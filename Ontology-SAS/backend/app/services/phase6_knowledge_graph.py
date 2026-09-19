import json


def run(thesaurus: list[dict], ontology: dict, namespace_uri: str, ask_json_fn=None) -> dict:
    id_map = {item["Concept_ID"]: item for item in thesaurus}
    pt_to_id = {item["PT"]: item["Concept_ID"] for item in thesaurus}

    object_properties = ontology.get("Object_Properties", []) if isinstance(ontology, dict) else []
    concept_class_rows = ontology.get("Concept_Class_Map", []) if isinstance(ontology, dict) else []

    class_map: dict[str, str] = {}
    if isinstance(concept_class_rows, list):
        for row in concept_class_rows:
            if not isinstance(row, dict):
                continue
            cid = str(row.get("Concept_ID", "")).strip()
            class_name = str(row.get("Class", "")).strip()
            if cid and class_name:
                class_map[cid] = class_name

    property_rules = []
    for prop in object_properties:
        if not isinstance(prop, dict):
            continue
        verb_raw = str(prop.get("Verb", "")).strip()
        domain = str(prop.get("Domain", "Concept")).strip() or "Concept"
        range_value = str(prop.get("Range", "Concept")).strip() or "Concept"
        if not verb_raw:
            continue
        property_rules.append({
            "Verb": verb_raw,
            "Verb_Key": _verb_key(verb_raw),
            "Domain": domain,
            "Range": range_value,
        })

    if not property_rules:
        property_rules = [
            {"Verb": "is_related_to", "Verb_Key": "is_related_to", "Domain": "Concept", "Range": "Concept"},
        ]

    context = {
        "skos": "http://www.w3.org/2004/02/skos/core#",
        "ex": f"{namespace_uri}ontology/",
    }
    used_verbs: set[str] = set()

    graph = []
    for item in thesaurus:
        cid = item["Concept_ID"]
        source_class = class_map.get(cid, "Concept")
        node = {
            "@id": f"concept:{cid}",
            "@type": source_class,
            "skos:prefLabel": str(item.get("PT", "")).strip() or cid,
            "skos:scopeNote": str(item.get("Scope_Note_SN", "")).strip() or f"Use for {item.get('PT', cid)}.",
        }

        alt_labels = [str(v).strip() for v in item.get("UF", []) if str(v).strip()]
        if alt_labels:
            node["skos:altLabel"] = alt_labels

        bt_targets = _resolve_targets(item.get("BT", []), id_map, pt_to_id)
        nt_targets = _resolve_targets(item.get("NT", []), id_map, pt_to_id)
        rt_targets = _resolve_targets(item.get("Related_Term_RT", []), id_map, pt_to_id)

        _attach_relation(node, "BT", bt_targets, source_class, class_map, property_rules, used_verbs)
        _attach_relation(node, "NT", nt_targets, source_class, class_map, property_rules, used_verbs)
        _attach_relation(node, "RT", rt_targets, source_class, class_map, property_rules, used_verbs)

        graph.append(node)

    for rule in property_rules:
        verb_key = rule["Verb_Key"]
        if ":" in rule["Verb"]:
            continue
        if verb_key not in context:
            context[verb_key] = {"@id": f"ex:{verb_key}", "@type": "@id"}

    if ask_json_fn is not None:
        _bridge_disconnected_components(graph, context, ask_json_fn)

    return {"@context": context, "@graph": graph}


def _weakly_connected_components(graph: list[dict]) -> list[set[str]]:
    """Treat every '@id'-referencing property as an undirected edge and find
    the weakly-connected components of the resulting graph."""
    adjacency: dict[str, set[str]] = {node["@id"]: set() for node in graph}
    skip_keys = {"@id", "@type", "skos:prefLabel", "skos:altLabel", "skos:scopeNote"}
    for node in graph:
        src = node["@id"]
        for key, value in node.items():
            if key in skip_keys:
                continue
            targets = value if isinstance(value, list) else [value]
            for target in targets:
                if isinstance(target, str) and target in adjacency and target != src:
                    adjacency[src].add(target)
                    adjacency[target].add(src)

    visited: set[str] = set()
    components: list[set[str]] = []
    for node_id in adjacency:
        if node_id in visited:
            continue
        stack = [node_id]
        component: set[str] = set()
        while stack:
            current = stack.pop()
            if current in visited:
                continue
            visited.add(current)
            component.add(current)
            stack.extend(adjacency[current] - visited)
        components.append(component)
    return components


def _representative_concepts(component: set[str], nodes_by_id: dict, limit: int = 8) -> list[dict]:
    reps = []
    for node_id in list(component)[:limit]:
        node = nodes_by_id[node_id]
        reps.append({
            "Concept_ID": node_id.replace("concept:", "", 1),
            "Label": node.get("skos:prefLabel", node_id),
        })
    return reps


