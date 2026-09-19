/**
 * Generates progressive JSON-LD data for each pipeline phase.
 * Phase 1: Just nodes (terms) — no relationships
 * Phase 2: Nodes gain types & metadata properties
 * Phase 3: Hierarchy edges (broader/narrower)
 * Phase 4: Thesaurus cross-links (related, synonym refs)
 * Phase 5: Ontology formal relations (subClassOf, domain, range)
 * Phase 6: Full knowledge graph — all entities linked
 */

const baseTerms = [
  { id: 'ex:PostalService', label: 'Postal Service', type: 'owl:Class', group: 'core' },
  { id: 'ex:Hub', label: 'Hub', type: 'owl:Class', group: 'core' },
  { id: 'ex:SortingCentre', label: 'Sorting Centre', type: 'owl:Class', group: 'core' },
  { id: 'ex:Region', label: 'Region', type: 'owl:Class', group: 'geo' },
  { id: 'ex:PostalCode', label: 'Postal Code', type: 'owl:Class', group: 'geo' },
  { id: 'ex:Address', label: 'Address', type: 'owl:Class', group: 'geo' },
  { id: 'ex:Volume', label: 'Volume', type: 'owl:Class', group: 'data' },
  { id: 'ex:Package', label: 'Package', type: 'owl:Class', group: 'data' },
  { id: 'ex:Status', label: 'Status', type: 'owl:Class', group: 'data' },
  { id: 'ex:Route', label: 'Route', type: 'owl:Class', group: 'ops' },
  { id: 'ex:Vehicle', label: 'Vehicle', type: 'owl:Class', group: 'ops' },
  { id: 'ex:Delivery', label: 'Delivery', type: 'owl:Class', group: 'ops' },
]

// Phase 3: Tree hierarchy (parent → child)
const taxonomyEdges: [string, string, string][] = [
  ['ex:PostalService', 'ex:Hub', 'skos:narrower'],
  ['ex:PostalService', 'ex:SortingCentre', 'skos:narrower'],
  ['ex:Hub', 'ex:Region', 'skos:narrower'],
  ['ex:Hub', 'ex:Volume', 'skos:narrower'],
  ['ex:SortingCentre', 'ex:Route', 'skos:narrower'],
  ['ex:SortingCentre', 'ex:Vehicle', 'skos:narrower'],
  ['ex:Region', 'ex:Address', 'skos:narrower'],
  ['ex:Route', 'ex:Package', 'skos:narrower'],
  ['ex:Vehicle', 'ex:Delivery', 'skos:narrower'],
  ['ex:Address', 'ex:PostalCode', 'skos:narrower'],
  ['ex:Package', 'ex:Status', 'skos:narrower'],
]

// Phase 4: Thesaurus cross-references
const thesaurusEdges: [string, string, string][] = [
  ['ex:Volume', 'ex:Package', 'skos:related'],
  ['ex:Region', 'ex:PostalCode', 'skos:related'],
  ['ex:Route', 'ex:Delivery', 'skos:related'],
  ['ex:Hub', 'ex:SortingCentre', 'skos:related'],
  ['ex:Address', 'ex:PostalCode', 'skos:related'],
]

// Phase 5: Ontology formal relations
const ontologyEdges: [string, string, string][] = [
  ['ex:Volume', 'ex:Status', 'ex:hasStatus'],
  ['ex:Vehicle', 'ex:Route', 'ex:assignedTo'],
  ['ex:Delivery', 'ex:Status', 'ex:trackingStatus'],
  ['ex:Package', 'ex:Delivery', 'ex:deliveredVia'],
  ['ex:Region', 'ex:Volume', 'ex:measuredBy'],
]

// Phase 6: Knowledge graph instance links
const kgEdges: [string, string, string][] = [
  ['ex:PostalService', 'ex:Volume', 'ex:manages'],
  ['ex:PostalService', 'ex:Route', 'ex:operates'],
  ['ex:Hub', 'ex:Vehicle', 'ex:dispatches'],
  ['ex:SortingCentre', 'ex:Package', 'ex:processes'],
  ['ex:Address', 'ex:Package', 'ex:receivesAt'],
  ['ex:PostalCode', 'ex:Status', 'ex:zoneStatus'],
  ['ex:Delivery', 'ex:Package', 'ex:contains'],
]

