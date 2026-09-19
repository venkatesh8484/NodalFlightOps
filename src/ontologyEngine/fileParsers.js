// ============================================
// OntologyEngine — in-browser file text extraction
// ============================================
// Client-side port of the original backend's file_parser.py (and, for .sql,
// Ontology-SAS's data_extractor._extract_sql). Every uploaded file is turned
// into plain text here, in the browser, before it goes into the six-phase
// pipeline. No file ever leaves the machine except in the AI prompt payload
// sent to the configured provider.

import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export const ALLOWED_EXTENSIONS = new Set([
  '.xml',
  '.pdf',
  '.csv',
  '.json',
  '.xlsx',
  '.sql',
  '.txt',
  '.md',
  '.doc',
  '.docx',
  '.docs',
]);

export function getExtension(filename) {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx).toLowerCase();
}

// Minimal RFC4180-ish CSV parser (handles quoted fields with embedded commas/newlines).
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function decodeText(buf) {
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

// PDFs (and occasionally other formats) built with subsetted/custom fonts can
// yield glyphs with no usable Unicode mapping. pdf.js then emits raw control
// characters (commonly U+0000) or, for a broken surrogate pair, a lone
// high/low surrogate half in the extracted text. Those are syntactically
// legal inside a JS string and inside the JSON we build from it, but Gemini's
// generateContent endpoint rejects a request whose text contains them with a
// bare "400 Request contains an invalid argument" — no detail on which
// character. Strip C0/C1 control characters (keeping \n and \t) and any
// unpaired surrogate before this text is ever used in an AI prompt.
function sanitizeText(text) {
  if (!text) return text;
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, (m) => m.slice(0, -1))
    .replace(/[ \t]{2,}/g, ' ');
}

// Ported from Ontology-SAS's data_extractor._extract_sql: pulls table names,
// column names, and foreign-key relationships out of SQL DDL deterministically
// (no AI call needed for this file type).
function extractSqlSchema(text) {
  const createBlocks = text.match(/CREATE\s+TABLE\s+[\s\S]*?;/gi) || [];
  const alterFkBlocks =
    text.match(/ALTER\s+TABLE\s+[\s\S]*?FOREIGN\s+KEY\s*\([\s\S]*?\)\s*REFERENCES\s+[\s\S]*?;/gi) || [];

  const lines = ['SQL Schema Summary:'];
  let tableCount = 0;

  for (const block of createBlocks) {
    const tableMatch = block.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.]+)[`"\]]?/i);
    if (!tableMatch) continue;
    tableCount += 1;
    lines.push(`Table: ${tableMatch[1]}`);

    const bodyMatch = block.match(/\(([\s\S]*)\)/);
    if (!bodyMatch) continue;
    const body = bodyMatch[1];

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line) continue;
      const upper = line.toUpperCase();

      if (upper.includes('FOREIGN KEY') && upper.includes('REFERENCES')) {
        const fkMatch = line.match(
          /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"[]?([\w.]+)[`"\]]?\s*\(([^)]+)\)/i
        );
        if (fkMatch) {
          lines.push(`  FK: (${fkMatch[1].trim()}) -> ${fkMatch[2].trim()}(${fkMatch[3].trim()})`);
        }
        continue;
      }

      if (/^(PRIMARY KEY|UNIQUE|INDEX|KEY|CONSTRAINT|CHECK)/.test(upper)) continue;

      const colMatch = line.match(/^[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s+(.+)/);
      if (colMatch) {
        lines.push(`  Column: ${colMatch[1]} (${colMatch[2].split(/\s+/)[0]})`);
      }
    }
  }

  for (const block of alterFkBlocks) {
    const alterMatch = block.match(
      /ALTER\s+TABLE\s+[`"[]?([\w.]+)[`"\]]?[\s\S]*?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"[]?([\w.]+)[`"\]]?\s*\(([^)]+)\)/i
    );
    if (alterMatch) {
      lines.push(
        `FK (ALTER): ${alterMatch[1].trim()}(${alterMatch[2].trim()}) -> ${alterMatch[3].trim()}(${alterMatch[4].trim()})`
      );
    }
  }

  if (tableCount === 0) return 'SQL Schema Summary:\nNo CREATE TABLE statements found.';
  return lines.join('\n');
}

/**
 * Format-dispatching extraction, unsanitized. Returns { text, warning }.
 * Call extractTextFromFile (below) instead — this is wrapped there so the
 * result always gets sanitizeText() applied before it reaches an AI prompt.
 */
async function extractTextFromFileRaw(file) {
  const ext = getExtension(file.name);

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { text: '', warning: 'Unsupported extension' };
  }

  try {
    if (['.txt', '.md', '.doc', '.docs'].includes(ext)) {
      const buf = await file.arrayBuffer();
      return { text: decodeText(buf), warning: null };
    }

    if (ext === '.json') {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      return { text: JSON.stringify(parsed, null, 2), warning: null };
    }

    if (ext === '.xml') {
      const raw = await file.text();
      const doc = new DOMParser().parseFromString(raw, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
      const chunks = [];
      const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const v = node.nodeValue?.trim();
        if (v) chunks.push(v);
        node = walker.nextNode();
      }
      return { text: chunks.join('\n'), warning: null };
    }

    if (ext === '.csv') {
      const raw = await file.text();
      const rows = parseCsvText(raw);
      return { text: rows.map((r) => r.join(' | ')).join('\n'), warning: null };
    }

    if (ext === '.sql') {
      const raw = await file.text();
      return { text: extractSqlSchema(raw), warning: null };
    }

    if (ext === '.xlsx') {
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const parts = [];
        wb.SheetNames.forEach((name) => {
          parts.push(`Sheet: ${name}`);
          const sheet = wb.Sheets[name];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
          rows.forEach((row) => {
            const values = row.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
            if (values.length) parts.push(values.map(String).join(' | '));
          });
        });
        return { text: parts.join('\n'), warning: null };
      } catch {
        const buf = await file.arrayBuffer();
        return { text: decodeText(buf), warning: 'XLSX parser fallback used' };
      }
    }

    if (ext === '.docx') {
      try {
        const buf = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: buf });
        return { text: result.value.trim(), warning: null };
      } catch {
        const buf = await file.arrayBuffer();
        return { text: decodeText(buf), warning: 'DOCX parser fallback used' };
      }
    }

    if (ext === '.pdf') {
      const buf = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      const pageTexts = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pageTexts.push(content.items.map((it) => it.str || '').join(' '));
      }
      return { text: pageTexts.join(' ').trim(), warning: null };
    }

    return { text: '', warning: 'Unsupported extension for parser' };
  } catch (err) {
    return { text: '', warning: `Parse failed: ${err.message || err}` };
  }
}

/**
 * Extract plain text from an uploaded File. Returns { text, warning }.
 * warning is null on a clean parse, or a short human-readable note
 * (mirrors ProcessedFile.warning from the original API).
 *
 * Thin wrapper around extractTextFromFileRaw that sanitizes the extracted
 * text so control characters / broken surrogates picked up from a file
 * (most commonly a PDF with subsetted fonts) never reach an AI provider —
 * see sanitizeText above.
 */
export async function extractTextFromFile(file) {
  const result = await extractTextFromFileRaw(file);
  return { text: sanitizeText(result.text), warning: result.warning };
}
