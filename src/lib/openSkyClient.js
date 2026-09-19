/**
 * openSkyClient.js — Real-time fleet tracking via the OpenSky Network
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This module is the live data spine of the Console tab's OpenSky-style map.
 * It is no longer a decorative "ambient traffic" layer: it is the map.
 *
 * What it does
 * ------------
 *  • Fetches ADS-B state vectors from OpenSky's /states/all REST endpoint.
 *  • Authenticates with OAuth2 client credentials when the operator has
 *    supplied them (Settings → OpenSky Network), and falls back to anonymous
 *    access when they have not.
 *  • Filters the world's traffic down to the tracked operators (the KLM
 *    group and Air France) by ICAO callsign prefix.
 *  • Fails soft on every error path — a rate limit, a CORS block or a dropped
 *    network returns the previous snapshot's worth of nothing rather than
 *    throwing into the React tree.
 *
 * Quota notes (important for demo planning)
 * -----------------------------------------
 * OpenSky bills REST calls in "credits". A bounded-box query over a small
 * area costs 1 credit; an unbounded world query (which is what tracking the
 * long-haul KLM fleet actually requires) costs 4. Anonymous users get ~400
 * credits/day, authenticated users ~4000. The console therefore defaults to
 * a conservative refresh interval when anonymous and a faster one when
 * credentials are present — see SUGGESTED_INTERVAL_SEC below. Between polls
 * the map dead-reckons aircraft forward from their last known velocity and
 * track, so a 60-second poll still renders as continuous motion.
 */

/* ══════════════════════════════════════════════════════════════════════
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

/* ══════════════════════════════════════════════════════════════════════
   AIRLINE FILTER
   ══════════════════════════════════════════════════════════════════════
   OpenSky reports the ICAO callsign as transmitted by the aircraft, e.g.
   "KLM1234 ". Every operator below is matched on its three-letter ICAO
   designator.

   KLM group — KLM (mainline), KLC (Cityhopper), MPH (Martinair, cargo),
   TRA (Transavia, Air France-KLM group but a separate brand).

   AF group — Air France mainline (ICAO AFR, IATA AF). SAS was removed
   from the tracked set (2026-09-17); Air France-KLM's two mainline
   carriers are now the only operators tracked.

   `iata` is the marketing prefix used to turn an ICAO callsign into the
   flight number an OCC controller and the KG actually speak. */
export const AIRLINE_CALLSIGN_PREFIXES = {
  KLM: { prefix: 'KLM', iata: 'KL', group: 'KLM', label: 'KLM Royal Dutch Airlines', defaultOn: true },
  KLC: { prefix: 'KLC', iata: 'KL', group: 'KLM', label: 'KLM Cityhopper', defaultOn: false },
  MPH: { prefix: 'MPH', iata: 'MP', group: 'KLM', label: 'Martinair Cargo', defaultOn: false },
  TRA: { prefix: 'TRA', iata: 'HV', group: 'KLM', label: 'Transavia', defaultOn: false },
  AFR: { prefix: 'AFR', iata: 'AF', group: 'AF', label: 'Air France', defaultOn: true },
};

/** Deprecated name kept so nothing that still imports it breaks. */
export const KLM_CALLSIGN_PREFIXES = AIRLINE_CALLSIGN_PREFIXES;

/** The prefix set the console starts with: KLM and AF mainline. */
export const DEFAULT_PREFIXES = Object.values(AIRLINE_CALLSIGN_PREFIXES)
  .filter((a) => a.defaultOn)
  .map((a) => a.prefix);

/** Every declared prefix — what the *request* filter should use, so that
 *  toggling a chip is a client-side operation and never costs a credit. */
export const ALL_CALLSIGN_PREFIXES = Object.keys(AIRLINE_CALLSIGN_PREFIXES);

/* ══════════════════════════════════════════════════════════════════════
   QUERY SCOPES
   ══════════════════════════════════════════════════════════════════════ */

/** Unbounded world query — catches the long-haul fleet (JFK/SIN/GRU/HND/DXB
 *  sectors) as well as the European short-haul bank. Costs 4 credits. */
export const SCOPE_GLOBAL = { id: 'global', label: 'Global', bbox: null, credits: 4 };

/** Western-Europe box — the AMS short-haul bank only. Costs 1 credit, so it
 *  is the scope to pick when running a long unattended demo anonymously. */
export const SCOPE_EUROPE = {
  id: 'europe',
  label: 'Europe',
  bbox: { lamin: 32, lomin: -25, lamax: 68, lomax: 40 },
  credits: 1,
};

export const SCOPES = { global: SCOPE_GLOBAL, europe: SCOPE_EUROPE };

/** Refresh cadence that keeps a session inside the daily credit allowance:
 *  anonymous ≈ 400 credits/day, authenticated ≈ 4000. */
