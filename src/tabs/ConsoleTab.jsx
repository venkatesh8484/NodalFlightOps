// ═══════════════════════════════════════════════════════════════════════
// ConsoleTab — AMS OCC live traffic map (KLM group + Air France)
// ═══════════════════════════════════════════════════════════════════════
//
// Rebuilt as a single full-bleed map modelled on opensky-network.org's own
// live map, showing real ADS-B positions for the tracked fleets.
//
// What changed from the previous console
// --------------------------------------
//  • The docked bottom "Delay Configuration & Strategy" panel and the docked
//    right "Live Ontology Traversal" panel are gone. The map owns the whole
//    workspace. (The delay/recovery simulation returns in a later stage,
//    triggered from an aircraft hover rather than from a docked panel.)
//  • The map no longer draws the curated KG scenario — no AMS connection
//    arcs, no four hardcoded inbound legs. Every aircraft on screen is a
//    live state vector from the OpenSky Network, filtered to tracked callsigns.
//
// How it stays smooth on a slow poll
// ----------------------------------
// OpenSky's free allowance does not permit a 5-second poll, so positions are
// dead-reckoned forward between fetches from each aircraft's last reported
// ground speed and true track (see openSkyClient.extrapolate). Markers are
// mutated in place on a 1 Hz ticker rather than re-rendered through React,
// which keeps several hundred aircraft fluid. The detail drawer always shows
// the true age of the underlying fix, so interpolation never masquerades as
// fresh data.

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Plane, Search, RefreshCw, Settings as SettingsIcon, X, Crosshair,
  Layers, Tag, Route, Radio, AlertTriangle, ChevronDown, ChevronUp, Globe,
  FlaskConical, Timer, ShieldCheck, RotateCcw, Users, CornerUpRight, ArrowUpToLine,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  fetchAirlineTraffic,
  extrapolate,
  altitudeColor,
  resetAuth,
  ALTITUDE_BANDS,
  AIRLINE_CALLSIGN_PREFIXES,
  ALL_CALLSIGN_PREFIXES,
  DEFAULT_PREFIXES,
  SCOPES,
} from '../lib/openSkyClient.js';
import { getKnowledgeGraph } from '../lib/knowledgeGraph.js';
import { simulateFlight, DEFAULT_SIM_OPTIONS, rankDestinations } from '../lib/flightSimulator.js';
import { TIER_ORDER, TIER_META } from '../lib/loyaltyTiers.js';

/* Every tracked prefix (KLM group + AF group) is pulled down on each poll
   and the operator's chip selection is applied client-side. Narrowing the
   *request* would spend a fresh credit every time a chip is toggled, for
   data we already have — so the request is deliberately wider than the
   display. */
const ALL_PREFIXES = ALL_CALLSIGN_PREFIXES;

/* ══════════════════════════════════════════════════════════════════════════
   DISRUPTION SCENARIO DEMO — one synthetic aircraft, everything else real
   ══════════════════════════════════════════════════════════════════════════
   Requested scenario: "It's 14:30 on a Tuesday. A severe crosswind event
   closes the Polderbaan at AMS, and simultaneously ATC goes on a slowdown
   at CDG due to a strike." Nothing in this app models runway closures, ATC
   ground stops, crew duty legality or catering/baggage flow — those stay a
   trigger story, presented as such, never as a computed figure.

   The live OpenSky feed is untouched: this adds exactly one synthetic
   aircraft to the fleet the tab already has, tagged `isDemo`, so it is
   filterable/searchable/selectable like any other marker but excluded from
   the header's live fleet stats (see the `stats` useMemo below). It is
   still distinguishable from a real contact by its callsign (KLM1250) and
   the amber Disruption Scenario panel in its drawer — no on-screen "DEMO"
   label, per operator preference.

   It reuses KL1250 — CDG → AMS, already in the knowledge graph as
   TIGHT_MCT / AT_RISK (data/flights.json) — rather than inventing a flight
   with no ontology backing, so its onward connections at AMS run through
   the KG's real key-connection bank, not fabricated numbers. */
const DISRUPTION_DEMO_ICAO24 = 'demo1250';

function buildDisruptionDemoAircraft(atMs) {
  // Fixed, not extrapolated: extrapolate() only moves an aircraft when
  // velocityMs is truthy, so 0 keeps it parked at its holding position
  // instead of dead-reckoning off the map in a straight line over a long
  // session. A real hold is a racetrack, not a stationary point — this is
  // a deliberate simplification for a UI fixture, not a flight model.
  const timePosition = Math.floor((atMs ?? Date.now()) / 1000);
  return {
    icao24: DISRUPTION_DEMO_ICAO24,
    callsign: 'KLM1250',
    iataFlight: 'KL1250',
    operator: 'KLM',
    originCountry: 'Netherlands',
    lat: 52.18,
    lon: 4.95,
    altitudeM: 1829,
    altitudeFt: 6000,
    flightLevel: 60,
    baroAltitudeM: 1829,
    geoAltitudeM: 1829,
    velocityMs: 0,
    velocityKt: 0,
    velocityKph: 0,
    headingDeg: 250,
    verticalRateMs: 0,
    verticalRateFpm: 0,
    onGround: false,
    squawk: '2743',
    spi: false,
    positionSource: 'ADS-B',
    lastContact: timePosition,
    timePosition,
    isDemo: true,
  };
}

/* Preset simOpts for the demo: holding 45 min for the Polderbaan closure,
   35 min already lost to the CDG ATC slowdown before it even got airborne,
   and the IROPS demand profile so the hub-pressure block reflects a
   dual-hub disruption rather than a normal Tuesday. Still plain simOpts —
   the operator can drag any of these sliders same as for a real aircraft. */
const DISRUPTION_SIM_PRESET = {
  ...DEFAULT_SIM_OPTIONS,
  destinationId: 'AMS',
  delayMin: 35,
  holdMin: 45,
  mctMinutes: 45,
  demandProfile: 'irops',
};

/* ── Basemaps ───────────────────────────────────────────────────────────
   Light is the default, to match the bright theme used everywhere else in
   the app. It used to be Esri's flat Canvas Gray service, which read as
   washed-out/"too bright" with almost no visual structure — no roads, no
   parks, no water tint. Swapped 2026-09-06 for Esri's World Street Map,
   a keyless road-map service styled like a classic civilian map (tan/white
   roads, green parks, light-blue water, place labels baked in) — the same
   layout family as Google Maps' default view, which is what was actually
   being asked for. Dark stays available from the basemap toggle for an
   ops-radar look, still on Canvas Dark Gray.

   Why this is no longer just two CARTO URLs
   -----------------------------------------
   CARTO's raster CDN now requires an API key. It does not fail closed — it
   serves a perfectly valid tile with "API KEY REQUIRED" and a signup URL
   burned into the pixels, which is what was tiling that message across the
   whole console. Nothing in the app was broken and no request was failing,
   so there was nothing to catch: the watermark IS the response.

   Shipping a map that only works after someone signs up for a third-party
   key is the wrong default, so each style still declares two sources:

     • keyless — no key, no watermark. Dark uses Esri's Canvas Dark Gray
       (split into a label-free base and a transparent reference overlay,
       both declared and stacked — labels land in the tile pane, below the
       marker pane, so aircraft always draw over place names). Light uses
       Esri's World Street Map, which bakes its own labels into one tile
       layer, the same shape CARTO's tiles take (no separate `labels` URL).
     • carto  — used the moment a key is entered in Settings → Basemap.
       A free key covers 5M tile requests a month and needs no CARTO
       account; `?key=` is CARTO's own documented parameter name. Voyager
       (light) is CARTO's own "Google Maps-style" tile set and reads even
       closer to Google Maps than the keyless Street Map fallback does, so
       it's worth a key if this console is going to be used a lot.

   Attribution is a condition of both services, which is why the footer
   line is derived from the resolved source rather than hardcoded. */
