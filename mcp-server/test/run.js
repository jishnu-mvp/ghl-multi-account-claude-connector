#!/usr/bin/env node
'use strict';
// Self-test: node test/run.js
//
// Runs against a fake HighLevel (src/http.js is stubbed) so it never touches a real CRM and
// needs no credentials. Covers the protocol handshake, argument validation, the safety gates,
// location injection, the credential store and the browser login flow end to end.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point every path at a throwaway directory before anything reads config.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ghl-mcp-test-'));
process.env.GHL_MCP_HOME = sandbox;
process.env.GHL_MCP_BACKUP_DIR = path.join(sandbox, 'backups');
process.env.GHL_MCP_ACCOUNTS_FILE = path.join(sandbox, 'accounts.conf');
process.env.GHL_MCP_REPO_ROOT = sandbox;
process.env.GHL_MCP_LOGIN_TTL_MS = '20000';
delete process.env.GHL_PIT_TOKEN;
delete process.env.GHL_LOCATION_ID;
delete process.env.GHL_OAUTH_CLIENT_ID;
delete process.env.GHL_OAUTH_CLIENT_SECRET;

fs.writeFileSync(process.env.GHL_MCP_ACCOUNTS_FILE, [
  '# test registry',
  'legacy|Legacy Client|GHL_PIT_TOKEN_LEGACY|GHL_LOCATION_ID_LEGACY',
  '',
].join('\n'));

// --- fake HighLevel ------------------------------------------------------------------
const http = require('../src/http');
const calls = [];
let responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
http.request = async (opts) => {
  calls.push(opts);
  return responder(opts);
};

const config = require('../src/config');
const store = require('../src/store');
const accounts = require('../src/accounts');
const safety = require('../src/safety');
const catalog = require('../src/catalog');
const { buildTools } = require('../src/tools');
const tools = buildTools('local');
const login = require('../src/login');

// --- tiny test harness ----------------------------------------------------------------
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

// Build the server exactly the way the entry point does, so instructions are covered too.
const server = require('../server').build();

async function callTool(name, args) {
  const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res.result, `tools/call returned an error frame: ${JSON.stringify(res.error)}`);
  return { text: res.result.content.map((c) => c.text).join('\n'), isError: Boolean(res.result.isError) };
}

function lastCall() {
  return calls[calls.length - 1];
}

function seedAccount(overrides = {}) {
  return store.saveAccount({
    alias: 'acme',
    displayName: 'Acme Pty Ltd',
    authType: 'pit',
    token: 'pit-testtoken-0000-1111',
    locationId: 'LOC1',
    ...overrides,
  });
}

// --- protocol -------------------------------------------------------------------------
async function protocolTests() {
  process.stdout.write('\nprotocol\n');

  await test('initialize echoes a supported protocol version and advertises tools', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.strictEqual(res.result.protocolVersion, '2024-11-05');
    assert.ok(res.result.capabilities.tools);
    assert.match(res.result.instructions, /explicit `account` alias/);
  });

  await test('initialize falls back to the default for an unknown version', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.strictEqual(res.result.protocolVersion, config.DEFAULT_PROTOCOL_VERSION);
  });

  await test('notifications get no response', async () => {
    assert.strictEqual(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });

  await test('unknown methods return -32601', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 9, method: 'nope' });
    assert.strictEqual(res.error.code, -32601);
  });

  await test('every tool has a name, description and object schema', async () => {
    for (const t of server.listTools()) {
      assert.ok(t.name && /^ghl_[a-z0-9_]+$/.test(t.name), `bad tool name: ${t.name}`);
      assert.ok(t.description && t.description.length > 20, `thin description on ${t.name}`);
      assert.strictEqual(t.inputSchema.type, 'object', `${t.name} schema is not an object`);
      for (const req of t.inputSchema.required || []) {
        assert.ok(t.inputSchema.properties[req], `${t.name} requires "${req}" but does not declare it`);
      }
    }
  });

  await test('every data tool requires an account and every gated tool takes confirm', async () => {
    const noAccountAllowed = new Set(['ghl_login', 'ghl_login_status', 'ghl_accounts', 'ghl_login_config', 'ghl_search_operations', 'ghl_describe_operation']);
    for (const t of server.listTools()) {
      if (noAccountAllowed.has(t.name)) continue;
      assert.ok((t.inputSchema.required || []).includes('account'), `${t.name} does not require an account`);
    }
    for (const name of ['ghl_send_message', 'ghl_create_appointment', 'ghl_add_to_workflow', 'ghl_add_to_campaign', 'ghl_delete_contact', 'ghl_delete_opportunity', 'ghl_send_invoice', 'ghl_request']) {
      const t = server.listTools().find((x) => x.name === name);
      assert.ok(t.inputSchema.properties.confirm, `${name} has no confirm argument`);
    }
  });

  await test('argument validation rejects a missing required field', async () => {
    const res = await callTool('ghl_get_contact', { account: 'acme' });
    assert.ok(res.isError);
    assert.match(res.text, /"contact_id" is required/);
  });

  await test('argument validation rejects a bad enum value', async () => {
    const res = await callTool('ghl_set_opportunity_status', { account: 'acme', opportunity_id: 'o1', status: 'maybe' });
    assert.ok(res.isError);
    assert.match(res.text, /must be one of/);
  });
}