export const SUGGESTED_INTERVAL_SEC = { anonymous: 60, authenticated: 15 };

/* Legacy export retained so any other module still importing it keeps
   building. The console itself now uses SCOPE_* above. */
export const EUROPE_BBOX = SCOPE_EUROPE.bbox;

/* ══════════════════════════════════════════════════════════════════════
   STATE VECTOR PARSING
   ══════════════════════════════════════════════════════════════════════
   OpenSky returns each aircraft as a positional array, not an object. This
   is the documented field order for /states/all. */
const STATE_FIELDS = [
  'icao24',        //  0 unique ICAO 24-bit transponder address (hex)
  'callsign',      //  1 callsign as transmitted, space-padded
  'originCountry', //  2 country inferred from the ICAO24 allocation block
  'timePosition',  //  3 unix ts of the last position report
  'lastContact',   //  4 unix ts of the last message of any kind
  'longitude',     //  5 WGS-84 degrees
  'latitude',      //  6 WGS-84 degrees
  'baroAltitude',  //  7 barometric altitude, metres
  'onGround',      //  8 surface position flag
  'velocity',      //  9 ground speed, m/s
  'trueTrack',     // 10 track over ground, degrees clockwise from north
  'verticalRate',  // 11 m/s, positive = climbing
  'sensors',       // 12 receiver ids (only when requested)
  'geoAltitude',   // 13 geometric altitude, metres
  'squawk',        // 14 transponder code
  'spi',           // 15 special-purpose indicator
  'positionSource',// 16 0=ADS-B 1=ASTERIX 2=MLAT 3=FLARM
];

const POSITION_SOURCES = ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'];

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.94384;
const MS_TO_KMH = 3.6;

function parseState(row) {
  const rec = {};
  STATE_FIELDS.forEach((key, i) => {
    rec[key] = row[i];
  });
  return rec;
}

/**
 * ICAO callsign → IATA flight number, e.g. KLM1234 → KL1234.
 *
 * Deliberately only when the numeric suffix is *purely* numeric. About a
 * third of this group's live callsigns carry an ICAO de-confliction letter
 * — KLM24M, KLC22A, TRA75K, SAS73A; 20 of 55 KLM states in the 2026-09-06
 * snapshot — and those correspond to no IATA flight number at all. The
 * previous `'KL' + suffix` rule turned them into plausible-looking
 * fictions ("KL24M") and printed them in the detail drawer as fact.
 */
function toIataFlight(callsign) {
  const m = /^([A-Z]{3})(\d+)$/.exec(callsign);
  if (!m) return null;
  const airline = AIRLINE_CALLSIGN_PREFIXES[m[1]];
  return airline ? `${airline.iata}${m[2]}` : null;
}

/**
 * Normalise a raw OpenSky state vector into the shape the map renders.
 * Every derived unit the UI needs (feet, knots, flight level) is computed
 * once here so the render path stays arithmetic-free.
 */
