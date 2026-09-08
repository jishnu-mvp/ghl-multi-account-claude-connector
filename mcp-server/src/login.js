'use strict';
// The login flow: a tiny web page on 127.0.0.1 that a person opens in their browser to
// connect a GoHighLevel sub-account.
//
// Why a browser page and not a tool argument: the credential never travels through the chat
// transcript, never lands in a file inside the repository, and nobody has to edit .env or
// relaunch anything. Two ways in:
//
//   1. Private Integration Token — paste the pit-… token from their own HighLevel account.
//      Works with no prior setup at all. If the token is agency-level we list their
//      sub-accounts and let them pick one.
//   2. Log in with HighLevel (OAuth) — real email/password sign-in on HighLevel's own
//      domain, then a consent screen. Needs a HighLevel marketplace app once, because
//      HighLevel has no dynamic client registration; the page walks them through it.
//
// The server binds to loopback only, is guarded by a single-use key in the URL, and shuts
// itself down when the login completes or the TTL expires.

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { execFile } = require('child_process');

const config = require('./config');
const store = require('./store');
const oauth = require('./oauth');
const api = require('./api');
const page = require('./pages');

/** @type {Map<string, Session>} keyed by the URL key */
const sessions = new Map();

class Session {
  constructor({ alias, displayName, scopes }) {
    this.key = crypto.randomBytes(24).toString('base64url');
    this.state = crypto.randomBytes(16).toString('base64url');
    this.alias = alias ? store.normaliseAlias(alias) : '';
    this.displayName = displayName || '';
    this.scopes = scopes && scopes.length ? scopes : config.OAUTH_DEFAULT_SCOPES;
    this.status = 'pending';      // pending | complete | failed | expired
    this.result = null;
    this.error = null;
    this.startedAt = Date.now();
    this.server = null;
    this.url = null;
    this.pending = null;          // half-finished login carried between page steps
    this.timer = null;
  }

  finish(status, payload) {
    this.status = status;
    if (status === 'complete') this.result = payload;
    if (status === 'failed') this.error = payload;
    // Give the browser a moment to render the final page before the socket goes away.
    setTimeout(() => this.close(), 1500);
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.server) {
      try { this.server.close(); } catch (_) { /* already closing */ }
      this.server = null;
    }
    // Keep the record around briefly so ghl_login_status can still report the outcome.
    setTimeout(() => sessions.delete(this.key), 5 * 60 * 1000).unref?.();
  }

  summary() {
    return {
      alias: this.alias || null,
      status: this.status,
      url: this.url,
      startedAt: new Date(this.startedAt).toISOString(),
      result: this.result,
      error: this.error,
    };
  }
}

/**
 * Start a login server.
 * @returns {Promise<Session>}
 */
function start({ alias, displayName, scopes } = {}) {
  const session = new Session({ alias, displayName, scopes });

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(session, req, res).catch((err) => {
        respondHtml(res, 500, page.errorPage('Something went wrong', err.message));
      });
    });
    server.on('error', reject);
    server.listen(config.LOGIN_SERVER.port, config.LOGIN_SERVER.host, () => {
      const { port } = server.address();
      session.server = server;
      session.port = port;
      session.url = `http://${config.LOGIN_SERVER.host}:${port}/?k=${session.key}`;
      session.timer = setTimeout(() => {
        if (session.status === 'pending') {
          session.status = 'expired';
          session.close();
        }
      }, config.LOGIN_SERVER.ttlMs);
      session.timer.unref?.();
      sessions.set(session.key, session);
      resolve(session);
    });
  });
}

function getSession(key) {
  return sessions.get(key) || null;
}

function findSession({ alias } = {}) {
  const all = [...sessions.values()];
  if (alias) {
    const key = store.normaliseAlias(alias);
    const match = all.filter((s) => s.alias === key);
    if (match.length) return match[match.length - 1];
  }
  return all.length ? all[all.length - 1] : null;
}

/** Resolve once a pending session settles, or after timeoutMs, whichever comes first. */
async function waitFor(session, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (session.status === 'pending' && Date.now() < deadline) {
    await api.sleep(400);
  }
  return session;
}

// --- request routing ---------------------------------------------------------------

