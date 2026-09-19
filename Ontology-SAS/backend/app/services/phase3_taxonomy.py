import json

BATCH_SIZE = 40  # keep each LLM response small enough to avoid output-token truncation


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _establish_buckets(compact_meta: list[dict], raw_text: str, ask_json_fn) -> list[dict]:
    """Ask the LLM once for a FIXED set of top-level buckets before batching.

    Doing this up front (instead of letting every batch invent its own buckets)
    keeps the hierarchy consistent across batches and gives every batch call a
    shared vocabulary of parent IDs to attach to.
    """
    terms = [c["Preferred_Term_PT"] for c in compact_meta]
    prompt = f"""PHASE 3a: Top-Level Buckets

Given this list of {len(terms)} domain concepts, invent 3 to 5 top-level category buckets that together
can classify EVERY concept below (e.g. People/Actors, Facilities/Assets, Processes, Systems, Locations).

Concepts:
{json.dumps(terms)}

Source text for context:
{raw_text[:20000]}

Return a JSON array of bucket objects, each with exactly these keys:
- Concept_ID (String, must start with "B", e.g. "B001")
- Preferred_Term_PT (String, short bucket name)
- Broader_Term_BT (Array, always [])
- Narrower_Term_NT (Array, always [])
"""
    data = ask_json_fn(prompt, expect_list=True)
    buckets = []
    if isinstance(data, list):
        for i, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            cid = str(item.get("Concept_ID", "")).strip() or f"B{i + 1:03d}"
            if not cid.startswith("B"):
                cid = f"B{i + 1:03d}"
            term = str(item.get("Preferred_Term_PT", "")).strip() or cid
            buckets.append({
                "Concept_ID": cid,
                "Preferred_Term_PT": term,
                "Broader_Term_BT": [],
                "Narrower_Term_NT": [],
            })
    if not buckets:
        buckets = [{"Concept_ID": "B001", "Preferred_Term_PT": "General", "Broader_Term_BT": [], "Narrower_Term_NT": []}]
    return buckets


def _classify_batch(batch: list[dict], buckets: list[dict], raw_text: str, ask_json_fn) -> list[dict]:
    bucket_ref = [{"Concept_ID": b["Concept_ID"], "Preferred_Term_PT": b["Preferred_Term_PT"]} for b in buckets]
    prompt = f"""PHASE 3: Taxonomy (batch of {len(batch)})

Goal: Build a strict vertical hierarchy (parent-child relationships) for ONLY the concepts listed below,
using the FIXED top-level buckets provided. Do NOT invent new B-bucket IDs.

Fixed top-level buckets (use these IDs only, never invent new ones):
{json.dumps(bucket_ref)}

Concepts to classify ({len(batch)} total — output ALL of them, do not skip any):
{json.dumps(batch)}

Return a JSON array. Each item must have exactly these keys:
- Concept_ID (String)
- Preferred_Term_PT (String)
- Broader_Term_BT (Array of Concept_ID strings): the immediate parent only
- Narrower_Term_NT (Array of Concept_ID strings): leave empty unless the parent of another
  concept in THIS batch is this concept

Strict Rules (CRITICAL):
- Is-A / Part-Of ONLY: hierarchy must be strictly categorical or structural.
- INSTANCES GO UNDER CLASSES: Specific instances MUST be Narrower Terms (NT) of an abstract class
  from this same batch when one fits, instead of going directly under a bucket.
- DIRECT PARENT ONLY: list ONLY the immediate parent in BT. Never list a bucket if a closer parent exists.
- Every concept MUST resolve up to exactly one of the fixed buckets above (directly, or through a class parent).
- COMPLETENESS CRITICAL: You MUST output ALL {len(batch)} concept IDs listed above. Do NOT skip any. Do NOT stop early.

Source text for context:
{raw_text[:40000]}
"""
    data = ask_json_fn(prompt, expect_list=True)
    return data if isinstance(data, list) else []


