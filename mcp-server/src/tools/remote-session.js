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
// Session tools for the hosted server.
//
// On the hosted server there is nothing to log in to from inside the conversation: the
// OAuth grant that authenticated the request already decided which GoHighLevel account
// this client may touch. So these replace ghl_login/ghl_logout with tools that describe
// the connection instead of creating one.

const config = require('../config');
const safety = require('../safety');
const { tool } = require('./kit');

const tools = [
  tool({
    name: 'ghl_accounts',
    title: 'List sub-accounts',
    noAccount: true,
    description: 'List the GoHighLevel sub-accounts this connection may act on, with the alias to pass as `account`. Call this first: the alias is required by every other tool and there is no default.',
    props: {},
    handler: async (args, ctx) => {
      const all = await ctx.provider.listAll();
      if (!all.length) {
        return [
          'This connection has no GoHighLevel sub-account attached, which should not happen —',
          'the person who added this connector authorised one. Ask them to remove and re-add the',
          'connector so it can be authorised again.',
        ].join('\n');
      }
      // Grouped by CRM: one connection can span two agencies, and two agencies can each
      // have a business of the same name, so the CRM is what disambiguates them.
      const byCrm = new Map();
      for (const account of all) {
        const crm = account.companyName || 'CRM not identified';
        if (!byCrm.has(crm)) byCrm.set(crm, []);
        byCrm.get(crm).push(account);
      }

      const sections = [...byCrm.entries()].map(([crm, accounts]) => [
        `${crm} — ${accounts.length} sub-account(s)`,
        ...accounts.map((a) => `    ${a.alias.padEnd(28)} ${(a.displayName || '').padEnd(32)} ${a.locationId || '—'}`),
      ].join('\n'));

      return [
        `${all.length} sub-account(s) available to this connection, across ${byCrm.size} CRM(s):`,
        '',
        sections.join('\n\n'),
        '',
        all.length === 1
          ? `Pass account: "${all[0].alias}" and refer to it as "${all[0].displayName}" when you report back.`
          : 'Pass the alias as `account`. Ask the user which one they mean — never pick for them, and '
            + 'never assume two similarly named sub-accounts in different CRMs are the same business. '
            + 'Say which you used, by business name, in your reply.',
      ].join('\n');
    },
  }),

  tool({
    name: 'ghl_whoami',
    title: 'Verify the connection',
    description: 'Smoke-test one sub-account: prove the stored credential still works and fetch the sub-account record. Run this first if anything looks wrong. Never reveals the credential.',
    props: {},
    handler: async (args, ctx) => {
      const info = [
        `Account      : ${ctx.label}`,
        `Business     : ${ctx.account.displayName}`,
        `Location id  : ${ctx.locationId || '<not set>'}`,
        `Authorised by: ${ctx.account.source}`,
        `Credential   : ${safety.tokenFingerprint(ctx.token)}`,
        `API base     : ${config.API_BASE_URL} (Version: ${config.API_VERSION})`,
        ctx.account.scope ? `Scopes       : ${ctx.account.scope}` : null,
        ctx.account.expiresAt ? `Token expires: ${new Date(ctx.account.expiresAt).toISOString()} (refreshed automatically)` : null,
      ].filter(Boolean).join('\n');

      if (!ctx.locationId) return `${info}\n\nNo location id on this connection, so there is nothing to probe.`;

      const probe = await ctx.call({ method: 'GET', path: `/locations/${encodeURIComponent(ctx.locationId)}` });
      const location = (probe.data && (probe.data.location || probe.data)) || {};
      return [
        info,
        '',
        `Probe        : GET /locations/${ctx.locationId} → HTTP ${probe.status} OK`,
        `HighLevel says this is: ${location.name || '(unnamed)'}${location.timezone ? ` · ${location.timezone}` : ''}`,
        '',
        'The credential, location and scopes all work.',
      ].join('\n');
    },
  }),

  tool({
    name: 'ghl_connection_info',
    title: 'About this connection',
    noAccount: true,
    description: 'Explain how this connector is authorised, what it will refuse to do without confirmation, and how the person can revoke it. Use when the user asks what this connector can see or how to disconnect.',
    props: {},
    handler: async (args, ctx) => {
      const all = await ctx.provider.listAll();
      const first = all[0];
      return [
        'This is a hosted GoHighLevel connector talking to the HighLevel API v2.',
        '',
        `Authorised for : ${all.map((a) => `${a.displayName} (${a.alias})`).join(', ') || 'nothing yet'}`,
        first ? `Granted via    : ${first.source}` : null,
        first && first.scope ? `Scopes granted : ${first.scope}` : null,
        '',
        'What it will not do without an explicit confirmation from the user, every time:',
        '  · send an SMS, email or any message to a contact',
        '  · book, reschedule or cancel an appointment',
        '  · enrol a contact in a workflow or campaign',
        '  · send or void an invoice',
        '  · delete a contact, opportunity, note or calendar event',
        'Those tools return a dry run of the exact request first. Show it to the user and only',
        'confirm once they have said yes to that specific action.',
        '',
        'It also refuses to act on a sub-account the user has not named, backs records up before',
        'changing them, and never reveals the stored credential.',
        '',
        'To revoke access: uninstall the app in HighLevel (Settings → Integrations), or delete the',
        'Private Integration that was used, and remove the connector in the client that added it.',
      ].filter(Boolean).join('\n');
    },
  }),
];

module.exports = tools;
