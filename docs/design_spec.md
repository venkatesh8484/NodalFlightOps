# FlightOps — Design Spec (Draft v2, for review)

**Status: DRAFT — nothing gets built off this until you approve it.**
Round 1 of review is folded in below — each of your 5 answers is now marked ✅ **Decided**. One new item came out
of your answer on real-time flights: I researched feasibility (§4a) and it needs a quick confirm before build.
Everything else marked 🔶 is a smaller, non-blocking detail you can redirect at any point, including during build.

---

## 0. How I got here

I explored `PostalOps/` (connected folder) directly and read the real source, not just the KG bug-fix doc: `src/App.jsx` (6,303 lines), `src/lib/knowledgeGraph.js`, `data/ontology.schema.json` + `data/README.md`, `docs/layout_design_options.md`, `reference/existing_ontology_schema.md`, `src/ontologyEngine/*` (pipeline, aiClient, exporters, fileParsers), the CSV dataset under `src/data/csv/`, and the standalone `ontologyEngine/` (FastAPI+React) app. I also fully read what's already in `FlightOps/src/App.jsx` (1,940 lines) — it's not an empty scaffold. Everything below is grounded in that reading, not guesswork.

---

## 1. What already exists in FlightOps/

This is important — you'd already started something, and I want to build on it rather than override it.

`FlightOps/` currently has a single-screen (no tabs) React app: an **Amsterdam Schiphol (AMS) OCC — connection-recovery simulator**:

