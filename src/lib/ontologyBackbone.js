// ============================================
// Ontology backbone — shared class/relation model
// ============================================
// The single source of truth for the CLASS-LEVEL ontology, derived at module
// load from the artifacts the OntologyEngine writes to src/data/:
//   04_thesaurus.json  -> concepts, aliases, scope notes, BT/NT hierarchy
//   05_ontology.json   -> declared classes and Domain/Verb/Range triples
//   02_metadata_standard.json -> Concept_ID -> Preferred Term resolution
//
// Extracted out of ExplorerTab so the Chat tab's graph-traversal panel draws
// its class nodes and relation edges from the SAME backbone the Explorer
// renders — the chat's "graph traversal" is then provably not a different
// graph. Mirrors PostalOps, where both live together in App.jsx.

import thesaurus from '../data/04_thesaurus.json';
import ontologySchema from '../data/05_ontology.json';
import metadataStandard from '../data/02_metadata_standard.json';

// ─── Resolve a thesaurus Concept_ID to its Preferred Term ──────────────────
export const getTermFromId = (id) => {
  const meta = metadataStandard.find((item) => item.Concept_ID === id);
  return meta ? meta.Preferred_Term_PT : null;
};

// ─── Keyword -> legend color (matches PostalOps' getColorForClass) ─────────
export const getColorForClass = (name) => {
  const n = name.toLowerCase();
  if (n.includes('airport') || n.includes('terminal') || n.includes('gateway') || n.includes('kiosk') || n.includes('desk')) return '#10b981'; // green
  if (n.includes('aircraft') || n.includes('crew')) return '#3b82f6'; // blue
  if (n.includes('flight') || n.includes('route')) return '#ec4899'; // pink
  if (n.includes('airline') || n.includes('iata')) return '#8b5cf6'; // purple
  if (n.includes('telemetry') || n.includes('event') || n.includes('fault') || n.includes('hold') || n.includes('surge') || n.includes('ping')) return '#ef4444'; // red
  if (n.includes('action')) return '#eab308'; // yellow
  return '#64748b'; // slate
};

