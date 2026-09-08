'use strict';
// The authorization endpoint and the connect flow that hangs off it.
//
// One screen does two jobs at once, on purpose: it names the client that is asking, and it
// connects the GoHighLevel account. That is the confused-deputy mitigation the MCP spec
// requires of a server that proxies a third-party authorization server — the person is told
// exactly who is getting access before any HighLevel consent happens, and a dynamically
// registered client can never inherit someone else's earlier grant.
//
// One connection can hold many sub-accounts across SEVERAL CRMs. An agency's own login only
// covers its own sub-accounts, so reaching two agencies means signing in twice — and the
// second sign-in must add to the first rather than replace it. Hence a flow that accumulates
// and is finished explicitly:
//
//   GET  /oauth/authorize            validate, create a login session, render consent
//   POST /oauth/connect/highlevel    bounce to HighLevel's OAuth (repeatable, per CRM)
//   GET  /highlevel/callback         come back, exchange, list that CRM's sub-accounts
//   POST /oauth/connect/select       attach the ticked sub-accounts, then show the review page
//   POST /oauth/connect/finish       issue the code for everything accumulated
//   POST /oauth/connect/token        legacy: a Private Integration Token (off by default)
//
// Only /finish redirects back to the client, with ?code=&state=

const crypto = require('../crypto');
const config = require('../config');
const storage = require('../storage');
const clients = require('./clients');
const tokens = require('./tokens');
const metadata = require('./metadata');
const tenants = require('../tenants');
const pages = require('../pages');
const ghlOAuth = require('../../../mcp-server/src/oauth');
const api = require('../../../mcp-server/src/api');

// Login sessions go through the storage layer rather than a module-level Map. On a single
// long-lived process either would work, but on a serverless platform the consent screen and
// the form it posts can easily be handled by two different instances — an in-memory session
// would simply not be there, and every connection attempt would fail with "this page has
// expired". Storage is the only thing both instances can see.

class AuthorizeError extends Error {
  constructor(code, description, { redirect } = {}) {
    super(description);
    this.name = 'AuthorizeError';
    this.code = code;
    this.description = description;
    this.redirect = redirect; // true when it is safe to report this to the client
  }
}

async function createSession(params) {
  const key = crypto.randomToken(24);
  const session = {
    key,
    state: crypto.randomToken(16),
    ...params,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.LOGIN_SESSION_TTL_MS,
    pending: null,
    // Everything attached so far, across every CRM signed into during this one login.
    connected: [],
  };
  await storage.sessions.put(key, session);
  return session;
}

async function getSession(key) {
  if (!key) return null;
  const session = await storage.sessions.get(key);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await storage.sessions.delete(key);
    return null;
  }
  return session;
}

/** Persist a session mid-flow — e.g. once a sub-account picker is pending. */
async function saveSession(session) {
  await storage.sessions.put(session.key, session);
  return session;
}

/**
 * GET /oauth/authorize
 * @returns {{kind:'html', html:string} | {kind:'redirect', location:string}}
 */
async function beginAuthorization(query) {
  const clientId = str(query.client_id);
  const redirectUri = str(query.redirect_uri);
  const responseType = str(query.response_type);
  const codeChallenge = str(query.code_challenge);
  const codeChallengeMethod = str(query.code_challenge_method) || 'plain';
  const state = str(query.state);
  const scope = str(query.scope) || metadata.SCOPES.join(' ');
  const resource = str(query.resource);

  // Anything wrong with the client or the redirect URI must NOT be redirected anywhere —
  // that is how open redirectors get built. Render it instead.
  const client = await clients.get(clientId);
  if (!clientId || !client) {
    throw new AuthorizeError('invalid_client', 'Unknown client_id. Register the client first, or reconnect from your assistant so it registers again.');
  }
  if (!redirectUri || !clients.redirectUriAllowed(client, redirectUri)) {
    throw new AuthorizeError('invalid_request', 'redirect_uri does not exactly match one registered by this client.');
  }

  // From here on the client is trusted enough to receive an error redirect.
  const fail = (code, description) => {
    throw new AuthorizeError(code, description, { redirect: { redirectUri, state } });
  };
  if (responseType !== 'code') fail('unsupported_response_type', 'Only response_type=code is supported.');
  if (!codeChallenge) fail('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.');
  if (codeChallengeMethod !== 'S256') fail('invalid_request', 'Only code_challenge_method=S256 is supported.');
  // RFC 8707: if an audience is named it has to be this server's.
  if (resource && !audienceMatches(resource)) {
    fail('invalid_target', `This server only issues tokens for ${config.RESOURCE}.`);
  }

  const session = await createSession({ clientId, redirectUri, codeChallenge, codeChallengeMethod, state, scope, resource });
  return {
    kind: 'html',
    html: pages.consentPage({
      session,
      client,
      oauthAvailable: Boolean(config.GHL_CLIENT_ID && config.GHL_CLIENT_SECRET),
      tokenAllowed: config.ALLOW_TOKEN_CONNECT,
    }),
  };
}

