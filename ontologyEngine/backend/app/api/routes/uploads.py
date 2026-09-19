from pathlib import Path
import os

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.core.config import ALLOWED_EXTENSIONS, UPLOAD_DIR
from app.schemas.upload import (
    OntoGPTOutput,
    ProcessedFile,
    StageOutputs,
    TaxonomySummary,
    UploadResponse,
)
from app.services.file_parser import extract_text
# from app.services.ontogpt_service import RealOntoGPTPipeline
from app.services.stage_xlsx_export import export_stage_excels
from app.services.taxonomy_service import SixPhaseOntologyPipeline

router = APIRouter(prefix="/api/v1/uploads", tags=["uploads"])


@router.post("/process", response_model=UploadResponse)
async def process_uploads(
    files: list[UploadFile] = File(...),
    api_key: str | None = Form(default=None),
    databricks_token: str | None = Form(default=None),
    databricks_host: str | None = Form(default=None),
    output_base: str = Form(default="company_taxonomy"),
    pipeline_mode: str = Form(default="current"),
):
    accepted_files: list[ProcessedFile] = []
    rejected_count = 0
    merged_text_parts: list[str] = []
    stage_outputs = None
    ontogpt_output = None

    for upload in files:
        suffix = Path(upload.filename).suffix.lower()
        content = await upload.read()

        if suffix not in ALLOWED_EXTENSIONS:
            rejected_count += 1
            accepted_files.append(
                ProcessedFile(
                    filename=upload.filename,
                    extension=suffix,
                    bytes=len(content),
                    parsed=False,
                    text_length=0,
                    warning="Unsupported extension",
                )
            )
            continue

        target_path = UPLOAD_DIR / upload.filename
        target_path.write_bytes(content)

        try:
            text, warning = extract_text(upload.filename, content)
            merged_text_parts.append(text)
            accepted_files.append(
                ProcessedFile(
                    filename=upload.filename,
                    extension=suffix,
                    bytes=len(content),
                    parsed=True,
                    text_length=len(text),
                    warning=warning,
                )
            )
        except Exception as exc:
            accepted_files.append(
                ProcessedFile(
                    filename=upload.filename,
                    extension=suffix,
                    bytes=len(content),
                    parsed=False,
                    text_length=0,
                    warning=f"Parse failed: {exc}",
                )
            )

    taxonomy_summary = None
    successful_text = "\n\n".join(part for part in merged_text_parts if part.strip())
    resolved_token = databricks_token or api_key or os.getenv("DATABRICKS_TOKEN")
    resolved_host = databricks_host or os.getenv("DATABRICKS_HOST")
    resolved_model = os.getenv("DATABRICKS_MODEL")

    if not resolved_token or not resolved_host or not resolved_model:
        raise HTTPException(
            status_code=400,
            detail=(
                "AI mode is required. Set DATABRICKS_TOKEN, DATABRICKS_HOST, and "
                "DATABRICKS_MODEL in environment variables."
            ),
        )

    if not successful_text.strip():
        raise HTTPException(
            status_code=400,
            detail="No parseable text found in uploaded files. AI pipeline cannot run.",
        )

    if pipeline_mode == "ontogpt":
        raise HTTPException(
            status_code=400,
            detail="OntoGPT mode is temporarily disabled. Use pipeline_mode=current.",
        )

        # OntoGPT mode is intentionally disabled for now.
        # verify_ssl = os.getenv("DATABRICKS_VERIFY_SSL", "false").lower() == "true"
        # service = RealOntoGPTPipeline(
        #     databricks_token=resolved_token,
        #     databricks_host=resolved_host,
        #     model_name=resolved_model,
        #     verify_ssl=verify_ssl,
        # )
        # try:
        #     ontogpt_result = service.run_pipeline(
        #         raw_text=successful_text,
        #         output_base=output_base,
        #     )
        # except Exception as exc:
        #     raise HTTPException(
        #         status_code=503,
        #         detail=f"AI pipeline failed: {exc}",
        #     ) from exc
        # ontogpt_output = OntoGPTOutput(**ontogpt_result["stage_json_outputs"])

    if resolved_token and resolved_host and successful_text.strip():
        service = SixPhaseOntologyPipeline(
            databricks_token=resolved_token,
            databricks_host=resolved_host,
        )
        try:
            stage_result = service.run_pipeline(
                raw_text=successful_text,
                metadata_rows=[file.model_dump() for file in accepted_files],
                output_base=output_base,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=f"AI pipeline failed: {exc}",
            ) from exc
        taxonomy_summary = TaxonomySummary(
            concept_count=stage_result["concept_count"],
            output_json=stage_result["output_json"],
            output_skos_jsonld=stage_result["output_skos_jsonld"],
        )

        xlsx_paths = export_stage_excels(
            output_base=output_base,
            controlled_vocab=stage_result["controlled_vocab"],
            metadata_standard=stage_result["metadata_standard"],
            taxonomy=stage_result["taxonomy"],
            thesaurus=stage_result["thesaurus"],
            ontology=stage_result["ontology"],
            knowledge_graph=stage_result["knowledge_graph"],
        )
        xlsx_paths.update(
            {
                "controlled_vocabulary_json": stage_result["stage_json_outputs"]["controlled_vocabulary_json"],
                "metadata_standard_json": stage_result["stage_json_outputs"]["metadata_standard_json"],
                "taxonomy_json": stage_result["stage_json_outputs"]["taxonomy_json"],
                "thesaurus_json": stage_result["stage_json_outputs"]["thesaurus_json"],
                "ontology_json": stage_result["stage_json_outputs"]["ontology_json"],
                "knowledge_graph_jsonld": stage_result["stage_json_outputs"]["knowledge_graph_jsonld"],
            }
        )
        stage_outputs = StageOutputs(**xlsx_paths)

    return UploadResponse(
        pipeline_mode=pipeline_mode,
        accepted=sum(1 for f in accepted_files if f.parsed),
        rejected=rejected_count,
        files=accepted_files,
        taxonomy=taxonomy_summary,
        stage_outputs=stage_outputs,
        ontogpt_output=ontogpt_output,
    )
