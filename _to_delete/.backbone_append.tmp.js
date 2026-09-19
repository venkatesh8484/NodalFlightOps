
// ─── Knowledge-Agent traversal helpers ─────────────────────────────────────
// These build graph-panel nodes/edges directly from the SAME ONTOLOGY_CLASSES /
// ONTOLOGY_RELATIONS backbone that powers the Ontology Graph Explorer tab, so
// the chat's "graph traversal" is never a different graph from the schema view.
// Ported from PostalOps' kgClassNode / kgInstanceNode / kgRelation helpers.

/** A schema-level node: an ontology class, styled by its metaType. */
export const kgClassNode = (name) => {
  const cls = ONTOLOGY_CLASSES[name];
  return {
    id: name,
    label: name,
    kind: 'class',
    metaType: cls ? cls.metaType : 'THING',
    color: cls ? cls.color : '#64748b',
    desc: cls ? cls.desc : '',
  };
};

/** An instance-level node: one live record (a flight, airport, tail, route). */
export const kgInstanceNode = (id, label, status = 'normal') => ({
  id,
  label,
  kind: 'instance',
  status,
});

/** A schema-level edge — the verb comes verbatim from 05_ontology.json / thesaurus BT. */
export const kgRelation = (source, target, label) => ({ source, target, label, kind: 'relation' });

/** A class -> instance edge ("this class has this live record"). */
export const kgInstanceLink = (source, target, label = 'hasRecord') => ({
  source,
  target,
  label,
  kind: 'instance',
});

// Entity-id shapes for each live KG type, used to recover a traversal from a
// free-text LLM answer. Every candidate is verified against the live graph
// before it becomes a node, so a hallucinated id is never drawn.
//
// Airport codes and flight numbers are deliberately loose patterns (any 3-letter
// uppercase token, any 2-letter + 3/4-digit token) because they are validated
// against the KG anyway — a loose pattern plus a hard existence check finds more
// real entities than a hardcoded list of the ten airports currently loaded.
export const ENTITY_ID_PATTERNS = [
  { re: /\b[A-Z]{2}\d{3,4}\b/g, type: 'flight', cls: 'Flight' },
  { re: /\bRTE-[A-Z0-9-]+\b/g, type: 'route', cls: 'Flight Route' },
  { re: /\b[A-Z]{1,2}-[A-Z]{3,5}\b/g, type: 'aircraft', cls: 'Aircraft' },
  { re: /\bCRW-[A-Z0-9-]+\b/g, type: 'crew', cls: 'Crew' },
  { re: /\bEVT-[A-Z0-9-]+\b/g, type: 'event', cls: 'Telemetry Event' },
  { re: /\bASG-[A-Z0-9-]+\b/g, type: 'assignment', cls: 'Aircraft Assignment' },
  { re: /\b[A-Z]{3}\b/g, type: 'airport', cls: 'Airport' },
];

/**
 * Recover a graph-panel traversal FROM an answer's text.
 *
 * A real LLM answer doesn't arrive with a pre-built traversal the way the local
 * engine's canned branches do. Rather than leave the panel empty, find which
 * live entity ids and thesaurus concepts the answer actually mentions, verify
 * each against the live KG (filtering out anything hallucinated), and draw the
 * real edges between them — so the panel shows how the answer was derived
 * rather than a fabricated path.
 *
 * @param {string} answerText   the agent's reply
 * @param {object} kg           the live KnowledgeGraph singleton
 * @returns {{nodes:Array, edges:Array, walkPath:Array}|null}
 */
