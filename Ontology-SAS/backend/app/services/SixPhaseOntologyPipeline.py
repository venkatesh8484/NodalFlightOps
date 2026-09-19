import json
import os
from json import JSONDecodeError
from pathlib import Path

from app.core.config import STATIC_JSON_DIR
from app.services.llm_helper import generate_description
from app.services.data_extractor import smart_chunk
from app.services import (
    phase1_controlled_vocabulary,
    phase2_metadata_standard,
    phase3_taxonomy,
    phase4_thesaurus,
    phase5_ontology,
    phase6_knowledge_graph,
)


SYSTEM_PROMPT = (
    "You are a Senior Semantic Architect and Data Engineer specializing in ISO 25964 thesauri and W3C Knowledge Graphs. "
    "Return strict JSON only. Do not include markdown fences or any explanatory text. "
    "You MUST strictly obey all hierarchical logic rules, anti-inversion constraints, and domain/range definitions."
)

# When enabled, Phase 6 will detect disconnected graph clusters and ask the LLM to
# propose bridging relationships using general world/domain knowledge so the final
# knowledge graph forms a single connected graph instead of several separate ones.
ALLOW_WORLD_KNOWLEDGE_BRIDGING = os.getenv("ALLOW_WORLD_KNOWLEDGE_BRIDGING", "true").lower() not in ("false", "0", "no")


