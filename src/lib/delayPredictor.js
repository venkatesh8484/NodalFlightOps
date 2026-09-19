/**
 * delayPredictor.js — Predictive Airport Congestion Monitoring Engine
 *
 * Continuously monitors airport gate-throughput utilization by querying the
 * Knowledge Graph, projects demand with seasonal/event multipliers, and raises
 * alerts when airports approach saturation thresholds.
 *
 * Ported from PostalOps' src/lib/capacityPredictor.js — same architecture,
 * domain renamed: Hub -> Airport, parcels/hr -> passengers/hr.
 * Flight-level connection risk (the KL1008-style scenario) is a separate,
 * more specific concern handled by KnowledgeGraph.computeConnectionRisk() —
 * this module scans network-wide airport congestion, not individual flights.
 */

// ─── Threshold Configuration ────────────────────────────────
const THRESHOLDS = {
  WATCH:    70,   // Elevated — log it, no action needed
  WARNING:  85,   // At risk  — predict time-to-saturation, prepare mitigation
  CRITICAL: 95,   // Saturated — trigger autonomous recovery proposal
};

// ─── Demand Profiles (seasonal / event surge multipliers) ───
export const DEMAND_PROFILES = {
  normal:      { label: 'Normal',        multiplier: 1.0 },
  peak:        { label: 'Peak Season',   multiplier: 1.4 },
  holiday:     { label: 'Holiday Rush',  multiplier: 1.8 },
  majorEvent:  { label: 'Major Event',   multiplier: 2.1 },
  irops:       { label: 'IROPS Cascade', multiplier: 2.4 },
};

export function getDemandLabel(multiplier) {
  if (multiplier >= 2.1) return 'IROPS Cascade';
  if (multiplier >= 1.8) return 'Major Event';
  if (multiplier >= 1.4) return 'Holiday Rush';
  if (multiplier >= 1.2) return 'Peak Season';
  return 'Normal';
}

// ─── Alert Severity ─────────────────────────────────────────
export const AlertSeverity = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

/**
 * Run a full congestion prediction scan across all airports in the Knowledge Graph.
 *
 * @param {import('./knowledgeGraph').KnowledgeGraph} kg
 * @param {number} demandMultiplier - Current demand surge multiplier (1.0-2.4)
 * @param {Object} [overrides] - Optional per-airport capacity overrides (manual slider)
 * @returns {{ predictions: Object[], alerts: Object[], timestamp: string }}
 */
