// ============================================
// OntologyEngine — client-side output exporters
// ============================================
// Download helpers for the pipeline output: per-stage JSON files and a single
// combined XLSX workbook (one sheet per stage), built entirely in the browser
// with SheetJS — mirrors stage_xlsx_export.py's sheet layout.

import * as XLSX from 'xlsx';

function safeRow(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);
}

export function downloadStageWorkbook(outputBase, state) {
  const wb = XLSX.utils.book_new();

  const vocabRows = [['Approved_Term', 'Aliases']].concat(
    (state.controlledVocab || []).map((c) => [c.Approved_Term, safeRow(c.Aliases)])
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(vocabRows), 'Controlled Vocabulary');

  const metaRows = [['Concept_ID', 'Preferred_Term_PT', 'Used_For_UF', 'Source', 'First_Seen_Run', 'Status']].concat(
    (state.metadataStandard || []).map((r) => [
      r.Concept_ID,
      r.Preferred_Term_PT,
      safeRow(r.Used_For_UF),
      safeRow(r.Source),
      safeRow(r.First_Seen_Run),
      r.Status,
    ])
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(metaRows), 'Metadata Standard');

  const taxRows = [['Concept_ID', 'Preferred_Term_PT', 'Broader_Term_BT', 'Narrower_Term_NT']].concat(
    (state.taxonomy || []).map((c) => [
      c.Concept_ID,
      c.Preferred_Term_PT,
      safeRow(c.Broader_Term_BT),
      safeRow(c.Narrower_Term_NT),
    ])
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(taxRows), 'Taxonomy');

  const thesRows = [['Concept_ID', 'PT', 'UF', 'BT', 'NT', 'Related_Term_RT', 'Scope_Note_SN']].concat(
    (state.thesaurus || []).map((r) => [
      r.Concept_ID,
      r.PT,
      safeRow(r.UF),
      safeRow(r.BT),
      safeRow(r.NT),
      safeRow(r.Related_Term_RT),
      r.Scope_Note_SN,
    ])
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(thesRows), 'Thesaurus');

  const classRows = [['Class']].concat((state.ontology?.Classes || []).map((c) => [String(c)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(classRows), 'Ontology Classes');

  const propRows = [['Verb', 'Domain', 'Range']].concat(
    (state.ontology?.Object_Properties || []).map((p) => [p.Verb, p.Domain, p.Range])
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(propRows), 'Object Properties');

  const metaById = new Map((state.metadataStandard || []).map((m) => [m.Concept_ID, m.Preferred_Term_PT]));
  const classMapRows = [['Concept_ID', 'Preferred_Term_PT', 'Class']].concat(
    (state.ontology?.Concept_Class_Map || []).map((r) => [r.Concept_ID, metaById.get(r.Concept_ID) || r.Concept_ID, r.Class])
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(classMapRows), 'Concept Class Map');

  const graphRows = [['@id', '@type', 'properties']].concat(
    (state.knowledgeGraph?.['@graph'] || []).map((node) => {
      const { '@id': id, '@type': type, ...rest } = node;
      return [id, type, JSON.stringify(rest)];
    })
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(graphRows), 'Knowledge Graph');

  XLSX.writeFile(wb, `${outputBase || 'ontology'}_stages.xlsx`);
}
