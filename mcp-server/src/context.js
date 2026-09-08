'use strict';
// Per-request credential context.
//
// The same ~100 tools serve two very different deployments:
//
//   * the local stdio server — one person, credentials from ~/.ghl-mcp or .env
//   * the hosted remote server — many people at once, credentials belonging to
//     whichever OAuth token authenticated the HTTP request
//
// AsyncLocalStorage keeps the second case honest: each request runs inside its own
// store, so a tool can only ever see the credentials of the tenant that asked. There is
// no ambient "current account" a concurrent request could read by accident.
//
// A provider implements the same shape as src/accounts.js:
//   credentials(alias) -> Promise<{ token, locationId, account }>
//   listAll()          -> [{ alias, displayName, ... }]

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** Run fn with this credential provider bound to the async context. */
function runWith(provider, fn) {
  return storage.run({ provider }, fn);
}

/** The provider for the request in flight, or null when running locally. */
function current() {
  const store = storage.getStore();
  return store ? store.provider : null;
}

module.exports = { runWith, current };
