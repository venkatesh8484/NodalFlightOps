/**
 * Converts controlled vocabulary and metadata standard data to JSON-LD format
 * for graph visualization
 */

type ControlledVocabItem = {
  Approved_Term: string
  Aliases: string[]
}

type MetadataStandardItem = {
  Concept_ID: string
  Preferred_Term_PT: string
  Used_For_UF: string[]
  Status: string
}

/**
 * Phase 0: Controlled Vocabulary (Hub-Spoke Pattern)
 * Each approved term is a hub with aliases as spokes
 */
export function convertControlledVocabToJsonLd(data: ControlledVocabItem[]) {
  const graph: any[] = []
  
  data.forEach((item, index) => {
    const hubId = `vocab:term_${index}`
    
    // Hub node (Approved Term)
    graph.push({
      '@id': hubId,
      '@type': 'skos:Concept',
      'skos:prefLabel': item.Approved_Term,
      'ex:isHub': true,
      'ex:clusterIndex': index
    })
    
    // Spoke nodes (Aliases)
    item.Aliases.forEach((alias, aliasIndex) => {
      const aliasId = `${hubId}_alias_${aliasIndex}`
      
      graph.push({
        '@id': aliasId,
        '@type': 'skos:Concept',
        'skos:prefLabel': alias,
        'ex:isAlias': true,
        'ex:clusterIndex': index,
        'skos:broader': { '@id': hubId }
      })
    })
  })
  
  return {
    '@context': {
      'skos': 'http://www.w3.org/2004/02/skos/core#',
      'ex': 'http://example.org/ontology#',
      'vocab': 'http://example.org/vocab#'
    },
    '@graph': graph
  }
}

/**
 * Phase 1: Metadata Standard (Hub-Spoke with Outer Circle Buckets)
 * Same hub-spoke pattern but with metadata bucket containers
 */
export function convertMetadataStandardToJsonLd(data: MetadataStandardItem[]) {
  const graph: any[] = []
  
  data.forEach((item, index) => {
    const hubId = item.Concept_ID
    
    // Hub node (Preferred Term with metadata)
    graph.push({
      '@id': hubId,
      '@type': 'ex:PreferredTerm',
      'skos:prefLabel': item.Preferred_Term_PT,
      'ex:conceptId': item.Concept_ID,
      'ex:status': item.Status,
      'ex:isHub': true,
      'ex:isMetadata': true,
      'ex:clusterIndex': index,
      'ex:aliasCount': item.Used_For_UF.length
    })
    
    // Bucket container (virtual node for outer circle)
    graph.push({
      '@id': `${hubId}_bucket`,
      '@type': 'ex:MetadataBucket',
      'ex:containsConcept': { '@id': hubId },
      'ex:preferredTerm': item.Preferred_Term_PT,
      'ex:conceptId': item.Concept_ID,
      'ex:status': item.Status,
      'ex:isBucket': true,
      'ex:clusterIndex': index
    })
    
    // Spoke nodes (Used For - Aliases)
    item.Used_For_UF.forEach((alias, aliasIndex) => {
      const aliasId = `${hubId}_uf_${aliasIndex}`
      
      graph.push({
        '@id': aliasId,
        '@type': 'ex:AlternateLabel',
        'skos:prefLabel': alias,
        'ex:isAlias': true,
        'ex:clusterIndex': index,
        'skos:broader': { '@id': hubId }
      })
    })
  })
  
  return {
    '@context': {
      'skos': 'http://www.w3.org/2004/02/skos/core#',
      'ex': 'http://example.org/ontology#'
    },
    '@graph': graph
  }
}
