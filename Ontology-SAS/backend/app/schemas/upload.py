from pydantic import BaseModel


class ProcessedFile(BaseModel):
    filename: str
    extension: str
    bytes: int
    parsed: bool
    text_length: int
    warning: str | None = None


class TaxonomySummary(BaseModel):
    concept_count: int
    output_json: str
    output_skos_jsonld: str


class OntoGPTOutput(BaseModel):
    run_folder: str
    knowledge_graph_jsonld: str


class StageOutputs(BaseModel):
    run_folder: str
    controlled_vocabulary_xlsx: str
    metadata_xlsx: str
    taxonomy_xlsx: str
    thesaurus_xlsx: str
    ontology_xlsx: str
    knowledge_graph_xlsx: str
    controlled_vocabulary_json: str | None = None
    metadata_standard_json: str | None = None
    taxonomy_json: str | None = None
    thesaurus_json: str | None = None
    ontology_json: str | None = None
    knowledge_graph_jsonld: str | None = None


class UploadResponse(BaseModel):
    pipeline_mode: str
    accepted: int
    rejected: int
    files: list[ProcessedFile]
    taxonomy: TaxonomySummary | None = None
    stage_outputs: StageOutputs | None = None
    ontogpt_output: OntoGPTOutput | None = None