function audienceMatches(resource) {
  const normalise = (u) => String(u).replace(/\/+$/, '').toLowerCase();
  return normalise(resource) === normalise(config.RESOURCE) || normalise(resource) === normalise(config.PUBLIC_URL);
}

/** POST /oauth/connect/token — a Private Integration Token typed on the consent screen. */
async function connectWithToken(session, form) {
  if (!config.ALLOW_TOKEN_CONNECT) {
    throw new AuthorizeError('access_denied', 'Connecting with a Private Integration Token is disabled on this server. Sign in with HighLevel instead.');
  }
  const client = await clients.get(session.clientId);
  const token = str(form.token);
  const locationId = str(form.locationId);

  if (config.SIGNUP_PASSCODE && !crypto.timingSafeEqual(str(form.passcode), config.SIGNUP_PASSCODE)) {
    return renderConsent(session, client, { error: 'That access phrase is not right. Ask the operator of this server for it.', form });
  }
  if (!token) {
    return renderConsent(session, client, { error: 'Paste your Private Integration Token.', form });
  }

  if (locationId) {
    try {
      const info = await tenants.describeLocation({ token, locationId });
      const tenant = await tenants.create({
        authType: 'pit',
        credential: { token },
        locationId,
        displayName: info.name || `Sub-account ${locationId.slice(-6)}`,
        companyId: info.companyId,
      });
      session.connected = [...(session.connected || []), summariseTenant(tenant)];
      session.pending = null;
      await saveSession(session);
      return reviewPage(session);
    } catch (err) {
      return renderConsent(session, client, { error: describeCredentialFailure(err), form, needLocation: true });
    }
  }

  // No location given: an agency-level token can list them, a sub-account token cannot.
  try {
    const search = await api.call({ method: 'GET', path: '/locations/search', token, query: { limit: 200 } });
    const found = (search.data && (search.data.locations || search.data.results)) || [];
    const choices = found
      .map((l) => ({ id: l.id || l._id, name: l.name || l.businessName || l.id || l._id }))
      .filter((l) => l.id);
    if (choices.length) {
      session.pending = { kind: 'pit', token, companyName: null };
      await saveSession(session);
      // As above: one sub-account is not a choice worth asking about.
      if (choices.length === 1) {
        const { failed } = await attachChosen(session, session.pending, [choices[0].id]);
        if (session.connected.length) return reviewPage(session, { failed });
        return renderConsent(session, client, { error: (failed[0] && failed[0].reason) || 'That sub-account could not be connected.', form, needLocation: true });
      }
      return {
        kind: 'html',
        html: pages.subAccountPickerPage({
          session,
          crmName: null,
          locations: choices,
          alreadyConnected: session.connected,
        }),
      };
    }
  } catch (_) {
    // Expected for a sub-account token — fall through and ask for the id.
  }

  return renderConsent(session, client, {
    error: 'Could not detect the sub-account automatically (normal for a sub-account token). Add the Location ID as well — HighLevel → Settings → Business Profile.',
    form,
    needLocation: true,
  });
}

