import { Suspense, lazy, useState, useEffect, useMemo } from 'react'
import type { ChangeEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  FiUpload, FiSettings, FiLogOut, FiMoon, FiSun,
  FiDatabase, FiCpu, FiGitBranch, FiBookOpen, FiLayers, FiShare2,
  FiArrowRight, FiChevronRight, FiZap
} from 'react-icons/fi'
import './App.css'
import PhaseWorkflow from './components/PhaseWorkflow'
import { getPhaseJsonLd } from './data/phaseGraphData'
import { convertControlledVocabToJsonLd, convertMetadataStandardToJsonLd } from './utils/graphConverters'

const JsonLd3DGraph = lazy(() => import('./components/JsonLd3DGraph'))

type UploadResponse = {
  pipeline_mode: string
  accepted: number
  rejected: number
  files: any[]
  stage_outputs?: {
    controlled_vocabulary_json?: string | null
    metadata_standard_json?: string | null
    taxonomy_json?: string | null
    thesaurus_json?: string | null
    ontology_json?: string | null
    knowledge_graph_jsonld?: string | null
    controlled_vocabulary_xlsx: string
    metadata_xlsx: string
    taxonomy_xlsx: string
    thesaurus_xlsx: string
    ontology_xlsx: string
    knowledge_graph_xlsx: string
  } | null
}

type PreviewResponse = {
  path: string
  kind: 'json' | 'xlsx' | 'text'
  data?: unknown
  truncated?: boolean
}

