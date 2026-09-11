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
// File-backed storage: a JSON file per collection in DATA_DIR, written atomically, cached in
// memory between writes.
//
// The right default for a single long-lived instance — a VPS, a container with a volume — and
// it needs nothing but a disk. It is the wrong choice for anything serverless or replicated,
// where the disk is neither shared nor persistent; use the Redis backend there.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const cache = new Map();

function file(name) {
  return path.join(config.DATA_DIR, `${name}.json`);
}

function load(name) {
  if (cache.has(name)) return cache.get(name);
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file(name)}: ${err.message}`);
  }
  if (!data || typeof data !== 'object') data = {};
  cache.set(name, data);
  return data;
}

function persist(name) {
  const data = load(name);
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
  const target = file(name);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function get(collection, id) {
  if (!id) return null;
  return load(collection)[id] || null;
}

function put(collection, id, value) {
  load(collection)[id] = value;
  persist(collection);
  return value;
}

function patch(collection, id, changes) {
  const data = load(collection);
  data[id] = { ...(data[id] || {}), ...changes };
  persist(collection);
  return data[id];
}

function remove(collection, id) {
  const data = load(collection);
  if (!(id in data)) return false;
  delete data[id];
  persist(collection);
  return true;
}

function all(collection) {
  return Object.values(load(collection));
}

function find(collection, predicate) {
  return all(collection).find(predicate) || null;
}

/**
 * The backend contract. Everything is async so the two backends are interchangeable, even
 * though this one never actually waits for anything.
 */
const backend = {
  name: 'file',
  describe: () => `file (${config.DATA_DIR})`,

  clients: {
    async get(id) { return get('clients', id); },
    async put(record) { return put('clients', record.client_id, record); },
  },

  tenants: {
    async get(id) { return get('tenants', id); },
    async put(record) { return put('tenants', record.id, record); },
    async patch(id, changes) { return patch('tenants', id, changes); },
    async all() { return all('tenants'); },
  },

  codes: {
    async put(digest, record) { return put('codes', digest, record); },
    /** Single use: read and delete together, so a replay cannot win a race. */
    async take(digest) {
      const record = get('codes', digest);
      if (record) remove('codes', digest);
      return record;
    },
  },

  grants: {
    async get(id) { return get('grants', id); },
    async put(record) { return put('grants', record.id, record); },
    async patch(id, changes) { return patch('grants', id, changes); },
    async byAccessToken(hash) { return find('grants', (g) => g.accessTokenHash === hash); },
    async byRefreshToken(hash) { return find('grants', (g) => g.refreshTokenHash === hash); },
    async byRetiredRefresh(hash) { return find('grants', (g) => (g.retiredRefreshHashes || []).includes(hash)); },
    async byAnyToken(hash) {
      return find('grants', (g) => g.accessTokenHash === hash || g.refreshTokenHash === hash);
    },
  },

  sessions: {
    async get(key) {
      const record = get('sessions', key);
      if (!record) return null;
      if (record.expiresAt && record.expiresAt < Date.now()) {
        remove('sessions', key);
        return null;
      }
      return record;
    },
    async put(key, record) { return put('sessions', key, record); },
    async delete(key) { return remove('sessions', key); },
  },

  /** Drop expired rows. Redis does this with TTLs; here it has to be swept. */
  async sweep(now = Date.now()) {
    let removed = 0;
    for (const collection of ['codes', 'sessions', 'grants']) {
      const data = load(collection);
      let touched = false;
      for (const [id, row] of Object.entries(data)) {
        const dead = row.expiresAt && row.expiresAt < now
          // A grant lives until its refresh token expires too, not just its access token.
          && (collection !== 'grants' || !row.refreshExpiresAt || row.refreshExpiresAt < now);
        if (dead) { delete data[id]; removed += 1; touched = true; }
      }
      if (touched) persist(collection);
    }
    return removed;
  },

  /** Test seam. */
  reset() { cache.clear(); },
};

module.exports = backend;
