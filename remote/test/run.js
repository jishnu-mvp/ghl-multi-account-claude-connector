#!/usr/bin/env node
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
// Self-test for the hosted server: node test/run.js
//
// Starts a real HTTP server on a random port and drives it exactly as an MCP client would —
// discovery, dynamic registration, the consent screen, PKCE code exchange, MCP calls,
// refresh rotation — with HighLevel stubbed, so nothing touches a real CRM and no
// credentials are needed.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');

// Configure before anything reads config.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ghl-remote-test-'));
process.env.DATA_DIR = sandbox;
process.env.ENCRYPTION_KEY = nodeCrypto.randomBytes(32).toString('hex');
process.env.GHL_CLIENT_ID = 'test-client-id';
process.env.GHL_CLIENT_SECRET = 'test-client-secret';
process.env.ACCESS_TOKEN_TTL_MS = '3600000';
process.env.RATE_LIMIT_AUTH_MAX = '500';
process.env.RATE_LIMIT_MCP_MAX = '2000';
process.env.GHL_MCP_HOME = path.join(sandbox, 'home');
process.env.GHL_MCP_ACCOUNTS_FILE = path.join(sandbox, 'accounts.conf');
process.env.GHL_MCP_REPO_ROOT = sandbox;
process.env.GHL_MCP_BACKUP_DIR = path.join(sandbox, 'backups');
delete process.env.GHL_PIT_TOKEN;
delete process.env.GHL_LOCATION_ID;

// --- a fake HighLevel -----------------------------------------------------------------
// Two agencies ("CRMs"), each with its own sub-accounts, and one business name deliberately
// shared between them: "Bluebird Childcare" exists under both, which is exactly the
// collision a connection spanning two CRMs has to survive.
const CRMS = {
  CO_1: { id: 'CO_1', name: 'MVP Ventures' },
  CO_2: { id: 'CO_2', name: 'Kellix iQ' },
  // One agency, one sub-account: the ordinary single-business person, who must not be walked
  // through a checklist of one or asked about a second CRM.
  CO_3: { id: 'CO_3', name: 'Solo Trader Co' },
};
const LOCATIONS = {
  LOC_A: { id: 'LOC_A', name: 'Acme Pty Ltd', companyId: 'CO_1', timezone: 'Australia/Sydney' },
  LOC_B: { id: 'LOC_B', name: 'Beta Holdings', companyId: 'CO_1' },
  LOC_C: { id: 'LOC_C', name: 'Bluebird Childcare', companyId: 'CO_1' },
  LOC_D: { id: 'LOC_D', name: 'Bluebird Childcare', companyId: 'CO_2' },
  LOC_E: { id: 'LOC_E', name: 'GSP Events', companyId: 'CO_2' },
  LOC_F: { id: 'LOC_F', name: 'Corner Cafe', companyId: 'CO_3' },
};
const GRANTED_SCOPE = 'contacts.readonly locations.readonly';

const ghlHttp = require('../../mcp-server/src/http');
const calls = [];
let responder = () => ({ status: 200, headers: {}, text: '{"ok":true}' });
ghlHttp.request = async (opts) => {
  calls.push(opts);
  return responder(opts);
};

const ok = (body) => ({ status: 200, headers: {}, text: JSON.stringify(body) });
const refuse = (status, message) => ({ status, headers: {}, text: JSON.stringify({ message }) });

/** Read one field out of an application/x-www-form-urlencoded request body. */
function field(body, name) {
  return new URLSearchParams(String(body || '')).get(name) || '';
}

// HighLevel rotates the refresh token on every use, so each refresh has to look different —
// a connector that keeps replaying the old one dies quietly about a day after it connects.
let refreshSeq = 0;

function stubHighLevel() {
  responder = (opts) => {
    const url = opts.url || '';
    const auth = String((opts.headers && opts.headers.Authorization) || '');

    if (/\/oauth\/token$/.test(url)) {
      if (field(opts.body, 'grant_type') === 'refresh_token') {
        refreshSeq += 1;
        return ok({
          access_token: `hl-refreshed-${refreshSeq}`,
          refresh_token: `hl-rotated-${refreshSeq}`,
          expires_in: 86399,
          scope: GRANTED_SCOPE,
          userType: 'Location',
        });
      }
      // The test drives the flow through our own callback, so the "authorization code" is
      // whatever the test asked for: agency:<companyId> or location:<locationId>.
      const [kind, id] = field(opts.body, 'code').split(':');
      if (kind === 'agency' && CRMS[id]) {
        return ok({
          access_token: `hl-agency-${id}`,
          refresh_token: `hl-agencyref-${id}`,
          expires_in: 86399,
          scope: GRANTED_SCOPE,
          userType: 'Company',
          companyId: id,
        });
      }
      if (kind === 'location' && LOCATIONS[id]) {
        return ok({
          access_token: `hl-loc-${id}`,
          refresh_token: `hl-locref-${id}`,
          expires_in: 86399,
          scope: GRANTED_SCOPE,
          userType: 'Location',
          locationId: id,
          companyId: LOCATIONS[id].companyId,
        });
      }
      return refuse(400, 'invalid authorization code');
    }

    // Agency token -> sub-account token. Refuses a sub-account belonging to another agency,
    // which is what stops one CRM's picker from being replayed against the next one.
    if (/\/oauth\/locationToken$/.test(url)) {
      const companyId = field(opts.body, 'companyId');
      const locationId = field(opts.body, 'locationId');
      const location = LOCATIONS[locationId];
      if (!location) return refuse(404, 'no such sub-account');
      if (location.companyId !== companyId) return refuse(403, 'that sub-account is not under this agency');
      return ok({
        access_token: `hl-mint-${locationId}`,
        expires_in: 86399,
        scope: GRANTED_SCOPE,
        userType: 'Location',
        locationId,
        companyId,
      });
    }

    if (/\/oauth\/installedLocations/.test(url)) {
      const companyId = new URL(url).searchParams.get('companyId');
      return ok({
        locations: Object.values(LOCATIONS)
          .filter((l) => l.companyId === companyId)
          .map((l) => ({ _id: l.id, name: l.name })),
      });
    }

    const company = /\/companies\/([^/?]+)$/.exec(url);
    if (company) {
      const found = CRMS[company[1]];
      return found ? ok({ company: { id: found.id, name: found.name } }) : refuse(404, 'no such company');
    }

    // Only an agency-level Private Integration can enumerate sub-accounts.
    if (/\/locations\/search/.test(url)) {
      if (!auth.includes('pit-agency')) return refuse(401, 'not an agency token');
      const company = auth.includes('pit-agency-solo') ? 'CO_3' : 'CO_1';
      return ok({
        locations: Object.values(LOCATIONS)
          .filter((l) => l.companyId === company)
          .map((l) => ({ id: l.id, name: l.name })),
      });
    }

    const location = /\/locations\/([^/?]+)$/.exec(url);
    if (location) {
      const found = LOCATIONS[location[1]];
      return found ? ok({ location: found }) : refuse(404, 'no such sub-account');
    }

    if (/\/contacts\//.test(url)) {
      return ok({ contacts: [{ id: 'c1', firstName: 'Zzz', lastName: 'Test' }] });
    }
    return ok({ ok: true });
  };
}
stubHighLevel();

// PUBLIC_URL is the OAuth issuer and the token audience, and every module that builds an
// absolute URL reads it at load time — so the port has to be known before the first require.
// These are filled in by boot() below, which reserves a port first.
let base;
let config;
let createApp;
let webHandler;

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = require('net').createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function boot() {
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  process.env.PUBLIC_URL = base;
  config = require('../src/config');
  createApp = require('../src/app').createApp;
  return port;
}

