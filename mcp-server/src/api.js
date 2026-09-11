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
// HighLevel API v2 client.
//
// Enforces the three mandatory headers (a missing `Version` is the classic mystery 4xx),
// keeps inside the documented rate-limit budget, and surfaces HighLevel's error body
// verbatim — that body is what names a missing scope.

const config = require('./config');
const { request } = require('./http');

// --- rate limiting ----------------------------------------------------------------
// Sliding window over the last RATE_LIMIT.windowMs. Shared across every account because
// the burst budget is per app, and this process is the app.
const recentRequests = [];

async function throttle() {
  for (;;) {
    const now = Date.now();
    while (recentRequests.length && now - recentRequests[0] > config.RATE_LIMIT.windowMs) {
      recentRequests.shift();
    }
    if (recentRequests.length < config.RATE_LIMIT.maxRequests) {
      recentRequests.push(now);
      return;
    }
    const waitMs = config.RATE_LIMIT.windowMs - (now - recentRequests[0]) + 25;
    await sleep(waitMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error carrying the HighLevel response so callers can render it faithfully. */
class ApiError extends Error {
  constructor(message, { status, body, method, path, scopeHint }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = path;
    this.scopeHint = scopeHint;
  }
}

/**
 * Call the HighLevel API v2.
 *
 * @param {object} opts
 * @param {string} opts.method            HTTP verb.
 * @param {string} opts.path              Path (`/contacts/`) or absolute URL.
 * @param {object} [opts.query]           Query parameters; undefined/null values are dropped.
 * @param {object|string} [opts.body]     Request body (objects are JSON-encoded).
 * @param {string} opts.token             Bearer token (PIT or OAuth access token).
 * @param {string} [opts.apiVersion]      Override the Version header (a few legacy endpoints
 *                                        want 2021-04-15).
 * @param {boolean} [opts.retryOn429=true]
 */
async function call({ method = 'GET', path, query, body, token, apiVersion, retryOn429 = true }) {
  if (!token) throw new Error('No access token — log in first with ghl_login.');
  const url = buildUrl(path, query);

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: apiVersion || config.API_VERSION,
    Accept: 'application/json',
  };

  let payload;
  if (body !== undefined && body !== null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    await throttle();
    const res = await request({
      method,
      url,
      headers,
      body: payload,
      timeoutMs: config.REQUEST_TIMEOUT_MS,
    });

    // 429: back off once, honouring Retry-After. Never retry-hammer.
    if (res.status === 429 && retryOn429 && attempt === 1) {
      const retryAfter = Number(res.headers['retry-after']);
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10000);
      continue;
    }

    const parsed = parseBody(res.text);

    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, data: parsed, raw: res.text };
    }

    throw new ApiError(describeFailure(res.status, method, url, parsed), {
      status: res.status,
      body: parsed,
      method,
      path: url,
      scopeHint: res.status === 401 || res.status === 403 ? scopeHintFor(path) : undefined,
    });
  }
}

function buildUrl(path, query) {
  const base = /^https?:\/\//i.test(path)
    ? path
    : `${config.API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  const [withoutHash] = base.split('#');
  const params = [];
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v === undefined || v === null || v === '') continue;
          params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
        }
      } else {
        params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }
  }
  if (!params.length) return withoutHash;
  return `${withoutHash}${withoutHash.includes('?') ? '&' : '?'}${params.join('&')}`;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function describeFailure(status, method, url, parsed) {
  const detail = typeof parsed === 'string'
    ? parsed.slice(0, 500)
    : JSON.stringify(parsed);
  const redactedUrl = url.replace(/([?&])(access_token|token)=[^&]*/gi, '$1$2=<redacted>');
  return `HighLevel returned HTTP ${status} for ${method} ${redactedUrl}: ${detail}`;
}

// A 401/403 almost always means a scope was never ticked on the Private Integration. Point at
// the likely one rather than making the user hunt; the mapping mirrors SKILL.md's scope table.
const SCOPE_HINTS = [
  [/^\/contacts\/[^/]+\/(notes|tasks)/, 'contacts.readonly / contacts.write'],
  [/^\/contacts/, 'contacts.readonly / contacts.write'],
  [/^\/conversations\/messages/, 'conversations/message.readonly / conversations/message.write'],
  [/^\/conversations/, 'conversations.readonly / conversations.write'],
  [/^\/opportunities/, 'opportunities.readonly / opportunities.write'],
  [/^\/calendars\/events/, 'calendars/events.readonly / calendars/events.write'],
  [/^\/calendars/, 'calendars.readonly / calendars.write'],
  [/^\/locations\/[^/]+\/customFields/, 'locations/customFields.readonly / .write'],
  [/^\/locations\/[^/]+\/customValues/, 'locations/customValues.readonly / .write'],
  [/^\/locations\/[^/]+\/tags/, 'locations/tags.readonly / .write'],
  [/^\/locations\/search/, 'an AGENCY-level token (a sub-account PIT cannot list sub-accounts)'],
  [/^\/locations/, 'locations.readonly'],
  [/^\/users/, 'users.readonly / users.write'],
  [/^\/workflows/, 'workflows.readonly'],
  [/^\/campaigns/, 'campaigns.readonly'],
  [/^\/forms/, 'forms.readonly'],
  [/^\/surveys/, 'surveys.readonly'],
  [/^\/products/, 'products.readonly / products.write (prices: products/prices.*)'],
  [/^\/invoices/, 'invoices.readonly / invoices.write'],
  [/^\/payments/, 'payments/orders.readonly / payments/transactions.readonly / payments/subscriptions.readonly'],
  [/^\/medias/, 'medias.readonly / medias.write'],
  [/^\/links/, 'links.readonly / links.write'],
  [/^\/businesses/, 'businesses.readonly / businesses.write'],
  [/^\/blogs/, 'blogs/post.readonly / blogs/post.write'],
  [/^\/funnels/, 'funnels/funnel.readonly'],
  [/^\/social-media-posting/, 'socialplanner/post.readonly / .write'],
  [/^\/emails/, 'emails/builder.readonly / .write'],
  [/^\/custom-menus/, 'locations/customFields.readonly (custom menus ride the locations scopes)'],
  [/^\/(snapshots|saas-api|oauth)/, 'an AGENCY-level token or an OAuth marketplace app — not available to a sub-account PIT'],
];

function scopeHintFor(path) {
  const p = /^https?:\/\//i.test(path) ? new URL(path).pathname : path;
  const match = SCOPE_HINTS.find(([re]) => re.test(p));
  return match ? match[1] : undefined;
}

module.exports = { call, ApiError, buildUrl, scopeHintFor, sleep };
