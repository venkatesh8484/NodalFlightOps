/**
 * autonomousRecoveryPlanner.js — Autonomous Passenger Recovery Engine
 *
 * Ported from PostalOps' src/lib/autonomousRebalancer.js. Where PostalOps reroutes
 * cargo consignments to alternate hubs, FlightOps rebooks at-risk connecting
 * passengers onto alternate/partner flights — the same "detect -> score -> propose
 * governance-ready actions" shape, adapted to a passenger-connection domain.
 *
 * When the delay predictor flags an airport at WARNING/CRITICAL, or a specific
 * flight has at-risk connections (via KnowledgeGraph.computeConnectionRisk), this
 * engine computes a recovery plan:
 *   1. Query the KG for the flight's downstream connection risk
 *   2. Build governance-ready RebookPassengers proposals per at-risk connection
 *   3. If the destination airport itself is congested, add a ReallocateGateCapacity proposal
 *   4. Produce action proposals for human-in-the-loop approval
 *
 * The engine is deterministic (no LLM dependency) and always produces a result.
 * It can run alongside the AI agent, which provides a second opinion.
 */

import { AlertSeverity } from './delayPredictor.js';
import { allocatePassengersToAlternates, summarizeAlternates } from './connectionRiskUtils.js';

// EU261-informed voucher policy: overnight/large delays trigger hotel+meal vouchers
// (see reference/KLM_Schiphol_Operations_Reference.md, section 4).
const OVERNIGHT_VOUCHER_THRESHOLD_MIN = 180; // 3h+, matches EU261 compensation trigger

/**
 * Compute an autonomous passenger-recovery plan for a delayed inbound flight.
 *
 * @param {import('./knowledgeGraph').KnowledgeGraph} kg
 * @param {string} flightId - Flight ID that needs recovery (e.g. 'KL1008')
 * @param {Object} [opts]
 * @param {string} [opts.trigger='DELAY']
 * @param {number} [opts.mctMinutes=50]
 * @param {Object} [opts.airportCapacityOverrides]
 * @returns {Object|null}
 */
