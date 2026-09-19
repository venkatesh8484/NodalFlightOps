# Ontology Pipeline Articulation Notes

This document gives brief notes for each step in the ontology pipeline.

## Model Used

- The pipeline uses the Databricks AI Gateway model configured in `.env` through `DATABRICKS_MODEL`.
- Example model: `databricks-claude-opus-5`.
- The same configured model is used in AI-driven steps to keep outputs consistent.

## Step 1: Controlled Vocabulary

Activities performed:

- Extract key terms from uploaded text.
- Collect possible aliases for each term.
- Remove duplicates and noisy entries.
- Keep terms focused on domain meaning (not general stop words).

What gets added:

- Approved term list.
- Alias list for each approved term.

Technical aspects:

- AI prompt asks only for term and alias extraction.
- Output is normalized into a clean JSON list.
- Prompt scope is intentionally narrow so Step 1 does not introduce hierarchy yet.

Outcome:

- A clean domain term foundation for all next steps.
- Reduces ambiguity before IDs and relationships are introduced.

## Step 2: Metadata Standard

Activities performed:

- Assign unique concept IDs to each approved term.
- Standardize naming and status fields.
- Convert vocabulary terms into a registry-like structure.
- Align metadata keys with ISO-style naming used in terminology systems.

What gets added:

- Concept ID.
- Preferred Term (PT).
- Used For (UF) aliases.
- Status field.

Technical aspects:

- Deterministic mapping from Step 1 output.
- No model dependency in this step.
- Formatting rules are fixed to ensure predictable downstream mapping.
- ISO references used:
	- ISO 25964-1 (Thesauri and interoperability with other vocabularies): PT (Preferred Term), UF (Used For).
	- ISO/IEC 11179 (Metadata registries): identifier and status style fields.
- ISO-aligned keys included in this step: `Concept_ID`, `Preferred_Term_PT`, `Used_For_UF`, `Status`.

Outcome:

- Structured concept registry ready for hierarchy building.
- Gives every concept a stable identifier for later linking.

## Step 3: Taxonomy

Activities performed:

- Build hierarchical relationships.
- Identify broader and narrower concept links.
- Check that parent-child placement is logically consistent.

What gets added:

- Broader Term links (BT).
- Narrower Term links (NT).

Technical aspects:

- AI prompt restricted to hierarchy only.
- Validation ensures links map to valid concept IDs.
- This separation prevents mixing hierarchy with associative semantics too early.

Outcome:

- A valid concept hierarchy (parent child structure).
- Produces a clear tree-like backbone for semantic navigation.

## Step 4: Thesaurus

Activities performed:

- Enrich taxonomy with semantic details.
- Add scope notes and associative relations.
- Capture near-synonyms and contextual usage notes.

What gets added:

- PT and UF alignment.
- BT and NT carry forward.
- Related Terms (RT).
- Scope Note (SN).

Technical aspects:

- AI prompt combines controlled vocabulary, taxonomy, and source context.
- Post-processing normalizes fields for consistency.
- RT links add lateral meaning across branches, not just vertical hierarchy.

Outcome:

- A richer semantic layer for search and understanding.
- Supports both precise lookup and broader concept discovery.

## Step 5: Ontology

Activities performed:

- Define abstract classes.
- Define object properties between concept types.
- Convert thesaurus semantics into reusable conceptual rules.

What gets added:

- Class list.
- Object property list with verb, domain, and range.

Technical aspects:

- AI prompt requests high-level ontology rules.
- Fallback defaults are added when properties are missing.
- Domain/range constraints keep relation meaning explicit.

Outcome:

- Formal semantic model that explains how concepts can relate.
- Makes the model easier to extend for future datasets.

## Step 6: Knowledge Graph (JSON-LD)

Activities performed:

- Convert thesaurus and ontology into machine-readable graph form.
- Build concept nodes and semantic edges.
- Materialize relationships into linkable graph entities.

What gets added:

- JSON-LD context.
- Graph nodes for concepts.
- Relationship edges using ontology verbs.

Technical aspects:

- IDs are resolved and linked consistently.
- Output format is JSON-LD for interoperability.
- Context definitions help external systems interpret predicates correctly.

Outcome:

- Final graph output ready for integration, querying, and downstream use.
- Enables use in semantic apps, graph tooling, and API-driven workflows.

## Final Note

The pipeline is incremental:

- Each step builds on the previous step.
- Structure grows from simple terms to a formal knowledge graph.
- Outputs are generated as JSON and stage files for practical use.
