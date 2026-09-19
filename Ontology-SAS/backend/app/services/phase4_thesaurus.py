import json

BATCH_SIZE = 40  # keep each LLM response small enough to avoid output-token truncation


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _enrich_batch(batch: list[dict], all_ids_reference: list[dict], compact_cv: list[dict], raw_text: str, ask_json_fn) -> list[dict]:
    prompt = f"""PHASE 4: Thesaurus (batch of {len(batch)})

Goal: Enrich ONLY the concepts listed below with lateral relationships and human-readable definitions.

Return a JSON array. Each item must have exactly these keys:
- Concept_ID (String)
- PT (String): Preferred Term
- UF (Array of Strings): aliases/synonyms
- BT (Array of Concept_ID strings): carry over from taxonomy unchanged
- NT (Array of Concept_ID strings): carry over from taxonomy unchanged
- Related_Term_RT (Array of Concept_ID strings): lateral relationships only. May reference ANY
  Concept_ID from the full reference list below, not just this batch.
- Scope_Note_SN (String): actual definition from source text

Strict Rules:
- BT and NT must be carried over unchanged from the taxonomy below.
- Related_Term_RT is for lateral connections only — never hierarchical.
- COMPLETENESS CRITICAL: Output ALL {len(batch)} concept IDs in this batch. Do NOT stop early.

Concepts to enrich ({len(batch)} total — output ALL of them):
{json.dumps(batch)}

Full reference list of every Concept_ID in the dataset (for choosing Related_Term_RT targets):
{json.dumps(all_ids_reference)}

Aliases reference:
{json.dumps(compact_cv)}

Source text for scope notes:
{raw_text[:60000]}
"""
    data = ask_json_fn(prompt, expect_list=True)
    return data if isinstance(data, list) else []


def run(controlled_vocab: list[dict], taxonomy: list[dict], raw_text: str, ask_json_fn) -> list[dict]:
    compact_taxonomy = [
        {"Concept_ID": item["Concept_ID"], "Preferred_Term_PT": item["Preferred_Term_PT"],
         "BT": item.get("Broader_Term_BT", []), "NT": item.get("Narrower_Term_NT", [])}
        for item in taxonomy
    ]
    compact_cv = [
        {"Approved_Term": item["Approved_Term"], "Aliases": item.get("Aliases", [])}
        for item in controlled_vocab
    ]
    expected_ids = {item["Concept_ID"] for item in taxonomy}
    all_ids_reference = [
        {"Concept_ID": item["Concept_ID"], "Preferred_Term_PT": item["Preferred_Term_PT"]}
        for item in compact_taxonomy
    ]

    # Batch the enrichment so no single LLM response is large enough to hit the
    # output-token ceiling and get truncated mid-word/mid-object.
    data: list = []
    for batch in _chunks(compact_taxonomy, BATCH_SIZE):
        data.extend(_enrich_batch(batch, all_ids_reference, compact_cv, raw_text, ask_json_fn))

    returned_ids = {str(item.get("Concept_ID", "")).strip() for item in data if isinstance(item, dict)}
    missing = expected_ids - returned_ids

    # CHUNKED RETRY LOGIC: secondary safety net for anything a batch still missed
    max_retries = 3
    retries = 0
    chunk_size = 5
    while missing and retries < max_retries:
        missing_concepts = [t for t in compact_taxonomy if t["Concept_ID"] in missing]
        for i in range(0, len(missing_concepts), chunk_size):
            chunk = missing_concepts[i:i + chunk_size]
            extra = ask_json_fn(
                f"""The previous thesaurus batch was INCOMPLETE. Return ONLY these {len(chunk)} missing entries
as a JSON array with keys: Concept_ID, PT, UF, BT, NT, Related_Term_RT, Scope_Note_SN. Do NOT truncate.
{json.dumps(chunk)}""",
                expect_list=True
            )
            if isinstance(extra, list):
                data.extend(extra)
        returned_ids = {str(item.get("Concept_ID", "")).strip() for item in data if isinstance(item, dict)}
        missing = expected_ids - returned_ids
        retries += 1

    return _normalize(data, controlled_vocab, taxonomy)


def _normalize(data, controlled_vocab: list[dict], taxonomy: list[dict]) -> list[dict]:
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

        bt_ids = [_id_from_value(v, valid_ids, term_to_id) for v in bt]
        nt_ids = [_id_from_value(v, valid_ids, term_to_id) for v in nt]
        rt_ids = [_id_from_value(v, valid_ids, term_to_id) for v in rt]

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
            "Scope_Note_SN": f"Top-level category: {term}." if not tax_item.get("Broader_Term_BT") else f"Use for {term}.",
        }

    return [result[item["Concept_ID"]] for item in taxonomy if item["Concept_ID"] in result]


def _id_from_value(value, valid_ids: set[str], term_to_id: dict[str, str]) -> str | None:
    raw = str(value).strip()
    if not raw:
        return None
    if raw in valid_ids:
        return raw
    return term_to_id.get(raw)
