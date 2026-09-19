"""
LLM integration helpers.

Functions:
- generate_description: Generate description using LLM (Databricks, Azure OpenAI, or OpenAI)
- get_crewai_llm: Get configured CrewAI LLM instance

Configuration (set MODEL_PROVIDER in .env to force a provider, or let auto-detect pick one):
- MODEL_PROVIDER: "databricks" | "azure" | "openai"  (auto-detects if omitted)
- Databricks: DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_MODEL
- Azure OpenAI: AZURE_OPENAI_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT_ID
- OpenAI: OPENAI_API_KEY, OPENAI_MODEL
"""

import os
import random
import time
from pathlib import Path
from dotenv import load_dotenv

# Load .env from the backend directory (2 levels up from this file)
_backend_dir = Path(__file__).resolve().parents[2]
_env_path = _backend_dir / ".env"
load_dotenv(dotenv_path=_env_path)

# --- Provider credentials ---------------------------------------------------
# Databricks
DATABRICKS_HOST = os.getenv('DATABRICKS_HOST', '').rstrip('/')
DATABRICKS_TOKEN = os.getenv('DATABRICKS_TOKEN')
DATABRICKS_MODEL = os.getenv('DATABRICKS_MODEL', 'databricks-gpt-5-4-mini')
DATABRICKS_VERIFY_SSL = os.getenv('DATABRICKS_VERIFY_SSL', 'true').lower() not in ('false', '0', 'no')

# Azure OpenAI
AZURE_KEY = os.getenv('AZURE_OPENAI_KEY')
AZURE_ENDPOINT = os.getenv('AZURE_OPENAI_ENDPOINT')
AZURE_DEPLOYMENT = os.getenv('AZURE_OPENAI_DEPLOYMENT_ID')
AZURE_API_VERSION = os.getenv('AZURE_OPENAI_API_VERSION', '2024-02-01')
AZURE_VERIFY_SSL = os.getenv('AZURE_OPENAI_VERIFY_SSL', 'true').lower() not in ('false', '0', 'no')

# Standard OpenAI
MODEL = os.getenv('OPENAI_MODEL', 'gpt-4o-mini')
API_KEY = os.getenv('OPENAI_API_KEY')

# --- Transient network error retry (large multi-file uploads make dozens of
# sequential calls; a single "server disconnected" blip should not kill the
# whole pipeline) -------------------------------------------------------------
LLM_MAX_RETRIES = int(os.getenv('LLM_MAX_RETRIES', '4'))
LLM_RETRY_BASE_DELAY = float(os.getenv('LLM_RETRY_BASE_DELAY', '2'))

_TRANSIENT_EXC_NAMES = {
    'APIConnectionError',
    'APITimeoutError',
    'RemoteProtocolError',
    'ConnectError',
    'ConnectTimeout',
    'ReadTimeout',
    'ReadError',
    'WriteTimeout',
    'PoolTimeout',
    'RateLimitError',
    'InternalServerError',
    'APIStatusError',
}


