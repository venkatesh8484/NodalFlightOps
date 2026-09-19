# KLM Amsterdam Schiphol — Operational Ontology Dataset

Sample data for the *Nodal Schiphol Ops Console* demo, mirroring PostalOps' dataset structure
(Object Types, Link Types, Action Types) for a passenger-flight domain instead of parcels. All records
are grounded in **real KLM/Schiphol network geography** (real airport codes, coordinates, aircraft types)
and are internally consistent — every foreign key resolves. Capacity, utilization and pax figures are
illustrative, not published KLM/Schiphol operational data (same disclaimer PostalOps' dataset carries).

## Files

| File | Contents |
|------|----------|
| `ontology.schema.json` | Object Types, Link Types, Action Types — the ontology definition |
| `airports.json` | `Airport` object records (10 airports: AMS hub + 9 spokes) |
| `flight_routes.json` | `FlightRoute` object records (18 legs — 9 spokes x 2 directions) |
| `flights.json` | `Flight` object records (28 scheduled flight instances) |
| `aircraft.json` | `Aircraft` object records (19 aircraft across the KLM fleet types) |
| `links.json` | Link Type instances (operates_route / assigned_to / travels_along) |
| `actions.sample.json` | Sample Action invocations resolving the KL1008 connection-risk scenario |

## Object Type — `Airport`

| airportId | Name | City | Role | Gate thpt/hr | Util % | Status |
|-----------|------|------|------|-------------:|-------:|--------|
| AMS | Amsterdam Airport Schiphol | Amsterdam | HUB | 9,000 | 79 | OPERATIONAL |
| LHR | London Heathrow | London | SPOKE | 3,200 | 73 | OPERATIONAL |
| CDG | Paris Charles de Gaulle | Paris | SPOKE | 3,400 | 76 | OPERATIONAL |
| DXB | Dubai International | Dubai | SPOKE | 4,200 | 74 | OPERATIONAL |
| CPH | Copenhagen | Copenhagen | SPOKE | 1,800 | 64 | OPERATIONAL |
| JFK | New York JFK | New York | SPOKE | 3,100 | 81 | OPERATIONAL |
| SIN | Singapore Changi | Singapore | SPOKE | 3,600 | 67 | OPERATIONAL |
| GRU | São Paulo/Guarulhos | São Paulo | SPOKE | 2,600 | 65 | OPERATIONAL |
| HND | Tokyo Haneda | Tokyo | SPOKE | 3,000 | 82 | OPERATIONAL |
| FRA | Frankfurt | Frankfurt | SPOKE | 3,300 | 67 | OPERATIONAL |

## Anchor disruption scenario

**KL1008 (LHR → AMS) is delayed 45 minutes** — scheduled arrival 13:40Z, actual 14:25Z. AMS applies a
50-minute minimum connecting time (MCT) for non-Schengen connections (per real KLM/Schiphol guidance —
see `reference/KLM_Schiphol_Operations_Reference.md`). Against that threshold, three of KL1008's
downstream connections fall below the MCT floor and are genuinely computed (not hardcoded) as at-risk:

- **KL605 → JFK** (dep 15:00Z): buffer 35 min — AT RISK, ~10 pax
- **KL837 → SIN** (dep 15:10Z): buffer 45 min — AT RISK, ~10 pax
- **KL861 → HND** (dep 14:55Z): buffer 30 min — AT RISK, ~6 pax
- **KL791 → GRU** (dep 15:20Z): buffer 55 min — safe

Two other inbound flights are also disrupted the same day: **KL1250 (CDG → AMS, +75 min)** — the most
severe delay, putting all four onward connections at risk — and **KL427 (DXB → AMS, +35 min)**, at risk
on JFK/SIN/HND but clear on GRU. **KL198 (CPH → AMS)** is on time with no connections at risk, the
"nominal" baseline case.

## Object Type — `FlightRoute`

18 legs connecting AMS to 9 spoke airports in both directions. AMS↔LHR is marked `SLOT_CONSTRAINED`,
reflecting Heathrow's real-world slot scarcity.

## Object Type — `Flight`

28 scheduled flight instances across the 18 routes (KLM flight-number style IDs). Four are flagged
`isKeyConnection: true` (KL605/KL837/KL791/KL861) — these are the onward legs the connection-risk
calculation checks against any delayed inbound arrival.

Each of those four carries the actual passenger and rebooking detail the recovery engine reasons
over, rather than a flat headcount and a free-text suggestion:

- **`connectingPaxByTier`** — the connecting headcount broken down by Flying Blue loyalty tier
  (`PLATINUM` / `GOLD` / `SILVER` / `EXPLORER`), so rebooking can protect higher tiers first when
  alternate capacity is scarce — mirroring real OCC practice.
- **`connectingPassengers`** — a named manifest (PNR, tier, cabin, seat, FFP number, and the
  occasional special-assistance code like `WCHR`/`UMNR`) for exactly those connecting passengers —
  the entities a `RebookPassengers` action actually rebooks.
- **`alternateFlightOptions`** — the real rebooking alternatives, as structured records (carrier,
  alliance relationship, scheduled departure, per-cabin seat availability, and the MCT that specific
  alternative requires — an interline handoff needs more buffer than a same-metal one) instead of a
  single hand-authored string. `src/lib/connectionRiskUtils.js` checks each option's feasibility
  against the (possibly delayed) arrival and allocates passengers onto them tier-by-tier, falling
  through to the next feasible option — and ultimately to an overnight/voucher outcome — exactly the
  business-rule logic the free-text version never had.

## Object Type — `Aircraft`

19 aircraft spanning KLM's real fleet types (787-10, 787-9, 777-300ER, A330-300, A321neo, 737-800,
E195-E2 — see `reference/KLM_Schiphol_Operations_Reference.md` for sourcing). Two aircraft
(`PH-AOF`, `PH-EZB`) are held `STANDBY` as reserve capacity, mirroring PostalOps' two standby vehicles.

