// ============================================
// OntologyEngine — direct-to-provider AI client
// ============================================
// No backend, no Databricks. Every call goes straight from the browser to
// the configured provider (Gemini / OpenRouter / Claude), reusing the exact
// same aiConfig (provider/apiKey/model) the app's AI Settings modal already
// manages for the reroute agent.

// Wraps fetch() so a transient network-layer failure (the browser throwing
// `TypeError: Failed to fetch` — Wi-Fi drop, laptop sleep/wake, VPN blip —
// before any HTTP response is received) gets a couple of short-backoff
// retries instead of immediately burning one of askJson's 3 precious
// attempt slots. HTTP-level errors (4xx/5xx, a real response) are NOT
// retried here — they come back as a normal Response and the caller
// decides what to do with a non-ok status.
async function fetchWithRetry(url, options, { retries = 2, delayMs = 600 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      const isNetworkError = err instanceof TypeError;
      if (!isNetworkError || i === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

export async function callProviderChat(aiConfig, systemPrompt, userPrompt, maxTokens = 16000) {
  const { provider, apiKey, model } = aiConfig || {};
  if (!apiKey) {
    throw new Error('No API key configured. Open Settings (gear icon) and add a provider API key.');
  }

  if (provider === 'gemini') {
    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: maxTokens,
            // Gemini "thinking" models (e.g. gemini-3.6-flash) spend part of
            // maxOutputTokens on hidden reasoning tokens before writing any
            // visible text. On the long, complex extraction prompts this
            // pipeline sends, that can consume the whole budget and come
            // back as finishReason: MAX_TOKENS with an EMPTY content part —
            // which askJson then fails to parse as JSON. Disabling thinking
            // keeps the full budget for the actual JSON output.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || '').join('');
  }

  if (provider === 'openrouter') {
    const res = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://flightops.local',
        'X-Title': 'FlightOps OntologyEngine',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  }

  if (provider === 'claude') {
    // Claude 4.6-generation-and-later model IDs are dateless (e.g.
    // "claude-sonnet-5", "claude-opus-4-7"); everything before that
    // generation kept a dated snapshot suffix (e.g.
    // "claude-haiku-4-5-20251001"). That split also happens to be exactly
    // where Anthropic switched thinking from opt-in ("classic": off by
    // default, enabled via `{type:'enabled', budget_tokens}`) to adaptive
    // (ON by default, only turned off via `{type:'disabled'}` — and a
    // handful of newer non-Sonnet/Opus families reject `disabled` outright).
    // `{type:'disabled'}` is itself a 400 on any classic-thinking model, so
    // this can't be sent unconditionally — only the dateless Sonnet/Opus
    // models get it; older/dated snapshots are already thinking-off by
    // default and get no `thinking` field at all.
    const isAdaptiveThinkingModel = /^claude-(sonnet|opus)-\d+(-\d+)*$/.test(model || '');

    const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // No `temperature` here on purpose. Newer Claude models (Sonnet 5 /
        // Opus 4.7+) reject it outright with a 400 "`temperature` is
        // deprecated for this model" — their adaptive-thinking sampling has
        // taken over what temperature used to control, and there's no value
        // (including 0 or 1) that's accepted instead. Determinism/strict-JSON
        // behavior is asked for via the system prompt instead (see
        // SYSTEM_PROMPT / askJson's retry prompts in pipeline.js).
        //
        // Explicitly disable adaptive thinking on models that have it on by
        // default. Its hidden reasoning tokens are drawn from the same
        // max_tokens budget as the visible answer, with no guarantee the
        // thinking block finishes before max_tokens runs out — that silently
        // produces a 200 response whose `content` is all `thinking` blocks
        // and zero `text` blocks (no error, so askJson's retry logic never
        // even fires). That's exactly what happened with ChatTab's
        // maxTokens=4000 calls once Sonnet 5 became the default model. This
        // app wants a direct, gradeable answer every time, not open-ended
        // deliberation, so disabling it outright is more predictable than
        // tuning `output_config.effort` / raising max_tokens and hoping
        // thinking stops in time.
        ...(isAdaptiveThinkingModel ? { thinking: { type: 'disabled' } } : {}),
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    // Select by block type rather than assuming position/shape — Sonnet 5
    // responses can include `thinking` (and other non-text) blocks, and per
    // Anthropic's own migration guidance `content[0]` is no longer safely
    // assumed to be the text block.
    return (data?.content || [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text || '')
      .join('');
  }

  throw new Error(`Unsupported AI provider: ${provider}`);
}

function cleanJsonResponse(text) {
  let t = (text || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```/, '').trim();
    if (/^json/i.test(t)) t = t.slice(4).trim();
    if (t.endsWith('```')) t = t.slice(0, -3).trim();
  }
  return t;
}

function extractFirstJsonBlock(text) {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' || text[i] === '{') {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const stack = [];
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ']' || ch === '}') {
      if (!stack.length) return null;
      const opener = stack.pop();
      if ((opener === '[' && ch !== ']') || (opener === '{' && ch !== '}')) return null;
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Ask the configured AI provider for strict JSON. Mirrors the retry -> extract
 * -> AI-repair fallback chain the original Python pipeline used (_ask_json).
 */
export async function askJson(aiConfig, systemPrompt, userPrompt, maxTokens = 16000) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const sys =
      attempt === 0
        ? systemPrompt
        : 'Return strict, complete, valid JSON only. No prose, no code fences, no trailing fragments.';
    const usr =
      attempt === 0
        ? userPrompt
        : `${userPrompt}\n\nIMPORTANT: Output must be complete JSON (not truncated).`;

    let content;
    try {
      content = await callProviderChat(aiConfig, sys, usr, maxTokens);
    } catch (err) {
      lastError = err;
      continue;
    }

    let cleaned = cleanJsonResponse(content);
    try {
      return JSON.parse(cleaned);
    } catch (ex) {
      lastError = ex;
    }

    const extracted = extractFirstJsonBlock(cleaned);
    if (extracted) {
      try {
        return JSON.parse(extracted);
      } catch (ex) {
        cleaned = extracted;
        lastError = ex;
      }
    }

    try {
      const repaired = await callProviderChat(
        aiConfig,
        'You repair malformed JSON. Return only corrected valid JSON with no markdown. Do not add explanatory text. Preserve original data and structure.',
        `Repair this malformed JSON and return valid JSON only:\n\n${cleaned}`,
        maxTokens
      );
      const repairedClean = cleanJsonResponse(repaired);
      return JSON.parse(repairedClean);
    } catch (ex) {
      lastError = ex;
    }
  }

  throw new Error(`Unable to parse valid JSON from AI response after retries: ${lastError}`);
}
