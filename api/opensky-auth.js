// Serverless proxy for OpenSky's OAuth2 token endpoint
// (auth.opensky-network.org). See api/opensky-api.js for the full
// rationale, routing notes, and why errors surface err.cause.

const ALLOWED_HOST = 'auth.opensky-network.org';
const USER_AGENT = 'NodalFlightOps/1.0 (+https://github.com/venkatesh8484/NodalFlightOps)';

export default async function handler(req, res) {
  const { path, ...rest } = req.query || {};
  const pathStr = Array.isArray(path) ? path.join('/') : path || '';
  const upstreamPath = '/' + pathStr.replace(/^\/+/, '');

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) {
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
    else if (value != null) search.append(key, value);
  }
  const qs = search.toString();
  const target = `https://${ALLOWED_HOST}${upstreamPath}${qs ? `?${qs}` : ''}`;

  const headers = { 'user-agent': USER_AGENT };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (req.body && typeof req.body === 'object') {
      body = new URLSearchParams(req.body).toString();
    }
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
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
