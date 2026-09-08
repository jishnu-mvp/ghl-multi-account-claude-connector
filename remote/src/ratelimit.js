'use strict';
// Fixed-window rate limiting, per key, in memory.
//
// Guards the OAuth endpoints against credential stuffing and the MCP endpoint against a
// runaway client burning through the shared HighLevel budget. In-memory means it is
// per-instance; behind several replicas each gets its own window, which is fine for the
// abuse this is meant to blunt.

const buckets = new Map();

function check(key, { max, windowMs }) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: max - bucket.count, retryAfterSeconds: 0 };
}

/** Housekeeping so the map cannot grow without bound. */
function sweep() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function reset() { buckets.clear(); }

module.exports = { check, sweep, reset };
