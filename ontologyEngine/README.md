# Ontology Processing App

This project provides:
- A FastAPI backend for multi-file upload and semantic processing.
- A React + Vite frontend for uploading files and viewing results.

Current status:
- `current` pipeline mode is enabled.
- `ontogpt` mode is temporarily disabled in backend and frontend.

---

## 1) Prerequisites

- Python 3.10+ (recommended: 3.12)
- Node.js 18+
- npm
- A valid Databricks host, token, and model for AI calls

---

## 2) Project Structure

- `backend/` FastAPI API
- `frontend/` React UI
- `mock_files/` sample input files for testing
- `generated_outputs/` generated JSON/JSON-LD/XLSX outputs (created automatically)
- `uploaded_files/` uploaded raw files (created automatically)

---

## 3) Backend Setup

From project root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Create env file from template:

```powershell
copy .env.example .env
```

Edit `.env` and fill values:

```env
DATABRICKS_HOST=https://your-databricks-workspace.cloud.databricks.com/
DATABRICKS_TOKEN=your_databricks_token
DATABRICKS_MODEL=databricks-gpt-5-4-mini
DATABRICKS_VERIFY_SSL=false
```

Run backend:

```powershell
python -m uvicorn app.main:app --port 8000
```

Health check:

- Open: `http://127.0.0.1:8000/health`
- Expected: `{"status":"ok"}`

---

## 4) Frontend Setup

From project root:

```powershell
cd frontend
npm install
npm run dev
```

Open UI:

- `http://127.0.0.1:5173`

Note:
- Frontend proxy is configured to backend `http://127.0.0.1:8000` in `frontend/vite.config.ts`.

---

## 5) How to Use

1. Start backend.
2. Start frontend.
3. Open the frontend in browser.
4. Upload one or more files (`.xml,.pdf,.csv,.json,.xlsx,.txt,.md,.doc,.docx,.docs`).
5. Keep pipeline mode as `Current Pipeline`.
6. Click `Upload and Process`.

---

## 6) API Endpoint

- `POST /api/v1/uploads/process`

Example test call (PowerShell):

```powershell
cd backend
$uri='http://127.0.0.1:8000/api/v1/uploads/process'
$filePath=Resolve-Path ..\mock_files\sample.txt
curl.exe -s -X POST $uri -F "files=@$filePath" -F "pipeline_mode=current" -F "output_base=company_taxonomy"
```

---

## 7) Outputs

Generated automatically under:

- `generated_outputs/`

Typical outputs include:
- Pipeline JSON outputs (controlled vocabulary, metadata, taxonomy, thesaurus, ontology, knowledge graph JSON-LD)
- Stage-wise XLSX files

---

## 8) Common Issues and Fixes

### A) `AI mode is required...`
Cause:
- Missing env variables.

Fix:
- Ensure `.env` exists in `backend/` with valid `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_MODEL`.

### B) `Failed to fetch` in frontend
Cause:
- Backend not running, wrong backend port, or proxy mismatch.

Fix:
- Verify backend is running on port 8000.
- If using another port (for example 8010), update `frontend/vite.config.ts` proxy target.

### C) Port in use or permission errors (WinError 10013)
Cause:
- Port blocked or already occupied.

Fix:
- Run backend on another port:

```powershell
python -m uvicorn app.main:app --port 8010
```

- Then update frontend proxy target to `http://127.0.0.1:8010`.

### D) SSL/Connection errors to Databricks
Cause:
- Corporate TLS interception or network restrictions.

Fix:
- Set `DATABRICKS_VERIFY_SSL=false` in `.env` for development.
- Confirm internet and Databricks host access.

### E) Some files parse with warnings
Cause:
- Complex/scanned PDFs or unsupported formatting.

Fix:
- Check warning message in response.
- Try a cleaner text-based source where possible.

---

## 9) OntoGPT Mode Note

`ontogpt` mode is intentionally disabled right now.

If you send `pipeline_mode=ontogpt`, API returns:
- `OntoGPT mode is temporarily disabled. Use pipeline_mode=current.`

---

## 10) Sharing This Project

When sharing a zip, exclude:
- `.env`
- `.venv/`, `.venv312/`
- `node_modules/`
- `generated_outputs/`
- `uploaded_files/`
- `__pycache__/`

Include:
- source code
- `.env.example`
- `requirements.txt`
- this `README.md`
