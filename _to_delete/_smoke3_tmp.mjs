import fs from 'node:fs';
import { KnowledgeGraph } from './src/lib/knowledgeGraph.js';
import { computeRecoveryPlan } from './src/lib/autonomousRecoveryPlanner.js';

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const flights = load('data/flights.json');
const f = flights.find(f => f.flightId === 'KL1250');
f.delayMinutes = 600; // ~10h delay -> arrival lands after every modeled evening backup

const kg = new KnowledgeGraph();
kg.build({
  airports: load('data/airports.json'),
  routes: load('data/flight_routes.json'),
  flights,
  aircraft: load('data/aircraft.json'),
});

const plan = computeRecoveryPlan(kg, 'KL1250', { mctMinutes: 45 });
console.log('confidence:', plan.recommendation.confidence);
for (const a of plan.actions.filter(a => a.actionType === 'RebookPassengers')) {
  console.log(a.context.originalConnectingFlightId, '-> primary', a.parameters.alternateConnectingFlightId,
    'voucher', a.parameters.voucherPolicy, 'unresolvedTotal=', a.context.unresolvedTotal,
    JSON.stringify(a.context.unresolvedByTier));
}
