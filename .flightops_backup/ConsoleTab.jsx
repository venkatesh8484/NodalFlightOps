import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Play, RotateCcw, CheckCircle2, AlertTriangle, HelpCircle, 
  ChevronLeft, ChevronRight, LayoutGrid, Network, Map as MapIcon, 
  Terminal, ShieldCheck, Database, Send, Sliders, Check, Maximize2, Minimize2, X
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getKnowledgeGraph } from '../lib/knowledgeGraph.js';
import { predictAirportLoad, getAirportsNeedingRecovery } from '../lib/delayPredictor.js';
import { computeRecoveryPlan } from '../lib/autonomousRecoveryPlanner.js';
import { getAmbientTraffic, EUROPE_BBOX } from '../lib/openSkyClient.js';
import {
  buildAirportsLegacyMap,
  buildInboundFlights,
  ambientTrafficToLegacyShape,
  CONSOLE_MCT_MINUTES,
} from '../lib/consoleDataAdapter.js';
import RecoveryConfirmationPanel from '../components/RecoveryConfirmationPanel.jsx';

// Helper to calculate Bezier curve points
function getCurvePoints(start, end, pointsCount = 40) {
  const points = [];
  const lat1 = start[0], lng1 = start[1];
  const lat2 = end[0], lng2 = end[1];
  
  // Midpoint
  const midLat = (lat1 + lat2) / 2;
  const midLng = (lng1 + lng2) / 2;
  
  // Offset perpendicular to the line for curve height
  const dx = lat2 - lat1;
  const dy = lng2 - lng1;
  
  // Scale factor for curve height
  const curveFactor = 0.15; 
  const offsetLat = midLat - dy * curveFactor;
  const offsetLng = midLng + dx * curveFactor;
  
  for (let i = 0; i <= pointsCount; i++) {
    const t = i / pointsCount;
    // Quadratic Bezier
    const lat = (1 - t) * (1 - t) * lat1 + 2 * (1 - t) * t * offsetLat + t * t * lat2;
    const lng = (1 - t) * (1 - t) * lng1 + 2 * (1 - t) * t * offsetLng + t * t * lng2;
    points.push([lat, lng]);
  }
  return points;
}

// Static ontology definitions for the Schema Inspector
const ONTOLOGY_SCHEMAS = {
  Class_FlightLeg: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:FlightLeg",
    "label": "FlightLeg",
    "comment": "Represents an individual scheduled flight sector operated by an aircraft tail.",
    "dataSource": "FLIFO (Flight Information Schedule System / NetLine)",
    "properties": {
      "flightId": { "type": "xsd:string", "description": "Unique IATA flight designator (e.g., KL1008)" },
      "origin": { "type": "xsd:string", "description": "3-letter IATA origin airport code" },
      "destination": { "type": "xsd:string", "description": "3-letter IATA destination airport code" },
      "estArrival": { "type": "xsd:dateTime", "description": "Estimated gate arrival timestamp" },
      "status": { "type": "xsd:string", "enum": ["NOMINAL", "DELAYED", "DIVERTED"] }
    },
    "constraints": [
      "Inbound arrival must clear minimum aircraft turnaround before next departure."
    ]
  },
  Class_BoardingPass: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:BoardingPass",
    "label": "BoardingPass",
    "comment": "A digital ticket representing a passenger reservation and connection check-in.",
    "dataSource": "PSS (Passenger Service System / Altéa Departure Control)",
    "properties": {
      "ticketNumber": { "type": "xsd:string", "description": "Unique e-ticket number" },
      "passengerName": { "type": "xsd:string", "description": "Passenger name record (PNR) name" },
      "frequentFlyerTier": { "type": "xsd:string", "description": "Loyalty status level (Platinum, Gold, Silver, Explorer)" },
      "connectsTo": { "type": "kb:FlightLeg", "description": "Onward connecting flight leg" }
    },
    "constraints": [
      "Transit window (Outbound departure - Inbound arrival) must exceed Minimum Connecting Time (MCT) of 45 minutes."
    ]
  },
  Class_Aircraft: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:Aircraft",
    "label": "Aircraft",
    "comment": "An individual physical aircraft frame (tail) assigned to fly sectors.",
    "dataSource": "FLIFO (Fleet Management / Aircraft Rotation System)",
    "properties": {
      "tailNumber": { "type": "xsd:string", "description": "Unique aircraft registration number" },
      "aircraftType": { "type": "xsd:string", "description": "IATA aircraft type code (e.g., B777, B789, E190)" },
      "turnaroundMinMinutes": { "type": "xsd:integer", "description": "Minimum legal ground turnaround duration (e.g., 30m)" }
    }
  },
  Class_Voucher: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:Voucher",
    "label": "Voucher",
    "comment": "A compensation voucher issued to passengers during major disruptions.",
    "dataSource": "VMS (Voucher Management System / SITA Passenger Care API)",
    "properties": {
      "voucherId": { "type": "xsd:string", "description": "Unique voucher index" },
      "voucherType": { "type": "xsd:string", "enum": ["HOTEL", "MEAL", "COMPENSATION"] },
      "valueEuro": { "type": "xsd:decimal", "description": "Monetary value in EUR" }
    }
  },
  Class_Rule: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:BusinessRule",
    "label": "BusinessRule",
    "comment": "Operational constraints and legal policies validated before executing changes.",
    "dataSource": "BRMS (Business Rules Management System / OCC Decision Rules Engine)",
    "properties": {
      "ruleId": { "type": "xsd:string", "description": "Unique identifier (R1 to R6)" },
      "ruleName": { "type": "xsd:string", "description": "Descriptive rule title" },
      "satisfied": { "type": "xsd:boolean", "description": "Current evaluation status" }
    }
  },
  Class_Stand: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:Stand",
    "label": "Stand",
    "comment": "An designated aircraft stand/parking position at Schiphol Airport.",
    "dataSource": "AODB (Airport Operational Database / Stand Management System)",
    "properties": {
      "standId": { "type": "xsd:string", "description": "Unique stand designation (e.g., D18, E24)" },
      "pier": { "type": "xsd:string", "description": "Terminal pier letter" },
      "locatedAt": { "type": "kb:Airport", "description": "Hub airport object" }
    }
  },
  Class_Airport: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:Airport",
    "label": "Airport",
    "comment": "An international hub airport terminal facilitating flight transfers.",
    "dataSource": "AODB (Global IATA Airport Directory)",
    "properties": {
      "iataCode": { "type": "xsd:string", "description": "3-letter IATA code (e.g., AMS, HND, JFK)" },
      "cityName": { "type": "xsd:string", "description": "Name of primary city served" }
    }
  },
  Class_Passenger: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:Passenger",
    "label": "Passenger",
    "comment": "A customer associated with a booking reservation PNR.",
    "dataSource": "PSS (Passenger Service System / Altéa PNR Database)",
    "properties": {
      "paxId": { "type": "xsd:string", "description": "Unique passenger ID" },
      "loyaltyTier": { "type": "xsd:string", "description": "Frequent flyer tier" },
      "holds": { "type": "kb:BoardingPass", "description": "Associated flight ticket" }
    }
  },
  Class_SLA: {
    "@context": "https://schema.org",
    "@type": "Class",
    "id": "kb:SLA",
    "label": "ServiceLevelAgreement",
    "comment": "Service level targets for connection safety, passenger delays, and rebooking timings.",
    "dataSource": "BRMS (Contractual SLAs & Hub Regulations)",
    "properties": {
      "targetMCT": { "type": "xsd:integer", "description": "Target minimum connection window (45m)" },
      "maxDelayTolerance": { "type": "xsd:integer", "description": "Maximum tolerated delay before rebooking (120m)" }
    }
  }
};

