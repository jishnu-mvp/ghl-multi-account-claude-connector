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
// Storage selection.
//
// `STORAGE=file|redis|auto` (default auto): auto uses Redis when connection details are
// present, and the local disk otherwise. That way a container with a volume needs no
// configuration, and a Vercel deployment with the Upstash integration installed needs none
// either — the injected environment variables are the signal.
//
// Everything above this module talks to one async interface, so neither the OAuth code nor
// the tenant code knows or cares which is in use.

const config = require('./../config');
const fileBackend = require('./file');
const redisBackend = require('./redis');

let selected = null;

function backend() {
  if (selected) return selected;
  const mode = String(config.STORAGE || 'auto').toLowerCase();

  if (mode === 'redis') {
    if (!redisBackend.available()) {
      throw new Error('STORAGE=redis but no Redis connection details are set. Provide REDIS_REST_URL and REDIS_REST_TOKEN (Vercel\'s Upstash integration injects KV_REST_API_URL / KV_REST_API_TOKEN).');
    }
    selected = redisBackend;
  } else if (mode === 'file') {
    selected = fileBackend;
  } else {
    selected = redisBackend.available() ? redisBackend : fileBackend;
  }
  return selected;
}

/** Test seam: forget the choice and any cached state. */
function reset() {
  if (selected) selected.reset();
  selected = null;
  fileBackend.reset();
}

// A thin façade so callers can hold a stable reference even though the backend is chosen
// lazily (config is read at first use, not at import time).
module.exports = {
  get name() { return backend().name; },
  describe: () => backend().describe(),
  isRedis: () => backend().name === 'redis',

  clients: {
    get: (id) => backend().clients.get(id),
    put: (record) => backend().clients.put(record),
  },
  tenants: {
    get: (id) => backend().tenants.get(id),
    put: (record) => backend().tenants.put(record),
    patch: (id, changes) => backend().tenants.patch(id, changes),
    all: () => backend().tenants.all(),
  },
  codes: {
    put: (digest, record) => backend().codes.put(digest, record),
    take: (digest) => backend().codes.take(digest),
  },
  grants: {
    get: (id) => backend().grants.get(id),
    put: (record) => backend().grants.put(record),
    patch: (id, changes) => backend().grants.patch(id, changes),
    byAccessToken: (hash) => backend().grants.byAccessToken(hash),
    byRefreshToken: (hash) => backend().grants.byRefreshToken(hash),
    byRetiredRefresh: (hash) => backend().grants.byRetiredRefresh(hash),
    byAnyToken: (hash) => backend().grants.byAnyToken(hash),
  },
  sessions: {
    get: (key) => backend().sessions.get(key),
    put: (key, record) => backend().sessions.put(key, record),
    delete: (key) => backend().sessions.delete(key),
  },

  sweep: (now) => backend().sweep(now),

  /** Reachability probe. The file backend is always reachable; Redis is not. */
  async check() {
    const chosen = backend();
    if (chosen.name !== 'redis') return { ok: true, backend: chosen.describe() };
    try {
      const ok = await chosen.ping();
      return { ok, backend: chosen.describe(), ...(ok ? {} : { error: 'PING did not return PONG.' }) };
    } catch (err) {
      return { ok: false, backend: chosen.describe(), error: err.message };
    }
  },

  reset,
};