function buildJsonLd(phase: number) {
  // Phase 1 (Metadata Standard): Add category nodes for grouping visualization
  const categoryNodes = phase === 1 ? [
    { id: 'ex:CoreConcepts', label: 'Core Concepts', type: 'ex:Category', isCategory: true },
    { id: 'ex:GeographicConcepts', label: 'Geographic Concepts', type: 'ex:Category', isCategory: true },
    { id: 'ex:DataConcepts', label: 'Data Concepts', type: 'ex:Category', isCategory: true },
    { id: 'ex:OperationalConcepts', label: 'Operational Concepts', type: 'ex:Category', isCategory: true },
  ] : []

  // Phase 1: Add edges connecting terms to their category buckets
  const categoryEdges: [string, string, string][] = phase === 1 ? [
    // Core group
    ['ex:PostalService', 'ex:CoreConcepts', 'ex:belongsTo'],
    ['ex:Hub', 'ex:CoreConcepts', 'ex:belongsTo'],
    ['ex:SortingCentre', 'ex:CoreConcepts', 'ex:belongsTo'],
    // Geographic group
    ['ex:Region', 'ex:GeographicConcepts', 'ex:belongsTo'],
    ['ex:PostalCode', 'ex:GeographicConcepts', 'ex:belongsTo'],
    ['ex:Address', 'ex:GeographicConcepts', 'ex:belongsTo'],
    // Data group
    ['ex:Volume', 'ex:DataConcepts', 'ex:belongsTo'],
    ['ex:Package', 'ex:DataConcepts', 'ex:belongsTo'],
    ['ex:Status', 'ex:DataConcepts', 'ex:belongsTo'],
    // Operations group
    ['ex:Route', 'ex:OperationalConcepts', 'ex:belongsTo'],
    ['ex:Vehicle', 'ex:OperationalConcepts', 'ex:belongsTo'],
    ['ex:Delivery', 'ex:OperationalConcepts', 'ex:belongsTo'],
  ] : []

  // Determine which edges to include
  let edges: [string, string, string][] = [...categoryEdges]
  if (phase >= 2) edges = [...edges, ...taxonomyEdges]
  if (phase >= 3) edges = [...edges, ...thesaurusEdges]
  if (phase >= 4) edges = [...edges, ...ontologyEdges]
  if (phase >= 5) edges = [...edges, ...kgEdges]

  // Build edge lookup: source → [{target, rel}]
  const edgeMap = new Map<string, { target: string; rel: string }[]>()
  for (const [src, tgt, rel] of edges) {
    if (!edgeMap.has(src)) edgeMap.set(src, [])
    edgeMap.get(src)!.push({ target: tgt, rel })
  }

  // Build @graph items - include category nodes for Phase 1
  const allTerms = phase === 1 ? [...categoryNodes, ...baseTerms] : baseTerms
  
  const graph = allTerms.map(term => {
    const item: Record<string, unknown> = {
      '@id': term.id,
      '@type': phase >= 1 ? term.type : 'skos:Concept',
      'skos:prefLabel': term.label,
    }

    // Mark category nodes differently
    if ('isCategory' in term && term.isCategory) {
      item['ex:isCategory'] = true
    }

    // Phase 1+: Add metadata properties (for non-category nodes)
    if (phase >= 1 && 'group' in term) {
      item['ex:group'] = term.group
    }

    // Add edges as properties
    const termEdges = edgeMap.get(term.id) || []
    for (const { target, rel } of termEdges) {
      if (item[rel]) {
        // Multiple values → array
        const existing = item[rel]
        if (Array.isArray(existing)) {
          existing.push({ '@id': target })
        } else {
          item[rel] = [existing, { '@id': target }]
        }
      } else {
        item[rel] = { '@id': target }
      }
    }

    return item
  })

  return {
    '@context': {
      'owl': 'http://www.w3.org/2002/07/owl#',
      'skos': 'http://www.w3.org/2004/02/skos/core#',
      'ex': 'http://example.org/postal#',
    },
    '@graph': graph,
  }
}

// Pre-build all 6 phases
const phaseGraphData: Record<string, unknown>[] = [0, 1, 2, 3, 4, 5].map(buildJsonLd)

export function getPhaseJsonLd(phase: number): Record<string, unknown> {
  return phaseGraphData[Math.min(Math.max(0, phase), 5)]
}
