// Serverless proxy for OpenSky's OAuth2 token endpoint
// (auth.opensky-network.org). See api/opensky-api/[...path].js for the
// full rationale — same idea, but this one also forwards a request body,
// since the OAuth2 client_credentials grant is a POST with a
// form-urlencoded body.

const ALLOWED_HOST = 'auth.opensky-network.org';

export default async function handler(req, res) {
  const incoming = new URL(req.url, 'http://internal');
  const upstreamPath = incoming.pathname.replace(/^\/api\/opensky-auth/, '') + incoming.search;
  const target = `https://${ALLOWED_HOST}${upstreamPath}`;

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
