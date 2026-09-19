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
// Previously this was a vercel.json "external rewrite" straight to
// opensky-network.org. That returned an opaque HTTP 502 to the browser on
// the live site. A serverless function gives us the same effect with a
// real error message on failure instead of a bare 502, and one less layer
// that can behave unexpectedly.

const ALLOWED_HOST = 'opensky-network.org';

export default async function handler(req, res) {
  const incoming = new URL(req.url, 'http://internal');
  const upstreamPath = incoming.pathname.replace(/^\/api\/opensky-api/, '/api') + incoming.search;
  const target = `https://${ALLOWED_HOST}${upstreamPath}`;

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
