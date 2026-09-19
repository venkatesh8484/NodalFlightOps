/**
 * openSkyClient.js — Live ambient air-traffic layer via the OpenSky Network
 *
 * Free, anonymous, no-API-key REST access to real ADS-B aircraft position data
 * (see docs/design_spec.md §4a for the feasibility research behind this choice).
 * Replaces the prototype's hardcoded STATIC_FLIGHTS background-traffic markers
 * with genuinely live aircraft near the AMS hub — the curated Flight/Aircraft
 * records in data/*.json stay static so the anchor disruption scenario is
 * always reproducible; this module is purely an ambient-realism layer on top.
 *
 * Anonymous quota: 400 requests/day (10s position resolution). Non-commercial
 * license — fine for this internal ops-console demo.
 */

const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';

// Western Europe bounding box — covers AMS plus the LHR/CDG/CPH/FRA cluster,
// where the console's map is actually focused. A single box keeps quota usage
// low; the long-haul spokes (JFK/SIN/GRU/HND/DXB) are too far apart to cover
// with one box without losing the "ambient, local" feel this layer is for.
export const EUROPE_BBOX = { lamin: 35, lomin: -15, lamax: 62, lomax: 20 };

const STATE_FIELDS = [
  'icao24', 'callsign', 'originCountry', 'timePosition', 'lastContact',
  'longitude', 'latitude', 'baroAltitude', 'onGround', 'velocity',
  'trueTrack', 'verticalRate', 'sensors', 'geoAltitude', 'squawk', 'spi', 'positionSource',
];

function parseState(row) {
  const rec = {};
  STATE_FIELDS.forEach((key, i) => { rec[key] = row[i]; });
  return rec;
}

/**
 * Fetch live aircraft state vectors within a bounding box.
 * Fails soft — returns an empty array on any network/rate-limit error rather
 * than throwing, since this is an ambient decoration layer, not critical path.
 *
 * @param {{lamin:number, lomin:number, lamax:number, lomax:number}} bbox
 * @returns {Promise<Array<{icao24:string, callsign:string, lat:number, lon:number, altitudeM:number, velocityKph:number, headingDeg:number, onGround:boolean}>>}
 */
export async function fetchLiveTraffic(bbox = EUROPE_BBOX) {
  try {
    const url = `${OPENSKY_STATES_URL}?lamin=${bbox.lamin}&lomin=${bbox.lomin}&lamax=${bbox.lamax}&lomax=${bbox.lomax}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[openSkyClient] OpenSky returned ${res.status} — ambient traffic layer will stay empty this refresh.`);
      return [];
    }
    const data = await res.json();
    const states = Array.isArray(data?.states) ? data.states : [];

    return states
      .map(parseState)
      .filter(s => s.latitude != null && s.longitude != null && !s.onGround)
      .map(s => ({
        icao24: s.icao24,
        callsign: (s.callsign || '').trim() || s.icao24,
        lat: s.latitude,
        lon: s.longitude,
        altitudeM: s.geoAltitude ?? s.baroAltitude ?? null,
        velocityKph: s.velocity != null ? Math.round(s.velocity * 3.6) : null,
        headingDeg: s.trueTrack ?? 0,
        originCountry: s.originCountry,
      }));
  } catch (err) {
    console.warn('[openSkyClient] Live traffic fetch failed (network or CORS) — falling back to no ambient traffic this refresh:', err.message);
    return [];
  }
}

/**
 * Convenience wrapper: fetch and cap to a reasonable render count, sampled
 * for spread rather than just the first N, so the ambient layer doesn't
 * clump around one corner of the bounding box.
 */
export async function getAmbientTraffic(bbox = EUROPE_BBOX, maxCount = 35) {
  const traffic = await fetchLiveTraffic(bbox);
  if (traffic.length <= maxCount) return traffic;
  const stride = Math.ceil(traffic.length / maxCount);
  return traffic.filter((_, i) => i % stride === 0).slice(0, maxCount);
}
