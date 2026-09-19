from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.uploads import router as uploads_router

app = FastAPI(title="Ontology Upload API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(uploads_router)


@app.get("/health")
def health_check():
    return {"status": "ok"}