// ─── Class -> illustrative live-schema properties (shown in the detail panel) ──
export const CLASS_PROPERTIES = {
  Airport: [
    { name: 'airportId', type: 'string', desc: 'IATA code, e.g. AMS' },
    { name: 'role', type: 'string', desc: 'HUB | SPOKE' },
    { name: 'name', type: 'string', desc: 'Full airport name' },
    { name: 'city', type: 'string', desc: 'City location' },
    { name: 'coords', type: 'array', desc: '[latitude, longitude]' },
    { name: 'gateThroughputPerHr', type: 'integer', desc: 'Design gate throughput' },
    { name: 'currentUtilizationPct', type: 'integer', desc: 'Live gate utilization %' },
    { name: 'status', type: 'string', desc: 'OPERATIONAL | DEGRADED | OFFLINE' },
  ],
  Airline: [
    { name: 'airlineId', type: 'string', desc: 'IATA airline code' },
    { name: 'name', type: 'string', desc: 'Airline name' },
    { name: 'homeCountry', type: 'string', desc: 'ISO-3166 alpha-2 country code' },
    { name: 'allianceType', type: 'string', desc: 'MAINLINE | JOINT_VENTURE | CODESHARE' },
  ],
  Crew: [
    { name: 'crewId', type: 'string', desc: 'Crew roster key' },
    { name: 'role', type: 'string', desc: 'PILOT | CABIN_CREW' },
    { name: 'homeBaseAirportId', type: 'string', desc: 'Home base airport reference' },
    { name: 'hoursAvailableToday', type: 'number', desc: 'Duty hours remaining' },
    { name: 'status', type: 'string', desc: 'ON_DUTY | OFF_DUTY | RESTING' },
  ],
  'Flight Route': [
    { name: 'routeId', type: 'string', desc: 'Route key, e.g. RTE-AMS-JFK' },
    { name: 'sourceAirportId', type: 'string', desc: 'Origin airport reference' },
    { name: 'destinationAirportId', type: 'string', desc: 'Destination airport reference' },
    { name: 'distanceKm', type: 'number', desc: 'Great-circle distance' },
    { name: 'scheduledFlightTimeMin', type: 'integer', desc: 'Block time in minutes' },
    { name: 'operatingAirline', type: 'string', desc: 'Operating / joint-venture airline' },
    { name: 'status', type: 'string', desc: 'ACTIVE | SEASONAL | SLOT_CONSTRAINED' },
  ],
  Aircraft: [
    { name: 'tailNumber', type: 'string', desc: 'Registration, e.g. PH-BVA' },
    { name: 'aircraftType', type: 'string', desc: 'e.g. B777-300ER' },
    { name: 'seatCapacity', type: 'integer', desc: 'Total seats' },
    { name: 'assignedRouteId', type: 'string', desc: 'Current rotation route reference' },
    { name: 'status', type: 'string', desc: 'EN_ROUTE | BOARDING | GROUND | STANDBY' },
  ],
  Flight: [
    { name: 'flightId', type: 'string', desc: 'Flight number, e.g. KL1008' },
    { name: 'originAirportId', type: 'string', desc: 'Origin airport reference' },
    { name: 'destinationAirportId', type: 'string', desc: 'Destination airport reference' },
    { name: 'assignedRouteId', type: 'string', desc: 'Flight route reference' },
    { name: 'assignedTailNumber', type: 'string', desc: 'Assigned aircraft reference' },
    { name: 'delayMinutes', type: 'integer', desc: 'Current delay against schedule' },
    { name: 'connectionRiskTier', type: 'string', desc: 'TIGHT_MCT | STANDARD | BUFFERED' },
    { name: 'paxCount', type: 'integer', desc: 'Passengers aboard' },
    { name: 'status', type: 'string', desc: 'SCHEDULED | AT_RISK | DELAYED | DIVERTED | LANDED' },
  ],
  'Aircraft Assignment': [
    { name: 'assignmentId', type: 'string', desc: 'Assignment reference key' },
    { name: 'flightId', type: 'string', desc: 'Flight reference' },
    { name: 'tailNumber', type: 'string', desc: 'Assigned aircraft reference' },
    { name: 'routeId', type: 'string', desc: 'Assigned route reference' },
  ],
  'Telemetry Event': [
    { name: 'eventId', type: 'string', desc: 'Event tracking key' },
    { name: 'eventTs', type: 'string', desc: 'Event timestamp' },
    { name: 'eventType', type: 'string', desc: 'MECH_FAULT | WEATHER_HOLD | DELAY | ADSB_PING' },
    { name: 'severity', type: 'string', desc: 'INFO | WARN | CRITICAL' },
    { name: 'airportId', type: 'string', desc: 'Associated airport (if on ground)' },
    { name: 'tailNumber', type: 'string', desc: 'Associated aircraft (if in flight)' },
  ],
  'Action Type': [
    { name: 'actionName', type: 'string', desc: 'Operational command name' },
    { name: 'description', type: 'string', desc: 'What the action does' },
    { name: 'parameterSchema', type: 'string', desc: 'JSON parameter schema' },
    { name: 'requiresApproval', type: 'boolean', desc: 'Governance gate' },
  ],
  'Action Execution': [
    { name: 'executionId', type: 'string', desc: 'Execution tracking key' },
    { name: 'actionName', type: 'string', desc: 'Executed action reference' },
    { name: 'parametersJson', type: 'string', desc: 'Supplied parameter values' },
    { name: 'proposedBy', type: 'string', desc: 'Originating agent' },
    { name: 'approvedBy', type: 'string', desc: 'Approving operator' },
    { name: 'status', type: 'string', desc: 'PROPOSED | APPROVED | EXECUTED' },
  ],
};
export const getPropertiesForClass = (name) =>
  CLASS_PROPERTIES[name] || [
    { name: 'concept_id', type: 'string', desc: 'Taxonomy unique identifier' },
    { name: 'preferred_term', type: 'string', desc: 'Standardized semantic preferred term' },
  ];

