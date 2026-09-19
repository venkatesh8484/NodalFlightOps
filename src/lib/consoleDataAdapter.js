/**
 * consoleDataAdapter.js — bridges the real Knowledge Graph to the Console
 * tab's existing map/panel rendering code.
 *
 * The Console tab's rendering logic (map markers, curve tooltips, MCT risk
 * checks) was originally written against three hardcoded constants:
 * AIRPORTS, INBOUND_FLIGHTS, STATIC_FLIGHTS. Rather than rewrite that
 * rendering code, this module produces data in the EXACT SAME SHAPE from
 * the real KG (airports.json / flight_routes.json / flights.json /
 * aircraft.json), so the render logic itself needed no changes — only its
 * data source did.
 *
 * Key correctness note: `connection.offset` is defined so that the existing
 * `(offset - delay) < MCT_MINUTES` check reproduces the KG's own connection-
 * risk math exactly:
 *   offset = (onwardDepartureUtc - inboundScheduledArrivalUtc) in minutes
 *   buffer = offset - delay = onwardDepartureUtc - (scheduledArrival + delay)
 * which is precisely KnowledgeGraph.computeConnectionRisk()'s bufferMin
 * formula. So the interactive delay slider stays fully KG-grounded.
 */

import { sumPaxByTier } from './loyaltyTiers.js';
import { summarizeAlternates } from './connectionRiskUtils.js';

// The four real inbound-to-AMS flights carrying an intentional delay in the
// curated dataset (see data/flights.json) — LHR/CDG/DXB/CPH, mirroring the
// original prototype's 4-flight scenario exactly, but now backed by real
// scheduled times and real onward key-connection data instead of fabricated
// constants.
export const INBOUND_SCENARIO_FLIGHT_IDS = ['KL1008', 'KL1250', 'KL427', 'KL198'];

// Minimum Connecting Time used throughout the Console tab's interactive
// simulator. KLM's real published non-Schengen MCT at AMS is 50 minutes
// (see reference/KLM_Schiphol_Operations_Reference.md §3); the Console tab
// keeps the prototype's original illustrative 45-minute figure for its own
// UI copy/business-rule labels (R2 "Minimum Connect Time"), which is an
// acceptable simplification flagged in the design spec. The KG's other
// consumers (delayPredictor, autonomousRecoveryPlanner, Chat tab) use the
// real 50-minute DEFAULT_MCT_MINUTES from knowledgeGraph.js.
export const CONSOLE_MCT_MINUTES = 45;

/** Illustrative rebooking economics: cost/passenger scales with route
 * distance (longer reroutes cost more to rebook) — same illustrative-value
 * pattern as the original prototype's costPerPax table, but derived from a
 * real KG-held distance rather than an arbitrary per-destination constant. */
function illustrativeCostPerPax(distanceKm) {
  return Math.round(20 + (distanceKm || 4000) * 0.045);
}

/** Great-circle initial bearing from [lat1,lon1] to [lat2,lon2], in degrees —
 * used purely cosmetically to orient the plane icon toward AMS. */
function bearingDeg([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** AIRPORTS: { code: { coords: [lat, lon], name } } — same shape as the
 * original prototype's hardcoded map, now sourced from every airport the
 * curated scenario actually touches (hub + all spokes in the dataset). */
export function buildAirportsLegacyMap(kg) {
  const map = {};
  for (const airport of kg.getAllAirports()) {
    map[airport.id] = { coords: airport.coords, name: airport.name };
  }
  return map;
}

/** INBOUND_FLIGHTS: { flightId: { id, route, origin, dest, originCoords,
 * connections: [{code, offset, pax, costPerPax, rebookOption}],
 * defaultAngle } } */
export function buildInboundFlights(kg) {
  const hub = 'AMS';
  const result = {};

  for (const flightId of INBOUND_SCENARIO_FLIGHT_IDS) {
    const flight = kg.getFlight(flightId);
    if (!flight) continue;

    const origin = kg.getAirport(flight.originAirportId);
    if (!origin) continue;

    const scheduledArrivalMs = flight.scheduledArrivalUtc ? new Date(flight.scheduledArrivalUtc).getTime() : null;
    const keyConnections = kg.getKeyConnectionsFrom(hub);

    const connections = keyConnections.map((onward) => {
      const onwardDepMs = new Date(onward.scheduledDepartureUtc).getTime();
      const offset = scheduledArrivalMs != null ? Math.round((onwardDepMs - scheduledArrivalMs) / 60000) : 999;
      const route = kg.findRoute(hub, onward.destinationAirportId);
      const pax = sumPaxByTier(onward.connectingPaxByTier);
      return {
        code: onward.destinationAirportId,
        onwardFlightId: onward.id,
        offset,
        pax,
        costPerPax: illustrativeCostPerPax(route?.distanceKm),
        rebookOption: `${pax} pax → ${summarizeAlternates(onward.alternateFlightOptions)}`,
      };
    });

    result[flightId] = {
      id: flightId,
      route: `${flight.originAirportId} → ${hub}`,
      origin: flight.originAirportId,
      dest: hub,
      originCoords: origin.coords,
      connections,
      defaultAngle: bearingDeg(origin.coords, kg.getAirport(hub).coords),
      baseDelayMinutes: flight.delayMinutes || 0,
    };
  }

  return result;
}

/** Convert OpenSky ambient traffic records into the shape the Console tab's
 * "static background flights" green-marker layer already renders — real
 * live aircraft standing in for the old two hardcoded STATIC_FLIGHTS rows.
 * Fails soft: an empty array (no live traffic this refresh) renders nothing. */
export function ambientTrafficToLegacyShape(liveTraffic) {
  return (liveTraffic || []).slice(0, 12).map((t) => ({
    id: t.callsign,
    route: t.originCountry || 'Live ADS-B',
    coords: [t.lat, t.lon],
    delay: 0,
    angle: t.headingDeg || 0,
  }));
}
