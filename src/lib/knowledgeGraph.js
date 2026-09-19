/**
 * knowledgeGraph.js — Operational Knowledge Graph Engine
 *
 * Instantiates the KLM/Schiphol flight ontology with real airport, route, flight, and
 * aircraft data loaded from the JSON data pipeline. Provides typed query methods that
 * every other module (delay predictor, autonomous recovery planner, AI agent) uses
 * instead of touching hardcoded constants.
 *
 * Ported 1:1 from PostalOps' src/lib/knowledgeGraph.js — same architecture, domain
 * renamed: Hub -> Airport, LinehaulRoute -> FlightRoute, ShipmentConsignment -> Flight
 * (the at-risk/flow entity, tracking passenger connections instead of cargo),
 * TransportVehicle -> Aircraft.
 *
 * The graph is an in-memory adjacency structure indexed by entity type and ID.
 * Edges encode the three link types from the ontology schema:
 *   Airport  --operates_route-->  FlightRoute
 *   Flight   --assigned_to-->     Aircraft
 *   Aircraft --travels_along-->   FlightRoute
 */

import { sumPaxByTier } from './loyaltyTiers.js';
import { evaluateAlternates, summarizeAlternates } from './connectionRiskUtils.js';

// ─── Entity Types ────────────────────────────────────────────
const EntityType = {
  AIRPORT: 'Airport',
  ROUTE: 'FlightRoute',
  FLIGHT: 'Flight',
  AIRCRAFT: 'Aircraft',
};

// ─── Edge / Link Types ──────────────────────────────────────
const LinkType = {
  OPERATES_ROUTE: 'operates_route',
  ASSIGNED_TO: 'assigned_to',
  TRAVELS_ALONG: 'travels_along',
  DESTINATES_AT: 'destinates_at',
  DEPARTS_FROM: 'departs_from',
  ARRIVES_AT: 'arrives_at',
  OPERATES_ON_ROUTE: 'operates_on_route',
};

// Minimum connecting time for non-Schengen connections at AMS (real KLM guidance —
// see reference/KLM_Schiphol_Operations_Reference.md). Schengen-Schengen is 40min;
// this dataset's connection destinations (JFK/SIN/GRU/HND) are all non-Schengen.
const DEFAULT_MCT_MINUTES = 50;

// ─── Knowledge Graph Class ──────────────────────────────────
export class KnowledgeGraph {
  constructor() {
    // Primary stores: type → Map<id, entity>
    this.entities = {
      [EntityType.AIRPORT]: new Map(),
      [EntityType.ROUTE]: new Map(),
      [EntityType.FLIGHT]: new Map(),
      [EntityType.AIRCRAFT]: new Map(),
    };

    // Adjacency lists: entityId → [{target, linkType, metadata}]
    this.edges = new Map();

    // Reverse adjacency: entityId → [{source, linkType, metadata}]
    this.reverseEdges = new Map();

    // Semantic concept layer (SKOS taxonomy, populated by the OntologyEngine pipeline)
    this.concepts = new Map();

    // Snapshot timestamp
    this.lastUpdated = null;
  }

  // ─── Data Ingestion ──────────────────────────────────────

  /** Load airport data. Each airport becomes a graph node with typed properties. */
  loadAirports(airportsArray) {
    for (const airport of airportsArray) {
      const node = {
        id: airport.airportId,
        type: EntityType.AIRPORT,
        role: airport.role || 'SPOKE',
        name: airport.name,
        city: airport.city,
        coords: airport.coords,
        terminalType: airport.terminalType || 'SPOKE',
        gateThroughputPerHr: airport.gateThroughputPerHr || 0,
        currentThroughputPerHr: airport.currentThroughputPerHr || 0,
        currentUtilizationPct: airport.currentUtilizationPct || 0,
        status: airport.status || 'OPERATIONAL',
        gates: airport.gates || 0,
        freeGates: airport.freeGates || 0,
        marking: airport.marking || '',
        note: airport.note || '',
      };
      this.entities[EntityType.AIRPORT].set(airport.airportId, node);
    }
  }

  /** Load flight routes and build Airport↔Route edges. */
  loadRoutes(routesArray) {
    for (const route of routesArray) {
      const node = {
        id: route.routeId,
        type: EntityType.ROUTE,
        sourceAirportId: route.sourceAirportId,
        destinationAirportId: route.destinationAirportId,
        serviceType: route.serviceType || 'MAINLINE',
        distanceKm: route.distanceKm || 0,
        scheduledFlightTimeMin: route.scheduledFlightTimeMin || 0,
        operatingAirline: route.operatingAirline || '',
        maxSeats: route.maxSeats || 0,
        status: route.status || 'ACTIVE',
      };
      this.entities[EntityType.ROUTE].set(route.routeId, node);

      this._addEdge(route.sourceAirportId, route.routeId, LinkType.OPERATES_ROUTE);
      this._addEdge(route.routeId, route.destinationAirportId, LinkType.DESTINATES_AT);
    }
  }