async function handle(session, req, res) {
  const url = new URL(req.url, `http://${config.LOGIN_SERVER.host}`);
  const key = url.searchParams.get('k');
  const path = url.pathname;

  // The OAuth callback comes back from HighLevel, which will not carry our key, so it is
  // authenticated by the `state` parameter instead.
  const isCallback = path === '/oauth/callback';
  if (!isCallback && key !== session.key) {
    respondHtml(res, 403, page.errorPage('Wrong link', 'Open the exact link the ghl_login tool printed — this one is missing its one-time key.'));
    return;
  }

  if (req.method === 'GET' && path === '/') {
    respondHtml(res, 200, page.loginPage(session, { oauthApp: store.getOAuthApp() }));
    return;
  }

  if (req.method === 'POST' && path === '/pit') {
    await handlePitSubmit(session, req, res);
    return;
  }

  if (req.method === 'POST' && path === '/pit/select') {
    await handlePitSelect(session, req, res);
    return;
  }

  if (req.method === 'POST' && path === '/oauth/app') {
    await handleOAuthAppSubmit(session, req, res);
    return;
  }

  if (req.method === 'GET' && path === '/oauth/start') {
    handleOAuthStart(session, res);
    return;
  }

  if (isCallback) {
    await handleOAuthCallback(session, url, res);
    return;
  }

  if (req.method === 'POST' && path === '/oauth/select') {
    await handleOAuthSelect(session, req, res);
    return;
  }

  respondHtml(res, 404, page.errorPage('Not found', `No page at ${path}.`));
}

// --- Private Integration Token path -------------------------------------------------

async function handlePitSubmit(session, req, res) {
  const form = await readForm(req);
  const token = (form.token || '').trim();
  const locationId = (form.locationId || '').trim();
  const alias = store.normaliseAlias(form.alias || session.alias || '');
  const displayName = (form.displayName || session.displayName || '').trim();

  if (!token) {
    respondHtml(res, 400, page.loginPage(session, { oauthApp: store.getOAuthApp(), error: 'Paste your Private Integration Token first.' }));
    return;
  }
  if (!alias) {
    respondHtml(res, 400, page.loginPage(session, {
      oauthApp: store.getOAuthApp(),
      error: 'Give this connection a short name (the alias you will refer to it by in chat).',
      form,
    }));
    return;
  }

  // Location given: verify it directly. This is the common case.
  if (locationId) {
    try {
      const probe = await api.call({ method: 'GET', path: `/locations/${encodeURIComponent(locationId)}`, token });
      const location = (probe.data && (probe.data.location || probe.data)) || {};
      const saved = store.saveAccount({
        alias,
        displayName: displayName || location.name || alias,
        authType: 'pit',
        token,
        locationId,
        companyId: location.companyId || null,
        lastVerifiedAt: new Date().toISOString(),
      });
      session.finish('complete', publicAccount(saved, location));
      respondHtml(res, 200, page.successPage(saved, location));
    } catch (err) {
      respondHtml(res, 200, page.loginPage(session, {
        oauthApp: store.getOAuthApp(),
        form,
        error: pitFailureMessage(err),
      }));
    }
    return;
  }

  // No location given: try to discover the sub-accounts this token can see. That only works
  // for an agency-level token; a sub-account PIT 401s here, which is expected.
  try {
    const search = await api.call({ method: 'GET', path: '/locations/search', token, query: { limit: 200 } });
    const locations = (search.data && (search.data.locations || search.data.results || [])) || [];
    if (locations.length) {
      session.pending = { kind: 'pit', token, alias, displayName };
      respondHtml(res, 200, page.locationPickerPage(session, {
        locations: locations.map((l) => ({ id: l.id || l._id, name: l.name || l.businessName || l.id })),
        action: `/pit/select?k=${session.key}`,
        heading: 'Which sub-account?',
        note: 'This token can see more than one sub-account. Pick the one this connection should use.',
      }));
      return;
    }
  } catch (_) {
    // Fall through: a sub-account token cannot list locations, so just ask for the id.
  }

  respondHtml(res, 200, page.loginPage(session, {
    oauthApp: store.getOAuthApp(),
    form,
    needLocation: true,
    error: 'Could not detect the sub-account automatically (normal for a sub-account token). Paste the Location ID as well — HighLevel → Settings → Business Profile.',
  }));
}

