/**
 * loyaltyTiers.js — Flying Blue loyalty-tier reference used across the
 * connection-risk and recovery pipeline.
 *
 * The dataset models connecting passengers as a headcount-by-tier
 * (`connectingPaxByTier` on each isKeyConnection flight) rather than a
 * flat number, so recovery logic can do what real OCC rebooking does:
 * protect higher-tier passengers first when alternate capacity is scarce.
 */

/** Highest rebooking priority first — mirrors real-world OCC practice. */
export const TIER_ORDER = ['PLATINUM', 'GOLD', 'SILVER', 'EXPLORER'];

export const TIER_META = {
  PLATINUM: { label: 'Platinum', shortCode: 'P', color: '#52525b', priority: 1 },
  GOLD: { label: 'Gold', shortCode: 'G', color: '#eab308', priority: 2 },
  SILVER: { label: 'Silver', shortCode: 'S', color: '#94a3b8', priority: 3 },
  EXPLORER: { label: 'Explorer', shortCode: 'E', color: '#0369a1', priority: 4 },
};

/** Total connecting pax across all tiers. */
export function sumPaxByTier(paxByTier = {}) {
  return TIER_ORDER.reduce((sum, tier) => sum + (paxByTier[tier] || 0), 0);
}

/** Compact "P 2 · G 3 · S 4" style label for tight UI real estate. */
export function tierBreakdownLabel(paxByTier = {}) {
  return TIER_ORDER
    .filter((tier) => paxByTier[tier] > 0)
    .map((tier) => `${TIER_META[tier].shortCode} ${paxByTier[tier]}`)
    .join(' · ');
}
