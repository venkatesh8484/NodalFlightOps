#!/usr/bin/env python3
"""Rework openSkyClient.js to go through a CORS-safe transport:
the Electron IPC bridge when present, otherwise the Vite dev proxy."""

import io, os

P = os.path.expanduser("~/mnt/FlightOps/src/lib/openSkyClient.js")
s = io.open(P, encoding="utf-8").read()

# ── 1. URL constants → transport layer ───────────────────────────────
old = """const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
"""

new = '''/* ══════════════════════════════════════════════════════════════════════
   TRANSPORT — why this is not just fetch()
   ══════════════════════════════════════════════════════════════════════
   The OpenSky REST API sends no Access-Control-Allow-Origin header. A
   browser page on localhost:5173 calling it directly gets an opaque
   "TypeError: Failed to fetch" — the request is killed by the same-origin
   policy before it leaves Chrome, which is indistinguishable from being
   offline. So the call never goes out from renderer code directly.

   Two ways around it, picked at load time:

     1. Electron IPC (`window.flightOpsNet`, installed by preload.cjs) —
        main.js performs the request, where CORS does not apply. This is
        the path in both `npm run electron:dev` and the packaged app.
     2. The Vite dev proxy (see vite.config.js) — same-origin paths that
        the dev server forwards. This is the path for a plain browser tab
        on localhost:5173.

   A production web build served without either would fall back to path 2
   and need an equivalent proxy on whatever serves it — worth knowing if
   this console is ever hosted rather than shipped as a desktop app. */

const IPC = typeof window !== 'undefined' && window.flightOpsNet && window.flightOpsNet.openSky
  ? window.flightOpsNet.openSky
  : null;

/** True when requests are being made by the Electron main process. */
export const usingNativeBridge = !!IPC;

const OPENSKY_STATES_URL = IPC
  ? 'https://opensky-network.org/api/states/all'
  : '/opensky-api/states/all';

const OPENSKY_TOKEN_URL = IPC
  ? 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
  : '/opensky-auth/auth/realms/opensky-network/protocol/openid-connect/token';

/**
 * One request shape over both transports.
 *
 * Never throws for network or HTTP failure — those come back as a result
 * object — but does re-throw AbortError, because a caller that cancelled a
 * request needs to know it was cancelled rather than that it failed.
 *
 * @returns {Promise<{ok:boolean, status:number, data:any, text:string|null,
 *                    rateRemaining:string|null, error:string|null}>}
 */
async function request(url, { method = 'GET', headers = {}, body = null, signal } = {}) {
  const blank = { ok: false, status: 0, data: null, text: null, rateRemaining: null };

  if (IPC) {
    // The bridge cannot carry an AbortSignal across IPC, so honour the
    // signal on this side: a cancelled request simply discards its reply.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let res;
    try {
      res = await IPC({ url, method, headers, body });
    } catch (err) {
      return { ...blank, error: `Desktop bridge failed: ${err.message}` };
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (res.error) return { ...blank, status: res.status || 0, error: res.error };

    let data = null;
    try { data = res.body ? JSON.parse(res.body) : null; } catch { /* caller decides */ }
    return {
      ok: res.ok,
      status: res.status,
      data,
      text: res.body,
      rateRemaining: res.rateRemaining ?? null,
      error: null,
    };
  }

  let res;
  try {
    res = await fetch(url, { method, headers, body, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { ...blank, error: err.message };
  }

  const text = await res.text().catch(() => null);
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* caller decides */ }

  return {
    ok: res.ok,
    status: res.status,
    data,
    text,
    rateRemaining: res.headers.get('x-rate-limit-remaining'),
    error: null,
  };
}
'''
assert old in s, "URL constants block not found"
s = s.replace(old, new, 1)

# ── 2. Token request through the transport ───────────────────────────
old = """  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(OPENSKY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      console.warn(`[openSky] Token request failed (${res.status}) — continuing anonymously.`);
      tokenCache = { token: null, expiresAt: 0, clientId: null };
      return null;
    }
    const data = await res.json();
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000,
      clientId,
    };
    return tokenCache.token;
  } catch (err) {
    console.warn('[openSky] Token request threw — continuing anonymously:', err.message);
    tokenCache = { token: null, expiresAt: 0, clientId: null };
    return null;
  }
}"""

new = """  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const res = await request(OPENSKY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok || !res.data?.access_token) {
    console.warn(
      `[openSky] Token request failed (${res.error || `HTTP ${res.status}`}) — continuing anonymously.`,
    );
    tokenCache = { token: null, expiresAt: 0, clientId: null };
    return null;
  }

  tokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in ?? 1800) * 1000,
    clientId,
  };
  return tokenCache.token;
}"""
assert old in s, "token fetch block not found"
s = s.replace(old, new, 1)

# ── 3. States request through the transport ──────────────────────────
old = """  let res;
  try {
    res = await fetch(url, {
      signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Almost always a CORS rejection or an offline browser. Both look
    // identical to fetch(), so the message covers both.
    return fail(
      'network',
      'Cannot reach OpenSky — the browser blocked the request or the network is offline.',
      authenticated,
    );
  }

  if (res.status === 429) {"""

new = """  const res = await request(url, {
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (res.error) {
    return fail(
      'network',
      usingNativeBridge
        ? `Cannot reach OpenSky: ${res.error}`
        : 'Cannot reach OpenSky through the dev-server proxy. Is the Vite dev server running, and is this page served from it?',
      authenticated,
    );
  }

  if (res.status === 429) {"""
assert old in s, "states fetch block not found"
s = s.replace(old, new, 1)

# ── 4. Response body is already parsed by the transport ──────────────
old = """  let data;
  try {
    data = await res.json();
  } catch {
    return fail('parse', 'OpenSky returned a malformed response.', authenticated);
  }

  const states = Array.isArray(data?.states) ? data.states : [];"""

new = """  const data = res.data;
  if (!data) {
    return fail('parse', 'OpenSky returned a malformed response.', authenticated);
  }

  const states = Array.isArray(data?.states) ? data.states : [];"""
assert old in s, "json parse block not found"
s = s.replace(old, new, 1)

# ── 5. Rate-limit header now comes off the transport result ──────────
old = """  // OpenSky exposes the remaining allowance in a response header. Browsers
  // only surface it if the server marks it exposed via CORS, so treat it as
  // a bonus rather than a guarantee.
  const remainingHeader = res.headers.get('x-rate-limit-remaining');
"""
new = """  // OpenSky reports the remaining daily allowance in a response header.
  // Both transports surface it, but it is absent on some responses, so it
  // stays optional.
  const remainingHeader = res.rateRemaining;
"""
assert old in s, "rate header block not found"
s = s.replace(old, new, 1)

io.open(P, "w", encoding="utf-8").write(s)
print("openSkyClient transport rewired")