class SixPhaseOntologyPipeline:
    def __init__(self, namespace_uri: str = "http://example.org/"):
        self.namespace_uri = namespace_uri.rstrip("/") + "/"

    def run_pipeline(self, noun_text: str, raw_text: str, metadata_rows: list[dict], output_base: str) -> dict:
        # === PASS 1: Extract concepts from raw text chunks (Phase 1 only) ===
        # Phase 1 uses RAW text to preserve multi-word entity boundaries
        # (noun-filtered text destroys compound names like "PostNord TPL")
        raw_chunks = smart_chunk(raw_text, chunk_size=50000, overlap=5000)
        noun_chunks = smart_chunk(noun_text, chunk_size=50000, overlap=5000)

        all_vocab = []
        seen_terms = set()

        for chunk in raw_chunks:
            chunk_vocab = phase1_controlled_vocabulary.run(chunk, self._ask_json)

            # Retry up to 2 more times if LLM returns empty (non-deterministic)
            for retry in range(2):
                if chunk_vocab:
                    break
                import logging
                logging.warning(f"Phase 1 returned empty for chunk, retry {retry + 1}/2")
                chunk_vocab = phase1_controlled_vocabulary.run(chunk, self._ask_json)

            for item in chunk_vocab:
                term = item.get("Approved_Term", "").strip().lower()
                if term and term not in seen_terms:
                    seen_terms.add(term)
                    all_vocab.append(item)

        # === PASS 2: Build hierarchy from unified vocabulary (Phases 2-6) ===
        # Phase 2: Pure Python - assign IDs to merged vocab
        metadata_standard = phase2_metadata_standard.run(all_vocab)

        # Phase 3: Taxonomy - uses structured concept list (small), not raw text
        # Pass first noun chunk as context hint only
        taxonomy = phase3_taxonomy.run(metadata_standard, noun_chunks[0], self._ask_json)

        # Phase 4: Thesaurus - uses structured data from phases 1-3
        thesaurus = phase4_thesaurus.run(all_vocab, taxonomy, noun_chunks[0], self._ask_json)

        # Phase 5: Ontology - uses raw text for verb/relationship extraction
        ontology = phase5_ontology.run(thesaurus, raw_chunks[0], self._ask_json)

        # Phase 6: Knowledge Graph - pure Python graph assembly, plus an optional
        # LLM-driven connectivity pass that bridges disconnected clusters using
        # general world/domain knowledge so we end up with one connected graph.
        bridging_ask_fn = self._ask_json if ALLOW_WORLD_KNOWLEDGE_BRIDGING else None
        knowledge_graph = phase6_knowledge_graph.run(thesaurus, ontology, self.namespace_uri, ask_json_fn=bridging_ask_fn)

        output_paths = self._write_stage_outputs(
            output_base=output_base,
            controlled_vocab=all_vocab,
            metadata_standard=metadata_standard,
            taxonomy=taxonomy,
            thesaurus=thesaurus,
            ontology=ontology,
            knowledge_graph=knowledge_graph,
        )

        return {
            "concept_count": len(all_vocab),
            "output_json": output_paths["taxonomy_json"],
            "output_skos_jsonld": output_paths["knowledge_graph_jsonld"],
            "controlled_vocab": all_vocab,
            "metadata_standard": metadata_standard,
            "taxonomy": taxonomy,
            "thesaurus": thesaurus,
            "ontology": ontology,
            "knowledge_graph": knowledge_graph,
            "stage_json_outputs": output_paths,
        }

    def _write_stage_outputs(self, output_base, controlled_vocab, metadata_standard, taxonomy, thesaurus, ontology, knowledge_graph) -> dict:
        run_dir = STATIC_JSON_DIR
        files = {
            "controlled_vocabulary_json": run_dir / "01_controlled_vocabulary.json",
            "metadata_standard_json": run_dir / "02_metadata_standard.json",
            "taxonomy_json": run_dir / "03_taxonomy.json",
            "thesaurus_json": run_dir / "04_thesaurus.json",
            "ontology_json": run_dir / "05_ontology.json",
            "knowledge_graph_jsonld": run_dir / "06_knowledge_graph.jsonld",
        }
        self._write_json(files["controlled_vocabulary_json"], controlled_vocab)
        self._write_json(files["metadata_standard_json"], metadata_standard)
        self._write_json(files["taxonomy_json"], taxonomy)
        self._write_json(files["thesaurus_json"], thesaurus)
        self._write_json(files["ontology_json"], ontology)
        self._write_json(files["knowledge_graph_jsonld"], knowledge_graph)
        result = {"run_folder": str(run_dir)}
        result.update({key: str(path) for key, path in files.items()})
        return result

    def _write_json(self, path: Path, data) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def _ask_json(self, prompt: str, expect_list: bool = False):
        base_messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]

        last_error = None
        for attempt in range(3):
            if attempt == 0:
                messages = base_messages
            else:
                messages = [
                    {"role": "system", "content": "Return strict, complete, valid JSON only. No prose, no code fences, no trailing fragments."},
                    {"role": "user", "content": prompt + "\n\nIMPORTANT: Output must be complete JSON (not truncated)."},
                ]

            system_msg = next((m["content"] for m in messages if m["role"] == "system"), None)
            user_msg = next((m["content"] for m in messages if m["role"] == "user"), prompt)

            content = generate_description(
                prompt=user_msg,
                max_tokens=16000,
                system=system_msg,
                response_format='json'
            )
            cleaned = self._clean_json_response(content)

            try:
                return self._unwrap_if_needed(json.loads(cleaned), expect_list)
            except JSONDecodeError as ex:
                last_error = ex

            extracted = self._extract_first_json_block(cleaned)
            if extracted:
                try:
                    return self._unwrap_if_needed(json.loads(extracted), expect_list)
                except JSONDecodeError as ex:
                    cleaned = extracted
                    last_error = ex

            repaired = generate_description(
                prompt=f"Repair this malformed JSON and return valid JSON only:\n\n{cleaned}",
                max_tokens=16000,
                system="You repair malformed JSON. Return only corrected valid JSON with no markdown. Do not add explanatory text. Preserve original data and structure.",
                response_format='json'
            )
            repaired_clean = self._clean_json_response(repaired)
            try:
                return self._unwrap_if_needed(json.loads(repaired_clean), expect_list)
            except JSONDecodeError as ex:
                last_error = ex

        raise RuntimeError(f"Unable to parse valid JSON from AI response after retries: {last_error}")

    def _unwrap_if_needed(self, data, expect_list: bool):
        if expect_list and isinstance(data, dict):
            for v in data.values():
                if isinstance(v, list):
                    return v
        return data

    def _clean_json_response(self, text: str) -> str:
        text = text.strip()
        if text.startswith("```"):
            text = text.strip("`").strip()
            if text.lower().startswith("json"):
                text = text[4:].strip()
        return text

    def _extract_first_json_block(self, text: str) -> str | None:
        start = -1
        for i, ch in enumerate(text):
            if ch in "[{":
                start = i
                break
        if start == -1:
            return None

        stack = []
        in_string = False
        escape = False

        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
                continue
            if ch in "[{":
                stack.append(ch)
            elif ch in "]}":
                if not stack:
                    return None
                opener = stack.pop()
                if (opener == "[" and ch != "]") or (opener == "{" and ch != "}"):
                    return None
                if not stack:
                    return text[start: i + 1]

        return None