function toAircraft(s) {
  const altitudeM = s.geoAltitude ?? s.baroAltitude ?? null;
  const callsign = (s.callsign || '').trim();
  return {
    icao24: s.icao24,
    callsign: callsign || s.icao24?.toUpperCase() || 'UNKNOWN',
    iataFlight: toIataFlight(callsign.toUpperCase()),
    operator: callsign.slice(0, 3),
    originCountry: s.originCountry || '—',

    lat: s.latitude,
    lon: s.longitude,

    altitudeM,
    altitudeFt: altitudeM != null ? Math.round(altitudeM * M_TO_FT) : null,
    flightLevel: altitudeM != null ? Math.round((altitudeM * M_TO_FT) / 100) : null,
    baroAltitudeM: s.baroAltitude ?? null,
    geoAltitudeM: s.geoAltitude ?? null,

    velocityMs: s.velocity ?? null,
    velocityKt: s.velocity != null ? Math.round(s.velocity * MS_TO_KT) : null,
    velocityKph: s.velocity != null ? Math.round(s.velocity * MS_TO_KMH) : null,

    headingDeg: s.trueTrack ?? 0,
    verticalRateMs: s.verticalRate ?? null,
    verticalRateFpm: s.verticalRate != null ? Math.round(s.verticalRate * M_TO_FT * 60) : null,

    onGround: !!s.onGround,
    squawk: s.squawk || null,
    spi: !!s.spi,
    positionSource: POSITION_SOURCES[s.positionSource] || 'UNKNOWN',

    lastContact: s.lastContact ?? null,
    timePosition: s.timePosition ?? null,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   OAUTH2 — CLIENT CREDENTIALS
   ══════════════════════════════════════════════════════════════════════
   OpenSky issues short-lived (30 min) bearer tokens against a Keycloak
   realm. We cache the token in module scope and refresh it a minute before
   expiry. A failure here is never fatal: the caller silently degrades to
   anonymous access, which still works, just with a much smaller allowance. */
let tokenCache = { token: null, expiresAt: 0, clientId: null };

async function getAccessToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;

  const now = Date.now();
  if (tokenCache.token && tokenCache.clientId === clientId && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
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
}

/** Drop any cached bearer token — called when credentials change or a 401
 *  tells us the cached one is no longer good. */
export function resetAuth() {
  tokenCache = { token: null, expiresAt: 0, clientId: null };
}

/**
 * Verify a client id / secret pair against the OpenSky token endpoint.
 *
 * Exists because the alternative is a silent one: the feed degrades to
 * anonymous access when credentials are wrong, and anonymous access still
 * *works*. An operator who fat-fingers the secret sees a map full of
 * aircraft and a 400-credit allowance, with nothing on screen saying which
 * of the two they are on until the rate limit bites hours later. This makes
 * the answer immediate and explicit.
 *
 * Always drops the cached token first, so it tests the credentials in the
 * box rather than whatever was already cached from a previous pair.
 *
 * @returns {Promise<{ok:boolean, message:string, expiresInSec:number|null}>}
 */
export async function testOpenSkyCredentials({ clientId = '', clientSecret = '' } = {}) {
  if (!clientId.trim() || !clientSecret.trim()) {
    return { ok: false, message: 'Enter both a client id and a client secret.', expiresInSec: null };
  }

  resetAuth();

  let res;
  try {
    res = await request(OPENSKY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
      }).toString(),
    });
  } catch (err) {
    return { ok: false, message: `Request failed: ${err.message}`, expiresInSec: null };
  }

  if (res.ok && res.data?.access_token) {
    const ttl = res.data.expires_in ?? 1800;
    return {
      ok: true,
      message: `Authenticated. Bearer token issued, valid ${Math.round(ttl / 60)} min. `
        + 'The feed now runs on the ~4000 credit/day allowance.',
      expiresInSec: ttl,
    };
  }

  if (res.status === 401 || res.status === 400) {
    // Keycloak answers both a bad secret and an unknown client here, and
    // its own description is more specific than anything we could guess.
    const detail = res.data?.error_description || res.data?.error || '';
    return {
      ok: false,
      message: `Rejected by OpenSky${detail ? ` — ${detail}` : ''}. Check that the id and secret came `
        + 'from an API client on your OpenSky account page, not your website login.',
      expiresInSec: null,
    };
  }

  return {
    ok: false,
    message: res.error
      ? `Could not reach OpenSky: ${res.error}`
      : `OpenSky returned HTTP ${res.status}.`,
    expiresInSec: null,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   THE FETCH
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Fetch live traffic for the tracked operators.
 *
 * Returns a result envelope rather than a bare array, because the console's
 * status bar needs to distinguish "no KLM aircraft airborne in this box"
 * from "OpenSky rate-limited us" from "the browser blocked the request".
 *
 * @param {object}  opts
 * @param {string}  [opts.scope='global']     'global' | 'europe'
 * @param {string[]}[opts.prefixes]           ICAO callsign prefixes to keep
 * @param {string}  [opts.clientId]           OAuth2 client id (optional)
 * @param {string}  [opts.clientSecret]       OAuth2 client secret (optional)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, aircraft:Array, error:string|null,
 *                     errorKind:string|null, authenticated:boolean,
 *                     fetchedAt:number, snapshotTime:number|null,
 *                     totalStates:number, creditsRemaining:number|null,
 *                     creditsUsed:number}>}
 */