// --- harness ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
async function test(name, fn) {
  calls.length = 0;
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}

let server;

// How a request actually leaves the test: over a real socket by default, or through the
// serverless adapter when a test asks for it. Every helper above and below is unaware of the
// difference, which is the point — the adapter has to behave identically or the swap fails.
const overHttp = (url, init) => fetch(url, init);
const overWebAdapter = (url, init) => webHandler(new Request(url, init));
let send = overHttp;

async function withWebAdapter(fn) {
  const original = send;
  send = overWebAdapter;
  try {
    return await fn();
  } finally {
    send = original;
  }
}

async function request(method, urlPath, { headers = {}, body, form, json: jsonBody, redirect = 'manual' } = {}) {
  const init = { method, headers: { ...headers }, redirect };
  if (form) {
    // Append rather than construct: a sub-account checklist posts the same field name once
    // per ticked box, and URLSearchParams(object) would flatten an array into one value.
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(form)) {
      for (const one of Array.isArray(value) ? value : [value]) params.append(name, one);
    }
    init.body = params.toString();
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (jsonBody !== undefined) {
    init.body = JSON.stringify(jsonBody);
    init.headers['content-type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await send(`${base}${urlPath}`, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* html */ }
  return { status: res.status, headers: res.headers, text, json: parsed };
}

function pkce() {
  const verifier = nodeCrypto.randomBytes(48).toString('base64url');
  const challenge = nodeCrypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/**
 * Register a client and open the consent screen — the first half of every flow below.
 * Returns everything the rest of it needs, including the login-session key the page carries.
 */
async function beginAuthorize({ redirectUri = CLAUDE_REDIRECT, clientName = 'Claude' } = {}) {
  const reg = await request('POST', '/oauth/register', { json: { redirect_uris: [redirectUri], client_name: clientName } });
  assert.strictEqual(reg.status, 201, `registration failed: ${reg.text}`);
  const { verifier, challenge } = pkce();
  const state = nodeCrypto.randomBytes(8).toString('hex');
  const page = await request('GET', `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(reg.json.client_id)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}`
    + `&code_challenge_method=S256&state=${state}&resource=${encodeURIComponent(config.RESOURCE)}`);
  assert.strictEqual(page.status, 200, `authorize failed: ${page.status} ${page.text.slice(0, 200)}`);
  return { clientId: reg.json.client_id, redirectUri, verifier, state, page, key: connectKey(page.text, 'highlevel') };
}

/** Pull a connect-step key out of a rendered page, the way a browser would follow the form. */
function connectKey(html, step) {
  const found = new RegExp(`/oauth/connect/${step}\\?k=([^"]+)"`).exec(html);
  assert.ok(found, `the page offers no /oauth/connect/${step} step`);
  return decodeURIComponent(found[1]);
}

/** Sign in to one CRM: bounce out to HighLevel and come back with a code. Repeatable. */
async function signIn(key, code) {
  const start = await request('POST', `/oauth/connect/highlevel?k=${encodeURIComponent(key)}`);
  assert.strictEqual(start.status, 302, `sign-in did not redirect: ${start.status} ${start.text.slice(0, 200)}`);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  return request('GET', `/highlevel/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
}

/** Tick sub-accounts on the checklist an agency sign-in lands on. */
function chooseSubAccounts(key, locationIds) {
  return request('POST', `/oauth/connect/select?k=${encodeURIComponent(key)}`, { form: { locationId: locationIds } });
}

/** Finish. The only step that hands an authorization code back to the client. */
function finish(key) {
  return request('POST', `/oauth/connect/finish?k=${encodeURIComponent(key)}`);
}

function exchange({ clientId, redirectUri, verifier, code }) {
  return request('POST', '/oauth/token', {
    form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, resource: config.RESOURCE },
  });
}

/**
 * The whole flow the way a person actually walks it: sign in to one or more CRMs, tick
 * sub-accounts in each, finish once, exchange the code. Each entry of `crms` is
 * `{ code, pick }` — `pick` only for an agency sign-in, which lands on the checklist.
 */
async function connectAll({ crms, redirectUri = CLAUDE_REDIRECT, clientName = 'Claude' } = {}) {
  const begun = await beginAuthorize({ redirectUri, clientName });
  let lastPage = begun.page.text;
  for (const crm of crms) {
    const back = await signIn(begun.key, crm.code);
    assert.strictEqual(back.status, 200, `the HighLevel callback failed: ${back.status} ${back.text.slice(0, 300)}`);
    lastPage = back.text;
    if (crm.pick) {
      const picked = await chooseSubAccounts(begun.key, crm.pick);
      assert.strictEqual(picked.status, 200, `choosing sub-accounts failed: ${picked.status} ${picked.text.slice(0, 300)}`);
      lastPage = picked.text;
    }
  }
  const done = await finish(begun.key);
  assert.strictEqual(done.status, 302, `finish did not redirect: ${done.status} ${done.text.slice(0, 300)}`);
  const redirect = new URL(done.headers.get('location'));
  const code = redirect.searchParams.get('code');
  assert.ok(code, 'no authorization code in the redirect');

  const token = await exchange({ ...begun, code });
  assert.strictEqual(token.status, 200, `token exchange failed: ${token.text}`);
  return {
    ...begun,
    reviewPage: lastPage,
    tokens: token.json,
    returnedState: redirect.searchParams.get('state'),
    iss: redirect.searchParams.get('iss'),
  };
}

/** The common case: one sub-account, authorised at sub-account level. */
function connect({ locationId = 'LOC_A', clientName = 'Claude', redirectUri = CLAUDE_REDIRECT } = {}) {
  return connectAll({ crms: [{ code: `location:${locationId}` }], clientName, redirectUri });
}

/** Walk far enough to hold an authorization code, without exchanging it. */
async function codeFor({ locationId = 'LOC_A', clientName = 'Claude' } = {}) {
  const begun = await beginAuthorize({ clientName });
  const back = await signIn(begun.key, `location:${locationId}`);
  assert.strictEqual(back.status, 200, back.text.slice(0, 200));
  const done = await finish(begun.key);
  assert.strictEqual(done.status, 302, done.text.slice(0, 200));
  return { ...begun, code: new URL(done.headers.get('location')).searchParams.get('code') };
}

/**
 * The Private Integration Token route is off unless the operator turns it on, so the few
 * tests that still cover it turn it on around themselves. config is read per request, so
 * flipping the flag takes effect immediately and the finally clause really does restore it.
 */
async function withTokenConnect(fn) {
  const original = config.ALLOW_TOKEN_CONNECT;
  config.ALLOW_TOKEN_CONNECT = true;
  try {
    return await fn();
  } finally {
    config.ALLOW_TOKEN_CONNECT = original;
  }
}

async function mcp(accessToken, message) {
  return request('POST', '/mcp', {
    headers: { authorization: `Bearer ${accessToken}`, 'mcp-protocol-version': '2025-06-18' },
    json: message,
  });
}

/** Call a tool and hand back its text, failing loudly if the tool itself errored. */
async function callTool(accessToken, name, args = {}, { expectError = false } = {}) {
  const res = await mcp(accessToken, { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } });
  assert.strictEqual(res.status, 200, `tools/call ${name} → HTTP ${res.status}`);
  const text = res.json.result.content[0].text;
  if (!expectError) assert.ok(!res.json.result.isError, `${name} failed: ${text}`);
  else assert.ok(res.json.result.isError, `${name} was expected to fail but returned: ${text}`);
  return text;
}

// --- tests ------------------------------------------------------------------------------

async function discoveryTests() {
  process.stdout.write('\ndiscovery\n');

  await test('an unauthenticated MCP request 401s with a resource_metadata pointer', async () => {
    const res = await request('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.strictEqual(res.status, 401);
    const header = res.headers.get('www-authenticate');
    assert.ok(header, 'no WWW-Authenticate header');
    assert.match(header, /^Bearer /);
    assert.match(header, new RegExp(`resource_metadata="${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.well-known/oauth-protected-resource"`));
  });

  await test('protected resource metadata names this resource and its auth server', async () => {
    const res = await request('GET', '/.well-known/oauth-protected-resource');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.resource, `${base}/mcp`);
    assert.deepStrictEqual(res.json.authorization_servers, [base]);
    assert.deepStrictEqual(res.json.bearer_methods_supported, ['header']);
  });

  await test('the path-suffixed metadata form works too', async () => {
    const res = await request('GET', '/.well-known/oauth-protected-resource/mcp');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.resource, `${base}/mcp`);
  });

  await test('authorization server metadata advertises PKCE-only public clients', async () => {
    const res = await request('GET', '/.well-known/oauth-authorization-server');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.issuer, base);
    assert.strictEqual(res.json.authorization_endpoint, `${base}/oauth/authorize`);
    assert.strictEqual(res.json.token_endpoint, `${base}/oauth/token`);
    assert.strictEqual(res.json.registration_endpoint, `${base}/oauth/register`);
    assert.deepStrictEqual(res.json.code_challenge_methods_supported, ['S256']);
    assert.deepStrictEqual(res.json.token_endpoint_auth_methods_supported, ['none']);
    assert.ok(res.json.grant_types_supported.includes('refresh_token'));
  });

  await test('openid-configuration is served as an alias', async () => {
    const res = await request('GET', '/.well-known/openid-configuration');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.issuer, base);
  });

  await test('healthz reports readiness without leaking configuration', async () => {
    const res = await request('GET', '/healthz');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.status, 'ok');
    assert.ok(res.json.tools > 50);
    assert.ok(!res.text.includes('test-client-secret'));
  });

  await test('the landing page explains the connector without requiring auth', async () => {
    const res = await request('GET', '/');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Connector/);
    assert.match(res.text, new RegExp(`${base}/mcp`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(res.text, /will not do without asking you/);
  });

  await test('responses carry hardening headers and a strict CSP', async () => {
    const res = await request('GET', '/');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(res.headers.get('content-security-policy'), /form-action 'self'/);
  });

  await test('CORS preflight is answered for browser-based clients', async () => {
    const res = await request('OPTIONS', '/mcp', { headers: { origin: 'https://claude.ai' } });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://claude.ai');
    assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(res.headers.get('access-control-expose-headers'), /WWW-Authenticate/);
  });
}

async function registrationTests() {
  process.stdout.write('\ndynamic client registration\n');

  await test('a client can register itself and gets no secret', async () => {
    const res = await request('POST', '/oauth/register', {
      json: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude', scope: 'ghl:read ghl:write' },
    });
    assert.strictEqual(res.status, 201);
    assert.match(res.json.client_id, /^client_/);
    assert.strictEqual(res.json.token_endpoint_auth_method, 'none');
    assert.ok(!('client_secret' in res.json), 'a client secret was issued');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  });

  await test('a non-HTTPS redirect URI is refused', async () => {
    const res = await request('POST', '/oauth/register', { json: { redirect_uris: ['http://evil.example.com/cb'] } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error, 'invalid_redirect_uri');
  });

  await test('loopback and custom-scheme redirects are accepted for native clients', async () => {
    for (const uri of ['http://127.0.0.1:33418/callback', 'cursor://anysphere.cursor-mcp/oauth/callback']) {
      const res = await request('POST', '/oauth/register', { json: { redirect_uris: [uri] } });
      assert.strictEqual(res.status, 201, `${uri} was refused: ${res.text}`);
    }
  });

  await test('a client asking for a secret-based auth method is refused', async () => {
    const res = await request('POST', '/oauth/register', {
      json: { redirect_uris: ['https://x.example.com/cb'], token_endpoint_auth_method: 'client_secret_post' },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error, 'invalid_client_metadata');
  });
}

async function authorizeTests() {
  process.stdout.write('\nauthorization endpoint\n');

  await test('an unknown client is refused without redirecting anywhere', async () => {
    const res = await request('GET', '/oauth/authorize?response_type=code&client_id=nope&redirect_uri=https%3A%2F%2Fevil.example.com%2Fcb&code_challenge=x&code_challenge_method=S256');
    assert.strictEqual(res.status, 400);
    assert.ok(!res.headers.get('location'), 'an unknown client must not cause a redirect');
    assert.match(res.text, /Unknown client_id/);
  });

  await test('a redirect_uri that was not registered is refused, not redirected to', async () => {
    const reg = await request('POST', '/oauth/register', { json: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } });
    const res = await request('GET', `/oauth/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}&code_challenge=x&code_challenge_method=S256`);
    assert.strictEqual(res.status, 400);
    assert.ok(!res.headers.get('location'), 'an unregistered redirect_uri must never be redirected to');
  });

  await test('a request without PKCE is rejected back to the client', async () => {
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const reg = await request('POST', '/oauth/register', { json: { redirect_uris: [redirectUri] } });
    const res = await request('GET', `/oauth/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&state=abc`);
    assert.strictEqual(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.strictEqual(location.origin + location.pathname, redirectUri);
    assert.strictEqual(location.searchParams.get('error'), 'invalid_request');
    assert.match(location.searchParams.get('error_description'), /PKCE is required/);
    assert.strictEqual(location.searchParams.get('state'), 'abc');
  });

  await test('plain PKCE is refused — S256 only', async () => {
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const reg = await request('POST', '/oauth/register', { json: { redirect_uris: [redirectUri] } });
    const res = await request('GET', `/oauth/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=abc&code_challenge_method=plain`);
    assert.strictEqual(res.status, 302);
    assert.match(new URL(res.headers.get('location')).searchParams.get('error_description'), /S256/);
  });

  await test('a token requested for someone else\'s resource is refused', async () => {
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const reg = await request('POST', '/oauth/register', { json: { redirect_uris: [redirectUri] } });
    const { challenge } = pkce();
    const res = await request('GET', `/oauth/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent('https://someone-else.example.com/mcp')}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(new URL(res.headers.get('location')).searchParams.get('error'), 'invalid_target');
  });

  await test('the consent screen names the client asking for access', async () => {
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const reg = await request('POST', '/oauth/register', { json: { redirect_uris: [redirectUri], client_name: 'Some Assistant' } });
    const { challenge } = pkce();
    const res = await request('GET', `/oauth/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Some Assistant/);
    assert.match(res.text, /Sign in with HighLevel/);
    assert.ok(!/Private Integration Token/.test(res.text), 'a token box was offered even though the token route is off');
  });

  await test('pasting a token is refused unless the operator enabled that route', async () => {
    const begun = await beginAuthorize();
    const res = await request('POST', `/oauth/connect/token?k=${encodeURIComponent(begun.key)}`, {
      form: { token: 'pit-test-token-1234', locationId: 'LOC_A' },
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /disabled on this server/);
  });

  await test('a bad credential is reported on the page and nothing is stored', async () => {
    await withTokenConnect(async () => {
      const begun = await beginAuthorize();
      const key = connectKey(begun.page.text, 'token');

      const before = (await require('../src/storage').tenants.all()).length;
      responder = () => ({ status: 401, headers: {}, text: '{"message":"Invalid token"}' });
      const res = await request('POST', `/oauth/connect/token?k=${encodeURIComponent(key)}`, { form: { token: 'pit-wrong', locationId: 'LOC_X' } });
      stubHighLevel();
      assert.strictEqual(res.status, 200);
      assert.match(res.text, /rejected that token/);
      assert.strictEqual((await require('../src/storage').tenants.all()).length, before, 'a rejected credential must not be stored');
    });
  });

  await test('an agency Private Integration Token gets the same sub-account checklist', async () => {
    await withTokenConnect(async () => {
      const begun = await beginAuthorize();
      const key = connectKey(begun.page.text, 'token');
      const res = await request('POST', `/oauth/connect/token?k=${encodeURIComponent(key)}`, { form: { token: 'pit-agency-token-1234' } });
      assert.strictEqual(res.status, 200);
      assert.match(res.text, /Which sub-accounts\?/);
      assert.match(res.text, /Acme Pty Ltd/);
      assert.match(res.text, /Bluebird Childcare/);
      assert.ok(!res.text.includes('GSP Events'), 'a sub-account from the other CRM was offered');
    });
  });

  await test('an expired consent page cannot be used', async () => {
    const res = await request('POST', '/oauth/connect/token?k=not-a-real-session', { form: { token: 'pit-x' } });
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /expired/);
  });
}

async function tokenTests() {
  process.stdout.write('\ntoken endpoint\n');

  await test('the full flow yields an access token bound to this resource', async () => {
    const session = await connect();
    assert.strictEqual(session.tokens.token_type, 'Bearer');
    assert.ok(session.tokens.access_token.length > 20);
    assert.ok(session.tokens.refresh_token.length > 20);
    assert.strictEqual(session.tokens.expires_in, 3600);
    assert.strictEqual(session.returnedState, session.state, 'state was not echoed back');
    assert.strictEqual(session.iss, base, 'the issuer was not identified in the redirect');
  });

  await test('the authorization code is single use', async () => {
    const held = await codeFor();
    const first = await exchange(held);
    assert.strictEqual(first.status, 200);
    const second = await exchange(held);
    assert.strictEqual(second.status, 400);
    assert.strictEqual(second.json.error, 'invalid_grant');
  });

  await test('a code cannot be exchanged with the wrong PKCE verifier', async () => {
    const held = await codeFor();
    const res = await exchange({ ...held, verifier: nodeCrypto.randomBytes(48).toString('base64url') });
    assert.strictEqual(res.status, 400);
    assert.match(res.json.error_description, /PKCE/);
  });

  await test('a code cannot be redeemed by a different client', async () => {
    const held = await codeFor();
    const attacker = await request('POST', '/oauth/register', { json: { redirect_uris: [held.redirectUri], client_name: 'Attacker' } });
    const res = await exchange({ ...held, clientId: attacker.json.client_id });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error, 'invalid_grant');
  });

  await test('refresh rotates the token and keeps the connection working', async () => {
    const session = await connect();
    const refreshed = await request('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token, client_id: session.clientId },
    });
    assert.strictEqual(refreshed.status, 200);
    assert.notStrictEqual(refreshed.json.refresh_token, session.tokens.refresh_token, 'the refresh token was not rotated');

    const listed = await mcp(refreshed.json.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.strictEqual(listed.status, 200);
    assert.ok(listed.json.result.tools.length > 50);
  });

  await test('replaying a rotated refresh token revokes the whole connection', async () => {
    const session = await connect();
    const first = await request('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token, client_id: session.clientId } });
    assert.strictEqual(first.status, 200);

    const replay = await request('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token, client_id: session.clientId } });
    assert.strictEqual(replay.status, 400);
    assert.match(replay.json.error_description, /already been used/);

    // The tokens minted from the stolen chain must stop working too.
    const after = await mcp(first.json.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.strictEqual(after.status, 401);
  });

  await test('an unknown client cannot use the token endpoint', async () => {
    const res = await request('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: 'x', client_id: 'client_nope', redirect_uri: 'https://x/y', code_verifier: 'z' } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.json.error, 'invalid_client');
  });

  await test('revocation kills the access token', async () => {
    const session = await connect();
    const ok = await mcp(session.tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.strictEqual(ok.status, 200);
    const revoked = await request('POST', '/oauth/revoke', { form: { token: session.tokens.access_token, client_id: session.clientId } });
    assert.strictEqual(revoked.status, 200);
    const after = await mcp(session.tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.strictEqual(after.status, 401);
  });
}

async function mcpTests() {
  process.stdout.write('\nMCP over HTTP\n');
  let session;

  await test('initialize handshakes and returns the connector instructions', async () => {
    session = await connect();
    const res = await mcp(session.tokens.access_token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.result.serverInfo.name, 'ghl');
    assert.match(res.json.result.instructions, /NAME THE ACCOUNT/);
    assert.ok(res.headers.get('mcp-session-id'), 'no session id was issued');
  });

  await test('tools/list has the remote session tools and no login tools', async () => {
    const res = await mcp(session.tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = res.json.result.tools.map((t) => t.name);
    assert.ok(names.includes('ghl_accounts'));
    assert.ok(names.includes('ghl_connection_info'));
    assert.ok(names.includes('ghl_request'));
    assert.ok(!names.includes('ghl_login'), 'ghl_login must not be exposed on the hosted server');
    assert.ok(!names.includes('ghl_logout'), 'ghl_logout must not be exposed on the hosted server');
  });

  await test('ghl_accounts reports the connected sub-account under its CRM', async () => {
    const text = await callTool(session.tokens.access_token, 'ghl_accounts');
    assert.match(text, /Acme Pty Ltd/);
    assert.match(text, /acme-pty-ltd/);
    assert.match(text, /MVP Ventures/);
  });

  await test('a tool call reaches HighLevel with the stored credential', async () => {
    const res = await mcp(session.tokens.access_token, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ghl_list_contacts', arguments: { account: 'acme-pty-ltd' } },
    });
    assert.ok(!res.json.result.isError, res.json.result.content[0].text);
    const call = calls.find((c) => /\/contacts\//.test(c.url));
    assert.ok(call, 'HighLevel was never called');
    assert.strictEqual(call.headers.Authorization, 'Bearer hl-loc-LOC_A');
    assert.strictEqual(call.headers.Version, '2021-07-28');
    assert.match(call.url, /locationId=LOC_A/);
    assert.match(res.json.result.content[0].text, /Account : Acme Pty Ltd/);
  });

  await test('a tool call without an account is refused, not defaulted', async () => {
    const res = await mcp(session.tokens.access_token, {
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ghl_list_contacts', arguments: {} },
    });
    assert.ok(res.json.result.isError);
    assert.match(res.json.result.content[0].text, /"account" is required/);
  });

  await test('an outbound tool still refuses to run without confirmation', async () => {
    const res = await mcp(session.tokens.access_token, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'ghl_send_message', arguments: { account: 'acme-pty-ltd', type: 'SMS', contact_id: 'c1', message: 'hi' } },
    });
    assert.ok(res.json.result.isError);
    assert.match(res.json.result.content[0].text, /NOT SENT — confirmation required/);
    assert.ok(!calls.some((c) => c.method === 'POST' && /conversations\/messages/.test(c.url)), 'a message was sent during a dry run');
  });

  await test('the stored credential is never echoed back to the client', async () => {
    const res = await mcp(session.tokens.access_token, {
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ghl_whoami', arguments: { account: 'acme-pty-ltd' } },
    });
    const text = res.json.result.content[0].text;
    assert.ok(!text.includes('hl-loc-LOC_A'), 'the credential leaked through ghl_whoami');
    assert.match(text, new RegExp(`hl-loc-L… \\(${'hl-loc-LOC_A'.length} chars\\)`));
  });

  await test('a batch of notifications is accepted with 202 and no body', async () => {
    const res = await mcp(session.tokens.access_token, [{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.text, '');
  });

  await test('a JSON-RPC batch comes back as an array', async () => {
    const res = await mcp(session.tokens.access_token, [
      { jsonrpc: '2.0', id: 10, method: 'ping' },
      { jsonrpc: '2.0', id: 11, method: 'tools/list' },
    ]);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.json));
    assert.strictEqual(res.json.length, 2);
  });

  await test('malformed JSON gets a parse error, not a crash', async () => {
    const res = await request('POST', '/mcp', {
      headers: { authorization: `Bearer ${session.tokens.access_token}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error.code, -32700);
  });

  await test('GET /mcp declines instead of hanging a stream open', async () => {
    const res = await request('GET', '/mcp', { headers: { authorization: `Bearer ${session.tokens.access_token}` } });
    assert.strictEqual(res.status, 405);
    assert.match(res.headers.get('allow'), /POST/);
  });

  await test('the legacy SSE transport hands back a message endpoint', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/sse`, {
      headers: { authorization: `Bearer ${session.tokens.access_token}` },
      signal: controller.signal,
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const chunk = Buffer.from(value).toString('utf8');
    assert.match(chunk, /event: endpoint/);
    const endpoint = /data: (\S+)/.exec(chunk)[1];
    assert.match(endpoint, /\/messages\?sessionId=/);

    // Post a request and read the reply off the stream.
    const sessionId = new URL(endpoint).searchParams.get('sessionId');
    const posted = await request('POST', `/messages?sessionId=${sessionId}`, {
      headers: { authorization: `Bearer ${session.tokens.access_token}` },
      json: { jsonrpc: '2.0', id: 99, method: 'ping' },
    });
    assert.strictEqual(posted.status, 202);
    const next = await reader.read();
    assert.match(Buffer.from(next.value).toString('utf8'), /"id":99/);
    controller.abort();
  });

  await test('posting to an SSE session that is not yours is refused', async () => {
    const other = await connect({ clientName: 'Other client' });
    const res = await request('POST', '/messages?sessionId=made-up', {
      headers: { authorization: `Bearer ${other.tokens.access_token}` },
      json: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    assert.strictEqual(res.status, 404);
  });
}

async function isolationTests() {
  process.stdout.write('\ntenant isolation\n');

  await test('one connection cannot name another connection\'s sub-account', async () => {
    const acme = await connect({ locationId: 'LOC_A' });
    const beta = await connect({ locationId: 'LOC_B', clientName: 'Beta client' });

    const ownAccounts = await mcp(beta.tokens.access_token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_accounts', arguments: {} },
    });
    assert.match(ownAccounts.json.result.content[0].text, /Beta Holdings/);
    assert.ok(!ownAccounts.json.result.content[0].text.includes('Acme'), 'Beta could see Acme in its account list');

    // Setting the connections up legitimately touches both locations, so only judge what
    // happens from here on.
    const callsBefore = calls.length;
    const crossRead = await mcp(beta.tokens.access_token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_list_contacts', arguments: { account: 'acme-pty-ltd' } },
    });
    assert.ok(crossRead.json.result.isError, 'a cross-tenant read succeeded');
    assert.match(crossRead.json.result.content[0].text, /Unknown account "acme-pty-ltd"/);
    assert.strictEqual(calls.length, callsBefore, 'a cross-tenant call still reached HighLevel');

    // And the legitimate owner still works.
    const ownRead = await mcp(acme.tokens.access_token, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ghl_list_contacts', arguments: { account: 'acme-pty-ltd' } },
    });
    assert.ok(!ownRead.json.result.isError);
  });

  await test('concurrent requests from different tenants do not cross over', async () => {
    const acme = await connect({ locationId: 'LOC_A' });
    const beta = await connect({ locationId: 'LOC_B', clientName: 'Beta client' });

    // Make HighLevel slow and interleaved so a shared "current account" would be caught.
    responder = async (opts) => {
      await new Promise((r) => setTimeout(r, /LOC_A/.test(opts.url) ? 40 : 5));
      return { status: 200, headers: {}, text: JSON.stringify({ url: opts.url, auth: opts.headers.Authorization }) };
    };

    const [a, b] = await Promise.all([
      mcp(acme.tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_list_contacts', arguments: { account: 'acme-pty-ltd' } } }),
      mcp(beta.tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_list_contacts', arguments: { account: 'beta-holdings' } } }),
    ]);
    stubHighLevel();

    const textA = a.json.result.content[0].text;
    const textB = b.json.result.content[0].text;
    assert.match(textA, /Acme Pty Ltd/);
    assert.match(textA, /LOC_A/);
    assert.ok(!textA.includes('LOC_B'), 'Acme\'s response contained Beta\'s location');
    assert.match(textB, /Beta Holdings/);
    assert.match(textB, /LOC_B/);
    assert.ok(!textB.includes('LOC_A'), 'Beta\'s response contained Acme\'s location');
  });

  await test('two connections to the same sub-account do not share one credential', async () => {
    const storage = require('../src/storage');
    const before = (await storage.tenants.all()).filter((t) => t.locationId === 'LOC_A').length;
    const first = await connect({ locationId: 'LOC_A' });
    const second = await connect({ locationId: 'LOC_A', clientName: 'Someone else' });
    const after = (await storage.tenants.all()).filter((t) => t.locationId === 'LOC_A').length;
    assert.strictEqual(after, before + 2, 'the second connection reused the first one\'s record');

    // Revoking one must leave the other alone — otherwise one person disconnecting takes
    // everyone else who authorised the same sub-account down with them.
    await request('POST', '/oauth/revoke', { form: { token: first.tokens.access_token, client_id: first.clientId } });
    const still = await callTool(second.tokens.access_token, 'ghl_whoami', { account: 'acme-pty-ltd' });
    assert.match(still, /Acme Pty Ltd/);
  });

  await test('credentials are encrypted on disk, not merely hidden', async () => {
    await connect({ locationId: 'LOC_A' });
    const raw = fs.readFileSync(path.join(sandbox, 'tenants.json'), 'utf8');
    assert.ok(!raw.includes('hl-loc-LOC_A'), 'the credential is stored in the clear');
    assert.ok(!raw.includes('hl-locref-LOC_A'), 'the refresh token is stored in the clear');
    assert.match(raw, /"sealed": "v1\./);
  });

  await test('issued tokens are stored only as digests', async () => {
    const session = await connect();
    const raw = fs.readFileSync(path.join(sandbox, 'grants.json'), 'utf8');
    assert.ok(!raw.includes(session.tokens.access_token), 'an access token is recoverable from disk');
    assert.ok(!raw.includes(session.tokens.refresh_token), 'a refresh token is recoverable from disk');
    assert.match(raw, /"accessTokenHash"/);
  });
}

async function highlevelOAuthTests() {
  process.stdout.write('\nHighLevel sign-in\n');

  await test('"Sign in with HighLevel" hands over to the marketplace with our own callback', async () => {
    const begun = await beginAuthorize();
    const res = await request('POST', `/oauth/connect/highlevel?k=${encodeURIComponent(begun.key)}`);
    assert.strictEqual(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.strictEqual(location.origin, 'https://marketplace.gohighlevel.com');
    assert.strictEqual(location.pathname, '/oauth/chooselocation');
    assert.strictEqual(location.searchParams.get('client_id'), 'test-client-id');
    assert.strictEqual(location.searchParams.get('redirect_uri'), `${base}/highlevel/callback`);
    assert.strictEqual(location.searchParams.get('response_type'), 'code');
    // Our own login session travels as HighLevel's state, so the callback can find it again.
    assert.ok(location.searchParams.get('state').startsWith(`${begun.key}.`), 'the login session is not carried in the state');
    assert.match(location.searchParams.get('scope'), /contacts.readonly/);
  });

  await test('a sub-account sign-in attaches that one and asks nothing else', async () => {
    const begun = await beginAuthorize();
    const back = await signIn(begun.key, 'location:LOC_A');
    assert.strictEqual(back.status, 200, back.text.slice(0, 300));
    assert.ok(!back.headers.get('location'), 'the assistant was handed a code before Finish');
    assert.match(back.text, /Acme Pty Ltd is ready/);
    assert.match(back.text, /Finish and return to the assistant/);

    // The exchange with HighLevel must have used the app credentials, form-encoded.
    const tokenCall = calls.find((c) => /\/oauth\/token$/.test(c.url));
    assert.ok(tokenCall, 'HighLevel token endpoint was never called');
    assert.match(tokenCall.body, /grant_type=authorization_code/);
    assert.match(tokenCall.body, /client_id=test-client-id/);
    assert.match(tokenCall.body, /user_type=Location/);
  });

  await test('the finished connection works, and the HighLevel token never leaves the server', async () => {
    const session = await connect({ locationId: 'LOC_A' });
    const text = await callTool(session.tokens.access_token, 'ghl_whoami', { account: 'acme-pty-ltd' });
    assert.match(text, /HighLevel sign-in/);
    assert.match(text, /Acme Pty Ltd/);
    assert.ok(!text.includes('hl-loc-LOC_A'), 'the HighLevel access token leaked to the client');
  });

  await test('finishing with nothing attached is refused rather than issuing a code', async () => {
    const begun = await beginAuthorize();
    const res = await finish(begun.key);
    assert.strictEqual(res.status, 400);
    assert.ok(!res.headers.get('location'), 'a code was issued for an empty connection');
    assert.match(res.text, /Nothing connected yet/);
  });

  await test('a callback with a mismatched state is refused', async () => {
    const res = await request('GET', '/highlevel/callback?code=location:LOC_A&state=bogus.nonce');
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /expired/);
  });

  await test('HighLevel cancelling the sign-in is reported, not swallowed', async () => {
    const begun = await beginAuthorize();
    const start = await request('POST', `/oauth/connect/highlevel?k=${encodeURIComponent(begun.key)}`);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const res = await request('GET', `/highlevel/callback?error=access_denied&error_description=User+said+no&state=${encodeURIComponent(state)}`);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /cancelled/i);
    assert.match(res.text, /User said no/);
  });

  await test('an expired HighLevel token is refreshed transparently and the rotation is stored', async () => {
    const storage = require('../src/storage');
    const cryptoBox = require('../src/crypto');
    const session = await connect({ locationId: 'LOC_A' });

    // Age the stored credential. Earlier tests left other LOC_A tenants behind, so take the
    // one this connection just created — the most recent — rather than the first match.
    const tenant = (await storage.tenants.all()).filter((t) => t.locationId === 'LOC_A').pop();
    await storage.tenants.patch(tenant.id, {
      sealed: cryptoBox.sealJson({ accessToken: 'stale', refreshToken: 'hl-locref-LOC_A', expiresAt: Date.now() - 1000 }),
      expiresAt: Date.now() - 1000,
    });

    // Only judge what the tool call itself does — connecting already talked to HighLevel.
    calls.length = 0;
    await callTool(session.tokens.access_token, 'ghl_list_contacts', { account: tenant.alias });
    const refresh = calls.find((c) => /\/oauth\/token$/.test(c.url));
    assert.ok(refresh, 'no refresh was attempted');
    assert.match(refresh.body, /grant_type=refresh_token/);
    assert.match(refresh.body, /refresh_token=hl-locref-LOC_A/);
    const contacts = calls.find((c) => /\/contacts\//.test(c.url));
    assert.match(contacts.headers.Authorization, /^Bearer hl-refreshed-\d+$/, 'the refreshed token was not used');

    // HighLevel invalidates a refresh token the moment it is used, so the replacement has to
    // be persisted or the connection dies the next day.
    const opened = cryptoBox.openJson((await storage.tenants.get(tenant.id)).sealed);
    assert.match(opened.refreshToken, /^hl-rotated-\d+$/, 'the rotated refresh token was not stored');
  });
}

async function multiCrmTests() {
  process.stdout.write('\nmany sub-accounts, many CRMs\n');

  await test('an agency sign-in lists that CRM\'s sub-accounts to tick, and only its own', async () => {
    const begun = await beginAuthorize();
    const back = await signIn(begun.key, 'agency:CO_1');
    assert.strictEqual(back.status, 200, back.text.slice(0, 300));
    assert.match(back.text, /Which sub-accounts\?/);
    assert.match(back.text, /MVP Ventures/);
    for (const name of ['Acme Pty Ltd', 'Beta Holdings', 'Bluebird Childcare']) assert.match(back.text, new RegExp(name));
    assert.ok(!back.text.includes('GSP Events'), 'a sub-account from the other CRM was offered');
    const boxes = [...back.text.matchAll(/<input type="checkbox" name="locationId" value="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(boxes.sort(), ['LOC_A', 'LOC_B', 'LOC_C']);
  });

  await test('"Add all" attaches every sub-account in that CRM at once', async () => {
    const begun = await beginAuthorize();
    const back = await signIn(begun.key, 'agency:CO_1');
    assert.match(back.text, /Add all 3/);
    // The add-all button is a second form of hidden fields, because the page runs under a
    // CSP that forbids script. Post exactly what that form carries.
    const all = [...back.text.matchAll(/<input type="hidden" name="locationId" value="([^"]+)">/g)].map((m) => m[1]);
    assert.deepStrictEqual(all.sort(), ['LOC_A', 'LOC_B', 'LOC_C']);

    const picked = await chooseSubAccounts(begun.key, all);
    assert.strictEqual(picked.status, 200, picked.text.slice(0, 300));
    assert.match(picked.text, /3 sub-accounts ready/);
    assert.match(picked.text, /MVP Ventures — 3 sub-accounts/);
  });

  await test('a second CRM is added to the first rather than replacing it', async () => {
    const session = await connectAll({
      crms: [
        { code: 'agency:CO_1', pick: ['LOC_A', 'LOC_B'] },
        { code: 'agency:CO_2', pick: ['LOC_D', 'LOC_E'] },
      ],
    });
    // The review page in between must have shown everything, not just the latest CRM.
    assert.match(session.reviewPage, /4 sub-accounts ready/);
    assert.match(session.reviewPage, /MVP Ventures/);
    assert.match(session.reviewPage, /Kellix iQ/);

    const text = await callTool(session.tokens.access_token, 'ghl_accounts');
    assert.match(text, /4 sub-account\(s\) available to this connection, across 2 CRM\(s\)/);
    assert.match(text, /MVP Ventures — 2 sub-account\(s\)/);
    assert.match(text, /Kellix iQ — 2 sub-account\(s\)/);
    for (const name of ['Acme Pty Ltd', 'Beta Holdings', 'Bluebird Childcare', 'GSP Events']) assert.match(text, new RegExp(name));
  });

  await test('the same business name in two CRMs gets two aliases a person can actually say', async () => {
    const session = await connectAll({
      crms: [
        { code: 'agency:CO_1', pick: ['LOC_C'] },
        { code: 'agency:CO_2', pick: ['LOC_D'] },
      ],
    });
    const text = await callTool(session.tokens.access_token, 'ghl_accounts');
    assert.match(text, /bluebird-childcare-mvp/);
    assert.match(text, /bluebird-childcare-kellix/);

    // And each alias must reach its own CRM's sub-account, not the other's.
    calls.length = 0;
    await callTool(session.tokens.access_token, 'ghl_list_contacts', { account: 'bluebird-childcare-kellix' });
    const kellix = calls.find((c) => /\/contacts\//.test(c.url));
    assert.match(kellix.url, /locationId=LOC_D/);
    assert.strictEqual(kellix.headers.Authorization, 'Bearer hl-mint-LOC_D');

    calls.length = 0;
    await callTool(session.tokens.access_token, 'ghl_list_contacts', { account: 'bluebird-childcare-mvp' });
    const mvp = calls.find((c) => /\/contacts\//.test(c.url));
    assert.match(mvp.url, /locationId=LOC_C/);
  });

  await test('a sub-account outside the agency just signed into cannot be attached', async () => {
    const begun = await beginAuthorize();
    await signIn(begun.key, 'agency:CO_1');
    const picked = await chooseSubAccounts(begun.key, ['LOC_E']); // Kellix iQ's, not MVP's
    assert.strictEqual(picked.status, 200);
    assert.match(picked.text, /None of those sub-accounts could be connected/);
  });

  await test('one sub-account failing does not lose the ones that worked', async () => {
    const begun = await beginAuthorize();
    await signIn(begun.key, 'agency:CO_1');
    const picked = await chooseSubAccounts(begun.key, ['LOC_A', 'LOC_E']);
    assert.strictEqual(picked.status, 200);
    assert.match(picked.text, /Acme Pty Ltd is ready/);
    assert.match(picked.text, /LOC_E/);
    assert.match(picked.text, /could not be added/);
  });

  await test('a half-finished picker cannot be applied to the next CRM signed into', async () => {
    const begun = await beginAuthorize();
    await signIn(begun.key, 'agency:CO_1');   // picker pending for MVP Ventures…
    await signIn(begun.key, 'agency:CO_2');   // …and then they sign in somewhere else
    const picked = await chooseSubAccounts(begun.key, ['LOC_A']); // MVP's sub-account
    assert.strictEqual(picked.status, 200);
    assert.match(picked.text, /None of those sub-accounts could be connected/);
  });

  await test('the picker says what is already attached, so nothing looks lost', async () => {
    const begun = await beginAuthorize();
    await signIn(begun.key, 'agency:CO_1');
    await chooseSubAccounts(begun.key, ['LOC_A']);
    const second = await signIn(begun.key, 'agency:CO_2');
    assert.match(second.text, /Already added/);
    assert.match(second.text, /MVP Ventures/);
    assert.match(second.text, /GSP Events/);
  });

  await test('a sub-account added by Location ID lands alongside the ticked ones', async () => {
    const begun = await beginAuthorize();
    await signIn(begun.key, 'agency:CO_1');
    await chooseSubAccounts(begun.key, ['LOC_A']);
    const again = await signIn(begun.key, 'agency:CO_1');
    const manual = await chooseSubAccounts(connectKey(again.text, 'select'), ['LOC_B']);
    assert.match(manual.text, /2 sub-accounts ready/);
    assert.match(manual.text, /Beta Holdings/);
  });

  await test('a login covering one sub-account skips the checklist entirely', async () => {
    const begun = await beginAuthorize();
    const back = await signIn(begun.key, 'agency:CO_3');
    assert.strictEqual(back.status, 200, back.text.slice(0, 300));
    assert.ok(!/Which sub-accounts\?/.test(back.text), 'a checklist of one was shown');
    assert.ok(!/type="checkbox"/.test(back.text), 'a checklist of one was shown');
    assert.match(back.text, /Corner Cafe is ready/);
    assert.match(back.text, /Finish and return to the assistant/);
  });

  await test('someone with one CRM is never asked to sign in to a second', async () => {
    const begun = await beginAuthorize();
    const back = await signIn(begun.key, 'agency:CO_3');

    // The option still exists — someone could have a second agency — but it is closed, and
    // Finish comes first, so a finished connection does not read as unfinished.
    assert.ok(!/<details open>/.test(back.text), 'the second-CRM prompt was open for a single-CRM login');
    assert.ok(!/<h2>/.test(back.text), 'the second-CRM section still has a heading of its own');
    assert.ok(
      back.text.indexOf('Finish and return') < back.text.indexOf('another'),
      'Finish is not the first thing offered',
    );

    // And it is genuinely one click from here.
    const done = await finish(begun.key);
    assert.strictEqual(done.status, 302, done.text.slice(0, 200));
  });

  await test('someone already working across two CRMs keeps the option in front of them', async () => {
    const begun = await beginAuthorize();
    await signIn(begun.key, 'agency:CO_1');
    await chooseSubAccounts(begun.key, ['LOC_A']);
    const second = await signIn(begun.key, 'agency:CO_2');
    const picked = await chooseSubAccounts(connectKey(second.text, 'select'), ['LOC_E']);
    assert.match(picked.text, /<details open>/);
    assert.match(picked.text, /Sign in to another CRM/);
  });

  await test('an agency token covering one sub-account skips the checklist too', async () => {
    await withTokenConnect(async () => {
      const begun = await beginAuthorize();
      const key = connectKey(begun.page.text, 'token');
      const res = await request('POST', `/oauth/connect/token?k=${encodeURIComponent(key)}`, { form: { token: 'pit-agency-solo-1234' } });
      assert.strictEqual(res.status, 200);
      assert.ok(!/Which sub-accounts\?/.test(res.text), 'a checklist of one was shown');
      assert.match(res.text, /Corner Cafe is ready/);
    });
  });

  await test('a connection spanning two CRMs still refuses to guess between them', async () => {
    const session = await connectAll({
      crms: [
        { code: 'agency:CO_1', pick: ['LOC_A'] },
        { code: 'agency:CO_2', pick: ['LOC_E'] },
      ],
    });
    const text = await callTool(session.tokens.access_token, 'ghl_list_contacts', {}, { expectError: true });
    assert.match(text, /"account" is required/);
    // And an alias from a CRM this connection never signed into does not exist here.
    const outsider = await callTool(session.tokens.access_token, 'ghl_list_contacts', { account: 'beta-holdings' }, { expectError: true });
    assert.match(outsider, /Unknown account "beta-holdings"/);
  });
}

async function serverlessTests() {
  process.stdout.write('\nserverless adapter (Netlify and friends)\n');

  await test('discovery answers identically through the Web adapter', async () => {
    const direct = await request('GET', '/.well-known/oauth-authorization-server');
    const adapted = await withWebAdapter(() => request('GET', '/.well-known/oauth-authorization-server'));
    assert.strictEqual(adapted.status, direct.status);
    assert.deepStrictEqual(adapted.json, direct.json);
    assert.strictEqual(adapted.headers.get('content-type'), direct.headers.get('content-type'));
  });

  await test('the whole connect flow works over Web Request/Response', async () => {
    // The full walk — register, consent, HighLevel sign-in, the sub-account checklist, a
    // second CRM, finish, code exchange — with every request going through the adapter.
    const session = await withWebAdapter(() => connectAll({
      crms: [
        { code: 'agency:CO_1', pick: ['LOC_A', 'LOC_B'] },
        { code: 'agency:CO_2', pick: ['LOC_E'] },
      ],
      clientName: 'Netlify client',
    }));
    assert.match(session.reviewPage, /3 sub-accounts ready/);

    const text = await withWebAdapter(() => callTool(session.tokens.access_token, 'ghl_accounts'));
    assert.match(text, /across 2 CRM\(s\)/);
    assert.match(text, /GSP Events/);

    // And the connection keeps working over a socket: nothing about it is adapter-specific.
    const overSocket = await callTool(session.tokens.access_token, 'ghl_list_contacts', { account: 'acme-pty-ltd' });
    assert.match(overSocket, /Acme Pty Ltd/);
  });

  await test('a redirect survives the adapter with its Location intact', async () => {
    await withWebAdapter(async () => {
      const held = await codeFor({ clientName: 'Redirect check' });
      assert.ok(held.code, 'no code came back through the adapter');
      const exchanged = await exchange(held);
      assert.strictEqual(exchanged.status, 200, exchanged.text);
    });
  });

  await test('a ticked checklist keeps every value through a Web body', async () => {
    await withWebAdapter(async () => {
      const begun = await beginAuthorize({ clientName: 'Checklist check' });
      await signIn(begun.key, 'agency:CO_1');
      const picked = await chooseSubAccounts(begun.key, ['LOC_A', 'LOC_B', 'LOC_C']);
      // A form body parsed with Object.fromEntries would keep only the last box.
      assert.match(picked.text, /3 sub-accounts ready/);
    });
  });

  await test('a 204 carries no body, which undici would otherwise reject', async () => {
    const res = await withWebAdapter(() => request('OPTIONS', '/mcp', { headers: { origin: 'https://claude.ai' } }));
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.text, '');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://claude.ai');
  });

  await test('a 401 keeps its WWW-Authenticate pointer through the adapter', async () => {
    const res = await withWebAdapter(() => request('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    assert.strictEqual(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata=/);
  });

  await test('an oversized body is still refused, not buffered into the function', async () => {
    const session = await connect();
    const res = await withWebAdapter(() => request('POST', '/mcp', {
      headers: { authorization: `Bearer ${session.tokens.access_token}`, 'content-type': 'application/json' },
      body: 'x'.repeat(5 * 1024 * 1024),
    }));
    assert.ok([413, 400].includes(res.status), `expected 413, got ${res.status}`);
  });

  await test('the legacy SSE stream is declined rather than left hanging', async () => {
    const session = await connect();
    const original = config.SERVERLESS;
    config.SERVERLESS = true; // read per request, which is what makes this testable
    try {
      const res = await withWebAdapter(() => request('GET', '/sse', {
        headers: { authorization: `Bearer ${session.tokens.access_token}` },
      }));
      assert.strictEqual(res.status, 501);
      assert.match(res.json.error_description, /Streamable HTTP/);
    } finally {
      config.SERVERLESS = original;
    }
  });

  await test('the client address comes from the platform, since there is no socket', async () => {
    // Proven through the rate limiter, which keys on it: one caller hitting the limit must
    // not lock out another. With no address the adapter would put the whole platform in one
    // bucket, and the second caller below would be refused too.
    const register = (ip) => request('POST', '/oauth/register', {
      headers: { 'x-nf-client-connection-ip': ip },
      json: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
    });
    const original = config.RATE_LIMIT.authMax;
    config.RATE_LIMIT.authMax = 2;
    try {
      await withWebAdapter(async () => {
        const noisy = [];
        for (let i = 0; i < 4; i += 1) noisy.push((await register('198.51.100.7')).status);
        assert.ok(noisy.includes(429), `the noisy caller was never limited: ${noisy.join(',')}`);

        const other = await register('203.0.113.42');
        assert.strictEqual(other.status, 201, 'one caller hitting the limit locked out another');
      });
    } finally {
      config.RATE_LIMIT.authMax = original;
      require('../src/ratelimit').reset();
    }
  });
}

async function hardeningTests() {
  process.stdout.write('\nhardening\n');

  await test('an oversized body is rejected rather than buffered', async () => {
    const session = await connect();
    const res = await request('POST', '/mcp', {
      headers: { authorization: `Bearer ${session.tokens.access_token}`, 'content-type': 'application/json' },
      body: 'x'.repeat(5 * 1024 * 1024),
    });
    assert.ok([413, 400].includes(res.status), `expected 413, got ${res.status}`);
  });

  await test('the MCP endpoint is rate limited per connection', async () => {
    const session = await connect();
    const original = config.RATE_LIMIT.mcpMax;
    config.RATE_LIMIT.mcpMax = 3; // read per request, so this takes effect immediately
    try {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await mcp(session.tokens.access_token, { jsonrpc: '2.0', id: i, method: 'ping' });
        statuses.push(res.status);
      }
      assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(',')}`);
      const limited = await mcp(session.tokens.access_token, { jsonrpc: '2.0', id: 9, method: 'ping' });
      assert.ok(Number(limited.headers.get('retry-after')) >= 0, 'no Retry-After on a 429');
    } finally {
      config.RATE_LIMIT.mcpMax = original;
      require('../src/ratelimit').reset();
    }
  });

  await test('an unknown path 404s as JSON', async () => {
    const res = await request('GET', '/wat');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, 'not_found');
  });

  await test('nothing sensitive appears in the data directory file names or key file mode', async () => {
    const keyFileMissing = !fs.existsSync(path.join(sandbox, '.encryption-key'));
    assert.ok(keyFileMissing, 'a key file was written even though ENCRYPTION_KEY was set');
    for (const name of ['clients.json', 'tenants.json', 'grants.json']) {
      const mode = fs.statSync(path.join(sandbox, name)).mode & 0o777;
      assert.strictEqual(mode, 0o600, `${name} is ${mode.toString(8)}, expected 0600`);
    }
  });
}

