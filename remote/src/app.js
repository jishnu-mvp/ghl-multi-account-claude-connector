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
// The HTTP surface.
//
//   GET  /                                       landing page
//   GET  /healthz                                liveness/readiness
//   GET  /.well-known/oauth-protected-resource   RFC 9728 (also with a path suffix)
//   GET  /.well-known/oauth-authorization-server RFC 8414 (also with a path suffix)
//   GET  /.well-known/openid-configuration       alias, for clients that probe it first
//   POST /oauth/register                         RFC 7591 dynamic client registration
//   GET  /oauth/authorize                        consent + connect screen
//   POST /oauth/connect/{token,highlevel,select} the connect steps
//   GET  /highlevel/callback                     HighLevel's OAuth redirect lands here
//   POST /oauth/token                            code exchange + refresh
//   POST /oauth/revoke                           RFC 7009
//   POST /mcp                                    MCP, Streamable HTTP  (auth required)
//   GET  /sse  +  POST /messages                 MCP, legacy SSE       (auth required)

const { URL } = require('url');

const config = require('./config');
const storage = require('./storage');
const rateLimit = require('./ratelimit');
const pages = require('./pages');
const transport = require('./transport');
const clients = require('./oauth/clients');
const tokens = require('./oauth/tokens');
const metadata = require('./oauth/metadata');
const authorize = require('./oauth/authorize');

const { McpServer } = require('../../mcp-server/src/mcp');
const { buildTools } = require('../../mcp-server/src/tools');
const SERVER_INSTRUCTIONS = require('./instructions');

function buildMcpServer() {
  const tools = buildTools('remote', config.TOOLSET);
  const server = new McpServer({
    name: 'ghl',
    version: require('../package.json').version,
    instructions: SERVER_INSTRUCTIONS,
  });
  server.registerTools(tools);
  return server;
}

/**
 * @param {object} [deps]
 * @param {object} [deps.log]  { info(msg), error(msg) } — anything logged here is safe to
 *                             keep: no tokens, no CRM payloads, no request bodies.
 */