  /** Load flights and build Flight→Aircraft edges. */
  loadFlights(flightsArray) {
    for (const f of flightsArray) {
      const node = {
        id: f.flightId,
        type: EntityType.FLIGHT,
        originAirportId: f.originAirportId,
        destinationAirportId: f.destinationAirportId,
        assignedRouteId: f.assignedRouteId,
        assignedTailNumber: f.assignedTailNumber,
        operatingAirline: f.operatingAirline || '',
        scheduledDepartureUtc: f.scheduledDepartureUtc || null,
        scheduledArrivalUtc: f.scheduledArrivalUtc || null,
        delayMinutes: f.delayMinutes || 0,
        connectionRiskTier: f.connectionRiskTier || 'STANDARD',
        paxCount: f.paxCount || 0,
        status: f.status || 'SCHEDULED',
        isKeyConnection: !!f.isKeyConnection,
        connectingPaxByTier: f.connectingPaxByTier || {},
        connectingPassengers: f.connectingPassengers || [],
        alternateFlightOptions: f.alternateFlightOptions || [],
      };
      this.entities[EntityType.FLIGHT].set(f.flightId, node);

      if (f.originAirportId) {
        this._addEdge(f.flightId, f.originAirportId, LinkType.DEPARTS_FROM);
      }
      if (f.destinationAirportId) {
        this._addEdge(f.flightId, f.destinationAirportId, LinkType.ARRIVES_AT);
      }
      if (f.assignedRouteId) {
        this._addEdge(f.flightId, f.assignedRouteId, LinkType.OPERATES_ON_ROUTE);
      }
      if (f.assignedTailNumber) {
        this._addEdge(f.flightId, f.assignedTailNumber, LinkType.ASSIGNED_TO);
      }
    }
  }

  /** Load aircraft and build Aircraft→Route edges. */
  loadAircraft(aircraftArray) {
    for (const a of aircraftArray) {
      const node = {
        id: a.tailNumber,
        type: EntityType.AIRCRAFT,
        registration: a.registration || a.tailNumber,
        aircraftType: a.aircraftType || '',
        seatCapacity: a.seatCapacity || 0,
        assignedRouteId: a.assignedRouteId,
        currentLat: a.currentLat,
        currentLon: a.currentLon,
        speedKph: a.speedKph || 0,
        etaMinutes: a.etaMinutes,
        status: a.status || 'GROUND',
      };
      this.entities[EntityType.AIRCRAFT].set(a.tailNumber, node);

      if (a.assignedRouteId) {
        this._addEdge(a.tailNumber, a.assignedRouteId, LinkType.TRAVELS_ALONG);
      }
    }
  }

  /** Load SKOS concept scheme (the taxonomy layer, from the OntologyEngine pipeline output). */
  loadConcepts(conceptGraph) {
    if (!conceptGraph?.['@graph']) return;
    for (const concept of conceptGraph['@graph']) {
      if (concept['@type'] === 'skos:Concept') {
        this.concepts.set(concept['@id'], {
          id: concept['@id'],
          prefLabel: concept.prefLabel || '',
          altLabel: concept.altLabel || [],
          scopeNote: concept.scopeNote || '',
          broader: (concept.broader || []).map(b => b['@id']),
          narrower: (concept.narrower || []).map(n => n['@id']),
          related: (concept.related || []).map(r => r['@id']),
        });
      }
    }
  }

  /** Build the full graph from all data sources at once. */
  build({ airports, routes, flights, aircraft, conceptGraph }) {
    this.loadAirports(airports || []);
    this.loadRoutes(routes || []);
    this.loadFlights(flights || []);
    this.loadAircraft(aircraft || []);
    this.loadConcepts(conceptGraph);
    this.lastUpdated = new Date().toISOString();
    return this;
  }

  // ─── Edge Management ─────────────────────────────────────

  _addEdge(sourceId, targetId, linkType, metadata = {}) {
    if (!this.edges.has(sourceId)) this.edges.set(sourceId, []);
    this.edges.get(sourceId).push({ target: targetId, linkType, ...metadata });

    if (!this.reverseEdges.has(targetId)) this.reverseEdges.set(targetId, []);
    this.reverseEdges.get(targetId).push({ source: sourceId, linkType, ...metadata });
  }

  // ─── Query Methods ───────────────────────────────────────

  getEntity(type, id) {
    return this.entities[type]?.get(id) || null;
  }

  getAirport(airportId) {
    return this.getEntity(EntityType.AIRPORT, airportId);
  }