- **9 airports** as coordinates: AMS (hub) + LHR, CDG, DXB, CPH (inbound origins) + JFK, SIN, GRU, HND (connection destinations)
- **4 inbound flights** (`KL1008` LHR→AMS, `KL1250` CDG→AMS, `KL427` DXB→AMS, `KL198` CPH→AMS), each carrying **4 outbound connections** (16 passenger cohorts total) with pax counts, cost-per-pax, and specific rebooking options on partner airlines (SQ, DL, NH, LH, AF, VS, JL)
- **9 ontology classes** already sketched inline: `FlightLeg`, `BoardingPass`, `Aircraft`, `Voucher`, `BusinessRule`, `Stand`, `Airport`, `Passenger`, `SLA` (ServiceLevelAgreement) — each with a schema.org-flavored property list, matching PostalOps' `ontology.schema.json` style
- **A Leaflet map** with curved great-circle-style flight paths (this is more visually developed than PostalOps' map)
- **An 8-stage simulated agent flow**: `idle → telemetry → traversal → dependency → rules → proposal → executing → recovered`, with hardcoded Gremlin-style query strings shown per stage (`g.V().hasLabel('FlightLeg')...`) — this is the FlightOps analogue of PostalOps' reroute-agent "STAGE 0–7" panel, but **the queries are decorative strings, not real queries** — same issue the KG bug-fix doc found and fixed in PostalOps' chat.
- **A hand-built SVG force-graph-style panel** showing the ontology classes/instances and pulsing edges (`operatedBy`, `boards`, `holds`, `connectsTo`, `assignedTo`, `locatedAt`, `requires`, `validatedBy`, `guards`) as the simulation advances — this is the FlightOps analogue of PostalOps' Explorer tab graph, but scenario-specific and hand-animated rather than a generic D3 force-directed browser
- **A business-rules checklist** (R1–R6, e.g. minimum connect time, turnaround legality) and a **two-strategy comparison** ("high-value" pax protection vs "hold-rush")
- No knowledge-graph engine (`knowledgeGraph.js` equivalent) — everything is hardcoded JS objects, not a queryable graph
- No dataset files (no `data/*.json`, no `src/data/csv/*`)
- No real AI provider calls (no `aiClient.js`, no Settings modal, no API key) — the "agent" is a scripted `setSimStep()` sequence
- No OntologyEngine tab, no Explorer tab, no Chat tab — one screen only
- `package.json` has `leaflet`, `lucide-react`, `react`/`react-dom` but **not** `d3`, `mammoth`, `pdfjs-dist`, `xlsx` — the four packages PostalOps needs for the Explorer graph and the OntologyEngine file-upload pipeline

✅ **Decided:** treat this prototype as the seed for **Tab 1 (Console)**. Keep its scenario (AMS hub, KL-flight-number-style IDs, the same 4 inbound flights, the same 8-stage vocabulary, the same visual language) and rebuild it on the real architecture below: a real `KnowledgeGraph` class backing a real dataset, a real (KG-grounded, provider-fallback) AI call via `aiClient.js`, real D3 graph rendering — replacing the current hardcoded `setSimStep()` script and decorative Gremlin strings with actual queries against actual data, the same fix the KG bug-fix doc applied to PostalOps' chat.

---

## 2. Entity / data model — PostalOps → FlightOps mapping

Per your answer, cargo/bookings are **not** a tracked entity. The existing prototype already made this call correctly on its own — its "thing at risk" is **passengers/connections**, not freight, so the mapping below keeps that framing rather than inventing a cargo entity.

| PostalOps (live KG, 4 entities) | FlightOps proposal | Notes |
|---|---|---|
| **Hub** | **Airport** | `airportId` (IATA-style, e.g. `AMS`), `name`, `city`, `coords`, `terminalType` (HUB / SPOKE), `processingCapacityPerHr` → **`gateThroughputPerHr`** (pax/hr through security+gates), `currentThroughputPerHr`, `currentUtilizationPct`, `status` (OPERATIONAL/DEGRADED/DOWN), `loadingBays` → **`gates`**, `freeLoadingBays` → **`freeGates`**, `marking` |
| **LinehaulRoute** | **FlightRoute** | `routeId` (e.g. `RTE-LHR-AMS`), `sourceAirportId`, `destinationAirportId`, `mode` (ROAD/RAIL) → **`serviceType`** (MAINLINE / CODESHARE / REGIONAL), `distanceKm`, `transitTimeMin` → **`scheduledFlightTimeMin`**, `activeCarrier` → **`operatingAirline`**, `maxCapacityParcels` → **`maxSeats`**, `status` (ACTIVE/STANDBY/CONGESTED) → (ACTIVE/SEASONAL/SLOT_CONSTRAINED) |
| **ShipmentConsignment** | **Flight** (the flow/at-risk entity — *not* cargo) | `flightId` (IATA-style, e.g. `KL1008`), `serviceProduct` → **`cabinMix`** or drop, `slaLevel` (EXPRESS/PRIORITY/ECONOMY) → **`connectionRiskTier`** (TIGHT_MCT / STANDARD / BUFFERED), `parcelCount` → **`paxCount`**, `originHubId`/`targetHubId` → `originAirportId`/`destinationAirportId`, `assignedVehicleId` → **`assignedTailNumber`**, `assignedRouteId`, `slaDeadlineUtc` → **`scheduledArrivalUtc`** (+ derived MCT deadline for connecting pax), `status` (IN_TRANSIT/AT_RISK/REROUTED/STAGED/DELIVERED) → (SCHEDULED/AT_RISK/DELAYED/DIVERTED/LANDED) |
| **TransportVehicle** | **Aircraft** | `vehicleId` → **`tailNumber`**, `plate` → **`registration`**, `type` → **`aircraftType`** (e.g. `B777`, `B789`, `E190` — already used in your prototype's `Aircraft` class), `capacityParcels` → **`seatCapacity`**, `assignedRouteId`, `currentLat`/`currentLon`, `speedKph`, `etaMinutes`, `status` (EN_ROUTE/LOADING/IDLE/STANDBY) → (EN_ROUTE/BOARDING/GROUND/STANDBY) |

**Extended reference dataset** (mirrors PostalOps' `driver.csv`/`carrier.csv`, which exist for the reference ontology and OntologyEngine but aren't in the live 4-entity KG):

| PostalOps | FlightOps proposal |
|---|---|
| **Driver** (`driver.csv`) | **Pilot/Crew**: `crewId`, `name`, `homeAirportId`, `airlineId`, `dutyHoursAvailableToday`, `status` (ON_DUTY), `certifications` → **type ratings** (e.g. `B777;B789`) |
| **Carrier** (`carrier.csv`) | **Airline**: `airlineId` (e.g. `KLM`), `airlineName`, `carrierType` (IN_HOUSE/CONTRACT_3PL) → (MAINLINE/ALLIANCE_PARTNER/CODESHARE), `homeCountry`, `reliabilityRating`, `costIndex`, `certifications` → **`allianceMembership`** (SkyTeam etc.) |

**Link types** (mirrors PostalOps' 3): `Airport routes_to FlightRoute`, `Flight assigned_to Aircraft`, `Aircraft travels_along FlightRoute`.

🔶 **Proposal:** also keep the *richer* relationship vocabulary your prototype already defined — `boards`, `holds`, `connectsTo`, `operatedBy`, `locatedAt`, `requires`, `validatedBy`, `guards` — as a second, finer-grained layer surfaced in the Explorer tab and the OntologyEngine's generated ontology, exactly the way PostalOps has a simple 4-entity/3-link live KG *and* a separate, richer 25-class reference ontology (`reference/existing_ontology_schema.md`) that the OntologyEngine produced from real PostNord documents. Same two-layer pattern, just carried over.

**Action types** (writebacks, human-in-the-loop, audit-logged — mirrors PostalOps exactly):

| PostalOps | FlightOps proposal |
|---|---|
| `RerouteLinehaul(consignmentId, newTargetHubId, alternateCarrierId)` | `RebookPassengers(flightId, alternateConnectingFlightId, voucherPolicy)` — reassigns an at-risk passenger cohort to a partner/alternate flight and issues vouchers. Approver role: `OCC_DISPATCHER` → **`OCC_DUTY_MANAGER`** |
| `ReallocateHubCapacity(hubId, additionalHours, divertThresholdPct)` | `ReallocateGateCapacity(airportId, additionalGateHours, divertThresholdPct)` — opens extra gate/stand hours, sets an auto-divert threshold. Approver role: `HUB_OPS_MANAGER` → **`AIRPORT_OPS_MANAGER`** |

---

## 3. Anchor scenario

PostalOps grounds itself in a real carrier (PostNord) and a real, named disruption (Rosersberg terminal conveyor failure, 14,600 parcels inbound, 8,400 EXPRESS at SLA risk). Your prototype already made the equivalent call: **KLM at Amsterdam Schiphol (AMS)** — real airline, real hub, `KL`-prefixed flight numbers match KLM's actual numbering.

🔶 **Proposal:** keep KLM/AMS as the flagship scenario, and keep the existing headline disruption — **KL1008 (LHR→AMS) delayed 45 min, four downstream connections at risk (GRU/SIN/JFK/HND)** — as the "Rosersberg-equivalent" scenario that ships pre-loaded when the app opens, exactly like PostalOps opens with Rosersberg already DOWN.

---

## 4. Dataset scale

You asked for a **larger/more realistic** dataset than PostalOps' (which is deliberately minimal: 6 hubs, 8 routes, 10 consignments, 10 vehicles, 4 drivers, 4 carriers). Proposed FlightOps target:

| Entity | PostalOps | FlightOps proposal |
|---|---:|---:|
| Airports | 6 | **10** (AMS hub + LHR, CDG, DXB, CPH, JFK, SIN, GRU, HND from your prototype, + 1 more, e.g. FRA or ARN) |
| Flight routes | 8 | **16–20** |
| Flights (flow entity) | 10 consignments | **24–30** |
| Aircraft | 10 | **16–20** |
| Pilots/Crew | 4 | **8** |
| Airlines/Carriers | 4 | **5** (KLM + the partner airlines your prototype already references: Air France, Delta, Singapore Airlines, ANA) |

All records would be internally consistent (every foreign key resolves) and grounded in real airport codes/coordinates and a real KLM/Schiphol-style route network, with illustrative (not published-real) capacity and utilization numbers — same disclaimer pattern as PostalOps' `data/README.md` "Notes on realism" section.

✅ **Decided:** counts confirmed as above.

### 4a. Real-time flights — feasibility findings (new, from your follow-up)

You asked me to check feasibility of showing **real, live flights** (not just synthetic data) using a public API,
and to derive other entity data from that feed. Researched this; here's what's actually available to a
client-side-only app (no backend, same architecture as PostalOps):

| Source | Access | What it gives you | Catch |
|---|---|---|---|
| **OpenSky Network** | Free, **anonymous, no API key** (400 requests/day; 4,000/day if you register a free account) | Real live aircraft positions (lat/lon/altitude/speed/heading/callsign) via bounding-box query, plus recent arrivals/departures per airport | Position/telemetry only — **no** schedule, gate, delay, or passenger data. Non-commercial license (fine for this app). |
| **AviationStack** | Freemium (small monthly quota) | Real flight schedules, status, delays | Free tier is **HTTP-only** — browsers block this as mixed content from an HTTPS-served app, so it's a real blocker without a paid tier |
| **AeroDataBox** (via RapidAPI) | Freemium (small monthly quota) | Real schedules, status, delays, aircraft/airport data — the richest of the three | Needs an API key sent from the browser on every call — visible in devtools, same trust model as the Gemini/OpenRouter/Claude keys PostalOps' Settings modal already handles (your own key, stored client-side, never proxied) |

**Recommendation (hybrid — mirrors how the current prototype already fakes background traffic with
`STATIC_FLIGHTS`):**
1. **Default, zero-setup:** call OpenSky's free anonymous API for a bounding box around AMS and the route
   network airports, and plot *genuinely live* aircraft as the map's ambient background-traffic layer — replaces
   the current fake `STATIC_FLIGHTS` positions with real ones, no configuration required.
2. **Optional, richer:** if you add an AeroDataBox key in Settings (same panel as the AI provider keys), pull
   real KLM schedule/status/delay data at AMS to enrich `Flight` records beyond the curated dataset.
3. **Keep the flagship disruption scenario static/curated** (KL1008 delayed 45 min, 4 connections at risk) —
   a live feed can't guarantee a repeatable, demoable disruption exists at any given moment, so §3's anchor
   scenario stays deterministic while live traffic is layered on top for realism. This is the same reason
   PostalOps' Rosersberg outage is curated data rather than a live feed, even though its data model has
   telemetry fields (`currentLat`/`currentLon`/`speedKph`) that *could* come from a real GPS stream.

🔶 **Confirm:** go with this hybrid approach (live OpenSky background traffic + optional AeroDataBox enrichment
+ static anchor scenario), or would you rather I look further into a specific one of these (or a different
provider entirely)?

---

## 5. Ontology Engine (Tab 4)

PostalOps has **two** ontology-engine surfaces:
1. A standalone root-level app (`ontologyEngine/` — separate FastAPI backend calling Databricks + separate React/Vite/TS frontend) — a general-purpose "upload documents, run a 6-phase AI pipeline" tool.
2. An **in-app tab** (`src/ontologyEngine/OntologyEngineTab.jsx`) that does the *same* 6-phase pipeline, but entirely client-side — calls Gemini/OpenRouter/Claude directly from the browser (`aiClient.js`) using the same `aiConfig` the Settings gear manages, parses uploaded files in-browser (`fileParsers.js`, via `pdfjs-dist` + `mammoth` + `xlsx`), and exports per-stage JSON + a combined XLSX (`exporters.js`).

The 6 phases (`pipeline.js`, domain-agnostic — no code changes needed for a new domain): **Controlled Vocabulary → Metadata Standard → Taxonomy → Thesaurus → Ontology → Knowledge Graph**.

✅ **Decided:** build only surface #2 (the in-app tab) for FlightOps — it's self-contained (no Python backend, no Databricks credentials to manage) and functionally identical to #1. Skip replicating the standalone FastAPI app. This needs 3 new `package.json` dependencies FlightOps doesn't have yet: `d3`, `mammoth`, `pdfjs-dist`, `xlsx`.

✅ **Decided + done:** rather than a synthetic document, I researched real KLM/Schiphol operational facts (fleet
types, hub/pier structure, minimum connecting times, EU261 disruption-compensation rules, alliance/interline
structure) and wrote them up as a cited reference document — **`FlightOps/reference/KLM_Schiphol_Operations_Reference.md`**,
already saved to your FlightOps folder (also sent above). This is FlightOps' equivalent of PostalOps'
`PostNord_Handbook.pdf` — real, source-grounded material the six-phase pipeline can run against to produce
FlightOps' reference ontology, the same way the real PostNord PDFs produced `reference/existing_ontology_schema.md`.
The pipeline itself hasn't been *run* yet (that happens once the OntologyEngine tab exists and you either trigger
it or I do during build) — this is the input document ready for that run.

---

## 6. UI — 4 tabs (same count as PostalOps)

| # | PostalOps tab | Badge | Icon | FlightOps proposal |
|---|---|---|---|---|
| 1 | **Sweden Postal Console** | Live | `Sliders` | **Schiphol Ops Console** — airport map (keep your existing Leaflet curved-path map — it's already more developed than PostalOps' map), KPI cards, disruption alert banner, capacity-predictor + autonomous-rebalancer equivalents, AI recovery-agent panel |
| 2 | **Ontology Graph Explorer** | Graph | `Network` | **Flight Ontology Explorer** — generic, D3 force-directed class/instance browser over the full ontology (all classes from §2), same interaction model as PostalOps (click a class → see instances → click an instance → inspect) |
| 3 | **Talk to Data** | Agent | `MessageSquare` | **Ask FlightOps** — chat grounded in the live KG via a `toAgentContext()`-equivalent export, same "KG-only vs configured provider" fallback and status button |
| 4 | **OntologyEngine** | Engine | `Workflow` | Same tab (generic tool name, no domain flavor needed) — see §5 |

Plus the same non-tab **settings gear** (AI provider config: Gemini/OpenRouter/Claude, plus the optional
AeroDataBox key from §4a, shared across the Console agent, Chat, and OntologyEngine — exactly like PostalOps).

✅ **Decided (1):** keep the split — your prototype's hand-built SVG graph stays **inside the Console tab** as the
agent's live-traversal visual, and the **Explorer tab** gets a separate, generic D3 browser over the full class
list, same as PostalOps. You noted we can revisit this once you see it built, so I'll treat it as the working
default rather than locked in stone.

✅ **Decided (2):** tab 3 is **"Ask FlightOps"**. Carrying the same flavored-naming logic to the rest for
consistency — Tab 1 header/badge reads **"Nodal · Schiphol Ops"** (mirroring "Nodal · Sweden Postal Ops"), Tab 2
is **"Flight Ontology Explorer"**, Tab 4 stays **"OntologyEngine"** (already domain-neutral). Flag it if you want
any of these three adjusted — only tab 3's name was explicitly set by you, the rest are my extrapolation.

---

## 7. File layout (exact structural mirror)

```
FlightOps/
├── data/                          # NEW — live KG source JSON (mirrors PostalOps' data/)
│   ├── README.md
│   ├── ontology.schema.json       # Object/Link/Action types (§2)
│   ├── airports.json
│   ├── flight_routes.json
│   ├── flights.json
│   ├── aircraft.json
│   └── links.json
├── src/
│   ├── App.jsx                    # REBUILT — 4-tab shell, Console = evolved prototype
│   ├── lib/                       # NEW
│   │   ├── knowledgeGraph.js      # real KG class, ported 1:1 from PostalOps' pattern
│   │   ├── capacityPredictor.js   # gate/throughput saturation alerts
│   │   └── autonomousRebalancer.js
│   ├── ontologyEngine/            # NEW — in-app tab (§5)
│   │   ├── OntologyEngineTab.jsx
│   │   ├── aiClient.js
│   │   ├── pipeline.js
│   │   ├── exporters.js
│   │   └── fileParsers.js
│   ├── utils/csvParser.js
│   └── data/csv/                  # NEW — extended reference dataset (crew, airlines, etc.)
├── docs/design_spec.md            # this document
├── reference/                     # NEW — if 5(a)/(b) chosen: source docs + generated reference ontology
└── package.json                   # + d3, mammoth, pdfjs-dist, xlsx
```

---

## 8. Governance pattern (unchanged from PostalOps)

Both action types require human-in-the-loop approval and are audit-logged, matching PostalOps' `actions.sample.json` format — a `RebookPassengers`/`ReallocateGateCapacity` sample file would document the resolved KL1008 scenario the same way `actions.sample.json` documents the Rosersberg resolution (who approved, timestamp, side effects, audit reference).

---

## 9. Decisions log

| # | Topic | Decision |
|---|---|---|
| 1 | Console tab origin | ✅ Evolve the existing prototype onto a real KG + real agent, don't rebuild from scratch |
| 2 | Dataset scale | ✅ 10 airports / 16–20 routes / 24–30 flights / 16–20 aircraft / 8 crew / 5 airlines |
| 2a | Real-time flights | 🔶 **Only open item** — confirm the hybrid approach in §4a (free OpenSky live background traffic + optional AeroDataBox enrichment + static anchor scenario) |
| 3 | OntologyEngine scope | ✅ In-app tab only, skip the standalone FastAPI app |
| 3a | Reference document | ✅ Done — real, cited KLM/Schiphol doc researched and saved to `FlightOps/reference/` |
| 4 | Explorer vs Console graph | ✅ Keep the split (scenario SVG in Console, generic D3 Explorer), open to revisiting after you see it built |
| 5 | Tab naming | ✅ "Ask FlightOps" confirmed for tab 3; tabs 1/2/4 and the app header extrapolated to match — flag if any need adjusting |

**One confirm needed (2a) and this moves straight to build.** Everything else above is locked in from your review.
