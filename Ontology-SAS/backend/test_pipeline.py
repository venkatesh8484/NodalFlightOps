"""Test LLM connectivity and pipeline phase 1."""
import sys
import time
import traceback
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger("test_pipeline")

try:
    from app.services.llm_helper import AZURE_KEY, AZURE_ENDPOINT, AZURE_DEPLOYMENT, AZURE_API_VERSION, generate_description
    from app.services.SixPhaseOntologyPipeline import SixPhaseOntologyPipeline

    logger.info(f"AZURE_ENDPOINT  : {AZURE_ENDPOINT}")
    logger.info(f"AZURE_DEPLOYMENT: {AZURE_DEPLOYMENT}")
    logger.info(f"AZURE_API_VERSION: {AZURE_API_VERSION}")
    logger.info(f"AZURE_KEY set   : {'YES' if AZURE_KEY else 'NO'}")

    # --- Test 1: simple hi ---
    logger.info("\n[TEST 1] Sending 'hi'...")
    t0 = time.time()
    resp = generate_description("hi", max_tokens=50, system="Reply briefly.")
    logger.info(f"Response ({time.time()-t0:.1f}s): {resp}")

    # --- Test 2: JSON response ---
    logger.info("\n[TEST 2] JSON response test...")
    t0 = time.time()
    resp = generate_description(
        prompt='Return a JSON array with 2 items. Each item has keys: Approved_Term (string) and Aliases (array of strings).',
        max_tokens=200,
        system='Return strict JSON only. No markdown.',
        response_format='json'
    )
    logger.info(f"JSON response ({time.time()-t0:.1f}s): {resp}")

    import json
    parsed = json.loads(resp)
    logger.info(f"Parsed OK - {len(parsed)} items")

    # --- Test 3: Pipeline phase 1 ---
    logger.info("\n[TEST 3] Running pipeline Phase 1 (Controlled Vocabulary)...")
    t0 = time.time()
    service = SixPhaseOntologyPipeline()
    test_text = "PostNord is a logistics company in Sweden providing parcel and mail delivery through sorting centers."
    from app.services import phase1_controlled_vocabulary
    cv = phase1_controlled_vocabulary.run(test_text, service._ask_json)
    logger.info(f"Phase 1 done ({time.time()-t0:.1f}s) - {len(cv)} terms extracted")
    for item in cv[:5]:
        logger.info(f"  {item['Approved_Term']} -> {item.get('Aliases', [])}")

    print("\n" + "="*50)
    print("ALL TESTS PASSED — pipeline is working.")
    print("="*50)

except Exception as e:
    logger.error(f"FAILED: {e}")
    traceback.print_exc()
    sys.exit(1)