async function handlePitSelect(session, req, res) {
  const form = await readForm(req);
  const pending = session.pending;
  if (!pending || pending.kind !== 'pit') {
    respondHtml(res, 400, page.errorPage('Nothing to finish', 'Start again from the login link.'));
    return;
  }
  const locationId = (form.locationId || '').trim();
  if (!locationId) {
    respondHtml(res, 400, page.errorPage('No sub-account chosen', 'Go back and pick a sub-account.'));
    return;
  }
  try {
    const probe = await api.call({ method: 'GET', path: `/locations/${encodeURIComponent(locationId)}`, token: pending.token });
    const location = (probe.data && (probe.data.location || probe.data)) || {};
    const saved = store.saveAccount({
      alias: pending.alias,
      displayName: pending.displayName || location.name || pending.alias,
      authType: 'pit',
      token: pending.token,
      locationId,
      companyId: location.companyId || null,
      lastVerifiedAt: new Date().toISOString(),
    });
    session.finish('complete', publicAccount(saved, location));
    respondHtml(res, 200, page.successPage(saved, location));
  } catch (err) {
    respondHtml(res, 200, page.errorPage('That sub-account could not be verified', pitFailureMessage(err)));
  }
}

function pitFailureMessage(err) {
  if (err && err.status === 401) {
    return 'HighLevel rejected the token (401). Either the token is wrong or it was created without the `locations.readonly` scope. ' +
      'Check it in Settings → Other Settings → Private Integrations, and remember the token is shown only once — if it was lost, create a new integration. ' +
      `HighLevel said: ${short(err.body)}`;
  }
  if (err && err.status === 403) {
    return `HighLevel accepted the token but refused this call (403) — a scope is missing. HighLevel said: ${short(err.body)}`;
  }
  if (err && err.status === 404) {
    return 'No sub-account with that Location ID. Copy it from HighLevel → Settings → Business Profile.';
  }
  return err && err.message ? err.message : 'Unknown failure.';
}

// --- OAuth path ---------------------------------------------------------------------

async function handleOAuthAppSubmit(session, req, res) {
  const form = await readForm(req);
  try {
    store.saveOAuthApp({ clientId: form.clientId, clientSecret: form.clientSecret });
  } catch (err) {
    respondHtml(res, 400, page.loginPage(session, { oauthApp: null, error: err.message, form }));
    return;
  }
  session.alias = store.normaliseAlias(form.alias || session.alias || '');
  session.displayName = (form.displayName || session.displayName || '').trim();
  handleOAuthStart(session, res);
}

function handleOAuthStart(session, res) {
  const app = store.getOAuthApp();
  if (!app) {
    respondHtml(res, 400, page.errorPage(
      'No HighLevel app configured',
      'The "log in with HighLevel" flow needs a HighLevel marketplace app (client id + secret). Go back and use the Private Integration Token option, or add the app credentials.'
    ));
    return;
  }
  const redirectUri = redirectUriFor(session);
  const url = oauth.authorizeUrl({
    clientId: app.clientId,
    redirectUri,
    scopes: session.scopes,
    state: session.state,
  });
  res.writeHead(302, { Location: url });
  res.end();
}

function redirectUriFor(session) {
  return `http://${config.LOGIN_SERVER.host}:${session.port}/oauth/callback`;
}

async function handleOAuthCallback(session, url, res) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');

  if (denied) {
    session.finish('failed', `HighLevel returned "${denied}": ${url.searchParams.get('error_description') || 'authorisation was not granted'}`);
    respondHtml(res, 200, page.errorPage('Authorisation cancelled', session.error));
    return;
  }
  if (!code) {
    respondHtml(res, 400, page.errorPage('No authorisation code', 'HighLevel redirected back without a code. Start the login again.'));
    return;
  }
  if (state !== session.state) {
    respondHtml(res, 400, page.errorPage('State mismatch', 'The redirect did not match this login attempt. Start again from a fresh ghl_login link.'));
    return;
  }

  const app = store.getOAuthApp();
  try {
    const tokens = await oauth.exchangeCode({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code,
      redirectUri: redirectUriFor(session),
      userType: 'Location',
    });

    // A company-level grant has no single location — let them choose which sub-account this
    // connection should point at, then mint a location token for it.
    if (!tokens.locationId && tokens.companyId) {
      session.pending = { kind: 'oauth', tokens };
      let locations = [];
      try {
        const installed = await oauth.installedLocations({
          agencyAccessToken: tokens.accessToken,
          companyId: tokens.companyId,
          appId: app.clientId,
        });
        locations = (installed && (installed.locations || installed.data || [])) || [];
      } catch (_) { /* fall back to a free-text location id */ }
      respondHtml(res, 200, page.locationPickerPage(session, {
        locations: locations.map((l) => ({ id: l._id || l.id, name: l.name || l._id || l.id })),
        action: `/oauth/select?k=${session.key}`,
        heading: 'Which sub-account?',
        note: 'You signed in at agency level. Choose the sub-account this connection should work in.',
        allowManual: true,
      }));
      return;
    }

    const saved = await saveOAuthAccount(session, tokens);
    session.finish('complete', publicAccount(saved, null));
    respondHtml(res, 200, page.successPage(saved, null));
  } catch (err) {
    session.finish('failed', err.message);
    respondHtml(res, 200, page.errorPage('Login failed', err.message));
  }
}

