/**
 * connectionRiskUtils.js — real business-rule logic for turning a flight's
 * `alternateFlightOptions` (structured rebooking alternatives) into a
 * feasibility-checked, tier-prioritised rebooking plan.
 *
 * This replaces the previous approach, which parsed a single free-text
 * `rebookPartnerOptions` string and always proposed whichever alternative
 * happened to be listed first — regardless of whether it actually cleared
 * the MCT against the delayed arrival, or had any seats left. See
 * console-simulation-critique.md, Finding 2.
 *
 * Shared by knowledgeGraph.js (curated/static scenario) and
 * flightSimulator.js (live ADS-B arrivals) so both code paths reason about
 * alternates identically.
 */

import { TIER_ORDER } from './loyaltyTiers.js';

/**
 * Feasibility-check and rank a flight's alternate rebooking options against
 * an (possibly delayed) arrival time.
 *
 * @param {Array<Object>} options - raw `alternateFlightOptions` records
 * @param {number} actualArrivalMs - the arrival timestamp to check MCT against
 * @param {number} defaultMctMinutes - MCT to fall back to when an option carries none of its own
 * @param {(opt: Object) => number|null} resolveDepartureMs - computes this option's departure timestamp
 *   (a plain `Date` parse for the curated same-day dataset, or `alignToArrivalDay` for a live arrival)
 * @returns {Array<Object>} options annotated with departureMs / bufferMin / requiredMct / feasible /
 *   totalSeats, sorted soonest-departure-first (so "soonest alternative that still clears the MCT"
 *   is simply the first feasible entry)
 */
export function evaluateAlternates(options, actualArrivalMs, defaultMctMinutes, resolveDepartureMs) {
  return (options || [])
    .map((opt) => {
      const departureMs = resolveDepartureMs(opt);
      const requiredMct = opt.mctMinutesRequired ?? defaultMctMinutes;
      const bufferMin = departureMs == null ? null : Math.round((departureMs - actualArrivalMs) / 60_000);
      const feasible = bufferMin != null && bufferMin >= requiredMct;
      const totalSeats = opt.seatsAvailable
        ? Object.values(opt.seatsAvailable).reduce((s, n) => s + (n || 0), 0)
        : 0;
      return { ...opt, departureMs, bufferMin, requiredMct, feasible, totalSeats };
    })
    .sort((a, b) => (a.departureMs ?? Infinity) - (b.departureMs ?? Infinity));
}

/**
 * Allocate at-risk connecting passengers onto feasible alternates: highest
 * loyalty tier first (real-world rebooking priority), soonest-departing
 * feasible option first, capacity-checked seat by seat. Falls through to
 * the next feasible option — and ultimately to "unresolved" — exactly the
 * "fall through to the next listed option when the first is also
 * unreachable" behaviour the critique flagged as missing.
 *
 * @param {Object} paxByTier - e.g. { PLATINUM: 2, GOLD: 3, SILVER: 3, EXPLORER: 2 }
 * @param {Array<Object>} evaluatedOptions - output of evaluateAlternates()
 * @returns {{ selected: Array<Object>, unresolvedByTier: Object|null, unresolvedTotal: number }}
 */
export function allocatePassengersToAlternates(paxByTier, evaluatedOptions) {
  const remainingByTier = { ...paxByTier };
  const selected = [];

  for (const opt of evaluatedOptions) {
    if (!opt.feasible || opt.totalSeats <= 0) continue;

    let capacity = opt.totalSeats;
    const assigned = {};
    for (const tier of TIER_ORDER) {
      if (capacity <= 0) break;
      const want = remainingByTier[tier] || 0;
      const take = Math.min(want, capacity);
      if (take > 0) {
        assigned[tier] = take;
        remainingByTier[tier] = want - take;
        capacity -= take;
      }
    }

    const assignedTotal = Object.values(assigned).reduce((s, n) => s + n, 0);
    if (assignedTotal > 0) {
      selected.push({
        altFlightId: opt.altFlightId,
        carrier: opt.carrier,
        relationship: opt.relationship,
        departureLocal: opt.departureLocal,
        departureUtc: opt.departureUtc,
        bufferMin: opt.bufferMin,
        assigned,
        assignedTotal,
        seatsRemaining: opt.totalSeats - assignedTotal,
      });
    }
  }

  const unresolvedTotal = Object.values(remainingByTier).reduce((s, n) => s + n, 0);
  return {
    selected,
    unresolvedByTier: unresolvedTotal > 0 ? remainingByTier : null,
    unresolvedTotal,
  };
}

/**
 * Legacy free-text summary ("DL47 (Delta Air Lines, dep 17:35 local) or
 * VS103 (...)"), kept for the few call sites (Chat tab / consoleDataAdapter
 * map tooltips) that display a single line rather than the structured
 * option list.
 */
export function summarizeAlternates(options) {
  if (!options || options.length === 0) return 'TBD';
  return options
    .map((o) => `${o.altFlightId} (${o.carrier}, dep ${o.departureLocal} local)`)
    .join(' or ');
}
