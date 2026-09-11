/*
 * GHL Multi-Account Claude Connector
 * Copyright (c) 2026 Jishnu Venugopal. All Rights Reserved.
 *
 * Proprietary software. You may use this software as-is for your own
 * GoHighLevel account(s). You may NOT copy, redistribute, or use this
 * code (or any part of it) to build a new or competing product without
 * the owner's prior written permission. See LICENSE and NOTICE at the
 * repository root for full terms. This notice must not be removed.
 * Contact: jishhnnuu@gmail.com
 */

'use strict';
// MCP over HTTP.
//
// Two transports, because clients in the wild use both:
//
//   Streamable HTTP (current)  POST /mcp with a JSON-RPC body, JSON back. Optional
//                              Mcp-Session-Id, so a client that wants a session gets one.
//   HTTP+SSE (legacy)          GET /sse holds an event stream, POST /messages posts calls,
//                              replies arrive as SSE events on the stream.
//
// Both funnel into the same McpServer instance, and every request is run inside its own
// credential context, so a tool can only see the tenants of the token that authenticated it.

const crypto = require('./crypto');
const config = require('./config');
const context = require('../../mcp-server/src/context');
const tenants = require('./tenants');

const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Live legacy SSE streams, by session id.
const streams = new Map();

/**
 * Handle one batch of JSON-RPC messages for an authenticated grant.
 * @returns {Promise<Array<object>>} the responses to send back (notifications produce none)
 */
async function dispatch({ server, grant, payload }) {
  const messages = Array.isArray(payload) ? payload : [payload];
  const provider = tenants.providerFor(grant.tenantIds);

  // AsyncLocalStorage: the provider is bound for the whole async subtree of this request.
  return context.runWith(provider, async () => {
    const out = [];
    for (const message of messages) {
      const response = await server.handleMessage(message);
      if (response) out.push(response);
    }
    return out;
  });
}

/** POST /mcp — Streamable HTTP. */
async function handleStreamablePost({ server, grant, req, res, body }) {
  let payload;
  try {
    payload = JSON.parse(body || '');
  } catch (err) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Could not parse the JSON-RPC body: ${err.message}` },
    });
    return;
  }

  const responses = await dispatch({ server, grant, payload });

  // A batch of notifications only: nothing to say, and 202 is what the spec asks for.
  if (!responses.length) {
    res.writeHead(202, sessionHeaders(req, { 'Content-Type': 'application/json' }));
    res.end();
    return;
  }

  const single = !Array.isArray(payload) && responses.length === 1;
  sendJson(res, 200, single ? responses[0] : responses, sessionHeaders(req));
}

/** GET /mcp — no server-initiated stream is needed, so decline politely. */
function handleStreamableGet({ res }) {
  res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, DELETE' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'This server does not open server-initiated streams; POST your JSON-RPC requests to this endpoint instead.' },
  }));
}

function sessionHeaders(req, extra = {}) {
  const existing = req.headers['mcp-session-id'];
  const id = existing || crypto.randomToken(12);
  return { 'Mcp-Session-Id': id, 'MCP-Protocol-Version': req.headers['mcp-protocol-version'] || '2025-06-18', ...extra };
}

// --- legacy HTTP+SSE transport --------------------------------------------------------

/** GET /sse — open the event stream and tell the client where to post. */
function handleSseOpen({ grant, req, res }) {
  const sessionId = crypto.randomToken(16);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const stream = {
    id: sessionId,
    grantId: grant.id,
    res,
    // A comment line every 25s so proxies do not reap an idle stream.
    heartbeat: setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch (_) { closeStream(sessionId); }
    }, 25000),
  };
  streams.set(sessionId, stream);
  stream.heartbeat.unref?.();

  res.write(`event: endpoint\ndata: ${config.PUBLIC_URL}/messages?sessionId=${sessionId}\n\n`);

  req.on('close', () => closeStream(sessionId));
  return sessionId;
}

/** POST /messages?sessionId=… — legacy clients post here; replies go out on the stream. */
async function handleSsePost({ server, grant, sessionId, body, res }) {
  const stream = streams.get(sessionId);
  if (!stream || stream.grantId !== grant.id) {
    sendJson(res, 404, { error: 'unknown_session', error_description: 'No open SSE stream with that sessionId for this token. Reconnect to /sse.' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body || '');
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', error_description: err.message });
    return;
  }

  // Acknowledge immediately; the JSON-RPC replies travel on the stream.
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end('{"accepted":true}');

  const responses = await dispatch({ server, grant, payload });
  for (const response of responses) {
    try {
      stream.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } catch (_) {
      closeStream(sessionId);
    }
  }
}

function closeStream(sessionId) {
  const stream = streams.get(sessionId);
  if (!stream) return;
  clearInterval(stream.heartbeat);
  try { stream.res.end(); } catch (_) { /* already gone */ }
  streams.delete(sessionId);
}

function closeAllStreams() {
  for (const id of [...streams.keys()]) closeStream(id);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

/** Read a request body with a hard cap, so a huge POST cannot exhaust memory. */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        // Drain and discard rather than destroying the socket: the caller still gets to
        // answer 413, which is far more use to them than a connection reset.
        req.resume();
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = {
  dispatch,
  handleStreamablePost,
  handleStreamableGet,
  handleSseOpen,
  handleSsePost,
  closeStream,
  closeAllStreams,
  readBody,
  sendJson,
  streams,
  MAX_BODY_BYTES,
};
