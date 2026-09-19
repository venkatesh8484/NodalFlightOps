"""
Unified Data Extraction Module
================================
All source-file parsing + text processing logic lives here.
One file to debug all data extraction issues.

Functions:
  - extract_from_file(filename, raw_bytes) -> (full_text, noun_text)
  - merge_extractions(results) -> (merged_full, merged_nouns)
  - smart_chunk(text, chunk_size, overlap) -> list[str]
"""

import csv
import io
import json
import re
import xml.etree.ElementTree as ET

import fitz
from openpyxl import load_workbook
from docx import Document

# ──────────────────────────────────────────────
# NLTK POS Tags
# ──────────────────────────────────────────────
_NOUN_TAGS = {"NN", "NNS", "NNP", "NNPS"}
_VERB_TAGS = {"VB", "VBD", "VBG", "VBN", "VBP", "VBZ"}


def _ensure_nltk_data():
    try:
        import nltk
        nltk.data.find('taggers/averaged_perceptron_tagger_eng')
        nltk.data.find('tokenizers/punkt_tab')
    except LookupError:
        import nltk
        nltk.download('averaged_perceptron_tagger_eng', quiet=True)
        nltk.download('punkt_tab', quiet=True)


# ──────────────────────────────────────────────
# Text Processing (Noun extraction)
# ──────────────────────────────────────────────
def extract_nouns(text: str) -> str:
    """Extract only nouns from text using nltk POS tagging on full sentences."""
    try:
        from nltk import word_tokenize, pos_tag
        from nltk.tokenize import sent_tokenize
        _ensure_nltk_data()

        # POS tag full sentences for better accuracy, not line fragments
        all_nouns = []
        sentences = sent_tokenize(text)
        for sentence in sentences:
            tokens = word_tokenize(sentence)
            pos_tags = pos_tag(tokens)
            nouns = [word for word, tag in pos_tags
                     if tag in _NOUN_TAGS and _is_valid_noun(word)]
            all_nouns.extend(nouns)

        # Deduplicate while preserving order
        seen = set()
        unique_nouns = []
        for noun in all_nouns:
            key = noun.lower()
            if key not in seen:
                seen.add(key)
                unique_nouns.append(noun)

        return " ".join(unique_nouns)
    except Exception as e:
        print(f"[data_extractor] Warning: noun extraction failed, returning original. Error: {e}")
        return text


def _is_valid_noun(word: str) -> bool:
    """Filter out punctuation, symbols, and junk that NLTK misclassifies as nouns."""
    if len(word) < 2:
        return False
    # Must contain at least one letter
    if not any(c.isalpha() for c in word):
        return False
    # Skip pure punctuation/symbols
    if word in {"—", "–", "-", "·", "•", "/", "%", ">>", "<<", "..."}:
        return False
    return True


# ──────────────────────────────────────────────
# Smart Chunking
# ──────────────────────────────────────────────
def smart_chunk(text: str, chunk_size: int = 50000, overlap: int = 5000) -> list[str]:
    """Split text into chunks at paragraph boundaries with overlap."""
    if len(text) <= chunk_size:
        return [text]

    paragraphs = text.split("\n")
    chunks = []
    current_chunk = ""

    for para in paragraphs:
        if len(current_chunk) + len(para) + 1 > chunk_size and current_chunk:
            chunks.append(current_chunk)
            overlap_buffer = current_chunk[-overlap:] if len(current_chunk) > overlap else current_chunk
            current_chunk = overlap_buffer + "\n" + para
        else:
            current_chunk = current_chunk + "\n" + para if current_chunk else para

    if current_chunk.strip():
        chunks.append(current_chunk)

    return chunks


# ──────────────────────────────────────────────
# Byte Decoding
# ──────────────────────────────────────────────
def _decode_bytes(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="ignore")


# ──────────────────────────────────────────────
# PDF Extraction
# ──────────────────────────────────────────────
def _extract_pdf(raw: bytes) -> str:
    """Extract all text from a PDF."""
    doc = fitz.open(stream=raw, filetype="pdf")
    text = " ".join(page.get_text("text") for page in doc)
    return text.strip()


# ──────────────────────────────────────────────
# DOCX Extraction
# ──────────────────────────────────────────────
def _extract_docx(raw: bytes) -> str:
    """Extract paragraph text from a DOCX."""
    document = Document(io.BytesIO(raw))
    lines = [p.text.strip() for p in document.paragraphs if p.text.strip()]
    return "\n".join(lines)


# ──────────────────────────────────────────────
# Plain Text Extraction
# ──────────────────────────────────────────────
def _extract_plain_text(raw: bytes) -> str:
    """Extract text from .txt, .md, .doc, .docs files."""
    return _decode_bytes(raw)


