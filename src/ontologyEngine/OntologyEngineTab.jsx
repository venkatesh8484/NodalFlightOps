// ============================================
// OntologyEngine tab
// ============================================
// Stage 1 — upload files.
// Stage 2 — validate the configured AI provider key, then process every
//           file sequentially against the same growing six-phase pipeline
//           (one controlled vocabulary / taxonomy / thesaurus / ontology /
//           knowledge graph for the whole batch — "append mode").
// Stage 3 — each processed file gets an on-demand, in-window popup showing
//           the pipeline output as of that point in the sequence.

import React, { useRef, useState } from 'react';
import {
  Upload,
  Workflow,
  Eye,
  Download,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
  FileText,
  Trash2,
  KeyRound,
  Layers,
  RotateCcw,
  ChevronRight,
  UploadCloud,
} from 'lucide-react';
import { ALLOWED_EXTENSIONS, extractTextFromFile, getExtension } from './fileParsers';
import { runSixPhasePipeline, PIPELINE_STAGES, resetOntologyRegistry } from './pipeline';
import { downloadJson, downloadStageWorkbook } from './exporters';

let idCounter = 0;
const nextId = () => {
  idCounter += 1;
  return `oe-${idCounter}`;
};

const ACCEPT_ATTR = [...ALLOWED_EXTENSIONS].join(',');

const STATUS_META = {
  queued: { label: 'Queued', color: 'var(--muted-2)' },
  parsing: { label: 'Parsing file…', color: 'var(--agent)' },
  processing: { label: 'Processing…', color: 'var(--agent)' },
  done: { label: 'Done', color: 'var(--healthy)' },
  error: { label: 'Failed', color: 'var(--crit)' },
};

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ColumnHeader({ index, icon: Icon, label, active, done }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 14px',
        borderBottom: '1px solid var(--line)',
        background: active ? 'var(--agent-soft)' : done ? 'var(--healthy-soft)' : 'var(--surface-2)',
        flexShrink: 0,
        transition: 'background 200ms ease',
      }}
    >
      <span
        style={{
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          fontWeight: 700,
          flexShrink: 0,
          background: active ? 'var(--agent)' : done ? 'var(--healthy)' : 'var(--surface-3)',
          color: active || done ? '#fff' : 'var(--muted-2)',
        }}
      >
        {done ? <CheckCircle2 size={12} /> : index}
      </span>
      <Icon size={14} style={{ color: active ? 'var(--agent)' : done ? 'var(--healthy)' : 'var(--muted-2)', flexShrink: 0 }} />
      <span
        style={{
          fontSize: '12px',
          fontWeight: 700,
          color: 'var(--ink)',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        Stage {index} · {label}
      </span>
    </div>
  );
}

function FlowArrow({ active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '24px', flexShrink: 0 }}>
      <ChevronRight
        size={20}
        style={{
          color: active ? 'var(--agent)' : 'var(--line-strong)',
          animation: active ? 'oe-flow-pulse 1.1s ease-in-out infinite' : 'none',
          transition: 'color 200ms ease',
        }}
      />
    </div>
  );
}

