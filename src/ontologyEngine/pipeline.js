// ============================================
// OntologyEngine — six-phase ontology pipeline (client-side)
// ============================================
// JS port of the original backend's taxonomy_service.py, hardened for
// ontological (not merely referential) integrity, and since updated with the
// SixPhaseOntologyPipeline improvements shipped in the Ontology-SAS backend
// (chunked full-corpus vocabulary extraction, fixed top-level taxonomy
// buckets + batched classification, batched thesaurus enrichment, a real
// Concept_Class_Map for the ontology, and class/domain-aware knowledge-graph
// typing with optional world-knowledge bridging). Runs entirely in the
// browser against the app's configured AI provider (Gemini / OpenRouter /
// Claude) — no Databricks, no Python process.
//
// Cumulative / "append mode" design: rather than merging partial AI outputs
// across files (fragile), each processing step re-runs the full six-phase
// pipeline over the concatenation of every file's text processed so far.
// That guarantees there is always exactly ONE controlled vocabulary, ONE
// taxonomy, ONE thesaurus, ONE ontology and ONE knowledge graph — each new
// file extends the same growing result instead of starting over.
//
// Integrity guarantees enforced here (see review items A–H, ported from the
// original hardening pass):
//   A. Concept IDs are STABLE + opaque (hash of the term), not positional,
//      and are held in a session registry so a term keeps its ID across runs.
//   B. Raw text is windowed head+tail where a phase still windows (never a
//      blind head slice), so the newest file's content survives truncation;
//      truncation is reported. Phase 1 no longer windows — see below.
//   C. The taxonomy is guaranteed acyclic with BT/NT kept exact inverses.
//   D. Associative (RT) links are kept disjoint from the hierarchy.
//   E. The knowledge graph declares/materializes EVERY ontology verb + class
//      instead of collapsing to three SKOS relations.
//   F. Object-property Domain/Range are validated against the class set.
//   G. The metadata standard carries provenance + a status lifecycle.
//   H. Concepts the taxonomy phase discovers are admitted (as PROVISIONAL)
//      instead of being silently dropped.
//
// Ontology-SAS parity additions (this pass):
//   I. Phase 1 chunks the FULL corpus (paragraph-aligned, overlapping) and
//      merges vocabulary across chunks, instead of windowing to a head+tail
//      slice — large single documents no longer lose their middle content.
//   J. Phase 3 asks for a fixed set of 3–5 top-level buckets once, then
//      classifies concepts in small batches against those buckets, with a
//      missing-ID retry loop — avoids output-token truncation on large
//      concept sets and keeps the hierarchy's top level consistent.
//   K. Floating concepts (no parent) are attached to a fallback bucket, and
//      any taxonomy components left disconnected after batching are merged
//      into the primary one — no concept silently ends up unreachable from
//      the root buckets.
//   L. Phase 4 enrichment is batched the same way, with the full Concept_ID
//      list passed as a reference so Related_Term_RT can point anywhere in
//      the graph, not just within a batch.
//   M. Phase 5 now assigns every concept to exactly one ontology Class
//      (Concept_Class_Map), with a substring-based fallback inference when
//      the model skips one, and asks for a richer verb set with reciprocal
//      pairs instead of three generic relations.
//   N. The knowledge graph types every node with its real class (materialized
//      as an owl:Class), carries prefLabel/altLabel/scopeNote, and picks a
//      domain/range-appropriate verb for associative (RT) edges instead of
//      always using the generic "is_related_to". BT/NT keep the fixed
//      structural predicates so the acyclic mirroring guarantee (C) is never
//      fought over verb choice.
//   O. An optional world-knowledge bridging pass detects disconnected graph
//      clusters and asks the AI — using general domain knowledge, not just
//      the source text — to propose a connecting relationship, so the final
//      graph tends toward a single connected component.

import { askJson } from './aiClient';

const SYSTEM_PROMPT =
  'You are a precise semantic architect. Return strict JSON only. ' +
  'Do not include markdown fences or any explanatory text.';

// Per-phase raw-text budgets (chars) for phases that still window rather than
// chunk. Kept distinct because later phases also carry large structured JSON
// payloads and must leave room for them.
const BUDGET = {
  taxonomyBuckets: 20000,
  taxonomyBatch: 40000,
  thesaurus: 60000,
  ontology: 40000,
};

// I: phase 1 now chunks the full corpus instead of windowing it.
const VOCAB_CHUNK_SIZE = 50000;
const VOCAB_CHUNK_OVERLAP = 5000;

// J/L: batch sizes for taxonomy classification and thesaurus enrichment —
// small enough that a single AI response can't hit the output-token ceiling.
const BATCH_SIZE = 40;
const RETRY_CHUNK_SIZE = 5;
const MAX_MISSING_RETRIES = 3;

// ---------- A/G: stable ID registry + concept lifecycle (session-scoped) ----------

const conceptRegistry = new Map(); // termKey -> Concept_ID   (A: stable across runs)
const usedIds = new Set();         // guards against hash collisions
const conceptMeta = new Map();     // Concept_ID -> { firstSeenRun, status, source }
const bucketIdRegistry = new Set(); // J/K: which Concept_IDs are taxonomy buckets
let runIndex = 0;

/** Clear all session-scoped ontology state. Call when the user resets. */
export function resetOntologyRegistry() {
  conceptRegistry.clear();
  usedIds.clear();
  conceptMeta.clear();
  bucketIdRegistry.clear();
  runIndex = 0;
}

function termKeyOf(term) {
  return String(term ?? '').trim().toLowerCase();
}

// FNV-1a 32-bit — deterministic, order-independent, opaque.
function hashTerm(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).toUpperCase();
}

/** Deterministic, opaque Concept_ID for a term; stable within a session. */
function stableConceptId(term) {
  const key = termKeyOf(term);
  if (conceptRegistry.has(key)) return conceptRegistry.get(key);

  const base = `C${hashTerm(key).padStart(6, '0').slice(0, 6)}`;
  let id = base;
  let probe = 0;
  while (usedIds.has(id)) {
    probe += 1;
    id = `${base}-${probe.toString(36).toUpperCase()}`;
  }
  usedIds.add(id);
  conceptRegistry.set(key, id);
  return id;
}

// ---------- B: text windowing (head + tail, so the newest file survives) ----------

function windowText(text, budget) {
  const t = String(text ?? '');
  if (t.length <= budget) return t;
  const headLen = Math.floor(budget * 0.6);
  const tailLen = budget - headLen;
  const omitted = t.length - budget;
  return `${t.slice(0, headLen)}\n\n…[${omitted} characters omitted from the middle of the corpus]…\n\n${t.slice(t.length - tailLen)}`;
}

function buildRunMeta(rawText) {
  const corpusChars = String(rawText ?? '').length;
  const minBudget = Math.min(...Object.values(BUDGET));
  const truncated = corpusChars > minBudget;
  return {
    run: runIndex,
    corpusChars,
    truncated,
    note: truncated
      ? `Corpus is ${corpusChars.toLocaleString()} characters. Vocabulary extraction (Phase 1) reads the full corpus in overlapping chunks; taxonomy, thesaurus and ontology phases read a windowed head+tail view (smallest window ${minBudget.toLocaleString()} characters) for context alongside the concepts already extracted.`
      : null,
  };
}

