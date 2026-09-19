def run(controlled_vocab: list[dict]) -> list[dict]:
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