function OutputTable({ columns, rows }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  background: 'var(--surface-2)',
                  borderBottom: '1px solid var(--line)',
                  color: 'var(--muted)',
                  fontWeight: 700,
                  position: 'sticky',
                  top: 0,
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} style={{ padding: '12px', color: 'var(--muted-2)' }}>
                No rows yet.
              </td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '7px 10px', color: 'var(--ink)', verticalAlign: 'top' }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutputModal({ isOpen, onClose, fileName, state, outputBase }) {
  const [section, setSection] = useState('vocabulary');
  if (!isOpen || !state) return null;

  const sections = [
    { key: 'vocabulary', label: `Controlled Vocabulary (${state.controlledVocab.length})` },
    { key: 'metadata', label: `Metadata Standard (${state.metadataStandard.length})` },
    { key: 'taxonomy', label: `Taxonomy (${state.taxonomy.length})` },
    { key: 'thesaurus', label: `Thesaurus (${state.thesaurus.length})` },
    { key: 'ontology', label: `Ontology (${state.ontology.Classes.length} classes)` },
    { key: 'graph', label: `Knowledge Graph (${state.knowledgeGraph['@graph'].length} nodes)` },
  ];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          borderRadius: '12px',
          width: 'min(920px, 95vw)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-lg)',
          fontFamily: 'var(--sans)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 20px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--ink)' }}>OntologyEngine Output</div>
            <div style={{ fontSize: '11.5px', color: 'var(--muted-2)' }}>
              Combined result through <strong>{fileName}</strong>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              onClick={() => downloadJson(`${outputBase}_combined.json`, state)}
              title="Download combined JSON"
              style={iconBtnStyle}
            >
              <Download size={14} /> JSON
            </button>
            <button
              onClick={() => downloadStageWorkbook(outputBase, state)}
              title="Download combined XLSX workbook"
              style={iconBtnStyle}
            >
              <Download size={14} /> XLSX
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-2)' }}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', padding: '10px 20px 0', flexWrap: 'wrap' }}>
          {sections.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              style={{
                padding: '6px 10px',
                fontSize: '11px',
                fontWeight: 600,
                borderRadius: '8px 8px 0 0',
                border: '1px solid var(--line)',
                borderBottom: section === s.key ? '1px solid var(--paper)' : '1px solid var(--line)',
                background: section === s.key ? 'var(--paper)' : 'var(--surface)',
                color: section === s.key ? 'var(--agent)' : 'var(--muted)',
                cursor: 'pointer',
                position: 'relative',
                top: '1px',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', borderTop: '1px solid var(--line)' }}>
          {state._meta?.truncated && (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'flex-start',
                padding: '9px 11px',
                marginBottom: '14px',
                borderRadius: '8px',
                background: 'var(--warn-soft)',
                border: '1px solid var(--warn-border)',
                fontSize: '11px',
                color: 'var(--warn)',
                lineHeight: 1.5,
              }}
            >
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>{state._meta.note}</span>
            </div>
          )}
          {section === 'vocabulary' && (
            <OutputTable
              columns={['Approved_Term', 'Aliases']}
              rows={state.controlledVocab.map((c) => [c.Approved_Term, c.Aliases.join(', ')])}
            />
          )}
          {section === 'metadata' && (
            <OutputTable
              columns={['Concept_ID', 'Preferred_Term_PT', 'Used_For_UF', 'Source', 'Status']}
              rows={state.metadataStandard.map((r) => [r.Concept_ID, r.Preferred_Term_PT, r.Used_For_UF.join(', '), r.Source || '—', r.Status])}
            />
          )}
          {section === 'taxonomy' && (
            <OutputTable
              columns={['Concept_ID', 'Preferred_Term_PT', 'Broader_Term_BT', 'Narrower_Term_NT']}
              rows={state.taxonomy.map((c) => [c.Concept_ID, c.Preferred_Term_PT, c.Broader_Term_BT.join(', '), c.Narrower_Term_NT.join(', ')])}
            />
          )}
          {section === 'thesaurus' && (
            <OutputTable
              columns={['Concept_ID', 'PT', 'UF', 'BT', 'NT', 'Related_Term_RT', 'Scope_Note_SN']}
              rows={state.thesaurus.map((r) => [r.Concept_ID, r.PT, r.UF.join(', '), r.BT.join(', '), r.NT.join(', '), r.Related_Term_RT.join(', '), r.Scope_Note_SN])}
            />
          )}
          {section === 'ontology' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <OutputTable columns={['Class']} rows={state.ontology.Classes.map((c) => [String(c)])} />
              <OutputTable
                columns={['Verb', 'Domain', 'Range']}
                rows={state.ontology.Object_Properties.map((p) => [p.Verb, p.Domain, p.Range])}
              />
              {state.ontology.Concept_Class_Map?.length > 0 && (
                <OutputTable
                  columns={['Concept_ID', 'Preferred_Term_PT', 'Class']}
                  rows={state.ontology.Concept_Class_Map.map((r) => [
                    r.Concept_ID,
                    state.metadataStandard.find((m) => m.Concept_ID === r.Concept_ID)?.Preferred_Term_PT || r.Concept_ID,
                    r.Class,
                  ])}
                />
              )}
            </div>
          )}
          {section === 'graph' && (
            <pre
              style={{
                background: 'var(--surface-2)',
                padding: '12px',
                borderRadius: 'var(--radius-md)',
                fontSize: '11px',
                fontFamily: 'var(--mono)',
                overflowX: 'auto',
                margin: 0,
              }}
            >
              {JSON.stringify(state.knowledgeGraph, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 10px',
  fontSize: '11px',
  fontWeight: 600,
  border: '1px solid var(--line)',
  borderRadius: '8px',
  background: 'var(--surface)',
  color: 'var(--ink)',
  cursor: 'pointer',
};

export default function OntologyEngineTab({ aiConfig, onOpenSettings }) {
  const [pendingFiles, setPendingFiles] = useState([]);
  const [runFiles, setRunFiles] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [outputBase, setOutputBase] = useState('flightops_ontology');
  const [modalFileId, setModalFileId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // Publish-to-app status: the artifacts on disk under src/data/ are what the
  // Explorer and Chat tabs import, so publishing is what makes the running app's
  // semantic layer come from THIS engine run rather than from checked-in JSON.
  const [publishState, setPublishState] = useState({ status: 'idle', message: null });

  const cumulativeTextRef = useRef('');
  const previousStateRef = useRef(null);
  const fileInputRef = useRef(null);

  const hasApiKey = Boolean(aiConfig?.apiKey);
  const anyDone = runFiles.some((f) => f.status === 'done');
  const latestState = [...runFiles].reverse().find((f) => f.status === 'done')?.state || null;

  const stage1Active = pendingFiles.length === 0 && runFiles.length === 0;
  const stage2Active = isRunning;
  const stage3Active = !isRunning && anyDone;

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    const valid = [];
    for (const file of incoming) {
      if (!ALLOWED_EXTENSIONS.has(getExtension(file.name))) continue;
      valid.push(file);
    }
    setPendingFiles((prev) => [...prev, ...valid]);
  }

  function removePending(index) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function startProcessing() {
    if (!hasApiKey) return;
    if (!pendingFiles.length) return;

    const queued = pendingFiles.map((file) => ({
      id: nextId(),
      file,
      name: file.name,
      size: file.size,
      status: 'queued',
      phase: null,
      warning: null,
      error: null,
      state: null,
    }));

    setPendingFiles([]);
    setRunFiles((prev) => [...prev, ...queued]);
    setIsRunning(true);

    for (const entry of queued) {
      setRunFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: 'parsing' } : f)));

      const { text, warning } = await extractTextFromFile(entry.file);

      if (!text.trim()) {
        setRunFiles((prev) =>
          prev.map((f) =>
            f.id === entry.id ? { ...f, status: 'error', warning, error: warning || 'No extractable text' } : f
          )
        );
        continue;
      }

      const candidateText = cumulativeTextRef.current
        ? `${cumulativeTextRef.current}\n\n${text}`
        : text;

      setRunFiles((prev) =>
        prev.map((f) => (f.id === entry.id ? { ...f, status: 'processing', warning, phase: PIPELINE_STAGES[0].key } : f))
      );

      try {
        const state = await runSixPhasePipeline(
          candidateText,
          aiConfig,
          (phaseKey) => {
            setRunFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, phase: phaseKey } : f)));
          },
          previousStateRef.current
        );

        cumulativeTextRef.current = candidateText;
        previousStateRef.current = state;

        setRunFiles((prev) =>
          prev.map((f) => (f.id === entry.id ? { ...f, status: 'done', phase: null, state } : f))
        );
      } catch (err) {
        setRunFiles((prev) =>
          prev.map((f) =>
            f.id === entry.id ? { ...f, status: 'error', phase: null, error: err?.message || String(err) } : f
          )
        );
      }
    }

    setIsRunning(false);
  }

  /**
   * Persist the six pipeline artifacts to src/data/01..06*.json via the dev
   * server's /api/ontology-writeback endpoint (see vite-plugin-flightops-writeback.js).
   * Those are the exact files ExplorerTab and ChatTab import, so after a publish
   * + reload the whole app is driven by the ontology this engine just produced.
   *
   * Dev-server only: in a production build there is no writeback endpoint, so the
   * download buttons in the output modal remain the export path.
   */
  async function publishToApp() {
    if (!latestState) return;
    setPublishState({ status: 'publishing', message: null });

    try {
      const response = await fetch('/api/ontology-writeback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          controlledVocab: latestState.controlledVocab,
          metadataStandard: latestState.metadataStandard,
          taxonomy: latestState.taxonomy,
          thesaurus: latestState.thesaurus,
          ontology: latestState.ontology,
          knowledgeGraph: latestState.knowledgeGraph,
          outputBase,
          runMeta: latestState._meta || null,
          sourceFiles: runFiles.filter((f) => f.status === 'done').map((f) => f.name),
        }),
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        // Vite serves index.html for unknown paths in a production preview —
        // a non-JSON response means the writeback plugin is not running.
        throw new Error('Writeback endpoint not available (dev server only). Use the download buttons instead.');
      }

      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);

      const files = (result.written || []).map((w) => w.file).join(', ');
      setPublishState({
        status: 'done',
        message: `Published ${result.written.length} artifact(s) to src/data/ (${files}). Reload the app to see Explorer and Chat rebuilt from them.`,
      });
    } catch (err) {
      setPublishState({ status: 'error', message: err?.message || String(err) });
    }
  }

  function resetSession() {
    setPendingFiles([]);
    setRunFiles([]);
    setIsRunning(false);
    cumulativeTextRef.current = '';
    previousStateRef.current = null;
    setModalFileId(null);
    setPublishState({ status: 'idle', message: null });
    resetOntologyRegistry();
  }

  const modalEntry = runFiles.find((f) => f.id === modalFileId);

  return (
    <div style={{ padding: '20px 28px', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes oe-flow-pulse {
          0%, 100% { opacity: 0.35; transform: translateX(0); }
          50% { opacity: 1; transform: translateX(3px); }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Workflow size={20} style={{ color: 'var(--agent)' }} />
          <div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--ink)' }}>OntologyEngine</div>
            <div style={{ fontSize: '11.5px', color: 'var(--muted-2)' }}>
              Upload documents to build one growing controlled vocabulary, taxonomy, thesaurus, ontology and
              knowledge graph — powered by the AI provider configured in Settings.
            </div>
          </div>
        </div>
        <button onClick={resetSession} style={iconBtnStyle} title="Clear session and start over">
          <RotateCcw size={13} /> Reset session
        </button>
      </div>

      {/* LEFT-TO-RIGHT PIPELINE */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: '2px', flex: 1, minHeight: 0 }}>

        {/* STAGE 1 — File Upload */}
        <div style={{ ...columnStyle, flex: 1 }}>
          <ColumnHeader index={1} icon={FileText} label="File Upload" active={stage1Active} done={runFiles.length > 0} />
          <div style={columnBodyStyle}>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? 'var(--agent)' : 'var(--line-strong)'}`,
                borderRadius: 'var(--radius-md)',
                padding: '18px 12px',
                textAlign: 'center',
                cursor: 'pointer',
                background: dragOver ? 'var(--agent-soft)' : 'var(--surface)',
                transition: 'all 150ms ease',
                flexShrink: 0,
              }}
            >
              <Upload size={20} style={{ color: 'var(--agent)', marginBottom: '6px' }} />
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>
                Drop files, or click to browse
              </div>
              <div style={{ fontSize: '10.5px', color: 'var(--muted-2)', marginTop: '2px' }}>
                {[...ALLOWED_EXTENSIONS].join(', ')}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTR}
                onChange={(e) => addFiles(e.target.files)}
                style={{ display: 'none' }}
              />
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {pendingFiles.length === 0 && (
                <div style={{ fontSize: '11px', color: 'var(--muted-2)', textAlign: 'center', padding: '10px 0' }}>
                  No files queued yet.
                </div>
              )}
              {pendingFiles.map((file, i) => (
                <div key={`${file.name}-${i}`} style={pendingRowStyle}>
                  <span style={{ fontSize: '11.5px', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.name}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                    <small style={{ color: 'var(--muted-2)' }}>{formatBytes(file.size)}</small>
                    <button onClick={() => removePending(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--crit)' }}>
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
              <input
                type="text"
                value={outputBase}
                onChange={(e) => setOutputBase(e.target.value)}
                placeholder="Output name"
                style={{
                  padding: '7px 10px',
                  fontSize: '12px',
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--mono)',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
              <button
                onClick={startProcessing}
                disabled={isRunning || pendingFiles.length === 0}
                style={{
                  padding: '9px 14px',
                  fontSize: '12.5px',
                  fontWeight: 700,
                  border: 'none',
                  borderRadius: '8px',
                  background: isRunning || pendingFiles.length === 0 ? 'var(--surface-3)' : 'var(--agent)',
                  color: isRunning || pendingFiles.length === 0 ? 'var(--muted-2)' : '#fff',
                  cursor: isRunning || pendingFiles.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                }}
              >
                {isRunning ? 'Processing…' : `Process ${pendingFiles.length || ''} file${pendingFiles.length === 1 ? '' : 's'}`.trim()}
              </button>
            </div>
          </div>
        </div>

        <FlowArrow active={pendingFiles.length > 0 || isRunning} />

        {/* STAGE 2 — Validate & Process */}
        <div style={{ ...columnStyle, flex: 1.4 }}>
          <ColumnHeader index={2} icon={KeyRound} label="Validate & Process" active={stage2Active} done={!isRunning && runFiles.length > 0} />
          <div style={columnBodyStyle}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '9px 11px',
                borderRadius: '8px',
                flexShrink: 0,
                background: hasApiKey ? 'var(--healthy-soft)' : 'var(--warn-soft)',
                border: `1px solid ${hasApiKey ? 'var(--healthy-border)' : 'var(--warn-border)'}`,
                fontSize: '11px',
              }}
            >
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: hasApiKey ? 'var(--healthy)' : 'var(--warn)',
                }}
              />
              <span style={{ color: hasApiKey ? 'var(--healthy)' : 'var(--warn)', fontWeight: 600, flex: 1 }}>
                {hasApiKey
                  ? `${aiConfig.provider.charAt(0).toUpperCase() + aiConfig.provider.slice(1)} key detected — ready.`
                  : 'No API key configured.'}
              </span>
              {!hasApiKey && (
                <button onClick={onOpenSettings} style={{ ...iconBtnStyle, flexShrink: 0 }}>
                  <KeyRound size={12} /> Settings
                </button>
              )}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {runFiles.length === 0 ? (
                <div style={{ fontSize: '11px', color: 'var(--muted-2)', textAlign: 'center', padding: '10px 0' }}>
                  No files processed yet.
                </div>
              ) : (
                runFiles.map((f) => {
                  const meta = STATUS_META[f.status];
                  const phaseLabel = f.phase ? PIPELINE_STAGES.find((s) => s.key === f.phase)?.label : null;
                  return (
                    <div key={f.id} style={fileRowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        {f.status === 'parsing' || f.status === 'processing' ? (
                          <Loader2 size={14} className="spin-animation" style={{ color: 'var(--agent)', flexShrink: 0 }} />
                        ) : f.status === 'done' ? (
                          <CheckCircle2 size={14} style={{ color: 'var(--healthy)', flexShrink: 0 }} />
                        ) : f.status === 'error' ? (
                          <AlertTriangle size={14} style={{ color: 'var(--crit)', flexShrink: 0 }} />
                        ) : (
                          <FileText size={14} style={{ color: 'var(--muted-2)', flexShrink: 0 }} />
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {f.name}
                          </div>
                          <div style={{ fontSize: '10px', color: meta.color }}>
                            {meta.label}
                            {phaseLabel ? ` — ${phaseLabel}` : ''}
                            {f.error ? ` — ${f.error}` : ''}
                            {f.warning && f.status === 'done' ? ` — ${f.warning}` : ''}
                          </div>
                        </div>
                      </div>

                      {f.status === 'done' && (
                        <button onClick={() => setModalFileId(f.id)} style={{ ...iconBtnStyle, flexShrink: 0 }}>
                          <Eye size={12} /> View
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <FlowArrow active={anyDone} />

        {/* STAGE 3 — Output */}
        <div style={{ ...columnStyle, flex: 1, opacity: anyDone ? 1 : 0.55, transition: 'opacity 250ms ease' }}>
          <ColumnHeader index={3} icon={Layers} label="View Output" active={stage3Active} done={false} />
          <div style={{ ...columnBodyStyle, justifyContent: anyDone ? 'flex-start' : 'center', alignItems: anyDone ? 'stretch' : 'center' }}>
            {!anyDone ? (
              <div style={{ fontSize: '11px', color: 'var(--muted-2)', textAlign: 'center' }}>
                Output appears here once a file finishes processing.
              </div>
            ) : (
              <>
                <div style={{ fontSize: '11.5px', color: 'var(--muted)', lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--ink)' }}>{latestState?.controlledVocab.length ?? 0}</strong> concepts
                  <br />
                  <strong style={{ color: 'var(--ink)' }}>{latestState?.ontology.Object_Properties.length ?? 0}</strong> object properties
                  <br />
                  <strong style={{ color: 'var(--ink)' }}>{latestState?.knowledgeGraph['@graph'].length ?? 0}</strong> graph nodes
                  <br />
                  across <strong style={{ color: 'var(--ink)' }}>{runFiles.filter((f) => f.status === 'done').length}</strong> file(s)
                </div>
                <button
                  onClick={() => setModalFileId(runFiles.filter((f) => f.status === 'done').slice(-1)[0]?.id)}
                  style={{ ...iconBtnStyle, background: 'var(--agent)', color: '#fff', border: 'none', justifyContent: 'center' }}
                >
                  <Eye size={13} /> View Latest Combined Output
                </button>

                {/* Publish — writes the six artifacts into src/data/, which is what
                    the Explorer and Chat tabs import. Without this step the engine's
                    output only ever leaves as a download. */}
                <button
                  onClick={publishToApp}
                  disabled={publishState.status === 'publishing'}
                  style={{
                    ...iconBtnStyle,
                    justifyContent: 'center',
                    background: publishState.status === 'done' ? 'var(--healthy-soft)' : 'var(--surface)',
                    borderColor: publishState.status === 'done' ? 'var(--healthy-border)' : 'var(--line-strong)',
                    color: publishState.status === 'done' ? 'var(--healthy)' : 'var(--ink)',
                    cursor: publishState.status === 'publishing' ? 'wait' : 'pointer',
                  }}
                  title="Write the six artifacts to src/data/01..06*.json so the Explorer and Chat tabs use this ontology"
                >
                  {publishState.status === 'publishing' ? (
                    <Loader2 size={13} className="spin-animation" />
                  ) : publishState.status === 'done' ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <UploadCloud size={13} />
                  )}
                  {publishState.status === 'publishing'
                    ? 'Publishing…'
                    : publishState.status === 'done'
                      ? 'Published to app'
                      : 'Publish to FlightOps app'}
                </button>

                {publishState.message && (
                  <div
                    style={{
                      fontSize: '10.5px',
                      lineHeight: 1.5,
                      padding: '8px 10px',
                      borderRadius: '8px',
                      background: publishState.status === 'error' ? 'var(--crit-soft)' : 'var(--healthy-soft)',
                      border: `1px solid ${publishState.status === 'error' ? 'var(--crit-border)' : 'var(--healthy-border)'}`,
                      color: publishState.status === 'error' ? 'var(--crit)' : 'var(--healthy)',
                    }}
                  >
                    {publishState.message}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <OutputModal
        isOpen={Boolean(modalEntry)}
        onClose={() => setModalFileId(null)}
        fileName={modalEntry?.name}
        state={modalEntry?.state}
        outputBase={outputBase}
      />
    </div>
  );
}
const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--paper)',
  minWidth: 0,
  overflow: 'hidden',
};

const columnBodyStyle = {
  padding: '14px',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  overflow: 'hidden',
};

const pendingRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 10px',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  background: 'var(--surface)',
};

const fileRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '9px 12px',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  background: 'var(--surface)',
  gap: '12px',
};
