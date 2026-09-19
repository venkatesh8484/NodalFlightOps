import fs from 'node:fs';
import { KnowledgeGraph } from './src/lib/knowledgeGraph.js';
import { computeLiveConnectionRisk } from './src/lib/flightSimulator.js';

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const kg = new KnowledgeGraph();
kg.build({
  airports: load('data/airports.json'), routes: load('data/flight_routes.json'),
  flights: load('data/flights.json'), aircraft: load('data/aircraft.json'),
});

// Sample "now" every 2 hours across the day, arrival = now + 0 delay: how far is
// the NEAREST bank (i.e. what's the worst-case gap an operator has to close with sliders)?
for (let h = 0; h < 24; h += 2) {
  const arrivalMs = Date.UTC(2026, 8, 6, h, 0, 0);
  const risk = computeLiveConnectionRisk(kg, 'AMS', arrivalMs, 999999); // huge MCT: just want buffers
  const nearestFuture = risk.filter(r => r.bufferMin >= 0).sort((a,b)=>a.bufferMin-b.bufferMin)[0];
  const nearestPast = risk.filter(r => r.bufferMin < 0).sort((a,b)=>b.bufferMin-a.bufferMin)[0];
  console.log(`now=${String(h).padStart(2,'0')}:00Z  nearest upcoming bank: ${nearestFuture ? nearestFuture.onwardFlightId+' in '+nearestFuture.bufferMin+'min' : 'none'}   most recent missed: ${nearestPast ? nearestPast.onwardFlightId+' '+nearestPast.bufferMin+'min ago' : 'none'}`);
}