// ─── Ontology-schema class id (PascalCase) -> thesaurus Preferred Term ─────
export const CLASS_TO_PT = {
  Airport: 'Airport',
  PassengerTerminal: 'Passenger Terminal',
  CargoTerminal: 'Cargo Terminal',
  GroundHandlingFacility: 'Ground Handling Facility',
  HubAirport: 'Hub Airport',
  SpokeAirport: 'Spoke Airport',
  InternationalGateway: 'International Gateway',
  FlightRoute: 'Flight Route',
  Airline: 'Airline',
  Crew: 'Crew',
  Aircraft: 'Aircraft',
  Flight: 'Flight',
  TelemetryEvent: 'Telemetry Event',
  ActionType: 'Action Type',
  ActionExecution: 'Action Execution',
  ActionExecutionLog: 'Action Execution',
  AircraftAssignment: 'Aircraft Assignment',
};
export const mapClassNameToPT = (className) => CLASS_TO_PT[className] || className;

// ─── Build ONTOLOGY_CLASSES from the thesaurus (one entry per concept) ─────
export const ONTOLOGY_CLASSES = {};
thesaurus.forEach((item) => {
  const name = item.PT;
  ONTOLOGY_CLASSES[name] = {
    name,
    metaType: name === 'Action Execution' ? 'AUTO_RECORD' : name.toLowerCase().includes('action') ? 'ACTION' : 'THING',
    color: getColorForClass(name),
    properties: getPropertiesForClass(name),
    desc: item.Scope_Note_SN,
    aliases: item.UF || [],
    parentClass: item.BT && item.BT.length > 0 ? getTermFromId(item.BT[0]) : null,
  };
});

// ─── Build ONTOLOGY_RELATIONS: (1) subClassOf from thesaurus BT, (2) semantic
// object properties from the ontology schema's Domain/Range/Verb triples ────
export const ONTOLOGY_RELATIONS = [];
thesaurus.forEach((item) => {
  (item.BT || []).forEach((btId) => {
    const parentName = getTermFromId(btId);
    if (parentName && ONTOLOGY_CLASSES[parentName]) {
      ONTOLOGY_RELATIONS.push({
        id: `${item.PT}_subClassOf_${parentName}`,
        source: item.PT,
        target: parentName,
        label: 'subClassOf',
        type: 'structural',
      });
    }
  });
});
ontologySchema.Object_Properties.forEach((prop, idx) => {
  const mappedDomain = mapClassNameToPT(prop.Domain);
  const mappedRange = mapClassNameToPT(prop.Range);
  if (ONTOLOGY_CLASSES[mappedDomain] && ONTOLOGY_CLASSES[mappedRange]) {
    ONTOLOGY_RELATIONS.push({
      id: `${mappedDomain}_${prop.Verb}_${mappedRange}_${idx}`,
      source: mappedDomain,
      target: mappedRange,
      label: prop.Verb,
      type: prop.Verb.toLowerCase().includes('execut') ? 'action' : 'structural',
    });
  }
});

// ─── Keyword -> SVG icon path (matches PostalOps' getIconPath cascade) ─────
export const getIconPath = (id) => {
  const lid = id.toLowerCase();
  if (lid.includes('airport') || lid.includes('terminal') || lid.includes('gateway') || lid.includes('kiosk') || lid.includes('desk')) {
    return 'M3 21h18M5 21V8l7-4 7 4v13M8 14h2v2H8zm0-4h2v2H8zm6 4h2v2h-2zm0-4h2v2h-2z'; // Building
  }
  if (lid.includes('aircraft') || lid.includes('crew')) {
    return 'M14 18H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h8m0 12h6a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-3l-3-3H14v13M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm11 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'; // Plane-ish truck glyph, matches PostalOps' vehicle icon family
  }
  if (lid.includes('flight') || lid.includes('route') || lid.includes('assignment')) {
    return 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'; // Package/hex
  }
  if (lid.includes('event') || lid.includes('telemetry') || lid.includes('fault') || lid.includes('hold') || lid.includes('surge') || lid.includes('ping')) {
    return 'M12 22a2 2 0 0 0 2-2H10a2 2 0 0 0 2 2zm6-6V10a6 6 0 0 0-12 0v6l-2 2v1h16v-1l-2-2z'; // Bell
  }
  if (lid.includes('action')) {
    return 'M13 2L3 14h9l-1 8 10-12h-9l1-8z'; // Bolt
  }
  if (lid.includes('iata')) {
    return 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'; // Document
  }
  return 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14h-2v-4h2zm0-6h-2V8h2z'; // Info
};

