'use strict';
// Account resolution.
//
// Three places an account can come from, in this order of precedence:
//   1. the browser login store  (~/.ghl-mcp/credentials.json)   — the new, no-setup path
//   2. accounts.conf + environment variables                    — the existing repo setup
//   3. bare GHL_PIT_TOKEN / GHL_LOCATION_ID environment variables
//
// (2) and (3) exist purely so this server is a drop-in for anyone already running the
// connector the old way: their aliases keep working with no migration. Nothing here ever
// picks an account on its own — the caller must name one (CLAUDE.md's first rule).

const fs = require('fs');
const path = require('path');
const store = require('./store');
const oauth = require('./oauth');
const dotenv = require('./dotenv');

function repoRoot() {
  if (process.env.GHL_MCP_REPO_ROOT) return process.env.GHL_MCP_REPO_ROOT;
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  // src/ -> mcp-server/ -> repo root
  return path.resolve(__dirname, '..', '..');
}

function accountsFile() {
  return process.env.GHL_MCP_ACCOUNTS_FILE || path.join(repoRoot(), 'accounts.conf');
}

/** Parse accounts.conf (alias|Display Name|TOKEN_ENV_VAR|LOCATION_ENV_VAR). No secrets in it. */
function readAccountsConf() {
  let text;
  try {
    text = fs.readFileSync(accountsFile(), 'utf8');
  } catch (_) {
    return [];
  }
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('|').map((c) => c.trim()))
    .filter((cols) => cols.length >= 4 && cols[0])
    .map(([alias, displayName, tokenVar, locationVar]) => ({
      alias: alias.toLowerCase(),
      displayName,
      tokenVar,
      locationVar,
    }));
}

/** Read a credential variable: real environment first, then the repo's .env. */
function envVar(name) {
  return dotenv.get(name, repoRoot());
}

/** Every account this server can see, with where it came from and whether it is usable. */
function listAll() {
  const out = new Map();

  for (const row of readAccountsConf()) {
    const token = envVar(row.tokenVar);
    const location = envVar(row.locationVar);
    out.set(row.alias, {
      alias: row.alias,
      displayName: row.displayName || row.alias,
      authType: 'pit',
      source: 'accounts.conf + environment',
      locationId: location || null,
      tokenVar: row.tokenVar,
      locationVar: row.locationVar,
      ready: Boolean(token && location),
    });
  }

  // A bare GHL_PIT_TOKEN with no accounts.conf row is still a working legacy setup.
  if (envVar('GHL_PIT_TOKEN') && ![...out.values()].some((a) => a.tokenVar === 'GHL_PIT_TOKEN')) {
    out.set('default', {
      alias: 'default',
      displayName: 'default (GHL_PIT_TOKEN)',
      authType: 'pit',
      source: 'environment',
      locationId: envVar('GHL_LOCATION_ID') || null,
      tokenVar: 'GHL_PIT_TOKEN',
      locationVar: 'GHL_LOCATION_ID',
      ready: Boolean(envVar('GHL_LOCATION_ID')),
    });
  }

  // Logged-in accounts win: if someone logged in as an alias that also exists in
  // accounts.conf, the credential they just supplied is the one they meant.
  for (const acct of store.listAccounts()) {
    const conf = out.get(acct.alias);
    out.set(acct.alias, {
      alias: acct.alias,
      displayName: acct.displayName || (conf && conf.displayName) || acct.alias,
      authType: acct.authType,
      source: acct.authType === 'oauth' ? 'browser login (OAuth)' : 'browser login (Private Integration Token)',
      locationId: acct.locationId || null,
      companyId: acct.companyId || null,
      scope: acct.scope || null,
      loggedInAt: acct.createdAt || null,
      lastVerifiedAt: acct.lastVerifiedAt || null,
      expiresAt: acct.expiresAt || null,
      ready: true,
    });
  }

  return [...out.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

class AccountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccountError';
  }
}

