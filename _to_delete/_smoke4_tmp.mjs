import fs from 'node:fs';
import { KnowledgeGraph } from './src/lib/knowledgeGraph.js';
import { computeLiveConnectionRisk, alignToArrivalDay } from './src/lib/flightSimulator.js';
import { computeRecoveryPlan } from './src/lib/autonomousRecoveryPlanner.js';

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const kg = new KnowledgeGraph();
kg.build({
  airports: load('data/airports.json'),
  routes: load('data/flight_routes.json'),
  flights: load('data/flights.json'),
  aircraft: load('data/aircraft.json'),
});

// Reproduce the reported scenario: arrival at AMS 11:33Z, MCT 80min.
const arrivalMs = Date.UTC(2026, 8, 6, 11, 33, 0); // 2026-09-06T11:33:00Z (arbitrary "today")
const risk = computeLiveConnectionRisk(kg, 'AMS', arrivalMs, 80);
for (const r of risk) {
  console.log(`${r.onwardFlightId} -> ${r.destinationAirportId}: aligned=${new Date(r.alignedDepartureMs).toISOString()} buffer=${r.bufferMin} atRisk=${r.atRisk} paxAtRisk=${r.paxAtRisk}`);
}
console.log('\n--- recovery plan ---');
const virtualFlight = {
  id: 'TEST123', type: 'Flight', originAirportId: null, destinationAirportId: 'AMS',
  assignedRouteId: null, operatingAirline: 'TEST', scheduledArrivalUtc: new Date(arrivalMs).toISOString(),
  delayMinutes: 0, connectionRiskTier: 'STANDARD', paxCount: 0, status: 'AT_RISK',
  isKeyConnection: false, connectingPaxByTier: {}, connectingPassengers: [], alternateFlightOptions: [],
};
const facade = Object.create(kg);
facade.getFlight = (id) => (id === 'TEST123' ? virtualFlight : kg.getFlight(id));
facade.computeConnectionRisk = (id) => (id === 'TEST123' ? risk : kg.computeConnectionRisk(id));
const plan = computeRecoveryPlan(facade, 'TEST123', { mctMinutes: 80 });
if (!plan) { console.log('no plan'); } else {
  console.log('confidence', plan.recommendation.confidence, '| pax at risk', plan.totalPaxAtRisk);
  for (const a of plan.actions.filter(a => a.actionType === 'RebookPassengers')) {
    console.log(a.context.originalConnectingFlightId, '-> primary', a.parameters.alternateConnectingFlightId, 'unresolved=', a.context.unresolvedTotal);
  }
}