export default function ConsoleTab() {
  // --- Selected Flight & Delays ---
  const [selectedFlight, setSelectedFlight] = useState('KL1008');
  const [delays, setDelays] = useState({
    KL1008: 45,
    KL1250: 75,
    KL427: 35,
    KL198: 0
  });

  // --- Simulation States ---
  const [simStep, setSimStep] = useState('idle'); // idle, telemetry, traversal, dependency, rules, proposal, executing, recovered
  const [activeStrategy, setActiveStrategy] = useState('high-value'); // high-value, hold-rush
  const [rulesSatisfied, setRulesSatisfied] = useState([false, false, false, false, false, false]); // R1 - R6
  const [writebacks, setWritebacks] = useState({ pss: 'pending', gate: 'pending', push: 'pending', voucher: 'pending' }); // pending, success
  const [logs, setLogs] = useState(['[14:07:20Z] SYSTEM · FlightOps operational console ready.']);
  const [ontologyTab, setOntologyTab] = useState('query'); // query, inspector
  const [hoveredNode, setHoveredNode] = useState(null);
  const [graphMode, setGraphMode] = useState('traversal'); // traversal, full
  const [rightPanelWidth, setRightPanelWidth] = useState(480);
  const isResizing = useRef(false);

  const startResizing = (mouseDownEvent) => {
    isResizing.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleMouseMove = (mouseMoveEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - mouseMoveEvent.clientX;
    if (newWidth > 380 && newWidth < 800) {
      setRightPanelWidth(newWidth);
    }
  };

  const handleMouseUp = () => {
    isResizing.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalZoom, setModalZoom] = useState(1.0);

  // --- Recovery Confirmation Panel (human-in-the-loop approval gate) ---
  // Mirrors PostalOps' RerouteConfirmationPanel flow: the agent's staged
  // reasoning runs first, each step reporting the real value it computed, and
  // only then is the decision presented for approval.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [reasoningStage, setReasoningStage] = useState(0);
  const [reasoningLog, setReasoningLog] = useState([]);
  const [isCompleted, setIsCompleted] = useState(false);
  const reasoningTimers = useRef([]);

  const toggleMaximize = () => {
    setIsModalOpen(true);
    setModalZoom(1.0);
  };
  
  // --- UI Layout States ---
  const [collapsed, setCollapsed] = useState({
    map: false,
    controls: false,
    right: false
  });
  const [logsOpen, setLogsOpen] = useState(false);
  
  // --- Leaflet Map Refs ---
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const mapLayers = useRef([]);

  // ══════════════════════════════════════════════════════════════
  // KG-DERIVED DATA — replaces the old hardcoded AIRPORTS / INBOUND_FLIGHTS
  // / STATIC_FLIGHTS constants. The KG singleton is built once by the top-
  // level App shell (from data/*.json) before this tab mounts.
  // ══════════════════════════════════════════════════════════════
  const kg = getKnowledgeGraph();
  const AIRPORTS = useMemo(() => buildAirportsLegacyMap(kg), [kg]);
  const INBOUND_FLIGHTS = useMemo(() => buildInboundFlights(kg), [kg]);

  // Live ambient air traffic (OpenSky) — purely decorative background layer,
  // fails soft to an empty array. Refreshes every 45s while the tab is open.
  const [ambientTraffic, setAmbientTraffic] = useState([]);
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const traffic = await getAmbientTraffic(EUROPE_BBOX, 12);
      if (!cancelled) setAmbientTraffic(ambientTrafficToLegacyShape(traffic));
    }
    refresh();
    const interval = setInterval(refresh, 45000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);
  const STATIC_FLIGHTS = ambientTraffic;

  // Real recovery plan for the selected flight — computed from the KG
  // (delayPredictor + autonomousRecoveryPlanner), independent of the staged
  // UI simulation below. Recomputes live as the delay slider moves.
  const liveRecoveryPlan = useMemo(() => {
    if (!kg.getFlight(selectedFlight)) return null;
    return computeRecoveryPlan(kg, selectedFlight, { mctMinutes: CONSOLE_MCT_MINUTES, trigger: 'DELAY' });
  }, [kg, selectedFlight, delays]);

  const destAirportLoad = useMemo(() => {
    const { predictions } = predictAirportLoad(kg, 1.0);
    return predictions.find((p) => p.airportId === 'AMS') || null;
  }, [kg]);

  // Active flight config details
  const activeFlightObj = INBOUND_FLIGHTS[selectedFlight];
  const activeDelay = delays[selectedFlight];

  // Calculate connection risk for selected flight
  const atRiskConnections = activeFlightObj.connections.filter(
    conn => (conn.offset - activeDelay) < 45
  );
  const connectsAtRisk = atRiskConnections.reduce((sum, c) => sum + c.pax, 0);
  const totalPax = activeFlightObj.connections.reduce((sum, c) => sum + c.pax, 0);

  const showProposal = simStep === 'proposal' || simStep === 'executing' || simStep === 'recovered';
  const isRecovered = simStep === 'recovered';
  
  // Strategy metrics based on selected flight & delay
  const getMetrics = () => {
    if (connectsAtRisk === 0) {
      return { cost: 0, saved: totalPax, tails: 0, vouchers: 0 };
    }
    
    const voucherCount = atRiskConnections.some(c => c.code === 'HND') ? activeFlightObj.connections.find(c => c.code === 'HND').pax : 0;
    const baseRebookCost = atRiskConnections.reduce((sum, c) => sum + (c.pax * c.costPerPax), 0) + 2000;

    if (activeStrategy === 'high-value') {
      const rebookCost = baseRebookCost + (voucherCount * 150);
      return {
        cost: Math.round(rebookCost),
        saved: totalPax,
        tails: 0,
        vouchers: voucherCount
      };
    } else {
      // Hold and Rush
      const savedCount = totalPax - atRiskConnections.reduce((sum, c) => sum + Math.round(c.pax * 0.4), 0);
      return {
        cost: Math.round(baseRebookCost * 0.45 + 3000),
        saved: savedCount,
        tails: activeDelay > 60 ? 2 : 1,
        vouchers: 0
      };
    }
  };

  const metrics = getMetrics();

  // Dynamic Instance Schema generators for Node hover card inspection
  const getFlightInstanceSchema = () => ({
    "@context": "https://schema.org",
    "@type": "kb:FlightLeg",
    "id": `inst:${selectedFlight}`,
    "flightId": selectedFlight,
    "origin": activeFlightObj.origin,
    "destination": "AMS",
    "estArrival": activeDelay === 0 ? "Nominal" : `+${activeDelay} mins`,
    "status": activeDelay === 0 ? "NOMINAL" : "DELAYED",
    "relationships": {
      "operatedBy": "inst:PH-BVA (B777-300ER)",
      "boards": `inst:BoardingPassGroup (${totalPax} pax)`
    }
  });

  const getBoardingPassInstanceSchema = () => ({
    "@context": "https://schema.org",
    "@type": "kb:BoardingPass[]",
    "id": "inst:TransitPaxGroup",
    "totalTransitCount": totalPax,
    "atRiskCount": connectsAtRisk,
    "connectionWindow": connectsAtRisk > 0 ? "VIOLATED (MCT < 45m)" : "NOMINAL",
    "rebookAction": simStep === 'recovered' ? "RESOLVED (Rebooked)" : connectsAtRisk > 0 ? "ProtectAndRebook proposed" : "None"
  });

  const getOutboundInstanceSchema = () => ({
    "@context": "https://schema.org",
    "@type": "kb:FlightLeg[]",
    "id": "inst:OnwardFlightGroup",
    "destinations": activeFlightObj.connections.map(c => c.code),
    "impactedCount": atRiskConnections.length,
    "impactedDestinations": atRiskConnections.map(c => c.code),
    "status": connectsAtRisk > 0 ? "CRITICAL downstream risk" : "NOMINAL"
  });

  const getActionInstanceSchema = () => ({
    "@context": "https://schema.org",
    "@type": "kb:ProtectAndRebook",
    "id": `action:rebook_${selectedFlight}`,
    "strategySelected": activeStrategy,
    "paxProtected": simStep === 'recovered' ? totalPax : 0,
    "rebookingCost": `€ ${metrics.cost.toLocaleString()}`,
    "status": simStep === 'recovered' ? "COMPLETED" : simStep === 'proposal' ? "PENDING_APPROVAL" : "IDLE"
  });

  const getVoucherInstanceSchema = () => ({
    "@context": "https://schema.org",
    "@type": "kb:Voucher[]",
    "id": "inst:VouchersAllocated",
    "vouchersIssuedCount": metrics.vouchers,
    "type": "HOTEL + MEAL",
    "paxTargeted": "HND connecting passengers",
    "status": simStep === 'recovered' ? "COMMITTED" : "PROPOSED"
  });

  const getActiveSchema = () => {
    const nodeKey = hoveredNode || 'Inst_FlightLeg';
    if (nodeKey === 'Class_FlightLeg') return ONTOLOGY_SCHEMAS.Class_FlightLeg;
    if (nodeKey === 'Class_BoardingPass') return ONTOLOGY_SCHEMAS.Class_BoardingPass;
    if (nodeKey === 'Class_Aircraft') return ONTOLOGY_SCHEMAS.Class_Aircraft;
    if (nodeKey === 'Class_Voucher') return ONTOLOGY_SCHEMAS.Class_Voucher;
    if (nodeKey === 'Class_Rule') return ONTOLOGY_SCHEMAS.Class_Rule;
    if (nodeKey === 'Class_Stand') return ONTOLOGY_SCHEMAS.Class_Stand;
    if (nodeKey === 'Class_Airport') return ONTOLOGY_SCHEMAS.Class_Airport;
    if (nodeKey === 'Class_Passenger') return ONTOLOGY_SCHEMAS.Class_Passenger;
    if (nodeKey === 'Class_SLA') return ONTOLOGY_SCHEMAS.Class_SLA;
    
    if (nodeKey === 'Inst_FlightLeg') return getFlightInstanceSchema();
    if (nodeKey === 'Inst_BoardingPass') return getBoardingPassInstanceSchema();
    if (nodeKey === 'Inst_Outbound') return getOutboundInstanceSchema();
    if (nodeKey === 'Inst_Action') return getActionInstanceSchema();
    if (nodeKey === 'Inst_Voucher') return getVoucherInstanceSchema();
    
    return getFlightInstanceSchema();
  };

  const getQueryLines = () => {
    const lines = [
      { id: 1, text: `g.V().hasLabel('FlightLeg').has('status', 'DELAYED')`, steps: ['telemetry', 'traversal', 'dependency', 'rules', 'proposal', 'executing', 'recovered'], status: 'active' },
      { id: 2, text: `g.V('${selectedFlight}').out('operatedBy')`, steps: ['traversal', 'dependency', 'rules', 'proposal', 'executing', 'recovered'], status: 'active' },
      { id: 3, text: `g.V('${selectedFlight}').inE('boards').outV()`, steps: ['dependency', 'rules', 'proposal', 'executing', 'recovered'], status: 'active' },
      { id: 4, text: `g.V('BoardingPassGroup').out('connectsTo').has('MCT', lt(45))`, steps: ['rules', 'proposal', 'executing', 'recovered'], status: 'active' },
      { id: 5, text: `g.V('BusinessRule').has('satisfied', false)`, steps: ['proposal', 'executing', 'recovered'], status: 'active' },
      { id: 6, text: `g.addV('ProtectAndRebook').property('strategy', '${activeStrategy}')`, steps: ['executing', 'recovered'], status: 'active' },
      { id: 7, text: `g.V('VoucherGroup').property('status', 'COMMITTED')`, steps: ['recovered'], status: 'active' }
    ];

    return lines.map(line => {
      let status = 'idle';
      if (simStep === 'recovered') {
        status = 'success';
      } else if (line.steps.includes(simStep)) {
        status = 'success';
      } else if (simStep === 'telemetry' && line.id === 1) {
        status = 'active';
      } else if (simStep === 'traversal' && line.id === 2) {
        status = 'active';
      } else if (simStep === 'dependency' && line.id === 3) {
        status = 'active';
      } else if (simStep === 'rules' && line.id === 4) {
        status = 'active';
      } else if (simStep === 'proposal' && line.id === 5) {
        status = 'active';
      } else if (simStep === 'executing' && line.id === 6) {
        status = 'active';
      }
      return { ...line, status };
    });
  };

  const renderJSONHighlighted = (obj) => {
    const jsonStr = JSON.stringify(obj, null, 2);
    // Escape HTML
    let html = jsonStr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    // Highlight keys, strings, numbers, booleans
    html = html.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)/g, '<span class="syn-key">$1</span>$3');
    html = html.replace(/: \s*("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")/g, ': <span class="syn-string">$1</span>');
    html = html.replace(/: \s*(-?\d+(\.\d+)?([eE][+-]?\d+)?)/g, ': <span class="syn-number">$1</span>');
    html = html.replace(/: \s*(true|false)/g, ': <span class="syn-boolean">$1</span>');
    
    return { __html: html };
  };

  // Helper to log message to terminal
  const logMessage = (msg) => {
    setLogs((prev) => [...prev, msg]);
  };

  // --- Initialize Map ---
  useEffect(() => {
    if (!leafletMap.current && mapRef.current) {
      leafletMap.current = L.map(mapRef.current, {
        zoomControl: false,
        attributionControl: false
      }).setView([40, 10], 3);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 18
      }).addTo(leafletMap.current);
    }

    return () => {
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
  }, []);

  // --- Render Map Items (Paths, Planes, Airports) ---
  useEffect(() => {
    if (!leafletMap.current) return;

    // Clear old layers
    mapLayers.current.forEach(layer => layer.remove());
    mapLayers.current = [];

    // 1. Draw Airports
    Object.entries(AIRPORTS).forEach(([code, data]) => {
      const icon = L.divIcon({
        html: `
          <div class="plane-marker-wrapper blue">
            <svg class="plane-svg" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="6" fill="#2563eb" stroke="#ffffff" stroke-width="2"/>
            </svg>
            <div class="plane-label" style="bottom: -22px; left: -10px;">${code}</div>
          </div>
        `,
        className: 'custom-plane-icon',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });

      const m = L.marker(data.coords, { icon }).addTo(leafletMap.current);
      mapLayers.current.push(m);
    });

    // 2. Draw Static Background Flights
    STATIC_FLIGHTS.forEach(flight => {
      const icon = L.divIcon({
        html: `
          <div class="plane-marker-wrapper green">
            <svg class="plane-svg" viewBox="0 0 24 24" style="transform: rotate(${flight.angle}deg)">
              <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L14 19v-5.5l8 2.5z"/>
            </svg>
            <div class="plane-label" style="bottom: 24px;">${flight.id} (+0m)</div>
          </div>
        `,
        className: 'custom-plane-icon',
        iconSize: [30, 40],
        iconAnchor: [15, 20]
      });

      const m = L.marker(flight.coords, { icon }).addTo(leafletMap.current);
      mapLayers.current.push(m);
    });

    // 3. Draw the Inbound Selectable Flights
    Object.entries(INBOUND_FLIGHTS).forEach(([fid, flight]) => {
      const del = delays[fid];
      const isSelected = fid === selectedFlight;
      const startCoords = flight.originCoords;
      const endCoords = AIRPORTS.AMS.coords;
      
      // Interpolate plane coordinates based on delay
      const fraction = Math.max(0.1, Math.min(0.9, (120 - del) / 120));
      const inboundCurve = getCurvePoints(startCoords, endCoords);
      const currentPointIndex = Math.round(inboundCurve.length * fraction);
      const planeCoords = inboundCurve[currentPointIndex] || endCoords;

      // Color coding for delays
      const colorClass = del === 0 ? 'green' : del <= 45 ? 'amber' : 'red';
      
      // Path drawing
      const pathLine = L.polyline(inboundCurve, {
        color: isSelected ? (del === 0 ? '#16a34a' : del <= 45 ? '#d97706' : '#dc2626') : '#cbd5e1',
        weight: isSelected ? 4.0 : 1.5,
        opacity: isSelected ? 0.9 : 0.4,
        className: isSelected ? 'animated-flight-line' : ''
      }).addTo(leafletMap.current);
      
      // Make path clickable to select flight
      pathLine.on('click', () => {
        setSelectedFlight(fid);
        logMessage(`[14:08:00Z] OCC · Inbound selection changed to ${fid} (${flight.route}).`);
      });
      mapLayers.current.push(pathLine);

      // Plane icon setup
      const inboundIcon = L.divIcon({
        html: `
          <div class="plane-marker-wrapper ${colorClass} ${isSelected ? 'selected-plane' : ''}" style="${isSelected ? 'box-shadow: 0 0 0 4px var(--agent-soft); border-radius: 50%;' : ''}">
            <svg class="plane-svg" viewBox="0 0 24 24" style="transform: rotate(${flight.defaultAngle}deg)">
              <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L14 19v-5.5l8 2.5z"/>
            </svg>
            <div class="plane-label" style="bottom: 24px; font-weight: ${isSelected ? 'bold' : 'normal'}; border: ${isSelected ? '2px solid var(--agent)' : '1px solid var(--line-strong)'};">
              ${fid} (${del > 0 ? `+${del}m` : 'On Time'}) ${isSelected ? '★' : ''}
            </div>
          </div>
        `,
        className: 'custom-plane-icon',
        iconSize: [30, 40],
        iconAnchor: [15, 20]
      });

      const planeMarker = L.marker(planeCoords, { icon: inboundIcon }).addTo(leafletMap.current);
      
      // Make plane marker clickable
      planeMarker.on('click', () => {
        setSelectedFlight(fid);
        logMessage(`[14:08:00Z] OCC · Inbound selection changed to ${fid} (${flight.route}).`);
      });
      
      // Tooltip to help stakeholders navigate selection
      planeMarker.bindTooltip(`
        <div style="font-family: var(--mono); font-size: 11px; padding: 2px;">
          <b>${fid}</b> · ${flight.route}<br/>
          <span>Delay: ${del > 0 ? `+${del} mins` : 'On Time'}</span><br/>
          <span style="color: var(--agent); font-weight: bold;">Click to select and view onward connections</span>
        </div>
      `, { direction: 'top' });
      
      mapLayers.current.push(planeMarker);
    });

    // 4. Draw Onward Connections for the SELECTED flight
    activeFlightObj.connections.forEach(conn => {
      const destCoords = AIRPORTS[conn.code].coords;
      const curve = getCurvePoints(AIRPORTS.AMS.coords, destCoords);
      
      const isAtRisk = (conn.offset - activeDelay) < 45; // MCT check
      
      let strokeColor = '#cbd5e1'; // default grey
      let isDashed = true;

      if (simStep === 'recovered') {
        strokeColor = '#16a34a'; // All green on recovery
      } else if (simStep === 'idle') {
        strokeColor = '#cbd5e1'; // Grey (Neutral / Idle)
        isDashed = false;
      } else if (isAtRisk) {
        strokeColor = '#dc2626'; // Red (Impacted connection)
      } else {
        strokeColor = '#16a34a'; // Green (Safe connection)
      }

      const polyline = L.polyline(curve, {
        color: strokeColor,
        weight: strokeColor === '#cbd5e1' ? 1.5 : 2.5,
        opacity: 0.8,
        className: isDashed ? 'animated-flight-line' : ''
      }).addTo(leafletMap.current);

      // Tooltip explaining details to business stakeholders (Request 2)
      const paxAffected = isAtRisk && simStep !== 'recovered' ? conn.pax : 0;
      const routeCost = isAtRisk ? (conn.pax * conn.costPerPax) : 0;
      const timeRemaining = conn.offset - activeDelay;
      
      let windowText = '';
      if (timeRemaining < 0) {
        windowText = `Missed (Outbound departed ${Math.abs(timeRemaining)}m ago)`;
      } else if (timeRemaining === 0) {
        windowText = `Missed (Simultaneous arrival/departure)`;
      } else if (timeRemaining < 45) {
        windowText = `${timeRemaining}m (MCT Violated — Missed)`;
      } else {
        windowText = `${timeRemaining}m (Nominal)`;
      }

      const statusTitle = simStep === 'recovered' ? 'RESOLVED ✓' : isAtRisk ? 'IMPACTED ⚠️' : 'SAFE ✓';
      const statusColor = simStep === 'recovered' ? 'var(--healthy)' : isAtRisk ? 'var(--crit)' : 'var(--healthy)';
      
      // Determine rebooking display
      let rebookBlock = '';
      const requiresVoucher = activeStrategy === 'high-value' && conn.code === 'HND' && isAtRisk;
      
      if (isAtRisk && (simStep === 'proposal' || simStep === 'executing')) {
        rebookBlock = `
          <div style="margin-top: 6px; padding: 4px 6px; background: rgba(37, 99, 235, 0.08); border-left: 2.5px solid #2563eb; border-radius: 2px;">
            <span style="color: #2563eb; font-weight: bold; font-size: 10px; text-transform: uppercase; display: block; margin-bottom: 2px;">Proposed Rebooking Action</span>
            <span style="font-size: 10.5px; color: var(--ink);">${conn.rebookOption}</span>
            ${requiresVoucher ? `<span style="color: #b45309; font-weight: bold; font-size: 10px; display: block; margin-top: 4px;">⚠️ Overnight Accommodation: Propose ${conn.pax} Hotel + Meal Vouchers</span>` : ''}
          </div>
        `;
      } else if (isAtRisk && simStep === 'recovered') {
        rebookBlock = `
          <div style="margin-top: 6px; padding: 4px 6px; background: rgba(22, 163, 74, 0.08); border-left: 2.5px solid #16a34a; border-radius: 2px;">
            <span style="color: #16a34a; font-weight: bold; font-size: 10px; text-transform: uppercase; display: block; margin-bottom: 2px;">Confirmed Rebooking Action</span>
            <span style="font-size: 10.5px; color: var(--ink);">${conn.rebookOption}</span>
            ${requiresVoucher ? `<span style="color: #16a34a; font-weight: bold; font-size: 10px; display: block; margin-top: 4px;">✓ Accommodation: ${conn.pax} Hotel + Meal Vouchers Issued</span>` : ''}
          </div>
        `;
      }
      
      const costLabel = simStep === 'recovered' ? 'Realized Rebooking Cost' : 'Estimated Impact Cost';
      const costColor = simStep === 'recovered' ? 'var(--healthy)' : isAtRisk ? 'var(--crit)' : 'var(--muted)';

      const tooltipContent = `
        <div style="font-family: var(--mono); font-size: 11.5px; padding: 6px; line-height: 1.5; color: var(--ink);">
          <b style="font-size: 13px; color: ${statusColor}">
            AMS → ${conn.code} (${AIRPORTS[conn.code].name}) — ${statusTitle}
          </b><br/>
          <span><b>Transiting Passengers</b>: ${conn.pax} passengers</span><br/>
          <span><b>Connection Window</b>: ${windowText}</span><br/>
          <span><b>Status</b>: ${simStep === 'recovered' ? 'Passengers protected / rebooked (Resolved)' : isAtRisk ? 'Missed connection (MCT Violated)' : 'Safe connection (MCT cleared)'}</span><br/>
          ${rebookBlock}
          <span style="border-top: 1px solid var(--line); margin-top: 6px; padding-top: 4px; display: block; font-weight: bold; color: ${costColor}">
            ${costLabel}: €${routeCost.toLocaleString()}
          </span>
        </div>
      `;
      
      polyline.bindTooltip(tooltipContent, { sticky: true });
      mapLayers.current.push(polyline);
    });

  }, [selectedFlight, delays, simStep, connectsAtRisk, activeDelay]);

  // Adjust Leaflet Map display size on layout collapses
  useEffect(() => {
    if (leafletMap.current) {
      setTimeout(() => {
        leafletMap.current.invalidateSize();
      }, 350);
    }
  }, [collapsed]);

  // --- Simulation Logic Pipeline ---
  const runSimulation = () => {
    if (connectsAtRisk === 0) {
      logMessage(`[14:07:22Z] INFO · No connections at risk for ${selectedFlight}.`);
      return;
    }
    
    setSimStep('telemetry');
    setRulesSatisfied([false, false, false, false, false, false]);
    setLogs([`[14:07:22Z] TELEMETRY · FlightLeg ${selectedFlight} estimated arrival delayed. status=DELAYED.`]);
    
    // Step 1: Telemetry
    setTimeout(() => {
      setSimStep('traversal');
      logMessage(`[14:07:22Z] AGENT · Assembling context for ${selectedFlight}. Querying ontology...`);
      logMessage(`  [Query] FlightLeg:${selectedFlight} → boards⁻¹ → BoardingPass[] (${totalPax} active passes found)`);
    }, 1200);

    // Step 2: Traversal
    setTimeout(() => {
      setSimStep('dependency');
      logMessage('[14:07:23Z] AGENT · Traversing links to identify downstream impacts...');
      logMessage('  [Traverse] BoardingPass → connectsTo → FlightLeg (Onward departures)');
      logMessage(`  [Rule Eval] New arrival vs MCT. ${connectsAtRisk} connections fell below MCT threshold.`);
    }, 2400);

    // Step 3: Rules verification
    setTimeout(() => {
      setSimStep('rules');
      logMessage('[14:07:24Z] AGENT · Evaluating business validation rules for candidates...');
      
      const verifyRule = (idx, name, msg) => {
        setTimeout(() => {
          setRulesSatisfied(prev => {
            const next = [...prev];
            next[idx] = true;
            return next;
          });
          logMessage(`  [Rule Validated] ${name}: ${msg}`);
        }, idx * 300);
      };

      verifyRule(0, 'R1 (Open Inventory)', 'Available rebooking inventory verified.');
      verifyRule(1, 'R2 (Minimum Connect Time)', 'MCT walk times computed for all piers.');
      verifyRule(2, 'R3 (Crew Duty Hours)', 'Connecting crew duty headroom checked.');
      verifyRule(3, 'R4 (Aircraft Turnaround)', 'Turnaround buffer stays above legal floor.');
      verifyRule(4, 'R5 (Loyalty Priority)', 'Rebooking queue ordered by SkyPriority status.');
      verifyRule(5, 'R6 (Write Authorization)', 'Dispatcher write credentials validated.');
    }, 3800);

    // Step 4: Ready for approval — backed by the real, independently computed
    // KG recovery plan (delayPredictor.js + autonomousRecoveryPlanner.js),
    // not just the staged UI narration above.
    setTimeout(() => {
      setSimStep('proposal');
      logMessage('[14:07:26Z] AGENT · Proposals generated. Standing by for dispatcher signature.');
      if (liveRecoveryPlan) {
        logMessage(`  [KG-ENGINE] autonomousRecoveryPlanner.js: ${liveRecoveryPlan.recommendation.summary} (confidence ${Math.round(liveRecoveryPlan.recommendation.confidence * 100)}%)`);
        logMessage(`  [KG-ENGINE] ${liveRecoveryPlan.actions.length} governance-ready action(s) drafted — approverRole(s): ${[...new Set(liveRecoveryPlan.actions.map(a => a.governance.approverRole))].join(', ')}.`);
      }
      if (destAirportLoad && destAirportLoad.utilizationPct >= 70) {
        logMessage(`  [KG-ENGINE] delayPredictor.js: AMS gate utilization ${destAirportLoad.utilizationPct}% (${destAirportLoad.status}) — ${destAirportLoad.headroom.toLocaleString()} pax/hr headroom remaining.`);
      }
    }, 6000);
  };

  // Cancel any in-flight reasoning timers when the panel closes or unmounts.
  useEffect(() => () => reasoningTimers.current.forEach(clearTimeout), []);

  /**
   * Open the confirmation panel and run the agent's reasoning stages. Each
   * stage reports the value it actually computed from the KG plan, so the panel
   * shows real numbers rather than a fixed script.
   */
  const openRecoveryConfirmation = () => {
    reasoningTimers.current.forEach(clearTimeout);
    reasoningTimers.current = [];

    setConfirmOpen(true);
    setConfirmLoading(true);
    setReasoningStage(0);
    setReasoningLog([]);

    const plan = liveRecoveryPlan;
    const flight = kg.getFlight(selectedFlight);
    const worstBuffer = plan ? Math.min(...plan.atRiskConnections.map((c) => c.bufferMin)) : null;

    const results = [
      flight ? `${flight.id}: ${flight.originAirportId} → ${flight.destinationAirportId}, status ${flight.status}` : `${selectedFlight}: not found in graph`,
      flight ? `delayMinutes = ${flight.delayMinutes}, ${flight.paxCount} pax aboard` : 'no telemetry',
      plan ? `${plan.atRiskConnections.length + (plan.atRiskConnections.length ? 0 : 0)} onward connection(s) traversed from ${plan.flightDestination}` : 'no onward connections',
      plan ? `${plan.atRiskConnections.length} connection(s) below the ${CONSOLE_MCT_MINUTES}-min MCT` : `0 connections below the ${CONSOLE_MCT_MINUTES}-min MCT`,
      destAirportLoad ? `${destAirportLoad.airportId} at ${destAirportLoad.utilizationPct}% utilization (${destAirportLoad.status})` : 'no live utilization reading',
      plan ? `${plan.totalPaxAtRisk} pax require rebooking across ${plan.atRiskConnections.length} connection(s)` : 'nothing to rebook',
      plan ? `confidence = ${Math.round(plan.recommendation.confidence * 100)}% (worst buffer ${worstBuffer} min)` : 'n/a',
      plan ? `${plan.actions.length} action(s) drafted — ${[...new Set(plan.actions.map((a) => a.governance.approverRole))].join(', ')}` : 'no actions drafted',
    ];

    results.forEach((result, i) => {
      reasoningTimers.current.push(
        setTimeout(() => {
          setReasoningLog((prev) => [...prev, { step: i, result }]);
          setReasoningStage(i + 1);
          if (i === results.length - 1) {
            reasoningTimers.current.push(setTimeout(() => setConfirmLoading(false), 500));
          }
        }, 420 * (i + 1))
      );
    });
  };

  const closeRecoveryConfirmation = () => {
    reasoningTimers.current.forEach(clearTimeout);
    reasoningTimers.current = [];
    setConfirmOpen(false);
    setConfirmLoading(false);
    setReasoningStage(0);
    setReasoningLog([]);
  };

  /**
   * Persist the approved plan through the dev server's /api/writeback endpoint
   * (vite-plugin-flightops-writeback.js): one action_execution_log.csv row per
   * drafted action, plus the flight status/tier updates the rebooking implies.
   * Fails soft — the console narration still runs if the endpoint is absent
   * (e.g. a production build), it just logs that nothing was persisted.
   */
  const persistRecoveryPlan = async () => {
    const plan = liveRecoveryPlan;
    if (!plan) return;

    const nowIso = new Date().toISOString();
    const stamp = nowIso.replace(/[-:T.Z]/g, '').slice(0, 14);

    try {
      for (let i = 0; i < plan.actions.length; i++) {
        const action = plan.actions[i];
        const response = await fetch('/api/writeback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actionLog: {
              execution_id: `EXE-${stamp}-${String(i + 1).padStart(2, '0')}`,
              action_name: action.actionType,
              parameters_json: JSON.stringify(action.parameters),
              proposed_by: 'autonomousRecoveryPlanner',
              approved_by: 'OCC_DUTY_MANAGER',
              status: 'EXECUTED',
              proposed_ts: plan.timestamp,
              decided_ts: nowIso,
              executed_ts: nowIso,
              target_system_ack: (action.sideEffects || []).join('; '),
              sensitivity_marking: 'NL-OPS//SCHIPHOL',
              result_summary: plan.recommendation.summary,
            },
            // Only the first request carries the record updates, so the same
            // change is not applied once per action.
            flightUpdates: i === 0
              ? [{ flightId: plan.flightId, newStatus: 'RECOVERED', newRiskTier: 'BUFFERED' }]
              : undefined,
            airportUpdates: i === 0 && action.actionType === 'ReallocateGateCapacity'
              ? [{ airportId: action.parameters.airportId, newStatus: 'OPERATIONAL' }]
              : undefined,
          }),
        });

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          logMessage('  [Writeback] Persistence endpoint unavailable (dev server only) — narration only, nothing written to disk.');
          return;
        }
        const result = await response.json();
        if (result.error) throw new Error(result.error);
      }
      logMessage(`  [Writeback] ${plan.actions.length} action(s) appended to action_execution_log.csv; flight + airport records updated.`);
    } catch (err) {
      logMessage(`  [Writeback] Persistence failed: ${err.message}`);
    }
  };

  const confirmRecovery = async () => {
    approveAndExecute();
    await persistRecoveryPlan();
    setIsCompleted(true);
    reasoningTimers.current.push(setTimeout(() => closeRecoveryConfirmation(), 2200));
  };

  const approveAndExecute = () => {
    setSimStep('executing');
    setWritebacks({ pss: 'pending', gate: 'pending', push: 'pending', voucher: 'pending' });
    logMessage(`[14:09:00Z] DISPATCHER · Approved & Execute committed for ${selectedFlight} by S. de Vries.`);
    
    // PSS rebooking writeback
    setTimeout(() => {
      setWritebacks(prev => ({ ...prev, pss: 'success' }));
      logMessage('  [Writeback] Sabre PSS re-issue transaction succeeded (200 OK).');
    }, 800);

    // Gate Database writeback
    setTimeout(() => {
      setWritebacks(prev => ({ ...prev, gate: 'success' }));
      logMessage('  [Writeback] Stand Allocation DB committed stand changes.');
    }, 1600);

    // Voucher Database writeback
    setTimeout(() => {
      setWritebacks(prev => ({ ...prev, voucher: 'success' }));
      logMessage(`  [Writeback] Voucher DB generated ${metrics.vouchers} hotel & meal vouchers.`);
    }, 2400);

    // Mobile Push writeback
    setTimeout(() => {
      setWritebacks(prev => ({ ...prev, push: 'success' }));
      logMessage('  [Writeback] Push Notification API dispatched mobile notifications.');
    }, 3200);

    // Final Success
    setTimeout(() => {
      setSimStep('recovered');
      logMessage(`[14:09:03Z] DONE · ${selectedFlight} recovery completed. Network state → RECOVERED.`);
    }, 4000);
  };

  const handleDelayChange = (newVal) => {
    setDelays(prev => ({ ...prev, [selectedFlight]: newVal }));
    if (simStep !== 'idle') {
      setSimStep('idle');
      setRulesSatisfied([false, false, false, false, false, false]);
      setWritebacks({ pss: 'pending', gate: 'pending', push: 'pending', voucher: 'pending' });
      setLogs([`[14:07:20Z] SYSTEM · FlightOps OCC console reset. Active selection: ${selectedFlight}.`]);
    }
  };

  const resetSimulation = () => {
    setSimStep('idle');
    setRulesSatisfied([false, false, false, false, false, false]);
    setWritebacks({ pss: 'pending', gate: 'pending', push: 'pending', voucher: 'pending' });
    setLogs([`[14:07:20Z] SYSTEM · FlightOps OCC console reset. Active selection: ${selectedFlight}.`]);
    setIsCompleted(false);
    closeRecoveryConfirmation();
  };

  // Automatically reset the simulation state when switching active flights
  useEffect(() => {
    resetSimulation();
  }, [selectedFlight]);

  return (
    <div className="app-container">
      {/* HEADER */}
      <header className="app-header">
        <div className="app-logo">
          <Network size={22} className="text-blue-600" />
          <span>AMS OCC <small>Live Scenario Console</small></span>
        </div>
        
        <div className="header-metrics">
          <div className="header-metric">
            <span className="label">Active Flight</span>
            <span className="val warn" style={{ color: 'var(--agent)' }}>{selectedFlight} ({activeFlightObj.route})</span>
          </div>
          <div className="header-metric">
            <span className="label">Estimated Delay</span>
            <span className={`val ${activeDelay === 0 ? 'healthy' : activeDelay <= 45 ? 'warn' : 'crit'}`}>
              {activeDelay === 0 ? 'On Time' : `+${activeDelay}m`}
            </span>
          </div>
          <div className="header-metric">
            <span className="label">Connections At Risk</span>
            <span className={`val ${connectsAtRisk > 0 ? 'crit' : 'healthy'}`}>
              {connectsAtRisk} pax
            </span>
          </div>
          <div className="header-metric">
            <span className="label">Est. Rerouting Cost</span>
            <span className="val warn" style={{ color: connectsAtRisk > 0 ? 'var(--crit)' : 'var(--healthy)' }}>
              {connectsAtRisk > 0 ? `€ ${metrics.cost.toLocaleString()}` : '€0'}
            </span>
          </div>
          <div className="header-metric">
            <span className="label">Overnight Vouchers</span>
            <span className={`val ${metrics.vouchers > 0 ? 'warn' : 'healthy'}`}>
              {metrics.vouchers} pax
            </span>
          </div>
          <div className="header-metric">
            <span className="label">Status</span>
            <span className={`val ${isRecovered ? 'healthy' : connectsAtRisk > 0 ? 'crit' : 'healthy'}`}>
              {isRecovered ? 'RECOVERED' : connectsAtRisk > 0 ? 'DISRUPTED' : 'NOMINAL'}
            </span>
          </div>
        </div>
      </header>

      {/* WORKSPACE */}
      <div className="app-workspace">
        {/* Floating Restore Buttons when panels are collapsed */}
        <div className="floating-restore-bar">
          {collapsed.map && (
            <button className="restore-btn" title="Expand Map" onClick={() => setCollapsed(prev => ({ ...prev, map: false }))}>
              <MapIcon size={18} />
            </button>
          )}
          {collapsed.controls && (
            <button className="restore-btn" title="Expand Controls" onClick={() => setCollapsed(prev => ({ ...prev, controls: false }))}>
              <Sliders size={18} />
            </button>
          )}
          {collapsed.right && (
            <button className="restore-btn" title="Expand Graph" onClick={() => setCollapsed(prev => ({ ...prev, right: false }))}>
              <Network size={18} />
            </button>
          )}
        </div>

        {/* LEFT / CENTER COLUMN */}
        <div className="panel-left-center">
          {/* MAP PANEL */}
          <div className={`panel-map-container ${collapsed.map ? 'collapsed' : ''}`}>
            <div className="map-overlay-title">
              <h4>AMS OCC Live Connections & Traffic Map</h4>
              <p>Click any inbound flight to select it. Hover routes to see business details.</p>
            </div>
            
            {!collapsed.map && (
              <button 
                className="panel-toggle-btn" 
                style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000, background: 'rgba(255,255,255,0.9)', boxShadow: 'var(--shadow-sm)' }}
                onClick={() => setCollapsed(prev => ({ ...prev, map: true }))}
              >
                <ChevronLeft size={16} />
              </button>
            )}

            <div ref={mapRef} style={{ width: '100%', height: '100%' }}></div>
          </div>

          {/* CONTROLS PANEL */}
          <div className={`panel-controls-container ${collapsed.controls ? 'collapsed' : ''}`}>
            <div className="panel-header">
              <span className="panel-title">
                <Sliders size={16} className="text-blue-500" />
                Selected Flight: {selectedFlight} Delay Configuration & Strategy Console
              </span>
              <button className="panel-toggle-btn" onClick={() => setCollapsed(prev => ({ ...prev, controls: true }))}>
                <ChevronRight size={16} style={{ transform: 'rotate(90deg)' }} />
              </button>
            </div>
            <div className="panel-body">
              {/* Slider controls */}
              <div className="slider-section">
                <div className="slider-header">
                  <span className="slider-title">Adjust Delay for {selectedFlight} ({activeFlightObj.route})</span>
                  <span className={`slider-value ${activeDelay === 0 ? 'nominal' : ''}`}>
                    {activeDelay === 0 ? 'On Time' : `+ ${activeDelay} minutes`}
                  </span>
                </div>
                <div className="slider-wrapper">
                  <input 
                    type="range" 
                    min="0" 
                    max="120" 
                    step="5" 
                    value={activeDelay} 
                    onChange={(e) => handleDelayChange(parseInt(e.target.value))}
                    disabled={simStep === 'executing' || simStep === 'recovered'}
                  />
                </div>
              </div>

              {/* Simulation triggers */}
              <div className="action-buttons">
                {simStep === 'idle' ? (
                  <button className="btn btn-primary" onClick={runSimulation} disabled={connectsAtRisk === 0}>
                    <Play size={16} /> Trigger Disruption Simulation
                  </button>
                ) : (
                  <button className="btn btn-secondary" onClick={resetSimulation}>
                    <RotateCcw size={16} /> Reset Scenario
                  </button>
                )}
                
                <button 
                  className="btn btn-success" 
                  onClick={openRecoveryConfirmation} 
                  disabled={simStep !== 'proposal'}
                >
                  <CheckCircle2 size={16} /> Approve & Execute Recovery
                </button>
              </div>

              {/* Strategy Comparison Grid */}
              {showProposal && (
                <div className="strategies-grid">
                  <div 
                    className={`strategy-card ${activeStrategy === 'high-value' ? 'selected' : ''}`}
                    onClick={() => simStep === 'proposal' && setActiveStrategy('high-value')}
                  >
                    <div className="title">
                      <span>High-Value Protection</span>
                      <span className="recommended-badge">Recommended</span>
                    </div>
                    <div className="metric-row">
                      <span>Saved Connections</span>
                      <span className="val healthy">{totalPax} / {totalPax}</span>
                    </div>
                    <div className="metric-row">
                      <span>Rebooking Action</span>
                      <span className="val">Re-route disrupted pax</span>
                    </div>
                    <div className="metric-row">
                      <span>Est. Recovery Cost</span>
                      <span className="val crit">€ {metrics.cost.toLocaleString()}</span>
                    </div>
                  </div>

                  <div 
                    className={`strategy-card ${activeStrategy === 'hold-rush' ? 'selected' : ''}`}
                    onClick={() => simStep === 'proposal' && setActiveStrategy('hold-rush')}
                  >
                    <div className="title">
                      <span>Hold-and-Rush</span>
                    </div>
                    <div className="metric-row">
                      <span>Saved Connections</span>
                      <span className="val">
                        {metrics.saved} / {totalPax}
                      </span>
                    </div>
                    <div className="metric-row">
                      <span>Downstream Delay Risk</span>
                      <span className="val crit">{metrics.tails} aircraft tails</span>
                    </div>
                    <div className="metric-row">
                      <span>Est. Recovery Cost</span>
                      <span className="val healthy">€ {metrics.cost.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (LIVE TRAVERSAL & TERMINAL) */}
        <div 
          className="panel-splitter"
          onMouseDown={startResizing}
        />
        <div 
          className={`workspace-panel panel-right ${collapsed.right ? 'collapsed' : ''}`}
          style={{ width: collapsed.right ? 0 : `${rightPanelWidth}px`, minWidth: collapsed.right ? 0 : undefined }}
        >
          <div className="panel-header">
            <span className="panel-title">
              <Network size={16} className="text-purple-500" />
              Live Ontology Traversal & Reasoning
            </span>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button 
                className="panel-toggle-btn" 
                onClick={toggleMaximize}
                title="Open enlarged popup view"
              >
                <Maximize2 size={13} />
              </button>
              <button className="panel-toggle-btn" onClick={() => setCollapsed(prev => ({ ...prev, right: true }))}>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          <div className="graph-mode-header">
            <span style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--muted)', marginRight: '4px' }}>GRAPH VIEW:</span>
            <button 
              className={`graph-mode-btn ${graphMode === 'traversal' ? 'active' : ''}`}
              onClick={() => setGraphMode('traversal')}
            >
              Active Traversal Path
            </button>
            <button 
              className={`graph-mode-btn ${graphMode === 'full' ? 'active' : ''}`}
              onClick={() => setGraphMode('full')}
            >
              Full Ontology Schema
            </button>
          </div>

          <div className="panel-body">
            {/* SVG Graph visualizer */}
            <div className="graph-svg-container">
              {graphMode === 'traversal' ? (
                <svg width="100%" height="100%" viewBox="0 0 540 400">
                  <defs>
                    <marker 
                      id="arrow" 
                      viewBox="0 0 10 10" 
                      refX="7" 
                      refY="5" 
                      markerWidth="6" 
                      markerHeight="6" 
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#94a3b8" />
                    </marker>
                  </defs>

                  {/* Layer dividers */}
                  <path 
                    d="M 10 170 H 530" 
                    stroke="var(--line-strong)" 
                    strokeWidth="1.5" 
                    strokeDasharray="4 4" 
                  />
                  <text x="10" y="165" fill="var(--struct)" style={{ fontFamily: 'var(--mono)', fontSize: '8px', letterSpacing: '0.05em', fontWeight: 'bold' }}>
                    SCHEMA LAYER (ONTOLOGY VOCABULARY)
                  </text>
                  <text x="10" y="195" fill="var(--muted)" style={{ fontFamily: 'var(--mono)', fontSize: '8px', letterSpacing: '0.05em', fontWeight: 'bold' }}>
                    INSTANCE LAYER (LIVE DATA PATH)
                  </text>

                  {/* --- SCHEMA LAYER ARCS --- */}
                  {/* boards */}
                  <g>
                    <path d="M 150 44 H 200" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(175, 44)">
                      <rect x="-15" y="-4" width="30" height="8" fill="var(--paper)" rx="1" ry="1" />
                      <text x="0" y="2.5" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '7px' }}>boards</text>
                    </g>
                  </g>

                  {/* requires */}
                  <g>
                    <path d="M 325 44 H 375" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(350, 44)">
                      <rect x="-17" y="-4" width="34" height="8" fill="var(--paper)" rx="1" ry="1" />
                      <text x="0" y="2.5" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '7px' }}>requires</text>
                    </g>
                  </g>

                  {/* operatedBy */}
                  <g>
                    <path d="M 87.5 63 V 110" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(87.5, 86.5) rotate(-90)">
                      <rect x="-20" y="-4" width="40" height="8" fill="var(--paper)" rx="1" ry="1" />
                      <text x="0" y="2.5" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '7px' }}>operatedBy</text>
                    </g>
                  </g>

                  {/* validates */}
                  <g>
                    <path d="M 262.5 110 V 63" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(262.5, 86.5) rotate(-90)">
                      <rect x="-18" y="-4" width="36" height="8" fill="var(--paper)" rx="1" ry="1" />
                      <text x="0" y="2.5" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '7px' }}>validates</text>
                    </g>
                  </g>

                  {/* --- INSTANCE LAYER ARCS (Traversals) --- */}
                  <path 
                    className={`graph-edge ${(simStep === 'traversal' || simStep === 'dependency' || simStep === 'rules' || simStep === 'proposal' || simStep === 'executing') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`}
                    d="M 150 245 H 200" 
                    markerEnd="url(#arrow)"
                  />
                  <path 
                    className={`graph-edge ${(simStep === 'dependency' || simStep === 'rules' || simStep === 'proposal' || simStep === 'executing') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`}
                    d="M 325 245 H 375" 
                    markerEnd="url(#arrow)"
                  />
                  <path 
                    className={`graph-edge ${(simStep === 'rules' || simStep === 'proposal' || simStep === 'executing') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`}
                    d="M 262.5 270 V 315" 
                    markerEnd="url(#arrow)"
                  />
                  <path 
                    className={`graph-edge ${(simStep === 'rules' || simStep === 'proposal' || simStep === 'executing') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`}
                    d="M 200 340 H 150" 
                    markerEnd="url(#arrow)"
                  />

                  {/* Traversal Pulses */}
                  {simStep === 'traversal' && (
                    <circle cx="150" cy="245" r="4" className="graph-pulse">
                      <animate attributeName="cx" from="150" to="200" dur="0.8s" repeatCount="indefinite" />
                    </circle>
                  )}
                  {simStep === 'dependency' && (
                    <circle cx="325" cy="245" r="4" className="graph-pulse">
                      <animate attributeName="cx" from="325" to="375" dur="0.8s" repeatCount="indefinite" />
                    </circle>
                  )}
                  {simStep === 'executing' && (
                    <>
                      <circle cx="150" cy="340" r="4" className="graph-pulse recovered">
                        <animate attributeName="cx" from="200" to="150" dur="0.6s" repeatCount="indefinite" />
                      </circle>
                      <circle cx="262" cy="270" r="4" className="graph-pulse recovered">
                        <animate attributeName="cy" from="270" to="315" dur="0.6s" repeatCount="indefinite" />
                      </circle>
                    </>
                  )}

                  {/* Schema Class Nodes */}
                  <g className="graph-node class-node" transform="translate(25, 25)" onMouseEnter={() => { setHoveredNode('Class_FlightLeg'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="38" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:FlightLeg</text>
                    <text className="subtitle" x="8" y="28">Class blueprint</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(200, 25)" onMouseEnter={() => { setHoveredNode('Class_BoardingPass'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="38" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:BoardingPass</text>
                    <text className="subtitle" x="8" y="28">Class blueprint</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(375, 25)" onMouseEnter={() => { setHoveredNode('Class_Voucher'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="38" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:Voucher</text>
                    <text className="subtitle" x="8" y="28">Class blueprint</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(25, 110)" onMouseEnter={() => { setHoveredNode('Class_Aircraft'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="38" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:Aircraft</text>
                    <text className="subtitle" x="8" y="28">Class blueprint</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(200, 110)" onMouseEnter={() => { setHoveredNode('Class_Rule'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="38" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:BusinessRule</text>
                    <text className="subtitle" x="8" y="28">Class blueprint</text>
                  </g>

                  {/* Instance Nodes */}
                  <g className={`graph-node instance-node ${activeDelay > 0 && simStep !== 'recovered' ? 'delayed' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(25, 220)" onMouseEnter={() => { setHoveredNode('Inst_FlightLeg'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="50" rx="6" ry="6" />
                    <text className="title" x="8" y="16">inst:{selectedFlight}</text>
                    <text className="subtitle" x="8" y="28">FlightLeg Sector</text>
                    <text className="subtitle" x="8" y="40" fill={activeDelay > 0 && !isRecovered ? 'var(--crit)' : ''}>
                      {activeDelay > 0 ? `Delay: +${activeDelay}m` : 'On Time'}
                    </text>
                  </g>
                  <g className={`graph-node instance-node ${(simStep === 'traversal' || simStep === 'dependency' || simStep === 'rules' || simStep === 'proposal') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(200, 220)" onMouseEnter={() => { setHoveredNode('Inst_BoardingPass'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="50" rx="6" ry="6" />
                    <text className="title" x="8" y="16">inst:TransitPax</text>
                    <text className="subtitle" x="8" y="28">{totalPax} transiting pax</text>
                    <text className="subtitle" x="8" y="40" fill={connectsAtRisk > 0 && !isRecovered ? 'var(--crit)' : ''}>
                      {isRecovered ? 'Protected ✓' : connectsAtRisk > 0 ? `${connectsAtRisk} at risk` : 'Nominal'}
                    </text>
                  </g>
                  <g className={`graph-node instance-node ${connectsAtRisk > 0 && simStep !== 'recovered' ? 'delayed' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(375, 220)" onMouseEnter={() => { setHoveredNode('Inst_Outbound'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="50" rx="6" ry="6" />
                    <text className="title" x="8" y="16">inst:OnwardLegs</text>
                    <text className="subtitle" x="8" y="28">{activeFlightObj.connections.length} connections</text>
                    <text className="subtitle" x="8" y="40" fill={connectsAtRisk > 0 && !isRecovered ? 'var(--crit)' : ''}>
                      {isRecovered ? 'All Resolved' : connectsAtRisk > 0 ? `${atRiskConnections.length} impacted` : '0 impacted'}
                    </text>
                  </g>
                  <g className={`graph-node instance-node ${(simStep === 'rules' || simStep === 'proposal') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(200, 315)" onMouseEnter={() => { setHoveredNode('Inst_Action'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="50" rx="6" ry="6" strokeDasharray="3 3" />
                    <text className="title" x="8" y="16">inst:RebookAction</text>
                    <text className="subtitle" x="8" y="28">ProtectAndRebook</text>
                    <text className="subtitle" x="8" y="40">
                      {isRecovered ? 'Executed ✓' : simStep === 'proposal' ? 'Pending Approval' : 'Ready'}
                    </text>
                  </g>
                  <g className={`graph-node instance-node ${(simStep === 'rules' || simStep === 'proposal') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(25, 315)" onMouseEnter={() => { setHoveredNode('Inst_Voucher'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="50" rx="6" ry="6" strokeDasharray="3 3" />
                    <text className="title" x="8" y="18">inst:Vouchers</text>
                    <text className="subtitle" x="8" y="28">Voucher allocation</text>
                    <text className="subtitle" x="8" y="40" fill={metrics.vouchers > 0 ? 'var(--warn)' : ''}>
                      {metrics.vouchers > 0 ? `${metrics.vouchers} Hotel + Meal` : '0 issued'}
                    </text>
                  </g>
                </svg>
              ) : (
                <svg width="100%" height="100%" viewBox="0 0 640 380">
                  <defs>
                    <marker 
                      id="arrow" 
                      viewBox="0 0 10 10" 
                      refX="7" 
                      refY="5" 
                      markerWidth="6" 
                      markerHeight="6" 
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#94a3b8" />
                    </marker>
                  </defs>

                  {/* --- FULL SCHEMA ARCS --- */}
                  {/* operatedBy */}
                  <g>
                    <path d="M 87.5 73 V 150" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(87.5, 111.5) rotate(-90)">
                      <rect x="-22.5" y="-5" width="45" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>operatedBy</text>
                    </g>
                  </g>

                  {/* boards */}
                  <g>
                    <path d="M 150 49 H 250" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(200, 49)">
                      <rect x="-17.5" y="-5" width="35" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>boards</text>
                    </g>
                  </g>

                  {/* holds */}
                  <g>
                    <path d="M 312.5 73 V 150" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(312.5, 111.5) rotate(-90)">
                      <rect x="-15" y="-5" width="30" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>holds</text>
                    </g>
                  </g>

                  {/* connectsTo: Rerouted through track y=130 to completely segregate it */}
                  <g>
                    <path d="M 250 174 H 210 V 130 H 115 V 73" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(162.5, 130)">
                      <rect x="-22.5" y="-5" width="45" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>connectsTo</text>
                    </g>
                  </g>

                  {/* assignedTo: Vertically aligned text on left-gutter vertical segment */}
                  <g>
                    <path d="M 25 174 H 10 V 304 H 25" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(10, 239) rotate(-90)">
                      <rect x="-22.5" y="-5" width="45" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>assignedTo</text>
                    </g>
                  </g>

                  {/* locatedAt */}
                  <g>
                    <path d="M 150 304 H 250" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(200, 304)">
                      <rect x="-17.5" y="-5" width="35" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>locatedAt</text>
                    </g>
                  </g>

                  {/* requires: Rerouted through track y=90 to completely segregate it */}
                  <g>
                    <path d="M 375 174 H 415 V 90 H 450 V 49 H 480" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(432.5, 90)">
                      <rect x="-17.5" y="-5" width="35" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>requires</text>
                    </g>
                  </g>

                  {/* validatedBy: Rerouted through bottom-gutter track y=240 to avoid Passenger and BoardingPass */}
                  <g>
                    <path d="M 150 60 H 185 V 240 H 445 V 174 H 480" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(315, 240)">
                      <rect x="-25" y="-5" width="50" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>validatedBy</text>
                    </g>
                  </g>

                  {/* guards */}
                  <g>
                    <path d="M 542.5 198 V 280" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                    <g transform="translate(542.5, 239) rotate(-90)">
                      <rect x="-15" y="-5" width="30" height="10" fill="var(--paper)" rx="2" ry="2" />
                      <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>guards</text>
                    </g>
                  </g>

                  {/* --- FULL SCHEMA CLASS NODES --- */}
                  <g className="graph-node class-node" transform="translate(25, 25)" onMouseEnter={() => { setHoveredNode('Class_FlightLeg'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:FlightLeg</text>
                    <text className="subtitle" x="8" y="28">Sector Schedule</text>
                    <text className="source-tag source-flifo" x="8" y="39">Source: FLIFO</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(25, 150)" onMouseEnter={() => { setHoveredNode('Class_Aircraft'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:Aircraft</text>
                    <text className="subtitle" x="8" y="28">Airframe Frame</text>
                    <text className="source-tag source-flifo" x="8" y="39">Source: FLIFO</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(25, 280)" onMouseEnter={() => { setHoveredNode('Class_Stand'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:Stand</text>
                    <text className="subtitle" x="8" y="27">Parking Stand</text>
                    <text className="source-tag source-aodb" x="8" y="39">Source: AODB</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(250, 280)" onMouseEnter={() => { setHoveredNode('Class_Airport'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:Airport</text>
                    <text className="subtitle" x="8" y="28">Hub Terminal</text>
                    <text className="source-tag source-aodb" x="8" y="39">Source: AODB</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(250, 25)" onMouseEnter={() => { setHoveredNode('Class_Passenger'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:Passenger</text>
                    <text className="subtitle" x="8" y="28">Customer Profile</text>
                    <text className="source-tag source-pss" x="8" y="39">Source: PSS</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(250, 150)" onMouseEnter={() => { setHoveredNode('Class_BoardingPass'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:BoardingPass</text>
                    <text className="subtitle" x="8" y="27">Transit Ticket</text>
                    <text className="source-tag source-pss" x="8" y="39">Source: PSS</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(480, 25)" onMouseEnter={() => { setHoveredNode('Class_Voucher'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:Voucher</text>
                    <text className="subtitle" x="8" y="28">Meal & Hotel Issue</text>
                    <text className="source-tag source-vms" x="8" y="39">Source: VMS</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(480, 150)" onMouseEnter={() => { setHoveredNode('Class_Rule'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:BusinessRule</text>
                    <text className="subtitle" x="8" y="28">Safety Policy</text>
                    <text className="source-tag source-brms" x="8" y="39">Source: BRMS</text>
                  </g>
                  <g className="graph-node class-node" transform="translate(480, 280)" onMouseEnter={() => { setHoveredNode('Class_SLA'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                    <rect width="125" height="48" rx="6" ry="6" />
                    <text className="title" x="8" y="16">kb:SLA</text>
                    <text className="subtitle" x="8" y="28">Service Agreement</text>
                    <text className="source-tag source-brms" x="8" y="39">Source: BRMS</text>
                  </g>
                </svg>
              )}
            </div>

            {/* Business Rules Checklist */}
            <div className="rules-checklist">
              <div className={`rule-check-item ${rulesSatisfied[0] ? 'satisfied' : ''}`}>
                <div className="icon-wrapper">
                  {rulesSatisfied[0] ? <Check size={14} /> : <AlertTriangle size={14} />}
                </div>
                <div className="info">
                  <span className="id">R1</span>
                  <span className="name">Open Inventory</span>
                  <span className="desc">Seats open in fare class.</span>
                </div>
              </div>
              <div className={`rule-check-item ${rulesSatisfied[1] ? 'satisfied' : ''}`}>
                <div className="icon-wrapper">
                  {rulesSatisfied[1] ? <Check size={14} /> : <AlertTriangle size={14} />}
                </div>
                <div className="info">
                  <span className="id">R2</span>
                  <span className="name">MCT Clearance</span>
                  <span className="desc">Clears transit time floor.</span>
                </div>
              </div>
              <div className={`rule-check-item ${rulesSatisfied[2] ? 'satisfied' : ''}`}>
                <div className="icon-wrapper">
                  {rulesSatisfied[2] ? <Check size={14} /> : <AlertTriangle size={14} />}
                </div>
                <div className="info">
                  <span className="id">R3</span>
                  <span className="name">Crew Duty Hours</span>
                  <span className="desc">Crew within legal duty limits.</span>
                </div>
              </div>
              <div className={`rule-check-item ${rulesSatisfied[3] ? 'satisfied' : ''}`}>
                <div className="icon-wrapper">
                  {rulesSatisfied[3] ? <Check size={14} /> : <AlertTriangle size={14} />}
                </div>
                <div className="info">
                  <span className="id">R4</span>
                  <span className="name">Turnaround Min</span>
                  <span className="desc">Aircraft turnaround &gt;= 30m.</span>
                </div>
              </div>
              <div className={`rule-check-item ${rulesSatisfied[4] ? 'satisfied' : ''}`}>
                <div className="icon-wrapper">
                  {rulesSatisfied[4] ? <Check size={14} /> : <AlertTriangle size={14} />}
                </div>
                <div className="info">
                  <span className="id">R5</span>
                  <span className="name">Loyalty Priority</span>
                  <span className="desc">Priority rebook by elite tier.</span>
                </div>
              </div>
              <div className={`rule-check-item ${rulesSatisfied[5] ? 'satisfied' : ''}`}>
                <div className="icon-wrapper">
                  {rulesSatisfied[5] ? <Check size={14} /> : <AlertTriangle size={14} />}
                </div>
                <div className="info">
                  <span className="id">R6</span>
                  <span className="name">Auth Write Scope</span>
                  <span className="desc">Operator holds PSS write scope.</span>
                </div>
              </div>
            </div>

            {/* Execute writebacks checklist */}
            {simStep === 'executing' && (
              <div className="slider-section" style={{ background: '#f8fafc', border: '1px solid var(--line-strong)' }}>
                <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '8px' }}>Committing Transactions...</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Database size={12} className={writebacks.pss === 'success' ? 'text-green-600' : 'animate-pulse text-blue-600'} />
                    <span>PSS ticket re-issue (Sabre/Amadeus) — {writebacks.pss === 'success' ? 'SUCCESS ✓' : 'PENDING'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <LayoutGrid size={12} className={writebacks.gate === 'success' ? 'text-green-600' : 'animate-pulse text-blue-600'} />
                    <span>Schiphol Stand swaps (Gate Allocation DB) — {writebacks.gate === 'success' ? 'SUCCESS ✓' : 'PENDING'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ShieldCheck size={12} className={writebacks.voucher === 'success' ? 'text-green-600' : 'animate-pulse text-blue-600'} />
                    <span>Hotel & Meal Voucher DB allocation — {writebacks.voucher === 'success' ? 'SUCCESS ✓' : 'PENDING'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Send size={12} className={writebacks.push === 'success' ? 'text-green-600' : 'animate-pulse text-blue-600'} />
                    <span>Flight Ops Mobile API alerts dispatched — {writebacks.push === 'success' ? 'SUCCESS ✓' : 'PENDING'}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Tabbed Inspector & Console */}
            <div className="ontology-tabs" style={{ marginTop: '16px' }}>
              <button 
                className={`ontology-tab ${ontologyTab === 'query' ? 'active' : ''}`} 
                onClick={() => setOntologyTab('query')}
              >
                Live Traversal Console
              </button>
              <button 
                className={`ontology-tab ${ontologyTab === 'inspector' ? 'active' : ''}`} 
                onClick={() => setOntologyTab('inspector')}
              >
                Ontology Inspector
              </button>
            </div>

            {ontologyTab === 'query' ? (
              <div className="query-console">
                <div style={{ color: '#64748b', fontSize: '9px', fontStyle: 'italic', marginBottom: '8px' }}>
                  // Live RDF/Property Graph traversals fired by the agent
                </div>
                {getQueryLines().map((line) => (
                  <div key={line.id} className={`query-line ${line.status}`}>
                    <span className="prompt">nodal&gt;</span>
                    {line.text}
                    {line.status === 'success' && <span style={{ color: '#4ade80', marginLeft: '6px' }}>✓</span>}
                    {line.status === 'active' && <span style={{ color: '#38bdf8', marginLeft: '6px' }} className="animate-pulse">●</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="schema-inspector">
                <div style={{ color: '#94a3b8', fontSize: '9px', fontStyle: 'italic', marginBottom: '8px' }}>
                  // JSON-LD Semantic definition: {hoveredNode || 'Inst_FlightLeg'} (Hover graph nodes to inspect)
                </div>
                <pre dangerouslySetInnerHTML={renderJSONHighlighted(getActiveSchema())} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Enlarged Popup Graph Modal */}
      {isModalOpen && (
        <div className="graph-modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="graph-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="graph-modal-header">
              <span className="graph-modal-title">
                <Network size={16} className="text-purple-500" />
                {graphMode === 'traversal' 
                  ? 'Active Traversal Path — Interactive Zoom View' 
                  : 'Full Ontology Schema — Interactive Zoom View'}
              </span>
              <div className="graph-modal-controls">
                <button className="graph-mode-btn" onClick={() => setModalZoom(z => Math.min(5.0, z + 0.15))}>Zoom In (+)</button>
                <span style={{ fontSize: '11px', fontFamily: 'var(--mono)', fontWeight: 'bold', color: 'var(--ink)', minWidth: '42px', textAlign: 'center' }}>
                  {Math.round(modalZoom * 100)}%
                </span>
                <button className="graph-mode-btn" onClick={() => setModalZoom(z => Math.max(0.2, z - 0.15))}>Zoom Out (-)</button>
                <button className="graph-mode-btn" onClick={() => setModalZoom(1.0)}>Reset Zoom</button>
                <div style={{ width: '1px', height: '14px', background: 'var(--line)', margin: '0 4px' }} />
                <button 
                  className="panel-toggle-btn" 
                  onClick={() => setIsModalOpen(false)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px' }}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="graph-modal-body">
              <div 
                className="graph-modal-svg-wrapper"
                style={{ 
                  transform: `scale(${modalZoom})`, 
                  transformOrigin: 'center center', 
                  transition: 'transform 0.15s ease-out' 
                }}
              >
                {graphMode === 'traversal' ? (
                  <svg width="540" height="400" viewBox="0 0 540 400" style={{ background: 'transparent' }}>
                    <defs>
                      <marker 
                        id="arrow" 
                        viewBox="0 0 10 10" 
                        refX="7" 
                        refY="5" 
                        markerWidth="6" 
                        markerHeight="6" 
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#94a3b8" />
                      </marker>
                    </defs>

                    {/* Layer dividers */}
                    <path 
                      d="M 10 170 H 530" 
                      stroke="var(--line-strong)" 
                      strokeWidth="1.5" 
                      strokeDasharray="4 4" 
                    />
                    <text x="10" y="165" fill="var(--struct)" style={{ fontFamily: 'var(--mono)', fontSize: '8px', letterSpacing: '0.05em', fontWeight: 'bold' }}>
                      SCHEMA LAYER (ONTOLOGY VOCABULARY)
                    </text>
                    <text x="10" y="195" fill="var(--muted)" style={{ fontFamily: 'var(--mono)', fontSize: '8px', letterSpacing: '0.05em', fontWeight: 'bold' }}>
                      INSTANCE LAYER (LIVE DATA PATH)
                    </text>

                    {/* --- SCHEMA LAYER ARCS --- */}
                    {/* boards */}
                    <g>
                      <path d="M 150 44 H 200" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(175, 44)">
                        <rect x="-15" y="-4" width="30" height="8" fill="var(--paper)" rx="1" ry="1" />
                        <text x="0" y="2.5" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '7px' }}>boards</text>
                      </g>
                    </g>

                    {/* requires */}
                    <g>
                      <path d="M 325 44 H 375" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(350, 44)">
                        <rect x="-17" y="-4" width="34" height="8" fill="var(--paper)" rx="1" ry="1" />
                        <text x="0" y="2.5" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '7px' }}>requires</text>
                      </g>
                    </g>

                    {/* operatedBy */}
                    <g>
                      <path d="M 87.5 63 V 110" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(87.5, 86.5) rotate(-90)">
                        <rect x="-20" y="-4" width="40" height="8" fill="var(--paper)" rx="1" ry="1" />
                        <text x="0" y="2.5" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '7px' }}>operatedBy</text>
                      </g>
                    </g>

                    {/* validates */}
                    <g>
                      <path d="M 262.5 110 V 63" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(262.5, 86.5) rotate(-90)">
                        <rect x="-18" y="-4" width="36" height="8" fill="var(--paper)" rx="1" ry="1" />
                        <text x="0" y="2.5" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '7px' }}>validates</text>
                      </g>
                    </g>

                    {/* --- INSTANCE LAYER ARCS (Traversals) --- */}
                    <path 
                      className={`graph-edge ${(simStep === 'traversal' || simStep === 'dependency' || simStep === 'rules' || simStep === 'proposal' || simStep === 'executing') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`}
                      d="M 150 245 H 200" 
                      markerEnd="url(#arrow)"
                    />
                    <path 
                      className={`graph-edge ${(simStep === 'dependency' || simStep === 'rules' || simStep === 'proposal' || simStep === 'executing') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`}
                      d="M 325 245 H 375" 
                      markerEnd="url(#arrow)"
                    />
                    <path 
                      className={`graph-edge ${(simStep === 'rules' || simStep === 'proposal' || simStep === 'executing') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`}
                      d="M 262.5 270 V 315" 
                      markerEnd="url(#arrow)"
                    />
                    <path 
                      className={`graph-edge ${(simStep === 'rules' || simStep === 'proposal' || simStep === 'executing') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`}
                      d="M 200 340 H 150" 
                      markerEnd="url(#arrow)"
                    />

                    {/* Traversal Pulses */}
                    {simStep === 'traversal' && (
                      <circle cx="150" cy="245" r="4" className="graph-pulse">
                        <animate attributeName="cx" from="150" to="200" dur="0.8s" repeatCount="indefinite" />
                      </circle>
                    )}
                    {simStep === 'dependency' && (
                      <circle cx="325" cy="245" r="4" className="graph-pulse">
                        <animate attributeName="cx" from="325" to="375" dur="0.8s" repeatCount="indefinite" />
                      </circle>
                    )}
                    {simStep === 'executing' && (
                      <>
                        <circle cx="150" cy="340" r="4" className="graph-pulse recovered">
                          <animate attributeName="cx" from="200" to="150" dur="0.6s" repeatCount="indefinite" />
                        </circle>
                        <circle cx="262" cy="270" r="4" className="graph-pulse recovered">
                          <animate attributeName="cy" from="270" to="315" dur="0.6s" repeatCount="indefinite" />
                        </circle>
                      </>
                    )}

                    {/* Schema Class Nodes */}
                    <g className="graph-node class-node" transform="translate(25, 25)">
                      <rect width="125" height="38" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:FlightLeg</text>
                      <text className="subtitle" x="8" y="28">Class blueprint</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(200, 25)">
                      <rect width="125" height="38" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:BoardingPass</text>
                      <text className="subtitle" x="8" y="28">Class blueprint</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(375, 25)">
                      <rect width="125" height="38" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:Voucher</text>
                      <text className="subtitle" x="8" y="28">Class blueprint</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(25, 110)">
                      <rect width="125" height="38" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:Aircraft</text>
                      <text className="subtitle" x="8" y="28">Class blueprint</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(200, 110)">
                      <rect width="125" height="38" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:BusinessRule</text>
                      <text className="subtitle" x="8" y="28">Class blueprint</text>
                    </g>

                    {/* Instance Nodes */}
                    <g className={`graph-node instance-node ${activeDelay > 0 && simStep !== 'recovered' ? 'delayed' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(25, 220)">
                      <rect width="125" height="50" rx="6" ry="6" />
                      <text className="title" x="8" y="16">inst:{selectedFlight}</text>
                      <text className="subtitle" x="8" y="28">FlightLeg Sector</text>
                      <text className="subtitle" x="8" y="40" fill={activeDelay > 0 && !isRecovered ? 'var(--crit)' : ''}>
                        {activeDelay > 0 ? `Delay: +${activeDelay}m` : 'On Time'}
                      </text>
                    </g>
                    <g className={`graph-node instance-node ${(simStep === 'traversal' || simStep === 'dependency' || simStep === 'rules' || simStep === 'proposal') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(200, 220)">
                      <rect width="125" height="50" rx="6" ry="6" />
                      <text className="title" x="8" y="16">inst:TransitPax</text>
                      <text className="subtitle" x="8" y="28">{totalPax} transiting pax</text>
                      <text className="subtitle" x="8" y="40" fill={connectsAtRisk > 0 && !isRecovered ? 'var(--crit)' : ''}>
                        {isRecovered ? 'Protected ✓' : connectsAtRisk > 0 ? `${connectsAtRisk} at risk` : 'Nominal'}
                      </text>
                    </g>
                    <g className={`graph-node instance-node ${connectsAtRisk > 0 && simStep !== 'recovered' ? 'delayed' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(375, 220)">
                      <rect width="125" height="50" rx="6" ry="6" />
                      <text className="title" x="8" y="16">inst:OnwardLegs</text>
                      <text className="subtitle" x="8" y="28">{activeFlightObj.connections.length} connections</text>
                      <text className="subtitle" x="8" y="40" fill={connectsAtRisk > 0 && !isRecovered ? 'var(--crit)' : ''}>
                        {isRecovered ? 'All Resolved' : connectsAtRisk > 0 ? `${atRiskConnections.length} impacted` : '0 impacted'}
                      </text>
                    </g>
                    <g className={`graph-node instance-node ${(simStep === 'rules' || simStep === 'proposal') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(200, 315)">
                      <rect width="125" height="50" rx="6" ry="6" strokeDasharray="3 3" />
                      <text className="title" x="8" y="16">inst:RebookAction</text>
                      <text className="subtitle" x="8" y="28">ProtectAndRebook</text>
                      <text className="subtitle" x="8" y="40">
                        {isRecovered ? 'Executed ✓' : simStep === 'proposal' ? 'Pending Approval' : 'Ready'}
                      </text>
                    </g>
                    <g className={`graph-node instance-node ${(simStep === 'rules' || simStep === 'proposal') ? 'active' : ''} ${isRecovered ? 'recovered' : ''}`} transform="translate(25, 315)">
                      <rect width="125" height="50" rx="6" ry="6" strokeDasharray="3 3" />
                      <text className="title" x="8" y="18">inst:Vouchers</text>
                      <text className="subtitle" x="8" y="27">Voucher allocation</text>
                      <text className="subtitle" x="8" y="40" fill={metrics.vouchers > 0 ? 'var(--warn)' : ''}>
                        {metrics.vouchers > 0 ? `${metrics.vouchers} Hotel + Meal` : '0 issued'}
                      </text>
                    </g>
                  </svg>
                ) : (
                  <svg width="100%" height="100%" viewBox="0 0 640 380">
                    <defs>
                      <marker 
                        id="arrow" 
                        viewBox="0 0 10 10" 
                        refX="7" 
                        refY="5" 
                        markerWidth="6" 
                        markerHeight="6" 
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#94a3b8" />
                      </marker>
                    </defs>

                    {/* --- FULL SCHEMA ARCS --- */}
                    {/* operatedBy */}
                    <g>
                      <path d="M 87.5 73 V 150" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(87.5, 111.5) rotate(-90)">
                        <rect x="-22.5" y="-5" width="45" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>operatedBy</text>
                      </g>
                    </g>

                    {/* boards */}
                    <g>
                      <path d="M 150 49 H 250" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(200, 49)">
                        <rect x="-17.5" y="-5" width="35" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>boards</text>
                      </g>
                    </g>

                    {/* holds */}
                    <g>
                      <path d="M 312.5 73 V 150" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(312.5, 111.5) rotate(-90)">
                        <rect x="-15" y="-5" width="30" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>holds</text>
                      </g>
                    </g>

                    {/* connectsTo: Rerouted through track y=130 to completely segregate it */}
                    <g>
                      <path d="M 250 174 H 210 V 130 H 115 V 73" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(162.5, 130)">
                        <rect x="-22.5" y="-5" width="45" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>connectsTo</text>
                      </g>
                    </g>

                    {/* assignedTo: Vertically aligned text on left-gutter vertical segment */}
                    <g>
                      <path d="M 25 174 H 10 V 304 H 25" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(10, 239) rotate(-90)">
                        <rect x="-22.5" y="-5" width="45" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>assignedTo</text>
                      </g>
                    </g>

                    {/* locatedAt */}
                    <g>
                      <path d="M 150 304 H 250" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(200, 304)">
                        <rect x="-17.5" y="-5" width="35" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>locatedAt</text>
                      </g>
                    </g>

                    {/* requires: Rerouted through track y=90 to completely segregate it */}
                    <g>
                      <path d="M 375 174 H 415 V 90 H 450 V 49 H 480" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(432.5, 90)">
                        <rect x="-17.5" y="-5" width="35" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>requires</text>
                      </g>
                    </g>

                    {/* validatedBy: Rerouted through bottom-gutter track y=240 to avoid Passenger and BoardingPass */}
                    <g>
                      <path d="M 150 60 H 185 V 240 H 445 V 174 H 480" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(315, 240)">
                        <rect x="-25" y="-5" width="50" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>validatedBy</text>
                      </g>
                    </g>

                    {/* guards */}
                    <g>
                      <path d="M 542.5 198 V 280" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" markerEnd="url(#arrow)" />
                      <g transform="translate(542.5, 239) rotate(-90)">
                        <rect x="-15" y="-5" width="30" height="10" fill="var(--paper)" rx="2" ry="2" />
                        <text x="0" y="3" fill="#64748b" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: '6.5px' }}>guards</text>
                      </g>
                    </g>

                    {/* --- FULL SCHEMA CLASS NODES --- */}
                    <g className="graph-node class-node" transform="translate(25, 25)" onMouseEnter={() => { setHoveredNode('Class_FlightLeg'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:FlightLeg</text>
                      <text className="subtitle" x="8" y="28">Sector Schedule</text>
                      <text className="source-tag source-flifo" x="8" y="39">Source: FLIFO</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(25, 150)" onMouseEnter={() => { setHoveredNode('Class_Aircraft'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:Aircraft</text>
                      <text className="subtitle" x="8" y="28">Airframe Frame</text>
                      <text className="source-tag source-flifo" x="8" y="39">Source: FLIFO</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(25, 280)" onMouseEnter={() => { setHoveredNode('Class_Stand'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:Stand</text>
                      <text className="subtitle" x="8" y="27">Parking Stand</text>
                      <text className="source-tag source-aodb" x="8" y="39">Source: AODB</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(250, 280)" onMouseEnter={() => { setHoveredNode('Class_Airport'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:Airport</text>
                      <text className="subtitle" x="8" y="28">Hub Terminal</text>
                      <text className="source-tag source-aodb" x="8" y="39">Source: AODB</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(250, 25)" onMouseEnter={() => { setHoveredNode('Class_Passenger'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:Passenger</text>
                      <text className="subtitle" x="8" y="28">Customer Profile</text>
                      <text className="source-tag source-pss" x="8" y="39">Source: PSS</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(250, 150)" onMouseEnter={() => { setHoveredNode('Class_BoardingPass'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:BoardingPass</text>
                      <text className="subtitle" x="8" y="27">Transit Ticket</text>
                      <text className="source-tag source-pss" x="8" y="39">Source: PSS</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(480, 25)" onMouseEnter={() => { setHoveredNode('Class_Voucher'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:Voucher</text>
                      <text className="subtitle" x="8" y="28">Meal & Hotel Issue</text>
                      <text className="source-tag source-vms" x="8" y="39">Source: VMS</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(480, 150)" onMouseEnter={() => { setHoveredNode('Class_Rule'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:BusinessRule</text>
                      <text className="subtitle" x="8" y="28">Safety Policy</text>
                      <text className="source-tag source-brms" x="8" y="39">Source: BRMS</text>
                    </g>
                    <g className="graph-node class-node" transform="translate(480, 280)" onMouseEnter={() => { setHoveredNode('Class_SLA'); setOntologyTab('inspector'); }} onMouseLeave={() => setHoveredNode(null)}>
                      <rect width="125" height="48" rx="6" ry="6" />
                      <text className="title" x="8" y="16">kb:SLA</text>
                      <text className="subtitle" x="8" y="28">Service Agreement</text>
                      <text className="source-tag source-brms" x="8" y="39">Source: BRMS</text>
                    </g>
                  </svg>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Human-in-the-loop approval gate for the KG-computed recovery plan */}
      <RecoveryConfirmationPanel
        isOpen={confirmOpen}
        onClose={closeRecoveryConfirmation}
        onConfirm={confirmRecovery}
        plan={liveRecoveryPlan}
        flightId={selectedFlight}
        mctMinutes={CONSOLE_MCT_MINUTES}
        destAirportLoad={destAirportLoad}
        isExecuting={simStep === 'executing'}
        isCompleted={isCompleted}
        isLoading={confirmLoading}
        reasoningStage={reasoningStage}
        reasoningLog={reasoningLog}
      />
    </div>
  );
}
