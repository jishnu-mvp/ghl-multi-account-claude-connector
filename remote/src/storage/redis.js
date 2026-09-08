'use strict';
// Redis-backed storage over the Upstash REST API.
//
// This is what makes the connector deployable to Vercel and anything else serverless: there
// is no disk to keep, so OAuth grants, connections and in-flight login sessions live in a
// shared store instead. Still zero dependencies — Upstash speaks plain HTTPS, so the existing
// HTTP client is enough.
//
// Two things this backend does better than the file one, rather than merely differently:
//   * expiry is a TTL on the key, so nothing has to be swept;
//   * an authorization code is redeemed with GETDEL, so single use is atomic even when two
//     instances race — which is exactly the situation serverless creates.
//
// Key layout (short prefixes because keys are also index entries):
//   c:<clientId>     OAuth client
//   t:<tenantId>     connection (credential sealed before it gets here)
//   T                set of tenant ids
//   k:<digest>       authorization code            TTL: code lifetime
//   g:<grantId>      grant
//   ga:<hash>        access-token  -> grantId      TTL: refresh lifetime
//   gr:<hash>        refresh-token -> grantId      TTL: refresh lifetime
//   gx:<hash>        retired refresh -> grantId    TTL: refresh lifetime
//   s:<key>          login session                 TTL: session lifetime

const { request } = require('../../../mcp-server/src/http');
const config = require('../config');

// Vercel's Upstash integration has injected several names over the years, and someone
// self-hosting may set their own. Accept them all rather than making people rename things.
function endpoint() {
  const url = process.env.REDIS_REST_URL
    || process.env.KV_REST_API_URL
    || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.REDIS_REST_TOKEN
    || process.env.KV_REST_API_TOKEN
    || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url: url && url.replace(/\/+$/, ''), token };
}

function available() {
  const { url, token } = endpoint();
  return Boolean(url && token);
}

/** Mark an error as "the store is unavailable" rather than "the code is wrong". */
function storageError(message) {
  return Object.assign(new Error(message), { storage: true });
}

