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
// EXPLICITLY as a query parameter in the rewrite destination (see git log
// for the earlier, wrong attempts at this).
//
// Node's global fetch() (undici) collapses real connection failures (DNS,
// TLS, connection reset, timeout) into a bare "fetch failed" Error whose
// .message says nothing useful — the actual cause lives in err.cause.
// Surface that explicitly below instead of the useless top-level message.
// Also sends an explicit User-Agent: some APIs silently reset connections
// from requests that look like anonymous server/bot traffic (no UA at
// all), which Node's fetch sends by default.

const ALLOWED_HOST = 'opensky-network.org';
const USER_AGENT = 'NodalFlightOps/1.0 (+https://github.com/venkatesh8484/NodalFlightOps)';

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

  const headers = { 'user-agent': USER_AGENT };
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
    const cause = err && err.cause ? (err.cause.code || err.cause.message || String(err.cause)) : null;
    res.status(502).json({
      error: `Proxy could not reach ${ALLOWED_HOST}: ${err.message}`,
      cause,
      target,
    });
  }
}
