'use strict';
// Tenants: one per connected GoHighLevel sub-account.
//
// A tenant holds the credential itself (encrypted) plus the harmless labels needed to talk
// about it — business name, location id, how it was authorised. An OAuth grant references
// one or more tenant ids, and that reference is the only thing standing between a request
// and a CRM, so nothing here is ever looked up by anything a client controls.
//
// Where the record lives is the storage layer's business: a JSON file on a container with a
// volume, or Redis on a serverless platform. This module only ever sees the interface.

const storage = require('./storage');
const crypto = require('./crypto');
const ghlOAuth = require('../../mcp-server/src/oauth');
const api = require('../../mcp-server/src/api');
const config = require('./config');

/**
 * Create (or refresh) a tenant for a connected sub-account.
 * @param {object} input
 * @param {'pit'|'oauth'} input.authType
 * @param {object} input.credential   { token } for a PIT, { accessToken, refreshToken, expiresAt } for OAuth
 * @param {string} input.locationId
 * @param {string} input.displayName
 */
async function create({ authType, credential, locationId, displayName, companyId, companyName, scope, userType }) {
  // Always a NEW record, even for a sub-account someone else has already connected. Two
  // people who each authorise the same location must not end up sharing one credential:
  // whoever connected second would otherwise replace the first person's token, so their
  // calls would run under someone else's integration and scopes, and would break the moment
  // that person revoked it. One connection, one credential, one audit trail.
  const id = crypto.randomId('ten');

  return storage.tenants.put({
    id,
    alias: aliasFor(displayName || locationId || 'account'),
    displayName: displayName || locationId || 'account',
    authType,
    locationId: locationId || null,
    companyId: companyId || null,
    // Which CRM this sub-account belongs to. Two agencies can each have a "Bluebird
    // Childcare", so the agency is what makes an alias unambiguous.
    companyName: companyName || null,
    scope: scope || null,
    userType: userType || (authType === 'oauth' ? 'Location' : null),
    // The credential never touches disk in the clear.
    sealed: crypto.sealJson(credential),
    expiresAt: credential.expiresAt || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function get(id) {
  return storage.tenants.get(id);
}

/** Public view — safe to render or hand to a tool. Never includes the credential. */
function publicView(tenant) {
  if (!tenant) return null;
  return {
    alias: tenant.alias,
    displayName: tenant.displayName,
    authType: tenant.authType,
    locationId: tenant.locationId,
    companyId: tenant.companyId,
    companyName: tenant.companyName || null,
    scope: tenant.scope,
    expiresAt: tenant.expiresAt,
    source: tenant.authType === 'oauth'
      ? 'HighLevel sign-in (OAuth), refreshed automatically'
      : 'Private Integration Token',
  };
}

/** A stable, readable handle for a sub-account: the business name, slugified. */
function aliasFor(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'account';
}

/**
 * A credential provider for one grant, matching the interface src/accounts.js exposes so the
 * shared tool layer works unchanged. Scoped to exactly the tenants the grant references —
 * an alias belonging to anyone else simply does not exist here.
 */
function providerFor(tenantIds) {
  const ids = Array.isArray(tenantIds) ? tenantIds : [tenantIds];

  // Names collide across CRMs — two agencies can each run a "Bluebird Childcare" — so
  // aliases are made unique within the grant. Qualify with the CRM first, because
  // "bluebird-childcare-kellix" is something a person can actually say; only fall back to
  // an id fragment when even that is ambiguous.
  const visible = async () => {
    const found = (await Promise.all(ids.map((id) => get(id)))).filter(Boolean);

    const slugCounts = new Map();
    for (const tenant of found) slugCounts.set(tenant.alias, (slugCounts.get(tenant.alias) || 0) + 1);

    const used = new Set();
    return found.map((tenant) => {
      let alias = tenant.alias;
      if (slugCounts.get(tenant.alias) > 1) {
        const crm = tenant.companyName ? aliasFor(tenant.companyName).split('-')[0] : null;
        alias = crm ? `${tenant.alias}-${crm}` : tenant.alias;
      }
      // Still colliding (same business name in the same CRM, or no CRM name known).
      if (used.has(alias)) {
        alias = `${alias}-${String(tenant.locationId || tenant.id).slice(-4).toLowerCase()}`;
      }
      used.add(alias);
      return { ...tenant, alias };
    });
  };

  return {
    async listAll() {
      return (await visible()).map((t) => ({ ...publicView(t), alias: t.alias, ready: true }));
    },

    async credentials(alias) {
      const tenants = await visible();
      if (!alias || !String(alias).trim()) {
        const names = tenants.map((t) => `${t.alias} (${t.displayName})`).join(', ');
        throw new AccountError(
          'No account named. Every call must name the sub-account it targets — there is no default. ' +
          (names ? `Available: ${names}. Ask the user which one they mean.` : 'Call ghl_accounts to see what this connection can reach.')
        );
      }
      const wanted = String(alias).trim().toLowerCase();
      const tenant = tenants.find((t) => t.alias === wanted)
        || tenants.find((t) => t.locationId === alias)
        || tenants.find((t) => (t.displayName || '').toLowerCase() === wanted);
      if (!tenant) {
        const names = tenants.map((t) => `${t.alias} (${t.displayName})`).join(', ');
        throw new AccountError(`Unknown account "${alias}" for this connection. Available: ${names || 'none'}.`);
      }

      const credential = crypto.openJson(tenant.sealed);

      if (tenant.authType === 'pit') {
        return { token: credential.token, locationId: tenant.locationId, account: accountView(tenant) };
      }

      // OAuth: refresh in place when the access token has expired. HighLevel rotates the
      // refresh token on every use, so the new one has to be stored or the connection dies.
      let accessToken = credential.accessToken;
      if (!credential.expiresAt || credential.expiresAt <= Date.now()) {
        if (!credential.refreshToken) {
          throw new AccountError(
            `The HighLevel authorisation for "${tenant.displayName}" has expired and cannot be refreshed. ` +
            'The person who connected it needs to reconnect this connector.'
          );
        }
        if (!config.GHL_CLIENT_ID || !config.GHL_CLIENT_SECRET) {
          throw new AccountError(
            'This server no longer has the HighLevel app credentials it needs to refresh the ' +
            'authorisation. The operator must restore GHL_CLIENT_ID / GHL_CLIENT_SECRET.'
          );
        }
        const fresh = await ghlOAuth.refresh({
          clientId: config.GHL_CLIENT_ID,
          clientSecret: config.GHL_CLIENT_SECRET,
          refreshToken: credential.refreshToken,
          userType: tenant.userType || 'Location',
        });
        accessToken = fresh.accessToken;
        await storage.tenants.patch(tenant.id, {
          sealed: crypto.sealJson({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken || credential.refreshToken,
            expiresAt: fresh.expiresAt,
          }),
          expiresAt: fresh.expiresAt,
          scope: fresh.scope || tenant.scope,
          updatedAt: new Date().toISOString(),
        });
      }

      return { token: accessToken, locationId: tenant.locationId, account: accountView(tenant) };
    },
  };
}

function accountView(tenant) {
  const view = publicView(tenant);
  return { ...view, ready: true };
}

class AccountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccountError';
  }
}

/** Verify a credential against HighLevel and read the business name back. */
async function describeLocation({ token, locationId }) {
  const probe = await api.call({ method: 'GET', path: `/locations/${encodeURIComponent(locationId)}`, token });
  const location = (probe.data && (probe.data.location || probe.data)) || {};
  return {
    name: location.name || null,
    companyId: location.companyId || null,
    timezone: location.timezone || null,
  };
}

/**
 * The agency's own name, for labelling which CRM a sub-account came from. Best effort: a
 * sub-account-scoped token cannot read company details, and the label is cosmetic.
 */
async function describeCompany({ token, companyId }) {
  if (!companyId) return null;
  try {
    const probe = await api.call({ method: 'GET', path: `/companies/${encodeURIComponent(companyId)}`, token });
    const company = (probe.data && (probe.data.company || probe.data)) || {};
    return company.name || null;
  } catch (_) {
    return null;
  }
}

module.exports = { create, get, publicView, providerFor, describeLocation, describeCompany, aliasFor, AccountError };
