import { useEffect, useMemo, useState } from 'react'
import './App.css'

type ProcessedFile = {
  filename: string
  extension: string
  bytes: number
  parsed: boolean
  text_length: number
  warning?: string | null
}

type TaxonomySummary = {
  concept_count: number
  output_json: string
  output_skos_jsonld: string
}

type UploadResponse = {
  pipeline_mode: string
  accepted: number
  rejected: number
  files: ProcessedFile[]
  taxonomy?: TaxonomySummary | null
  stage_outputs?: {
    run_folder: string
    controlled_vocabulary_xlsx: string
    metadata_xlsx: string
    taxonomy_xlsx: string
    thesaurus_xlsx: string
    ontology_xlsx: string
    knowledge_graph_xlsx: string
  } | null
  ontogpt_output?: {
    run_folder: string
    knowledge_graph_jsonld: string
  } | null
}

type PipelineMode = 'current'
// type PipelineMode = 'current' | 'ontogpt'

const ACCEPTED_TYPES =
  '.xml,.pdf,.csv,.json,.xlsx,.txt,.md,.doc,.docx,.docs'

function App() {
  const [files, setFiles] = useState<File[]>([])
  const [outputBase, setOutputBase] = useState('company_taxonomy')
  const [pipelineMode, setPipelineMode] = useState<PipelineMode>('current')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<UploadResponse | null>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const totalBytes = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  )

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files ? Array.from(event.target.files) : []
    setFiles(selected)
    setResult(null)
    setError('')
    setToast('')
  }

  useEffect(() => {
    if (!toast) {
      return
    }

    const timer = window.setTimeout(() => setToast(''), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const uploadFiles = async () => {
    if (!files.length) {
      setToast('Please choose at least one file.')
      return
    }

    setLoading(true)
    setError('')

    try {
      const formData = new FormData()
      files.forEach((file) => formData.append('files', file))
      formData.append('output_base', outputBase)
      formData.append('pipeline_mode', pipelineMode)

      const response = await fetch('/api/v1/uploads/process', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        let message = 'Upload failed'
        try {
          const body = await response.json()
          message = body?.detail || JSON.stringify(body)
        } catch {
          const bodyText = await response.text()
          message = bodyText || message
        }
        throw new Error(message)
      }

      const data: UploadResponse = await response.json()
      setResult(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown upload error'
      setError(message)
      setToast(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="page">
      {toast && <div className="toast-error">{toast}</div>}
      <section className="panel">
        <header className="panel-header">
          <p className="eyebrow">Semantic Upload Console</p>
          <h1>Multi-Format Batch Upload</h1>
          <p className="subhead">
            Upload XML, PDF, CSV, JSON, XLSX, TXT, MD, DOC, and DOCX files together.
          </p>
        </header>

        <div className="field-block">
          <label htmlFor="file-upload">Select files</label>
          <input
            id="file-upload"
            type="file"
            multiple
            accept={ACCEPTED_TYPES}
            onChange={onFileChange}
          />
        </div>

        <div className="field-grid">
          <div className="field-block">
            <label htmlFor="output-base">Output base name</label>
            <input
              id="output-base"
              type="text"
              value={outputBase}
              onChange={(event) => setOutputBase(event.target.value)}
            />
          </div>

          <div className="field-block">
            <label>Pipeline mode</label>
            <div className="mode-switch" role="radiogroup" aria-label="Pipeline mode">
              <button
                type="button"
                className={pipelineMode === 'current' ? 'mode-button active' : 'mode-button'}
                onClick={() => setPipelineMode('current')}
              >
                Current Pipeline
              </button>
              {/*
              <button
                type="button"
                className={pipelineMode === 'ontogpt' ? 'mode-button active' : 'mode-button'}
                onClick={() => setPipelineMode('ontogpt')}
              >
                OntoGPT Mode
              </button>
              */}
            </div>
          </div>

        </div>

        <button
          type="button"
          className="upload-button"
          onClick={uploadFiles}
          disabled={loading}
        >
          {loading ? 'Processing files...' : 'Upload and Process'}
        </button>

        <section className="stats">
          <div>
            <strong>{files.length}</strong>
            <span>selected files</span>
          </div>
          <div>
            <strong>{(totalBytes / 1024).toFixed(1)} KB</strong>
            <span>total size</span>
          </div>
        </section>

        {files.length > 0 && (
          <section className="list-card">
            <h2>Selected Files</h2>
            <ul>
              {files.map((file) => (
                <li key={`${file.name}-${file.size}`}>
                  <span>{file.name}</span>
                  <small>{(file.size / 1024).toFixed(1)} KB</small>
                </li>
              ))}
            </ul>
          </section>
        )}

        {error && <p className="error-text">{error}</p>}

        {result && (
          <section className="list-card">
            <h2>Processing Result</h2>
            <p className="summary">
              Accepted: {result.accepted} | Rejected: {result.rejected}
            </p>
            <ul>
              {result.files.map((file) => (
                <li key={file.filename}>
                  <div>
                    <span>{file.filename}</span>
                    <small>
                      {file.parsed ? 'Parsed' : 'Failed'} · {file.text_length} chars
                    </small>
                  </div>
                  {file.warning ? <small>{file.warning}</small> : null}
                </li>
              ))}
            </ul>
            {result.pipeline_mode === 'current' && result.taxonomy && (
              <div className="taxonomy-box">
                <h3>Generated Taxonomy</h3>
                <p>Concepts: {result.taxonomy.concept_count}</p>
                <p>JSON: {result.taxonomy.output_json}</p>
                <p>SKOS: {result.taxonomy.output_skos_jsonld}</p>
              </div>
            )}
            {result.pipeline_mode === 'current' && result.stage_outputs && (
              <div className="taxonomy-box">
                <h3>Stage XLSX Outputs</h3>
                <p>Folder: {result.stage_outputs.run_folder}</p>
                <p>Controlled Vocabulary: {result.stage_outputs.controlled_vocabulary_xlsx}</p>
                <p>Metadata: {result.stage_outputs.metadata_xlsx}</p>
                <p>Taxonomy: {result.stage_outputs.taxonomy_xlsx}</p>
                <p>Thesaurus: {result.stage_outputs.thesaurus_xlsx}</p>
                <p>Ontology: {result.stage_outputs.ontology_xlsx}</p>
                <p>Knowledge Graph: {result.stage_outputs.knowledge_graph_xlsx}</p>
              </div>
            )}
            {/*
            {result.pipeline_mode === 'ontogpt' && result.ontogpt_output && (
              <div className="taxonomy-box">
                <h3>OntoGPT Output</h3>
                <p>Folder: {result.ontogpt_output.run_folder}</p>
                <p>JSON-LD: {result.ontogpt_output.knowledge_graph_jsonld}</p>
              </div>
            )}
            */}
          </section>
        )}
      </section>
    </main>
  )
}

export default App