/** Resolve one alias to a usable account, or explain exactly what is missing. */
function resolve(alias) {
  if (!alias || !String(alias).trim()) {
    throw new AccountError(
      'No account named. Every GoHighLevel call must name the sub-account it targets — ' +
      `there is deliberately no default. ${knownAccountsSentence()}`
    );
  }
  const key = store.normaliseAlias(alias);
  const found = listAll().find((a) => a.alias === key);
  if (!found) {
    throw new AccountError(`Unknown account "${alias}". ${knownAccountsSentence()}`);
  }
  if (!found.ready) {
    throw new AccountError(
      `Account "${found.alias}" (${found.displayName}) is registered in accounts.conf but its ` +
      `credentials are not available: ${found.tokenVar}/${found.locationVar} are set neither in ` +
      'this environment nor in the repo\'s .env. Log in for it instead — call ghl_login with ' +
      `account: "${found.alias}" and open the link it returns.`
    );
  }
  return found;
}

function knownAccountsSentence() {
  const all = listAll();
  if (!all.length) {
    return 'No accounts are set up yet — call ghl_login to log in to a GoHighLevel sub-account in your browser.';
  }
  const ready = all.filter((a) => a.ready).map((a) => `${a.alias} (${a.displayName})`);
  const pending = all.filter((a) => !a.ready).map((a) => `${a.alias} (${a.displayName}, not logged in)`);
  const parts = [];
  if (ready.length) parts.push(`Available: ${ready.join(', ')}.`);
  if (pending.length) parts.push(`Registered but needing a login: ${pending.join(', ')}.`);
  parts.push('Ask the user which one they mean — never guess.');
  return parts.join(' ');
}

/**
 * Get a bearer token for a resolved account, refreshing an expired OAuth token first.
 * @returns {Promise<{token:string, locationId:string|null, account:object}>}
 */
async function credentials(alias) {
  const account = resolve(alias);

  if (account.source.startsWith('browser login')) {
    const stored = store.getAccount(account.alias);
    if (!stored) throw new AccountError(`Account "${account.alias}" vanished from the credential store. Log in again.`);

    if (stored.authType === 'pit') {
      return { token: stored.token, locationId: stored.locationId, account };
    }

    // OAuth: refresh when the access token is at or past its expiry.
    let accessToken = stored.accessToken;
    if (!stored.expiresAt || stored.expiresAt <= Date.now()) {
      const app = store.getOAuthApp();
      if (!app) {
        throw new AccountError(
          `The access token for "${account.alias}" has expired and the marketplace app credentials ` +
          'are no longer configured, so it cannot be refreshed. Log in again with ghl_login.'
        );
      }
      if (!stored.refreshToken) {
        throw new AccountError(`The access token for "${account.alias}" has expired and there is no refresh token. Log in again with ghl_login.`);
      }
      const fresh = await oauth.refresh({
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken: stored.refreshToken,
        userType: stored.userType || 'Location',
      });
      const merged = store.saveAccount({
        ...stored,
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || stored.refreshToken,
        expiresAt: fresh.expiresAt,
        scope: fresh.scope || stored.scope,
      });
      accessToken = merged.accessToken;
    }
    return { token: accessToken, locationId: stored.locationId, account };
  }

  // Legacy environment-variable (or .env) account.
  return {
    token: envVar(account.tokenVar),
    locationId: envVar(account.locationVar) || null,
    account,
  };
}

/** locationId for an account, or a clear error naming what to do about it. */
async function requireLocation(alias) {
  const creds = await credentials(alias);
  if (!creds.locationId) {
    throw new AccountError(
      `Account "${creds.account.alias}" (${creds.account.displayName}) has no sub-account (location) id, ` +
      'and this operation needs one. Log in again with ghl_login so the location is captured, or set it explicitly.'
    );
  }
  return creds;
}

module.exports = {
  repoRoot,
  envVar,
  accountsFile,
  readAccountsConf,
  listAll,
  resolve,
  credentials,
  requireLocation,
  knownAccountsSentence,
  AccountError,
};