const BASEMAPS = {
  dark: {
    label: 'Dark',
    background: '#0b1120',
    keyless: {
      provider: 'Esri',
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      labels: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 16,
      attribution: 'basemap © Esri, HERE, Garmin, © OpenStreetMap',
    },
    carto: {
      provider: 'CARTO',
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      labels: null,
      maxZoom: 20,
      attribution: 'basemap © CARTO © OpenStreetMap',
    },
  },
  light: {
    label: 'Streets',
    background: '#e5e3df',
    keyless: {
      provider: 'Esri',
      // World Street Map, not Canvas Gray — a keyless road map (roads,
      // parks, water, labels) instead of a flat desaturated tint. Bakes
      // its own labels in, so there is no separate `labels` tile to load.
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      labels: null,
      maxZoom: 19,
      attribution: 'basemap © Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap',
    },
    carto: {
      provider: 'CARTO',
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      labels: null,
      maxZoom: 20,
      attribution: 'basemap © CARTO © OpenStreetMap',
    },
  },
};

/** Resolve one style to the tile source actually in force. */
function resolveTiles(style, cartoKey) {
  const def = BASEMAPS[style] || BASEMAPS.dark;
  const key = (cartoKey || '').trim();
  if (!key) return def.keyless;
  const q = `?key=${encodeURIComponent(key)}`;
  return {
    ...def.carto,
    url: def.carto.url + q,
    labels: def.carto.labels ? def.carto.labels + q : null,
  };
}

const TRAIL_MAX_POINTS = 80;

// Caps how many aircraft actually render on the map/list, independent of
// how many the feed/scope returns — a busy Europe or Global snapshot can
// otherwise put 100+ markers on screen at once. Headline stats (the `stats`
// useMemo below) are NOT capped — they still reflect the real fleet size.
const MAX_VISIBLE_AIRCRAFT = 50;

const PLANE_PATH =
  'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L14 19v-5.5l8 2.5z';

/* ── Small formatting helpers ───────────────────────────────────────── */
const fmt = (v, suffix = '') => (v == null ? '—' : `${v.toLocaleString()}${suffix}`);

