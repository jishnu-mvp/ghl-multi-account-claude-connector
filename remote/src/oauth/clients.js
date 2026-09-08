'use strict';
// OAuth 2.0 Dynamic Client Registration (RFC 7591).
//
// This is how an MCP client gets a client_id with no human in the loop, which is what makes
// "paste a URL into Claude and it just connects" possible. Registration is open by design,
// so the security has to live elsewhere: PKCE on every exchange, strict redirect-URI
// matching, and a consent screen naming the specific client before any CRM access is
// granted (the confused-deputy mitigation the MCP spec requires of proxying servers).

const storage = require('../storage');
const crypto = require('../crypto');
const config = require('../config');

const SUPPORTED_GRANTS = ['authorization_code', 'refresh_token'];
const SUPPORTED_RESPONSE_TYPES = ['code'];

class RegistrationError extends Error {
  constructor(code, description) {
    super(description);
    this.name = 'RegistrationError';
    this.code = code; // invalid_redirect_uri | invalid_client_metadata
    this.description = description;
  }
}

/** A redirect URI must be absolute, fragment-free, and HTTPS unless it is loopback. */
function validateRedirectUri(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new RegistrationError('invalid_redirect_uri', `"${raw}" is not an absolute URI.`);
  }
  if (url.hash) {
    throw new RegistrationError('invalid_redirect_uri', 'A redirect URI must not contain a fragment.');
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  // Custom schemes are legitimate for native clients (cursor://, vscode://), so allow them.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return raw;
  if (url.protocol === 'http:' && !isLoopback) {
    throw new RegistrationError('invalid_redirect_uri', 'A redirect URI must use HTTPS unless it is a loopback address.');
  }
  if (config.ALLOWED_REDIRECT_HOSTS.length) {
    const host = url.hostname.toLowerCase();
    const permitted = isLoopback
      || config.ALLOWED_REDIRECT_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    if (!permitted) {
      throw new RegistrationError('invalid_redirect_uri', `Redirect host "${url.hostname}" is not on this server's allow-list.`);
    }
  }
  return raw;
}

/**
 * Register a client.
 * @param {object} metadata  the RFC 7591 client metadata document
 * @returns {object}         the registered client, as the response document
 */
async function register(metadata) {
  if (!config.ALLOW_DYNAMIC_REGISTRATION) {
    throw new RegistrationError('invalid_client_metadata', 'Dynamic client registration is disabled on this server. The operator must pre-register your client.');
  }
  if (!metadata || typeof metadata !== 'object') {
    throw new RegistrationError('invalid_client_metadata', 'The request body must be a JSON object.');
  }

  const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  if (!redirectUris.length) {
    throw new RegistrationError('invalid_redirect_uri', 'At least one redirect_uris entry is required.');
  }
  if (redirectUris.length > 10) {
    throw new RegistrationError('invalid_redirect_uri', 'At most 10 redirect URIs may be registered.');
  }
  redirectUris.forEach(validateRedirectUri);

  const grantTypes = (metadata.grant_types && metadata.grant_types.length ? metadata.grant_types : ['authorization_code', 'refresh_token'])
    .filter((g) => SUPPORTED_GRANTS.includes(g));
  if (!grantTypes.includes('authorization_code')) {
    throw new RegistrationError('invalid_client_metadata', `Only these grant types are supported: ${SUPPORTED_GRANTS.join(', ')}.`);
  }

  const responseTypes = (metadata.response_types && metadata.response_types.length ? metadata.response_types : ['code'])
    .filter((r) => SUPPORTED_RESPONSE_TYPES.includes(r));
  if (!responseTypes.length) {
    throw new RegistrationError('invalid_client_metadata', 'Only the "code" response type is supported.');
  }

  // Public clients only: an MCP client is a desktop app or a service acting for a user, and
  // PKCE — not a client secret — is what protects the exchange. Refusing to mint secrets
  // means there is no long-lived shared secret to leak.
  const authMethod = metadata.token_endpoint_auth_method || 'none';
  if (authMethod !== 'none') {
    throw new RegistrationError('invalid_client_metadata', 'This server registers public clients only; use token_endpoint_auth_method "none" with PKCE.');
  }

  const clientId = crypto.randomId('client', 16);
  const record = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: cleanString(metadata.client_name) || 'Unnamed MCP client',
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: 'none',
    scope: cleanString(metadata.scope) || 'ghl:read ghl:write',
    client_uri: cleanString(metadata.client_uri) || null,
    logo_uri: cleanString(metadata.logo_uri) || null,
    software_id: cleanString(metadata.software_id) || null,
    software_version: cleanString(metadata.software_version) || null,
  };
  await storage.clients.put(record);
  return record;
}

function get(clientId) {
  return storage.clients.get(clientId);
}

/** Exact match, as the spec requires — no prefix or wildcard matching. */
function redirectUriAllowed(client, redirectUri) {
  if (!client || !redirectUri) return false;
  return client.redirect_uris.some((uri) => crypto.timingSafeEqual(uri, redirectUri));
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) return null;
  // Registration metadata is written by whoever calls /register and ends up on the consent
  // screen, so strip control characters before it is ever rendered.
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, '');
}

module.exports = { register, get, redirectUriAllowed, validateRedirectUri, RegistrationError, SUPPORTED_GRANTS };