export function buildTraversalGraphFromAnswer(answerText, kg) {
  if (!kg || !answerText) return null;

  const flights = kg.getAllFlights();
  const aircraft = kg.getAllAircraft();
  const routes = kg.getAllRoutes();

  const foundIds = [];
  const seenIds = new Set();

  for (const { re, type, cls } of ENTITY_ID_PATTERNS) {
    for (const match of answerText.matchAll(re)) {
      const id = match[0];
      if (seenIds.has(id)) continue;

      const existsLive =
        (type === 'airport' && Boolean(kg.getAirport(id))) ||
        (type === 'flight' && flights.some((f) => f.id === id || f.flightId === id)) ||
        (type === 'aircraft' && aircraft.some((a) => a.id === id || a.tailNumber === id)) ||
        (type === 'route' && routes.some((r) => r.id === id || r.routeId === id)) ||
        // Crew, telemetry events and assignments are CSV-level records rather
        // than KG nodes — accept them as labels, matching PostalOps' treatment
        // of drivers and carriers.
        type === 'crew' ||
        type === 'event' ||
        type === 'assignment';

      if (!existsLive) continue;

      seenIds.add(id);
      foundIds.push({ id, type, cls });
      if (foundIds.length >= 15) break;
    }
    if (foundIds.length >= 15) break;
  }

  // Definitional answers ("what is MCT") reference a thesaurus concept by name
  // rather than an entity id — match those too, so a definition question still
  // draws something meaningful instead of nothing.
  const foundConcepts = [];
  const lowerText = answerText.toLowerCase();
  for (const entry of thesaurus) {
    const terms = [entry.PT, ...(entry.UF || [])].filter(Boolean);
    if (terms.some((t) => t.length > 3 && lowerText.includes(t.toLowerCase()))) {
      foundConcepts.push({ id: entry.Concept_ID, label: entry.PT });
      if (foundConcepts.length >= 4) break;
    }
  }

  if (foundIds.length === 0 && foundConcepts.length === 0) return null;

  const statusOf = (f) => {
    if (f.type === 'airport') {
      const airport = kg.getAirport(f.id);
      if (!airport) return 'normal';
      if (airport.status !== 'OPERATIONAL') return 'critical';
      return (airport.currentUtilizationPct ?? 0) < 60 ? 'healthy' : 'normal';
    }
    if (f.type === 'flight') {
      const flight = flights.find((x) => x.id === f.id || x.flightId === f.id);
      if (!flight) return 'normal';
      if (flight.status === 'AT_RISK' || flight.status === 'DIVERTED') return 'critical';
      if ((flight.delayMinutes ?? 0) > 0) return 'action';
      return 'healthy';
    }
    return 'normal';
  };

  const classesUsed = [...new Set(foundIds.map((f) => f.cls))];
  const nodes = [
    ...classesUsed.map(kgClassNode),
    ...foundIds.map((f) => kgInstanceNode(f.id, f.id, statusOf(f))),
    ...foundConcepts.map((c) => kgInstanceNode(c.id, c.label, 'normal')),
  ];

  const idSet = new Set(foundIds.map((f) => f.id));
  const edges = foundIds.map((f) => kgInstanceLink(f.cls, f.id));
  const seenEdges = new Set(edges.map((e) => `${e.source}|${e.target}|${e.label}`));

  foundIds.forEach((f) => {
    [...kg.getOutboundEdges(f.id), ...kg.getInboundEdges(f.id)].forEach((e) => {
      const other = e.target ?? e.source;
      if (!other || other === f.id || !idSet.has(other)) return;
      const key = `${f.id}|${other}|${e.linkType}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push(kgRelation(f.id, other, e.linkType));
    });
  });

  return {
    nodes,
    edges,
    walkPath: [...foundIds.map((f) => f.id), ...foundConcepts.map((c) => c.id)],
  };
}

/**
 * Last-resort fallback when an answer references no recognizable live entity or
 * concept (a purely summarizing answer, say) — shows that the whole live graph
 * was in scope rather than leaving the panel blank.
 */
export function genericKgOverviewGraph() {
  return {
    nodes: [
      kgClassNode('Airport'),
      kgClassNode('Flight Route'),
      kgClassNode('Flight'),
      kgClassNode('Aircraft'),
    ],
    edges: [
      kgRelation('Flight Route', 'Airport', 'originatesAt'),
      kgRelation('Aircraft', 'Flight Route', 'travelsAlong'),
      kgRelation('Flight', 'Aircraft', 'assignedTo'),
      kgRelation('Flight', 'Airport', 'arrivesAt'),
    ],
    walkPath: ['Airport', 'Flight Route', 'Flight', 'Aircraft'],
  };
}
