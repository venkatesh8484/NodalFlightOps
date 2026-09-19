import fs from 'node:fs';
import { KnowledgeGraph } from './src/lib/knowledgeGraph.js';
import { computeRecoveryPlan } from './src/lib/autonomousRecoveryPlanner.js';

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const kg = new KnowledgeGraph();
kg.build({
  airports: load('data/airports.json'),
  routes: load('data/flight_routes.json'),
  flights: load('data/flights.json'),
  aircraft: load('data/aircraft.json'),
});

// Force an extreme MCT so even the generous evening backups can't clear it,
// to exercise the "no same-day capacity" fallback path.
const plan = computeRecoveryPlan(kg, 'KL1250', { mctMinutes: 400 });
console.log('confidence:', plan.recommendation.confidence);
for (const a of plan.actions.filter(a => a.actionType === 'RebookPassengers')) {
  console.log(a.context.originalConnectingFlightId, '-> voucher', a.parameters.voucherPolicy,
    'unresolvedTotal=', a.context.unresolvedTotal, JSON.stringify(a.context.unresolvedByTier));
}
