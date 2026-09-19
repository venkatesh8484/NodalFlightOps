import json


def run(thesaurus: list[dict], raw_text: str, ask_json_fn) -> dict:
    compact_concepts = [
        {"Concept_ID": item["Concept_ID"], "PT": item["PT"]}
        for item in thesaurus
    ]
    prompt = f"""PHASE 5: Ontology

Goal: Define the abstract "laws of physics" for the data model — the classes and relationship rules.

Return a JSON object with exactly these keys:
- Classes (Array of Strings): abstract meta-category names
- Object_Properties (Array of objects with: Verb, Domain, Range)
- Concept_Class_Map (Array of objects with: Concept_ID, Class)

Strict Rules (CRITICAL):
- Abstract Classes Only: classes must be meta-categories (e.g. Organization, Location, Document, Process, Person, Facility, Service, Product, Event, Policy). NEVER use specific instance names as Classes. Derive as many distinct classes as the data warrants — do NOT collapse everything into 3-4 classes.
- PHYSICAL VS INTANGIBLE: Do not confuse physical infrastructure (e.g., Parcel lockers, Service points, Terminals) with the intangible services they provide. Physical objects MUST be classified under a physical class like Facility, Asset, or Infrastructure, never as a Service.
- PROTECT TAXONOMY: Object Properties define associative, cross-class relationships (how different things interact, e.g., Organization owns Facility). Do NOT invent verbs that redefine strict hierarchical (Is-A/Part-Of) relationships (like "includes" or "is_type_of"), as those are handled separately by the taxonomy.
- Domain and Range: every Object_Property must define exactly which classes can connect. Example: {{"Verb": "employs", "Domain": "Organization", "Range": "Person"}}.
- RICH VERB SET REQUIRED: You MUST define a rich, domain-specific set of verbs that reflect the actual relationships in the data (e.g. owns, employs, operates, located_in, manages, delivers, provides, governs, reports_to). Do NOT use only generic verbs.
- RECIPROCAL VERB PAIRS REQUIRED: For every top-down verb (e.g. "owns", "operates"), define its bottom-up reciprocal (e.g. "is_owned_by", "is_operated_by"). They must NEVER be the same word.
- UNIVERSAL FALLBACK REQUIRED: Include at least one verb pair where both Domain and Range are "Concept", for example {{"Verb": "is_related_to", "Domain": "Concept", "Range": "Concept"}}. Do NOT use "has_broader" or "has_narrower" as verb names.
- Concept_Class_Map: assign EVERY Concept_ID below to exactly ONE class. Do not skip any ID.

Concepts to classify:
{json.dumps(compact_concepts, indent=2)}

Source text for context:
{raw_text[:40000]}
"""
    data = ask_json_fn(prompt)
    return _normalize(data, thesaurus)


def _normalize(data, thesaurus: list[dict]) -> dict:
    if not isinstance(data, dict):
        data = {}

    classes_raw = data.get("Classes") if isinstance(data.get("Classes"), list) else []
    classes = []
    for class_name in classes_raw:
        text = str(class_name).strip()
        if text and text not in classes:
            classes.append(text)
    if "Concept" not in classes:
        classes.append("Concept")

    props = data.get("Object_Properties")
    if not isinstance(props, list):
        props = []

    normalized_props = []
    seen_prop = set()
    for prop in props:
        if not isinstance(prop, dict):
            continue
        verb = str(prop.get("Verb", "")).strip()
        domain = str(prop.get("Domain", "")).strip() or "Concept"
        range_value = str(prop.get("Range", "")).strip() or "Concept"
        if not verb:
            continue
        key = (verb.lower(), domain.lower(), range_value.lower())
        if key in seen_prop:
            continue
        seen_prop.add(key)
        normalized_props.append({"Verb": verb, "Domain": domain, "Range": range_value})

    _guaranteed = [
        {"Verb": "is_related_to", "Domain": "Concept", "Range": "Concept"},
    ]
    existing_verbs = {p["Verb"].lower() for p in normalized_props}
    for g in _guaranteed:
        if g["Verb"].lower() not in existing_verbs:
            normalized_props.append(g)

    if not normalized_props:
        normalized_props = [
            {"Verb": "is_related_to", "Domain": "Concept", "Range": "Concept"},
        ]

    class_rows = data.get("Concept_Class_Map") if isinstance(data.get("Concept_Class_Map"), list) else []
    class_by_id = {}
    valid_ids = {item["Concept_ID"] for item in thesaurus}
    class_lookup = {c.lower(): c for c in classes}

    for row in class_rows:
        if not isinstance(row, dict):
            continue
        cid = str(row.get("Concept_ID", "")).strip()
        class_name_raw = str(row.get("Class", "")).strip()
        if cid not in valid_ids or not class_name_raw:
            continue
        class_by_id[cid] = class_lookup.get(class_name_raw.lower(), class_name_raw)

    def _infer_class(pt: str, known_classes: list[str]) -> str:
        pt_lower = pt.lower().replace(" ", "").replace("_", "")
        for cls in known_classes:
            if cls == "Concept":
                continue
            cls_lower = cls.lower().replace(" ", "").replace("_", "")
            if cls_lower in pt_lower or pt_lower in cls_lower:
                return cls
        return "Concept"

    for item in thesaurus:
        cid = item["Concept_ID"]
        if cid not in class_by_id:
            class_by_id[cid] = _infer_class(item.get("PT", ""), classes)

    ordered_class_map = [
        {"Concept_ID": item["Concept_ID"], "Class": class_by_id.get(item["Concept_ID"], "Concept")}
        for item in thesaurus
    ]

    return {"Classes": classes, "Object_Properties": normalized_props, "Concept_Class_Map": ordered_class_map}
