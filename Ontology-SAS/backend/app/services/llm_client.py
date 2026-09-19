import os
from pathlib import Path

import httpx


def _load_env_file() -> None:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _get_databricks_settings() -> tuple[str | None, str | None, bool, str | None]:
    token = os.getenv("DATABRICKS_TOKEN")
    host = os.getenv("DATABRICKS_HOST")
    verify_ssl = os.getenv("DATABRICKS_VERIFY_SSL", "false").lower() == "true"
    model = os.getenv("DATABRICKS_MODEL")
    return token, host, verify_ssl, model


_load_env_file()


def get_llm_client():
    """Create and return an OpenAI client configured for Databricks AI Gateway."""
    token, host, verify_ssl, _ = _get_databricks_settings()

    if not token or not host:
        raise RuntimeError("DATABRICKS_TOKEN and DATABRICKS_HOST must be set in .env")

    host_url = host.rstrip("/")

    # For development this can remain False. Set DATABRICKS_VERIFY_SSL=true in production.
    http_client = httpx.Client(verify=verify_ssl, trust_env=True, timeout=180)

    try:
        from openai import OpenAI
    except Exception as ex:
        raise RuntimeError(f"openai package is required for AI findings: {ex}")

    return OpenAI(
        api_key=token,
        base_url=f"{host_url}/ai-gateway/mlflow/v1",
        http_client=http_client,
    )


def extract_message_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if text:
                    parts.append(str(text))
            else:
                text = getattr(item, "text", None)
                if text:
                    parts.append(str(text))
                else:
                    parts.append(str(item))
        return "\n".join(parts)
    return str(content)


def call_databricks_chat(messages, max_tokens=2400):
    _, _, _, model = _get_databricks_settings()

    if not model:
        raise RuntimeError(
            "DATABRICKS_MODEL must be set in .env for AI findings generation."
        )

    client = get_llm_client()

    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.1,
            max_tokens=max_tokens,
        )
    except Exception as ex:
        raise RuntimeError(f"Databricks AI Gateway request failed: {ex}")

    if not getattr(response, "choices", None):
        raise RuntimeError("Databricks AI Gateway response did not include any choices.")

    content = extract_message_text(response.choices[0].message.content)
    if not content.strip():
        raise RuntimeError("Databricks AI Gateway returned empty content.")

    return content