// ─── Knowledge-Agent traversal helpers ─────────────────────────────────────
// These build graph-panel nodes/edges directly from the SAME ONTOLOGY_CLASSES /
// ONTOLOGY_RELATIONS backbone that powers the Ontology Graph Explorer tab, so
// the chat's "graph traversal" is never a different graph from the schema view.
// Ported from PostalOps' kgClassNode / kgInstanceNode / kgRelation helpers.

/** A schema-level node: an ontology class, styled by its metaType. */
export const kgClassNode = (name) => {
  const cls = ONTOLOGY_CLASSES[name];
  return {
    id: name,
    label: name,
    kind: 'class',
    metaType: cls ? cls.metaType : 'THING',
    color: cls ? cls.color : '#64748b',
    desc: cls ? cls.desc : '',
  };
};

/** An instance-level node: one live record (a flight, airport, tail, route). */
export const kgInstanceNode = (id, label, status = 'normal') => ({
  id,
  label,
  kind: 'instance',
  status,
});

/** A schema-level edge — the verb comes verbatim from 05_ontology.json / thesaurus BT. */
export const kgRelation = (source, target, label) => ({ source, target, label, kind: 'relation' });

/** A class -> instance edge ("this class has this live record"). */
export const kgInstanceLink = (source, target, label = 'hasRecord') => ({
  source,
  target,
  label,
  kind: 'instance',
});

// Entity-id shapes for each live KG type, used to recover a traversal from a
// free-text LLM answer. Every candidate is verified against the live graph
// before it becomes a node, so a hallucinated id is never drawn.
//
// Airport codes and flight numbers are deliberately loose patterns (any 3-letter
// uppercase token, any 2-letter + 3/4-digit token) because they are validated
// against the KG anyway — a loose pattern plus a hard existence check finds more
// real entities than a hardcoded list of the ten airports currently loaded.
export const ENTITY_ID_PATTERNS = [
  { re: /\b[A-Z]{2}\d{3,4}\b/g, type: 'flight', cls: 'Flight' },
  { re: /\bRTE-[A-Z0-9-]+\b/g, type: 'route', cls: 'Flight Route' },
  { re: /\b[A-Z]{1,2}-[A-Z]{3,5}\b/g, type: 'aircraft', cls: 'Aircraft' },
  { re: /\bCRW-[A-Z0-9-]+\b/g, type: 'crew', cls: 'Crew' },
  { re: /\bEVT-[A-Z0-9-]+\b/g, type: 'event', cls: 'Telemetry Event' },
  { re: /\bASG-[A-Z0-9-]+\b/g, type: 'assignment', cls: 'Aircraft Assignment' },
  { re: /\b[A-Z]{3}\b/g, type: 'airport', cls: 'Airport' },
];

/**
 * Recover a graph-panel traversal FROM an answer's text.
 *
 * A real LLM answer doesn't arrive with a pre-built traversal the way the local
 * engine's canned branches do. Rather than leave the panel empty, find which
 * live entity ids and thesaurus concepts the answer actually mentions, verify
 * each against the live KG (filtering out anything hallucinated), and draw the
 * real edges between them — so the panel shows how the answer was derived
 * rather than a fabricated path.
 *
 * @param {string} answerText   the agent's reply
 * @param {object} kg           the live KnowledgeGraph singleton
 * @returns {{nodes:Array, edges:Array, walkPath:Array}|null}
 */