def run(metadata_standard: list[dict], raw_text: str, ask_json_fn) -> list[dict]:
    compact_meta = [
        {"Concept_ID": item["Concept_ID"], "Preferred_Term_PT": item["Preferred_Term_PT"]}
        for item in metadata_standard
    ]
    expected_ids = {item["Concept_ID"] for item in metadata_standard}

    # STEP 1: Fixed buckets shared by every batch (keeps the hierarchy consistent).
    buckets = _establish_buckets(compact_meta, raw_text, ask_json_fn)

    # STEP 2: Classify concepts in small batches so no single LLM response is large
    # enough to hit the output-token ceiling and get truncated mid-word/mid-object.
    data: list = list(buckets)
    for batch in _chunks(compact_meta, BATCH_SIZE):
        data.extend(_classify_batch(batch, buckets, raw_text, ask_json_fn))

    returned_ids = {str(item.get("Concept_ID", "")).strip() for item in data if isinstance(item, dict)}
    missing = expected_ids - returned_ids

    # CHUNKED RETRY LOGIC: secondary safety net for anything a batch still missed
    max_retries = 3
    retries = 0
    chunk_size = 5  # Force the LLM to only process 5 missing items at a time
    bucket_ids_str = ", ".join(b["Concept_ID"] for b in buckets)

    while missing and retries < max_retries:
        missing_concepts = [
            {"Concept_ID": item["Concept_ID"], "Preferred_Term_PT": item["Preferred_Term_PT"]}
            for item in metadata_standard if item["Concept_ID"] in missing
        ]

        # Process the missing concepts in chunks
        for i in range(0, len(missing_concepts), chunk_size):
            chunk = missing_concepts[i:i + chunk_size]

            continuation_prompt = f"""CRITICAL ERROR: The previous taxonomy response was INCOMPLETE.
You skipped concepts. You MUST classify these specific {len(chunk)} concepts. DO NOT TRUNCATE.

Concepts to classify:
{json.dumps(chunk)}

Return ONLY these {len(chunk)} entries as a JSON array with the exact same keys:
- Concept_ID, Preferred_Term_PT, Broader_Term_BT, Narrower_Term_NT

Use ONLY these fixed top-level buckets as ultimate ancestors: {bucket_ids_str}.
Assign each concept to the most appropriate bucket or an intermediate class. Do NOT invent new buckets."""

            extra = ask_json_fn(continuation_prompt, expect_list=True)
            if isinstance(extra, list):
                data.extend(extra)  # Use extend instead of + to safely append to the list

        # Re-calculate missing IDs for the next iteration
        returned_ids = {str(item.get("Concept_ID", "")).strip() for item in data if isinstance(item, dict)}
        missing = expected_ids - returned_ids
        retries += 1

    return _normalize(data, metadata_standard)


