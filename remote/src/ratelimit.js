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