const phases = [
  { 
    id: 0, name: 'Controlled Vocabulary', icon: FiDatabase, color: '#60a5fa',
    subtitle: 'Extract & Standardize Terms',
    description: 'Extracts domain-specific terms from uploaded documents and builds a controlled vocabulary — a curated list of standardized terms with unique identifiers and definitions.',
    steps: [
      'Parse uploaded files (PDF, XLSX, SQL, CSV)',
      'Extract domain-specific terms and labels',
      'Assign unique identifiers to each term',
      'Standardize naming conventions',
      'Generate controlled vocabulary JSON + XLSX'
    ],
    input: 'Raw documents (PDF, XLSX, SQL)',
    output: 'Controlled vocabulary with standardized terms'
  },
  { 
    id: 1, name: 'Metadata Standard', icon: FiCpu, color: '#34d399',
    subtitle: 'Define Data Schema & Properties',
    description: 'Creates metadata standards by defining properties, data types, and constraints for each term. Establishes how data elements relate to recognized metadata schemas.',
    steps: [
      'Map vocabulary terms to metadata fields',
      'Define data types and cardinality',
      'Add constraints and validation rules',
      'Align with industry metadata standards',
      'Generate metadata standard JSON + XLSX'
    ],
    input: 'Controlled vocabulary',
    output: 'Metadata schema with typed properties'
  },
  { 
    id: 2, name: 'Taxonomy', icon: FiGitBranch, color: '#fbbf24',
    subtitle: 'Build Hierarchical Classification',
    description: 'Organizes terms into a hierarchical classification tree with parent-child relationships, creating a structured taxonomy for domain concepts.',
    steps: [
      'Identify broader/narrower term relationships',
      'Build parent-child hierarchies',
      'Create multi-level classification trees',
      'Validate hierarchy consistency',
      'Generate taxonomy JSON + XLSX'
    ],
    input: 'Metadata standard',
    output: 'Hierarchical classification of domain concepts'
  },
  { 
    id: 3, name: 'Thesaurus', icon: FiBookOpen, color: '#f87171',
    subtitle: 'Map Semantic Relationships',
    description: 'Enriches the taxonomy with semantic relationships — synonyms, related terms, and associative links — creating a comprehensive thesaurus for navigation and discovery.',
    steps: [
      'Identify synonyms and alternate labels',
      'Map associative (related) term links',
      'Add scope notes and usage context',
      'Cross-reference between categories',
      'Generate thesaurus JSON + XLSX'
    ],
    input: 'Taxonomy',
    output: 'Thesaurus with rich semantic links'
  },
  { 
    id: 4, name: 'Ontology', icon: FiLayers, color: '#a78bfa',
    subtitle: 'Define Classes & Logical Rules',
    description: 'Constructs a formal ontology with classes, properties, and logical axioms. Defines domain constraints, inheritance, and rules that machines can reason over.',
    steps: [
      'Define OWL/RDFS classes from taxonomy',
      'Add object and data properties',
      'Set domain and range constraints',
      'Define class inheritance (subClassOf)',
      'Generate ontology JSON + XLSX'
    ],
    input: 'Thesaurus',
    output: 'Formal ontology with logical axioms'
  },
  { 
    id: 5, name: 'Knowledge Graph', icon: FiShare2, color: '#fb923c',
    subtitle: 'Generate Linked Data Graph',
    description: 'Produces a JSON-LD knowledge graph with interconnected entities, properties, and relationships — ready for querying, visualization, and integration with semantic web tools.',
    steps: [
      'Instantiate ontology classes as entities',
      'Link entities via object properties',
      'Serialize as JSON-LD with @context',
      'Generate interactive 3D graph visualization',
      'Export knowledge graph JSON-LD + XLSX'
    ],
    input: 'Ontology',
    output: 'JSON-LD knowledge graph with linked entities'
  },
]

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('graphify-theme')
    return (saved as 'dark' | 'light') || 'dark'
  })
  const [activePhase, setActivePhase] = useState(0)
  const [activeView, setActiveView] = useState<'graph' | 'json' | 'xlsx'>('xlsx')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [loading, setLoading] = useState(false)
  const [graphLoading, setGraphLoading] = useState(false)
  const [result, setResult] = useState<UploadResponse | null>(null)
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [controlledVocab, setControlledVocab] = useState<any>(null)
  const [metadataStandard, setMetadataStandard] = useState<any>(null)
  const [taxonomy, setTaxonomy] = useState<any>(null)
  const [thesaurus, setThesaurus] = useState<any>(null)
  const [ontology, setOntology] = useState<any>(null)
  const [knowledgeGraph, setKnowledgeGraph] = useState<any>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [error, setError] = useState<string | null>(null)
  
  const graphMode = '3d' as const
  const [graphOffsetX, setGraphOffsetX] = useState(0)
  const [graphOffsetY, setGraphOffsetY] = useState(0)

  // Auto-dismiss error toast after 10 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 10000)
      return () => clearTimeout(timer)
    }
  }, [error])

  // Reset graph offsets and set appropriate view when phase changes
  useEffect(() => {
    setGraphOffsetX(0)
    setGraphOffsetY(0)
    
    // Set default view based on phase
    if (activePhase === 5) {
      setActiveView('graph')  // Phase 6: default to graph
    } else {
      setActiveView('xlsx')   // Phases 1-5: default to xlsx
    }
  }, [activePhase])
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('graphify-theme', theme)
  }, [theme])

  useEffect(() => {
    fetch('/api/v1/uploads/latest')
      .then(res => res.json())
      .then((data: UploadResponse) => {
        if (data.stage_outputs) {
          setResult(data)
          setIsLoggedIn(true)
        }
      })
      .catch(() => setIsLoggedIn(true)) // Auto-login for demo
  }, [])

  // Fetch controlled vocabulary data for Phase 0
  useEffect(() => {
    fetch(`/generated_outputs/json/01_controlled_vocabulary.json?t=${Date.now()}`)
      .then(res => {
        console.log('[App] Fetching controlled vocabulary, status:', res.status)
        return res.json()
      })
      .then(data => {
        console.log('[App] Controlled vocabulary loaded:', data?.length, 'terms')
        setControlledVocab(data)
      })
      .catch(err => console.error('[App] Could not load controlled vocabulary:', err))
  }, [refreshTrigger])

  // Fetch metadata standard data for Phase 1
  useEffect(() => {
    fetch(`/generated_outputs/json/02_metadata_standard.json?t=${Date.now()}`)
      .then(res => {
        console.log('[App] Fetching metadata standard, status:', res.status)
        return res.json()
      })
      .then(data => {
        console.log('[App] Metadata standard loaded:', data?.length, 'concepts')
        setMetadataStandard(data)
      })
      .catch(err => console.error('[App] Could not load metadata standard:', err))
  }, [refreshTrigger])

  // Fetch taxonomy data for Phase 2
  useEffect(() => {
    fetch(`/generated_outputs/json/03_taxonomy.json?t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        console.log('[App] Taxonomy loaded:', data?.length, 'concepts')
        setTaxonomy(data)
      })
      .catch(err => console.error('[App] Could not load taxonomy:', err))
  }, [refreshTrigger])

  // Fetch thesaurus data for Phase 3
  useEffect(() => {
    fetch(`/generated_outputs/json/04_thesaurus.json?t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        console.log('[App] Thesaurus loaded:', data?.length, 'concepts')
        setThesaurus(data)
      })
      .catch(err => console.error('[App] Could not load thesaurus:', err))
  }, [refreshTrigger])

  // Fetch ontology data for Phase 4
  useEffect(() => {
    fetch(`/generated_outputs/json/05_ontology.json?t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        console.log('[App] Ontology loaded')
        setOntology(data)
      })
      .catch(err => console.error('[App] Could not load ontology:', err))
  }, [refreshTrigger])

  // Fetch knowledge graph data for Phase 5
  useEffect(() => {
    fetch(`/generated_outputs/json/06_knowledge_graph.jsonld?t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        console.log('[App] Knowledge graph loaded')
        setKnowledgeGraph(data)
        setGraphLoading(false)
      })
      .catch(err => {
        console.error('[App] Could not load knowledge graph:', err)
        setGraphLoading(false)
      })
  }, [refreshTrigger])

  useEffect(() => {
    if (!result || activePhase < 0) return

    const phaseKeys = [
      'controlled_vocabulary',
      'metadata_standard',
      'taxonomy',
      'thesaurus',
      'ontology',
      'knowledge_graph'
    ]
    const key = phaseKeys[activePhase]
    const jsonPath = result.stage_outputs?.[`${key}_json${activePhase === 5 ? 'ld' : ''}` as keyof typeof result.stage_outputs]
    
    if (!jsonPath || typeof jsonPath !== 'string') return

    fetch(`/api/v1/uploads/artifact-preview?path=${encodeURIComponent(jsonPath)}`)
      .then(res => res.json())
      .then((data: PreviewResponse) => setPreview(data))
      .catch(console.error)
  }, [activePhase, result])

  const uploadFiles = async () => {
    if (!files.length) return
    setLoading(true)
    setError(null)
    
    const formData = new FormData()
    files.forEach(f => formData.append('files', f))
    formData.append('output_base', 'ontology')
    formData.append('pipeline_mode', 'current')

    try {
      const res = await fetch('/api/v1/uploads/process', { method: 'POST', body: formData })
      if (!res.ok) {
        let errorMsg = `Server error (${res.status})`
        try {
          const errData = await res.json()
          errorMsg = errData.detail || errorMsg
        } catch {
          errorMsg = await res.text().catch(() => errorMsg)
        }
        setError(errorMsg)
        return
      }
      const data: UploadResponse = await res.json()
      setResult(data)
      setGraphLoading(true)
      setKnowledgeGraph(null)
      setRefreshTrigger(prev => prev + 1)
      setUploadOpen(false)
      setActivePhase(5)
      setActiveView('graph')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Check server logs.')
    } finally {
      setLoading(false)
    }
  }

  const jsonText = useMemo(() => {
    if (preview?.kind !== 'json') return ''
    try {
      return JSON.stringify(preview.data, null, 2).slice(0, 100000)
    } catch {
      return ''
    }
  }, [preview])

  // Use real uploaded data if available for this phase, otherwise use synthetic progressive data
  const activeGraphData = useMemo(() => {
    // Phase 0: Use real controlled vocabulary data (hub-spoke pattern)
    if (activePhase === 0 && controlledVocab) {
      console.log('[App] Using real controlled vocabulary data for Phase 0')
      return convertControlledVocabToJsonLd(controlledVocab)
    }
    
    // Phase 1: Use real metadata standard data (hub-spoke with buckets)
    if (activePhase === 1 && metadataStandard) {
      console.log('[App] Using real metadata standard data for Phase 1')
      return convertMetadataStandardToJsonLd(metadataStandard)
    }
    
    // Check if we have valid preview data for the current phase
    if (preview?.kind === 'json' && preview.data) {
      const data = preview.data as any
      // If it has @graph array, use it
      if (Array.isArray(data['@graph']) && data['@graph'].length > 0) {
        console.log('[App] Using preview data with @graph')
        return preview.data
      }
      // If it's an object with @context, try to wrap it in @graph format
      if (data['@context']) {
        console.log('[App] Using preview data with @context')
        return preview.data
      }
    }
    // Fall back to synthetic progressive data
    console.log('[App] Using synthetic progressive data for Phase', activePhase)
    return getPhaseJsonLd(activePhase)
  }, [activePhase, preview, controlledVocab, metadataStandard])

  if (!isLoggedIn) {
    return (
      <motion.div 
        className="login-screen"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
      >
        <motion.div 
          className="login-logo"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
        >
          Ontology Pipeline
        </motion.div>
        <motion.div 
          className="login-form"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
        >
          <input className="login-input" type="text" placeholder="Username" />
          <input className="login-input" type="password" placeholder="Password" />
          <motion.button 
            className="login-button" 
            onClick={() => setIsLoggedIn(true)}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            Sign In
          </motion.button>
        </motion.div>
      </motion.div>
    )
  }

  return (
    <motion.div 
      className="app"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div className="main-layout">
        <motion.div 
          className="workflow-panel"
          initial={{ x: -280, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 80, delay: 0.2 }}
        >
          <div className="workflow-header">
            <div className="workflow-title">Ontology Pipeline</div>
          </div>

          <div className="phase-list">
            <AnimatePresence>
              {phases.map((phase, i) => {
                const Icon = phase.icon
                const isActive = activePhase === i
                return (
                  <motion.div
                    key={phase.id}
                    className={`phase-item ${isActive ? 'active' : ''}`}
                    onClick={() => setActivePhase(i)}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ delay: 0.3 + i * 0.06 }}
                    whileHover={{ x: 6, backgroundColor: isActive ? undefined : 'rgba(96, 165, 250, 0.08)' }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <div className="phase-number" style={{ background: isActive ? phase.color : 'transparent', borderColor: phase.color }}>
                      <Icon size={14} style={{ color: isActive ? 'white' : phase.color }} />
                    </div>
                    <div className="phase-content">
                      <div className="phase-name">{phase.name}</div>
                      <div className="phase-desc">{phase.subtitle}</div>
                    </div>
                    <FiChevronRight className="phase-chevron" style={{ color: isActive ? phase.color : 'var(--text-secondary)' }} />
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        </motion.div>

        <motion.div 
          className="content"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <motion.div 
            className="content-header"
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.4 }}
          >
            <motion.div 
              className="content-title"
              key={activePhase}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
            >
              {phases[activePhase]?.name || 'Select Phase'}
            </motion.div>
            <div className="view-tabs">
              {(activePhase === 5 ? ['graph', 'json', 'xlsx'] : ['xlsx', 'json']).map((view) => (
                <motion.button
                  key={view}
                  className={`view-tab ${activeView === view ? 'active' : ''}`}
                  onClick={() => setActiveView(view as any)}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  {view.charAt(0).toUpperCase() + view.slice(1)}
                </motion.button>
              ))}
            </div>
          </motion.div>

          <div className="content-main">
            {activeView === 'graph' && (
              <div className="graph-container">
                <div className={`phase-hero ${activePhase === 5 ? 'full-width' : ''}`}>
                  <div className="phase-hero-graph">
                    {graphLoading ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: '16px' }}>
                        <div className="graph-spinner" />
                        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>Building knowledge graph...</div>
                      </div>
                    ) : (
                    <Suspense fallback={
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: '16px' }}>
                        <div className="graph-spinner" />
                      </div>
                    }>
                      <JsonLd3DGraph
                        key={`graph-${activePhase}-${graphMode}`}
                        jsonLdData={activeGraphData}
                        mode={graphMode}
                        offsetX={graphOffsetX}
                        offsetY={graphOffsetY}
                        onMove={(dx, dy) => {
                          setGraphOffsetX(x => x + dx)
                          setGraphOffsetY(y => y + dy)
                        }}
                      />
                    </Suspense>
                    )}
                  </div>

                  {activePhase !== 5 && (
                    <motion.div
                      className="phase-hero-info"
                      key={`info-${activePhase}`}
                      initial={{ opacity: 0, x: 30 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.5, delay: 0.1 }}
                    >
                    <div className="phi-badge" style={{ background: `${phases[activePhase]?.color}18`, borderColor: `${phases[activePhase]?.color}40` }}>
                      <FiZap size={12} style={{ color: phases[activePhase]?.color }} />
                      <span style={{ color: phases[activePhase]?.color }}>Phase {activePhase + 1} of 6</span>
                    </div>

                    <h2 className="phi-title">{phases[activePhase]?.name}</h2>
                    <p className="phi-subtitle">{phases[activePhase]?.subtitle}</p>
                    <p className="phi-desc">{phases[activePhase]?.description}</p>

                    <div className="phi-io">
                      <div className="phi-io-block">
                        <div className="phi-io-label">INPUT</div>
                        <div className="phi-io-value">{phases[activePhase]?.input}</div>
                      </div>
                      <div className="phi-io-arrow"><FiArrowRight size={16} /></div>
                      <div className="phi-io-block phi-io-output">
                        <div className="phi-io-label">OUTPUT</div>
                        <div className="phi-io-value">{phases[activePhase]?.output}</div>
                      </div>
                    </div>

                    <div className="phi-steps">
                      {phases[activePhase]?.steps.map((step, i) => (
                        <motion.div
                          key={i}
                          className="phi-step"
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: 0.2 + i * 0.06 }}
                        >
                          <div className="phi-step-dot" style={{ background: phases[activePhase]?.color }} />
                          <span>{step}</span>
                        </motion.div>
                      ))}
                    </div>

                    {activePhase < 5 && (
                      <motion.button
                        className="phi-next-btn"
                        onClick={() => setActivePhase(activePhase + 1)}
                        whileHover={{ x: 4 }}
                        whileTap={{ scale: 0.97 }}
                      >
                        <span>Next: {phases[activePhase + 1]?.name}</span>
                        <FiChevronRight size={16} />
                      </motion.button>
                    )}
                  </motion.div>
                  )}
                </div>
              </div>
            )}

            {activeView === 'json' && (
              <div className="json-viewer">
                {jsonText ? (
                  <pre className="json-content">{jsonText}</pre>
                ) : (
                  <div className="empty-state">
                    <FiDatabase className="empty-icon" />
                    <div className="empty-text">No JSON data</div>
                  </div>
                )}
              </div>
            )}

            {activeView === 'xlsx' && (
              <div className="xlsx-viewer">
                {(() => {
                  // Phase 0: Controlled Vocabulary
                  if (activePhase === 0 && controlledVocab) {
                    return (
                      <div className="table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Approved Term</th>
                              <th>Aliases</th>
                            </tr>
                          </thead>
                          <tbody>
                            {controlledVocab.map((row: any, idx: number) => (
                              <tr key={idx}>
                                <td className="font-semibold">{row.Approved_Term}</td>
                                <td>{Array.isArray(row.Aliases) ? row.Aliases.join(', ') : row.Aliases}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  }
                  
                  // Phase 1: Metadata Standard
                  if (activePhase === 1 && metadataStandard) {
                    return (
                      <div className="table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Concept ID</th>
                              <th>Preferred Term PT</th>
                              <th>Used For UF</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metadataStandard.map((row: any, idx: number) => (
                              <tr key={idx}>
                                <td className="font-mono text-accent">{row.Concept_ID}</td>
                                <td className="font-semibold">{row.Preferred_Term_PT}</td>
                                <td>{Array.isArray(row.Used_For_UF) ? row.Used_For_UF.join(', ') : row.Used_For_UF}</td>
                                <td><span className="status-badge">{row.Status}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  }
                  
                  // Phase 2: Taxonomy
                  if (activePhase === 2 && taxonomy) {
                    return (
                      <div className="table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Concept ID</th>
                              <th>Preferred Term PT</th>
                              <th>Broader Term BT</th>
                              <th>Narrower Term NT</th>
                            </tr>
                          </thead>
                          <tbody>
                            {taxonomy.map((row: any, idx: number) => (
                              <tr key={idx}>
                                <td className="font-mono text-accent">{row.Concept_ID}</td>
                                <td className="font-semibold">{row.Preferred_Term_PT}</td>
                                <td>{Array.isArray(row.Broader_Term_BT) && row.Broader_Term_BT.length > 0 ? row.Broader_Term_BT.join(', ') : '-'}</td>
                                <td>{Array.isArray(row.Narrower_Term_NT) && row.Narrower_Term_NT.length > 0 ? row.Narrower_Term_NT.join(', ') : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  }
                  
                  // Phase 3: Thesaurus
                  if (activePhase === 3 && thesaurus) {
                    return (
                      <div className="table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Concept ID</th>
                              <th>Preferred Term PT</th>
                              <th>Related Terms RT</th>
                              <th>Broader Term BT</th>
                              <th>Narrower Term NT</th>
                            </tr>
                          </thead>
                          <tbody>
                            {thesaurus.map((row: any, idx: number) => (
                              <tr key={idx}>
                                <td className="font-mono text-accent">{row.Concept_ID}</td>
                                <td className="font-semibold">{row.PT}</td>
                                <td>{Array.isArray(row.Related_Term_RT) && row.Related_Term_RT.length > 0 ? row.Related_Term_RT.join(', ') : '-'}</td>
                                <td>{Array.isArray(row.BT) && row.BT.length > 0 ? row.BT.join(', ') : '-'}</td>
                                <td>{Array.isArray(row.NT) && row.NT.length > 0 ? row.NT.join(', ') : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  }
                  
                  // Phase 4: Ontology
                  if (activePhase === 4 && ontology) {
                    return (
                      <div className="xlsx-viewer-multi">
                        <div className="table-section">
                          <h3 className="table-section-title">Classes</h3>
                          <div className="table-container">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Class Name</th>
                                </tr>
                              </thead>
                              <tbody>
                                {ontology.Classes?.map((className: string, idx: number) => (
                                  <tr key={idx}>
                                    <td className="font-semibold">{className}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                        
                        <div className="table-section">
                          <h3 className="table-section-title">Object Properties</h3>
                          <div className="table-container">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Verb</th>
                                  <th>Domain</th>
                                  <th>Range</th>
                                </tr>
                              </thead>
                              <tbody>
                                {ontology.Object_Properties?.map((prop: any, idx: number) => (
                                  <tr key={idx}>
                                    <td className="font-semibold text-accent">{prop.Verb}</td>
                                    <td>{prop.Domain}</td>
                                    <td>{prop.Range}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    )
                  }
                  
                  // Phase 5: Knowledge Graph
                  if (activePhase === 5 && knowledgeGraph) {
                    const nodes = knowledgeGraph['@graph'] || []
                    if (nodes.length === 0) {
                      return (
                        <div className="empty-state">
                          <FiDatabase className="empty-icon" />
                          <div className="empty-text">No graph data available</div>
                        </div>
                      )
                    }
                    return (
                      <div className="table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>ID</th>
                              <th>Type</th>
                              <th>Label</th>
                              <th>Properties</th>
                            </tr>
                          </thead>
                          <tbody>
                            {nodes.slice(0, 100).map((node: any, idx: number) => (
                              <tr key={idx}>
                                <td className="font-mono text-accent">{node['@id']}</td>
                                <td><span className="type-badge">{node['@type']}</span></td>
                                <td className="font-semibold">{node.label || node['skos:prefLabel'] || '-'}</td>
                                <td className="text-xs">{Object.keys(node).filter(k => !k.startsWith('@') && k !== 'label').slice(0, 3).join(', ')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  }
                  
                  return (
                    <div className="empty-state">
                      <FiDatabase className="empty-icon" />
                      <div className="empty-text">No data available for this phase</div>
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      <motion.button 
        className="upload-fab" 
        onClick={() => setUploadOpen(true)}
        initial={{ scale: 0, rotate: -180, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ delay: 0.6, type: "spring", stiffness: 200 }}
        whileHover={{ scale: 1.1, boxShadow: "0 8px 40px rgba(96, 165, 250, 0.6)" }}
        whileTap={{ scale: 0.9 }}
      >
        <motion.div
          animate={{ rotate: uploadOpen ? 45 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <FiUpload />
        </motion.div>
      </motion.button>

      <AnimatePresence>
        {uploadOpen && (
          <motion.div 
            className="modal-overlay" 
            onClick={() => setUploadOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div 
              className="modal-content" 
              onClick={e => e.stopPropagation()}
              initial={{ scale: 0.9, y: 20, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.9, y: 20, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
              <motion.div 
                className="modal-title"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                Upload Documents
              </motion.div>

              <div className="modal-body">
                <div className="upload-area" onClick={() => document.getElementById('file-input')?.click()}>
                  <div className="upload-icon"><FiUpload /></div>
                  <div className="upload-text">Click to select files</div>
                </div>

                <input
                  id="file-input"
                  type="file"
                  multiple
                  className="file-input"
                  accept=".pdf,.xlsx,.sql,.csv,.json,.txt"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    if (e.target.files) setFiles(Array.from(e.target.files))
                  }}
                />

                {files.length > 0 && (
                  <div className="upload-file-list-wrap">
                    <div className="upload-file-list-label">Selected files ({files.length})</div>
                    <div className="upload-file-list" role="list">
                      {files.map((f, i) => (
                        <div key={i} className="upload-file-item" role="listitem">
                          {f.name}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <motion.button 
                  className="btn btn-primary" 
                  onClick={uploadFiles} 
                  disabled={loading}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {loading ? 'Processing...' : 'Upload & Process'}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Toast */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            style={{
              position: 'fixed',
              bottom: '24px',
              right: '24px',
              maxWidth: '500px',
              background: '#dc2626',
              color: '#fff',
              padding: '16px 20px',
              borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(220,38,38,0.4)',
              zIndex: 9999,
              fontSize: '14px',
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
              <div>
                <strong style={{ fontSize: '15px' }}>Error</strong>
                <div style={{ marginTop: '4px', opacity: 0.95 }}>{error}</div>
              </div>
              <button
                onClick={() => setError(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#fff',
                  fontSize: '20px',
                  cursor: 'pointer',
                  padding: '0 4px',
                  lineHeight: '1',
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default App
