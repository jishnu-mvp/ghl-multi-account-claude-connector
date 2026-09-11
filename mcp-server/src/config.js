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
// Central configuration + filesystem locations.
//
// Design rule: nothing secret is ever read from, or written to, this repository.
// Credentials live in the per-user home directory (see credentialsFile below), which is
// why this server needs no .env, no launcher script and no environment variables.

const os = require('os');
const path = require('path');

const SERVER_NAME = 'ghl';
const SERVER_VERSION = '1.0.0';

// MCP protocol revisions this server can speak. The newest is advertised by default; if the
// client asks for one of the others we echo that back so old clients keep working.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const API_BASE_URL = stripSlash(process.env.GHL_API_BASE_URL || 'https://services.leadconnectorhq.com');
const API_VERSION = process.env.GHL_API_VERSION || '2021-07-28';
const MARKETPLACE_BASE_URL = stripSlash(process.env.GHL_MARKETPLACE_URL || 'https://marketplace.gohighlevel.com');

// Where per-user state lives. GHL_MCP_HOME exists so the test suite (and anyone with an
// unusual setup) can redirect it without touching the real credential store.
function stateDir() {
  return process.env.GHL_MCP_HOME || path.join(os.homedir(), '.ghl-mcp');
}
function credentialsFile() {
  return path.join(stateDir(), 'credentials.json');
}
// Record backups written before a destructive write (read-before-write rule).
function backupDir() {
  return process.env.GHL_MCP_BACKUP_DIR || path.join(stateDir(), 'backups');
}

// HighLevel's published API v2 budget: ~100 requests / 10s burst, ~200k / day per
// app+location. We stay a little under the burst ceiling on purpose.
const RATE_LIMIT = {
  maxRequests: numberFromEnv('GHL_MCP_RATE_MAX', 90),
  windowMs: numberFromEnv('GHL_MCP_RATE_WINDOW_MS', 10000),
};

const REQUEST_TIMEOUT_MS = numberFromEnv('GHL_MCP_TIMEOUT_MS', 60000);

// Loopback login server. Port 0 = let the OS pick a free port, which avoids clashing with
// whatever else the user is running.
const LOGIN_SERVER = {
  host: '127.0.0.1',
  port: numberFromEnv('GHL_MCP_LOGIN_PORT', 0),
  // How long a login page stays open waiting for the person to finish.
  ttlMs: numberFromEnv('GHL_MCP_LOGIN_TTL_MS', 15 * 60 * 1000),
};

// Default scopes requested when logging in through the OAuth marketplace flow. Chosen to
// match the scope map in .claude/skills/ghl/SKILL.md.
const OAUTH_DEFAULT_SCOPES = [
  'contacts.readonly', 'contacts.write',
  'conversations.readonly', 'conversations.write',
  'conversations/message.readonly', 'conversations/message.write',
  'opportunities.readonly', 'opportunities.write',
  'calendars.readonly', 'calendars.write',
  'calendars/events.readonly', 'calendars/events.write',
  'locations.readonly',
  'locations/customFields.readonly', 'locations/customFields.write',
  'locations/customValues.readonly', 'locations/customValues.write',
  'locations/tags.readonly', 'locations/tags.write',
  'locations/tasks.readonly', 'locations/tasks.write',
  'users.readonly',
  'workflows.readonly', 'campaigns.readonly',
  'forms.readonly', 'surveys.readonly',
  'products.readonly', 'products/prices.readonly',
  'invoices.readonly', 'payments/orders.readonly', 'payments/transactions.readonly',
  'payments/subscriptions.readonly',
  'medias.readonly', 'links.readonly', 'businesses.readonly', 'blogs/post.readonly',
  'funnels/funnel.readonly',
];

function stripSlash(u) {
  return String(u).replace(/\/+$/, '');
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_PROTOCOL_VERSION,
  API_BASE_URL,
  API_VERSION,
  MARKETPLACE_BASE_URL,
  stateDir,
  credentialsFile,
  backupDir,
  RATE_LIMIT,
  REQUEST_TIMEOUT_MS,
  LOGIN_SERVER,
  OAUTH_DEFAULT_SCOPES,
};