  getAllAirports() {
    return Array.from(this.entities[EntityType.AIRPORT].values());
  }

  /**
   * Get all airports as a code-keyed object, matching the shape of the
   * prototype's hardcoded AIRPORTS constant (for drop-in compatibility with
   * the existing Console map component).
   */
  getAirportsLegacyMap() {
    const map = {};
    for (const airport of this.getAllAirports()) {
      map[airport.id] = { coords: airport.coords, name: airport.name };
    }
    return map;
  }

  getAllRoutes() {
    return Array.from(this.entities[EntityType.ROUTE].values());
  }

  getAllFlights() {
    return Array.from(this.entities[EntityType.FLIGHT].values());
  }

  getFlight(flightId) {
    return this.getEntity(EntityType.FLIGHT, flightId);
  }

  getAllAircraft() {
    return Array.from(this.entities[EntityType.AIRCRAFT].values());
  }

  getOutboundEdges(entityId, linkType = null) {
    const edges = this.edges.get(entityId) || [];
    return linkType ? edges.filter(e => e.linkType === linkType) : edges;
  }

  getInboundEdges(entityId, linkType = null) {
    const edges = this.reverseEdges.get(entityId) || [];
    return linkType ? edges.filter(e => e.linkType === linkType) : edges;
  }

  // ─── Connection-Risk Queries (replaces the prototype's hardcoded offsets) ──

  /** Key onward ("connection-worthy") flights departing a given airport. */
  getKeyConnectionsFrom(airportId) {
    return this.getAllFlights().filter(
      f => f.originAirportId === airportId && f.isKeyConnection
    );
  }

  /**
   * Compute real connection risk for an inbound flight: for each key onward
   * flight from its destination airport, the buffer between the inbound
   * flight's (delayed) arrival and the onward flight's scheduled departure,
   * checked against the minimum connecting time.
   */
  computeConnectionRisk(flightId, mctMinutes = DEFAULT_MCT_MINUTES) {
    const flight = this.getFlight(flightId);
    if (!flight || !flight.scheduledArrivalUtc) return [];

    const actualArrival = new Date(flight.scheduledArrivalUtc).getTime() + flight.delayMinutes * 60000;
    const onwardFlights = this.getKeyConnectionsFrom(flight.destinationAirportId);

    return onwardFlights.map(onward => {
      const onwardDep = new Date(onward.scheduledDepartureUtc).getTime();
      const bufferMin = Math.round((onwardDep - actualArrival) / 60000);
      const atRisk = bufferMin < mctMinutes;
      const alternateOptions = atRisk
        ? evaluateAlternates(
            onward.alternateFlightOptions,
            actualArrival,
            mctMinutes,
            (opt) => new Date(opt.departureUtc).getTime(),
          )
        : [];
      return {
        onwardFlightId: onward.id,
        destinationAirportId: onward.destinationAirportId,
        scheduledDepartureUtc: onward.scheduledDepartureUtc,
        bufferMin,
        atRisk,
        mctMinutes,
        paxAtRisk: atRisk ? sumPaxByTier(onward.connectingPaxByTier) : 0,
        paxByTier: atRisk ? onward.connectingPaxByTier : {},
        passengers: atRisk ? onward.connectingPassengers : [],
        alternateOptions,
        rebookPartnerOptions: atRisk ? summarizeAlternates(onward.alternateFlightOptions) : '',
      };
    });
  }

  // ─── Capacity & Flow Queries ──────────────────────────────

  /** Compute the headroom (spare capacity) at an airport. */
  getAirportHeadroom(airportId, demandMultiplier = 1.0) {
    const airport = this.getAirport(airportId);
    if (!airport) return null;

    const effectiveThroughput = Math.round(airport.currentThroughputPerHr * demandMultiplier);
    const headroom = airport.gateThroughputPerHr - effectiveThroughput;
    const utilizationPct = airport.gateThroughputPerHr > 0
      ? Math.round((effectiveThroughput / airport.gateThroughputPerHr) * 100)
      : 100;

    return {
      airportId,
      name: airport.name,
      city: airport.city,
      maxCapacity: airport.gateThroughputPerHr,
      effectiveThroughput,
      headroom: Math.max(0, headroom),
      utilizationPct: Math.min(100, utilizationPct),
      status: utilizationPct >= 95 ? 'SATURATED'
        : utilizationPct >= 85 ? 'AT_RISK'
        : utilizationPct >= 70 ? 'ELEVATED'
        : 'OPERATIONAL',
      freeGates: airport.freeGates,
    };
  }

  getInboundRoutes(airportId) {
    return this.getAllRoutes().filter(r => r.destinationAirportId === airportId);
  }

  getOutboundRoutes(airportId) {
    return this.getAllRoutes().filter(r => r.sourceAirportId === airportId);
  }

