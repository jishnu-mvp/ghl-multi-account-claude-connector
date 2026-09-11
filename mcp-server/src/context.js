/*
 * GHL Multi-Account Claude Connector
 * Copyright (c) 2026 Jishnu Venugopal. All Rights Reserved.
 *
 * Proprietary software. You may use this software as-is for your own
 * GoHighLevel account(s). You may NOT copy, redistribute, or use this
 * code (or any part of it) to build a new or competing product without
 * the owner's prior written permission. See LICENSE and NOTICE at the
 * repository root for full terms. This notice must not be removed.
 * Contact: jishhnnuu@gmail.com
 */

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
