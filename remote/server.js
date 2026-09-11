#!/usr/bin/env node
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
// Hosted GoHighLevel MCP server — entry point.
//
//   node server.js           serve
//   node server.js --check   validate the configuration and exit (use in CI or a healthcheck)
//
// No dependencies, no build step. Put it behind TLS (a platform router, or a reverse proxy)
// and set PUBLIC_URL to the URL clients will actually type.

const http = require('http');
const config = require('./src/config');
const { createApp, startHousekeeping, buildMcpServer } = require('./src/app');
const transport = require('./src/transport');

async function report() {
  const { errors, warnings } = config.audit();
  const mcp = buildMcpServer();
  const storage = require('./src/storage');

  // Probe the store rather than just naming it: "configured" and "reachable" are different
  // problems and the fix for each is different.
  let store = storage.describe();
  try {
    const health = await storage.check();
    store = health.ok ? `${health.backend} — reachable` : `${health.backend} — NOT REACHABLE: ${health.error}`;
    if (!health.ok) errors.push(`The ${storage.name} store could not be reached: ${health.error}`);
  } catch (err) {
    store = `${storage.describe()} — NOT REACHABLE: ${err.message}`;
    errors.push(`The store could not be reached: ${err.message}`);
  }
  const lines = [
    `${config.BRAND.name}`,
    '',
    `  MCP endpoint     ${config.RESOURCE}`,
    `  OAuth issuer     ${config.PUBLIC_URL}`,
    `  Tools            ${mcp.listTools().length} (${config.TOOLSET})`,
    `  Storage          ${store}`,
    `  Platform         ${platformLabel()}`,
    `  HighLevel app    ${config.GHL_CLIENT_ID ? `configured (${config.GHL_CLIENT_ID.slice(0, 8)}…)` : 'not configured — Private Integration Token only'}`,
    `  Redirect to add  ${config.highlevelRedirectUri}`,
    `  Registration     ${config.ALLOW_DYNAMIC_REGISTRATION ? 'open (dynamic)' : 'disabled'}`,
    `  Access phrase    ${config.SIGNUP_PASSCODE ? 'required' : 'not required'}`,
    '',
  ];
  for (const warning of warnings) lines.push(`  WARNING  ${warning}`, '');
  for (const error of errors) lines.push(`  ERROR    ${error}`, '');
  return { text: lines.join('\n'), errors, warnings };
}

/** Name the platform in the audit, so its advice can be specific about what is missing. */
function platformLabel() {
  const named = { vercel: 'Vercel', netlify: 'Netlify' }[config.PLATFORM];
  if (named) return `${named} — serverless (no persistent disk, no long-lived process)`;
  if (config.SERVERLESS) return 'serverless (no persistent disk, no long-lived process)';
  return 'long-running process';
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'Hosted GoHighLevel MCP server',
      '',
      '  node server.js           serve on PORT (default 8787)',
      '  node server.js --check   validate configuration and exit non-zero on a problem',
      '',
      'Required for a real deployment:',
      '  PUBLIC_URL       https URL clients will use, e.g. https://ghl.example.com',
      '  ENCRYPTION_KEY   32 bytes (hex/base64) or a long passphrase',
      '  STORAGE          file (default, needs a persistent disk) or redis (needed on serverless)',
      'Optional but recommended:',
      '  GHL_CLIENT_ID / GHL_CLIENT_SECRET   HighLevel marketplace app, for "Sign in with HighLevel"',
      '',
      'See remote/README.md and PUBLISHING.md.',
      '',
    ].join('\n'));
    return;
  }

  const { text, errors } = await report();

  if (args.includes('--check')) {
    process.stdout.write(text);
    process.stdout.write(errors.length ? 'Configuration is NOT ready.\n' : 'Configuration is ready.\n');
    process.exitCode = errors.length ? 1 : 0;
    return;
  }

  process.stderr.write(text);
  if (errors.length) {
    process.stderr.write('Refusing to start with the errors above. Fix them, or run with --check for detail.\n');
    process.exit(1);
  }

  const app = createApp();
  const server = http.createServer(app);

  // Long enough for a slow HighLevel call, short enough that a dead socket is reclaimed.
  server.headersTimeout = 30000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 65000;

  server.listen(config.PORT, config.HOST, () => {
    process.stderr.write(`[ghl-remote] listening on ${config.HOST}:${config.PORT}\n`);
  });

  const housekeeping = startHousekeeping();

  const shutdown = (signal) => {
    process.stderr.write(`[ghl-remote] ${signal} — shutting down\n`);
    clearInterval(housekeeping);
    transport.closeAllStreams();
    server.close(() => process.exit(0));
    // Do not hang for ever on a stuck connection.
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { report };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[ghl-remote] failed to start: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