// --- accounts -------------------------------------------------------------------------
async function accountTests() {
  process.stdout.write('\naccounts\n');

  await test('no account named is refused, not defaulted', async () => {
    seedAccount();
    const res = await callTool('ghl_get_contact', { contact_id: 'c1' });
    assert.ok(res.isError);
    assert.match(res.text, /"account" is required/);
    store.deleteAccount('acme');
  });

  await test('a single connected account is still not chosen implicitly', async () => {
    seedAccount();
    let threw = false;
    try { accounts.resolve(''); } catch (err) { threw = true; assert.match(err.message, /no default/); }
    assert.ok(threw, 'resolve("") should have thrown');
    store.deleteAccount('acme');
  });

  await test('an unknown alias lists what is available instead', async () => {
    seedAccount();
    const res = await callTool('ghl_get_contact', { account: 'nope', contact_id: 'c1' });
    assert.ok(res.isError);
    assert.match(res.text, /Unknown account "nope"/);
    assert.match(res.text, /acme \(Acme Pty Ltd\)/);
    store.deleteAccount('acme');
  });

  await test('accounts.conf rows appear but are flagged as not logged in', async () => {
    const list = accounts.listAll();
    const legacy = list.find((a) => a.alias === 'legacy');
    assert.ok(legacy, 'legacy row missing');
    assert.strictEqual(legacy.ready, false);
    assert.strictEqual(legacy.displayName, 'Legacy Client');
  });

  await test('environment credentials still work for an accounts.conf row', async () => {
    process.env.GHL_PIT_TOKEN_LEGACY = 'pit-legacy-token';
    process.env.GHL_LOCATION_ID_LEGACY = 'LEGACYLOC';
    try {
      const creds = await accounts.credentials('legacy');
      assert.strictEqual(creds.token, 'pit-legacy-token');
      assert.strictEqual(creds.locationId, 'LEGACYLOC');
    } finally {
      delete process.env.GHL_PIT_TOKEN_LEGACY;
      delete process.env.GHL_LOCATION_ID_LEGACY;
    }
  });

  await test('credentials in the repo .env work with no relaunch', async () => {
    // The original flow put the token in .env and relied on a launcher wrapper to export it.
    // The server reads the file itself, so an existing setup needs no migration.
    const dotenv = require('../src/dotenv');
    fs.writeFileSync(path.join(sandbox, '.env'), 'GHL_PIT_TOKEN_LEGACY=pit-from-dotenv\nGHL_LOCATION_ID_LEGACY="DOTENVLOC"\n');
    dotenv.reset();
    try {
      const legacy = accounts.listAll().find((a) => a.alias === 'legacy');
      assert.strictEqual(legacy.ready, true, 'the .env account was not picked up');
      const creds = await accounts.credentials('legacy');
      assert.strictEqual(creds.token, 'pit-from-dotenv');
      assert.strictEqual(creds.locationId, 'DOTENVLOC', 'quoted .env values must be unquoted');
    } finally {
      fs.rmSync(path.join(sandbox, '.env'), { force: true });
      dotenv.reset();
    }
  });

  await test('a real environment variable beats the .env file', async () => {
    const dotenv = require('../src/dotenv');
    fs.writeFileSync(path.join(sandbox, '.env'), 'GHL_PIT_TOKEN_LEGACY=pit-from-dotenv\nGHL_LOCATION_ID_LEGACY=DOTENVLOC\n');
    dotenv.reset();
    process.env.GHL_PIT_TOKEN_LEGACY = 'pit-from-environment';
    try {
      const creds = await accounts.credentials('legacy');
      assert.strictEqual(creds.token, 'pit-from-environment');
    } finally {
      delete process.env.GHL_PIT_TOKEN_LEGACY;
      fs.rmSync(path.join(sandbox, '.env'), { force: true });
      dotenv.reset();
    }
  });

  await test('a login overrides the accounts.conf row for the same alias', async () => {
    process.env.GHL_PIT_TOKEN_LEGACY = 'pit-legacy-token';
    process.env.GHL_LOCATION_ID_LEGACY = 'LEGACYLOC';
    store.saveAccount({ alias: 'legacy', displayName: 'Legacy Client', authType: 'pit', token: 'pit-fresh-login', locationId: 'NEWLOC' });
    try {
      const creds = await accounts.credentials('legacy');
      assert.strictEqual(creds.token, 'pit-fresh-login');
      assert.strictEqual(creds.locationId, 'NEWLOC');
      assert.match(creds.account.source, /browser login/);
    } finally {
      store.deleteAccount('legacy');
      delete process.env.GHL_PIT_TOKEN_LEGACY;
      delete process.env.GHL_LOCATION_ID_LEGACY;
    }
  });

  await test('ghl_accounts explains itself when nothing is connected', async () => {
    const res = await callTool('ghl_accounts', {});
    assert.match(res.text, /legacy/);
    assert.match(res.text, /never pick one of these on the user's behalf/i);
  });

  await test('the credential store is written owner-only', async () => {
    seedAccount();
    const mode = fs.statSync(config.credentialsFile()).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
}

// --- requests -------------------------------------------------------------------------
async function requestTests() {
  process.stdout.write('\nrequests\n');
  seedAccount();

  await test('the three mandatory headers are always sent', async () => {
    await callTool('ghl_list_contacts', { account: 'acme' });
    const req = lastCall();
    assert.strictEqual(req.headers.Authorization, 'Bearer pit-testtoken-0000-1111');
    assert.strictEqual(req.headers.Version, config.API_VERSION);
    assert.strictEqual(req.headers.Accept, 'application/json');
  });

  await test('writes send Content-Type: application/json', async () => {
    await callTool('ghl_add_tags', { account: 'acme', contact_id: 'c1', tags: 'vip' });
    assert.strictEqual(lastCall().headers['Content-Type'], 'application/json');
  });

  await test('locationId is injected as a query parameter', async () => {
    await callTool('ghl_list_contacts', { account: 'acme' });
    assert.match(lastCall().url, /\/contacts\/\?locationId=LOC1/);
  });

  await test('the opportunities search endpoint gets snake_case params', async () => {
    await callTool('ghl_search_opportunities', { account: 'acme', pipeline_id: 'p1' });
    assert.match(lastCall().url, /location_id=LOC1/);
    assert.match(lastCall().url, /pipeline_id=p1/);
  });

  await test('invoices and media get altId/altType', async () => {
    await callTool('ghl_list_invoices', { account: 'acme' });
    assert.match(lastCall().url, /altId=LOC1&altType=location/);
    await callTool('ghl_list_media', { account: 'acme' });
    assert.match(lastCall().url, /altId=LOC1&altType=location/);
  });

  await test('locationId goes in the path where the endpoint wants it there', async () => {
    await callTool('ghl_list_tags', { account: 'acme' });
    assert.match(lastCall().url, /\/locations\/LOC1\/tags$/);
  });

  await test('locationId goes in the body on create', async () => {
    await callTool('ghl_create_contact', { account: 'acme', first_name: 'Zzz', email: 'zzz-test@example.com' });
    assert.strictEqual(JSON.parse(lastCall().body).locationId, 'LOC1');
  });

  await test('a contact update refuses to carry locationId', async () => {
    const res = await callTool('ghl_update_contact', { account: 'acme', contact_id: 'c1', updates: { locationId: 'LOC1', firstName: 'A' } });
    assert.ok(res.isError);
    assert.match(res.text, /Remove locationId/);
  });

  await test('ISO date-times are converted to epoch milliseconds for free slots', async () => {
    await callTool('ghl_free_slots', { account: 'acme', calendar_id: 'cal1', start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z' });
    const url = lastCall().url;
    assert.match(url, new RegExp(`startDate=${Date.parse('2026-09-15T00:00:00Z')}`));
    assert.match(url, new RegExp(`endDate=${Date.parse('2026-09-16T00:00:00Z')}`));
  });

  await test('the account is named in every successful result', async () => {
    const res = await callTool('ghl_list_contacts', { account: 'acme' });
    assert.match(res.text, /Account : Acme Pty Ltd \(acme\)/);
  });

  await test('a 401 is reported as a missing scope and never retried', async () => {
    responder = () => ({ status: 401, headers: {}, text: JSON.stringify({ message: 'not authorized' }) });
    const res = await callTool('ghl_list_contacts', { account: 'acme' });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    assert.ok(res.isError);
    assert.match(res.text, /missing scope/);
    assert.match(res.text, /contacts.readonly/);
    assert.strictEqual(calls.length, 1, 'a 401 must not be retried');
  });

  await test('a 429 is retried exactly once, then surfaced', async () => {
    responder = () => ({ status: 429, headers: { 'retry-after': '0' }, text: '{"message":"slow down"}' });
    const res = await callTool('ghl_list_contacts', { account: 'acme' });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    assert.ok(res.isError);
    assert.strictEqual(calls.length, 2, 'expected one retry');
    assert.match(res.text, /Rate limited/);
  });

  await test('a non-JSON error body is passed through rather than swallowed', async () => {
    responder = () => ({ status: 500, headers: {}, text: '<html>gateway blew up</html>' });
    const res = await callTool('ghl_list_contacts', { account: 'acme' });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    assert.ok(res.isError);
    assert.match(res.text, /gateway blew up/);
  });
}

// --- safety ---------------------------------------------------------------------------
async function safetyTests() {
  process.stdout.write('\nsafety\n');
  seedAccount();

  await test('sending a message without confirm is a dry run, not a send', async () => {
    const res = await callTool('ghl_send_message', { account: 'acme', type: 'SMS', contact_id: 'c1', message: 'hello' });
    assert.ok(res.isError, 'a dry run must be flagged so it is not mistaken for a send');
    assert.match(res.text, /NOT SENT — confirmation required/);
    assert.match(res.text, /POST \/conversations\/messages/);
    assert.match(res.text, /"message": "hello"/);
    assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing may be POSTed during a dry run');
  });

  await test('sending with confirm: true goes through', async () => {
    const res = await callTool('ghl_send_message', { account: 'acme', type: 'SMS', contact_id: 'c1', message: 'hello', confirm: true });
    assert.ok(!res.isError, res.text);
    const post = calls.find((c) => c.method === 'POST' && /conversations\/messages/.test(c.url));
    assert.ok(post, 'the send never happened');
    assert.strictEqual(JSON.parse(post.body).message, 'hello');
  });

  await test('a message with no body at all is refused', async () => {
    const res = await callTool('ghl_send_message', { account: 'acme', type: 'SMS', contact_id: 'c1', confirm: true });
    assert.ok(res.isError);
    assert.match(res.text, /Nothing to send/);
  });

  for (const [name, args] of [
    ['ghl_create_appointment', { calendar_id: 'cal1', contact_id: 'c1', start_time: '2026-09-15T10:00:00+10:00' }],
    ['ghl_add_to_workflow', { contact_id: 'c1', workflow_id: 'w1' }],
    ['ghl_add_to_campaign', { contact_id: 'c1', campaign_id: 'ca1' }],
    ['ghl_delete_contact', { contact_id: 'c1' }],
    ['ghl_delete_opportunity', { opportunity_id: 'o1' }],
    ['ghl_send_invoice', { invoice_id: 'i1' }],
    ['ghl_void_invoice', { invoice_id: 'i1' }],
    ['ghl_create_tag', { name: 'brand-new-tag' }],
    ['ghl_create_custom_field', { name: 'Field', data_type: 'TEXT' }],
  ]) {
    await test(`${name} refuses to run without confirm`, async () => {
      const res = await callTool(name, { account: 'acme', ...args });
      assert.ok(res.isError, `${name} ran without confirmation`);
      assert.match(res.text, /confirmation required/);
      assert.ok(!calls.some((c) => ['POST', 'PUT', 'DELETE'].includes(c.method)), `${name} issued a write during its dry run`);
    });
  }

  await test('deleting a contact exports it first', async () => {
    responder = (opts) => (/\/contacts\/c1$/.test(opts.url) && opts.method === 'GET'
      ? { status: 200, headers: {}, text: JSON.stringify({ contact: { id: 'c1', firstName: 'Zzz', email: 'zzz-test@example.com' } }) }
      : { status: 200, headers: {}, text: '{"succeded":true}' });
    const res = await callTool('ghl_delete_contact', { account: 'acme', contact_id: 'c1', confirm: true });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    assert.ok(!res.isError, res.text);
    const match = res.text.match(/Exported to (\S+)/);
    assert.ok(match, 'no export path in the result');
    const saved = JSON.parse(fs.readFileSync(match[1], 'utf8'));
    assert.strictEqual(saved.contact.id, 'c1');
  });

  await test('updating a contact reads and backs it up first', async () => {
    responder = (opts) => (opts.method === 'GET'
      ? { status: 200, headers: {}, text: JSON.stringify({ contact: { id: 'c1', firstName: 'Old' } }) }
      : { status: 200, headers: {}, text: '{"contact":{"id":"c1","firstName":"New"}}' });
    const res = await callTool('ghl_update_contact', { account: 'acme', contact_id: 'c1', updates: { firstName: 'New' } });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    assert.ok(!res.isError, res.text);
    assert.strictEqual(calls[0].method, 'GET', 'the update did not read first');
    assert.match(res.text, /Backed up to/);
    assert.match(res.text, /"firstName":"Old"/);
  });

  await test('a raw GET needs no confirmation but a raw DELETE does', async () => {
    const read = await callTool('ghl_request', { account: 'acme', method: 'GET', path: '/contacts/c1' });
    assert.ok(!read.isError, read.text);
    const write = await callTool('ghl_request', { account: 'acme', method: 'DELETE', path: '/contacts/c1' });
    assert.ok(write.isError);
    assert.match(write.text, /confirmation required/);
  });

  await test('a raw request leaves no unsubstituted path placeholder', async () => {
    const res = await callTool('ghl_request', { account: 'acme', method: 'GET', path: '/contacts/{contactId}' });
    assert.ok(res.isError);
    assert.match(res.text, /still contains \{contactId\}/);
  });

  await test('a raw request injects the location the way the endpoint expects', async () => {
    await callTool('ghl_request', { account: 'acme', method: 'GET', path: '/locations/{locationId}/customValues' });
    assert.match(lastCall().url, /\/locations\/LOC1\/customValues/);
    await callTool('ghl_request', { account: 'acme', method: 'GET', path: '/payments/orders' });
    assert.match(lastCall().url, /altId=LOC1/);
  });

  await test('tokens never appear in output', async () => {
    const res = await callTool('ghl_whoami', { account: 'acme' });
    assert.ok(!res.text.includes('pit-testtoken-0000-1111'), 'the token leaked into ghl_whoami output');
    assert.match(res.text, /pit-test… \(23 chars\)/);
  });

  await test('a token in an error body is redacted', async () => {
    responder = () => ({ status: 400, headers: {}, text: JSON.stringify({ message: 'bad token pit-secret-abc-123456', access_token: 'zzzzzzzzzzzzzz' }) });
    const res = await callTool('ghl_list_contacts', { account: 'acme' });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    assert.ok(!res.text.includes('pit-secret-abc-123456'));
    assert.ok(!res.text.includes('zzzzzzzzzzzzzz'));
    assert.match(res.text, /pit-<redacted>/);
  });
}

// --- catalogue ------------------------------------------------------------------------
async function catalogTests() {
  process.stdout.write('\ncatalogue\n');

  await test('every catalogue entry is well formed', async () => {
    for (const op of catalog.OPERATIONS) {
      assert.ok(/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(op.method), `bad method: ${op.method}`);
      assert.ok(op.path.startsWith('/'), `bad path: ${op.path}`);
      assert.ok(catalog.LOC_EXPLANATION[op.loc], `unknown loc "${op.loc}" on ${op.path}`);
      assert.ok(op.summary.length > 5, `thin summary on ${op.path}`);
    }
  });

  await test('the catalogue covers every domain the skill documents', async () => {
    for (const domain of ['contacts', 'conversations', 'opportunities', 'calendars', 'forms', 'surveys', 'locations', 'users', 'workflows', 'campaigns', 'products', 'invoices', 'payments', 'medias', 'links', 'businesses', 'blogs', 'social', 'funnels']) {
      assert.ok(catalog.domains().includes(domain), `catalogue is missing the ${domain} domain`);
    }
  });

  await test('searching finds the send-message endpoint', async () => {
    const res = await callTool('ghl_search_operations', { query: 'send a message to a contact' });
    assert.match(res.text, /POST\s+\/conversations\/messages/);
  });

  await test('describing an endpoint explains the location convention', async () => {
    const res = await callTool('ghl_describe_operation', { method: 'GET', path: '/opportunities/search' });
    assert.match(res.text, /snake_case/);
    assert.match(res.text, /opportunities.readonly/);
  });

  await test('an unknown endpoint is reported honestly, not invented', async () => {
    const res = await callTool('ghl_describe_operation', { method: 'GET', path: '/made/up/endpoint' });
    assert.match(res.text, /not in the catalogue/);
  });
}

// --- login ----------------------------------------------------------------------------
async function loginTests() {
  process.stdout.write('\nlogin flow\n');

  await test('ghl_login returns a loopback link and no credential prompt in chat', async () => {
    const res = await callTool('ghl_login', { account: 'newclient', open_browser: false });
    assert.match(res.text, /http:\/\/127\.0\.0\.1:\d+\/\?k=/);
    assert.match(res.text, /never enters the transcript/);
  });

  await test('the login page serves a form and rejects a wrong key', async () => {
    const session = login.findSession({ alias: 'newclient' });
    const base = `http://127.0.0.1:${session.port}`;
    const good = await fetch(`${base}/?k=${session.key}`);
    assert.strictEqual(good.status, 200);
    const html = await good.text();
    assert.match(html, /Private Integration Token/);
    assert.match(html, /Log in with HighLevel/);
    const bad = await fetch(`${base}/?k=nope`);
    assert.strictEqual(bad.status, 403);
  });

  await test('pasting a token verifies it, names the business and stores it', async () => {
    const session = login.findSession({ alias: 'newclient' });
    responder = (opts) => (/\/locations\/LOCNEW$/.test(opts.url)
      ? { status: 200, headers: {}, text: JSON.stringify({ location: { id: 'LOCNEW', name: 'New Client Pty Ltd', companyId: 'CO9' } }) }
      : { status: 401, headers: {}, text: '{"message":"nope"}' });
    const res = await fetch(`http://127.0.0.1:${session.port}/pit?k=${session.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'pit-brand-new-token-9999', alias: 'newclient', locationId: 'LOCNEW' }).toString(),
    });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    const html = await res.text();
    assert.match(html, /Connected/);
    assert.ok(!html.includes('pit-brand-new-token-9999'), 'the success page echoed the token back');
    const stored = store.getAccount('newclient');
    assert.strictEqual(stored.displayName, 'New Client Pty Ltd');
    assert.strictEqual(stored.locationId, 'LOCNEW');
    assert.strictEqual(session.status, 'complete');
  });

  await test('ghl_login_status reports the finished login without printing the token', async () => {
    const res = await callTool('ghl_login_status', { account: 'newclient', wait_seconds: 0 });
    assert.match(res.text, /Logged in/);
    assert.match(res.text, /New Client Pty Ltd/);
    assert.ok(!res.text.includes('pit-brand-new-token-9999'));
  });

  await test('a rejected token keeps nothing and explains why', async () => {
    const session = await login.start({ alias: 'badclient' });
    responder = () => ({ status: 401, headers: {}, text: JSON.stringify({ message: 'Invalid token' }) });
    const res = await fetch(`http://127.0.0.1:${session.port}/pit?k=${session.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'pit-wrong', alias: 'badclient', locationId: 'NOPE' }).toString(),
    });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    const html = await res.text();
    assert.match(html, /rejected the token/);
    assert.strictEqual(store.getAccount('badclient'), null, 'a rejected token must not be stored');
    session.close();
  });

  await test('an agency token gets a sub-account picker instead of a guess', async () => {
    const session = await login.start({ alias: 'agency' });
    responder = (opts) => (/\/locations\/search/.test(opts.url)
      ? { status: 200, headers: {}, text: JSON.stringify({ locations: [{ id: 'L1', name: 'Client One' }, { id: 'L2', name: 'Client Two' }] }) }
      : { status: 200, headers: {}, text: '{}' });
    const res = await fetch(`http://127.0.0.1:${session.port}/pit?k=${session.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'pit-agency-token', alias: 'agency' }).toString(),
    });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    const html = await res.text();
    assert.match(html, /Which sub-account/);
    assert.match(html, /Client One/);
    assert.match(html, /Client Two/);
    assert.strictEqual(store.getAccount('agency'), null, 'nothing should be stored until a sub-account is chosen');
    session.close();
  });

  await test('the OAuth authorize URL is built against HighLevel marketplace', async () => {
    const oauth = require('../src/oauth');
    const url = oauth.authorizeUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1234/oauth/callback', state: 'st' });
    assert.match(url, /^https:\/\/marketplace\.gohighlevel\.com\/oauth\/chooselocation\?/);
    assert.match(url, /response_type=code/);
    assert.match(url, /client_id=cid/);
    assert.match(url, /state=st/);
    assert.match(url, /scope=contacts.readonly/);
  });

  await test('an expired OAuth access token is refreshed transparently', async () => {
    store.saveOAuthApp({ clientId: 'cid', clientSecret: 'csecret' });
    store.saveAccount({
      alias: 'oauthclient',
      displayName: 'OAuth Client',
      authType: 'oauth',
      accessToken: 'expired-token',
      refreshToken: 'refresh-me',
      expiresAt: Date.now() - 1000,
      locationId: 'OLOC',
      userType: 'Location',
    });
    responder = (opts) => (/\/oauth\/token$/.test(opts.url)
      ? { status: 200, headers: {}, text: JSON.stringify({ access_token: 'fresh-token', refresh_token: 'refresh-2', expires_in: 86399, scope: 'contacts.readonly', userType: 'Location', locationId: 'OLOC' }) }
      : { status: 200, headers: {}, text: '{"contacts":[]}' });
    const res = await callTool('ghl_list_contacts', { account: 'oauthclient' });
    responder = () => ({ status: 200, headers: {}, text: JSON.stringify({ ok: true }) });
    assert.ok(!res.isError, res.text);
    const refresh = calls.find((c) => /\/oauth\/token$/.test(c.url));
    assert.ok(refresh, 'no refresh was attempted');
    assert.match(refresh.body, /grant_type=refresh_token/);
    const data = calls.find((c) => /\/contacts\//.test(c.url));
    assert.strictEqual(data.headers.Authorization, 'Bearer fresh-token', 'the refreshed token was not used');
    assert.strictEqual(store.getAccount('oauthclient').accessToken, 'fresh-token', 'the refreshed token was not persisted');
    store.deleteAccount('oauthclient');
    store.deleteOAuthApp();
  });

  await test('logging out needs confirmation and then forgets the account', async () => {
    seedAccount({ alias: 'gone', displayName: 'Gone Ltd' });
    const dry = await callTool('ghl_logout', { account: 'gone' });
    assert.ok(dry.isError);
    assert.ok(store.getAccount('gone'), 'the account was removed during a dry run');
    const res = await callTool('ghl_logout', { account: 'gone', confirm: true });
    assert.ok(!res.isError, res.text);
    assert.strictEqual(store.getAccount('gone'), null);
    assert.match(res.text, /still valid inside HighLevel/);
  });
}

// --- stdio transport -------------------------------------------------------------------
async function transportTests() {
  process.stdout.write('\nstdio transport\n');

  await test('a real child process completes an MCP handshake over stdio', async () => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, GHL_MCP_HOME: sandbox },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const frames = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) frames.push(JSON.parse(line));
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ghl_search_operations', arguments: { query: 'free slots' } } })}\n`);

    const deadline = Date.now() + 15000;
    while (frames.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    child.stdin.end();
    child.kill();

    assert.strictEqual(frames.length, 3, `expected 3 response frames, got ${frames.length}`);
    assert.strictEqual(frames[0].result.serverInfo.name, 'ghl');
    assert.ok(frames[1].result.tools.length > 50, 'tool list looks too short');
    assert.match(frames[2].result.content[0].text, /free-slots/);
    // A notification must not produce a frame, and nothing but JSON may hit stdout.
    assert.ok(frames.every((f) => f.jsonrpc === '2.0'));
  });
}

(async () => {
  process.stdout.write('ghl-mcp self-test\n');
  await protocolTests();
  await accountTests();
  await requestTests();
  await safetyTests();
  await catalogTests();
  await loginTests();
  await transportTests();

  for (const s of login.sessions.values()) s.close();
  fs.rmSync(sandbox, { recursive: true, force: true });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  ${f.name}\n    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}\n`);
    process.exit(1);
  }
  process.exit(0);
})();