/**
 * POST /oauth/connect/highlevel — hand over to HighLevel's own sign-in.
 * Repeatable: called once per CRM, and anything already attached stays attached.
 */
async function startHighLevelConnect(session) {
  if (!config.GHL_CLIENT_ID || !config.GHL_CLIENT_SECRET) {
    throw new AuthorizeError(
      'temporarily_unavailable',
      'Sign-in with HighLevel is not configured on this server yet. The operator needs to add the HighLevel marketplace app credentials.',
    );
  }
  // Drop any half-finished picker from a previous CRM so a stale one cannot be applied to
  // the agency we are about to sign into.
  session.pending = null;
  await saveSession(session);

  const url = ghlOAuth.authorizeUrl({
    clientId: config.GHL_CLIENT_ID,
    redirectUri: config.highlevelRedirectUri,
    scopes: undefined, // the connector's documented default scope set
    // Our own login-session key travels as HighLevel's state so the callback can find it.
    state: `${session.key}.${session.state}`,
  });
  return { kind: 'redirect', location: url };
}

/** GET /highlevel/callback — HighLevel sends the person back here with a code. */
async function completeHighLevelConnect(query) {
  const rawState = str(query.state);
  const [key, nonce] = rawState.split('.');
  const session = await getSession(key);
  if (!session || session.state !== nonce) {
    return { kind: 'html', status: 400, html: pages.errorPage('This link has expired', 'Start the connection again from your assistant — the sign-in window was open too long, or the link did not match.') };
  }
  if (query.error) {
    return { kind: 'html', status: 200, html: pages.errorPage('Authorisation cancelled', `HighLevel reported: ${str(query.error_description) || str(query.error)}`) };
  }
  const code = str(query.code);
  if (!code) {
    return { kind: 'html', status: 400, html: pages.errorPage('No authorisation code', 'HighLevel redirected back without a code. Start the connection again.') };
  }

  let granted;
  try {
    granted = await ghlOAuth.exchangeCode({
      clientId: config.GHL_CLIENT_ID,
      clientSecret: config.GHL_CLIENT_SECRET,
      code,
      redirectUri: config.highlevelRedirectUri,
      userType: 'Location',
    });
  } catch (err) {
    return { kind: 'html', status: 200, html: pages.errorPage('HighLevel would not complete the sign-in', err.message) };
  }

  // An agency-level grant covers many sub-accounts: list them and let the person tick the
  // ones they want. This is the normal path for anyone managing several clients.
  if (!granted.locationId && granted.companyId) {
    const companyName = await tenants.describeCompany({ token: granted.accessToken, companyId: granted.companyId });
    session.pending = { kind: 'oauth', granted, companyName };
    await saveSession(session);

    let locations = [];
    let listingFailed = null;
    try {
      const installed = await ghlOAuth.installedLocations({
        agencyAccessToken: granted.accessToken,
        companyId: granted.companyId,
        appId: config.GHL_CLIENT_ID,
      });
      locations = (installed && (installed.locations || installed.data)) || [];
    } catch (err) {
      // Not fatal: they can still type a Location ID. But say why the list is missing
      // rather than showing an empty box.
      listingFailed = err.message;
    }

    const choices = locations
      .map((l) => ({ id: l._id || l.id, name: l.name || l._id || l.id }))
      .filter((l) => l.id);

    // A checklist of one is a question with a single answer. If this login covers exactly one
    // sub-account, attach it and go straight to the review screen.
    if (choices.length === 1) {
      const { failed } = await attachChosen(session, session.pending, [choices[0].id]);
      if (!session.connected.length) {
        return {
          kind: 'html',
          status: 200,
          html: pages.errorPage(
            `${choices[0].name} could not be connected`,
            (failed[0] && failed[0].reason) || 'HighLevel refused to authorise that sub-account.',
          ),
        };
      }
      return reviewPage(session, { failed });
    }

    return {
      kind: 'html',
      html: pages.subAccountPickerPage({
        session,
        crmName: companyName,
        locations: choices,
        alreadyConnected: session.connected,
        listingFailed,
      }),
    };
  }

  // A sub-account-level grant covers exactly one location: attach it and go to the review
  // page, so they can still add another CRM afterwards.
  const tenant = await tenantFromGrant(granted, granted.locationId, null);
  session.connected = [...(session.connected || []), summariseTenant(tenant)];
  session.pending = null;
  await saveSession(session);
  return reviewPage(session);
}

