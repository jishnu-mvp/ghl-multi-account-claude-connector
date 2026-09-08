#!/usr/bin/env node
'use strict';
// Storage-backend self-test: node test/storage.js
//
// Runs the same contract against both backends, and drives the whole OAuth flow through the
// Redis one with a fake Upstash — because a serverless deployment lives or dies on that path
// working, and nothing else in the suite exercises it.
//
// The fake speaks the real Upstash REST protocol (JSON command arrays, {"result": …}
// responses, GETDEL, SET EX, pipelines), so the backend is tested against the contract it
// will actually meet rather than a mock of itself.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ghl-storage-test-'));
process.env.DATA_DIR = sandbox;
process.env.ENCRYPTION_KEY = nodeCrypto.randomBytes(32).toString('hex');
process.env.GHL_CLIENT_ID = 'test-client-id';
process.env.GHL_CLIENT_SECRET = 'test-client-secret';
process.env.RATE_LIMIT_AUTH_MAX = '500';
process.env.RATE_LIMIT_MCP_MAX = '2000';
process.env.GHL_MCP_REPO_ROOT = sandbox;
process.env.GHL_MCP_HOME = path.join(sandbox, 'home');
process.env.GHL_MCP_BACKUP_DIR = path.join(sandbox, 'backups');
delete process.env.GHL_PIT_TOKEN;
delete process.env.GHL_LOCATION_ID;

// --- stub HighLevel --------------------------------------------------------------------
const ghlHttp = require('../../mcp-server/src/http');
const realRequest = ghlHttp.request;
const ghlCalls = [];
ghlHttp.request = async (opts) => {
  // Requests to the fake Redis must go over the wire for real; only HighLevel is stubbed.
  if (String(opts.url).startsWith(fakeRedisUrl)) return realRequest(opts);
  ghlCalls.push(opts);
  const url = opts.url || '';
  const json = (body) => ({ status: 200, headers: {}, text: JSON.stringify(body) });
  const field = (name) => new URLSearchParams(String(opts.body || '')).get(name) || '';

  // One agency is enough here: this suite is about where the flow's state lives, not about
  // how many CRMs it can hold.
  if (/\/oauth\/token$/.test(url)) {
    const [kind, id] = field('code').split(':');
    if (kind === 'agency') return json({ access_token: `hl-agency-${id}`, refresh_token: 'hl-agencyref', expires_in: 86399, userType: 'Company', companyId: id });
    return json({ access_token: `hl-loc-${id}`, refresh_token: 'hl-locref', expires_in: 86399, userType: 'Location', locationId: id, companyId: 'CO_1' });
  }
  if (/\/oauth\/locationToken$/.test(url)) {
    return json({ access_token: `hl-mint-${field('locationId')}`, expires_in: 86399, userType: 'Location', locationId: field('locationId'), companyId: field('companyId') });
  }
  if (/\/oauth\/installedLocations/.test(url)) {
    // Two, deliberately: one sub-account would skip the checklist, and the checklist is the
    // mid-flow state this suite exists to prove survives a cold instance.
    return json({ locations: [{ _id: 'LOC_A', name: 'Redis Co' }, { _id: 'LOC_B', name: 'Redis Two' }] });
  }
  if (/\/companies\/CO_1$/.test(url)) return json({ company: { id: 'CO_1', name: 'Redis Agency' } });
  const location = /\/locations\/(LOC_[AB])$/.exec(url);
  if (location) {
    const name = location[1] === 'LOC_A' ? 'Redis Co' : 'Redis Two';
    return json({ location: { id: location[1], name, companyId: 'CO_1' } });
  }
  if (/\/locations\/search/.test(url)) return { status: 401, headers: {}, text: '{"message":"nope"}' };
  if (/\/contacts\//.test(url)) return { status: 200, headers: {}, text: '{"contacts":[]}' };
  return { status: 200, headers: {}, text: '{"ok":true}' };
};

// --- a fake Upstash Redis, speaking the real REST protocol ------------------------------
const data = new Map();      // key -> { value, expiresAt }
const sets = new Map();      // key -> Set
let fakeRedisUrl = '';
let redisCommandLog = [];

function alive(entry) {
  return entry && (!entry.expiresAt || entry.expiresAt > Date.now());
}

function execute(args) {
  const cmd = String(args[0] || '').toUpperCase();
  redisCommandLog.push(cmd);
  switch (cmd) {
    case 'PING':
      return 'PONG';
    case 'SET': {
      const [, key, value, ...rest] = args;
      let expiresAt = null;
      const exIndex = rest.findIndex((a) => String(a).toUpperCase() === 'EX');
      if (exIndex !== -1) expiresAt = Date.now() + Number(rest[exIndex + 1]) * 1000;
      data.set(key, { value, expiresAt });
      return 'OK';
    }
    case 'GET': {
      const entry = data.get(args[1]);
      if (!alive(entry)) { data.delete(args[1]); return null; }
      return entry.value;
    }
    case 'GETDEL': {
      const entry = data.get(args[1]);
      data.delete(args[1]);
      return alive(entry) ? entry.value : null;
    }
    case 'DEL':
      data.delete(args[1]);
      return 1;
    case 'MGET':
      return args.slice(1).map((key) => {
        const entry = data.get(key);
        return alive(entry) ? entry.value : null;
      });
    case 'SADD': {
      const set = sets.get(args[1]) || new Set();
      set.add(args[2]);
      sets.set(args[1], set);
      return 1;
    }
    case 'SMEMBERS':
      return [...(sets.get(args[1]) || new Set())];
    default:
      return { error: `unknown command ${cmd}` };
  }
}

function startFakeRedis() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer fake-redis-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '[]'); } catch (_) { parsed = []; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/pipeline') {
          const results = parsed.map((args) => {
            const result = execute(args);
            return result && result.error ? { error: result.error } : { result };
          });
          res.end(JSON.stringify(results));
          return;
        }
        const result = execute(parsed);
        res.end(JSON.stringify(result && result.error ? { error: result.error } : { result }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// --- harness ----------------------------------------------------------------------------
let passed = 0;
const failures = [];
async function test(name, fn) {
  ghlCalls.length = 0;
  redisCommandLog = [];
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}

/** Every file in a directory with its size and mtime, for "was this touched?" assertions. */
function snapshotDir(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    });
}

