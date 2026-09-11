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
// Shared plumbing for tool definitions, so each tool below is a few readable lines.

const accounts = require('../accounts');
const api = require('../api');
const safety = require('../safety');
const context = require('../context');

// Where credentials come from: the request's own provider when one is bound (the hosted
// server binds one per authenticated tenant), otherwise this machine's local accounts.
function provider() {
  return context.current() || accounts;
}

// Every data tool takes this. There is deliberately no default: acting on the wrong client's
// CRM is the mistake this connector exists to prevent, so the caller must always name one.
const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which sub-account to act on (alias from ghl_accounts). Required — there is no default. If the user has not named an account, ask them; never guess.',
  },
};

/**
 * Define a tool.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {object} [spec.props]         Extra JSON Schema properties (beyond `account`).
 * @param {string[]} [spec.required]    Extra required argument names.
 * @param {boolean} [spec.noAccount]    Omit the `account` argument (login/admin tools).
 * @param {'read'|'write'|'destructive'|'outbound'} [spec.kind]
 * @param {(args:object, ctx:object)=>Promise<any>} spec.handler
 */
function tool(spec) {
  const props = { ...(spec.noAccount ? {} : ACCOUNT_PROP), ...(spec.props || {}) };
  const required = [...(spec.noAccount ? [] : ['account']), ...(spec.required || [])];
  const isRead = !spec.kind || spec.kind === 'read';

  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: props,
      required,
      additionalProperties: false,
    },
    annotations: {
      title: spec.title || spec.name,
      readOnlyHint: isRead,
      destructiveHint: spec.kind === 'destructive',
      idempotentHint: Boolean(spec.idempotent),
      openWorldHint: true,
    },
    handler: async (args) => {
      if (spec.noAccount) return spec.handler(args, { provider: provider() });
      const creds = await provider().credentials(args.account);
      const ctx = {
        ...creds,
        label: `${creds.account.displayName} (${creds.account.alias})`,
        // Most endpoints need the location id one way or another.
        location: () => {
          if (!creds.locationId) {
            throw new accounts.AccountError(
              `Account "${creds.account.alias}" has no sub-account (location) id and this call needs one. ` +
              'Run ghl_login again for it so the location is captured.'
            );
          }
          return creds.locationId;
        },
        call: (opts) => api.call({ ...opts, token: creds.token }),
      };
      return spec.handler(args, ctx);
    },
  };
}

/**
 * Render a successful call. Always names the account in the output so the assistant relays
 * which client it just touched.
 */
function render({ ctx, request, data, notes = [] }) {
  const head = [
    `Account : ${ctx.label}${ctx.locationId ? ` · location ${ctx.locationId}` : ''}`,
    request ? `Request : ${request.method} ${request.path}` : null,
    ...notes.map((n) => `Note    : ${n}`),
  ].filter(Boolean).join('\n');
  const body = data === undefined || data === null || data === ''
    ? '(empty response body — HighLevel returned no content)'
    : safety.redact(data);
  return `${head}\n\n${body}`;
}

/** GET helper: call, then render. */
async function get(ctx, path, query, notes) {
  const res = await ctx.call({ method: 'GET', path, query });
  return render({ ctx, request: { method: 'GET', path: api.buildUrl(path, query).replace(/^https?:\/\/[^/]+/, '') }, data: res.data, notes });
}

/** Write helper: call, then render. */
async function send(ctx, method, path, { query, body, notes } = {}) {
  const res = await ctx.call({ method, path, query, body });
  return render({ ctx, request: { method, path }, data: res.data, notes });
}

/** Read a record so a write is never blind, and keep a copy on disk first. */
async function readAndBackup(ctx, { kind, id, path }) {
  const current = await ctx.call({ method: 'GET', path });
  const file = safety.backup({ alias: ctx.account.alias, kind, id, data: current.data });
  return { current: current.data, backupFile: file };
}

/** Accept either a JSON object or a JSON string, the way the shell helpers accept both. */
function asObject(value, argName) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
      throw new Error('not an object');
    } catch (err) {
      throw new Error(`"${argName}" must be a JSON object (or a string containing one): ${err.message}`);
    }
  }
  throw new Error(`"${argName}" must be a JSON object.`);
}

/** "a, b" or ["a","b"] -> ["a","b"] */
function asTags(value, argName = 'tags') {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((t) => t.trim()).filter(Boolean);
  throw new Error(`"${argName}" must be an array of tags or a comma-separated string.`);
}

module.exports = {
  provider,
  tool,
  render,
  get,
  send,
  readAndBackup,
  asObject,
  asTags,
  ACCOUNT_PROP,
};