## Link Types

- **`Airport` operates_route `FlightRoute`** — 18 instances.
- **`FlightRoute` destinates_at `Airport`** — 18 instances (closes the loop so a route visibly connects both airports it serves).
- **`Flight` assigned_to `Aircraft`** — 28 instances.
- **`Flight` departs_from `Airport`** — 28 instances.
- **`Flight` arrives_at `Airport`** — 28 instances.
- **`Flight` operates_on_route `FlightRoute`** — 28 instances.
- **`Aircraft` travels_along `FlightRoute`** — 17 instances (excludes the 2 standby aircraft).

165 edges total. All seven link types are declared in `ontology.schema.json`, backed by curated
instances in `links.json`, and are the single source of truth every consumer (Explorer graph,
`KnowledgeGraph.getAllEdges()`, `toAgentContext()`) reads from — no code path re-derives
relationships from raw FK fields independently anymore.

## Action Types (deterministic writebacks)

**`RebookPassengers(flightId, alternateConnectingFlightId, voucherPolicy)`**
→ side effects: `PSS.reissueTicket`, `VMS.allocateVoucher`, `CNS.notifyPassengers`.
Requires `OCC_DUTY_MANAGER` approval; audit-logged.

**`ReallocateGateCapacity(airportId, additionalGateHours, divertThresholdPct)`**
→ side effects: `AODB.updateStandPlan`, `AODB.setDivertThreshold`.
Requires `AIRPORT_OPS_MANAGER` approval; audit-logged.

See `actions.sample.json` for the four committed invocations that resolve the KL1008 connection-risk
scenario (1x ReallocateGateCapacity on AMS + 3x RebookPassengers for the at-risk connections), each with
resolved context, side effects, approver, CBAC marking, and audit reference.

## Notes on realism

KLM's real fleet, hub structure, alliance (SkyTeam), and EU261 disruption-compensation rules are all
sourced from public documentation (cited in `reference/KLM_Schiphol_Operations_Reference.md`). Specific
per-flight/per-airport capacity, utilization, and passenger-count figures in this dataset are illustrative
values for the demo, not published KLM/Schiphol operational data — same pattern PostalOps' dataset uses
for PostNord.

## Live traffic layer

Real-time ambient background traffic near AMS and the route network airports is pulled at runtime from
the free, anonymous **OpenSky Network** REST API (`src/lib/openSkyClient.js`) — genuinely live aircraft
positions, separate from the curated `Flight`/`Aircraft` records above, which stay static so the anchor
disruption scenario is always reproducible for a demo.
