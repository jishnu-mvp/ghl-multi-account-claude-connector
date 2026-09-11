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
// Discover-then-execute over the whole API v2 surface, plus the raw escape hatch. This is
// what makes the server a superset of the typed tools above rather than a fixed subset.

const { tool, render, asObject } = require('./kit');
const catalog = require('../catalog');
const safety = require('../safety');

const SAFE_METHODS = ['GET', 'HEAD'];

const tools = [
  tool({
    name: 'ghl_search_operations',
    title: 'Find an API operation',
    noAccount: true,
    description: 'Search the HighLevel API v2 endpoint catalogue by intent ("send message", "invoice", "free slots"). Use when no typed ghl_* tool covers what you need, then call ghl_describe_operation and ghl_request.',
    props: {
      query: { type: 'string', description: 'What you want to do.' },
      domain: { type: 'string', description: `Restrict to one domain: ${catalog.domains().join(', ')}.` },
      method: { type: 'string', description: 'Restrict to an HTTP method.' },
      limit: { type: 'number', description: 'Max results (default 25).' },
    },
    handler: async (args) => {
      const results = catalog.search(args.query, { domain: args.domain, method: args.method, limit: args.limit });
      if (!results.length) {
        return `Nothing matched "${args.query}". Domains available: ${catalog.domains().join(', ')}. The catalogue covers ${catalog.OPERATIONS.length} operations; HighLevel's own explorer at https://marketplace.gohighlevel.com/docs/ is the definitive reference, and ghl_request can call any endpoint whether it is listed here or not.`;
      }
      return [
        `${results.length} matching operation(s):`,
        '',
        ...results.map((op) => `${op.method.padEnd(6)} ${op.path.padEnd(52)} ${op.summary}`),
        '',
        'Next: ghl_describe_operation for the calling details, then ghl_request to run it.',
      ].join('\n');
    },
  }),

  tool({
    name: 'ghl_describe_operation',
    title: 'Describe an API operation',
    noAccount: true,
    description: 'Explain how to call one endpoint: what it does, how the sub-account id has to be supplied, and which scope it needs. Cheaper than guessing a request shape and getting a 422.',
    props: {
      method: { type: 'string', description: 'HTTP method.' },
      path: { type: 'string', description: 'Endpoint path, e.g. /conversations/messages.' },
    },
    required: ['method', 'path'],
    handler: async (args) => {
      const op = catalog.describe(args.method, args.path);
      const api = require('../api');
      const scope = api.scopeHintFor(args.path.replace(/\{[^}]+\}/g, 'x'));
      if (!op) {
        return [
          `${args.method.toUpperCase()} ${args.path} is not in the catalogue, which does not mean it does not exist —`,
          'the catalogue covers the endpoints this repo documents. You can still call it with ghl_request.',
          scope ? `Likely scope: ${scope}` : '',
          'Definitive reference: https://marketplace.gohighlevel.com/docs/',
        ].filter(Boolean).join('\n');
      }
      return [
        `${op.method} ${op.path}`,
        '',
        `What it does : ${op.summary}`,
        `Domain       : ${op.domain}`,
        `Sub-account  : ${catalog.LOC_EXPLANATION[op.loc]}`,
        scope ? `Scope needed : ${scope}` : null,
        '',
        `Call it with : ghl_request { account: "<alias>", method: "${op.method}", path: "${op.path}"${SAFE_METHODS.includes(op.method) ? '' : ', body: {…}, confirm: true'} }`,
        '',
        'Exact field names live in HighLevel\'s explorer (https://marketplace.gohighlevel.com/docs/). Do not invent them.',
      ].filter(Boolean).join('\n');
    },
  }),

  tool({
    name: 'ghl_request',
    title: 'Call any API endpoint',
    kind: 'write',
    description:
      'Call any HighLevel API v2 endpoint directly — the escape hatch for anything the typed tools ' +
      'do not cover. The sub-account id is injected the way that endpoint expects. Reads run ' +
      'straight away; anything that writes needs confirm: true, because an arbitrary write can ' +
      'reach a real customer.',
    props: {
      method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method.' },
      path: { type: 'string', description: 'Path such as /contacts/ or /locations/{locationId}/tags. {locationId} is substituted for you.' },
      query: { type: 'object', description: 'Query parameters. The sub-account id is added automatically when the endpoint needs one and you have not supplied it.' },
      body: { type: 'object', description: 'Request body for writes.' },
      api_version: { type: 'string', description: 'Override the Version header (a few legacy endpoints want 2021-04-15).' },
      no_location: { type: 'boolean', description: 'Skip automatic sub-account id injection entirely.' },
      confirm: { type: 'boolean', description: 'Required for any method other than GET/HEAD.' },
    },
    required: ['method', 'path'],
    handler: async (args, ctx) => {
      const method = args.method.toUpperCase();
      const isRead = SAFE_METHODS.includes(method);
      const op = catalog.describe(method, args.path);

      let path = args.path;
      let query = { ...(asObject(args.query, 'query') || {}) };
      let body = asObject(args.body, 'body');

      if (args.no_location !== true) {
        const loc = op ? op.loc : inferLoc(path);
        const locationId = ['none', 'agency'].includes(loc) ? null : ctx.location();
        if (locationId) {
          if (path.includes('{locationId}')) {
            path = path.replace(/\{locationId\}/g, encodeURIComponent(locationId));
          } else if (loc === 'q' && !query.locationId) {
            query.locationId = locationId;
          } else if (loc === 'q_snake' && !query.location_id) {
            query.location_id = locationId;
          } else if (loc === 'alt' && !query.altId) {
            query.altId = locationId;
            query.altType = query.altType || 'location';
          } else if (loc === 'body' && body && !body.locationId) {
            body = { locationId, ...body };
          } else if (loc === 'body' && !body) {
            body = { locationId };
          }
        }
      }
      // Any remaining placeholder means an id was not filled in — say so rather than sending
      // a request that is guaranteed to 404.
      const leftover = path.match(/\{([^}]+)\}/);
      if (leftover) {
        throw new Error(`The path still contains {${leftover[1]}} — substitute the real id before calling (fetch it with the relevant list tool).`);
      }

      if (!isRead) {
        safety.gate({
          confirm: args.confirm,
          action: `send ${method} ${path} to HighLevel`,
          consequence: op && /SEND|BOOK|PUBLISH|FIRES/.test(op.summary)
            ? `${op.summary} — this reaches a real person.`
            : 'This changes live CRM data. Deletes and sends cannot be undone.',
          request: { method, path, body },
          accountLabel: ctx.label,
        });
      }

      const res = await ctx.call({ method, path, query, body, apiVersion: args.api_version });
      return render({
        ctx,
        request: { method, path },
        data: res.data,
        notes: [
          `HTTP ${res.status}`,
          ...(isRead ? [] : ['Verify by re-reading the record — a 2xx is not proof the field changed.']),
        ],
      });
    },
  }),
];

// Endpoints outside the catalogue: guess the convention from the path family.
function inferLoc(path) {
  if (path.includes('{locationId}')) return 'path';
  if (/^\/(invoices|payments|medias)/.test(path)) return 'alt';
  if (/^\/opportunities\/search/.test(path)) return 'q_snake';
  if (/^\/(contacts|opportunities|conversations)\/[^/]+/.test(path)) return 'none';
  return 'q';
}

module.exports = tools;