/**
 * POST /oauth/connect/select — attach every ticked sub-account from the CRM just signed
 * into, then show the review page. One sub-account that fails does not lose the others.
 */
async function completeSelection(session, form) {
  const pending = session.pending;
  if (!pending) {
    return { kind: 'html', status: 400, html: pages.errorPage('Nothing to attach', 'Start the connection again from your assistant.') };
  }

  const wanted = [...new Set(asList(form.locationId).filter(Boolean))];
  if (!wanted.length) {
    return { kind: 'html', status: 400, html: pages.errorPage('No sub-accounts chosen', 'Go back and tick at least one sub-account, or use Select all.') };
  }

  const { failed } = await attachChosen(session, pending, wanted);

  if (!session.connected.length) {
    return {
      kind: 'html',
      status: 200,
      html: pages.errorPage(
        'None of those sub-accounts could be connected',
        failed.map((f) => `${f.locationId}: ${f.reason}`).join(' · ') || 'HighLevel refused every one.',
      ),
    };
  }
  return reviewPage(session, { failed });
}

/**
 * Attach the chosen sub-accounts from the CRM currently pending. One that fails does not
 * lose the others — they are reported and the rest stay attached.
 */
async function attachChosen(session, pending, wanted) {
  const attached = [];
  const failed = [];

  for (const locationId of wanted) {
    try {
      const tenant = pending.kind === 'pit'
        ? await attachWithToken(pending, locationId)
        : await attachWithAgencyGrant(pending, locationId);
      attached.push(summariseTenant(tenant));
    } catch (err) {
      failed.push({ locationId, reason: describeCredentialFailure(err) });
    }
  }

  session.connected = [...(session.connected || []), ...attached];
  session.pending = null;
  await saveSession(session);
  return { attached, failed };
}

/** Mint a sub-account-scoped token from an agency grant and store it as a connection. */
async function attachWithAgencyGrant(pending, locationId) {
  const locationGrant = await ghlOAuth.locationToken({
    agencyAccessToken: pending.granted.accessToken,
    companyId: pending.granted.companyId,
    locationId,
  });
  return tenantFromGrant({
    ...locationGrant,
    companyId: pending.granted.companyId,
    // A minted location token carries no refresh token of its own; keep the agency one so
    // the connection can still be renewed later.
    refreshToken: locationGrant.refreshToken || pending.granted.refreshToken,
  }, locationGrant.locationId || locationId, pending.companyName);
}

async function attachWithToken(pending, locationId) {
  const info = await tenants.describeLocation({ token: pending.token, locationId });
  return tenants.create({
    authType: 'pit',
    credential: { token: pending.token },
    locationId,
    displayName: info.name || `Sub-account ${String(locationId).slice(-6)}`,
    companyId: info.companyId,
    companyName: pending.companyName || null,
  });
}

/**
 * POST /oauth/connect/finish — done adding CRMs. This is the only step that hands an
 * authorization code back to the client.
 */
async function finishConnecting(session) {
  const connected = session.connected || [];
  if (!connected.length) {
    return { kind: 'html', status: 400, html: pages.errorPage('Nothing connected yet', 'Sign in with HighLevel and choose at least one sub-account first.') };
  }
  return completeAuthorization(session, connected.map((c) => c.tenantId));
}

/** The between-CRMs screen: what is attached, and the choice to add more or finish. */
function reviewPage(session, { failed = [] } = {}) {
  return {
    kind: 'html',
    html: pages.reviewPage({
      session,
      connected: session.connected || [],
      failed,
    }),
  };
}

function summariseTenant(tenant) {
  return {
    tenantId: tenant.id,
    alias: tenant.alias,
    displayName: tenant.displayName,
    companyName: tenant.companyName || null,
    locationId: tenant.locationId,
  };
}