// I: split text into paragraph-aligned, overlapping chunks so a single large
// document is fully covered by Phase 1 instead of losing its middle to a
// head+tail window. Ported from Ontology-SAS's data_extractor.smart_chunk.
function smartChunk(text, chunkSize = VOCAB_CHUNK_SIZE, overlap = VOCAB_CHUNK_OVERLAP) {
  const t = String(text ?? '');
  if (t.length <= chunkSize) return [t];

  const paragraphs = t.split('\n');
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 1 > chunkSize && current) {
      chunks.push(current);
      const overlapBuffer = current.length > overlap ? current.slice(-overlap) : current;
      current = `${overlapBuffer}\n${para}`;
    } else {
      current = current ? `${current}\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function* chunksOf(items, size) {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

// Some models wrap a requested array in a single-key object (e.g.
// {"concepts": [...]}); recover the array when that happens instead of
// treating the whole response as empty.
function unwrapListIfNeeded(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) return v;
    }
  }
  return data;
}

// ---------- normalization helpers (ported from taxonomy_service.py) ----------

function normalizeControlledVocab(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  const out = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const term = String(item.Approved_Term || item.Preferred_Term_PT || item.PT || '').trim();
    if (!term) continue;

    let aliases = Array.isArray(item.Aliases)
      ? item.Aliases
      : Array.isArray(item.Used_For_UF)
      ? item.Used_For_UF
      : [];

    const normalizedAliases = [];
    for (const alias of aliases) {
      const a = String(alias).trim();
      // Skip empty, same-as-term, duplicate, or sentence-length "aliases"
      // (a definition or description is not a synonym).
      if (
        a &&
        a.toLowerCase() !== term.toLowerCase() &&
        !normalizedAliases.includes(a) &&
        a.split(/\s+/).filter(Boolean).length <= 6
      ) {
        normalizedAliases.push(a);
      }
    }

    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ Approved_Term: term, Aliases: normalizedAliases });
  }
  return out;
}

// G: provenance + lifecycle instead of a bare rename with hard-coded ACTIVE.
function buildMetadataStandard(controlledVocab, runIdx) {
  return controlledVocab.map((item) => {
    const id = stableConceptId(item.Approved_Term);
    let rec = conceptMeta.get(id);
    if (!rec) {
      rec = { firstSeenRun: runIdx, status: 'ACTIVE', source: 'controlled_vocabulary' };
      conceptMeta.set(id, rec);
    }
    return {
      Concept_ID: id,
      Preferred_Term_PT: item.Approved_Term,
      Used_For_UF: item.Aliases || [],
      Source: rec.source,
      First_Seen_Run: rec.firstSeenRun,
      Status: rec.status,
    };
  });
}

// H: admit concepts the taxonomy phase names but that phase-1 missed, rather
// than silently dropping them. They are flagged PROVISIONAL / derived so they
// are distinguishable from vocabulary-grounded concepts.
function admitNewTerms(aiTaxData, metadataStandard, runIdx) {
  const items = Array.isArray(aiTaxData) ? aiTaxData : [];
  const existingTerms = new Set(metadataStandard.map((m) => m.Preferred_Term_PT.toLowerCase()));
  const existingIds = new Set(metadataStandard.map((m) => m.Concept_ID));
  const additions = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const term = String(item.Preferred_Term_PT || '').trim();
    if (!term || existingTerms.has(term.toLowerCase())) continue;

    const id = stableConceptId(term);
    if (existingIds.has(id)) continue;

    existingTerms.add(term.toLowerCase());
    existingIds.add(id);

    let rec = conceptMeta.get(id);
    if (!rec) {
      rec = { firstSeenRun: runIdx, status: 'PROVISIONAL', source: 'derived_taxonomy' };
      conceptMeta.set(id, rec);
    }
    additions.push({
      Concept_ID: id,
      Preferred_Term_PT: term,
      Used_For_UF: [],
      Source: rec.source,
      First_Seen_Run: rec.firstSeenRun,
      Status: rec.status,
    });
  }

  return additions.length ? metadataStandard.concat(additions) : metadataStandard;
}

function idFromValue(value, validIds, termToId) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (validIds.has(raw)) return raw;
  return termToId.get(raw) || null;
}

function normalizeTaxonomy(data, metadataStandard) {
  const items = Array.isArray(data) ? data : [];

  const validIds = new Set(metadataStandard.map((i) => i.Concept_ID));
  const termToId = new Map(metadataStandard.map((i) => [i.Preferred_Term_PT, i.Concept_ID]));

  const byId = {};
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    let cid = String(item.Concept_ID || '').trim();
    let term = String(item.Preferred_Term_PT || '').trim();
    if (!cid && termToId.has(term)) cid = termToId.get(term);
    if (!validIds.has(cid)) continue;
    if (!term) {
      const found = metadataStandard.find((x) => x.Concept_ID === cid);
      term = found ? found.Preferred_Term_PT : '';
    }

    const bt = Array.isArray(item.Broader_Term_BT) ? item.Broader_Term_BT : [];
    const nt = Array.isArray(item.Narrower_Term_NT) ? item.Narrower_Term_NT : [];

    // C: drop self-references at the source.
    const btIds = [...new Set(bt.map((v) => idFromValue(v, validIds, termToId)).filter(Boolean))].filter((x) => x !== cid);
    const ntIds = [...new Set(nt.map((v) => idFromValue(v, validIds, termToId)).filter(Boolean))].filter((x) => x !== cid);

    byId[cid] = {
      Concept_ID: cid,
      Preferred_Term_PT: term,
      Broader_Term_BT: btIds,
      Narrower_Term_NT: ntIds,
    };
  }

  for (const item of metadataStandard) {
    if (!byId[item.Concept_ID]) {
      byId[item.Concept_ID] = {
        Concept_ID: item.Concept_ID,
        Preferred_Term_PT: item.Preferred_Term_PT,
        Broader_Term_BT: [],
        Narrower_Term_NT: [],
      };
    }
  }

  return metadataStandard.map((item) => byId[item.Concept_ID]);
}

// C: enforce acyclicity and exact BT/NT mirroring. Broader edges are collected
// from both BT and the inverse of NT, cycles are broken by dropping back-edges
// found during DFS, and NT is then rebuilt as the exact inverse of BT.
function postProcessTaxonomy(taxonomy) {
  const ids = new Set(taxonomy.map((t) => t.Concept_ID));
  const broader = new Map(); // child -> Set(parent)

  const addEdge = (child, parent) => {
    if (!ids.has(child) || !ids.has(parent) || child === parent) return;
    if (!broader.has(child)) broader.set(child, new Set());
    broader.get(child).add(parent);
  };

  for (const t of taxonomy) {
    for (const p of t.Broader_Term_BT || []) addEdge(t.Concept_ID, p);
    for (const c of t.Narrower_Term_NT || []) addEdge(c, t.Concept_ID);
  }

  // Break cycles: iterative DFS over child->parent edges, removing any back-edge.
  const state = new Map(); // 0 unseen, 1 on-stack, 2 done
  for (const id of ids) {
    if ((state.get(id) || 0) !== 0) continue;
    const stack = [{ node: id, iter: null }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.iter === null) {
        state.set(frame.node, 1);
        frame.iter = Array.from(broader.get(frame.node) || []);
        frame.i = 0;
      }
      if (frame.i < frame.iter.length) {
        const parent = frame.iter[frame.i++];
        const st = state.get(parent) || 0;
        if (st === 1) {
          broader.get(frame.node).delete(parent); // back-edge -> cycle -> drop
        } else if (st === 0) {
          stack.push({ node: parent, iter: null });
        }
      } else {
        state.set(frame.node, 2);
        stack.pop();
      }
    }
  }

  // Rebuild NT as the exact inverse of the (now acyclic) BT relation.
  const narrower = new Map();
  for (const [child, parents] of broader) {
    for (const p of parents) {
      if (!narrower.has(p)) narrower.set(p, new Set());
      narrower.get(p).add(child);
    }
  }

  return taxonomy.map((t) => ({
    ...t,
    Broader_Term_BT: Array.from(broader.get(t.Concept_ID) || []),
    Narrower_Term_NT: Array.from(narrower.get(t.Concept_ID) || []),
  }));
}

// K: attach any concept with no parent to a fallback bucket, then merge any
// taxonomy components still disconnected from it. Runs after postProcessTaxonomy
// so it only ever adds an edge from a parentless node to a bucket already known
// to have no ancestors of its own — that can never introduce a cycle, so the
// acyclic guarantee (C) never needs to be re-checked here.
function attachFloatingAndMergeComponents(taxonomy) {
  const byId = new Map(taxonomy.map((t) => [t.Concept_ID, t]));
  const bucketIds = [...bucketIdRegistry].filter((id) => byId.has(id));
  const fallbackBucket = bucketIds[0];
  if (!fallbackBucket) return taxonomy;

  for (const t of taxonomy) {
    if (bucketIdRegistry.has(t.Concept_ID)) continue;
    if (!t.Broader_Term_BT.length) {
      t.Broader_Term_BT = [fallbackBucket];
      const bucket = byId.get(fallbackBucket);
      if (bucket && !bucket.Narrower_Term_NT.includes(t.Concept_ID)) bucket.Narrower_Term_NT.push(t.Concept_ID);
    }
  }

  const components = connectedComponents(byId);
  if (components.length > 1) {
    const primary = components.find((c) => c.has(fallbackBucket)) || components.reduce((a, b) => (b.size > a.size ? b : a));
    for (const component of components) {
      if (component === primary) continue;
      let roots = [...component].filter((id) => bucketIdRegistry.has(id) && !(byId.get(id).Broader_Term_BT || []).length);
      if (!roots.length) roots = [...component].filter((id) => bucketIdRegistry.has(id));
      if (!roots.length) roots = [component.values().next().value];
      for (const rootId of roots) {
        if (rootId === fallbackBucket) continue;
        const rootNode = byId.get(rootId);
        if (!rootNode.Broader_Term_BT.includes(fallbackBucket)) rootNode.Broader_Term_BT.push(fallbackBucket);
        const bucket = byId.get(fallbackBucket);
        if (bucket && !bucket.Narrower_Term_NT.includes(rootId)) bucket.Narrower_Term_NT.push(rootId);
      }
    }
  }

  return Array.from(byId.values());
}

function connectedComponents(byId) {
  const visited = new Set();
  const components = [];
  for (const start of byId.keys()) {
    if (visited.has(start)) continue;
    const component = new Set();
    const stack = [start];
    while (stack.length) {
      const node = stack.pop();
      if (visited.has(node)) continue;
      visited.add(node);
      component.add(node);
      const t = byId.get(node);
      const neighbours = [...(t.Broader_Term_BT || []), ...(t.Narrower_Term_NT || [])];
      for (const n of neighbours) if (byId.has(n) && !visited.has(n)) stack.push(n);
    }
    components.push(component);
  }
  return components;
}

// D: transitive hierarchical closure (ancestors + descendants) per concept,
// used to keep associative RT links disjoint from the hierarchy.
function hierClosure(taxonomy) {
  const bt = new Map(taxonomy.map((t) => [t.Concept_ID, t.Broader_Term_BT || []]));
  const nt = new Map(taxonomy.map((t) => [t.Concept_ID, t.Narrower_Term_NT || []]));

  const reach = (start, rel) => {
    const out = new Set();
    const stack = [...(rel.get(start) || [])];
    while (stack.length) {
      const n = stack.pop();
      if (out.has(n)) continue;
      out.add(n);
      for (const m of rel.get(n) || []) stack.push(m);
    }
    return out;
  };

  const closure = new Map();
  for (const t of taxonomy) {
    closure.set(t.Concept_ID, new Set([...reach(t.Concept_ID, bt), ...reach(t.Concept_ID, nt)]));
  }
  return closure;
}

function normalizeThesaurus(data, controlledVocab, taxonomy) {
  const items = Array.isArray(data) ? data : [];

  const cvMap = new Map(controlledVocab.map((i) => [i.Approved_Term, i.Aliases || []]));
  const taxMap = new Map(taxonomy.map((i) => [i.Concept_ID, i]));
  const termToId = new Map(taxonomy.map((i) => [i.Preferred_Term_PT, i.Concept_ID]));
  const validIds = new Set(taxMap.keys());
  const closure = hierClosure(taxonomy); // D

  const result = {};
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    let cid = String(item.Concept_ID || '').trim();
    if (!cid) {
      const maybePt = String(item.PT || '').trim();
      cid = termToId.get(maybePt) || '';
    }
    if (!validIds.has(cid)) continue;

    const taxItem = taxMap.get(cid);
    const term = taxItem.Preferred_Term_PT;
    const uf = Array.isArray(item.UF) ? item.UF : cvMap.get(term) || [];

    // C-into-graph: BT/NT are taken ONLY from the validated, acyclic taxonomy,
    // never from the model's thesaurus payload, so the graph inherits the
    // acyclic + mirrored hierarchy.
    const btIds = taxItem.Broader_Term_BT || [];
    const ntIds = taxItem.Narrower_Term_NT || [];

    // D: RT is associative only — strip self and anything on the hierarchical path.
    const rt = Array.isArray(item.Related_Term_RT) ? item.Related_Term_RT : [];
    const closureSet = closure.get(cid) || new Set();
    const rtIds = [...new Set(rt.map((v) => idFromValue(v, validIds, termToId)).filter(Boolean))].filter(
      (id) => id !== cid && !closureSet.has(id)
    );

    const sn = String(item.Scope_Note_SN || '').trim();

    result[cid] = {
      Concept_ID: cid,
      PT: term,
      UF: uf.map((v) => String(v).trim()).filter(Boolean),
      BT: btIds,
      NT: ntIds,
      Related_Term_RT: rtIds,
      Scope_Note_SN: sn || (taxItem.Broader_Term_BT.length ? `Use for ${term}.` : `Top-level category: ${term}.`),
    };
  }

  for (const [cid, taxItem] of taxMap.entries()) {
    if (result[cid]) continue;
    const term = taxItem.Preferred_Term_PT;
    result[cid] = {
      Concept_ID: cid,
      PT: term,
      UF: cvMap.get(term) || [],
      BT: taxItem.Broader_Term_BT || [],
      NT: taxItem.Narrower_Term_NT || [],
      Related_Term_RT: [],
      Scope_Note_SN: taxItem.Broader_Term_BT.length ? `Use for ${term}.` : `Top-level category: ${term}.`,
    };
  }

  return taxonomy.map((item) => result[item.Concept_ID]);
}

// F: validate Domain/Range against the class set — any class a property refers
// to is guaranteed to be declared, and 'Concept' (the instance type) is always
// present. M: also builds Concept_Class_Map — every thesaurus concept gets
// exactly one class, from the model's own mapping when valid, else a
// substring-based fallback inference, else the generic 'Concept' type.
function inferClassFromTerm(pt, knownClasses) {
  const ptLower = String(pt || '').toLowerCase().replace(/[\s_]/g, '');
  for (const cls of knownClasses) {
    if (cls === 'Concept') continue;
    const clsLower = cls.toLowerCase().replace(/[\s_]/g, '');
    if (clsLower && (ptLower.includes(clsLower) || clsLower.includes(ptLower))) return cls;
  }
  return 'Concept';
}

function normalizeOntology(data, thesaurus = []) {
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const declaredClasses = Array.isArray(obj.Classes) ? obj.Classes.map((c) => String(c).trim()).filter(Boolean) : [];
  const props = Array.isArray(obj.Object_Properties) ? obj.Object_Properties : [];

  const classSet = new Set(declaredClasses);

  const normalizedProps = [];
  const seenVerbs = new Set();
  for (const prop of props) {
    if (!prop || typeof prop !== 'object') continue;
    const verb = String(prop.Verb || '').trim();
    if (!verb || seenVerbs.has(verb)) continue;
    seenVerbs.add(verb);
    const domain = String(prop.Domain || '').trim() || 'Concept';
    const range = String(prop.Range || '').trim() || 'Concept';
    classSet.add(domain); // F: guarantee referenced classes are declared
    classSet.add(range);
    normalizedProps.push({ Verb: verb, Domain: domain, Range: range });
  }

  const finalProps = normalizedProps.length
    ? normalizedProps
    : [
        { Verb: 'has_broader_concept', Domain: 'Concept', Range: 'Concept' },
        { Verb: 'has_narrower_concept', Domain: 'Concept', Range: 'Concept' },
        { Verb: 'is_related_to', Domain: 'Concept', Range: 'Concept' },
      ];

  classSet.add('Concept'); // instance type used by the knowledge graph
  const classes = Array.from(classSet);

  // M: Concept_Class_Map — every thesaurus concept gets exactly one class.
  const classLookup = new Map(classes.map((c) => [c.toLowerCase(), c]));
  const rows = Array.isArray(obj.Concept_Class_Map) ? obj.Concept_Class_Map : [];
  const validIds = new Set(thesaurus.map((t) => t.Concept_ID));
  const classById = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const cid = String(row.Concept_ID || '').trim();
    const clsRaw = String(row.Class || '').trim();
    if (!validIds.has(cid) || !clsRaw) continue;
    classById.set(cid, classLookup.get(clsRaw.toLowerCase()) || clsRaw);
  }
  for (const t of thesaurus) {
    if (!classById.has(t.Concept_ID)) {
      classById.set(t.Concept_ID, inferClassFromTerm(t.PT, classes));
    }
  }
  const conceptClassMap = thesaurus.map((t) => ({ Concept_ID: t.Concept_ID, Class: classById.get(t.Concept_ID) || 'Concept' }));

  return { Classes: classes, Object_Properties: finalProps, Concept_Class_Map: conceptClassMap };
}

function resolveTargets(values, idMap, ptToId) {
  const result = [];
  for (const value of values || []) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    let targetId = null;
    if (idMap.has(raw)) targetId = raw;
    else if (ptToId.has(raw)) targetId = ptToId.get(raw);
    else continue;
    result.push(`concept:${targetId}`);
  }
  return result;
}

// Structural predicates for the hierarchy — fixed, never re-labeled, so the
// acyclic BT/NT mirroring guarantee (C) is never fought over verb choice.
const BROADER = 'has_broader_concept';
const NARROWER = 'has_narrower_concept';
const RELATED = 'is_related_to';

function verbKey(verb) {
  let key = '';
  for (const ch of String(verb || '').trim()) {
    key += /[a-zA-Z0-9]/.test(ch) ? ch.toLowerCase() : '_';
  }
  key = key.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return key || 'related_to';
}

// N: pick the best domain/range-appropriate verb for an associative (RT) edge
// between two classes — strict match first, then progressively looser passes,
// finally falling back to the first declared property or the generic RELATED.
function matchAssociativeVerb(sourceClass, targetClass, propertyRules) {
  if (!propertyRules.length) return RELATED;
  const src = String(sourceClass || 'Concept').toLowerCase();
  const tgt = String(targetClass || 'Concept').toLowerCase();
  const classMatches = (ruleClass, current) => {
    const rc = String(ruleClass || '').toLowerCase();
    return rc === 'concept' || rc === 'any' || rc === current;
  };

  for (const rule of propertyRules) {
    const rd = String(rule.Domain || '').toLowerCase();
    const rr = String(rule.Range || '').toLowerCase();
    if (rd !== 'concept' && rr !== 'concept' && classMatches(rule.Domain, src) && classMatches(rule.Range, tgt)) {
      return rule.Verb_Key;
    }
  }
  for (const rule of propertyRules) {
    if (classMatches(rule.Domain, src) && classMatches(rule.Range, tgt)) return rule.Verb_Key;
  }
  for (const rule of propertyRules) {
    if (classMatches(rule.Domain, src)) return rule.Verb_Key;
  }
  for (const rule of propertyRules) {
    if (classMatches(rule.Range, tgt)) return rule.Verb_Key;
  }
  return propertyRules[0].Verb_Key;
}

// E/F/N: the knowledge graph (1) types every node with its real ontology class
// (falling back to the generic 'Concept'), (2) uses FIXED structural predicates
// for BT/NT so the hierarchy is never re-labeled, (3) picks a domain/range-aware
// verb for each associative (RT) edge instead of one generic relation, and (4)
// materializes the full ontology (every class and every object property, with
// rdfs:domain / rdfs:range) as declaration nodes via JSON-LD @included, so no
// ontology verb or class is discarded.
function buildKnowledgeGraph(thesaurus, ontology, namespaceUri = 'http://example.org/') {
  const ns = namespaceUri.replace(/\/+$/, '') + '/';
  const idMap = new Map(thesaurus.map((i) => [i.Concept_ID, i]));
  const ptToId = new Map(thesaurus.map((i) => [i.PT, i.Concept_ID]));
  const classById = new Map((ontology.Concept_Class_Map || []).map((r) => [r.Concept_ID, r.Class]));

  const propertyRules = (ontology.Object_Properties || [])
    .map((p) => {
      const verb = String(p?.Verb || '').trim();
      if (!verb) return null;
      return {
        Verb: verb,
        Verb_Key: verbKey(verb),
        Domain: String(p.Domain || 'Concept').trim() || 'Concept',
        Range: String(p.Range || 'Concept').trim() || 'Concept',
      };
    })
    .filter(Boolean);

  const context = {
    '@vocab': ns,
    concept: `${ns}concept/`,
    owl: 'http://www.w3.org/2002/07/owl#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    skos: 'http://www.w3.org/2004/02/skos/core#',
    Concept: `${ns}ontology/Concept`,
    prefLabel: 'skos:prefLabel',
    altLabel: 'skos:altLabel',
    scopeNote: 'skos:scopeNote',
    domain: { '@id': 'rdfs:domain', '@type': '@id' },
    range: { '@id': 'rdfs:range', '@type': '@id' },
    [BROADER]: { '@id': `${ns}ontology/${BROADER}`, '@type': '@id' },
    [NARROWER]: { '@id': `${ns}ontology/${NARROWER}`, '@type': '@id' },
    [RELATED]: { '@id': `${ns}ontology/${RELATED}`, '@type': '@id' },
  };
  // Declare EVERY ontology verb in the context (even bespoke domain verbs),
  // so they are part of the graph's vocabulary rather than silently dropped.
  for (const rule of propertyRules) {
    if (!context[rule.Verb_Key]) context[rule.Verb_Key] = { '@id': `${ns}ontology/${encodeURIComponent(rule.Verb_Key)}`, '@type': '@id' };
  }

  const graph = thesaurus.map((item) => {
    const sourceClass = classById.get(item.Concept_ID) || 'Concept';
    const node = {
      '@id': `concept:${item.Concept_ID}`,
      '@type': sourceClass,
      prefLabel: item.PT,
      scopeNote: item.Scope_Note_SN || `Use for ${item.PT}.`,
    };
    const altLabel = (item.UF || []).filter(Boolean);
    if (altLabel.length) node.altLabel = altLabel;

    node[BROADER] = resolveTargets(item.BT, idMap, ptToId);
    node[NARROWER] = resolveTargets(item.NT, idMap, ptToId);

    // N: RT edges get a domain/range-aware verb from the ontology's own
    // object properties when one fits, falling back to the generic
    // associative predicate — never re-labels BT/NT.
    for (const target of resolveTargets(item.Related_Term_RT, idMap, ptToId)) {
      const targetClass = classById.get(target.replace('concept:', '')) || 'Concept';
      const key = matchAssociativeVerb(sourceClass, targetClass, propertyRules);
      if (!node[key]) node[key] = [];
      if (!node[key].includes(target)) node[key].push(target);
    }

    return node;
  });

  const included = [];
  for (const cls of ontology.Classes || []) {
    const name = String(cls).trim();
    if (!name) continue;
    included.push({ '@id': `${ns}ontology/${encodeURIComponent(name)}`, '@type': 'owl:Class', 'rdfs:label': name });
  }
  for (const p of ontology.Object_Properties || []) {
    const v = String(p?.Verb || '').trim();
    if (!v) continue;
    included.push({
      '@id': `${ns}ontology/${encodeURIComponent(v)}`,
      '@type': 'owl:ObjectProperty',
      'rdfs:label': v,
      domain: `${ns}ontology/${encodeURIComponent(String(p.Domain || 'Concept'))}`,
      range: `${ns}ontology/${encodeURIComponent(String(p.Range || 'Concept'))}`,
    });
  }

  return { '@context': context, '@graph': graph, '@included': included };
}

// O: detect weakly-connected clusters (every relation edge treated as
// undirected) so a disconnected knowledge graph can be identified.
function weaklyConnectedComponents(graph) {
  const skipKeys = new Set(['@id', '@type', 'prefLabel', 'altLabel', 'scopeNote']);
  const adjacency = new Map(graph.map((n) => [n['@id'], new Set()]));
  for (const node of graph) {
    const src = node['@id'];
    for (const [key, value] of Object.entries(node)) {
      if (skipKeys.has(key)) continue;
      const targets = Array.isArray(value) ? value : [value];
      for (const target of targets) {
        if (typeof target === 'string' && adjacency.has(target) && target !== src) {
          adjacency.get(src).add(target);
          adjacency.get(target).add(src);
        }
      }
    }
  }
  const visited = new Set();
  const components = [];
  for (const id of adjacency.keys()) {
    if (visited.has(id)) continue;
    const component = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (visited.has(cur)) continue;
      visited.add(cur);
      component.add(cur);
      for (const n of adjacency.get(cur)) if (!visited.has(n)) stack.push(n);
    }
    components.push(component);
  }
  return components;
}

function representativeConcepts(component, nodesById, limit = 8) {
  return [...component].slice(0, limit).map((id) => {
    const node = nodesById.get(id);
    return { Concept_ID: id.replace('concept:', ''), Label: node?.prefLabel || id };
  });
}

// O: if the graph is split into multiple disconnected clusters (e.g. separate
// taxonomy buckets with no associative relationship between them), ask the AI
// — using general world/domain knowledge, not just the source text — to
// propose a bridging relationship between the two largest clusters. Repeat
// until the graph is a single connected component or every initial cluster
// has been considered, whichever comes first. Mutates graph/context in place.
async function bridgeDisconnectedComponents(aiConfig, graph, context) {
  if (graph.length < 2) return;
  const nodesById = new Map(graph.map((n) => [n['@id'], n]));
  const initialComponents = weaklyConnectedComponents(graph);
  const maxRounds = Math.max(0, initialComponents.length - 1);

  let rounds = 0;
  while (rounds < maxRounds) {
    const components = weaklyConnectedComponents(graph).sort((a, b) => b.size - a.size);
    if (components.length <= 1) return;
    const [mainComponent, otherComponent] = components;

    const prompt = `You are connecting two clusters of a knowledge graph that currently have NO relationship between them.

Cluster A concepts:
${JSON.stringify(representativeConcepts(mainComponent, nodesById))}

Cluster B concepts:
${JSON.stringify(representativeConcepts(otherComponent, nodesById))}

Using your general world/domain knowledge (you are NOT limited to any source document), propose the SINGLE
most plausible real-world relationship connecting one concept in Cluster A to one concept in Cluster B.

Return a JSON object with exactly these keys:
- Source_Concept_ID (String): a Concept_ID from Cluster A
- Target_Concept_ID (String): a Concept_ID from Cluster B
- Verb (String): a short relationship verb, e.g. "relates_to", "operates_within", "is_associated_with"
- Reason (String): one short sentence justifying the relationship

Never leave this empty — if no obvious relationship exists, still return your best general-domain guess.`;

    let edge = {};
    try {
      const raw = await askJson(aiConfig, SYSTEM_PROMPT, prompt);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) edge = raw;
    } catch {
      edge = {};
    }

    let srcFull = String(edge.Source_Concept_ID || '').trim();
    let tgtFull = String(edge.Target_Concept_ID || '').trim();
    srcFull = srcFull.startsWith('concept:') ? srcFull : `concept:${srcFull}`;
    tgtFull = tgtFull.startsWith('concept:') ? tgtFull : `concept:${tgtFull}`;
    let verb = String(edge.Verb || '').trim() || 'is_related_to';
    let reason = String(edge.Reason || '').trim();

    if (!mainComponent.has(srcFull) || !otherComponent.has(tgtFull)) {
      // AI picked an invalid/out-of-cluster id — fall back to a deterministic
      // bridge so the graph still converges toward a single component.
      srcFull = mainComponent.values().next().value;
      tgtFull = otherComponent.values().next().value;
      verb = 'is_related_to';
      reason = '';
    }

    const key = verbKey(verb);
    if (!context[key]) context[key] = { '@id': `${context['@vocab'] || ''}ontology/${encodeURIComponent(key)}`, '@type': '@id' };

    const srcNode = nodesById.get(srcFull);
    if (!srcNode[key]) srcNode[key] = [];
    if (!srcNode[key].includes(tgtFull)) srcNode[key].push(tgtFull);

    if (reason) {
      const tgtNode = nodesById.get(tgtFull);
      const note = String(tgtNode.scopeNote || '').trim();
      const addendum = ` (Inferred link via general domain knowledge: ${reason})`;
      if (!note.includes(addendum)) tgtNode.scopeNote = (note + addendum).trim();
    }

    rounds += 1;
  }
}

// ---------- cumulative merge helpers ----------
// Each phase call only sees the (possibly windowed/chunked) raw text and asks
// the AI to extract from it; nothing guarantees the AI re-lists every term it
// named on a previous, smaller run. So each phase's fresh output is UNIONED
// with the previous run's accumulated state here — this is what actually
// makes the pipeline additive instead of replacing prior results with
// whatever the AI happened to return this time.

function mergeControlledVocab(prevList, nextList) {
  const byKey = new Map();
  for (const item of prevList || []) {
    byKey.set(termKeyOf(item.Approved_Term), { Approved_Term: item.Approved_Term, Aliases: [...(item.Aliases || [])] });
  }
  for (const item of nextList || []) {
    const key = termKeyOf(item.Approved_Term);
    const existing = byKey.get(key);
    if (existing) {
      for (const a of item.Aliases || []) {
        if (a && !existing.Aliases.some((x) => x.toLowerCase() === a.toLowerCase())) existing.Aliases.push(a);
      }
    } else {
      byKey.set(key, { Approved_Term: item.Approved_Term, Aliases: [...(item.Aliases || [])] });
    }
  }
  return Array.from(byKey.values());
}

function mergeMetadataStandard(prevList, nextList) {
  const byId = new Map();
  for (const item of nextList || []) byId.set(item.Concept_ID, item);
  for (const item of prevList || []) {
    if (!byId.has(item.Concept_ID)) byId.set(item.Concept_ID, item);
  }
  return Array.from(byId.values());
}

function mergeTaxonomy(prevList, nextList) {
  const byId = new Map();
  for (const item of prevList || []) byId.set(item.Concept_ID, { ...item });
  for (const item of nextList || []) {
    const existing = byId.get(item.Concept_ID);
    if (existing) {
      byId.set(item.Concept_ID, {
        Concept_ID: item.Concept_ID,
        Preferred_Term_PT: item.Preferred_Term_PT || existing.Preferred_Term_PT,
        Broader_Term_BT: Array.from(new Set([...(existing.Broader_Term_BT || []), ...(item.Broader_Term_BT || [])])),
        Narrower_Term_NT: Array.from(new Set([...(existing.Narrower_Term_NT || []), ...(item.Narrower_Term_NT || [])])),
      });
    } else {
      byId.set(item.Concept_ID, item);
    }
  }
  return Array.from(byId.values());
}

function mergeThesaurus(prevList, nextList) {
  const prevById = new Map((prevList || []).map((i) => [i.Concept_ID, i]));
  return (nextList || []).map((item) => {
    const existing = prevById.get(item.Concept_ID);
    if (!existing) return item;
    const uf = Array.from(new Set([...(existing.UF || []), ...(item.UF || [])]));
    const rt = Array.from(new Set([...(existing.Related_Term_RT || []), ...(item.Related_Term_RT || [])]));
    // Keep a real scope note over a generic placeholder from either side.
    const existingIsGeneric = /^(Use for |Top-level category: )/.test(existing.Scope_Note_SN || '');
    const scopeNote = existingIsGeneric ? item.Scope_Note_SN : existing.Scope_Note_SN;
    return { ...item, UF: uf, Related_Term_RT: rt, Scope_Note_SN: scopeNote };
  });
}

function mergeOntology(prevOntology, nextOntology) {
  const classes = new Set([...(prevOntology?.Classes || []), ...(nextOntology?.Classes || [])]);
  const propsByVerb = new Map();
  for (const p of prevOntology?.Object_Properties || []) propsByVerb.set(p.Verb, p);
  for (const p of nextOntology?.Object_Properties || []) if (!propsByVerb.has(p.Verb)) propsByVerb.set(p.Verb, p);

  // M: prefer a specific class already on record over downgrading to the
  // generic 'Concept' fallback a later run's inference might produce.
  const classById = new Map();
  for (const row of prevOntology?.Concept_Class_Map || []) classById.set(row.Concept_ID, row.Class);
  for (const row of nextOntology?.Concept_Class_Map || []) {
    if (!classById.has(row.Concept_ID) || classById.get(row.Concept_ID) === 'Concept') {
      classById.set(row.Concept_ID, row.Class);
    }
  }

  return {
    Classes: Array.from(classes),
    Object_Properties: Array.from(propsByVerb.values()),
    Concept_Class_Map: Array.from(classById, ([Concept_ID, Class]) => ({ Concept_ID, Class })),
  };
}

// ---------- AI phases ----------

// I: chunk the full corpus and extract vocabulary from every chunk, merging
// across chunks by term key — no head+tail window loses the middle anymore.
async function phaseControlledVocabularyChunk(aiConfig, chunk) {
  const prompt = `PHASE 1: Controlled Vocabulary

Goal: Extract HIGH-VALUE DOMAIN ENTITIES and CORE DOMAIN CLASSES from the source text — the named things and infrastructure types that would become nodes in a knowledge graph. Deduplicate interchangeable terms and capture exact aliases.

Return a JSON array. Each item must have exactly these keys:
- Approved_Term (String): the canonical/preferred term, most formal version.
- Aliases (Array of Strings): exact synonyms, alternate spellings, or abbreviations found explicitly in the text. If none exist, return an empty array [].

Strict Rules (CRITICAL — violating any rule invalidates your output):

1. DOMAIN ENTITIES ONLY — NO IRRELEVANT FLUFF: Only extract terms that are meaningful in a knowledge graph for this domain. EXTRACT: named organizations, subsidiaries, branded services, specific facilities. DO NOT EXTRACT: irrelevant everyday nouns.

1.5. YOU MUST INCLUDE ABSTRACT DOMAIN CLASSES: while you must ignore irrelevant fluff, you MUST aggressively extract the foundational abstract concepts and infrastructure types defined in the text, even if they are not capitalized proper nouns.

2. KEEP MULTI-WORD ENTITIES INTACT: named entities that consist of multiple words MUST be extracted as a single complete term. When an entity appears both standalone and as part of a larger name, extract BOTH.

3. NO VERBS, ADJECTIVES, OR ADVERBS: extract ONLY nouns and noun phrases. Adjectives are allowed ONLY when part of an official proper noun.

4. EXACT EXTRACTION: extract terms EXACTLY as they appear in the source text. Do NOT invent or combine terms.

5. STRICT ALIASES — SYNONYMS ONLY: an alias must be an alternate proper name or acronym for the EXACT SAME entity — never a definition, functional description, or geographic description. If it describes WHAT the entity is rather than being another NAME for it, leave Aliases empty [].

6. NO WORD ASSOCIATION: do NOT group related words as aliases. A location is NOT an alias for the entity at that location.

7. ENTITY vs DESCRIPTION: the Approved_Term must be the actual entity noun, not a descriptive label.

8. NO ENTITY MERGING: keep distinct sub-entities, departments, or subsidiaries as SEPARATE concepts.

9. MERGE INTERCHANGEABLE TERMS: combine ONLY truly identical/interchangeable terms.

10. NO INVENTED ACRONYMS: do NOT add acronyms unless explicitly in the text.

11. FLAT STRUCTURE: no IDs, no hierarchies.

12. UNIQUENESS: every Approved_Term must be entirely unique across the output.

13. SERVICES ARE NOT ALIASES: multiple services provided by one organization are separate concepts.

Source text:
${chunk}
`;
  const data = await askJson(aiConfig, SYSTEM_PROMPT, prompt);
  return normalizeControlledVocab(unwrapListIfNeeded(data));
}

async function phaseControlledVocabulary(aiConfig, rawText) {
  const chunks = smartChunk(rawText);
  const seen = new Set();
  const merged = [];

  for (const chunk of chunks) {
    let chunkVocab = await phaseControlledVocabularyChunk(aiConfig, chunk);
    // Retry a couple of times if the model returns nothing for this chunk —
    // extraction is non-deterministic and an empty chunk result is usually a
    // blip, not a genuinely empty chunk.
    for (let retry = 0; retry < 2 && chunkVocab.length === 0; retry++) {
      chunkVocab = await phaseControlledVocabularyChunk(aiConfig, chunk);
    }
    for (const item of chunkVocab) {
      const key = termKeyOf(item.Approved_Term);
      if (key && !seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }

  return merged;
}

// J: fixed top-level buckets, established once per run so every batch shares
// the same top of the hierarchy instead of each one inventing its own.
async function establishBucketNames(aiConfig, compactMeta, rawText) {
  const terms = compactMeta.map((c) => c.Preferred_Term_PT);
  const prompt = `PHASE 3a: Top-Level Buckets

Given this list of ${terms.length} domain concepts, invent 3 to 5 top-level category buckets that together
can classify EVERY concept below (e.g. People/Actors, Facilities/Assets, Processes, Systems, Locations).

Concepts:
${JSON.stringify(terms)}

Source text for context:
${windowText(rawText, BUDGET.taxonomyBuckets)}

Return a JSON array of bucket objects, each with exactly one key:
- Preferred_Term_PT (String, short bucket name)
`;
  const data = unwrapListIfNeeded(await askJson(aiConfig, SYSTEM_PROMPT, prompt));
  const names = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item) continue;
      const name = typeof item === 'string' ? item.trim() : String(item.Preferred_Term_PT || item.name || '').trim();
      if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  if (!names.length) names.push('General');
  return names;
}

async function classifyTaxonomyBatch(aiConfig, batch, bucketRefs, rawText) {
  const prompt = `PHASE 3: Taxonomy (batch of ${batch.length})

Goal: Build a strict vertical hierarchy (parent-child relationships) for ONLY the concepts listed below,
using the FIXED top-level buckets provided. Do NOT invent new buckets.

Fixed top-level buckets (use these Concept_IDs only, never invent new ones):
${JSON.stringify(bucketRefs)}

Concepts to classify (${batch.length} total — output ALL of them, do not skip any):
${JSON.stringify(batch)}

Return a JSON array. Each item must have exactly these keys:
- Concept_ID (String)
- Preferred_Term_PT (String)
- Broader_Term_BT (Array of Concept_ID strings): the immediate parent only
- Narrower_Term_NT (Array of Concept_ID strings): leave empty unless the parent of another
  concept in THIS batch is this concept

Strict Rules (CRITICAL):
- Is-A / Part-Of ONLY: hierarchy must be strictly categorical or structural.
- INSTANCES GO UNDER CLASSES: specific instances MUST be Narrower Terms (NT) of an abstract class
  from this same batch when one fits, instead of going directly under a bucket.
- DIRECT PARENT ONLY: list ONLY the immediate parent in BT. Never list a bucket if a closer parent exists.
- Every concept MUST resolve up to exactly one of the fixed buckets above (directly, or through a class parent).
- COMPLETENESS CRITICAL: you MUST output ALL ${batch.length} concept IDs listed above. Do NOT skip any. Do NOT stop early.

Source text for context:
${windowText(rawText, BUDGET.taxonomyBatch)}
`;
  const data = unwrapListIfNeeded(await askJson(aiConfig, SYSTEM_PROMPT, prompt));
  return Array.isArray(data) ? data : [];
}

// J/K: establish buckets, batch-classify against them, retry anything missed,
// and admit the buckets themselves as real (stably-IDed) concepts.
async function phaseTaxonomyBatched(aiConfig, metadataStandard, rawText, runIdx) {
  const compactMeta = metadataStandard.map((m) => ({ Concept_ID: m.Concept_ID, Preferred_Term_PT: m.Preferred_Term_PT }));

  const bucketNames = await establishBucketNames(aiConfig, compactMeta, rawText);
  const bucketMeta = bucketNames.map((name) => {
    // Namespaced so a bucket concept never collides with a same-named domain concept.
    const id = stableConceptId(`bucket:${name}`);
    bucketIdRegistry.add(id);
    let rec = conceptMeta.get(id);
    if (!rec) {
      rec = { firstSeenRun: runIdx, status: 'ACTIVE', source: 'taxonomy_bucket' };
      conceptMeta.set(id, rec);
    }
    return { Concept_ID: id, Preferred_Term_PT: name, Used_For_UF: [], Source: rec.source, First_Seen_Run: rec.firstSeenRun, Status: rec.status };
  });

  const metadataWithBuckets = mergeMetadataStandard(metadataStandard, bucketMeta);
  const bucketRefs = bucketMeta.map((b) => ({ Concept_ID: b.Concept_ID, Preferred_Term_PT: b.Preferred_Term_PT }));

  let data = bucketMeta.map((b) => ({
    Concept_ID: b.Concept_ID,
    Preferred_Term_PT: b.Preferred_Term_PT,
    Broader_Term_BT: [],
    Narrower_Term_NT: [],
  }));
  for (const batch of chunksOf(compactMeta, BATCH_SIZE)) {
    data = data.concat(await classifyTaxonomyBatch(aiConfig, batch, bucketRefs, rawText));
  }

  const expectedIds = new Set(compactMeta.map((c) => c.Concept_ID));
  let returnedIds = new Set(data.filter((i) => i && i.Concept_ID).map((i) => String(i.Concept_ID).trim()));
  let missing = [...expectedIds].filter((id) => !returnedIds.has(id));

  let retries = 0;
  const bucketIdsStr = bucketRefs.map((b) => b.Concept_ID).join(', ');
  while (missing.length && retries < MAX_MISSING_RETRIES) {
    const missingConcepts = compactMeta.filter((c) => missing.includes(c.Concept_ID));
    for (const chunk of chunksOf(missingConcepts, RETRY_CHUNK_SIZE)) {
      const prompt = `CRITICAL ERROR: the previous taxonomy response was INCOMPLETE.
You skipped concepts. You MUST classify these specific ${chunk.length} concepts. DO NOT TRUNCATE.

Concepts to classify:
${JSON.stringify(chunk)}

Return ONLY these ${chunk.length} entries as a JSON array with the exact same keys:
- Concept_ID, Preferred_Term_PT, Broader_Term_BT, Narrower_Term_NT

Use ONLY these fixed top-level buckets as ultimate ancestors: ${bucketIdsStr}.
Assign each concept to the most appropriate bucket or an intermediate class. Do NOT invent new buckets.`;
      const extra = unwrapListIfNeeded(await askJson(aiConfig, SYSTEM_PROMPT, prompt));
      if (Array.isArray(extra)) data = data.concat(extra);
    }
    returnedIds = new Set(data.filter((i) => i && i.Concept_ID).map((i) => String(i.Concept_ID).trim()));
    missing = [...expectedIds].filter((id) => !returnedIds.has(id));
    retries += 1;
  }

  return { data, metadataStandard: metadataWithBuckets };
}

// L: batched enrichment with a full Concept_ID reference list (so
// Related_Term_RT can point anywhere in the graph, not just within a batch)
// plus a missing-entry retry loop.
async function enrichThesaurusBatch(aiConfig, batch, allIdsReference, compactCv, rawText) {
  const prompt = `PHASE 4: Thesaurus (batch of ${batch.length})

Goal: Enrich ONLY the concepts listed below with lateral relationships and human-readable definitions.

Return a JSON array. Each item must have exactly these keys:
- Concept_ID (String)
- PT (String): Preferred Term
- UF (Array of Strings): aliases/synonyms
- BT (Array of Concept_ID strings): carry over from taxonomy unchanged
- NT (Array of Concept_ID strings): carry over from taxonomy unchanged
- Related_Term_RT (Array of Concept_ID strings): lateral relationships only. May reference ANY
  Concept_ID from the full reference list below, not just this batch.
- Scope_Note_SN (String): actual definition from source text

Strict Rules:
- BT and NT must be carried over unchanged from the taxonomy below.
- Related_Term_RT is for lateral connections only — never hierarchical.
- COMPLETENESS CRITICAL: output ALL ${batch.length} concept IDs in this batch. Do NOT stop early.

Concepts to enrich (${batch.length} total — output ALL of them):
${JSON.stringify(batch)}

Full reference list of every Concept_ID in the dataset (for choosing Related_Term_RT targets):
${JSON.stringify(allIdsReference)}

Aliases reference:
${JSON.stringify(compactCv)}

Source text for scope notes:
${windowText(rawText, BUDGET.thesaurus)}
`;
  const data = unwrapListIfNeeded(await askJson(aiConfig, SYSTEM_PROMPT, prompt));
  return Array.isArray(data) ? data : [];
}

async function phaseThesaurusBatched(aiConfig, controlledVocab, taxonomy, rawText) {
  const compactTaxonomy = taxonomy.map((t) => ({
    Concept_ID: t.Concept_ID,
    Preferred_Term_PT: t.Preferred_Term_PT,
    BT: t.Broader_Term_BT || [],
    NT: t.Narrower_Term_NT || [],
  }));
  const compactCv = controlledVocab.map((c) => ({ Approved_Term: c.Approved_Term, Aliases: c.Aliases || [] }));
  const allIdsReference = compactTaxonomy.map((t) => ({ Concept_ID: t.Concept_ID, Preferred_Term_PT: t.Preferred_Term_PT }));
  const expectedIds = new Set(compactTaxonomy.map((t) => t.Concept_ID));

  let data = [];
  for (const batch of chunksOf(compactTaxonomy, BATCH_SIZE)) {
    data = data.concat(await enrichThesaurusBatch(aiConfig, batch, allIdsReference, compactCv, rawText));
  }

  let returnedIds = new Set(data.filter((i) => i && i.Concept_ID).map((i) => String(i.Concept_ID).trim()));
  let missing = [...expectedIds].filter((id) => !returnedIds.has(id));
  let retries = 0;
  while (missing.length && retries < MAX_MISSING_RETRIES) {
    const missingConcepts = compactTaxonomy.filter((t) => missing.includes(t.Concept_ID));
    for (const chunk of chunksOf(missingConcepts, RETRY_CHUNK_SIZE)) {
      const prompt = `The previous thesaurus batch was INCOMPLETE. Return ONLY these ${chunk.length} missing entries
as a JSON array with keys: Concept_ID, PT, UF, BT, NT, Related_Term_RT, Scope_Note_SN. Do NOT truncate.
${JSON.stringify(chunk)}`;
      const extra = unwrapListIfNeeded(await askJson(aiConfig, SYSTEM_PROMPT, prompt));
      if (Array.isArray(extra)) data = data.concat(extra);
    }
    returnedIds = new Set(data.filter((i) => i && i.Concept_ID).map((i) => String(i.Concept_ID).trim()));
    missing = [...expectedIds].filter((id) => !returnedIds.has(id));
    retries += 1;
  }

  return normalizeThesaurus(data, controlledVocab, taxonomy);
}

// M: richer ontology — rich verb set with reciprocal pairs, physical vs
// intangible guidance, and a Concept_Class_Map assigning every concept to
// exactly one class.
async function phaseOntology(aiConfig, thesaurus, rawText) {
  const compactConcepts = thesaurus.map((item) => ({ Concept_ID: item.Concept_ID, PT: item.PT }));
  const prompt = `PHASE 5: Ontology

Goal: Define the abstract "laws of physics" for the data model — the classes and relationship rules.

Return a JSON object with exactly these keys:
- Classes (Array of Strings): abstract meta-category names
- Object_Properties (Array of objects with: Verb, Domain, Range)
- Concept_Class_Map (Array of objects with: Concept_ID, Class)

Strict Rules (CRITICAL):
- Abstract Classes Only: classes must be meta-categories (e.g. Organization, Location, Document, Process, Person, Facility, Service, Product, Event, Policy). NEVER use specific instance names as Classes. Derive as many distinct classes as the data warrants — do NOT collapse everything into 3-4 classes.
- PHYSICAL VS INTANGIBLE: do not confuse physical infrastructure with the intangible services it provides. Physical objects MUST be classified under a physical class like Facility, Asset, or Infrastructure, never as a Service.
- PROTECT TAXONOMY: Object Properties define associative, cross-class relationships (how different things interact). Do NOT invent verbs that redefine strict hierarchical (Is-A/Part-Of) relationships — those are handled separately by the taxonomy.
- Domain and Range: every Object_Property must define exactly which classes can connect. Example: {"Verb": "employs", "Domain": "Organization", "Range": "Person"}.
- RICH VERB SET REQUIRED: define a rich, domain-specific set of verbs that reflect the actual relationships in the data (e.g. owns, employs, operates, located_in, manages, delivers, provides, governs, reports_to). Do NOT use only generic verbs.
- RECIPROCAL VERB PAIRS REQUIRED: for every top-down verb (e.g. "owns", "operates"), define its bottom-up reciprocal (e.g. "is_owned_by", "is_operated_by"). They must NEVER be the same word.
- UNIVERSAL FALLBACK REQUIRED: include at least one verb pair where both Domain and Range are "Concept", for example {"Verb": "is_related_to", "Domain": "Concept", "Range": "Concept"}.
- Concept_Class_Map: assign EVERY Concept_ID below to exactly ONE class. Do not skip any ID.

Concepts to classify:
${JSON.stringify(compactConcepts, null, 2)}

Source text for context:
${windowText(rawText, BUDGET.ontology)}
`;
  const data = await askJson(aiConfig, SYSTEM_PROMPT, prompt);
  return normalizeOntology(data, thesaurus);
}

/**
 * Run the full six-phase pipeline over rawText (the concatenation of every
 * file processed so far in this session). onPhase(name) fires before each
 * phase starts, so the UI can show live progress.
 *
 * previousState — the object returned by the prior call to this function
 * (or null for the first file). Passing it in is what makes results
 * cumulative: each phase's freshly-extracted output is unioned with
 * previousState rather than replacing it outright, so a concept the AI
 * fails to re-mention on a later, larger corpus (whether from budget
 * truncation or just not re-naming it) is still carried forward instead of
 * silently dropped.
 *
 * options.allowWorldKnowledgeBridging (default true) — when the knowledge
 * graph ends up split into disconnected clusters, ask the AI to propose
 * bridging relationships using general domain knowledge (O). Set to false
 * to skip the extra AI round-trips this can add.
 */
export async function runSixPhasePipeline(rawText, aiConfig, onPhase, previousState = null, options = {}) {
  const { allowWorldKnowledgeBridging = true } = options;
  runIndex += 1;
  const thisRun = runIndex;

  onPhase?.('vocabulary');
  const freshControlledVocab = await phaseControlledVocabulary(aiConfig, rawText);
  const controlledVocab = mergeControlledVocab(previousState?.controlledVocab, freshControlledVocab);

  onPhase?.('metadata');
  let metadataStandard = buildMetadataStandard(controlledVocab, thisRun);
  metadataStandard = mergeMetadataStandard(previousState?.metadataStandard, metadataStandard);

  onPhase?.('taxonomy');
  const { data: taxData, metadataStandard: metadataWithBuckets } = await phaseTaxonomyBatched(
    aiConfig,
    metadataStandard,
    rawText,
    thisRun
  );
  metadataStandard = admitNewTerms(taxData, metadataWithBuckets, thisRun); // H
  let taxonomy = normalizeTaxonomy(taxData, metadataStandard);
  taxonomy = mergeTaxonomy(previousState?.taxonomy, taxonomy);
  taxonomy = postProcessTaxonomy(taxonomy); // C
  taxonomy = attachFloatingAndMergeComponents(taxonomy); // K

  onPhase?.('thesaurus');
  const freshThesaurus = await phaseThesaurusBatched(aiConfig, controlledVocab, taxonomy, rawText);
  const thesaurus = mergeThesaurus(previousState?.thesaurus, freshThesaurus);

  onPhase?.('ontology');
  const freshOntology = await phaseOntology(aiConfig, thesaurus, rawText);
  const ontology = mergeOntology(previousState?.ontology, freshOntology);

  onPhase?.('knowledge_graph');
  const knowledgeGraph = buildKnowledgeGraph(thesaurus, ontology);
  if (allowWorldKnowledgeBridging) {
    await bridgeDisconnectedComponents(aiConfig, knowledgeGraph['@graph'], knowledgeGraph['@context']); // O
  }

  return {
    controlledVocab,
    metadataStandard,
    taxonomy,
    thesaurus,
    ontology,
    knowledgeGraph,
    _meta: buildRunMeta(rawText), // B: truncation is reported, not silent
  };
}

export const PIPELINE_STAGES = [
  { key: 'vocabulary', label: 'Controlled Vocabulary' },
  { key: 'metadata', label: 'Metadata Standard' },
  { key: 'taxonomy', label: 'Taxonomy' },
  { key: 'thesaurus', label: 'Thesaurus' },
  { key: 'ontology', label: 'Ontology' },
  { key: 'knowledge_graph', label: 'Knowledge Graph' },
];