export async function fetchAirlineTraffic({
  scope = 'global',
  prefixes = DEFAULT_PREFIXES,
  clientId = '',
  clientSecret = '',
  signal,
} = {}) {
  const scopeDef = SCOPES[scope] || SCOPE_GLOBAL;
  const fail = (errorKind, error, authenticated = false) => ({
    ok: false,
    aircraft: [],
    error,
    errorKind,
    authenticated,
    fetchedAt: Date.now(),
    snapshotTime: null,
    totalStates: 0,
    creditsRemaining: null,
    creditsUsed: scopeDef.credits,
  });

  const token = await getAccessToken(clientId, clientSecret);
  const authenticated = !!token;

  let url = OPENSKY_STATES_URL;
  if (scopeDef.bbox) {
    const b = scopeDef.bbox;
    url += `?lamin=${b.lamin}&lomin=${b.lomin}&lamax=${b.lamax}&lomax=${b.lomax}`;
  }

  const res = await request(url, {
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

  if (res.status === 429) {
    return fail(
      'rate_limit',
      authenticated
        ? 'OpenSky rate limit reached for these credentials. Slow the refresh interval or switch to the Europe scope.'
        : 'OpenSky anonymous rate limit reached (~400 credits/day). Add OpenSky credentials in Settings, or slow the refresh interval.',
      authenticated,
    );
  }
  if (res.status === 401 || res.status === 403) {
    resetAuth();
    return fail(
      'auth',
      authenticated
        ? 'OpenSky rejected these credentials. Check the client id and secret in Settings.'
        : 'OpenSky refused anonymous access to this endpoint. Add OpenSky credentials in Settings.',
      authenticated,
    );
  }
  if (!res.ok) {
    return fail('http', `OpenSky returned HTTP ${res.status}.`, authenticated);
  }

  const data = res.data;
  if (!data) {
    return fail('parse', 'OpenSky returned a malformed response.', authenticated);
  }

  const states = Array.isArray(data?.states) ? data.states : [];
  const wanted = prefixes && prefixes.length ? prefixes : DEFAULT_PREFIXES;

  const aircraft = states
    .map(parseState)
    .filter((s) => {
      if (s.latitude == null || s.longitude == null) return false;
      const cs = (s.callsign || '').trim().toUpperCase();
      return wanted.some((p) => cs.startsWith(p));
    })
    .map(toAircraft);

  // OpenSky reports the remaining daily allowance in a response header.
  // Both transports surface it, but it is absent on some responses, so it
  // stays optional.
  const remainingHeader = res.rateRemaining;

  return {
    ok: true,
    aircraft,
    error: null,
    errorKind: null,
    authenticated,
    fetchedAt: Date.now(),
    snapshotTime: typeof data?.time === 'number' ? data.time * 1000 : null,
    totalStates: states.length,
    creditsRemaining: remainingHeader != null ? Number(remainingHeader) : null,
    creditsUsed: scopeDef.credits,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   DEAD RECKONING
   ══════════════════════════════════════════════════════════════════════
   OpenSky's free tier resolves positions to roughly 5–10 seconds and our
   poll interval is far longer than that, so rendering raw snapshots would
   make the fleet teleport once a minute. Between polls we advance each
   aircraft along its own great-circle track at its last reported ground
   speed. This is exactly what live-tracking sites do, and it is honest:
   the detail drawer always shows the age of the underlying fix. */

const EARTH_RADIUS_M = 6_371_000;

/**
 * Project a position forward along a constant true track.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {number} headingDeg degrees clockwise from north
 * @param {number} distanceM metres travelled
 */
export function projectPosition(lat, lon, headingDeg, distanceM) {
  if (!distanceM) return [lat, lon];
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const δ = distanceM / EARTH_RADIUS_M;
  const θ = toRad(headingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);

  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * sinφ2,
    );

  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
}

/**
 * Where an aircraft should be drawn `elapsedMs` after its last fix.
 * Aircraft on the ground are never extrapolated — pushbacks and taxi turns
 * make constant-heading projection actively wrong there.
 */
export function extrapolate(ac, elapsedMs) {
  if (ac.onGround || !ac.velocityMs || elapsedMs <= 0) return [ac.lat, ac.lon];
  // Never extrapolate more than four minutes; past that the fix is stale
  // enough that a frozen marker is more honest than a confident guess.
  const cappedMs = Math.min(elapsedMs, 240_000);
  return projectPosition(ac.lat, ac.lon, ac.headingDeg, ac.velocityMs * (cappedMs / 1000));
}

/* ══════════════════════════════════════════════════════════════════════
   ALTITUDE COLOUR SCALE
   ══════════════════════════════════════════════════════════════════════
   The same banding OpenSky's own map uses to read vertical structure at a
   glance: warm on the deck, cool in the cruise. */
export const ALTITUDE_BANDS = [
  { maxFt: 0, color: '#94a3b8', label: 'On ground' },
  { maxFt: 3000, color: '#ef4444', label: '< FL030' },
  { maxFt: 10000, color: '#f97316', label: 'FL030–100' },
  { maxFt: 20000, color: '#eab308', label: 'FL100–200' },
  { maxFt: 30000, color: '#22c55e', label: 'FL200–300' },
  { maxFt: 38000, color: '#06b6d4', label: 'FL300–380' },
  { maxFt: Infinity, color: '#6366f1', label: '> FL380' },
];

export function altitudeColor(ac) {
  if (ac.onGround) return ALTITUDE_BANDS[0].color;
  // The grey ground band is reserved for aircraft actually reporting a
  // surface position. An airborne aircraft with no altitude in its state
  // vector falls into the lowest airborne band rather than being painted
  // as if it were parked.
  const airborneBands = ALTITUDE_BANDS.slice(1);
  const ft = ac.altitudeFt ?? 0;
  return (airborneBands.find((b) => ft <= b.maxFt) || airborneBands[airborneBands.length - 1]).color;
}

/** Deprecated name kept so nothing that still imports it breaks. */
export const fetchKlmTraffic = fetchAirlineTraffic;
