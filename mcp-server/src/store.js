'use strict';
// Per-user credential store: ~/.ghl-mcp/credentials.json, 0600, outside the repository.
//
// Shape:
// {
//   version: 1,
//   accounts: {
//     "<alias>": {
//       alias, displayName, authType: "pit" | "oauth",
//       locationId, companyId?, userId?, scope?,
//       token?,                          // pit-... (authType "pit")
//       accessToken?, refreshToken?, expiresAt?,   // authType "oauth"
//       createdAt, lastVerifiedAt
//     }
//   },
//   oauthApp?: { clientId, clientSecret }   // only if the user opted into the OAuth flow
// }

const fs = require('fs');
const path = require('path');
const config = require('./config');

const EMPTY = { version: 1, accounts: {} };

function read() {
  const file = config.credentialsFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return clone(EMPTY);
    throw new Error(`Cannot read the credential store at ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `The credential store at ${file} is not valid JSON (${err.message}). ` +
      'Delete the file and log in again to rebuild it.'
    );
  }
  if (!parsed || typeof parsed !== 'object') return clone(EMPTY);
  if (!parsed.accounts || typeof parsed.accounts !== 'object') parsed.accounts = {};
  parsed.version = parsed.version || 1;
  return parsed;
}

function write(data) {
  const file = config.credentialsFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Best effort on Windows, where POSIX modes are advisory.
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* not fatal */ }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* not fatal */ }
  return file;
}

function getAccount(alias) {
  if (!alias) return null;
  const data = read();
  return data.accounts[normaliseAlias(alias)] || null;
}

function listAccounts() {
  const data = read();
  return Object.values(data.accounts);
}

function saveAccount(account) {
  if (!account || !account.alias) throw new Error('saveAccount needs an account with an alias.');
  const data = read();
  const alias = normaliseAlias(account.alias);
  const existing = data.accounts[alias] || {};
  data.accounts[alias] = {
    ...existing,
    ...account,
    alias,
    createdAt: existing.createdAt || account.createdAt || new Date().toISOString(),
  };
  write(data);
  return data.accounts[alias];
}

function deleteAccount(alias) {
  const data = read();
  const key = normaliseAlias(alias);
  if (!data.accounts[key]) return false;
  delete data.accounts[key];
  write(data);
  return true;
}

function getOAuthApp() {
  // Environment variables win, so an organisation can pre-provision its marketplace app
  // for everyone without each person pasting the client secret.
  const envId = process.env.GHL_OAUTH_CLIENT_ID;
  const envSecret = process.env.GHL_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret, source: 'environment' };
  const app = read().oauthApp;
  if (app && app.clientId && app.clientSecret) return { ...app, source: 'stored' };
  return null;
}

function saveOAuthApp({ clientId, clientSecret }) {
  if (!clientId || !clientSecret) throw new Error('An OAuth app needs both a client id and a client secret.');
  const data = read();
  data.oauthApp = { clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim() };
  write(data);
  return { clientId: data.oauthApp.clientId, source: 'stored' };
}

function deleteOAuthApp() {
  const data = read();
  if (!data.oauthApp) return false;
  delete data.oauthApp;
  write(data);
  return true;
}

// Aliases are user-typed; keep them predictable and filesystem/JSON-safe.
function normaliseAlias(alias) {
  return String(alias).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

module.exports = {
  read,
  write,
  getAccount,
  listAccounts,
  saveAccount,
  deleteAccount,
  getOAuthApp,
  saveOAuthApp,
  deleteOAuthApp,
  normaliseAlias,
};
