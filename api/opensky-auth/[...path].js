// Serverless proxy for OpenSky's OAuth2 token endpoint
// (auth.opensky-network.org). See api/opensky-api/[...path].js for the
// full rationale, including why the upstream path is built from
// req.query.path rather than req.url.
//
// This one also forwards a request body, since the OAuth2
// client_credentials grant (used by the Settings modal's "Test
// connection" and by openSkyClient.js) is a POST with a
// form-urlencoded body.

const ALLOWED_HOST = 'auth.opensky-network.org';

export default async function handler(req, res) {
  const { path, ...rest } = req.query || {};
  const segments = Array.isArray(path) ? path : path ? [path] : [];
  const upstreamPath = '/' + segments.join('/');

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) {
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
    else if (value != null) search.append(key, value);
  }
  const qs = search.toString();
  const target = `https://${ALLOWED_HOST}${upstreamPath}${qs ? `?${qs}` : ''}`;

  const headers = {};
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
    res.send(text);
  } catch (err) {
    res.status(502).json({
      error: `Proxy could not reach ${ALLOWED_HOST}: ${err.message}`,
    });
  }
}