/** Run one Redis command. Commands go as a JSON array, which keeps values opaque and safe. */
async function command(args) {
  const { url, token } = endpoint();
  if (!url || !token) {
    throw storageError('Redis storage is selected but no connection details are set. Provide REDIS_REST_URL and REDIS_REST_TOKEN (Vercel\'s Upstash integration injects KV_REST_API_URL / KV_REST_API_TOKEN).');
  }
  let res;
  try {
    res = await request({
      method: 'POST',
      url,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      timeoutMs: config.REDIS_TIMEOUT_MS,
    });
  } catch (err) {
    throw storageError(`Could not reach the Redis store: ${err.message}`);
  }

  let parsed;
  try {
    parsed = res.text ? JSON.parse(res.text) : null;
  } catch (_) {
    throw storageError(`Redis returned a response that is not JSON (HTTP ${res.status}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw storageError('Redis rejected the credentials (HTTP 401/403). Check REDIS_REST_TOKEN.');
  }
  if (parsed && parsed.error) {
    throw storageError(`Redis error on ${args[0]}: ${parsed.error}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw storageError(`Redis returned HTTP ${res.status} on ${args[0]}.`);
  }
  return parsed ? parsed.result : null;
}

async function setJson(key, value, ttlSeconds) {
  const args = ['SET', key, JSON.stringify(value)];
  if (ttlSeconds && ttlSeconds > 0) args.push('EX', String(Math.ceil(ttlSeconds)));
  await command(args);
  return value;
}

async function getJson(key) {
  const raw = await command(['GET', key]);
  if (raw === null || raw === undefined) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

/** Atomic read-and-delete. This is what makes single-use codes safe across instances. */
async function takeJson(key) {
  const raw = await command(['GETDEL', key]);
  if (raw === null || raw === undefined) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

function ttlFromExpiry(expiresAt, fallbackMs) {
  const ms = (expiresAt ? expiresAt - Date.now() : fallbackMs) || fallbackMs;
  // Never write a key that is already dead, and never write one with no ceiling.
  return Math.max(60, Math.ceil(ms / 1000));
}

const REFRESH_TTL_S = () => Math.ceil(config.REFRESH_TOKEN_TTL_MS / 1000);

const backend = {
  name: 'redis',
  describe: () => {
    const { url } = endpoint();
    let host = 'configured';
    try { host = new URL(url).host; } catch (_) { /* keep the placeholder */ }
    return `redis (${host})`;
  },
  available,

  clients: {
    async get(id) { return id ? getJson(`c:${id}`) : null; },
    async put(record) { return setJson(`c:${record.client_id}`, record); },
  },

  tenants: {
    async get(id) { return id ? getJson(`t:${id}`) : null; },
    async put(record) {
      await setJson(`t:${record.id}`, record);
      await command(['SADD', 'T', record.id]);
      return record;
    },
    async patch(id, changes) {
      const current = (await getJson(`t:${id}`)) || {};
      const merged = { ...current, ...changes };
      await setJson(`t:${id}`, merged);
      return merged;
    },
    async all() {
      const ids = (await command(['SMEMBERS', 'T'])) || [];
      if (!ids.length) return [];
      const raw = await command(['MGET', ...ids.map((id) => `t:${id}`)]);
      return (raw || [])
        .map((value) => {
          try { return typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { return null; }
        })
        .filter(Boolean);
    },
  },

  codes: {
    async put(digest, record) {
      return setJson(`k:${digest}`, record, ttlFromExpiry(record.expiresAt, config.AUTH_CODE_TTL_MS));
    },
    async take(digest) { return takeJson(`k:${digest}`); },
  },

  grants: {
    async get(id) { return id ? getJson(`g:${id}`) : null; },

    async put(record) {
      // The grant, then its lookup indexes. Index entries carry the refresh lifetime so a
      // rotated-away token stays recognisable for reuse detection until the grant itself dies.
      await setJson(`g:${record.id}`, record);
      const ttl = REFRESH_TTL_S();
      const writes = [
        ['SET', `ga:${record.accessTokenHash}`, record.id, 'EX', String(ttl)],
        ['SET', `gr:${record.refreshTokenHash}`, record.id, 'EX', String(ttl)],
        ...(record.retiredRefreshHashes || []).map((hash) => ['SET', `gx:${hash}`, record.id, 'EX', String(ttl)]),
      ];
      await pipeline(writes);
      return record;
    },

    async patch(id, changes) {
      const current = (await getJson(`g:${id}`)) || {};
      const merged = { ...current, ...changes };
      await setJson(`g:${id}`, merged);
      if (changes.retiredRefreshHashes) {
        await pipeline(changes.retiredRefreshHashes.map((hash) => ['SET', `gx:${hash}`, id, 'EX', String(REFRESH_TTL_S())]));
      }
      return merged;
    },

    async byAccessToken(hash) { return followIndex(`ga:${hash}`); },
    async byRefreshToken(hash) { return followIndex(`gr:${hash}`); },
    async byRetiredRefresh(hash) { return followIndex(`gx:${hash}`); },
    async byAnyToken(hash) {
      return (await followIndex(`ga:${hash}`)) || followIndex(`gr:${hash}`);
    },
  },

  sessions: {
    async get(key) { return key ? getJson(`s:${key}`) : null; },
    async put(key, record) {
      return setJson(`s:${key}`, record, ttlFromExpiry(record.expiresAt, config.LOGIN_SESSION_TTL_MS));
    },
    async delete(key) {
      await command(['DEL', `s:${key}`]);
      return true;
    },
  },

  /** Nothing to sweep: every perishable key carries a TTL. */
  async sweep() { return 0; },

  reset() { /* nothing cached locally */ },
};

async function followIndex(indexKey) {
  const grantId = await command(['GET', indexKey]);
  if (!grantId) return null;
  return getJson(`g:${grantId}`);
}

async function pipeline(commands) {
  if (!commands.length) return [];
  const { url, token } = endpoint();
  let res;
  try {
    res = await request({
      method: 'POST',
      url: `${url}/pipeline`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      timeoutMs: config.REDIS_TIMEOUT_MS,
    });
  } catch (err) {
    throw storageError(`Could not reach the Redis store: ${err.message}`);
  }
  let parsed;
  try {
    parsed = res.text ? JSON.parse(res.text) : [];
  } catch (_) {
    throw storageError(`Redis pipeline returned a response that is not JSON (HTTP ${res.status}).`);
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = Array.isArray(parsed) ? JSON.stringify(parsed).slice(0, 200) : String(parsed).slice(0, 200);
    throw storageError(`Redis pipeline failed (HTTP ${res.status}): ${detail}`);
  }
  const failed = (Array.isArray(parsed) ? parsed : []).find((entry) => entry && entry.error);
  if (failed) throw storageError(`Redis pipeline error: ${failed.error}`);
  return parsed;
}

/** Prove the store is reachable, for --check and /healthz. */
async function ping() {
  const result = await command(['PING']);
  return result === 'PONG' || result === 'pong' || result === true;
}

module.exports = { ...backend, command, ping, available, endpoint };
