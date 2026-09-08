'use strict';
// Authorization codes and access/refresh tokens.
//
// Only digests are stored, so the data file cannot be replayed. Access tokens are short
// lived and bound to this server's canonical URI as their audience; refresh tokens rotate on
// every use, and a replayed one revokes the whole grant — the OAuth 2.1 requirement for
// public clients, and the thing that makes a stolen refresh token detectable rather than
// silently useful for a month.

const storage = require('../storage');
const crypto = require('../crypto');
const config = require('../config');

// --- authorization codes -------------------------------------------------------------

async function issueCode({ clientId, redirectUri, codeChallenge, codeChallengeMethod, tenantIds, scope, resource }) {
  const code = crypto.randomToken(32);
  await storage.codes.put(crypto.digest(code), {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: codeChallengeMethod || 'S256',
    tenantIds,
    scope,
    resource: resource || null,
    expiresAt: Date.now() + config.AUTH_CODE_TTL_MS,
    createdAt: Date.now(),
  });
  return code;
}

/**
 * Redeem a code. Single use: it is deleted before anything else is checked, so a replayed
 * code always fails even if two requests race.
 */
async function redeemCode({ code, clientId, redirectUri, codeVerifier }) {
  // Read and delete in one step. On Redis that is a GETDEL, so two instances racing on the
  // same code cannot both win — which is the whole point of single use.
  const record = await storage.codes.take(crypto.digest(code || ''));
  if (!record) throw new TokenError('invalid_grant', 'That authorization code is unknown, already used, or expired.');

  if (record.expiresAt < Date.now()) {
    throw new TokenError('invalid_grant', 'That authorization code has expired. Start the connection again.');
  }
  if (record.clientId !== clientId) {
    throw new TokenError('invalid_grant', 'That authorization code was issued to a different client.');
  }
  if (!crypto.timingSafeEqual(record.redirectUri, redirectUri || '')) {
    throw new TokenError('invalid_grant', 'redirect_uri does not match the one used to obtain the code.');
  }
  if (!crypto.verifyPkce(codeVerifier, record.codeChallenge, record.codeChallengeMethod)) {
    throw new TokenError('invalid_grant', 'PKCE verification failed.');
  }
  return record;
}

// --- grants (access + refresh) --------------------------------------------------------

/** Issue a fresh access/refresh pair, creating the grant if this is the first one. */
async function issueTokens({ clientId, tenantIds, scope, resource, grantId }) {
  const accessToken = crypto.randomToken(32);
  const refreshToken = crypto.randomToken(32);
  const now = Date.now();
  const id = grantId || crypto.randomId('grant');
  const existing = grantId ? await storage.grants.get(grantId) : null;

  await storage.grants.put({
    id,
    clientId,
    tenantIds,
    scope,
    // RFC 8707: the audience this token may be presented to, and nowhere else.
    audience: config.RESOURCE,
    resource: resource || config.RESOURCE,
    accessTokenHash: crypto.digest(accessToken),
    refreshTokenHash: crypto.digest(refreshToken),
    retiredRefreshHashes: existing ? existing.retiredRefreshHashes || [] : [],
    expiresAt: now + config.ACCESS_TOKEN_TTL_MS,
    refreshExpiresAt: now + config.REFRESH_TOKEN_TTL_MS,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    revoked: false,
  });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(config.ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope,
  };
}

/**
 * Rotate on refresh. A refresh token that has already been rotated away is treated as
 * theft: the grant is revoked rather than re-issued.
 */
async function refreshTokens({ refreshToken, clientId }) {
  const hash = crypto.digest(refreshToken || '');
  const found = await storage.grants.byRefreshToken(hash);
  // A lookup index can outlive the value it pointed at, so never trust it on its own:
  // the grant has to still name this exact token as its current refresh token.
  const grant = found && found.refreshTokenHash === hash ? found : null;

  if (!grant) {
    const reused = (found && found.refreshTokenHash !== hash ? found : null)
      || await storage.grants.byRetiredRefresh(hash);
    if (reused) {
      await storage.grants.patch(reused.id, { revoked: true, revokedReason: 'refresh_token_reuse', updatedAt: Date.now() });
      throw new TokenError('invalid_grant', 'That refresh token has already been used. The connection has been revoked as a precaution — reconnect to continue.');
    }
    throw new TokenError('invalid_grant', 'That refresh token is unknown or expired.');
  }
  if (grant.revoked) throw new TokenError('invalid_grant', 'This connection has been revoked. Reconnect to continue.');
  if (grant.clientId !== clientId) throw new TokenError('invalid_grant', 'That refresh token belongs to a different client.');
  if (grant.refreshExpiresAt && grant.refreshExpiresAt < Date.now()) {
    throw new TokenError('invalid_grant', 'That refresh token has expired. Reconnect to continue.');
  }

  const retired = [...(grant.retiredRefreshHashes || []), grant.refreshTokenHash].slice(-10);
  const issued = await issueTokens({
    clientId: grant.clientId,
    tenantIds: grant.tenantIds,
    scope: grant.scope,
    resource: grant.resource,
    grantId: grant.id,
  });
  await storage.grants.patch(grant.id, { retiredRefreshHashes: retired });
  return issued;
}

/**
 * Validate a bearer token presented at the MCP endpoint.
 * @returns {{grant: object}}
 * @throws {TokenError} carrying an HTTP status for the transport layer
 */
async function verifyAccessToken(bearer) {
  if (!bearer) throw new TokenError('invalid_token', 'No access token was presented.', 401);
  const hash = crypto.digest(bearer);
  const found = await storage.grants.byAccessToken(hash);
  // As above: the index is a hint, the grant is the truth. A rotated-away access token must
  // not authenticate just because its index entry has not expired yet.
  const grant = found && found.accessTokenHash === hash ? found : null;
  if (!grant) throw new TokenError('invalid_token', 'The access token is unknown.', 401);
  if (grant.revoked) throw new TokenError('invalid_token', 'This connection has been revoked.', 401);
  if (grant.expiresAt < Date.now()) throw new TokenError('invalid_token', 'The access token has expired.', 401);
  // Audience check: a token minted for a different resource must never work here, even when
  // this same server issued it (MCP spec: token audience binding).
  if (grant.audience && grant.audience !== config.RESOURCE) {
    throw new TokenError('invalid_token', 'The access token was not issued for this resource.', 401);
  }
  return { grant };
}

async function revokeToken(token) {
  const hash = crypto.digest(token || '');
  const grant = await storage.grants.byAnyToken(hash);
  if (!grant) return false;
  await storage.grants.patch(grant.id, { revoked: true, revokedReason: 'client_request', updatedAt: Date.now() });
  return true;
}

class TokenError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.name = 'TokenError';
    this.code = code;
    this.description = description;
    this.status = status;
  }
}

module.exports = { issueCode, redeemCode, issueTokens, refreshTokens, verifyAccessToken, revokeToken, TokenError };