/** A checklist posts one value per ticked box; a single tick arrives as a bare string. */
function asList(value) {
  if (Array.isArray(value)) return value.map((v) => str(v));
  const single = str(value);
  return single ? [single] : [];
}

async function tenantFromGrant(granted, locationId, companyName) {
  let displayName = null;
  let companyId = granted.companyId || null;
  try {
    const info = await tenants.describeLocation({ token: granted.accessToken, locationId });
    displayName = info.name;
    companyId = companyId || info.companyId;
  } catch (_) {
    // locations.readonly may not have been granted; the location id is enough to work.
  }
  // Which CRM this came from is what tells two identically named businesses apart later, so
  // it is worth asking even when the sign-in was at sub-account level and told us nothing.
  // Best effort: a sub-account token usually cannot read company details.
  let crm = companyName || null;
  if (!crm && companyId) {
    crm = await tenants.describeCompany({ token: granted.accessToken, companyId });
  }
  return tenants.create({
    companyName: crm,
    authType: 'oauth',
    credential: {
      accessToken: granted.accessToken,
      refreshToken: granted.refreshToken,
      expiresAt: granted.expiresAt,
    },
    locationId,
    displayName: displayName || `Sub-account ${String(locationId || '').slice(-6)}`,
    companyId,
    scope: granted.scope,
    userType: granted.userType || 'Location',
  });
}

/** Issue the authorization code and send the person back to the client. */
async function completeAuthorization(session, tenantIds) {
  const code = await tokens.issueCode({
    clientId: session.clientId,
    redirectUri: session.redirectUri,
    codeChallenge: session.codeChallenge,
    codeChallengeMethod: session.codeChallengeMethod,
    tenantIds,
    scope: session.scope,
    resource: session.resource,
  });
  await storage.sessions.delete(session.key);

  const url = new URL(session.redirectUri);
  url.searchParams.set('code', code);
  if (session.state) url.searchParams.set('state', session.state);
  // Lets a client confirm which authorization server answered (mix-up defence).
  url.searchParams.set('iss', config.PUBLIC_URL);
  return { kind: 'redirect', location: url.toString(), tenantIds };
}

function renderConsent(session, client, extra) {
  return {
    kind: 'html',
    status: 200,
    html: pages.consentPage({
      session,
      client,
      oauthAvailable: Boolean(config.GHL_CLIENT_ID && config.GHL_CLIENT_SECRET),
      tokenAllowed: config.ALLOW_TOKEN_CONNECT,
      ...extra,
    }),
  };
}

function describeCredentialFailure(err) {
  if (err && err.status === 401) {
    return 'HighLevel rejected that token (401). Check it was copied whole, and that the Private Integration includes the "locations.readonly" scope. The token is shown only once — if it was lost, create a new integration.';
  }
  if (err && err.status === 403) {
    return 'HighLevel accepted the token but refused the check (403) — a scope is missing from the Private Integration.';
  }
  if (err && err.status === 404) {
    return 'No sub-account has that Location ID. Copy it from HighLevel → Settings → Business Profile.';
  }
  return (err && err.message) || 'The credential could not be verified.';
}

/** Build the error redirect for a failure the client is allowed to see. */
function errorRedirect(err) {
  if (!err.redirect) return null;
  const url = new URL(err.redirect.redirectUri);
  url.searchParams.set('error', err.code);
  url.searchParams.set('error_description', err.description);
  if (err.redirect.state) url.searchParams.set('state', err.redirect.state);
  url.searchParams.set('iss', config.PUBLIC_URL);
  return url.toString();
}

/** Housekeeping hook for the server's timer. A no-op on Redis, where keys carry TTLs. */
function sweep() {
  return storage.sweep();
}

function str(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  beginAuthorization,
  connectWithToken,
  startHighLevelConnect,
  completeHighLevelConnect,
  completeSelection,
  finishConnecting,
  completeAuthorization,
  getSession,
  errorRedirect,
  audienceMatches,
  sweep,
  saveSession,
  AuthorizeError,
};
