'use strict';
// Discovery documents. These are what let a client connect knowing nothing but the URL:
// it hits /mcp, gets a 401 pointing at the protected-resource document, follows that to the
// authorization server metadata, registers itself, and starts the flow.
//
//   RFC 9728  OAuth 2.0 Protected Resource Metadata  -> /.well-known/oauth-protected-resource
//   RFC 8414  OAuth 2.0 Authorization Server Metadata -> /.well-known/oauth-authorization-server

const config = require('../config');

const SCOPES = ['ghl:read', 'ghl:write'];

/** RFC 9728 — what this resource is and who authorizes access to it. */
function protectedResource() {
  return {
    resource: config.RESOURCE,
    authorization_servers: [config.PUBLIC_URL],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: config.BRAND.name,
    resource_documentation: `${config.PUBLIC_URL}/`,
  };
}

/** RFC 8414 — the endpoints and capabilities of this authorization server. */
function authorizationServer() {
  return {
    issuer: config.PUBLIC_URL,
    authorization_endpoint: `${config.PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${config.PUBLIC_URL}/oauth/token`,
    registration_endpoint: `${config.PUBLIC_URL}/oauth/register`,
    revocation_endpoint: `${config.PUBLIC_URL}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Public clients with PKCE only. No client secrets exist to be stolen.
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: SCOPES,
    // RFC 8707. Advertised so clients know the audience binding is real.
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
    service_documentation: `${config.PUBLIC_URL}/`,
    ...(config.BRAND.privacyUrl ? { op_policy_uri: config.BRAND.privacyUrl } : {}),
    ...(config.BRAND.termsUrl ? { op_tos_uri: config.BRAND.termsUrl } : {}),
  };
}

/**
 * The 401 challenge that starts discovery (RFC 9728 §5.1). Without this header a client has
 * no way to find the authorization server, and the connection just fails.
 */
function wwwAuthenticate({ error = 'invalid_token', description } = {}) {
  const parts = [
    `Bearer resource_metadata="${config.PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    `error="${error}"`,
  ];
  if (description) parts.push(`error_description="${String(description).replace(/"/g, "'")}"`);
  return parts.join(', ');
}

module.exports = { protectedResource, authorizationServer, wwwAuthenticate, SCOPES };
