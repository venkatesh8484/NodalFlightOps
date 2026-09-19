/**
 * flightSimulator.js — live-vector flight simulation for the Console map
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Stage 2 of the Console revamp. Stage 1 stripped the docked "Delay
 * Configuration & Strategy" panel out of the console and replaced the
 * curated KG scenario with a live ADS-B map. The simulation comes back
 * here — but attached to a real aircraft the operator has clicked on,
 * rather than to four hardcoded inbound legs.
 *
 * The chain, end to end
 * ---------------------
 *   live ADS-B state vector
 *     → infer where it is going          (rankDestinations)
 *     → kinematic block time and ETA     (estimateArrival)
 *     → operator perturbs it             (delay / hold / speed / divert)
 *     → resulting arrival lands in the ontology  (computeLiveConnectionRisk)
 *     → governance-ready recovery actions        (computeRecoveryPlan)
 *
 * Two joins between live data and the curated ontology are worth calling
 * out, because both are places where a naive implementation quietly
 * produces nonsense:
 *
 *  1. OpenSky's /states/all carries NO route information. There is no
 *     origin, no destination, no schedule — only position, track, speed
 *     and altitude. So the destination is *inferred* from geometry, and
 *     the inference is always shown to the operator with its confidence
 *     and always overridable. It is a hypothesis, never presented as fact.
 *
 *  2. The KG's flights are stamped 2026-08-30. A live aircraft arrives
 *     today. Subtracting one from the other directly would produce buffers
 *     of tens of thousands of minutes and every connection would read as
 *     "made" — the failure would look like a working feature, which is the
 *     worst kind. `alignToArrivalDay` therefore treats each onward flight's
 *     schedule as a time-of-day in a daily bank and rolls it onto the
 *     arrival's own UTC day.
 */

import { computeRecoveryPlan } from './autonomousRecoveryPlanner.js';
import { predictAirportLoad, DEMAND_PROFILES } from './delayPredictor.js';
import { sumPaxByTier } from './loyaltyTiers.js';
import { evaluateAlternates, summarizeAlternates } from './connectionRiskUtils.js';

/* ══════════════════════════════════════════════════════════════════════
   GREAT-CIRCLE GEOMETRY
   ══════════════════════════════════════════════════════════════════════ */

