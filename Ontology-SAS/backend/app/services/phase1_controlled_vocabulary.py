from app.services.llm_helper import generate_description


def run(raw_text: str, ask_json_fn) -> list[dict]:
    prompt = f"""PHASE 1: Controlled Vocabulary

Goal: Extract HIGH-VALUE DOMAIN ENTITIES and CORE DOMAIN CLASSES from the source text — the named things and infrastructure types that would become nodes in a knowledge graph. Deduplicate interchangeable terms and capture exact aliases.

Return a JSON array. Each item must have exactly these keys:
- Approved_Term (String): the canonical/preferred term, most formal version.
- Aliases (Array of Strings): exact synonyms, alternate spellings, or abbreviations found explicitly in the text. If none exist, return an empty array [].

Strict Rules (CRITICAL — violating any rule invalidates your output):

1. DOMAIN ENTITIES ONLY — NO IRRELEVANT FLUFF: Only extract terms that are meaningful in a logistics knowledge graph. 
   EXTRACT: Named organizations, subsidiaries, branded services, specific facilities (e.g., "PostNord", "Hallsberg").
   DO NOT EXTRACT: Irrelevant everyday nouns (e.g., "weeks", "team", "door", "box", "roofs", "panels", "country", "goods", "vehicles", "fuels"). 

1.5. YOU MUST INCLUDE ABSTRACT DOMAIN CLASSES: While you must ignore irrelevant fluff, you MUST aggressively extract the foundational abstract concepts and infrastructure types defined in the text, even if they are not capitalized proper nouns. 

2. KEEP MULTI-WORD ENTITIES INTACT: Named entities that consist of multiple words MUST be extracted as a single complete term. If the text says "PostNord TPL", extract "PostNord TPL". When an entity appears both standalone and as part of a larger name, extract BOTH.

3. NO VERBS, ADJECTIVES, OR ADVERBS: Extract ONLY nouns and noun phrases. Exclude:
   - Verbs (e.g., "track", "deliver")
   - Standalone adjectives (e.g., "Swedish", "green")
   Adjectives are allowed ONLY when part of an official proper noun (e.g., "Universal Service Obligation").

4. EXACT EXTRACTION: Extract terms EXACTLY as they appear in the source text. Do NOT invent or combine terms.

5. STRICT ALIASES — SYNONYMS ONLY: An alias must be an alternate proper name or acronym for the EXACT SAME entity. NEVER include:
   - Definitions or functional descriptions (e.g., "Central rail hub" is NOT an alias for "Hallsberg")
   - Geographic descriptions (e.g., "Stockholm area terminal" is NOT an alias for "Rosersberg")
   If it describes WHAT the entity is rather than being another NAME for it, leave Aliases empty [].

6. NO WORD ASSOCIATION: Do NOT group related words as aliases. A location is NOT an alias for the entity at that location.

7. ENTITY vs DESCRIPTION: The Approved_Term must be the actual entity noun, not a descriptive label. 

8. NO ENTITY MERGING: Keep distinct sub-entities, departments, or subsidiaries as SEPARATE concepts.

9. MERGE INTERCHANGEABLE TERMS: Combine ONLY truly identical/interchangeable terms. 

10. NO INVENTED ACRONYMS: Do NOT add acronyms unless explicitly in the text.

11. FLAT STRUCTURE: No IDs, no hierarchies.

12. UNIQUENESS: Every Approved_Term must be entirely unique across the output.

13. SERVICES ARE NOT ALIASES: Multiple services provided by one organization are separate concepts.

Source text:
{raw_text[:120000]}
"""
    data = ask_json_fn(prompt, expect_list=True)
    return _normalize(data)


def _normalize(data) -> list[dict]:
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
            # Skip empty, same-as-term, duplicate, or sentence-length aliases
            if (a and a.lower() != term.lower()
                    and a not in normalized_aliases
                    and len(a.split()) <= 6):
                normalized_aliases.append(a)

        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"Approved_Term": term, "Aliases": normalized_aliases})
    return out