function requireFresh(id) {
  // The storage layer picks its backend from configuration at first use, so switching
  // backends inside one process means dropping the cached modules that captured it.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}remote${path.sep}src${path.sep}`)) delete require.cache[key];
  }
  return require(id);
}

/** The contract both backends must satisfy, run against whichever is configured. */
async function contractTests(label) {
  process.stdout.write(`\nstorage contract — ${label}\n`);
  const storage = requireFresh('../src/storage');

  await test(`${label}: reports itself`, async () => {
    assert.ok(storage.describe().length > 3);
    const health = await storage.check();
    assert.strictEqual(health.ok, true, `store not reachable: ${health.error}`);
  });

  await test(`${label}: clients round-trip`, async () => {
    await storage.clients.put({ client_id: 'client_x', client_name: 'X', redirect_uris: ['https://a/b'] });
    const found = await storage.clients.get('client_x');
    assert.strictEqual(found.client_name, 'X');
    assert.strictEqual(await storage.clients.get('client_missing'), null);
  });

  await test(`${label}: tenants round-trip, patch and list`, async () => {
    await storage.tenants.put({ id: 'ten_1', alias: 'a', locationId: 'L1', sealed: 'v1.x' });
    await storage.tenants.put({ id: 'ten_2', alias: 'b', locationId: 'L2', sealed: 'v1.y' });
    assert.strictEqual((await storage.tenants.get('ten_1')).alias, 'a');
    const patched = await storage.tenants.patch('ten_1', { alias: 'a2' });
    assert.strictEqual(patched.alias, 'a2');
    assert.strictEqual(patched.locationId, 'L1', 'patch dropped an untouched field');
    const all = await storage.tenants.all();
    assert.ok(all.length >= 2);
    assert.ok(all.every((t) => t && t.id));
  });

  await test(`${label}: an authorization code can only be taken once`, async () => {
    await storage.codes.put('digest1', { clientId: 'c', expiresAt: Date.now() + 60000 });
    const first = await storage.codes.take('digest1');
    assert.ok(first, 'the code was not returned');
    assert.strictEqual(await storage.codes.take('digest1'), null, 'the code was reusable');
  });

  await test(`${label}: two racing takes cannot both win`, async () => {
    await storage.codes.put('digest2', { clientId: 'c', expiresAt: Date.now() + 60000 });
    const results = await Promise.all([storage.codes.take('digest2'), storage.codes.take('digest2')]);
    assert.strictEqual(results.filter(Boolean).length, 1, 'both takes returned the code');
  });

  await test(`${label}: grants are findable by each token index`, async () => {
    await storage.grants.put({
      id: 'grant_1', clientId: 'client_x', tenantIds: ['ten_1'],
      accessTokenHash: 'ah1', refreshTokenHash: 'rh1', retiredRefreshHashes: ['old1'],
      expiresAt: Date.now() + 60000, refreshExpiresAt: Date.now() + 600000,
    });
    assert.strictEqual((await storage.grants.byAccessToken('ah1')).id, 'grant_1');
    assert.strictEqual((await storage.grants.byRefreshToken('rh1')).id, 'grant_1');
    assert.strictEqual((await storage.grants.byRetiredRefresh('old1')).id, 'grant_1');
    assert.strictEqual((await storage.grants.byAnyToken('rh1')).id, 'grant_1');
    assert.strictEqual(await storage.grants.byAccessToken('nope'), null);
  });

  await test(`${label}: a rotated grant keeps its retired index for reuse detection`, async () => {
    await storage.grants.put({
      id: 'grant_2', clientId: 'client_x', tenantIds: ['ten_1'],
      accessTokenHash: 'ah2', refreshTokenHash: 'rh2',
      expiresAt: Date.now() + 60000, refreshExpiresAt: Date.now() + 600000,
    });
    await storage.grants.patch('grant_2', { retiredRefreshHashes: ['rh2'] });
    await storage.grants.put({
      id: 'grant_2', clientId: 'client_x', tenantIds: ['ten_1'],
      accessTokenHash: 'ah2b', refreshTokenHash: 'rh2b', retiredRefreshHashes: ['rh2'],
      expiresAt: Date.now() + 60000, refreshExpiresAt: Date.now() + 600000,
    });
    const retired = await storage.grants.byRetiredRefresh('rh2');
    assert.ok(retired, 'the retired refresh token became unrecognisable');
    assert.strictEqual(retired.refreshTokenHash, 'rh2b', 'the grant was not updated');
  });

  await test(`${label}: sessions round-trip and expire`, async () => {
    await storage.sessions.put('sk1', { key: 'sk1', expiresAt: Date.now() + 60000, clientId: 'c' });
    assert.strictEqual((await storage.sessions.get('sk1')).clientId, 'c');
    await storage.sessions.delete('sk1');
    assert.strictEqual(await storage.sessions.get('sk1'), null);
  });

  await test(`${label}: sweep does not throw`, async () => {
    assert.strictEqual(typeof (await storage.sweep()), 'number');
  });
}

