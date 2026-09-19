import datetime
import json
import os
import subprocess
from pathlib import Path

from app.core.config import ONTOGPT_OUTPUT_DIR, PROJECT_DIR


ONTOGPT_TEMPLATE = """id: https://example.org/ontology/enterprise_terms
name: enterprise_terms
title: Enterprise Terms Extraction Template
description: Extract enterprise concepts from documents.
license: https://creativecommons.org/publicdomain/zero/1.0/
imports:
    - linkml:types
prefixes:
    ex: https://example.org/ontology/
    linkml: https://w3id.org/linkml/
default_prefix: ex
default_range: string

classes:
    EnterpriseTerms:
        tree_root: true
        attributes:
            concepts:
                multivalued: true
                range: string

    Concept:
        attributes:
            id:
                identifier: true
            preferred_label:
                required: true
            definition:
            synonyms:
                multivalued: true
"""


class RealOntoGPTPipeline:
    def __init__(
        self,
        databricks_token: str,
        databricks_host: str,
        model_name: str,
        verify_ssl: bool = False,
    ):
        self.databricks_token = databricks_token
        self.databricks_host = databricks_host.rstrip("/")
        self.model_name = model_name
        self.verify_ssl = verify_ssl

    def run_pipeline(self, raw_text: str, output_base: str) -> dict:
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = ONTOGPT_OUTPUT_DIR / f"{output_base}_ontogpt_{timestamp}"
        run_dir.mkdir(parents=True, exist_ok=True)

        input_file = run_dir / "input.txt"
        template_file = run_dir / "enterprise_template.yaml"
        extracted_json_file = run_dir / "ontogpt_extracted.json"
        jsonld_file = run_dir / "ontogpt_knowledge_graph.jsonld"

        input_file.write_text(raw_text, encoding="utf-8")
        template_file.write_text(ONTOGPT_TEMPLATE, encoding="utf-8")

        self._run_ontogpt_extract(
            input_file=input_file,
            template_file=template_file,
            output_file=extracted_json_file,
        )

        if not extracted_json_file.exists():
            raise RuntimeError("OntoGPT extract completed but no output file was produced.")

        extracted_data = json.loads(extracted_json_file.read_text(encoding="utf-8"))
        jsonld = self._to_jsonld(extracted_data)
        jsonld_file.write_text(json.dumps(jsonld, indent=2), encoding="utf-8")

        return {
            "output_jsonld": str(jsonld_file),
            "knowledge_graph": jsonld,
            "stage_json_outputs": {
                "run_folder": str(run_dir),
                "knowledge_graph_jsonld": str(jsonld_file),
            },
        }

    def _run_ontogpt_extract(self, input_file: Path, template_file: Path, output_file: Path) -> None:
        cli_path = PROJECT_DIR / "backend" / ".venv312" / "Scripts" / "ontogpt.exe"
        if not cli_path.exists():
            raise RuntimeError(
                "Official OntoGPT CLI not found at backend/.venv312/Scripts/ontogpt.exe. "
                "Create Python 3.12 venv and install ontogpt."
            )

        env = os.environ.copy()
        env["OPENAI_API_KEY"] = self.databricks_token
        env["OPENAI_API_BASE"] = f"{self.databricks_host}/ai-gateway/mlflow/v1"
        env["SSL_VERIFY"] = "true" if self.verify_ssl else "false"

        command = [
            str(cli_path),
            "extract",
            "-i",
            str(input_file),
            "-t",
            str(template_file),
            "-m",
            self.model_name,
            "--model-provider",
            "openai",
            "--api-base",
            env["OPENAI_API_BASE"],
            "-O",
            "json",
            "-o",
            str(output_file),
        ]

        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        if result.returncode != 0:
            stderr = (result.stderr or "").strip()
            stdout = (result.stdout or "").strip()
            details = stderr or stdout or "No error details returned by OntoGPT."
            raise RuntimeError(f"OntoGPT extract failed: {details}")

    def _to_jsonld(self, extracted_data) -> dict:
        payload = extracted_data
        if isinstance(extracted_data, dict) and "extracted_object" in extracted_data:
            payload = extracted_data["extracted_object"]

        concepts = []
        relations = []
        if isinstance(payload, dict):
            concepts = payload.get("concepts") or []
            relations = payload.get("relations") or []

        graph = []
        for idx, concept in enumerate(concepts, start=1):
            if isinstance(concept, dict):
                node_id = concept.get("id") or f"concept_{idx}"
                node = {
                    "@id": f"ex:{node_id}",
                    "@type": "ex:Concept",
                    "ex:preferredLabel": concept.get("preferred_label", ""),
                }
                if concept.get("definition"):
                    node["ex:definition"] = concept["definition"]
                if concept.get("synonyms"):
                    node["ex:synonym"] = concept["synonyms"]
                graph.append(node)
                continue

            label = str(concept).strip()
            if not label:
                continue
            slug = label.lower().replace(" ", "_").replace("/", "_")
            graph.append(
                {
                    "@id": f"ex:{slug}",
                    "@type": "ex:Concept",
                    "ex:preferredLabel": label,
                }
            )

        for idx, relation in enumerate(relations, start=1):
            if not isinstance(relation, dict):
                continue
            graph.append(
                {
                    "@id": f"ex:relation_{idx}",
                    "@type": "ex:Relation",
                    "ex:subject": relation.get("subject", ""),
                    "ex:predicate": relation.get("predicate", ""),
                    "ex:object": relation.get("object", ""),
                }
            )

        if not graph:
            graph.append(
                {
                    "@id": "ex:extraction_1",
                    "@type": "ex:EnterpriseExtraction",
                    "ex:rawPayload": payload,
                }
            )

        return {
            "@context": {
                "ex": "https://example.org/ontology/",
                "preferredLabel": "ex:preferredLabel",
                "definition": "ex:definition",
                "synonym": "ex:synonym",
                "subject": "ex:subject",
                "predicate": "ex:predicate",
                "object": "ex:object",
            },
            "@graph": graph,
        }
