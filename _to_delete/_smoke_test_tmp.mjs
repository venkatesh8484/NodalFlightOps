import fs from 'node:fs';
import { KnowledgeGraph } from './src/lib/knowledgeGraph.js';
import { computeRecoveryPlan } from './src/lib/autonomousRecoveryPlanner.js';

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const airports = load('data/airports.json');
const routes = load('data/flight_routes.json');
const flights = load('data/flights.json');
const aircraft = load('data/aircraft.json');

const kg = new KnowledgeGraph();
kg.build({ airports, routes, flights, aircraft });

for (const flightId of ['KL1250', 'KL427', 'KL1008', 'KL198']) {
  console.log('\n=================', flightId, '=================');
  const risk = kg.computeConnectionRisk(flightId, 45);
  for (const r of risk) {
    console.log(`  ${r.onwardFlightId} -> ${r.destinationAirportId}: buffer ${r.bufferMin}min atRisk=${r.atRisk} paxAtRisk=${r.paxAtRisk} tiers=${JSON.stringify(r.paxByTier)}`);
    for (const alt of r.alternateOptions) {
      console.log(`      alt ${alt.altFlightId} (${alt.carrier}) buffer=${alt.bufferMin} req=${alt.requiredMct} feasible=${alt.feasible} seats=${alt.totalSeats}`);
    }
  }
  const plan = computeRecoveryPlan(kg, flightId, { mctMinutes: 45 });
  if (!plan) { console.log('  no recovery plan (nothing at risk)'); continue; }
  console.log('  SUMMARY:', plan.recommendation.summary, 'confidence=', plan.recommendation.confidence);
  for (const a of plan.actions) {
    if (a.actionType !== 'RebookPassengers') { console.log('  [gate]', a.actionType, a.parameters); continue; }
    console.log(`  [rebook] onward=${a.context.originalConnectingFlightId} -> primary alt=${a.parameters.alternateConnectingFlightId} voucher=${a.parameters.voucherPolicy}`);
    for (const sel of a.context.selectedAlternates) {
      console.log(`      selected ${sel.altFlightId}: ${JSON.stringify(sel.assigned)} (total ${sel.assignedTotal}, seatsRemaining ${sel.seatsRemaining})`);
    }
    if (a.context.unresolvedTotal > 0) {
      console.log(`      UNRESOLVED: ${a.context.unresolvedTotal} pax`, a.context.unresolvedByTier);
    }
    console.log(`      manifest sample: ${a.context.passengers.slice(0,2).map(p => p.name + ' (' + p.tier + ')').join(', ')}`);
  }
}
