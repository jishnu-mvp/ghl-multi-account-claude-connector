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
// Login and account-management tools. These are the ones that replace .env editing.

const os = require('os');
const config = require('../config');
const store = require('../store');
const accounts = require('../accounts');
const login = require('../login');
const safety = require('../safety');
const { tool } = require('./kit');

// A loopback page is only reachable from the machine the browser runs on. In a remote or
// headless session there is no such browser, so say so instead of handing over a dead link.
function environmentWarning() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return 'This looks like a headless or remote session (no desktop). A 127.0.0.1 login page here is ' +
      'NOT reachable from the user\'s own browser. Run the login on the machine where Claude Code runs ' +
      'locally, or — for a cloud session — set the account\'s token/location environment variables instead ' +
      '(see accounts.conf).';
  }
  return null;
}

const tools = [
  tool({
    name: 'ghl_login',
    title: 'Log in to GoHighLevel',
    noAccount: true,
    description:
      'Start a browser login for a GoHighLevel sub-account and return the link to open. The person ' +
      'signs in on their own machine — either by pasting their Private Integration Token or, if a ' +
      'HighLevel marketplace app is configured, with their HighLevel email and password. No .env file, ' +
      'no environment variables and no restart. Give the user the link, then call ghl_login_status.',
    props: {
      account: {
        type: 'string',
        description: 'Short alias to save this connection under, e.g. "kellixiq". Reuse an existing alias to re-authenticate it.',
      },
      display_name: { type: 'string', description: 'Business name for this sub-account. Detected from HighLevel if omitted.' },
      open_browser: { type: 'boolean', description: 'Try to open the link in the local browser too. Default true.' },
      scopes: {
        type: 'array',
        items: { type: 'string' },
        description: 'OAuth scopes to request (OAuth login only). Defaults to the full read/write set this connector needs.',
      },
    },
    handler: async (args) => {
      const session = await login.start({
        alias: args.account,
        displayName: args.display_name,
        scopes: args.scopes,
      });

      let opened = false;
      if (args.open_browser !== false) opened = await login.openBrowser(session.url);

      const warning = environmentWarning();
      const lines = [
        'Login page ready. Give this link to the user and ask them to open it:',
        '',
        `    ${session.url}`,
        '',
        `It stays open for ${Math.round(config.LOGIN_SERVER.ttlMs / 60000)} minutes and is reachable only from ${os.hostname()} (127.0.0.1).`,
        opened ? 'Already opened in the default browser on this machine.' : 'Could not open a browser automatically — the user should paste the link themselves.',
        '',
        'On that page they can either:',
        '  1. paste a Private Integration Token (HighLevel → Settings → Other Settings →',
        '     Private Integrations) — works immediately, no setup; or',
        '  2. click "Log in with HighLevel" to sign in with their HighLevel email and password,',
        '     if a marketplace app has been configured (the page explains the one-time setup).',
        '',
        'Nothing is typed into this chat, so the credential never enters the transcript.',
        `Saved afterwards to ${config.credentialsFile()} (owner-only).`,
        '',
        'Once they say they are done, call ghl_login_status to confirm before doing any CRM work.',
      ];
      if (warning) lines.unshift(`WARNING: ${warning}`, '');
      return lines.join('\n');
    },
  }),

  tool({
    name: 'ghl_login_status',
    title: 'Check a login',
    noAccount: true,
    description: 'Check whether a browser login finished, waiting a short while for it. Call after ghl_login once the user says they have logged in.',
    props: {
      account: { type: 'string', description: 'The alias passed to ghl_login. Defaults to the most recent login attempt.' },
      wait_seconds: { type: 'number', description: 'How long to wait for a pending login to finish (0-120, default 20).' },
    },
    handler: async (args) => {
      const session = login.findSession({ alias: args.account });
      if (!session) {
        return 'No login has been started in this session. Call ghl_login first.';
      }
      const waitMs = Math.min(Math.max(Number(args.wait_seconds ?? 20), 0), 120) * 1000;
      await login.waitFor(session, waitMs);
      const summary = session.summary();

      if (summary.status === 'complete') {
        const acct = summary.result;
        return [
          'Logged in.',
          '',
          `Account       : ${acct.displayName} (alias "${acct.alias}")`,
          `Location id   : ${acct.locationId || '—'}`,
          `Signed in with: ${acct.authType === 'oauth' ? 'HighLevel login (OAuth), refreshed automatically' : 'Private Integration Token'}`,
          acct.scope ? `Scopes        : ${acct.scope}` : null,
          '',
          `Pass account: "${acct.alias}" to every other ghl_* tool. Say "${acct.displayName}" when reporting back to the user.`,
        ].filter(Boolean).join('\n');
      }
      if (summary.status === 'pending') {
        return [
          `Still waiting. The login page has not been completed yet:`,
          `    ${summary.url}`,
          '',
          'Ask the user to finish on that page, then call this tool again.',
        ].join('\n');
      }
      if (summary.status === 'expired') {
        return 'That login link expired before it was used. Call ghl_login again for a fresh one.';
      }
      return `Login failed: ${summary.error || 'unknown reason'}. Call ghl_login to try again.`;
    },
  }),

  tool({
    name: 'ghl_accounts',
    title: 'List sub-accounts',
    noAccount: true,
    description: 'List every GoHighLevel sub-account this server can reach, with its alias, business name, how it was authenticated and whether it is ready. Use this to know which alias to pass as `account`, and to ask the user which one they mean.',
    props: {},
    handler: async () => {
      const all = accounts.listAll();
      if (!all.length) {
        return [
          'No sub-accounts are connected yet.',
          '',
          'Call ghl_login to connect one — the user logs in in their browser; there is nothing to',
          'configure in the repository.',
        ].join('\n');
      }
      const rows = all.map((a) => [
        a.ready ? '  ready  ' : ' NOT set ',
        a.alias.padEnd(20),
        (a.displayName || '').padEnd(30),
        a.locationId ? String(a.locationId) : '—',
        a.source,
      ].join(' | '));
      const notReady = all.filter((a) => !a.ready);
      return [
        `${all.length} sub-account(s) known to this server:`,
        '',
        ['  status  ', 'alias'.padEnd(20), 'business'.padEnd(30), 'location id', 'authenticated via'].join(' | '),
        rows.join('\n'),
        '',
        notReady.length
          ? `${notReady.length} of them (${notReady.map((a) => a.alias).join(', ')}) are registered in accounts.conf but have no credentials in this environment — run ghl_login for those.`
          : 'All of them are usable right now.',
        '',
        'Never pick one of these on the user\'s behalf. If their request did not name a sub-account, ask which.',
      ].join('\n');
    },
  }),

  tool({
    name: 'ghl_whoami',
    title: 'Verify a connection',
    description: 'Smoke-test one sub-account: prove the credential works, show the resolved configuration, and fetch the sub-account record. Run this first whenever anything looks wrong. Never prints the credential itself.',
    props: {},
    handler: async (args, ctx) => {
      const stored = store.getAccount(ctx.account.alias);
      const info = [
        `Account     : ${ctx.label}`,
        `Business     : ${ctx.account.displayName}`,
        `Location id  : ${ctx.locationId || '<not set>'}`,
        `Auth         : ${ctx.account.source}`,
        `Credential   : ${safety.tokenFingerprint(ctx.token)}`,
        `API base     : ${config.API_BASE_URL}`,
        `API version  : ${config.API_VERSION}`,
        stored && stored.scope ? `Scopes       : ${stored.scope}` : null,
        stored && stored.expiresAt ? `Token expires: ${new Date(stored.expiresAt).toISOString()} (auto-refreshed)` : null,
        ctx.account.companyId ? `Company id   : ${ctx.account.companyId}` : null,
      ].filter(Boolean).join('\n');

      if (!ctx.locationId) {
        return `${info}\n\nNo location id, so there is nothing to probe. Run ghl_login for this account again.`;
      }
      const probe = await ctx.call({ method: 'GET', path: `/locations/${encodeURIComponent(ctx.locationId)}` });
      const location = (probe.data && (probe.data.location || probe.data)) || {};
      store.getAccount(ctx.account.alias) && store.saveAccount({ alias: ctx.account.alias, lastVerifiedAt: new Date().toISOString() });
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
    name: 'ghl_logout',
    title: 'Disconnect a sub-account',
    kind: 'destructive',
    description: 'Forget a sub-account\'s stored credential on this machine. Does not revoke anything inside HighLevel — to do that, delete the Private Integration (or uninstall the app) in HighLevel itself.',
    props: {
      confirm: { type: 'boolean', description: 'Must be true. Ask the user first.' },
    },
    handler: async (args) => {
      const alias = store.normaliseAlias(args.account);
      const stored = store.getAccount(alias);
      if (!stored) {
        return `Nothing stored for "${args.account}" — it may be an accounts.conf/environment account, which this tool cannot remove (unset its environment variables instead).`;
      }
      safety.gate({
        confirm: args.confirm,
        action: `forget the stored credential for "${alias}" (${stored.displayName})`,
        consequence: 'This machine can no longer reach that sub-account until someone logs in again. Nothing is revoked inside HighLevel.',
        request: { method: 'LOCAL', path: config.credentialsFile(), body: { remove: alias } },
        accountLabel: `${stored.displayName} (${alias})`,
      });
      store.deleteAccount(alias);
      return [
        `Removed "${alias}" (${stored.displayName}) from ${config.credentialsFile()}.`,
        '',
        'It is still valid inside HighLevel. To actually revoke access, delete that Private',
        'Integration under Settings → Other Settings → Private Integrations (or uninstall the',
        'marketplace app for an OAuth login).',
      ].join('\n');
    },
  }),

  tool({
    name: 'ghl_login_config',
    title: 'Login configuration',
    noAccount: true,
    description: 'Show how logins are configured on this machine: where credentials are stored, and whether the "log in with HighLevel email and password" (OAuth) flow is available or still needs a one-time marketplace app.',
    props: {},
    handler: async () => {
      const app = store.getOAuthApp();
      return [
        `Credential store : ${config.credentialsFile()} (owner-only, outside the repository)`,
        `Record backups   : ${config.backupDir()}`,
        `API base         : ${config.API_BASE_URL} (Version: ${config.API_VERSION})`,
        `Accounts registry: ${accounts.accountsFile()}`,
        '',
        app
          ? `HighLevel OAuth  : configured (client ${app.clientId.slice(0, 10)}…, from ${app.source}) — the login page offers "Log in with HighLevel".`
          : [
            'HighLevel OAuth  : not configured.',
            '',
            'Signing in with a HighLevel email and password requires a HighLevel marketplace app',
            '(client id + secret). HighLevel has no dynamic client registration, so that app has to',
            'be created once by whoever owns the agency — the login page walks through it, or set',
            'GHL_OAUTH_CLIENT_ID / GHL_OAUTH_CLIENT_SECRET in the environment for everyone at once.',
            '',
            'Until then, the Private Integration Token option on the login page works with no setup.',
          ].join('\n'),
      ].join('\n');
    },
  }),
];

module.exports = tools;