const EARTH_RADIUS_NM = 3440.065;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in nautical miles. */
export function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing, degrees clockwise from true north. */
export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute angle between two headings, 0–180°. */
export function headingDeltaDeg(a, b) {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

/** KG airport nodes carry `coords: [lat, lon]`; ranked candidates and any
 *  hand-built destination carry `lat`/`lon`. Accept either shape so the
 *  caller never has to care which one it is holding. */
export function airportLatLon(ap) {
  if (!ap) return null;
  if (Array.isArray(ap.coords) && ap.coords.length === 2) {
    return { lat: ap.coords[0], lon: ap.coords[1] };
  }
  if (ap.lat != null && ap.lon != null) return { lat: ap.lat, lon: ap.lon };
  return null;
}

/* ══════════════════════════════════════════════════════════════════════
   DESTINATION INFERENCE
   ══════════════════════════════════════════════════════════════════════
   Scored on the along-track / cross-track decomposition that every
   navigation system uses. Project the vector from the aircraft to each
   candidate airport onto the aircraft's current track:

     alongTrack = distance · cos(offTrackAngle)   — how far ahead it lies
     crossTrack = distance · sin(offTrackAngle)   — how far off the line

   An airport behind the aircraft (negative alongTrack) is discarded. Of
   the rest, the best candidate is the one closest to the extended
   centreline, with a mild preference for nearer airports so a distant
   airport that happens to sit dead ahead does not outrank the field it is
   visibly descending into. */

const CONE_DEG = 60;             // widest off-track angle still considered
/* An angle alone is not enough of a filter. From the mid-Pacific, an
   airport 8000 nm away can sit inside a 60° cone and still be 3000 nm off
   the extended centreline — "ahead" in the loosest sense and a nonsense
   destination in every other. Cross-track distance is the honest cap. */
const MAX_CROSS_TRACK_NM = 400;
/* And distance needs its own cap, for a reason that only shows up in
   testing: near-antipodal points are geometrically degenerate. Every
   heading out of the South Pacific is "toward" Dubai, ~10,000 nm away, with
   a small cross-track error — so angle and cross-track both pass and the
   inference confidently proposes a destination no airliner could reach.
   Ultra-long-haul range is the physical bound that rules it out. */
const MAX_RANGE_NM = 7000;
const CROSS_TRACK_WEIGHT = 1.0;
const ALONG_TRACK_WEIGHT = 0.14;
const DESCENT_FPM = -400;        // below this the aircraft is committed down
const DESCENT_RANGE_NM = 260;    // …and an airport this close is likely it
const DESCENT_BONUS = 0.45;      // score multiplier (lower score = better)

/**
 * Rank KG airports by how plausibly the aircraft is heading to each.
 *
 * @param {Object} ac      normalised aircraft (openSkyClient.toAircraft shape)
 * @param {Array}  airports kg.getAllAirports()
 * @returns {Array} candidates, best first, each with score + confidence
 */
export function rankDestinations(ac, airports) {
  if (!ac || ac.lat == null || ac.lon == null) return [];
  const descending = (ac.verticalRateFpm ?? 0) < DESCENT_FPM;

  return airports
    .map((ap) => {
      const pos = airportLatLon(ap);
      if (!pos) return null;
      const distanceNm = haversineNm(ac.lat, ac.lon, pos.lat, pos.lon);
      const bearingDeg = initialBearingDeg(ac.lat, ac.lon, pos.lat, pos.lon);
      const offTrackDeg = headingDeltaDeg(ac.headingDeg ?? 0, bearingDeg);
      const offTrackRad = toRad(offTrackDeg);
      const alongTrackNm = distanceNm * Math.cos(offTrackRad);
      const crossTrackNm = distanceNm * Math.abs(Math.sin(offTrackRad));

      let score = crossTrackNm * CROSS_TRACK_WEIGHT + alongTrackNm * ALONG_TRACK_WEIGHT;
      if (descending && distanceNm < DESCENT_RANGE_NM) score *= DESCENT_BONUS;

      return {
        id: ap.id,
        name: ap.name,
        city: ap.city,
        role: ap.role,
        lat: pos.lat,
        lon: pos.lon,
        distanceNm: Math.round(distanceNm),
        bearingDeg: Math.round(bearingDeg),
        offTrackDeg: Math.round(offTrackDeg),
        alongTrackNm: Math.round(alongTrackNm),
        crossTrackNm: Math.round(crossTrackNm),
        score,
        ahead:
          alongTrackNm > 0
          && offTrackDeg <= CONE_DEG
          && crossTrackNm <= MAX_CROSS_TRACK_NM
          && distanceNm <= MAX_RANGE_NM,
      };
    })
    .filter((c) => c && c.ahead)
    .sort((a, b) => a.score - b.score)
    .map((c, i, arr) => ({
      ...c,
      // Confidence is a statement about how *separable* the best candidate
      // is from the runner-up, not about how sure we are in the abstract.
      // One airport dead ahead with nothing else near the centreline is a
      // strong call; two within a few degrees of each other is a guess.
      confidence:
        i > 0 ? null
          : arr.length === 1 ? 'sole candidate ahead'
          : c.crossTrackNm < 40 && arr[1].crossTrackNm > c.crossTrackNm * 3 ? 'high'
          : c.crossTrackNm < 90 ? 'moderate'
          : 'low',
    }));
}

/* ══════════════════════════════════════════════════════════════════════
   KINEMATIC ARRIVAL ESTIMATE
   ══════════════════════════════════════════════════════════════════════
   Not a flight-planning system. It is a three-segment block-time model
   that is honest about being one:

     • enroute   — remaining distance beyond the terminal segment, flown at
                   the aircraft's current ground speed
     • terminal  — the last 120 nm: descent, deceleration, vectoring and
                   approach, which never happen at cruise speed
     • taxi-in   — a flat gate allowance

   Ground speed already contains the wind the aircraft is actually in, which
   is why using it beats any assumed true airspeed. */

export const TERMINAL_SEGMENT_NM = 120;
export const TERMINAL_AVG_KT = 300;
export const TAXI_IN_MIN = 8;
export const CRUISE_FALLBACK_KT = 450;
export const MIN_CRUISE_KT = 180;
/** Vectoring and re-sequencing cost of breaking off to an alternate. */
export const DIVERSION_PENALTY_MIN = 12;
/** Turnaround + positioning leg to get pax from the alternate to the
 *  original hub. Deliberately pessimistic: a diversion is not a delay. */
export const REPOSITION_TO_ORIGINAL_MIN = 150;

/**
 * Block time and arrival for one aircraft to one airport.
 *
 * @param {Object} ac
 * @param {Object} destination  ranked-candidate or airport-like {lat, lon}
 * @param {Object} [opts]
 * @param {number} [opts.speedAdjustPct=0]  enroute speed trim, −25…+15
 * @param {number} [opts.delayMin=0]        flat delay bolted on
 * @param {number} [opts.holdMin=0]         time in the stack
 * @param {number} [opts.penaltyMin=0]      diversion / re-sequencing
 * @param {number} [opts.fromMs=Date.now()]
 */
export function estimateArrival(ac, destination, opts = {}) {
  const {
    speedAdjustPct = 0,
    delayMin = 0,
    holdMin = 0,
    penaltyMin = 0,
    fromMs = Date.now(),
  } = opts;

  const dest = airportLatLon(destination);
  if (!dest) throw new TypeError('estimateArrival: destination has no coordinates');
  const distanceNm = haversineNm(ac.lat, ac.lon, dest.lat, dest.lon);

  const baseKt = ac.velocityKt && ac.velocityKt > MIN_CRUISE_KT ? ac.velocityKt : CRUISE_FALLBACK_KT;
  const cruiseKt = Math.max(MIN_CRUISE_KT, baseKt * (1 + speedAdjustPct / 100));

  const terminalNm = Math.min(distanceNm, TERMINAL_SEGMENT_NM);
  const enrouteNm = Math.max(0, distanceNm - terminalNm);

  const enrouteMin = (enrouteNm / cruiseKt) * 60;
  const terminalMin = (terminalNm / TERMINAL_AVG_KT) * 60;
  const addedMin = delayMin + holdMin + penaltyMin;
  const blockMin = enrouteMin + terminalMin + TAXI_IN_MIN + addedMin;

  return {
    distanceNm: Math.round(distanceNm),
    cruiseKt: Math.round(cruiseKt),
    enrouteMin: Math.round(enrouteMin),
    terminalMin: Math.round(terminalMin),
    taxiMin: TAXI_IN_MIN,
    addedMin,
    blockMin: Math.round(blockMin),
    arrivalMs: fromMs + blockMin * 60_000,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   LIVE ARRIVAL → ONTOLOGY CONNECTION BANK
   ══════════════════════════════════════════════════════════════════════ */

/** The KG's key connections are a daily bank. Roll one onto the arrival's
 *  own UTC day, and to the next day if the arrival has already passed it.
 *  A three-hour look-back keeps a connection the aircraft is landing right
 *  on top of in today's bank rather than throwing it 24 hours forward. */
export function alignToArrivalDay(scheduledUtc, arrivalMs) {
  const sched = new Date(scheduledUtc);
  if (Number.isNaN(sched.getTime())) return null;
  const arrival = new Date(arrivalMs);

  let aligned = Date.UTC(
    arrival.getUTCFullYear(), arrival.getUTCMonth(), arrival.getUTCDate(),
    sched.getUTCHours(), sched.getUTCMinutes(), sched.getUTCSeconds(),
  );
  if (aligned < arrivalMs - 3 * 3_600_000) aligned += 86_400_000;
  return aligned;
}

/**
 * Connection risk for a live arrival, in the exact shape the recovery
 * planner already consumes from `kg.computeConnectionRisk`.
 */
export function computeLiveConnectionRisk(kg, airportId, arrivalMs, mctMinutes) {
  return kg.getKeyConnectionsFrom(airportId).map((onward) => {
    const alignedDep = alignToArrivalDay(onward.scheduledDepartureUtc, arrivalMs);
    const bufferMin = alignedDep == null ? null : Math.round((alignedDep - arrivalMs) / 60_000);
    const atRisk = bufferMin != null && bufferMin < mctMinutes;
    const alternateOptions = atRisk
      ? evaluateAlternates(
          onward.alternateFlightOptions,
          arrivalMs,
          mctMinutes,
          (opt) => alignToArrivalDay(opt.departureUtc, arrivalMs),
        )
      : [];
    return {
      onwardFlightId: onward.id,
      destinationAirportId: onward.destinationAirportId,
      scheduledDepartureUtc: onward.scheduledDepartureUtc,
      alignedDepartureMs: alignedDep,
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

/* ══════════════════════════════════════════════════════════════════════
   RECOVERY BRIDGE
   ══════════════════════════════════════════════════════════════════════
   The live aircraft is not in the knowledge graph and must not be written
   into it — the KG is the curated ontology and a transient ADS-B contact
   has no business mutating it.

   Instead the planner is handed a *facade*: an object whose prototype is
   the real KG, so every read (airports, routes, edges, buildKgPath) still
   resolves against real data, with only `getFlight` and
   `computeConnectionRisk` shadowed for the one synthetic flight id. That
   keeps a single source of truth for the governance envelope — approver
   roles, voucher policy, side-effect lists — instead of a second copy of
   the action shapes drifting away from the first. */

function makeKgFacade(kg, virtualFlight, connectionRisk) {
  const facade = Object.create(kg);
  facade.getFlight = (id) =>
    (id === virtualFlight.id ? virtualFlight : kg.getFlight(id));
  facade.computeConnectionRisk = (id) =>
    (id === virtualFlight.id ? connectionRisk : kg.computeConnectionRisk(id));
  return facade;
}

/** Tier the synthetic flight the way the curated dataset tiers its own. */
function riskTierFor(worstBufferMin, mctMinutes) {
  if (worstBufferMin == null) return 'STANDARD';
  if (worstBufferMin < 0) return 'MISCONNECT';
  if (worstBufferMin < mctMinutes) return 'TIGHT_MCT';
  return 'STANDARD';
}

/* ══════════════════════════════════════════════════════════════════════
   THE SIMULATION
   ══════════════════════════════════════════════════════════════════════ */

export const DEFAULT_SIM_OPTIONS = {
  destinationId: null,   // null → use the top-ranked inference
  delayMin: 0,           // 0–180
  holdMin: 0,            // 0–60
  speedAdjustPct: 0,     // −25…+15
  divertToId: '',        // '' → no diversion
  mctMinutes: 45,
  demandProfile: 'normal',
};

/**
 * Run the whole chain for one live aircraft.
 *
 * @param {Object} args
 * @param {Object} args.aircraft  normalised, ideally dead-reckoned to now
 * @param {Object} args.kg        the KnowledgeGraph singleton
 * @param {Object} [args.options] DEFAULT_SIM_OPTIONS shape
 * @param {number} [args.nowMs]
 */
export function simulateFlight({ aircraft, kg, options = {}, nowMs = Date.now() }) {
  const opts = { ...DEFAULT_SIM_OPTIONS, ...options };

  if (!aircraft || aircraft.lat == null || aircraft.lon == null) {
    return { ok: false, reason: 'No position for this aircraft.' };
  }
  if (aircraft.onGround) {
    return {
      ok: false,
      reason:
        'Aircraft is on the ground. Arrival simulation needs an airborne vector — '
        + 'a surface contact has no meaningful track or ground speed to project.',
    };
  }

  const airports = kg.getAllAirports();
  const candidates = rankDestinations(aircraft, airports);

  const normaliseAirport = (ap) => {
    const pos = airportLatLon(ap);
    return pos ? { ...ap, lat: pos.lat, lon: pos.lon } : null;
  };

  const destination = normaliseAirport(
    (opts.destinationId && airports.find((a) => a.id === opts.destinationId))
    || candidates[0]
    || null,
  );

  if (!destination) {
    return {
      ok: false,
      reason:
        'No tracked airport lies ahead of this aircraft. Its current track points '
        + 'outside the ontology’s ten-airport network — pick a destination manually to simulate anyway.',
      candidates,
    };
  }

  const inferred = !opts.destinationId;
  const destinationMeta = candidates.find((c) => c.id === destination.id) || null;

  /* ── Baseline: the aircraft continues exactly as it is flying now ── */
  const baseline = estimateArrival(aircraft, destination, { fromMs: nowMs });

  /* ── Simulated: operator perturbations applied ────────────────────── */
  const alternate = opts.divertToId
    ? normaliseAirport(airports.find((a) => a.id === opts.divertToId)) || null
    : null;
  const diverted = !!alternate && alternate.id !== destination.id;

  const flownTo = diverted ? alternate : destination;
  const simulated = estimateArrival(aircraft, flownTo, {
    speedAdjustPct: opts.speedAdjustPct,
    delayMin: opts.delayMin,
    holdMin: opts.holdMin,
    penaltyMin: diverted ? DIVERSION_PENALTY_MIN : 0,
    fromMs: nowMs,
  });

  /* A diversion does not delay the passengers by the flying time to the
     alternate — it delays them by that plus the turnaround and positioning
     leg back to the hub they were actually connecting at. Connections are
     therefore always evaluated at the ORIGINAL destination. */
  const connectionAirportId = destination.id;
  const effectiveArrivalMs = diverted
    ? simulated.arrivalMs + REPOSITION_TO_ORIGINAL_MIN * 60_000
    : simulated.arrivalMs;

  const deltaMin = Math.round((effectiveArrivalMs - baseline.arrivalMs) / 60_000);

  /* ── Ontology: what this arrival does to the connection bank ─────── */
  const connections = computeLiveConnectionRisk(
    kg, connectionAirportId, effectiveArrivalMs, opts.mctMinutes,
  );
  const atRisk = connections.filter((c) => c.atRisk);
  const paxAtRisk = atRisk.reduce((s, c) => s + (c.paxAtRisk || 0), 0);
  const worstBuffer = atRisk.length
    ? Math.min(...atRisk.map((c) => c.bufferMin))
    : null;

  /* ── Hub pressure at the arrival airport ─────────────────────────── */
  const demand = DEMAND_PROFILES[opts.demandProfile] || DEMAND_PROFILES.normal;
  const { predictions } = predictAirportLoad(kg, demand.multiplier);
  const hub = predictions.find((p) => p.airportId === connectionAirportId) || null;

  /* ── Governance-ready recovery plan ──────────────────────────────── */
  let recovery = null;
  if (atRisk.length > 0) {
    const virtualFlight = {
      id: aircraft.iataFlight || aircraft.callsign,
      type: 'Flight',
      originAirportId: null,
      destinationAirportId: connectionAirportId,
      assignedRouteId: null,
      operatingAirline: aircraft.operator,
      scheduledArrivalUtc: new Date(baseline.arrivalMs).toISOString(),
      delayMinutes: Math.max(0, deltaMin),
      connectionRiskTier: riskTierFor(worstBuffer, opts.mctMinutes),
      paxCount: 0,
      status: 'AT_RISK',
      isKeyConnection: false,
      connectingPaxByTier: {},
      connectingPassengers: [],
      alternateFlightOptions: [],
    };
    recovery = computeRecoveryPlan(
      makeKgFacade(kg, virtualFlight, connections),
      virtualFlight.id,
      { trigger: diverted ? 'DIVERSION' : 'DELAY', mctMinutes: opts.mctMinutes },
    );
    // The synthetic flight has no origin or route, so the KG path the
    // planner built from them is meaningless here. Replace it with the
    // one edge that IS real: the arrival at the hub.
    if (recovery) recovery.knowledgeGraphPath = [`Airport:${connectionAirportId}`];
  }

  return {
    ok: true,
    reason: null,
    aircraft: {
      callsign: aircraft.callsign,
      iataFlight: aircraft.iataFlight,
      icao24: aircraft.icao24,
      lat: aircraft.lat,
      lon: aircraft.lon,
      headingDeg: aircraft.headingDeg,
      velocityKt: aircraft.velocityKt,
      flightLevel: aircraft.flightLevel,
      verticalRateFpm: aircraft.verticalRateFpm,
    },
    destination: { ...destination, ...(destinationMeta || {}) },
    destinationInferred: inferred,
    confidence: destinationMeta?.confidence || null,
    candidates,
    alternate,
    diverted,
    repositionMin: diverted ? REPOSITION_TO_ORIGINAL_MIN : 0,
    baseline,
    simulated,
    effectiveArrivalMs,
    deltaMin,
    options: opts,
    demand,
    hub,
    connections,
    atRisk,
    paxAtRisk,
    worstBuffer,
    recovery,
    nowMs,
  };
}

export default simulateFlight;
