from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from app.api.routes.uploads import router as uploads_router

app = FastAPI(title="Ontology Upload API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", 
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:5181",
        "http://127.0.0.1:5181"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount generated_outputs folder for static file access
generated_outputs_path = Path(__file__).parent.parent.parent / "generated_outputs"
if generated_outputs_path.exists():
    app.mount("/generated_outputs", StaticFiles(directory=str(generated_outputs_path)), name="generated_outputs")

app.include_router(uploads_router)


@app.get("/health")
def health_check():
    return {"status": "ok"}
