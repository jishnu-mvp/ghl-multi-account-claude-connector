'use strict';
// HighLevel OAuth 2.0 (marketplace app) support.
//
// This is the "log in with your HighLevel email and password" path: the person is sent to
// marketplace.gohighlevel.com, authenticates there, picks the sub-account to grant, and is
// redirected back to the loopback login server with an authorization code. We never see
// their password, and the resulting access token is refreshed automatically.
//
// It needs a HighLevel marketplace app (client id + secret) — HighLevel does not support
// dynamic client registration, so there is no way around that one-time registration. The PIT
// login path in login.js needs no app at all, which is why it is the default.

const config = require('./config');
const { request } = require('./http');

const TOKEN_PATH = '/oauth/token';

/** Build the URL the person opens to authenticate with HighLevel. */
function authorizeUrl({ clientId, redirectUri, scopes, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri,
    client_id: clientId,
    scope: (scopes && scopes.length ? scopes : config.OAUTH_DEFAULT_SCOPES).join(' '),
  });
  if (state) params.set('state', state);
  // `chooselocation` is the flow that lets the person pick which sub-account to grant.
  return `${config.MARKETPLACE_BASE_URL}/oauth/chooselocation?${params.toString()}`;
}

async function form(body) {
  const res = await request({
    method: 'POST',
    url: `${config.API_BASE_URL}${TOKEN_PATH}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Version: config.API_VERSION,
    },
    body: new URLSearchParams(body).toString(),
    timeoutMs: config.REQUEST_TIMEOUT_MS,
  });
  let parsed;
  try {
    parsed = res.text ? JSON.parse(res.text) : null;
  } catch (_) {
    parsed = res.text;
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(`HighLevel rejected the token request (HTTP ${res.status}): ${detail}`);
  }
  return parsed;
}

/** Exchange an authorization code for tokens. */
async function exchangeCode({ clientId, clientSecret, code, redirectUri, userType = 'Location' }) {
  const tokens = await form({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    user_type: userType,
    redirect_uri: redirectUri,
  });
  return normaliseTokens(tokens);
}

/** Swap a refresh token for a fresh access token. */
async function refresh({ clientId, clientSecret, refreshToken, userType = 'Location' }) {
  const tokens = await form({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    user_type: userType,
  });
  return normaliseTokens(tokens);
}

/**
 * Agency (Company) token -> sub-account (Location) token.
 * Only reachable with a company-level OAuth token; a sub-account PIT gets 401 here.
 */
async function locationToken({ agencyAccessToken, companyId, locationId }) {
  const res = await request({
    method: 'POST',
    url: `${config.API_BASE_URL}/oauth/locationToken`,
    headers: {
      Authorization: `Bearer ${agencyAccessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Version: config.API_VERSION,
    },
    body: new URLSearchParams({ companyId, locationId }).toString(),
    timeoutMs: config.REQUEST_TIMEOUT_MS,
  });
  let parsed;
  try { parsed = JSON.parse(res.text); } catch (_) { parsed = res.text; }
  if (res.status < 200 || res.status >= 300) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(`Could not mint a location token (HTTP ${res.status}): ${detail}`);
  }
  return normaliseTokens(parsed);
}

/** List the sub-accounts an agency-level app is installed on. */
async function installedLocations({ agencyAccessToken, companyId, appId }) {
  const params = new URLSearchParams({ companyId });
  if (appId) params.set('appId', appId);
  const res = await request({
    method: 'GET',
    url: `${config.API_BASE_URL}/oauth/installedLocations?${params.toString()}`,
    headers: {
      Authorization: `Bearer ${agencyAccessToken}`,
      Accept: 'application/json',
      Version: config.API_VERSION,
    },
    timeoutMs: config.REQUEST_TIMEOUT_MS,
  });
  let parsed;
  try { parsed = JSON.parse(res.text); } catch (_) { parsed = res.text; }
  if (res.status < 200 || res.status >= 300) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(`Could not list installed locations (HTTP ${res.status}): ${detail}`);
  }
  return parsed;
}

function normaliseTokens(tokens) {
  if (!tokens || typeof tokens !== 'object' || !tokens.access_token) {
    throw new Error('HighLevel did not return an access token. Check the app credentials and try again.');
  }
  const expiresIn = Number(tokens.expires_in);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    // Refresh a minute early so a long-running call never dies mid-flight.
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 86399) * 1000 - 60000,
    scope: tokens.scope || '',
    userType: tokens.userType || tokens.user_type || 'Location',
    locationId: tokens.locationId || null,
    companyId: tokens.companyId || null,
    userId: tokens.userId || null,
  };
}

module.exports = {
  authorizeUrl,
  exchangeCode,
  refresh,
  locationToken,
  installedLocations,
  normaliseTokens,
};