function createApp({ log = defaultLog } = {}) {
  const mcp = buildMcpServer();
  const toolCount = mcp.listTools().length;

  return async function handle(req, res) {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, config.PUBLIC_URL);
    } catch (_) {
      return text(res, 400, 'Bad request URL.');
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // CORS: browser-based MCP clients preflight before they will talk to us.
    setCors(res, req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      // --- public, unauthenticated -------------------------------------------------
      if (req.method === 'GET' && path === '/') {
        return html(res, 200, pages.landingPage({
          oauthAvailable: Boolean(config.GHL_CLIENT_ID && config.GHL_CLIENT_SECRET),
          toolCount,
        }));
      }
      if (req.method === 'GET' && path === '/healthz') {
        // Probe the store: a server that answers but cannot reach Redis is not healthy, and a
        // platform should know that rather than keep routing traffic to it.
        const health = await storage.check();
        return json(res, health.ok ? 200 : 503, {
          status: health.ok ? 'ok' : 'degraded',
          resource: config.RESOURCE,
          tools: toolCount,
          storage: health.backend,
          ...(health.ok ? {} : { storageError: health.error }),
          highlevelSignIn: Boolean(config.GHL_CLIENT_ID && config.GHL_CLIENT_SECRET),
          uptimeSeconds: Math.round(process.uptime()),
        });
      }

      // Discovery. RFC 9728/8414 allow the resource path to be appended, and clients differ
      // on which form they try, so answer both.
      if (req.method === 'GET' && isWellKnown(path, 'oauth-protected-resource')) {
        return json(res, 200, metadata.protectedResource(), { 'Cache-Control': 'public, max-age=3600' });
      }
      if (req.method === 'GET' && (isWellKnown(path, 'oauth-authorization-server') || isWellKnown(path, 'openid-configuration'))) {
        return json(res, 200, metadata.authorizationServer(), { 'Cache-Control': 'public, max-age=3600' });
      }

      // --- OAuth endpoints (rate limited per IP) ------------------------------------
      if (path.startsWith('/oauth/') || path === config.GHL_REDIRECT_PATH) {
        const limit = rateLimit.check(`auth:${clientIp(req)}`, { max: config.RATE_LIMIT.authMax, windowMs: config.RATE_LIMIT.windowMs });
        if (!limit.allowed) {
          return json(res, 429, { error: 'slow_down', error_description: 'Too many authorization requests. Wait a moment and try again.' }, { 'Retry-After': String(limit.retryAfterSeconds) });
        }
      }

      if (req.method === 'POST' && path === '/oauth/register') {
        return await handleRegister(req, res, log);
      }
      if (req.method === 'GET' && path === '/oauth/authorize') {
        return await handleAuthorize(url, res, log);
      }
      if (req.method === 'POST' && path.startsWith('/oauth/connect/')) {
        const step = path.slice('/oauth/connect/'.length);
        const session = await authorize.getSession(url.searchParams.get('k') || '');
        if (!session) {
          return html(res, 400, pages.errorPage(
            'This page has expired',
            'Start the connection again from your assistant — the page was open too long, or the link was incomplete.',
          ));
        }
        const form = await parseForm(req);
        try {
          if (step === 'token') return respond(res, await authorize.connectWithToken(session, form));
          if (step === 'highlevel') return respond(res, await authorize.startHighLevelConnect(session));
          if (step === 'select') return respond(res, await authorize.completeSelection(session, form));
          if (step === 'finish') return respond(res, await authorize.finishConnecting(session));
          return json(res, 404, { error: 'not_found', error_description: `No connect step "${step}".` });
        } catch (err) {
          if (err.name === 'AuthorizeError') {
            return html(res, 400, pages.errorPage('Cannot continue', err.description));
          }
          throw err;
        }
      }
      if (req.method === 'GET' && path === config.GHL_REDIRECT_PATH) {
        return respond(res, await authorize.completeHighLevelConnect(Object.fromEntries(url.searchParams)));
      }
      if (req.method === 'POST' && path === '/oauth/token') {
        return await handleToken(req, res, log);
      }
      if (req.method === 'POST' && path === '/oauth/revoke') {
        const form = await parseForm(req);
        await tokens.revokeToken(form.token);
        return json(res, 200, {}); // RFC 7009: always 200, never confirm existence
      }

      // --- MCP (authentication required) --------------------------------------------
      if (path === config.MCP_PATH || path === '/sse' || path === '/messages') {
        const auth = await authenticate(req);
        if (auth.error) {
          return json(res, auth.error.status, {
            error: auth.error.code,
            error_description: auth.error.description,
          }, { 'WWW-Authenticate': metadata.wwwAuthenticate({ error: auth.error.code, description: auth.error.description }) });
        }
        const { grant } = auth;

        const limit = rateLimit.check(`mcp:${grant.id}`, { max: config.RATE_LIMIT.mcpMax, windowMs: config.RATE_LIMIT.windowMs });
        if (!limit.allowed) {
          return json(res, 429, { error: 'rate_limited', error_description: 'Too many requests on this connection.' }, { 'Retry-After': String(limit.retryAfterSeconds) });
        }

        if (path === config.MCP_PATH) {
          if (req.method === 'POST') {
            const body = await transport.readBody(req);
            return await transport.handleStreamablePost({ server: mcp, grant, req, res, body });
          }
          if (req.method === 'GET') return transport.handleStreamableGet({ res });
          if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
          return text(res, 405, 'Use POST for MCP requests.');
        }
        if (path === '/sse' && req.method === 'GET') {
          if (config.SERVERLESS) {
            // A long-lived event stream needs a process that outlives the request. On
            // serverless it would be killed mid-flight, so decline clearly instead.
            return json(res, 501, {
              error: 'transport_unavailable',
              error_description: `This deployment does not support the legacy SSE transport. Use the Streamable HTTP endpoint at ${config.RESOURCE} instead.`,
            });
          }
          transport.handleSseOpen({ grant, req, res });
          return undefined;
        }
        if (path === '/messages' && req.method === 'POST') {
          if (config.SERVERLESS) {
            return json(res, 501, {
              error: 'transport_unavailable',
              error_description: `This deployment does not support the legacy SSE transport. Use the Streamable HTTP endpoint at ${config.RESOURCE} instead.`,
            });
          }
          const body = await transport.readBody(req);
          return await transport.handleSsePost({ server: mcp, grant, sessionId: url.searchParams.get('sessionId'), body, res });
        }
        return text(res, 405, 'Method not allowed on this endpoint.');
      }

      return json(res, 404, { error: 'not_found', error_description: `No endpoint at ${path}.` });
    } catch (err) {
      if (err && err.status === 413) {
        return json(res, 413, { error: 'payload_too_large', error_description: 'That request body is too large.' });
      }
      if (err && err.storage) {
        // The store is unreachable. That is an outage, not a bad request — say so, so a client
        // retries rather than treating the connection as broken.
        log.error(`${req.method} ${path}: storage unavailable — ${err.message}`);
        return json(res, 503, {
          error: 'storage_unavailable',
          error_description: 'The connector cannot reach its data store right now. This is temporary — try again shortly.',
        }, { 'Retry-After': '5' });
      }
      // Log the shape of the failure, never the request contents.
      log.error(`${req.method} ${path} failed after ${Date.now() - started}ms: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
      if (res.headersSent) return undefined;
      return json(res, 500, { error: 'server_error', error_description: 'Something went wrong handling that request.' });
    }

    // --- handlers -------------------------------------------------------------------

    async function handleRegister(request, response, logger) {
      let body;
      try {
        body = JSON.parse(await transport.readBody(request, 64 * 1024) || '{}');
      } catch (err) {
        return json(response, 400, { error: 'invalid_client_metadata', error_description: `Body must be JSON: ${err.message}` });
      }
      try {
        const client = await clients.register(body);
        logger.info(`registered client ${client.client_id} (${client.client_name})`);
        return json(response, 201, client, { 'Cache-Control': 'no-store' });
      } catch (err) {
        if (err.name === 'RegistrationError') {
          return json(response, 400, { error: err.code, error_description: err.description });
        }
        throw err;
      }
    }

    async function handleToken(request, response, logger) {
      const form = await parseForm(request);
      const grantType = String(form.grant_type || '');
      const clientId = String(form.client_id || '');

      // Public clients: the client_id is asserted, and PKCE (or the refresh token itself) is
      // what actually proves anything. A client secret would add nothing here.
      const client = await clients.get(clientId);
      if (!client) {
        return json(response, 401, { error: 'invalid_client', error_description: 'Unknown client_id.' }, { 'Cache-Control': 'no-store' });
      }
      if (!client.grant_types.includes(grantType)) {
        return json(response, 400, { error: 'unauthorized_client', error_description: `This client may not use grant_type "${grantType}".` });
      }
      // RFC 8707: a named audience must be ours.
      if (form.resource && !authorize.audienceMatches(form.resource)) {
        return json(response, 400, { error: 'invalid_target', error_description: `This server only issues tokens for ${config.RESOURCE}.` });
      }

      try {
        if (grantType === 'authorization_code') {
          const record = await tokens.redeemCode({
            code: String(form.code || ''),
            clientId,
            redirectUri: String(form.redirect_uri || ''),
            codeVerifier: String(form.code_verifier || ''),
          });
          const issued = await tokens.issueTokens({
            clientId,
            tenantIds: record.tenantIds,
            scope: record.scope,
            resource: record.resource,
          });
          logger.info(`issued tokens to ${clientId} for ${record.tenantIds.length} tenant(s)`);
          return json(response, 200, issued, { 'Cache-Control': 'no-store' });
        }
        if (grantType === 'refresh_token') {
          const issued = await tokens.refreshTokens({ refreshToken: String(form.refresh_token || ''), clientId });
          return json(response, 200, issued, { 'Cache-Control': 'no-store' });
        }
        return json(response, 400, { error: 'unsupported_grant_type', error_description: `grant_type "${grantType}" is not supported.` });
      } catch (err) {
        if (err.name === 'TokenError') {
          return json(response, 400, { error: err.code, error_description: err.description }, { 'Cache-Control': 'no-store' });
        }
        throw err;
      }
    }

    async function handleAuthorize(requestUrl, response, logger) {
      try {
        return respond(response, await authorize.beginAuthorization(Object.fromEntries(requestUrl.searchParams)));
      } catch (err) {
        if (err.name !== 'AuthorizeError') throw err;
        const redirect = authorize.errorRedirect(err);
        if (redirect) {
          // The client is known and its redirect URI is registered, so it is safe to report
          // the failure to it rather than stranding the person on a page.
          response.writeHead(302, { Location: redirect });
          return response.end();
        }
        logger.info(`authorize rejected: ${err.code}`);
        return html(response, 400, pages.errorPage('This connection request is not valid', err.description));
      }
    }
  };
}

// --- helpers ---------------------------------------------------------------------------

/** Bearer token -> grant, or the 401/403 to return. */
async function authenticate(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return { error: { status: 401, code: 'invalid_token', description: 'Authorization required. Connect this server so it can issue an access token.' } };
  }
  try {
    return await tokens.verifyAccessToken(match[1].trim());
  } catch (err) {
    return { error: { status: err.status || 401, code: err.code || 'invalid_token', description: err.description || 'The access token was rejected.' } };
  }
}

function isWellKnown(path, doc) {
  // Both "/.well-known/x" and "/.well-known/x/mcp" (the RFC's path-insertion form).
  return path === `/.well-known/${doc}` || path.startsWith(`/.well-known/${doc}/`);
}

function respond(res, result) {
  if (!result) return undefined;
  if (result.kind === 'redirect') {
    res.writeHead(302, { Location: result.location, 'Cache-Control': 'no-store' });
    return res.end();
  }
  return html(res, result.status || 200, result.html);
}

function setCors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate');
  res.setHeader('Access-Control-Max-Age', '600');
}

function securityHeaders(extra = {}) {
  return {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // The pages are entirely self-contained, so nothing external may load or be posted to.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

function html(res, status, body) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }));
  return res.end(body);
}

function json(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, securityHeaders({
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extra,
  }));
  return res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  return res.end(`${body}\n`);
}

async function parseForm(req) {
  if (req.method !== 'POST') return {};
  const body = await transport.readBody(req, 64 * 1024);
  const params = new URLSearchParams(body);
  // Repeated fields must survive as arrays: a sub-account checklist posts the same name
  // once per ticked box, and Object.fromEntries would keep only the last one — quietly
  // connecting a single sub-account when someone asked for all of them.
  const out = {};
  for (const [key, value] of params.entries()) {
    if (key in out) {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function clientIp(req) {
  if (config.TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const defaultLog = {
  info: (msg) => process.stderr.write(`[ghl-remote] ${msg}\n`),
  error: (msg) => process.stderr.write(`[ghl-remote] ERROR ${msg}\n`),
};

/** Periodic housekeeping: expired codes, grants, sessions and rate-limit buckets. */
function startHousekeeping() {
  const timer = setInterval(() => {
    try {
      authorize.sweep();
      rateLimit.sweep();
    } catch (_) { /* never let housekeeping take the server down */ }
  }, 5 * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = { createApp, buildMcpServer, startHousekeeping, authenticate, storage };