def _is_transient(exc: BaseException) -> bool:
    """Walk the exception chain (openai wraps httpx errors via __cause__) and
    check whether this looks like a transient network/server hiccup rather
    than a real config/auth/validation failure."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if type(current).__name__ in _TRANSIENT_EXC_NAMES:
            return True
        current = current.__cause__
    return False


def _call_with_retry(fn, max_retries: int = LLM_MAX_RETRIES, base_delay: float = LLM_RETRY_BASE_DELAY):
    """Call fn() with exponential-backoff retry on transient network errors.
    Non-transient errors (bad auth, bad request, etc.) are raised immediately."""
    last_exc: BaseException | None = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if not _is_transient(exc) or attempt == max_retries - 1:
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0, 1)
            time.sleep(delay)
    raise last_exc  # pragma: no cover - unreachable, loop always raises or returns

# --- Auto-detect provider (override with MODEL_PROVIDER env var) ------------
_env_provider = os.getenv('MODEL_PROVIDER')
if _env_provider:
    MODEL_PROVIDER = _env_provider.lower()
else:
    if DATABRICKS_HOST and DATABRICKS_TOKEN:
        MODEL_PROVIDER = 'databricks'
    elif AZURE_KEY and AZURE_ENDPOINT and AZURE_DEPLOYMENT:
        MODEL_PROVIDER = 'azure'
    elif API_KEY:
        MODEL_PROVIDER = 'openai'
    else:
        MODEL_PROVIDER = 'none'


def generate_description(prompt, max_tokens=8000, system: str | None = None, response_format: str = 'text'):
    """Generate a description via the configured LLM provider.

    Provider priority (override with MODEL_PROVIDER env var):
      1. Databricks  (DATABRICKS_HOST + DATABRICKS_TOKEN)
      2. Azure OpenAI (AZURE_OPENAI_KEY + ENDPOINT + DEPLOYMENT_ID)
      3. OpenAI       (OPENAI_API_KEY)
      4. Mock fallback
    """
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    kwargs_base = dict(messages=messages, max_tokens=max_tokens, temperature=0)
    if response_format == 'json':
        kwargs_base['response_format'] = {'type': 'json_object'}

    # ── Databricks (OpenAI-compatible API) ──────────────────────────────
    if MODEL_PROVIDER == 'databricks':
        if not (DATABRICKS_HOST and DATABRICKS_TOKEN):
            raise RuntimeError(
                "Databricks mode requires DATABRICKS_HOST and DATABRICKS_TOKEN in .env"
            )
        try:
            import httpx
            from openai import OpenAI
            http_client = httpx.Client(
                timeout=600,
                verify=DATABRICKS_VERIFY_SSL,
            )
            client = OpenAI(
                api_key=DATABRICKS_TOKEN,
                base_url=f"{DATABRICKS_HOST}/serving-endpoints",
                http_client=http_client,
            )
            resp = _call_with_retry(lambda: client.chat.completions.create(
                model=DATABRICKS_MODEL,
                **kwargs_base,
            ))
            return resp.choices[0].message.content.strip()
        except Exception as exc:
            raise RuntimeError(f"Databricks LLM call failed: {exc}") from exc

    # ── Azure OpenAI ────────────────────────────────────────────────────
    if MODEL_PROVIDER == 'azure':
        if not (AZURE_KEY and AZURE_ENDPOINT and AZURE_DEPLOYMENT):
            raise RuntimeError(
                "Azure mode requires AZURE_OPENAI_KEY, AZURE_OPENAI_ENDPOINT, "
                "and AZURE_OPENAI_DEPLOYMENT_ID in .env"
            )
        try:
            import httpx
            from openai import AzureOpenAI
            http_client = httpx.Client(
                timeout=600,
                verify=AZURE_VERIFY_SSL,
            )
            client = AzureOpenAI(
                api_key=AZURE_KEY,
                azure_endpoint=AZURE_ENDPOINT,
                api_version=AZURE_API_VERSION,
                timeout=600,
                http_client=http_client,
            )
            resp = _call_with_retry(lambda: client.chat.completions.create(
                model=AZURE_DEPLOYMENT,
                **kwargs_base,
            ))
            return resp.choices[0].message.content.strip()
        except Exception as exc:
            raise RuntimeError(f"Azure OpenAI call failed: {exc}") from exc

    # ── Standard OpenAI ─────────────────────────────────────────────────
    if MODEL_PROVIDER == 'openai':
        if not API_KEY:
            raise RuntimeError("OpenAI mode requires OPENAI_API_KEY in .env")
        try:
            from openai import OpenAI
            client = OpenAI(api_key=API_KEY)
            resp = _call_with_retry(lambda: client.chat.completions.create(
                model=MODEL,
                **kwargs_base,
            ))
            return resp.choices[0].message.content.strip()
        except Exception as exc:
            raise RuntimeError(f"OpenAI call failed: {exc}") from exc

    # ── No provider configured ──────────────────────────────────────────
    raise RuntimeError(
        "AI mode requires one of:\n"
        "  • Databricks   → set DATABRICKS_HOST + DATABRICKS_TOKEN\n"
        "  • Azure OpenAI → set AZURE_OPENAI_KEY + AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_DEPLOYMENT_ID\n"
        "  • OpenAI       → set OPENAI_API_KEY\n"
        "Or force a provider with MODEL_PROVIDER=databricks|azure|openai"
    )


def get_crewai_llm():
    """Return a configured CrewAI LLM for the active provider."""
    from crewai import LLM

    if MODEL_PROVIDER == 'databricks':
        if not (DATABRICKS_HOST and DATABRICKS_TOKEN):
            raise ValueError("Databricks credentials not configured in .env")
        return LLM(
            model=f"openai/{DATABRICKS_MODEL}",
            api_key=DATABRICKS_TOKEN,
            base_url=f"{DATABRICKS_HOST}/serving-endpoints",
            temperature=0,
        )
    elif MODEL_PROVIDER == 'azure':
        if not (AZURE_KEY and AZURE_ENDPOINT and AZURE_DEPLOYMENT):
            raise ValueError("Azure OpenAI credentials not configured in .env")
        return LLM(
            model=f"azure/{AZURE_DEPLOYMENT}",
            api_key=AZURE_KEY,
            base_url=AZURE_ENDPOINT,
            api_version=AZURE_API_VERSION,
            temperature=0,
        )
    elif MODEL_PROVIDER == 'openai' and API_KEY:
        return LLM(
            model=MODEL,
            api_key=API_KEY,
            temperature=0,
        )
    else:
        raise ValueError(
            "No LLM provider configured. Set MODEL_PROVIDER and credentials in .env"
        )
