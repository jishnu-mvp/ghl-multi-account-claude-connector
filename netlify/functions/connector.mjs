// Netlify entry point. Functions v2, so the signature is Web Request -> Response.
//
// This file sits at the deployment root rather than under remote/, for the same reason
// api/index.js does: remote/src/app.js requires the shared tool layer from mcp-server/, and a
// site rooted at remote/ would leave those files out of the bundle.
//
// netlify.toml sends every path here, so the connector keeps its real URLs — /mcp,
// /.well-known/…, /oauth/… — rather than exposing /.netlify/functions/ to clients. That
// matters: PUBLIC_URL is the OAuth issuer and the audience every token is bound to.
//
// Two settings are not optional here. ENCRYPTION_KEY, because there is no disk to keep a
// generated one on; and a Redis store (Netlify's Upstash extension, or your own), because the
// filesystem is wiped between invocations and OAuth grants, connections and half-finished
// logins have to outlive a single request. `node remote/server.js --check` says so if either
// is missing.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../../remote/src/app.js');
const { toWebHandler } = require('../../remote/src/serverless.js');

// Built once per instance and reused on a warm one: the tool schemas and the endpoint
// catalogue are the expensive part, and neither depends on the request.
const handler = toWebHandler(createApp(), {
  // Netlify puts the caller's address here. TRUST_PROXY=true (the default on Netlify, see
  // remote/README.md) also lets X-Forwarded-For take precedence for rate limiting.
  clientIp: (request) => request.headers.get('x-nf-client-connection-ip')
    || request.headers.get('client-ip')
    || null,
});

export default (request) => handler(request);

// Claim every path. Without this, Netlify would only route /.netlify/functions/connector.
export const config = { path: '/*', preferStatic: true };