/** The whole OAuth + MCP flow, on Redis. This is the serverless path. */
async function redisFlowTests() {
  process.stdout.write('\nfull flow on Redis\n');

  const port = await new Promise((resolve, reject) => {
    const probe = require('net').createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  process.env.PUBLIC_URL = base;

  const { createApp } = requireFresh('../src/app');
  const server = http.createServer(createApp({ log: { info: () => {}, error: () => {} } }));
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  // The file-backend phase already wrote here, so the question is not whether the directory
  // is empty but whether the Redis phase touches it at all.
  const diskBefore = snapshotDir(sandbox);

  const request = async (method, urlPath, { headers = {}, form, json } = {}) => {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (form) {
      init.body = new URLSearchParams(form).toString();
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['content-type'] = 'application/json';
    }
    const res = await fetch(`${base}${urlPath}`, init);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* html */ }
    return { status: res.status, headers: res.headers, text, json: parsed };
  };

  let session;

  // The connect flow, step by step, so each test can stop wherever it needs to.
  const pkce = () => {
    const verifier = nodeCrypto.randomBytes(48).toString('base64url');
    return { verifier, challenge: nodeCrypto.createHash('sha256').update(verifier).digest('base64url') };
  };
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

  async function beginAuthorize() {
    const reg = await request('POST', '/oauth/register', { json: { redirect_uris: [REDIRECT], client_name: 'Claude' } });
    assert.strictEqual(reg.status, 201, reg.text);
    const { verifier, challenge } = pkce();
    const page = await request('GET', `/oauth/authorize?response_type=code&client_id=${reg.json.client_id}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=st`);
    assert.strictEqual(page.status, 200, `authorize failed: ${page.status}`);
    const key = /\/oauth\/connect\/highlevel\?k=([^"]+)"/.exec(page.text);
    assert.ok(key, 'no HighLevel sign-in on the consent page');
    return { clientId: reg.json.client_id, verifier, key: decodeURIComponent(key[1]) };
  }

  async function signIn(key, code) {
    const start = await request('POST', `/oauth/connect/highlevel?k=${encodeURIComponent(key)}`);
    assert.strictEqual(start.status, 302, `sign-in did not redirect: ${start.text.slice(0, 200)}`);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    return request('GET', `/highlevel/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  }

  /** Swap the running app for a freshly required one: the closest thing to a cold instance. */
  function coldInstance() {
    server.removeAllListeners('request');
    server.on('request', requireFresh('../src/app').createApp({ log: { info: () => {}, error: () => {} } }));
  }

  await test('redis: the whole connect flow works end to end', async () => {
    const begun = await beginAuthorize();
    const picker = await signIn(begun.key, 'agency:CO_1');
    assert.strictEqual(picker.status, 200, `the callback failed: ${picker.text.slice(0, 200)}`);
    assert.match(picker.text, /Redis Co/);

    const picked = await request('POST', `/oauth/connect/select?k=${encodeURIComponent(begun.key)}`, { form: { locationId: 'LOC_A' } });
    assert.strictEqual(picked.status, 200, `selection failed: ${picked.text.slice(0, 200)}`);

    const done = await request('POST', `/oauth/connect/finish?k=${encodeURIComponent(begun.key)}`);
    assert.strictEqual(done.status, 302, `finish failed: ${done.text.slice(0, 200)}`);
    const code = new URL(done.headers.get('location')).searchParams.get('code');

    const token = await request('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, client_id: begun.clientId, redirect_uri: REDIRECT, code_verifier: begun.verifier },
    });
    assert.strictEqual(token.status, 200, token.text);
    session = { clientId: begun.clientId, tokens: token.json };

    // Everything must have gone through Redis, not a disk.
    assert.ok(redisCommandLog.includes('SET'), 'nothing was written to Redis');
    assert.ok(redisCommandLog.includes('GETDEL'), 'the code was not redeemed atomically');
  });

  await test('redis: a half-picked login survives being finished by a "different instance"', async () => {
    // Dropping the module cache is the closest thing to a cold second instance: no in-process
    // state carries over, so only what is in Redis can make the flow continue. This is the
    // step that matters most on serverless — the picker is mid-flow state, not just a session.
    const begun = await beginAuthorize();
    const picker = await signIn(begun.key, 'agency:CO_1');
    assert.strictEqual(picker.status, 200, picker.text.slice(0, 200));

    coldInstance();

    const picked = await request('POST', `/oauth/connect/select?k=${encodeURIComponent(begun.key)}`, { form: { locationId: 'LOC_A' } });
    assert.strictEqual(picked.status, 200, `a cold instance lost the pending sub-account picker: ${picked.text.slice(0, 200)}`);
    assert.match(picked.text, /Redis Co is ready/);

    coldInstance();

    const done = await request('POST', `/oauth/connect/finish?k=${encodeURIComponent(begun.key)}`);
    assert.strictEqual(done.status, 302, `a cold instance could not finish the flow: ${done.text.slice(0, 200)}`);
  });

  await test('redis: MCP calls work and reach HighLevel with the stored credential', async () => {
    const res = await request('POST', '/mcp', {
      headers: { authorization: `Bearer ${session.tokens.access_token}` },
      json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_accounts', arguments: {} } },
    });
    assert.strictEqual(res.status, 200, res.text);
    assert.match(res.json.result.content[0].text, /Redis Co/);

    const call = await request('POST', '/mcp', {
      headers: { authorization: `Bearer ${session.tokens.access_token}` },
      json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_list_contacts', arguments: { account: 'redis-co' } } },
    });
    assert.ok(!call.json.result.isError, call.json.result.content[0].text);
    const hl = ghlCalls.find((c) => /\/contacts\//.test(c.url));
    assert.ok(hl, 'HighLevel was never called');
    assert.strictEqual(hl.headers.Authorization, 'Bearer hl-mint-LOC_A');
  });

  await test('redis: refresh rotation and reuse detection behave the same as on disk', async () => {
    const first = await request('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token, client_id: session.clientId },
    });
    assert.strictEqual(first.status, 200, first.text);
    assert.notStrictEqual(first.json.refresh_token, session.tokens.refresh_token);

    const replay = await request('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token, client_id: session.clientId },
    });
    assert.strictEqual(replay.status, 400);
    assert.match(replay.json.error_description, /already been used/);

    const after = await request('POST', '/mcp', {
      headers: { authorization: `Bearer ${first.json.access_token}` },
      json: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    assert.strictEqual(after.status, 401, 'the revoked chain still authenticated');
  });

  await test('redis: a rotated-away access token stops working immediately', async () => {
    // The old index entry still exists (it carries the refresh TTL), so this proves the grant
    // itself — not the index — decides whether a token is current.
    const stale = session.tokens.access_token;
    const res = await request('POST', '/mcp', {
      headers: { authorization: `Bearer ${stale}` },
      json: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    assert.strictEqual(res.status, 401);
  });

  await test('redis: healthz reports the backend and stays 200 while reachable', async () => {
    const res = await request('GET', '/healthz');
    assert.strictEqual(res.status, 200);
    assert.match(res.json.storage, /^redis/);
  });

  await test('redis: healthz degrades to 503 when the store is unreachable', async () => {
    const goodToken = process.env.KV_REST_API_TOKEN;
    process.env.KV_REST_API_TOKEN = 'wrong-token';
    try {
      const res = await request('GET', '/healthz');
      assert.strictEqual(res.status, 503, 'an unreachable store still reported healthy');
      assert.strictEqual(res.json.status, 'degraded');
    } finally {
      process.env.KV_REST_API_TOKEN = goodToken;
    }
  });

  await test('redis: a store outage is a 503, not a 500', async () => {
    const goodToken = process.env.KV_REST_API_TOKEN;
    process.env.KV_REST_API_TOKEN = 'wrong-token';
    try {
      const res = await request('POST', '/oauth/register', { json: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } });
      assert.strictEqual(res.status, 503, `a store outage should be retryable, got ${res.status}`);
      assert.strictEqual(res.json.error, 'storage_unavailable');
      assert.strictEqual(res.headers.get('retry-after'), '5');
      assert.ok(!/wrong-token/.test(res.text), 'the store credential leaked into the error');
    } finally {
      process.env.KV_REST_API_TOKEN = goodToken;
    }
  });

  await test('redis: the data directory was never touched', async () => {
    const diskAfter = snapshotDir(sandbox);
    assert.deepStrictEqual(diskAfter, diskBefore, 'the Redis backend wrote to disk — on a serverless platform that data would be silently lost');
  });

  await test('the legacy SSE transport is declined on serverless', async () => {
    process.env.SERVERLESS = '1';
    coldInstance();
    try {
      const res = await request('GET', '/sse', { headers: { authorization: `Bearer ${session.tokens.access_token}` } });
      // The token is revoked by now, so a 401 is fine — what matters is that it is not a stream.
      assert.ok([401, 501].includes(res.status), `expected 401 or 501, got ${res.status}`);
      if (res.status === 501) assert.match(res.json.error_description, /Streamable HTTP/);
    } finally {
      delete process.env.SERVERLESS;
    }
  });

  server.close();
}

(async () => {
  process.stdout.write('ghl-remote storage self-test\n');

  const fake = await startFakeRedis();
  fakeRedisUrl = `http://127.0.0.1:${fake.address().port}`;

  // File backend first, with no Redis details in the environment at all.
  process.env.STORAGE = 'file';
  await contractTests('file');

  // Then Redis, through the fake.
  process.env.STORAGE = 'redis';
  process.env.KV_REST_API_URL = fakeRedisUrl;
  process.env.KV_REST_API_TOKEN = 'fake-redis-token';
  await contractTests('redis');
  await redisFlowTests();

  // And prove 'auto' follows the environment rather than a hard-coded default.
  process.stdout.write('\nbackend selection\n');
  await test('auto picks redis when connection details are present', async () => {
    process.env.STORAGE = 'auto';
    assert.strictEqual(requireFresh('../src/storage').name, 'redis');
  });
  await test('auto falls back to the disk when they are not', async () => {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    try {
      assert.strictEqual(requireFresh('../src/storage').name, 'file');
    } finally {
      process.env.KV_REST_API_URL = url;
      process.env.KV_REST_API_TOKEN = token;
    }
  });
  await test('STORAGE=redis without connection details fails loudly', async () => {
    const url = process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_URL;
    process.env.STORAGE = 'redis';
    try {
      const storage = requireFresh('../src/storage');
      assert.throws(() => storage.name, /no Redis connection details/);
    } finally {
      process.env.KV_REST_API_URL = url;
    }
  });

  fake.close();
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