export function computeRecoveryPlan(kg, flightId, opts = {}) {
  const { trigger = 'DELAY', mctMinutes = 50, airportCapacityOverrides = {} } = opts;
  const flight = kg.getFlight(flightId);
  if (!flight) return null;

  const timestamp = new Date().toISOString();
  const connectionRisk = kg.computeConnectionRisk(flightId, mctMinutes);
  const atRiskConnections = connectionRisk.filter(c => c.atRisk);

  if (atRiskConnections.length === 0) return null; // No recovery needed

  const totalPaxAtRisk = atRiskConnections.reduce((sum, c) => sum + c.paxAtRisk, 0);

  // ── Destination airport congestion check (cascade awareness) ──────────
  const destAirport = kg.getAirport(flight.destinationAirportId);
  const destAirportEffectiveCap = airportCapacityOverrides[flight.destinationAirportId] !== undefined
    ? airportCapacityOverrides[flight.destinationAirportId]
    : destAirport?.gateThroughputPerHr || 0;
  const destAirportUtilPct = destAirportEffectiveCap > 0
    ? Math.round((destAirport.currentThroughputPerHr / destAirportEffectiveCap) * 100)
    : 0;

  const actions = [];

  // Action 1: ReallocateGateCapacity if the connecting hub itself is under pressure
  if (destAirportUtilPct >= 70) {
    actions.push({
      actionType: 'ReallocateGateCapacity',
      parameters: {
        airportId: flight.destinationAirportId,
        additionalGateHours: destAirportUtilPct >= 85 ? 4 : 2,
        divertThresholdPct: 85,
      },
      governance: {
        requiresApproval: true,
        approverRole: 'AIRPORT_OPS_MANAGER',
        auditLogged: true,
      },
      context: {
        currentUtilPct: destAirportUtilPct,
        spareGateThroughputPerHr: Math.max(0, destAirportEffectiveCap - destAirport.currentThroughputPerHr),
      },
      sideEffects: ['AODB.updateStandPlan', 'AODB.setDivertThreshold'],
    });
  }

  // Action 2+: RebookPassengers for each at-risk connection, ordered by severity
  // (most negative buffer = most urgent) — mirrors PostalOps' SLA-priority ordering.
  const orderedRisk = [...atRiskConnections].sort((a, b) => a.bufferMin - b.bufferMin);

  let anyUnresolvedPax = false;

  for (const risk of orderedRisk) {
    // Real selection logic (see console-simulation-critique.md, Finding 2):
    // allocate connecting pax onto whichever modeled alternates actually clear
    // their own required MCT against this delayed arrival, highest loyalty
    // tier first, falling through to the next feasible alternate — and
    // finally to "unresolved" — when capacity or timing rules it out.
    const { selected, unresolvedByTier, unresolvedTotal } = allocatePassengersToAlternates(
      risk.paxByTier || {},
      risk.alternateOptions || [],
    );
    if (unresolvedTotal > 0) anyUnresolvedPax = true;

    const needsVoucher = flight.delayMinutes >= OVERNIGHT_VOUCHER_THRESHOLD_MIN
      || risk.bufferMin < -60 // missed connection by more than an hour -> overnight rebooking likely
      || unresolvedTotal > 0; // no same-day capacity on any modeled alternate -> overnight by definition

    const bestAlternate = selected[0] || null;
    const alternateConnectingFlightId = bestAlternate
      ? bestAlternate.altFlightId
      : ((risk.alternateOptions || []).length > 0 ? 'NONE_FEASIBLE_TODAY' : 'TBD');

    actions.push({
      actionType: 'RebookPassengers',
      parameters: {
        flightId: flight.id,
        alternateConnectingFlightId,
        voucherPolicy: needsVoucher ? 'HOTEL_MEAL' : 'NONE',
      },
      governance: {
        requiresApproval: true,
        approverRole: 'OCC_DUTY_MANAGER',
        auditLogged: true,
      },
      context: {
        originalConnectingFlightId: risk.onwardFlightId,
        destinationAirportId: risk.destinationAirportId,
        paxAffected: risk.paxAtRisk,
        paxByTier: risk.paxByTier,
        connectionRiskTier: flight.connectionRiskTier,
        bufferMin: risk.bufferMin,
        mctMinutes: risk.mctMinutes,
        rebookPartnerOptions: summarizeAlternates(risk.alternateOptions),
        alternates: risk.alternateOptions,
        selectedAlternates: selected,
        unresolvedByTier,
        unresolvedTotal,
        passengers: risk.passengers,
      },
      sideEffects: needsVoucher
        ? ['PSS.reissueTicket', 'VMS.allocateVoucher', 'CNS.notifyPassengers']
        : ['PSS.reissueTicket', 'CNS.notifyPassengers'],
    });
  }

  // Confidence: higher when buffers are only marginally short (clean rebook window
  // available) vs. deeply negative (harder to find same-day alternatives), further
  // discounted whenever a connection has pax the modeled alternates can't absorb today.
  const worstBuffer = Math.min(...atRiskConnections.map(c => c.bufferMin));
  const bufferConfidence = worstBuffer >= -15 ? 0.92 : worstBuffer >= -45 ? 0.78 : 0.6;
  const confidence = Math.round(bufferConfidence * (anyUnresolvedPax ? 0.85 : 1) * 100) / 100;

  const plan = {
    flightId: flight.id,
    flightOrigin: flight.originAirportId,
    flightDestination: flight.destinationAirportId,
    trigger,
    delayMinutes: flight.delayMinutes,
    totalPaxAtRisk,
    atRiskConnections,
    recommendation: {
      summary: `${atRiskConnections.length} of ${connectionRisk.length} onward connection(s) fall below the ${mctMinutes}-minute MCT after the ${flight.delayMinutes}-minute delay. ${totalPaxAtRisk} passengers require rebooking.`,
      confidence,
      estimatedVoucherPax: actions
        .filter(a => a.actionType === 'RebookPassengers' && a.parameters.voucherPolicy === 'HOTEL_MEAL')
        .reduce((s, a) => s + a.context.paxAffected, 0),
    },
    actions,
    knowledgeGraphPath: atRiskConnections.length > 0
      ? kg.buildKgPath(flight.originAirportId, flight.assignedRouteId, flight.destinationAirportId)
      : [],
    timestamp,
  };

  return plan;
}

/**
 * Run autonomous monitoring: scan all flights for connection risk and compute
 * recovery plans for any that need it.
 *
 * @param {import('./knowledgeGraph').KnowledgeGraph} kg
 * @param {number} [mctMinutes=50]
 * @param {Object} [airportCapacityOverrides]
 * @returns {{ plans: Object[], timestamp: string }}
 */
export function runAutonomousScan(kg, mctMinutes = 50, airportCapacityOverrides = {}) {
  const timestamp = new Date().toISOString();
  const plans = [];

  const delayedFlights = kg.getAllFlights().filter(f => f.delayMinutes > 0);

  for (const flight of delayedFlights) {
    const plan = computeRecoveryPlan(kg, flight.id, {
      trigger: flight.status === 'AT_RISK' ? 'CONNECTION_RISK' : 'DELAY',
      mctMinutes,
      airportCapacityOverrides,
    });
    if (plan) plans.push(plan);
  }

  return { plans, timestamp };
}

/** Format a recovery plan into a compact structure for UI/agent consumption. */
export function planToAgentFormat(plan) {
  if (!plan) return null;
  return {
    recommendation: plan.recommendation,
    atRiskConnections: plan.atRiskConnections,
    knowledgeGraphPath: plan.knowledgeGraphPath,
    actions: plan.actions,
  };
}

export { OVERNIGHT_VOUCHER_THRESHOLD_MIN };