def _normalize(data, metadata_standard: list[dict]) -> list[dict]:
    if not isinstance(data, list):
        data = []

    c_ids = {item["Concept_ID"] for item in metadata_standard}
    term_to_id = {item["Preferred_Term_PT"]: item["Concept_ID"] for item in metadata_standard}

    all_ids_in_output = set()
    for item in data:
        if isinstance(item, dict):
            cid = str(item.get("Concept_ID", "")).strip()
            if cid:
                all_ids_in_output.add(cid)
    valid_ids = c_ids | all_ids_in_output

    by_id = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        cid = str(item.get("Concept_ID", "")).strip()
        term = str(item.get("Preferred_Term_PT", "")).strip()
        if not cid and term in term_to_id:
            cid = term_to_id[term]
        if not cid:
            continue
        if not term:
            term = next((x["Preferred_Term_PT"] for x in metadata_standard if x["Concept_ID"] == cid), cid)

        bt = item.get("Broader_Term_BT")
        nt = item.get("Narrower_Term_NT")
        bt = bt if isinstance(bt, list) else []
        nt = nt if isinstance(nt, list) else []

        bt_ids = [_id_from_value(v, valid_ids, term_to_id) for v in bt]
        nt_ids = [_id_from_value(v, valid_ids, term_to_id) for v in nt]
        bt_ids = [x for x in bt_ids if x]
        nt_ids = [x for x in nt_ids if x]

        by_id[cid] = {
            "Concept_ID": cid,
            "Preferred_Term_PT": term,
            "Broader_Term_BT": list(dict.fromkeys(bt_ids)),
            "Narrower_Term_NT": list(dict.fromkeys(nt_ids)),
        }

    # Safety Net: Ensure all original concepts exist in the graph
    for item in metadata_standard:
        cid = item["Concept_ID"]
        if cid not in by_id:
            by_id[cid] = {
                "Concept_ID": cid,
                "Preferred_Term_PT": item["Preferred_Term_PT"],
                "Broader_Term_BT": [],
                "Narrower_Term_NT": [],
            }

    # Ensure Bidirectionality
    for cid, concept in by_id.items():
        for bt_id in concept["Broader_Term_BT"]:
            if bt_id in by_id and cid not in by_id[bt_id]["Narrower_Term_NT"]:
                by_id[bt_id]["Narrower_Term_NT"].append(cid)
        for nt_id in concept["Narrower_Term_NT"]:
            if nt_id in by_id and cid not in by_id[nt_id]["Broader_Term_BT"]:
                by_id[nt_id]["Broader_Term_BT"].append(cid)

    def get_ancestors(cid: str, visited: set | None = None) -> set[str]:
        if visited is None:
            visited = set()
        if cid in visited:
            return set()
        visited.add(cid)
        ancestors = set()
        for parent in by_id.get(cid, {}).get("Broader_Term_BT", []):
            ancestors.add(parent)
            ancestors |= get_ancestors(parent, visited)
        return ancestors

    # Remove Transitive/Grandparent links (Direct Parent Only enforcement)
    for cid, concept in list(by_id.items()):
        bts = concept["Broader_Term_BT"]
        if len(bts) <= 1:
            continue
        to_remove = set()
        for bt in bts:
            ancestors_of_bt = get_ancestors(bt)
            for other_bt in bts:
                if other_bt != bt and other_bt in ancestors_of_bt:
                    to_remove.add(other_bt)
        if not to_remove:
            c_parents = [b for b in bts if not b.startswith("B")]
            b_parents = [b for b in bts if b.startswith("B")]
            if c_parents and b_parents:
                to_remove = set(b_parents)
        if not to_remove:
            root_bts = [b for b in bts if not by_id.get(b, {}).get("Broader_Term_BT")]
            if len(root_bts) > 1:
                to_remove = set(root_bts[1:])
        if to_remove:
            concept["Broader_Term_BT"] = [b for b in bts if b not in to_remove]
            for removed_bt in to_remove:
                if removed_bt in by_id and cid in by_id[removed_bt]["Narrower_Term_NT"]:
                    by_id[removed_bt]["Narrower_Term_NT"].remove(cid)

    # Attach floating nodes to a fallback bucket
    bucket_ids = [k for k in by_id if k.startswith("B")]
    fallback_bucket = bucket_ids[0] if bucket_ids else None
    for cid, concept in by_id.items():
        if cid.startswith("B"):
            continue
        if not concept["Broader_Term_BT"] and fallback_bucket:
            concept["Broader_Term_BT"] = [fallback_bucket]
            if cid not in by_id[fallback_bucket]["Narrower_Term_NT"]:
                by_id[fallback_bucket]["Narrower_Term_NT"].append(cid)

    def _connected_components(nodes: dict) -> list[set]:
        visited: set[str] = set()
        components: list[set] = []
        for start in nodes:
            if start in visited:
                continue
            component: set[str] = set()
            stack = [start]
            while stack:
                node = stack.pop()
                if node in visited:
                    continue
                visited.add(node)
                component.add(node)
                neighbours = (
                    nodes[node]["Broader_Term_BT"] +
                    nodes[node]["Narrower_Term_NT"]
                )
                stack.extend(n for n in neighbours if n in nodes and n not in visited)
            components.append(component)
        return components

    # Merge any remaining disconnected components (e.g. separate bucket trees) into the
    # primary one by attaching each stray component's root(s) under the fallback bucket.
    # IMPORTANT: never delete concepts here — a previous version dropped every concept
    # outside the largest component, which silently destroyed valid Phase 1/2 data.
    components = _connected_components(by_id)
    if len(components) > 1 and fallback_bucket:
        primary = next((c for c in components if fallback_bucket in c), max(components, key=len))
        for component in components:
            if component is primary:
                continue
            roots = [cid for cid in component if cid.startswith("B") and not by_id[cid]["Broader_Term_BT"]]
            if not roots:
                roots = [cid for cid in component if cid.startswith("B")]
            if not roots:
                roots = [next(iter(component))]
            for root_id in roots:
                if root_id == fallback_bucket:
                    continue
                if fallback_bucket not in by_id[root_id]["Broader_Term_BT"]:
                    by_id[root_id]["Broader_Term_BT"].append(fallback_bucket)
                if root_id not in by_id[fallback_bucket]["Narrower_Term_NT"]:
                    by_id[fallback_bucket]["Narrower_Term_NT"].append(root_id)

    bucket_nodes = [v for k, v in by_id.items() if k.startswith("B")]
    c_nodes = [by_id[item["Concept_ID"]] for item in metadata_standard if item["Concept_ID"] in by_id]
    return bucket_nodes + c_nodes


def _id_from_value(value, valid_ids: set[str], term_to_id: dict[str, str]) -> str | None:
    raw = str(value).strip()
    if not raw:
        return None
    if raw in valid_ids:
        return raw
    return term_to_id.get(raw)