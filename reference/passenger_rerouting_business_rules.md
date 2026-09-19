# Passenger Rerouting Business Rules — reference note for the OntologyEngine

Added 2026-09-06. Feeds the OntologyEngine alongside the KLM handbook PDF and
`airline_ontology_csv/*` so a pipeline run produces a **PassengerRecovery**
domain in the ontology — it does not exist in the six generated artifacts
today. This closes a gap found reviewing the Console's "Simulate delay &
recovery" panel: the code already computes connection-risk buffers and
"recovery" proposals (`src/lib/autonomousRecoveryPlanner.js`,
`src/lib/flightSimulator.js`), but the alternative flight it proposes comes
from one hand-written text field (`rebookPartnerOptions`) with no modeled
parameters behind it — there was nothing for a business rule to check.

## The entity

**ReroutingBusinessRule** — a codified, versioned rule the OCC applies when a
passenger's connection is put at risk by a delay, diversion, or cancellation.
It does not pick a replacement flight by itself; it *evaluates* candidate
**AlternateConnectionOption**s against a **ConnectionRiskAssessment** and
returns an outcome. Three entities, one job: decide whether, and onto what,
an at-risk passenger gets rebooked.

### Key parameters the rule checks (`ReroutingBusinessRule` data properties)

- `requiredBufferMinutes` — the alternate's own buffer against MCT, evaluated
  from the passenger's *new*, delayed arrival time — not the original
  schedule's buffer. An alternate that is itself unreachable is not a
  proposal.
- `triggerCondition` — DELAY | DIVERSION | CANCELLATION (`cv:rerouting-trigger`).
- `maxAcceptableDelayMinutes` — beyond this, the rule declines to auto-resolve
  and the outcome is ESCALATED rather than a guessed rebooking.
- `voucherThresholdMinutes` — EU261 hotel+meal trigger (default 180 min).
- `cabinMatchRequired` — whether a downgrade/upgrade is acceptable.
- `partnerPriorityOrder` — preference order across `cv:operating-relationship`
  (OWN_METAL > JOINT_VENTURE > INTERLINE > CODESHARE) when more than one
  option clears the other checks.
- `minSeatAvailability` — the alternate must actually have room.
- `requiresApprovalRole` — who signs off (OCC_DUTY_MANAGER, AIRPORT_OPS_MANAGER, …).
- `ruleOutcome` — SELECTED | REJECTED | ESCALATED | NO_ACTION_NEEDED
  (`cv:rerouting-decision-outcome`), recorded once the rule runs.

### What it checks against

- `ConnectionRiskAssessment` — the computed buffer (`bufferMinutes`) between a
  flight's actual/projected arrival and a specific onward flight's scheduled
  departure, tiered STANDARD / TIGHT_MCT / MISCONNECT
  (`cv:connection-risk-tier`) against `minimumConnectingTimeMinutes`.
- `AlternateConnectionOption` — a candidate replacement with real,
  checkable attributes (`alternateFlightNumber`, `operatingRelationship`,
  `alternateDepartureLocal`, `seatsAvailable`, `cabinOffered`,
  `feasibleForPassenger`, `rankOrder`) instead of a free-text sentence. A
  rule can reject one option and fall through to the next-ranked one — the
  current code's `.split('(')[0]` always takes the first-listed text
  regardless of feasibility; this is what makes that fixable.

## Worked example, grounded in the current dataset

`data/flights.json` already has one key connection this maps onto exactly:
KL605 (AMS→JFK, scheduled 15:00Z) lists `rebookPartnerOptions`:
*"DL47 (Delta joint-venture, Dep 17:35 local) or VS103 (Virgin Atlantic
interline, Dep 18:40 local)"*. Modeled properly, that becomes:

- One `ConnectionRiskAssessment` for KL1008→AMS feeding KL605, with a
  computed `bufferMinutes` and `connectionRiskTier`.
- Two `AlternateConnectionOption`s: DL47 (JOINT_VENTURE, Dep 17:35 local) and
  VS103 (INTERLINE, Dep 18:40 local), each with its own `seatsAvailable` and
  `feasibleForPassenger`.
- One `ReroutingBusinessRule` evaluation that checks both against the
  passenger's actual delayed arrival and `requiredBufferMinutes`, and only
  then returns SELECTED for whichever one (if either) actually clears —
  falling through to VS103, or to ESCALATED, if DL47 doesn't.

## Relationships (object properties)

`ConnectionRiskAssessment` —assessesConnection→ `FlightSegment`,
—projectsArrivalOf→ `FlightInstance`, —appliesRule→ `ReroutingBusinessRule`,
—selectedAlternate→ `AlternateConnectionOption`. `ReroutingBusinessRule`
—evaluatesOption→ `AlternateConnectionOption`. `AlternateConnectionOption`
—rebooksPassenger→ `Passenger`.

## Note for whoever wires this into the running app

The ontology now has a place for this; `autonomousRecoveryPlanner.js` and
`flightSimulator.js` don't read it yet — they still parse the flat
`rebookPartnerOptions` string. Once the OntologyEngine is run over this
reference set and published (Stage 3 → *Publish to FlightOps app*), the
`AlternateConnectionOption` records it produces are what the recovery
planner should query instead, so the rule can actually fall through between
options rather than always taking the first one.