function ageLabel(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function verticalTrend(fpm) {
  if (fpm == null) return { label: '—', color: 'var(--osk-muted)' };
  if (fpm > 150) return { label: `▲ climbing ${fmt(fpm)} ft/min`, color: '#15803d' };
  if (fpm < -150) return { label: `▼ descending ${fmt(Math.abs(fpm))} ft/min`, color: '#b45309' };
  return { label: '● level', color: 'var(--osk-accent)' };
}

/** UTC clock face for an ETA — an OCC works in Zulu, not in local time. */
function zulu(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

/** Signed minutes, rendered the way a delay is spoken about. */
function deltaLabel(min) {
  if (min === 0) return 'on current profile';
  return min > 0 ? `+${min} min later` : `${Math.abs(min)} min earlier`;
}

function bufferTone(bufferMin, mct) {
  if (bufferMin == null) return 'unknown';
  if (bufferMin < 0) return 'missed';
  if (bufferMin < mct) return 'tight';
  return 'made';
}

/** Compact tier-breakdown chips ("Platinum 2", "Gold 3", ...) for a pax-by-tier map. */
function TierChips({ paxByTier }) {
  const entries = TIER_ORDER.filter((t) => paxByTier?.[t] > 0);
  if (entries.length === 0) return null;
  return (
    <div className="osk-tier-row">
      {entries.map((t) => (
        <span key={t} className="osk-tier-chip">
          <span className="dot" style={{ background: TIER_META[t].color }} />
          {TIER_META[t].label} {paxByTier[t]}
        </span>
      ))}
    </div>
  );
}

/**
 * Structured reroute detail for one RebookPassengers action: which modeled
 * alternates were considered, which cleared their MCT, which pax landed on
 * which alternate (by tier), any pax the plan couldn't place today, and an
 * expandable named passenger manifest — the "who exactly is affected and
 * where are they going" the free-text rebookPartnerOptions blob never showed.
 */
function RebookAlternatesDetail({ action, hideTierChips = false }) {
  const [showManifest, setShowManifest] = useState(false);
  const {
    alternates = [], selectedAlternates = [], unresolvedByTier, unresolvedTotal = 0,
    passengers = [], paxByTier,
  } = action.context;
  const assignedFor = (id) => selectedAlternates.find((s) => s.altFlightId === id);

  return (
    <>
      {!hideTierChips && <TierChips paxByTier={paxByTier} />}
      {alternates.length > 0 && (
        <div className="osk-alt-list">
          {alternates.map((alt) => {
            const assignment = assignedFor(alt.altFlightId);
            return (
              <React.Fragment key={alt.altFlightId}>
                <div className={`osk-alt ${alt.feasible ? 'feasible' : 'infeasible'}`}>
                  <span className="mark">{alt.feasible ? '✓' : '✗'}</span>
                  <span className="fl mono">{alt.altFlightId}</span>
                  <span className="carrier">{alt.carrier} · {alt.departureLocal} local</span>
                  <span className="dep mono">
                    {alt.bufferMin == null ? '—' : `${alt.bufferMin > 0 ? '+' : ''}${alt.bufferMin}′`}
                  </span>
                </div>
                {assignment && (
                  <div className="osk-alt-assigned">
                    → {assignment.assignedTotal} rebooked (
                    {TIER_ORDER.filter((t) => assignment.assigned[t])
                      .map((t) => `${TIER_META[t].shortCode} ${assignment.assigned[t]}`)
                      .join(' · ')}
                    ), {assignment.seatsRemaining} seat{assignment.seatsRemaining === 1 ? '' : 's'} left
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
      {unresolvedTotal > 0 && (
        <div className="osk-unresolved">
          {unresolvedTotal} pax (
          {TIER_ORDER.filter((t) => unresolvedByTier?.[t])
            .map((t) => `${TIER_META[t].shortCode} ${unresolvedByTier[t]}`)
            .join(' · ')}
          ) have no same-day capacity on a modeled alternate — overnight rebooking / next flight-out required.
        </div>
      )}
      {passengers.length > 0 && (
        <>
          <button className="osk-manifest-toggle" onClick={() => setShowManifest((v) => !v)}>
            {showManifest ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {showManifest ? 'Hide' : 'Show'} {passengers.length} impacted passenger{passengers.length === 1 ? '' : 's'}
          </button>
          {showManifest && (
            <div className="osk-manifest">
              {passengers.map((p) => (
                <div key={p.paxId} className="osk-manifest-row">
                  <span className="tier-dot" style={{ background: TIER_META[p.tier]?.color || '#94a3b8' }} />
                  <span className="name">
                    {p.name}
                    <span className="tier-label"> · {TIER_META[p.tier]?.label || p.tier}</span>
                    {p.specialAssistance && <span className="assist">{p.specialAssistance}</span>}
                  </span>
                  <span className="seat mono">{p.seat}</span>
                  <span className="pnr mono">{p.pnr}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function ConsoleTab({ openSkyConfig = {}, basemapConfig = {}, onOpenSettings }) {
  /* ── Live fleet state ───────────────────────────────────────────── */
  const [fleet, setFleet] = useState([]);
  const [status, setStatus] = useState({
    loading: true,
    error: null,
    errorKind: null,
    authenticated: false,
    fetchedAt: null,
    snapshotTime: null,
    totalStates: 0,
    creditsRemaining: null,
  });

  /* ── Operator controls ──────────────────────────────────────────── */
  const [scope, setScope] = useState('global');
  const [prefixes, setPrefixes] = useState(DEFAULT_PREFIXES);
  const [query, setQuery] = useState('');
  const [basemap, setBasemap] = useState('light');
  const [showLabels, setShowLabels] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [showOnGround, setShowOnGround] = useState(true);
  const [followSelected, setFollowSelected] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [selectedIcao, setSelectedIcao] = useState(null);

  /* ── Basemap provider ───────────────────────────────────────────── */
  const cartoKey = basemapConfig.cartoKey || '';
  const tileSource = useMemo(() => resolveTiles(basemap, cartoKey), [basemap, cartoKey]);
  // The map-init effect runs once with empty deps, so it reads the key
  // through a ref rather than closing over a stale value.
  const basemapRef = useRef(cartoKey);
  useEffect(() => { basemapRef.current = cartoKey; }, [cartoKey]);

  /* ── Simulation (stage 2) ───────────────────────────────────────── */
  const [simOpen, setSimOpen] = useState(false);
  const [simOpts, setSimOpts] = useState(DEFAULT_SIM_OPTIONS);
  const kg = useMemo(() => getKnowledgeGraph(), []);
  // Selecting a different aircraft must not silently carry the previous
  // aircraft's 90-minute delay onto it — that would be a simulation of
  // something nobody asked for, presented as this aircraft's outlook.
  useEffect(() => {
    if (selectedIcao === DISRUPTION_DEMO_ICAO24) {
      setSimOpts(DISRUPTION_SIM_PRESET);
      setSimOpen(true);
    } else {
      setSimOpts(DEFAULT_SIM_OPTIONS);
    }
  }, [selectedIcao]);

  /* ── Leaflet refs (kept out of React state so the 1 Hz animation
        ticker can mutate markers without re-rendering the tree) ───── */
  const mapEl = useRef(null);
  const map = useRef(null);
  const tileLayer = useRef(null);
  const labelLayer = useRef(null);   // Esri's reference overlay (labels)
  const simLayer = useRef(null);     // simulated route + destination pin
  const markers = useRef(new Map());   // icao24 → L.Marker
  const iconSigs = useRef(new Map());  // icao24 → last-rendered icon signature
  const trails = useRef(new Map());    // icao24 → [[lat, lon], …] raw fixes
  const trailLine = useRef(null);
  const fleetRef = useRef([]);
  const selectedRef = useRef(null);
  const settingsRef = useRef({ showLabels: true, showOnGround: true });
  // OpenSky stamps each fix with ITS clock. Comparing that directly to the
  // browser's Date.now() bakes in both network latency and any local clock
  // skew, which would make every aircraft dead-reckon from the wrong start
  // time. Each successful poll re-measures the offset between the two.
  const clockSkew = useRef(0);

  /* ══════════════════════════════════════════════════════════════════
     DATA — fetch OpenSky on demand (mount, scope/credential change, or the
     operator pressing Refresh). There is no auto-poll: a background refetch
     was stepping on the operator's simulation mid-run, so the map now only
     ever updates when something explicitly asks it to.
     ══════════════════════════════════════════════════════════════════ */
  const loadRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let controller = null;
    // Each fetch carries a generation number. A manual refresh aborts the
    // in-flight fetch and starts a new generation; the aborted one still
    // runs its finally block, so without this guard a fast double-click on
    // Refresh could let a stale response overwrite a newer one.
    let generation = 0;

    async function load() {
      const myGeneration = ++generation;
      controller = new AbortController();
      setStatus((s) => ({ ...s, loading: true }));
      try {
        const result = await fetchAirlineTraffic({
          scope,
          prefixes: ALL_PREFIXES,
          clientId: openSkyConfig.clientId || '',
          clientSecret: openSkyConfig.clientSecret || '',
          signal: controller.signal,
        });
        if (cancelled) return;

        if (result.ok) {
          if (result.snapshotTime) clockSkew.current = result.fetchedAt - result.snapshotTime;
          // Real feed untouched; the one demo aircraft is appended after the
          // fact so it never counts toward totalStates or the API response.
          setFleet([...result.aircraft, buildDisruptionDemoAircraft(result.fetchedAt)]);
          // Append this fix to each aircraft's trail history.
          for (const ac of result.aircraft) {
            const t = trails.current.get(ac.icao24) || [];
            const last = t[t.length - 1];
            if (!last || last[0] !== ac.lat || last[1] !== ac.lon) {
              t.push([ac.lat, ac.lon]);
              if (t.length > TRAIL_MAX_POINTS) t.shift();
              trails.current.set(ac.icao24, t);
            }
          }
        }

        setStatus({
          loading: false,
          error: result.error,
          errorKind: result.errorKind,
          authenticated: result.authenticated,
          fetchedAt: result.fetchedAt,
          snapshotTime: result.snapshotTime,
          totalStates: result.totalStates,
          creditsRemaining: result.creditsRemaining,
        });
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        setStatus((s) => ({ ...s, loading: false, error: err.message, errorKind: 'network' }));
      }
    }

    loadRef.current = () => {
      if (controller) controller.abort();
      load();
    };

    load();
    return () => {
      cancelled = true;
      if (controller) controller.abort();
    };
  }, [scope, openSkyConfig.clientId, openSkyConfig.clientSecret]);

  // Credentials changed → drop the cached bearer token so the next fetch
  // re-authenticates rather than reusing a token for the old client.
  useEffect(() => { resetAuth(); }, [openSkyConfig.clientId, openSkyConfig.clientSecret]);

  /* ══════════════════════════════════════════════════════════════════
     DERIVED — search filter and headline stats
     ══════════════════════════════════════════════════════════════════ */
  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    const matches = fleet.filter((ac) => {
      if (!prefixes.includes(ac.operator)) return false;
      if (!showOnGround && ac.onGround) return false;
      if (!q) return true;
      return (
        ac.callsign.includes(q) ||
        (ac.iataFlight || '').includes(q) ||
        ac.icao24.toUpperCase().includes(q) ||
        ac.originCountry.toUpperCase().includes(q)
      );
    });

    // MAX_VISIBLE_AIRCRAFT caps the real feed only — the synthetic
    // disruption-demo aircraft (isDemo: true) is exempt so it never gets
    // pushed out by a large real fleet mid-scenario.
    const real = matches.filter((ac) => !ac.isDemo);
    const demo = matches.filter((ac) => ac.isDemo);
    return real.slice(0, MAX_VISIBLE_AIRCRAFT).concat(demo);
  }, [fleet, query, showOnGround, prefixes]);

  const sortedVisible = useMemo(
    () => [...visible].sort((a, b) => a.callsign.localeCompare(b.callsign)),
    [visible],
  );

  // Headline stats follow the airline chips but ignore the search box, so
  // typing a callsign narrows the map without making the fleet look smaller.
  const stats = useMemo(() => {
    // Demo aircraft is excluded here on purpose — the header's live fleet
    // stats stay real, per "I need the real time dataset as it is".
    const inScope = fleet.filter((a) => prefixes.includes(a.operator) && !a.isDemo);
    const airborne = inScope.filter((a) => !a.onGround);
    const highest = airborne.reduce((m, a) => Math.max(m, a.flightLevel ?? 0), 0);
    const fastest = airborne.reduce((m, a) => Math.max(m, a.velocityKt ?? 0), 0);
    return {
      total: inScope.length,
      airborne: airborne.length,
      ground: inScope.length - airborne.length,
      highest,
      fastest,
    };
  }, [fleet, prefixes]);

  const selected = useMemo(
    () => fleet.find((a) => a.icao24 === selectedIcao) || null,
    [fleet, selectedIcao],
  );

  /** Milliseconds since an aircraft's last position fix, corrected for the
   *  measured offset between OpenSky's clock and this browser's. */
  const elapsedFor = useCallback((ac) => {
    if (!ac?.timePosition) return 0;
    return Math.max(0, Date.now() - (ac.timePosition * 1000 + clockSkew.current));
  }, []);

  useEffect(() => { fleetRef.current = visible; }, [visible]);
  useEffect(() => { selectedRef.current = selectedIcao; }, [selectedIcao]);
  useEffect(() => { settingsRef.current = { showLabels, showOnGround }; }, [showLabels, showOnGround]);

  /* ══════════════════════════════════════════════════════════════════
     MAP — init once
     ══════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (map.current || !mapEl.current) return;

    map.current = L.map(mapEl.current, {
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: true,
      minZoom: 2,
      preferCanvas: false,
    }).setView([48, 6], 4);

    L.control.zoom({ position: 'bottomright' }).addTo(map.current);

    const src = resolveTiles('light', basemapRef.current);
    tileLayer.current = L.tileLayer(src.url, { maxZoom: src.maxZoom }).addTo(map.current);
    if (src.labels) {
      labelLayer.current = L.tileLayer(src.labels, { maxZoom: src.maxZoom }).addTo(map.current);
    }

    // Deselect when clicking empty map, the way OpenSky's map does.
    map.current.on('click', () => setSelectedIcao(null));

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
      markers.current.clear();
      iconSigs.current.clear();
    };
  }, []);

  /* Basemap swap — also re-runs when a CARTO key is added or removed in
     Settings, which is what switches the whole map between providers.
     The label overlay is created and destroyed rather than re-pointed,
     because only one of the two providers has a separate labels layer. */
  useEffect(() => {
    if (!map.current || !tileLayer.current) return;
    const src = resolveTiles(basemap, cartoKey);

    tileLayer.current.options.maxZoom = src.maxZoom;
    tileLayer.current.setUrl(src.url);

    if (src.labels) {
      if (labelLayer.current) labelLayer.current.setUrl(src.labels);
      else labelLayer.current = L.tileLayer(src.labels, { maxZoom: src.maxZoom }).addTo(map.current);
    } else if (labelLayer.current) {
      labelLayer.current.remove();
      labelLayer.current = null;
    }

    mapEl.current.style.background = BASEMAPS[basemap].background;
  }, [basemap, cartoKey]);

  /* ── Marker icon builder ────────────────────────────────────────── */
  const buildIcon = useCallback((ac, isSelected, labelsOn) => {
    const color = altitudeColor(ac);
    if (ac.onGround) {
      return L.divIcon({
        className: 'osk-marker',
        html: `
          <div class="osk-ac ground ${isSelected ? 'selected' : ''}" style="--ac:${color}">
            <span class="osk-ground-dot"></span>
            ${labelsOn ? `<span class="osk-ac-label">${ac.callsign}</span>` : ''}
          </div>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      });
    }
    return L.divIcon({
      className: 'osk-marker',
      html: `
        <div class="osk-ac ${isSelected ? 'selected' : ''}" style="--ac:${color}">
          <svg viewBox="0 0 24 24" style="transform: rotate(${Math.round(ac.headingDeg)}deg)">
            <path d="${PLANE_PATH}"/>
          </svg>
          ${labelsOn ? `<span class="osk-ac-label">${ac.callsign}</span>` : ''}
        </div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }, []);

  /* ══════════════════════════════════════════════════════════════════
     MAP — reconcile markers against the visible fleet.
     Markers are reused across refreshes (keyed by ICAO24) so aircraft
     glide rather than blink.
     ══════════════════════════════════════════════════════════════════ */
  const syncMarkers = useCallback(() => {
    if (!map.current) return;
    const now = Date.now();
    const seen = new Set();
    const labelsOn = settingsRef.current.showLabels;

    for (const ac of fleetRef.current) {
      seen.add(ac.icao24);
      const isSelected = ac.icao24 === selectedRef.current;
      const elapsed = ac.timePosition
        ? Math.max(0, now - (ac.timePosition * 1000 + clockSkew.current))
        : 0;
      const [lat, lon] = extrapolate(ac, elapsed);

      let marker = markers.current.get(ac.icao24);
      const sig = `${Math.round(ac.headingDeg / 3)}|${altitudeColor(ac)}|${isSelected}|${labelsOn}|${ac.onGround}`;

      if (!marker) {
        marker = L.marker([lat, lon], {
          icon: buildIcon(ac, isSelected, labelsOn),
          riseOnHover: true,
          keyboard: false,
        }).addTo(map.current);
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          setSelectedIcao(ac.icao24);
        });
        markers.current.set(ac.icao24, marker);
        iconSigs.current.set(ac.icao24, sig);
      } else {
        marker.setLatLng([lat, lon]);
        if (iconSigs.current.get(ac.icao24) !== sig) {
          marker.setIcon(buildIcon(ac, isSelected, labelsOn));
          iconSigs.current.set(ac.icao24, sig);
        }
      }

      marker.setZIndexOffset(isSelected ? 1000 : 0);

      const tip =
        `<b>${ac.callsign}</b>${ac.iataFlight ? ` · ${ac.iataFlight}` : ''}<br/>` +
        `${ac.onGround ? 'On ground' : `FL${ac.flightLevel ?? '—'} · ${fmt(ac.velocityKt)} kt`}`;
      if (marker.getTooltip()) marker.setTooltipContent(tip);
      else marker.bindTooltip(tip, { direction: 'top', offset: [0, -12], className: 'osk-tooltip' });
    }

    // Retire markers for aircraft that dropped out of the feed.
    for (const [icao, marker] of markers.current) {
      if (!seen.has(icao)) {
        marker.remove();
        markers.current.delete(icao);
        iconSigs.current.delete(icao);
      }
    }
  }, [buildIcon]);

  // Re-sync whenever the visible set or presentation options change …
  useEffect(() => { syncMarkers(); }, [visible, selectedIcao, showLabels, syncMarkers]);

  // … and once a second in between, to advance the dead-reckoned positions.
  useEffect(() => {
    const t = setInterval(syncMarkers, 1000);
    return () => clearInterval(t);
  }, [syncMarkers]);

  /* ── Trail for the selected aircraft ────────────────────────────── */
  useEffect(() => {
    if (!map.current) return;
    if (trailLine.current) {
      trailLine.current.remove();
      trailLine.current = null;
    }
    if (!showTrail || !selectedIcao) return;
    const pts = trails.current.get(selectedIcao);
    if (!pts || pts.length < 2) return;
    trailLine.current = L.polyline(pts, {
      color: '#38bdf8',
      weight: 2,
      opacity: 0.85,
      dashArray: '4 4',
    }).addTo(map.current);
  }, [selectedIcao, showTrail, fleet]);

  /* ── Follow mode ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!followSelected || !selected || !map.current) return;
    map.current.panTo(extrapolate(selected, elapsedFor(selected)), { animate: true, duration: 0.6 });
  }, [followSelected, selected, elapsedFor]);

  const centerOn = useCallback((ac) => {
    if (!map.current) return;
    map.current.setView(extrapolate(ac, elapsedFor(ac)), Math.max(map.current.getZoom(), 6), { animate: true });
  }, [elapsedFor]);

  /* ══════════════════════════════════════════════════════════════════
     SIMULATION
     ══════════════════════════════════════════════════════════════════
     Stage 2 of the console revamp: the delay/recovery simulation that
     stage 1 removed from the docked bottom panel, now hung off a real
     aircraft the operator has clicked on. See lib/flightSimulator.js for
     the chain and for the two joins between live data and the ontology
     that need care (destination inference, and the schedule-day
     alignment between a 2026-08-30 knowledge graph and today's arrival).
     ══════════════════════════════════════════════════════════════════ */

  const simAirports = useMemo(
    () => kg.getAllAirports()
      .map((a) => ({ id: a.id, name: a.name, city: a.city, role: a.role }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [kg],
  );

  /* Feed the simulator the aircraft where it is NOW, not where its last
     fix put it. On a 60-second poll a 460-kt aircraft is up to 7 nm past
     its reported position, and an ETA computed from a stale point is off
     by more than several of the numbers it is being compared against. */
  const simAircraft = useMemo(() => {
    if (!selected) return null;
    const [lat, lon] = extrapolate(selected, elapsedFor(selected));
    return { ...selected, lat, lon };
  }, [selected, elapsedFor, fleet]);

  const sim = useMemo(() => {
    if (!simOpen || !simAircraft) return null;
    try {
      return simulateFlight({ aircraft: simAircraft, kg, options: simOpts });
    } catch (err) {
      // A simulation is a side feature. It must never take the live map
      // down with it, so a thrown error becomes a message in the panel.
      return { ok: false, reason: `Simulation failed: ${err.message}` };
    }
  }, [simOpen, simAircraft, kg, simOpts]);

  const setSim = (patch) => setSimOpts((prev) => ({ ...prev, ...patch }));

  /* ── Disruption-scenario KPIs ── derived from the live feed and the KG,
        not scripted. See DISRUPTION_DEMO_ICAO24 above for what is and isn't
        computed — crew duty and catering/baggage have no data model here and
        are deliberately left out of this list rather than faked. ── */
  const disruptionLiveInbound = useMemo(() => {
    let n = 0;
    for (const ac of fleet) {
      if (ac.isDemo || ac.onGround || ac.lat == null) continue;
      const top = rankDestinations(ac, kg.getAllAirports())[0];
      if (top && (top.id === 'AMS' || top.id === 'CDG')) n++;
    }
    return n;
  }, [fleet, kg]);

  const disruptionSlotConstraints = useMemo(() => {
    const seen = new Map();
    for (const r of [...kg.getConnectedRoutes('AMS'), ...kg.getConnectedRoutes('CDG')]) {
      if (r.status === 'SLOT_CONSTRAINED') seen.set(r.routeId, r);
    }
    return [...seen.values()];
  }, [kg]);

  const disruptionHubExposure = useMemo(() => {
    const touchingHubs = kg.getAllFlights().filter((f) =>
      ['AMS', 'CDG'].includes(f.originAirportId) || ['AMS', 'CDG'].includes(f.destinationAirportId));
    const strained = touchingHubs.filter(
      (f) => f.connectionRiskTier === 'TIGHT_MCT' || f.status === 'AT_RISK',
    );
    return { count: strained.length, pax: strained.reduce((s, f) => s + (f.paxCount || 0), 0) };
  }, [kg]);

  /* Which Onward Bank row (if any) is expanded to show its own reroute
     detail inline — the fix for "which passengers belong to which flight":
     instead of a separate Proposed Recovery list the operator has to
     cross-reference by flight number, each at-risk row owns its own
     expandable detail directly underneath it. */
  const [expandedConnections, setExpandedConnections] = useState(() => new Set());
  const toggleConn = useCallback((flightId) => {
    setExpandedConnections((prev) => {
      const next = new Set(prev);
      if (next.has(flightId)) next.delete(flightId);
      else next.add(flightId);
      return next;
    });
  }, []);
  // A newly-selected aircraft starts with everything collapsed rather than
  // inheriting whatever was expanded for the previous one.
  useEffect(() => {
    setExpandedConnections(new Set());
  }, [simAircraft?.icao24]);

  /** originalConnectingFlightId -> its RebookPassengers action, so an Onward
   *  Bank row can look up its own reroute detail by flight id in O(1). */
  const rebookActionsByFlight = useMemo(() => {
    const map = {};
    for (const a of sim?.recovery?.actions || []) {
      if (a.actionType === 'RebookPassengers') map[a.context.originalConnectingFlightId] = a;
    }
    return map;
  }, [sim]);
  const simDirty =
    simOpts.delayMin !== 0 || simOpts.holdMin !== 0
    || simOpts.speedAdjustPct !== 0 || !!simOpts.divertToId
    || !!simOpts.destinationId || simOpts.mctMinutes !== DEFAULT_SIM_OPTIONS.mctMinutes;

  /* ── Simulated route drawn on the map ───────────────────────────── */
  useEffect(() => {
    if (!map.current) return;
    if (simLayer.current) {
      simLayer.current.remove();
      simLayer.current = null;
    }
    if (!sim?.ok || !simAircraft) return;

    const layer = L.layerGroup();
    const from = [simAircraft.lat, simAircraft.lon];
    const dest = [sim.destination.lat, sim.destination.lon];

    const pin = (latlng, color, label) =>
      L.circleMarker(latlng, {
        radius: 5, color, weight: 2, fillColor: '#0b1120', fillOpacity: 1,
      }).bindTooltip(label, { direction: 'top', offset: [0, -8], className: 'osk-tooltip' });

    // Planned leg: dashed, because it is a projection and not a filed route.
    L.polyline([from, dest], {
      color: '#38bdf8', weight: 1.5, opacity: 0.75, dashArray: '6 6',
    }).addTo(layer);
    pin(dest, '#38bdf8', `${sim.destination.id} · ETA ${zulu(sim.baseline.arrivalMs)}`).addTo(layer);

    if (sim.diverted && sim.alternate) {
      L.polyline([from, [sim.alternate.lat, sim.alternate.lon]], {
        color: '#f97316', weight: 2, opacity: 0.9,
      }).addTo(layer);
      pin(
        [sim.alternate.lat, sim.alternate.lon],
        '#f97316',
        `Divert ${sim.alternate.id} · ${zulu(sim.simulated.arrivalMs)}`,
      ).addTo(layer);
    }

    layer.addTo(map.current);
    simLayer.current = layer;
  }, [sim, simAircraft]);

  const togglePrefix = (p) =>
    setPrefixes((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const snapshotAge = status.snapshotTime ? Math.round((Date.now() - status.snapshotTime) / 1000) : null;
  const feedHealthy = !status.error && fleet.length > 0;

  /* ══════════════════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════════════════ */
  return (
    <div className="app-container">
      {/* ── HEADER: live fleet vitals, replacing the old scenario KPIs ── */}
      <header className="app-header">
        <div className="app-logo">
          <Radio size={20} style={{ color: feedHealthy ? 'var(--healthy)' : 'var(--warn)' }} />
          <span>Live Fleet Traffic</span>
          <span className={`osk-feed-pill ${feedHealthy ? 'ok' : status.error ? 'bad' : 'idle'}`}>
            <span className="dot" />
            {status.error ? 'FEED DEGRADED' : status.loading && !fleet.length ? 'CONNECTING' : 'ADS-B LIVE'}
          </span>
        </div>

        <div className="header-metrics">
          <div className="header-metric">
            <span className="label">Airborne</span>
            <span className="val healthy">{stats.airborne}</span>
          </div>
          <div className="header-metric">
            <span className="label">On Ground</span>
            <span className="val">{stats.ground}</span>
          </div>
          <div className="header-metric">
            <span className="label">Highest</span>
            <span className="val">{stats.highest ? `FL${stats.highest}` : '—'}</span>
          </div>
          <div className="header-metric">
            <span className="label">Fastest</span>
            <span className="val">{stats.fastest ? `${stats.fastest} kt` : '—'}</span>
          </div>
          <div className="header-metric">
            <span className="label">Feed Age</span>
            <span className="val" style={{ color: snapshotAge > 120 ? 'var(--warn)' : undefined }}>
              {snapshotAge != null ? `${snapshotAge}s` : '—'}
            </span>
          </div>
          <div className="header-metric">
            <span className="label">Auth</span>
            <span className="val" style={{ color: status.authenticated ? 'var(--healthy)' : 'var(--warn)' }}>
              {status.authenticated ? 'OAuth2' : 'Anonymous'}
            </span>
          </div>
        </div>
      </header>

      {/* ── WORKSPACE: the map, edge to edge ── */}
      <div className="app-workspace">
        <div className="osk-map-wrap">
          <div ref={mapEl} className="osk-map" style={{ background: BASEMAPS[basemap].background }} />

          {/* ── Control card (top-left) ── */}
          <div className="osk-panel osk-panel-controls">
            <div className="osk-panel-head">
              <Plane size={15} />
              <div>
                <h4>Fleet · Live</h4>
                <p>
                  {visible.filter((a) => !a.isDemo).length}{visible.some((a) => a.isDemo) ? ' +1 demo' : ''}
                  {' '}shown of {stats.total} tracked · {SCOPES[scope].label} scope
                </p>
              </div>
            </div>

            <div className="osk-search">
              <Search size={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Callsign, KL number, ICAO24…"
              />
              {query && (
                <button className="osk-icon-btn" onClick={() => setQuery('')} title="Clear">
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="osk-chip-row">
              {Object.values(AIRLINE_CALLSIGN_PREFIXES).map((a) => (
                <button
                  key={a.prefix}
                  className={`osk-chip ${prefixes.includes(a.prefix) ? 'on' : ''}`}
                  onClick={() => togglePrefix(a.prefix)}
                  title={a.label}
                >
                  {a.prefix}
                </button>
              ))}
            </div>

            <div className="osk-chip-row">
              <button className={`osk-chip ${showLabels ? 'on' : ''}`} onClick={() => setShowLabels((v) => !v)}>
                <Tag size={10} /> Labels
              </button>
              <button className={`osk-chip ${showTrail ? 'on' : ''}`} onClick={() => setShowTrail((v) => !v)}>
                <Route size={10} /> Trail
              </button>
              <button className={`osk-chip ${showOnGround ? 'on' : ''}`} onClick={() => setShowOnGround((v) => !v)}>
                <Globe size={10} /> Ground
              </button>
              <button
                className={`osk-chip ${basemap === 'light' ? 'on' : ''}`}
                onClick={() => setBasemap((b) => (b === 'dark' ? 'light' : 'dark'))}
              >
                <Layers size={10} /> {BASEMAPS[basemap].label}
              </button>
            </div>

            <button className="osk-list-toggle" onClick={() => setListOpen((v) => !v)}>
              {listOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              Aircraft list ({sortedVisible.length})
            </button>

            {listOpen && (
              <div className="osk-list">
                {sortedVisible.length === 0 && (
                  <div className="osk-list-empty">
                    {status.loading ? 'Querying OpenSky…' : 'No aircraft match the current filters.'}
                  </div>
                )}
                {sortedVisible.map((ac) => (
                  <button
                    key={ac.icao24}
                    className={`osk-list-row ${ac.icao24 === selectedIcao ? 'active' : ''}`}
                    onClick={() => { setSelectedIcao(ac.icao24); centerOn(ac); }}
                  >
                    <span className="dot" style={{ background: altitudeColor(ac) }} />
                    <span className="cs">{ac.callsign}</span>
                    <span className="fl">{ac.onGround ? 'GND' : `FL${ac.flightLevel ?? '—'}`}</span>
                    <span className="kt">{ac.velocityKt != null ? `${ac.velocityKt}kt` : '—'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Feed controls (top-right) ── */}
          <div className="osk-panel osk-panel-feed">
            <div className="osk-feed-row">
              <label>Scope</label>
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                {Object.values(SCOPES).map((s) => (
                  <option key={s.id} value={s.id}>{s.label} · {s.credits} cr</option>
                ))}
              </select>
            </div>
            <div className="osk-feed-actions">
              <button
                className="osk-btn"
                onClick={() => loadRef.current && loadRef.current()}
                disabled={status.loading}
              >
                <RefreshCw size={12} className={status.loading ? 'osk-spin' : ''} />
                {status.loading ? 'Fetching' : 'Refresh'}
              </button>
              {onOpenSettings && (
                <button className="osk-btn ghost" onClick={onOpenSettings} title="OpenSky credentials">
                  <SettingsIcon size={12} />
                </button>
              )}
            </div>
            {status.fetchedAt != null && (
              <div className="osk-feed-note">Updated {zulu(status.fetchedAt)}</div>
            )}
            {status.creditsRemaining != null && (
              <div className="osk-feed-note">{status.creditsRemaining} credits left today</div>
            )}
          </div>

          {/* ── Error banner ── */}
          {status.error && (
            <div className="osk-error">
              <AlertTriangle size={14} />
              <div>
                <strong>OpenSky feed problem</strong>
                <p>{status.error}</p>
              </div>
              <button className="osk-icon-btn" onClick={() => setStatus((s) => ({ ...s, error: null }))}>
                <X size={12} />
              </button>
            </div>
          )}

          {/* ── Altitude legend (bottom-left) ── */}
          <div className="osk-legend">
            <span className="osk-legend-title">Altitude</span>
            {ALTITUDE_BANDS.map((b) => (
              <span key={b.label} className="osk-legend-item">
                <i style={{ background: b.color }} />
                {b.label}
              </span>
            ))}
          </div>

          {/* ── Attribution (bottom-centre) ── */}
          <div className="osk-attrib">
            Live ADS-B via <strong>The OpenSky Network</strong> · positions interpolated between
            {' '}manual refreshes · {tileSource.attribution}
          </div>

          {/* ── Aircraft detail drawer (right overlay) ── */}
          {selected && (
            <div className="osk-drawer">
              <div className="osk-drawer-head" style={{ borderColor: altitudeColor(selected) }}>
                <div>
                  <h3>{selected.callsign}</h3>
                  <p>
                    {selected.iataFlight ? `${selected.iataFlight} · ` : ''}
                    {AIRLINE_CALLSIGN_PREFIXES[selected.operator]?.label || selected.operator}
                  </p>
                </div>
                <button className="osk-icon-btn" onClick={() => setSelectedIcao(null)}>
                  <X size={14} />
                </button>
              </div>

              <div className="osk-drawer-status" style={{ color: verticalTrend(selected.verticalRateFpm).color }}>
                {selected.onGround ? '● on ground' : verticalTrend(selected.verticalRateFpm).label}
              </div>

              <div className="osk-kv-grid">
                <div><label>Altitude</label><span>{selected.altitudeFt != null ? `${fmt(selected.altitudeFt)} ft` : '—'}</span></div>
                <div><label>Flight level</label><span>{selected.flightLevel != null ? `FL${selected.flightLevel}` : '—'}</span></div>
                <div><label>Ground speed</label><span>{selected.velocityKt != null ? `${selected.velocityKt} kt` : '—'}</span></div>
                <div><label>Speed (km/h)</label><span>{fmt(selected.velocityKph)}</span></div>
                <div><label>True track</label><span>{Math.round(selected.headingDeg)}°</span></div>
                <div><label>Vertical rate</label><span>{selected.verticalRateFpm != null ? `${fmt(selected.verticalRateFpm)} ft/min` : '—'}</span></div>
                <div><label>Latitude</label><span>{selected.lat.toFixed(4)}°</span></div>
                <div><label>Longitude</label><span>{selected.lon.toFixed(4)}°</span></div>
                <div><label>ICAO24</label><span className="mono">{selected.icao24.toUpperCase()}</span></div>
                <div><label>Squawk</label><span className="mono">{selected.squawk || '—'}</span></div>
                <div><label>Registered</label><span>{selected.originCountry}</span></div>
                <div><label>Source</label><span>{selected.positionSource}</span></div>
                <div><label>Baro alt</label><span>{selected.baroAltitudeM != null ? `${fmt(Math.round(selected.baroAltitudeM))} m` : '—'}</span></div>
                <div><label>Geo alt</label><span>{selected.geoAltitudeM != null ? `${fmt(Math.round(selected.geoAltitudeM))} m` : '—'}</span></div>
              </div>

              <div className="osk-drawer-foot">
                <div className="osk-fix-age">
                  Position fix {ageLabel(Math.round(elapsedFor(selected) / 1000))}
                  {selected.spi && <span className="osk-spi">SPI</span>}
                </div>
                <div className="osk-drawer-actions">
                  <button className="osk-btn" onClick={() => centerOn(selected)}>
                    <Crosshair size={12} /> Centre
                  </button>
                  <button
                    className={`osk-btn ${followSelected ? '' : 'ghost'}`}
                    onClick={() => setFollowSelected((v) => !v)}
                  >
                    {followSelected ? 'Following' : 'Follow'}
                  </button>
                </div>
              </div>

              {selected.isDemo && (
                <div className="osk-disruption">
                  <div className="osk-disruption-head">
                    <AlertTriangle size={13} />
                    <span>Disruption Scenario</span>
                  </div>
                  <p className="osk-disruption-narrative">
                    It's 14:30 on a Tuesday. A severe crosswind event closes the
                    Polderbaan at AMS, and simultaneously ATC goes on a slowdown at
                    CDG due to a strike.{' '}
                    {selected.iataFlight || selected.callsign} pushed back into that
                    slowdown and is now holding short of AMS awaiting a runway — the
                    Onward bank below is this arrival's real knowledge-graph
                    connection risk, not a scripted number.
                  </p>
                  <div className="osk-disruption-kpis">
                    <div className="osk-disruption-kpi">
                      <span className="v">{disruptionLiveInbound}</span>
                      <span className="l">live KLM/AF aircraft inbound AMS/CDG right now</span>
                    </div>
                    <div className="osk-disruption-kpi">
                      <span className="v">{disruptionSlotConstraints.length}</span>
                      <span className="l">route{disruptionSlotConstraints.length === 1 ? '' : 's'} already slot-constrained at AMS/CDG (KG)</span>
                    </div>
                    <div className="osk-disruption-kpi">
                      <span className="v">{disruptionHubExposure.count}</span>
                      <span className="l">{disruptionHubExposure.pax.toLocaleString()} pax already on tight/at-risk AMS/CDG flights (KG)</span>
                    </div>
                  </div>
                  <p className="osk-disruption-note">
                    Numbers above are computed from the live feed and the knowledge
                    graph. Crew duty and catering/baggage flows aren't modelled
                    anywhere in this build — they're part of the trigger story, not a
                    figure this panel computes. <b>Onward bank</b> and <b>Proposed
                    recovery</b> below run through the same simulator every other
                    aircraft on this map uses.
                  </p>
                </div>
              )}

              {/* ── SIMULATION ───────────────────────────────────── */}
              <div className="osk-sim">
                <button
                  className={`osk-sim-toggle ${simOpen ? 'open' : ''}`}
                  onClick={() => setSimOpen((v) => !v)}
                >
                  <FlaskConical size={12} />
                  <span>{selected.isDemo ? 'Hold & recovery detail' : 'Simulate delay & recovery'}</span>
                  {simOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>

                {simOpen && (
                  <div className="osk-sim-body">
                    {!sim && <div className="osk-sim-note">Preparing simulation…</div>}
                    {sim && !sim.ok && <div className="osk-sim-note warn">{sim.reason}</div>}

                    {sim?.ok && (
                      <>
                        {/* ── Destination ── */}
                        <div className="osk-sim-block">
                          <div className="osk-sim-row">
                            <label>Arriving</label>
                            <select
                              value={simOpts.destinationId || ''}
                              onChange={(e) => setSim({ destinationId: e.target.value || null })}
                            >
                              <option value="">
                                Auto · {sim.candidates[0]?.id || sim.destination.id}
                              </option>
                              {simAirports.map((a) => (
                                <option key={a.id} value={a.id}>{a.id} — {a.city}</option>
                              ))}
                            </select>
                          </div>
                          <p className="osk-sim-hint">
                            {sim.destinationInferred ? (
                              <>
                                Inferred from track {Math.round(selected.headingDeg)}° —{' '}
                                {sim.destination.offTrackDeg}° off, {sim.destination.crossTrackNm} nm
                                cross-track, confidence <strong>{sim.confidence}</strong>. ADS-B
                                carries no route, so this is a hypothesis — override it if it is wrong.
                              </>
                            ) : (
                              <>Set manually to {sim.destination.name}.</>
                            )}
                          </p>
                        </div>

                        {/* ── Perturbations ── not shown for the synthetic
                             disruption aircraft: its hold/delay/MCT are fixed by
                             DISRUPTION_SIM_PRESET, not operator-adjustable ── */}
                        {!selected.isDemo && (
                        <div className="osk-sim-block">
                          <div className="osk-sim-slider">
                            <label>Delay <b>{simOpts.delayMin} min</b></label>
                            <input
                              type="range" min="0" max="180" step="5"
                              value={simOpts.delayMin}
                              onChange={(e) => setSim({ delayMin: Number(e.target.value) })}
                            />
                          </div>
                          <div className="osk-sim-slider">
                            <label>Hold <b>{simOpts.holdMin} min</b></label>
                            <input
                              type="range" min="0" max="60" step="5"
                              value={simOpts.holdMin}
                              onChange={(e) => setSim({ holdMin: Number(e.target.value) })}
                            />
                          </div>
                          <div className="osk-sim-slider">
                            <label>
                              Speed <b>{simOpts.speedAdjustPct > 0 ? '+' : ''}{simOpts.speedAdjustPct}%</b>
                              <span className="osk-sim-sub">
                                {sim.simulated.cruiseKt} kt enroute
                              </span>
                            </label>
                            <input
                              type="range" min="-25" max="15" step="1"
                              value={simOpts.speedAdjustPct}
                              onChange={(e) => setSim({ speedAdjustPct: Number(e.target.value) })}
                            />
                          </div>
                          <div className="osk-sim-row">
                            <label><CornerUpRight size={10} /> Divert</label>
                            <select
                              value={simOpts.divertToId}
                              onChange={(e) => setSim({ divertToId: e.target.value })}
                            >
                              <option value="">No diversion</option>
                              {simAirports
                                .filter((a) => a.id !== sim.destination.id)
                                .map((a) => (
                                  <option key={a.id} value={a.id}>{a.id} — {a.city}</option>
                                ))}
                            </select>
                          </div>
                          <div className="osk-sim-row">
                            <label>MCT <b>{simOpts.mctMinutes} min</b></label>
                            <input
                              type="range" min="30" max="90" step="5"
                              value={simOpts.mctMinutes}
                              onChange={(e) => setSim({ mctMinutes: Number(e.target.value) })}
                            />
                          </div>
                        </div>
                        )}

                        {/* ── Result ── */}
                        <div className="osk-sim-result">
                          <div className="osk-sim-eta">
                            <div>
                              <label>Current profile</label>
                              <span className="mono">{zulu(sim.baseline.arrivalMs)}</span>
                              <small>{sim.baseline.distanceNm} nm · {sim.baseline.blockMin} min</small>
                            </div>
                            <div className={sim.deltaMin > 0 ? 'worse' : sim.deltaMin < 0 ? 'better' : ''}>
                              <label>Simulated</label>
                              <span className="mono">{zulu(sim.effectiveArrivalMs)}</span>
                              <small>{deltaLabel(sim.deltaMin)}</small>
                            </div>
                          </div>
                          {sim.diverted && (
                            <p className="osk-sim-hint">
                              On the ground at {sim.alternate.id} at{' '}
                              <span className="mono">{zulu(sim.simulated.arrivalMs)}</span>. Connections
                              are still measured at {sim.destination.id}, because a diversion does not
                              cost the passengers the flying time to {sim.alternate.id} — it costs them
                              that plus the {sim.repositionMin}-minute turnaround and positioning leg
                              back to the hub they were connecting at.
                            </p>
                          )}
                        </div>

                        {/* ── Hub pressure ── */}
                        {sim.hub && (
                          <div className="osk-sim-block">
                            <div className={`osk-sim-hub ${sim.hub.status.toLowerCase()}`}>
                              <span className="dot" />
                              <div>
                                <strong>{sim.hub.airportId} {sim.hub.utilizationPct}% gate utilisation</strong>
                                <small>
                                  {sim.hub.status} · {sim.hub.headroom.toLocaleString()} spare movements/hr ·{' '}
                                  {sim.hub.freeGates} free gates · {sim.hub.inboundDelayedCount} delayed inbound
                                </small>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* ── Connection bank ── */}
                        <div className="osk-sim-block">
                          <div className="osk-sim-head">
                            <Timer size={11} />
                            <span>Onward bank at {sim.destination.id}</span>
                            {sim.paxAtRisk > 0 && (
                              <span className="osk-sim-badge bad">
                                <Users size={9} /> {sim.paxAtRisk} pax at risk
                              </span>
                            )}
                          </div>
                          {sim.connections.length === 0 && (
                            <p className="osk-sim-hint">
                              {sim.destination.id} has no key onward connections in the ontology, so
                              there is no misconnect exposure to compute here.
                            </p>
                          )}
                          {sim.connections.map((c) => {
                            const rebookAction = rebookActionsByFlight[c.onwardFlightId];
                            const clickable = c.atRisk && !!rebookAction;
                            const isOpen = clickable && expandedConnections.has(c.onwardFlightId);
                            return (
                              <div key={c.onwardFlightId} id={`osk-conn-${c.onwardFlightId}`} className="osk-sim-conn-wrap">
                                <div
                                  className={`osk-sim-conn ${bufferTone(c.bufferMin, simOpts.mctMinutes)} ${clickable ? 'clickable' : ''}`}
                                  role={clickable ? 'button' : undefined}
                                  tabIndex={clickable ? 0 : undefined}
                                  aria-expanded={clickable ? isOpen : undefined}
                                  onClick={clickable ? () => toggleConn(c.onwardFlightId) : undefined}
                                  onKeyDown={clickable ? (e) => {
                                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleConn(c.onwardFlightId); }
                                  } : undefined}
                                >
                                  <span className="cs mono">{c.onwardFlightId}</span>
                                  <span className="to">→ {c.destinationAirportId}</span>
                                  <span className="dep mono">{zulu(c.alignedDepartureMs)}</span>
                                  <span className="buf mono">
                                    {c.bufferMin == null
                                      ? '—'
                                      : `${c.bufferMin > 0 ? '+' : ''}${c.bufferMin}′`}
                                  </span>
                                  {clickable && (
                                    <span className="chev">{isOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}</span>
                                  )}
                                </div>
                                {c.atRisk && <TierChips paxByTier={c.paxByTier} />}
                                {clickable && !isOpen && (
                                  <button className="osk-conn-hint" onClick={() => toggleConn(c.onwardFlightId)}>
                                    <ChevronDown size={10} /> Who's affected &amp; reroute options
                                  </button>
                                )}
                                {isOpen && (
                                  <div className="osk-conn-detail">
                                    <RebookAlternatesDetail action={rebookAction} hideTierChips />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {/* ── Recovery plan ── */}
                        {sim.recovery && (
                          <div className="osk-sim-block">
                            <div className="osk-sim-head">
                              <ShieldCheck size={11} />
                              <span>Proposed recovery</span>
                              <span className="osk-sim-badge">
                                {Math.round(sim.recovery.recommendation.confidence * 100)}% confidence
                              </span>
                            </div>
                            <p className="osk-sim-summary">
                              {sim.atRisk.length} of {sim.connections.length} onward connections fall
                              below the {simOpts.mctMinutes}-minute MCT on the simulated arrival.{' '}
                              {sim.paxAtRisk} connecting passengers need rebooking
                              {sim.recovery.recommendation.estimatedVoucherPax > 0
                                ? `, ${sim.recovery.recommendation.estimatedVoucherPax} of them with hotel and meal vouchers`
                                : ''}.
                            </p>
                            {sim.recovery.actions.map((a, i) => (
                              <div key={i} className="osk-sim-action">
                                <div className="osk-sim-action-head">
                                  <strong>{a.actionType}</strong>
                                  <span className="osk-sim-badge ghost">{a.governance.approverRole}</span>
                                </div>
                                <div className="osk-sim-action-body">
                                  {a.actionType === 'RebookPassengers' ? (
                                    <>
                                      {a.context.paxAffected} pax off {a.context.originalConnectingFlightId} →{' '}
                                      {a.context.destinationAirportId}, buffer {a.context.bufferMin}′.{' '}
                                      {a.parameters.voucherPolicy === 'HOTEL_MEAL'
                                        ? 'Hotel + meal voucher.'
                                        : 'No voucher required.'}
                                      <button
                                        className="osk-conn-hint"
                                        onClick={() => {
                                          setExpandedConnections((prev) => new Set(prev).add(a.context.originalConnectingFlightId));
                                          document
                                            .getElementById(`osk-conn-${a.context.originalConnectingFlightId}`)
                                            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        }}
                                      >
                                        <ArrowUpToLine size={10} /> View {a.context.originalConnectingFlightId}'s passengers &amp; reroute options
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      +{a.parameters.additionalGateHours} gate-hours at{' '}
                                      {a.parameters.airportId}, currently {a.context.currentUtilPct}%
                                      utilised. Divert threshold {a.parameters.divertThresholdPct}%.
                                    </>
                                  )}
                                </div>
                                <div className="osk-sim-side">{a.sideEffects.join(' · ')}</div>
                              </div>
                            ))}
                            <p className="osk-sim-hint">
                              Proposals only. Every action is gated behind approval and audit logging —
                              nothing here is dispatched from this panel.
                            </p>
                          </div>
                        )}

                        {!sim.recovery && sim.connections.length > 0 && (
                          <p className="osk-sim-hint ok">
                            Every onward connection clears the {simOpts.mctMinutes}-minute MCT on this
                            arrival. No recovery needed.
                          </p>
                        )}

                        {simDirty && !selected.isDemo && (
                          <button className="osk-btn ghost osk-sim-reset" onClick={() => setSimOpts(DEFAULT_SIM_OPTIONS)}>
                            <RotateCcw size={11} /> Reset to live profile
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