export function predictAirportLoad(kg, demandMultiplier = 1.0, overrides = {}) {
  const airports = kg.getAllAirports();
  const predictions = [];
  const alerts = [];
  const timestamp = new Date().toISOString();

  for (const airport of airports) {
    const airportId = airport.id;

    const effectiveMaxCap = overrides[airportId] !== undefined
      ? overrides[airportId]
      : airport.gateThroughputPerHr;

    const baseLoad = airport.currentThroughputPerHr;
    const projectedLoad = Math.round(baseLoad * demandMultiplier);

    const inboundFlights = kg.getInboundFlights(airportId);
    const inboundDelayedCount = inboundFlights.filter(f => f.delayMinutes > 0).length;

    const utilizationPct = effectiveMaxCap > 0
      ? Math.min(100, Math.round((projectedLoad / effectiveMaxCap) * 100))
      : 100;

    const headroom = Math.max(0, effectiveMaxCap - projectedLoad);

    let status;
    if (effectiveMaxCap === 0 || airport.status === 'DOWN') {
      status = 'DOWN';
    } else if (utilizationPct >= THRESHOLDS.CRITICAL) {
      status = 'SATURATED';
    } else if (utilizationPct >= THRESHOLDS.WARNING) {
      status = 'AT_RISK';
    } else if (utilizationPct >= THRESHOLDS.WATCH) {
      status = 'ELEVATED';
    } else {
      status = 'OPERATIONAL';
    }

    let minutesToSaturation = null;
    if (demandMultiplier > 1.0 && utilizationPct < 100 && effectiveMaxCap > 0) {
      const growthRatePerHr = (demandMultiplier - 1.0) * baseLoad * 0.1;
      if (growthRatePerHr > 0) {
        const remainingCapacity = effectiveMaxCap - projectedLoad;
        minutesToSaturation = remainingCapacity > 0
          ? Math.round((remainingCapacity / growthRatePerHr) * 60)
          : 0;
      }
    }

    let alertSeverity = null;
    let alertMessage = null;

    if (status === 'DOWN') {
      alertSeverity = AlertSeverity.CRITICAL;
      alertMessage = `${airport.name} is DOWN — all inbound flights (${inboundFlights.length}) must be diverted or held.`;
    } else if (status === 'SATURATED') {
      alertSeverity = AlertSeverity.CRITICAL;
      alertMessage = `${airport.name} projected at ${utilizationPct}% gate utilization under ${getDemandLabel(demandMultiplier)}. Autonomous recovery recommended.`;
    } else if (status === 'AT_RISK') {
      alertSeverity = AlertSeverity.WARNING;
      alertMessage = `${airport.name} projected at ${utilizationPct}% utilization. ${minutesToSaturation != null ? `Est. ${minutesToSaturation} min to saturation.` : ''} ${inboundDelayedCount} delayed inbound flight(s).`;
    } else if (status === 'ELEVATED') {
      alertSeverity = AlertSeverity.INFO;
      alertMessage = `${airport.name} at ${utilizationPct}% — elevated but within operational limits.`;
    }

    const prediction = {
      airportId,
      airportName: airport.name,
      city: airport.city,
      maxCapacity: effectiveMaxCap,
      baseLoad,
      projectedLoad,
      inboundDelayedCount,
      utilizationPct,
      headroom,
      status,
      minutesToSaturation,
      alertSeverity,
      alertMessage,
      freeGates: airport.freeGates,
      gates: airport.gates,
    };

    predictions.push(prediction);
    if (alertSeverity) alerts.push(prediction);
  }

  const severityOrder = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  alerts.sort((a, b) => {
    const sev = (severityOrder[a.alertSeverity] || 3) - (severityOrder[b.alertSeverity] || 3);
    return sev !== 0 ? sev : b.utilizationPct - a.utilizationPct;
  });

  return { predictions, alerts, timestamp };
}

export function getAirportsNeedingRecovery(predictions) {
  return predictions.filter(
    p => p.alertSeverity === AlertSeverity.CRITICAL || p.alertSeverity === AlertSeverity.WARNING
  );
}

export function getNetworkSummary(predictions) {
  const total = predictions.length;
  const operational = predictions.filter(p => p.status === 'OPERATIONAL').length;
  const elevated = predictions.filter(p => p.status === 'ELEVATED').length;
  const atRisk = predictions.filter(p => p.status === 'AT_RISK').length;
  const saturated = predictions.filter(p => p.status === 'SATURATED').length;
  const down = predictions.filter(p => p.status === 'DOWN').length;

  const avgUtilization = total > 0
    ? Math.round(predictions.reduce((s, p) => s + p.utilizationPct, 0) / total)
    : 0;

  const totalCapacity = predictions.reduce((s, p) => s + p.maxCapacity, 0);
  const totalLoad = predictions.reduce((s, p) => s + p.projectedLoad, 0);
  const totalHeadroom = predictions.reduce((s, p) => s + p.headroom, 0);

  return {
    totalAirports: total,
    operational, elevated, atRisk, saturated, down,
    avgUtilization, totalCapacity, totalLoad, totalHeadroom,
    networkHealth: down > 0 || saturated > 0 ? 'CRITICAL'
      : atRisk > 0 ? 'WARNING'
      : elevated > 0 ? 'ELEVATED'
      : 'HEALTHY',
  };
}

export { THRESHOLDS };
