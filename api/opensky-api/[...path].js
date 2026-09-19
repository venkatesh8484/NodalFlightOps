// Serverless proxy for OpenSky's /api/* REST endpoints.
//
// Why this exists: opensky-network.org sends no Access-Control-Allow-Origin
// header, so the browser can't call it directly (see src/lib/openSkyClient.js
// for the full writeup). Locally this is handled by the Vite dev proxy
// (vite.config.js) or the Electron main process (main.js, ipcMain.handle
// 'opensky:request'). This function is the equivalent for the hosted web
// build: it runs server-side on Vercel, where CORS does not apply, and
// makes the real request in Node's fetch — the same technique main.js
// already uses.
//
// IMPORTANT: don't reconstruct the upstream path from req.url. Vercel
// keeps req.url as the original pre-rewrite browser path (/opensky-api/...)
// even when this function is reached via the vercel.json rewrite to
// /api/opensky-api/:path* — it does NOT become the rewritten destination
// path. Parsing req.url here previously produced a mangled, doubled-up
// upstream path and OpenSky returned a 404. The route's captured segments
// live in req.query.path instead (how Vercel's [...path] catch-all
// functions expose the matched segments), which is what this uses.

const ALLOWED_HOST = 'opensky-network.org';

export default async function handler(req, res) {
  const { path, ...rest } = req.query || {};
  const segments = Array.isArray(path) ? path : path ? [path] : [];
  const upstreamPath = '/api/' + segments.join('/');

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
    res.send(text);
  } catch (err) {
    res.status(502).json({
      error: `Proxy could not reach ${ALLOWED_HOST}: ${err.message}`,
    });
  }
}