# ──────────────────────────────────────────────
# JSON Extraction
# ──────────────────────────────────────────────
def _extract_json(raw: bytes) -> str:
    """Pretty-print JSON content."""
    parsed = json.loads(_decode_bytes(raw))
    return json.dumps(parsed, indent=2)


# ──────────────────────────────────────────────
# XML Extraction
# ──────────────────────────────────────────────
def _extract_xml(raw: bytes) -> str:
    """Extract all text nodes from XML."""
    root = ET.fromstring(raw)
    text_chunks = []
    for elem in root.iter():
        if elem.text and elem.text.strip():
            text_chunks.append(elem.text.strip())
    return "\n".join(text_chunks)


# ──────────────────────────────────────────────
# CSV Extraction (deterministic: headers only)
# ──────────────────────────────────────────────
def _extract_csv(raw: bytes) -> str:
    """Extract only the first row (headers/column names) from CSV deterministically."""
    text = _decode_bytes(raw)
    reader = csv.reader(io.StringIO(text))
    rows = [row for row in reader if any(str(cell).strip() for cell in row)]
    if not rows:
        return "CSV: No rows found."

    headers = [str(h).strip() for h in rows[0] if str(h).strip()]
    lines = ["CSV Column Headers:"]
    for h in headers:
        lines.append(f"- {h}")
    return "\n".join(lines)


# ──────────────────────────────────────────────
# XLSX Extraction (deterministic: headers only)
# ──────────────────────────────────────────────
def _extract_xlsx(raw: bytes) -> str:
    """Extract only the first row (headers/column names) from each XLSX sheet deterministically."""
    # Try XLSX (new format) first, fall back to XLS (old Excel 97-2003)
    try:
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        parts = []
        for sheet in wb.worksheets:
            headers = []
            for row in sheet.iter_rows(max_row=1, values_only=True):
                headers = [str(v).strip() for v in row if v is not None and str(v).strip()]
                break

            if not headers:
                continue

            lines = [f"XLSX Sheet '{sheet.title}' Column Headers:"]
            for h in headers:
                lines.append(f"- {h}")
            parts.append("\n".join(lines))

        if not parts:
            return "XLSX: No readable sheets found."
        return "\n\n".join(parts)
    except Exception:
        # Fallback: try reading as old XLS format (Excel 97-2003)
        return _extract_xls(raw)


def _extract_xls(raw: bytes) -> str:
    """Extract first row (headers) from old XLS (Excel 97-2003) format."""
    import xlrd
    wb = xlrd.open_workbook(file_contents=raw)
    parts = []
    for sheet in wb.sheets():
        if sheet.nrows == 0:
            continue
        headers = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)
                   if str(sheet.cell_value(0, c)).strip()]
        if not headers:
            continue
        lines = [f"XLS Sheet '{sheet.name}' Column Headers:"]
        for h in headers:
            lines.append(f"- {h}")
        parts.append("\n".join(lines))

    if not parts:
        return "XLS: No readable sheets found."
    return "\n\n".join(parts)