export function buildTraversalGraphFromAnswer(answerText, kg) {
  if (!kg || !answerText) return null;

  const flights = kg.getAllFlights();
  const aircraft = kg.getAllAircraft();
  const routes = kg.getAllRoutes();

  const foundIds = [];
  const seenIds = new Set();

  for (const { re, type, cls } of ENTITY_ID_PATTERNS) {
    for (const match of answerText.matchAll(re)) {
      const id = match[0];
      if (seenIds.has(id)) continue;

      const existsLive =
        (type === 'airport' && Boolean(kg.getAirport(id))) ||
        (type === 'flight' && flights.some((f) => f.id === id || f.flightId === id)) ||
        (type === 'aircraft' && aircraft.some((a) => a.id === id || a.tailNumber === id)) ||
        (type === 'route' && routes.some((r) => r.id === id || r.routeId === id)) ||
        // Crew, telemetry events and assignments are CSV-level records rather
        // than KG nodes — accept them as labels, matching PostalOps' treatment
        // of drivers and carriers.
        type === 'crew' ||
        type === 'event' ||
        type === 'assignment';

      if (!existsLive) continue;

      seenIds.add(id);
      foundIds.push({ id, type, cls });
      if (foundIds.length >= 15) break;
    }
    if (foundIds.length >= 15) break;
  }

  // Definitional answers ("what is MCT") reference a thesaurus concept by name
  // rather than an entity id — match those too, so a definition question still
  // draws something meaningful instead of nothing.
  const foundConcepts = [];
  const lowerText = answerText.toLowerCase();
  for (const entry of thesaurus) {
    const terms = [entry.PT, ...(entry.UF || [])].filter(Boolean);
    if (terms.some((t) => t.length > 3 && lowerText.includes(t.toLowerCase()))) {
      foundConcepts.push({ id: entry.Concept_ID, label: entry.PT });
      if (foundConcepts.length >= 4) break;
    }
  }

  if (foundIds.length === 0 && foundConcepts.length === 0) return null;

  const statusOf = (f) => {
    if (f.type === 'airport') {
      const airport = kg.getAirport(f.id);
      if (!airport) return 'normal';
      if (airport.status !== 'OPERATIONAL') return 'critical';
      return (airport.currentUtilizationPct ?? 0) < 60 ? 'healthy' : 'normal';
    }
    if (f.type === 'flight') {
      const flight = flights.find((x) => x.id === f.id || x.flightId === f.id);
      if (!flight) return 'normal';
      if (flight.status === 'AT_RISK' || flight.status === 'DIVERTED') return 'critical';
      if ((flight.delayMinutes ?? 0) > 0) return 'action';
      return 'healthy';
    }
    return 'normal';
  };

  const classesUsed = [...new Set(foundIds.map((f) => f.cls))];
  const nodes = [
    ...classesUsed.map(kgClassNode),
    ...foundIds.map((f) => kgInstanceNode(f.id, f.id, statusOf(f))),
    ...foundConcepts.map((c) => kgInstanceNode(c.id, c.label, 'normal')),
  ];

  const idSet = new Set(foundIds.map((f) => f.id));
  const edges = foundIds.map((f) => kgInstanceLink(f.cls, f.id));
  const seenEdges = new Set(edges.map((e) => `${e.source}|${e.target}|${e.label}`));

  foundIds.forEach((f) => {
    [...kg.getOutboundEdges(f.id), ...kg.getInboundEdges(f.id)].forEach((e) => {
      const other = e.target ?? e.source;
      if (!other || other === f.id || !idSet.has(other)) return;
      const key = `${f.id}|${other}|${e.linkType}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push(kgRelation(f.id, other, e.linkType));
    });
  });

  return {
    nodes,
    edges,
    walkPath: [...foundIds.map((f) => f.id), ...foundConcepts.map((c) => c.id)],
  };
}

/**
 * Last-resort fallback when an answer references no recognizable live entity or
 * concept (a purely summarizing answer, say) — shows that the whole live graph
 * was in scope rather than leaving the panel blank.
 */
export function genericKgOverviewGraph() {
  return {
    nodes: [
      kgClassNode('Airport'),
      kgClassNode('Flight Route'),
      kgClassNode('Flight'),
      kgClassNode('Aircraft'),
    ],
    edges: [
      kgRelation('Flight Route', 'Airport', 'originatesAt'),
      kgRelation('Aircraft', 'Flight Route', 'travelsAlong'),
      kgRelation('Flight', 'Aircraft', 'assignedTo'),
      kgRelation('Flight', 'Airport', 'arrivesAt'),
    ],
    walkPath: ['Airport', 'Flight Route', 'Flight', 'Aircraft'],
  };
}
