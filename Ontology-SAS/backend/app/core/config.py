from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
PROJECT_DIR = BASE_DIR.parent
UPLOAD_DIR = PROJECT_DIR / "uploaded_files"
UPLOAD_DIR.mkdir(exist_ok=True)
GENERATED_DIR = PROJECT_DIR / "generated_outputs"
GENERATED_DIR.mkdir(exist_ok=True)
STATIC_JSON_DIR = GENERATED_DIR / "json"
STATIC_JSON_DIR.mkdir(parents=True, exist_ok=True)
STATIC_XLSX_DIR = GENERATED_DIR / "xlsx"
STATIC_XLSX_DIR.mkdir(parents=True, exist_ok=True)
STAGE_OUTPUT_DIR = GENERATED_DIR / "stage_xlsx"
STAGE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
ONTOGPT_OUTPUT_DIR = GENERATED_DIR / "ontogpt"
ONTOGPT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {
    ".xml",
    ".pdf",
    ".csv",
    ".json",
    ".xlsx",
    ".sql",
    ".txt",
    ".md",
    ".doc",
    ".docx",
    ".docs",
}
