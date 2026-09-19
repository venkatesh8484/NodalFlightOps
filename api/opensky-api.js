// Serverless proxy for OpenSky's /api/* REST endpoints.
//
// Why this exists: opensky-network.org sends no Access-Control-Allow-Origin
// header, so the browser can't call it directly (see src/lib/openSkyClient.js
// for the full writeup). Locally this is handled by the Vite dev proxy
// (vite.config.js) or the Electron main process (main.js). This function is
// the equivalent for the hosted web build.
//
// Routing: vercel.json rewrites /opensky-api/:path* to
// /api/opensky-api?path=:path* — the captured segments are passed
// EXPLICITLY as a query parameter in the rewrite destination, rather than
// relying on Vercel to implicitly bind them the way a direct request to a
// [...path].js catch-all function would. Two earlier attempts assumed that
// implicit binding (and, before that, that req.url held the rewritten
// path) — both produced a malformed upstream path and OpenSky 404s. This
// explicit ?path=:path* mapping is the documented, unambiguous way to pass
// a rewrite's captured segments into a plain function.

const ALLOWED_HOST = 'opensky-network.org';

export default async function handler(req, res) {
  const { path, ...rest } = req.query || {};
  const pathStr = Array.isArray(path) ? path.join('/') : path || '';
  const upstreamPath = '/api/' + pathStr.replace(/^\/+/, '');

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) {
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
    else if (value != null) search.append(key, value);
  }
  const qs = search.toString();
  const target = `https://${ALLOWED_HOST}${upstreamPath}${qs ? `?${qs}` : ''}`;

  const headers = {};
  if (req.headers.authorization) headers.authorization = req.headers.authorization;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    const rateRemaining = upstream.headers.get('x-rate-limit-remaining');
    if (rateRemaining != null) res.setHeader('x-rate-limit-remaining', rateRemaining);
    res.setHeader('x-proxy-target', target);
    res.send(text);
  } catch (err) {
    res.status(502).json({
      error: `Proxy could not reach ${ALLOWED_HOST}: ${err.message}`,
      target,
    });
  }
}