function requireFresh(id) {
  delete require.cache[require.resolve(id)];
  return require(id);
}

// --- run --------------------------------------------------------------------------------

(async () => {
  process.stdout.write('ghl-remote self-test\n');

  const port = await boot();
  const app = createApp({ log: { info: () => {}, error: () => {} } });
  // The same handler, reachable two ways: over a socket, and through the Web adapter that
  // Netlify and friends call. Sharing the instance is deliberate — a divergence between the
  // two would otherwise hide behind two separate app objects.
  webHandler = require('../src/serverless').toWebHandler(app, {
    // The same header the Netlify function reads, so a test can pose as two callers.
    clientIp: (req) => req.headers.get('x-nf-client-connection-ip') || '203.0.113.9',
    log: { error: () => {} },
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  assert.strictEqual(config.RESOURCE, `${base}/mcp`, 'the test port and PUBLIC_URL disagree');

  await discoveryTests();
  await registrationTests();
  await authorizeTests();
  await tokenTests();
  await mcpTests();
  await isolationTests();
  await highlevelOAuthTests();
  await multiCrmTests();
  await serverlessTests();
  await hardeningTests();

  require('../src/transport').closeAllStreams();
  server.close();
  fs.rmSync(sandbox, { recursive: true, force: true });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) {
      process.stdout.write(`  ${f.name}\n    ${(f.err.stack || '').split('\n').slice(0, 4).join('\n    ')}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