# ──────────────────────────────────────────────
# SQL Extraction (table names + columns + FKs)
# ──────────────────────────────────────────────
def _extract_sql(raw: bytes) -> str:
    """Extract table names, column names, and foreign key relationships from SQL DDL."""
    sql_text = _decode_bytes(raw)

    create_blocks = re.findall(r"CREATE\s+TABLE\s+.*?;", sql_text, flags=re.IGNORECASE | re.DOTALL)
    alter_fk_blocks = re.findall(
        r"ALTER\s+TABLE\s+.*?FOREIGN\s+KEY\s*\(.*?\)\s*REFERENCES\s+.*?;",
        sql_text,
        flags=re.IGNORECASE | re.DOTALL,
    )

    lines = ["SQL Schema Summary:"]
    table_count = 0

    for block in create_blocks:
        table_match = re.search(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\"\[]?([\w.]+)[`\"\]]?",
            block, flags=re.IGNORECASE,
        )
        if not table_match:
            continue

        table_count += 1
        table_name = table_match.group(1)
        lines.append(f"Table: {table_name}")

        body_match = re.search(r"\((.*)\)", block, flags=re.DOTALL)
        if not body_match:
            continue

        body = body_match.group(1)
        for raw_line in body.splitlines():
            line = raw_line.strip().rstrip(",")
            if not line:
                continue
            upper = line.upper()

            if "FOREIGN KEY" in upper and "REFERENCES" in upper:
                fk_match = re.search(
                    r"FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`\"\[]?([\w.]+)[`\"\]]?\s*\(([^)]+)\)",
                    line, flags=re.IGNORECASE,
                )
                if fk_match:
                    src_cols = fk_match.group(1).strip()
                    ref_table = fk_match.group(2).strip()
                    ref_cols = fk_match.group(3).strip()
                    lines.append(f"  FK: ({src_cols}) -> {ref_table}({ref_cols})")
                continue

            if upper.startswith(("PRIMARY KEY", "UNIQUE", "INDEX", "KEY", "CONSTRAINT", "CHECK")):
                continue

            col_match = re.match(r"[`\"\[]?([A-Za-z_][\w$]*)[`\"\]]?\s+(.+)", line)
            if col_match:
                col_name = col_match.group(1)
                col_type = col_match.group(2).split()[0]
                lines.append(f"  Column: {col_name} ({col_type})")

    for block in alter_fk_blocks:
        alter_match = re.search(
            r"ALTER\s+TABLE\s+[`\"\[]?([\w.]+)[`\"\]]?.*?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`\"\[]?([\w.]+)[`\"\]]?\s*\(([^)]+)\)",
            block, flags=re.IGNORECASE | re.DOTALL,
        )
        if alter_match:
            src_table = alter_match.group(1).strip()
            src_cols = alter_match.group(2).strip()
            ref_table = alter_match.group(3).strip()
            ref_cols = alter_match.group(4).strip()
            lines.append(f"FK (ALTER): {src_table}({src_cols}) -> {ref_table}({ref_cols})")

    if table_count == 0:
        return "SQL Schema Summary:\nNo CREATE TABLE statements found."

    return "\n".join(lines)


# Extensions that produce already-structured metadata (no noun extraction needed)
_STRUCTURED_EXTENSIONS = {".csv", ".xlsx", ".sql"}


# ──────────────────────────────────────────────
# Main: Extract from a single file
# ──────────────────────────────────────────────
def extract_from_file(filename: str, raw: bytes) -> tuple[str, str | None]:
    """
    Extract text from a file based on its extension.

    Returns (extracted_text, warning).
    - PDF/DOCX/TXT/MD/JSON/XML: full text extraction
    - CSV/XLSX: first row (headers) only — deterministic
    - SQL: table names, column names, foreign keys only — deterministic
    """
    ext = filename.lower().rsplit(".", 1)
    ext = f".{ext[1]}" if len(ext) == 2 else ""

    try:
        if ext in {".txt", ".md", ".doc", ".docs"}:
            return _extract_plain_text(raw), None

        if ext == ".pdf":
            return _extract_pdf(raw), None

        if ext == ".docx":
            return _extract_docx(raw), None

        if ext == ".json":
            return _extract_json(raw), None

        if ext == ".xml":
            return _extract_xml(raw), None

        if ext == ".csv":
            return _extract_csv(raw), None

        if ext == ".xlsx":
            return _extract_xlsx(raw), None

        if ext == ".sql":
            return _extract_sql(raw), None

        return "", f"Unsupported extension: {ext}"

    except Exception as e:
        return "", f"Extraction failed: {e}"


# ──────────────────────────────────────────────
# Merge extractions from multiple files
# ──────────────────────────────────────────────
def merge_extractions(file_texts: list[tuple[str, str]]) -> tuple[str, str]:
    """
    Merge extracted texts from multiple files.

    Args:
        file_texts: list of (filename, extracted_text) tuples

    Returns:
        (merged_raw_text, merged_noun_text)
        - merged_raw_text: all texts joined with file separators (for phases 5-6)
        - merged_noun_text: for phases 1-4:
            - Unstructured files (PDF/DOCX/TXT): noun extraction applied
            - Structured files (CSV/XLSX/SQL): kept as-is (already clean metadata)
    """
    raw_parts = []
    noun_parts = []

    for filename, text in file_texts:
        if not text.strip():
            continue

        # Raw text keeps separators for human readability in the saved file
        separator = f"{'=' * 60}\nFILE: {filename}\n{'=' * 60}"
        raw_parts.append(f"{separator}\n{text}")

        # For noun text (fed to LLM): NO separators, just clean content
        ext = filename.lower().rsplit(".", 1)
        ext = f".{ext[1]}" if len(ext) == 2 else ""

        if ext in _STRUCTURED_EXTENSIONS:
            # Structured files: keep as-is but without decorative labels
            noun_parts.append(text)
        else:
            # Unstructured files: extract nouns only
            nouns = extract_nouns(text)
            if nouns.strip():
                noun_parts.append(nouns)

    merged_raw = "\n\n".join(raw_parts)
    merged_nouns = "\n\n".join(noun_parts)

    return merged_raw, merged_nouns