async function handleOAuthSelect(session, req, res) {
  const form = await readForm(req);
  const pending = session.pending;
  if (!pending || pending.kind !== 'oauth') {
    respondHtml(res, 400, page.errorPage('Nothing to finish', 'Start again from the login link.'));
    return;
  }
  const locationId = (form.locationId || '').trim();
  if (!locationId) {
    respondHtml(res, 400, page.errorPage('No sub-account chosen', 'Go back and pick a sub-account.'));
    return;
  }
  const app = store.getOAuthApp();
  try {
    const locationTokens = await oauth.locationToken({
      agencyAccessToken: pending.tokens.accessToken,
      companyId: pending.tokens.companyId,
      locationId,
    });
    const saved = await saveOAuthAccount(session, {
      ...locationTokens,
      locationId: locationTokens.locationId || locationId,
      companyId: pending.tokens.companyId,
      // A minted location token carries no refresh token of its own; keep the agency one so
      // the connection can be renewed later.
      refreshToken: locationTokens.refreshToken || pending.tokens.refreshToken,
    });
    session.finish('complete', publicAccount(saved, null));
    respondHtml(res, 200, page.successPage(saved, null));
  } catch (err) {
    void app;
    respondHtml(res, 200, page.errorPage('Could not connect that sub-account', err.message));
  }
}

async function saveOAuthAccount(session, tokens) {
  const alias = store.normaliseAlias(session.alias || `loc-${(tokens.locationId || 'ghl').slice(-6)}`);
  let displayName = session.displayName;
  let companyId = tokens.companyId;

  // Name the connection after the sub-account so the chat can say which client it acted on.
  if (tokens.locationId) {
    try {
      const probe = await api.call({ method: 'GET', path: `/locations/${encodeURIComponent(tokens.locationId)}`, token: tokens.accessToken });
      const location = (probe.data && (probe.data.location || probe.data)) || {};
      displayName = displayName || location.name || alias;
      companyId = companyId || location.companyId || null;
    } catch (_) { /* locations.readonly may not be granted; the alias is enough */ }
  }

  return store.saveAccount({
    alias,
    displayName: displayName || alias,
    authType: 'oauth',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    userType: tokens.userType,
    locationId: tokens.locationId,
    companyId,
    userId: tokens.userId,
    lastVerifiedAt: new Date().toISOString(),
  });
}

// --- helpers -------------------------------------------------------------------------

/** Never return the credential itself — only what is safe to show in a chat. */
function publicAccount(account, location) {
  return {
    alias: account.alias,
    displayName: account.displayName,
    authType: account.authType,
    locationId: account.locationId,
    companyId: account.companyId || null,
    locationName: (location && location.name) || account.displayName,
    scope: account.scope || null,
    expiresAt: account.expiresAt ? new Date(account.expiresAt).toISOString() : null,
  };
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) { reject(new Error('Form submission too large.')); return; }
      const params = new URLSearchParams(body);
      const out = {};
      for (const [k, v] of params.entries()) out[k] = v;
      resolve(out);
    });
    req.on('error', reject);
  });
}

function respondHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The page handles credentials; keep it out of any referrer and out of any frame.
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  res.end(html);
}

function short(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return (text || '').slice(0, 300);
}

/** Best-effort "open this in the browser". Silently gives up on a headless machine. */
function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = execFile(command, args, { timeout: 5000 }, (err) => resolve(!err));
      child.on('error', () => resolve(false));
    } catch (_) {
      resolve(false);
    }
  });
}

module.exports = { start, getSession, findSession, waitFor, openBrowser, sessions, publicAccount };
