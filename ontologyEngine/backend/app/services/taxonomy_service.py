import datetime
import json
import os
from json import JSONDecodeError
from pathlib import Path

from app.core.config import GENERATED_DIR
from app.services.llm_client import call_databricks_chat


class SixPhaseOntologyPipeline:
    def __init__(
        self,
        databricks_token: str,
        databricks_host: str,
        namespace_uri: str = "http://example.org/",
        model_name: str | None = None,
    ):
        os.environ["DATABRICKS_TOKEN"] = databricks_token
        os.environ["DATABRICKS_HOST"] = databricks_host
        if model_name:
            os.environ["DATABRICKS_MODEL"] = model_name
        self.namespace_uri = namespace_uri.rstrip("/") + "/"

    def run_pipeline(self, raw_text: str, metadata_rows: list[dict], output_base: str) -> dict:
        controlled_vocab = self._phase_controlled_vocabulary(raw_text)
        metadata_standard = self._phase_metadata_standard(controlled_vocab)
        taxonomy = self._phase_taxonomy(metadata_standard, raw_text)
        thesaurus = self._phase_thesaurus(controlled_vocab, taxonomy, raw_text)
        ontology = self._phase_ontology(thesaurus, raw_text)
        knowledge_graph = self._phase_knowledge_graph(thesaurus, ontology)

        output_paths = self._write_stage_outputs(
            output_base=output_base,
            controlled_vocab=controlled_vocab,
            metadata_standard=metadata_standard,
            taxonomy=taxonomy,
            thesaurus=thesaurus,
            ontology=ontology,
            knowledge_graph=knowledge_graph,
        )

        return {
            "concept_count": len(controlled_vocab),
            "output_json": output_paths["taxonomy_json"],
            "output_skos_jsonld": output_paths["knowledge_graph_jsonld"],
            "controlled_vocab": controlled_vocab,
            "metadata_standard": metadata_standard,
            "taxonomy": taxonomy,
            "thesaurus": thesaurus,
            "ontology": ontology,
            "knowledge_graph": knowledge_graph,
            "stage_json_outputs": output_paths,
        }

    def _phase_controlled_vocabulary(self, raw_text: str) -> list[dict]:
        prompt = f"""You are an Expert Semantic Architect.
Read the text and output phase 1 only.
Return valid JSON array only.
Each item keys must be exactly:
- Approved_Term
- Aliases (array)
Rules:
- ONLY raw words and aliases.
- No IDs.
- No parent/child.
- No related terms.

Source text:
{raw_text[:35000]}
"""
        data = self._ask_json(prompt)
        return self._normalize_controlled_vocab(data)

    def _phase_metadata_standard(self, controlled_vocab: list[dict]) -> list[dict]:
        metadata = []
        for idx, item in enumerate(controlled_vocab, start=1):
            metadata.append(
                {
                    "Concept_ID": f"C{idx:03d}",
                    "Preferred_Term_PT": item["Approved_Term"],
                    "Used_For_UF": item.get("Aliases", []),
                    "Status": "ACTIVE",
                }
            )
        return metadata

    def _phase_taxonomy(self, metadata_standard: list[dict], raw_text: str) -> list[dict]:
        prompt = f"""You are an Expert Semantic Architect.
Build phase 3 only.
Return valid JSON array only.
Each item keys must be exactly:
- Concept_ID
- Preferred_Term_PT
- Broader_Term_BT (array of Concept_ID)
- Narrower_Term_NT (array of Concept_ID)
Rules:
- ONLY hierarchical links.
- NO Related terms.
- IDs must come only from provided metadata.

Metadata standard input:
{json.dumps(metadata_standard, indent=2)}

Source text for context:
{raw_text[:25000]}
"""
        data = self._ask_json(prompt)
        return self._normalize_taxonomy(data, metadata_standard)

    def _phase_thesaurus(self, controlled_vocab: list[dict], taxonomy: list[dict], raw_text: str) -> list[dict]:
        prompt = f"""You are an Expert Semantic Architect.
Build phase 4 only.
Return valid JSON array only.
Each item keys must be exactly:
- Concept_ID
- PT
- UF (array)
- BT (array of Concept_ID)
- NT (array of Concept_ID)
- Related_Term_RT (array of Concept_ID)
- Scope_Note_SN
Rules:
- This is full thesaurus form.
- Use PT/UF from controlled vocabulary.
- Use BT/NT from taxonomy.
- Related terms can be added as associative links.

Controlled Vocabulary:
{json.dumps(controlled_vocab, indent=2)}

Taxonomy:
{json.dumps(taxonomy, indent=2)}

Source text for scope notes:
{raw_text[:22000]}
"""
        data = self._ask_json(prompt)
        return self._normalize_thesaurus(data, controlled_vocab, taxonomy)

    def _phase_ontology(self, thesaurus: list[dict], raw_text: str) -> dict:
        prompt = f"""You are an Expert Semantic Architect.
Build phase 5 only.
Return valid JSON object only with exactly:
- Classes (array)
- Object_Properties (array of objects with keys: Verb, Domain, Range)
Rules:
- High-level abstract rules only.
- No specific concept instance IDs in classes/properties.

Thesaurus:
{json.dumps(thesaurus, indent=2)}

Source text:
{raw_text[:15000]}
"""
        data = self._ask_json(prompt)
        if not isinstance(data, dict):
            data = {}

        classes = data.get("Classes") if isinstance(data.get("Classes"), list) else []
        props = data.get("Object_Properties")
        if not isinstance(props, list):
            props = []

        normalized_props = []
        for prop in props:
            if not isinstance(prop, dict):
                continue
            verb = str(prop.get("Verb", "")).strip()
            domain = str(prop.get("Domain", "")).strip()
            range_value = str(prop.get("Range", "")).strip()
            if verb:
                normalized_props.append(
                    {
                        "Verb": verb,
                        "Domain": domain or "Concept",
                        "Range": range_value or "Concept",
                    }
                )

        if not normalized_props:
            normalized_props = [
                {"Verb": "has_broader_concept", "Domain": "Concept", "Range": "Concept"},
                {"Verb": "has_narrower_concept", "Domain": "Concept", "Range": "Concept"},
                {"Verb": "is_related_to", "Domain": "Concept", "Range": "Concept"},
            ]

        if not classes:
            classes = ["Concept"]

        return {"Classes": classes, "Object_Properties": normalized_props}

    def _phase_knowledge_graph(self, thesaurus: list[dict], ontology: dict) -> dict:
        id_map = {item["Concept_ID"]: item for item in thesaurus}
        pt_to_id = {item["PT"]: item["Concept_ID"] for item in thesaurus}

        object_properties = ontology.get("Object_Properties", [])
        verbs = [str(p.get("Verb", "")).strip() for p in object_properties if isinstance(p, dict)]
        verbs = [v for v in verbs if v]

        broader_verb = next((v for v in verbs if "broader" in v.lower() or "parent" in v.lower()), None)
        narrower_verb = next((v for v in verbs if "narrower" in v.lower() or "child" in v.lower()), None)
        related_verb = next((v for v in verbs if "related" in v.lower()), None)

        if not broader_verb:
            broader_verb = verbs[0] if verbs else "has_broader_concept"
        if not narrower_verb:
            narrower_verb = verbs[1] if len(verbs) > 1 else "has_narrower_concept"
        if not related_verb:
            related_verb = verbs[2] if len(verbs) > 2 else "is_related_to"

        context = {
            "@vocab": self.namespace_uri,
            broader_verb: {"@id": f"{self.namespace_uri}ontology/{broader_verb}", "@type": "@id"},
            narrower_verb: {"@id": f"{self.namespace_uri}ontology/{narrower_verb}", "@type": "@id"},
            related_verb: {"@id": f"{self.namespace_uri}ontology/{related_verb}", "@type": "@id"},
        }

        graph = []
        for item in thesaurus:
            cid = item["Concept_ID"]
            node = {
                "@id": f"concept:{cid}",
                "@type": "Concept",
                broader_verb: self._resolve_targets(item.get("BT", []), id_map, pt_to_id),
                narrower_verb: self._resolve_targets(item.get("NT", []), id_map, pt_to_id),
                related_verb: self._resolve_targets(item.get("Related_Term_RT", []), id_map, pt_to_id),
            }
            graph.append(node)

        return {"@context": context, "@graph": graph}

    def _resolve_targets(self, values: list, id_map: dict, pt_to_id: dict) -> list[str]:
        result: list[str] = []
        for value in values:
            raw = str(value).strip()
            if not raw:
                continue
            if raw in id_map:
                target_id = raw
            elif raw in pt_to_id:
                target_id = pt_to_id[raw]
            else:
                continue
            result.append(f"concept:{target_id}")
        return result

    def _normalize_controlled_vocab(self, data) -> list[dict]:
        if not isinstance(data, list):
            return []
        seen = set()
        out = []
        for item in data:
            if not isinstance(item, dict):
                continue
            term = str(
                item.get("Approved_Term")
                or item.get("Preferred_Term_PT")
                or item.get("PT")
                or ""
            ).strip()
            if not term:
                continue

            aliases = item.get("Aliases")
            if not isinstance(aliases, list):
                aliases = item.get("Used_For_UF") if isinstance(item.get("Used_For_UF"), list) else []

            normalized_aliases = []
            for alias in aliases:
                a = str(alias).strip()
                if a and a.lower() != term.lower() and a not in normalized_aliases:
                    normalized_aliases.append(a)

            key = term.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append({"Approved_Term": term, "Aliases": normalized_aliases})
        return out

    def _normalize_taxonomy(self, data, metadata_standard: list[dict]) -> list[dict]:
        if not isinstance(data, list):
            data = []

        valid_ids = {item["Concept_ID"] for item in metadata_standard}
        term_to_id = {item["Preferred_Term_PT"]: item["Concept_ID"] for item in metadata_standard}

        by_id = {}
        for item in data:
            if not isinstance(item, dict):
                continue
            cid = str(item.get("Concept_ID", "")).strip()
            term = str(item.get("Preferred_Term_PT", "")).strip()
            if not cid and term in term_to_id:
                cid = term_to_id[term]
            if cid not in valid_ids:
                continue
            if not term:
                term = next((x["Preferred_Term_PT"] for x in metadata_standard if x["Concept_ID"] == cid), "")

            bt = item.get("Broader_Term_BT")
            nt = item.get("Narrower_Term_NT")
            bt = bt if isinstance(bt, list) else []
            nt = nt if isinstance(nt, list) else []

            bt_ids = [self._id_from_value(v, valid_ids, term_to_id) for v in bt]
            nt_ids = [self._id_from_value(v, valid_ids, term_to_id) for v in nt]
            bt_ids = [x for x in bt_ids if x]
            nt_ids = [x for x in nt_ids if x]

            by_id[cid] = {
                "Concept_ID": cid,
                "Preferred_Term_PT": term,
                "Broader_Term_BT": list(dict.fromkeys(bt_ids)),
                "Narrower_Term_NT": list(dict.fromkeys(nt_ids)),
            }

        for item in metadata_standard:
            cid = item["Concept_ID"]
            if cid not in by_id:
                by_id[cid] = {
                    "Concept_ID": cid,
                    "Preferred_Term_PT": item["Preferred_Term_PT"],
                    "Broader_Term_BT": [],
                    "Narrower_Term_NT": [],
                }

        return [by_id[item["Concept_ID"]] for item in metadata_standard]

    def _normalize_thesaurus(self, data, controlled_vocab: list[dict], taxonomy: list[dict]) -> list[dict]:
        if not isinstance(data, list):
            data = []

        cv_map = {item["Approved_Term"]: item.get("Aliases", []) for item in controlled_vocab}
        tax_map = {item["Concept_ID"]: item for item in taxonomy}
        term_to_id = {item["Preferred_Term_PT"]: item["Concept_ID"] for item in taxonomy}
        valid_ids = set(tax_map.keys())

        result = {}
        for item in data:
            if not isinstance(item, dict):
                continue
            cid = str(item.get("Concept_ID", "")).strip()
            if not cid:
                maybe_pt = str(item.get("PT", "")).strip()
                cid = term_to_id.get(maybe_pt, "")
            if cid not in valid_ids:
                continue

            term = tax_map[cid]["Preferred_Term_PT"]
            uf = item.get("UF") if isinstance(item.get("UF"), list) else cv_map.get(term, [])
            bt = item.get("BT") if isinstance(item.get("BT"), list) else tax_map[cid].get("Broader_Term_BT", [])
            nt = item.get("NT") if isinstance(item.get("NT"), list) else tax_map[cid].get("Narrower_Term_NT", [])
            rt = item.get("Related_Term_RT") if isinstance(item.get("Related_Term_RT"), list) else []
            sn = str(item.get("Scope_Note_SN", "")).strip()

            bt_ids = [self._id_from_value(v, valid_ids, term_to_id) for v in bt]
            nt_ids = [self._id_from_value(v, valid_ids, term_to_id) for v in nt]
            rt_ids = [self._id_from_value(v, valid_ids, term_to_id) for v in rt]

            result[cid] = {
                "Concept_ID": cid,
                "PT": term,
                "UF": [str(v).strip() for v in uf if str(v).strip()],
                "BT": [x for x in bt_ids if x],
                "NT": [x for x in nt_ids if x],
                "Related_Term_RT": [x for x in rt_ids if x],
                "Scope_Note_SN": sn or f"Use for {term}.",
            }

        for cid, tax_item in tax_map.items():
            if cid in result:
                continue
            term = tax_item["Preferred_Term_PT"]
            result[cid] = {
                "Concept_ID": cid,
                "PT": term,
                "UF": cv_map.get(term, []),
                "BT": tax_item.get("Broader_Term_BT", []),
                "NT": tax_item.get("Narrower_Term_NT", []),
                "Related_Term_RT": [],
                "Scope_Note_SN": f"Use for {term}.",
            }

        ordered = [result[item["Concept_ID"]] for item in taxonomy]
        return ordered

    def _id_from_value(self, value, valid_ids: set[str], term_to_id: dict[str, str]) -> str | None:
        raw = str(value).strip()
        if not raw:
            return None
        if raw in valid_ids:
            return raw
        return term_to_id.get(raw)

    def _write_stage_outputs(
        self,
        output_base: str,
        controlled_vocab: list[dict],
        metadata_standard: list[dict],
        taxonomy: list[dict],
        thesaurus: list[dict],
        ontology: dict,
        knowledge_graph: dict,
    ) -> dict:
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = GENERATED_DIR / f"{output_base}_six_phase_{timestamp}"
        run_dir.mkdir(parents=True, exist_ok=True)

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

    def _ask_json(self, prompt: str):
        base_messages = [
            {
                "role": "system",
                "content": (
                    "You are a precise semantic architect. Return strict JSON only. "
                    "Do not include markdown fences or any explanatory text."
                ),
            },
            {"role": "user", "content": prompt},
        ]

        last_error = None
        for attempt in range(3):
            if attempt == 0:
                messages = base_messages
            else:
                messages = [
                    {
                        "role": "system",
                        "content": (
                            "Return strict, complete, valid JSON only. "
                            "No prose, no code fences, no trailing fragments."
                        ),
                    },
                    {
                        "role": "user",
                        "content": prompt + "\n\nIMPORTANT: Output must be complete JSON (not truncated).",
                    },
                ]

            content = call_databricks_chat(
                messages=messages,
                max_tokens=8000,
            )
            cleaned = self._clean_json_response(content)

            # 1) Direct parse
            try:
                return json.loads(cleaned)
            except JSONDecodeError as ex:
                last_error = ex

            # 2) Parse extracted JSON candidate
            extracted = self._extract_first_json_block(cleaned)
            if extracted:
                try:
                    return json.loads(extracted)
                except JSONDecodeError as ex:
                    cleaned = extracted
                    last_error = ex

            # 3) AI-only repair pass
            repaired = call_databricks_chat(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You repair malformed JSON. Return only corrected valid JSON with no markdown. "
                            "Do not add explanatory text. Preserve original data and structure."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            "Repair this malformed JSON and return valid JSON only:\n\n"
                            f"{cleaned}"
                        ),
                    },
                ],
                max_tokens=8000,
            )
            repaired_clean = self._clean_json_response(repaired)
            try:
                return json.loads(repaired_clean)
            except JSONDecodeError as ex:
                last_error = ex

        raise RuntimeError(f"Unable to parse valid JSON from AI response after retries: {last_error}")

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
                    return text[start : i + 1]

        return None