def _bridge_disconnected_components(graph: list[dict], context: dict, ask_json_fn) -> None:
    """If the graph is split into multiple disconnected clusters (e.g. separate
    taxonomy buckets with no associative relationship between them), ask the LLM
    — using general world/domain knowledge, not just the source text — to propose
    a bridging relationship between the two largest clusters. Repeat until the
    graph is a single connected component or every initial cluster has been
    considered, whichever comes first."""
    if len(graph) < 2:
        return

    nodes_by_id = {node["@id"]: node for node in graph}
    initial_components = _weakly_connected_components(graph)
    max_rounds = max(0, len(initial_components) - 1)

    rounds = 0
    while rounds < max_rounds:
        components = _weakly_connected_components(graph)
        if len(components) <= 1:
            return

        components.sort(key=len, reverse=True)
        main_component, other_component = components[0], components[1]

        prompt = f"""You are connecting two clusters of a knowledge graph that currently have NO relationship
between them.

Cluster A concepts:
{json.dumps(_representative_concepts(main_component, nodes_by_id))}

Cluster B concepts:
{json.dumps(_representative_concepts(other_component, nodes_by_id))}

Using your general world/domain knowledge (you are NOT limited to any source document), propose the SINGLE
most plausible real-world relationship connecting one concept in Cluster A to one concept in Cluster B.

Return a JSON object with exactly these keys:
- Source_Concept_ID (String): a Concept_ID from Cluster A
- Target_Concept_ID (String): a Concept_ID from Cluster B
- Verb (String): a short relationship verb, e.g. "relates_to", "operates_within", "is_associated_with"
- Reason (String): one short sentence justifying the relationship

Never leave this empty — if no obvious relationship exists, still return your best general-domain guess."""

        result = ask_json_fn(prompt, expect_list=False)
        edge = result if isinstance(result, dict) else {}

        src_id = str(edge.get("Source_Concept_ID", "")).strip()
        tgt_id = str(edge.get("Target_Concept_ID", "")).strip()
        verb = str(edge.get("Verb", "")).strip() or "is_related_to"
        reason = str(edge.get("Reason", "")).strip()

        src_full = src_id if src_id.startswith("concept:") else f"concept:{src_id}"
        tgt_full = tgt_id if tgt_id.startswith("concept:") else f"concept:{tgt_id}"

        if src_full not in main_component or tgt_full not in other_component:
            # LLM picked an invalid/out-of-cluster id — fall back to a deterministic
            # bridge so the graph still converges to a single component.
            src_full = next(iter(main_component))
            tgt_full = next(iter(other_component))
            verb = "is_related_to"
            reason = ""

        verb_key = _verb_key(verb)
        if verb_key not in context:
            context[verb_key] = {"@id": f"ex:{verb_key}", "@type": "@id"}

        src_node = nodes_by_id[src_full]
        src_node.setdefault(verb_key, [])
        if tgt_full not in src_node[verb_key]:
            src_node[verb_key].append(tgt_full)

        if reason:
            tgt_node = nodes_by_id[tgt_full]
            note = str(tgt_node.get("skos:scopeNote", "")).strip()
            addendum = f" (Inferred link via general domain knowledge: {reason})"
            if addendum not in note:
                tgt_node["skos:scopeNote"] = (note + addendum).strip()

        rounds += 1


def _verb_key(verb: str) -> str:
    cleaned = []
    for char in verb.strip():
        if char.isalnum():
            cleaned.append(char.lower())
        else:
            cleaned.append("_")
    key = "".join(cleaned)
    while "__" in key:
        key = key.replace("__", "_")
    key = key.strip("_")
    return key or "related_to"


def _match_property_rule(source_class: str, target_class: str, relation_type: str, property_rules: list[dict]) -> str | None:
    src = source_class.lower()
    tgt = target_class.lower()

    def class_match(rule_class: str, current: str) -> bool:
        return rule_class.lower() in {"concept", "any", current}

    # 1. TAXONOMIC COLLISION AVOIDANCE
    # If the graph attempts an "Is-A" relationship between mismatched classes (e.g., Location is a Organization),
    # we intercept it and treat it as a cross-class associative relationship instead.
    is_hierarchical = relation_type in ("BT", "NT")
    classes_differ = (src != tgt and src != "concept" and tgt != "concept")
    
    if is_hierarchical and not classes_differ:
        return "skos:broader" if relation_type == "BT" else "skos:narrower"

    # 2. ASSOCIATIVE (RT) LOGIC (and fallback for converted hierarchical links)
    
    # First Pass: Strict domain/range matches (Ignoring the universal Concept wildcard)
    for rule in property_rules:
        r_dom = rule["Domain"].lower()
        r_ran = rule["Range"].lower()
        if r_dom != "concept" and r_ran != "concept":
            if class_match(r_dom, src) and class_match(r_ran, tgt):
                return rule["Verb_Key"]

    # Second Pass: Include wildcards (e.g. Concept -> Concept)
    for rule in property_rules:
        if class_match(rule["Domain"], src) and class_match(rule["Range"], tgt):
            return rule["Verb_Key"]

    # Third Pass: Partial match on Domain only
    for rule in property_rules:
        if class_match(rule["Domain"], src):
            return rule["Verb_Key"]

    # Fourth Pass: Partial match on Range only
    for rule in property_rules:
        if class_match(rule["Range"], tgt):
            return rule["Verb_Key"]

    if property_rules:
        return property_rules[0]["Verb_Key"]
        
    return "skos:related"


def _attach_relation(node, relation_type, targets, source_class, target_class_map, property_rules, used_verbs):
    if not targets:
        return
    grouped: dict[str, list[str]] = {}
    for target in targets:
        target_cid = target.replace("concept:", "", 1)
        target_class = target_class_map.get(target_cid, "Concept")
        verb_key = _match_property_rule(source_class, target_class, relation_type, property_rules)
        if verb_key is None:
            continue
        grouped.setdefault(verb_key, []).append(target)
        
    for verb_key, values in grouped.items():
        # Using dict.fromkeys to safely merge and deduplicate if converted BTs and existing RTs share a verb
        if verb_key in node:
            node[verb_key].extend(values)
            node[verb_key] = list(dict.fromkeys(node[verb_key]))
        else:
            node[verb_key] = list(dict.fromkeys(values))
        used_verbs.add(verb_key)


def _resolve_targets(values: list, id_map: dict, pt_to_id: dict) -> list[str]:
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