  getConnectedRoutes(airportId) {
    return this.getAllRoutes().filter(
      r => r.sourceAirportId === airportId || r.destinationAirportId === airportId
    );
  }

  getNeighborAirports(airportId) {
    const routes = this.getConnectedRoutes(airportId);
    const neighbors = new Set();
    for (const r of routes) {
      if (r.sourceAirportId === airportId) neighbors.add(r.destinationAirportId);
      if (r.destinationAirportId === airportId) neighbors.add(r.sourceAirportId);
    }
    return Array.from(neighbors).map(id => this.getAirport(id)).filter(Boolean);
  }

  /** Flights currently en route toward an airport. */
  getInboundFlights(airportId) {
    return this.getAllFlights().filter(
      f => f.destinationAirportId === airportId && (f.status === 'AT_RISK' || f.status === 'DELAYED' || f.status === 'SCHEDULED')
    );
  }

  /** Standby aircraft available for reassignment. */
  getStandbyAircraft() {
    return this.getAllAircraft().filter(a => a.status === 'STANDBY');
  }

  findRoute(fromAirportId, toAirportId) {
    return this.getAllRoutes().find(
      r => r.sourceAirportId === fromAirportId && r.destinationAirportId === toAirportId
    ) || null;
  }

  findPaths(fromAirportId, toAirportId, maxHops = 3) {
    const results = [];
    const visited = new Set();

    const dfs = (current, path) => {
      if (current === toAirportId) {
        results.push([...path]);
        return;
      }
      if (path.length >= maxHops) return;
      visited.add(current);

      const outRoutes = this.getOutboundRoutes(current);
      for (const route of outRoutes) {
        if (!visited.has(route.destinationAirportId)) {
          dfs(route.destinationAirportId, [...path, route.id]);
        }
      }
      visited.delete(current);
    };

    dfs(fromAirportId, []);
    return results;
  }

  // ─── Graph Traversal for KG Path Display ──────────────────

  buildKgPath(fromAirportId, routeId, toAirportId) {
    return [`Airport:${fromAirportId}`, `FlightRoute:${routeId}`, `Airport:${toAirportId}`];
  }

  /**
   * Flatten the internal adjacency store into a plain {source, target, type} edge list.
   * This is the single source of truth for every edge in the ontology — every consumer
   * (Explorer graph, agent-context serialization, stats) should read edges from here
   * instead of re-deriving relationships from raw entity FK fields, which is how the
   * Explorer, the agent context, and this store previously drifted into three different,
   * mutually-inconsistent definitions of "what the ontology's edges are."
   */
  getAllEdges() {
    const out = [];
    for (const [source, list] of this.edges.entries()) {
      for (const e of list) {
        out.push({ source, target: e.target, type: e.linkType });
      }
    }
    return out;
  }

  // ─── Serialization ────────────────────────────────────────

  /** Export the full graph as a JSON-LD-style document for the AI agent prompt. */
  toAgentContext() {
    return {
      airports: this.getAllAirports(),
      routes: this.getAllRoutes(),
      flights: this.getAllFlights(),
      aircraft: this.getAllAircraft(),
      edges: this.getAllEdges().map(e => ({ from: e.source, to: e.target, type: e.type })),
      stats: {
        totalAirports: this.entities[EntityType.AIRPORT].size,
        totalRoutes: this.entities[EntityType.ROUTE].size,
        totalFlights: this.entities[EntityType.FLIGHT].size,
        totalAircraft: this.entities[EntityType.AIRCRAFT].size,
        totalEdges: this.getAllEdges().length,
        lastUpdated: this.lastUpdated,
      },
    };
  }

  getStats() {
    return {
      airports: this.entities[EntityType.AIRPORT].size,
      routes: this.entities[EntityType.ROUTE].size,
      flights: this.entities[EntityType.FLIGHT].size,
      aircraft: this.entities[EntityType.AIRCRAFT].size,
      edges: Array.from(this.edges.values()).reduce((s, a) => s + a.length, 0),
      concepts: this.concepts.size,
      lastUpdated: this.lastUpdated,
    };
  }
}

// ─── Singleton Factory ──────────────────────────────────────

let _instance = null;

/** Build (or rebuild) the singleton KG from data files. */
export function buildKnowledgeGraph({ airports, routes, flights, aircraft, conceptGraph }) {
  _instance = new KnowledgeGraph();
  _instance.build({ airports, routes, flights, aircraft, conceptGraph });
  return _instance;
}

/** Get the current KG instance (null if not yet built). */
export function getKnowledgeGraph() {
  return _instance;
}

export { EntityType, LinkType, DEFAULT_MCT_MINUTES };
export default KnowledgeGraph;
