#!/usr/bin/env node
/*
 * SessionStart hook for the GoHighLevel + Claude Code connector.
 * Warns the developer (and tells the model) if GHL credentials are not configured,
 * so someone who has never touched a Private Integration Token knows exactly what to do.
 *
 * Cross-platform: runs under node, which Claude Code always ships with — no
 * cmd-vs-sh / PowerShell-vs-bash concerns.
 *
 * Reads .env (and the live environment) to check GHL_PIT_TOKEN, GHL_LOCATION_ID,
 * GHL_API_BASE_URL, GHL_API_VERSION. Emits JSON on stdout with additionalContext so
 * the running session is told the current setup state. Never prints token values.
 */
const fs = require('fs');
const path = require('path');

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.mcp.json')) || fs.existsSync(path.join(dir, '.env.example'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const repoRoot = findRepoRoot(process.cwd());
const envFile = path.join(repoRoot, '.env');

const vals = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const idx = t.indexOf('=');
    vals[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^"|"$/g, '');
  }
}
// live environment overrides .env
const get = (k) => (process.env[k] && process.env[k].trim()) || vals[k] || '';

const envExists = fs.existsSync(envFile);
const token = get('GHL_PIT_TOKEN');
const hasToken = !!token;
const hasLocation = !!get('GHL_LOCATION_ID');
// GHL_API_BASE_URL / GHL_API_VERSION are NOT required here: ghl.sh/ghl.ps1 already default them
// (https://services.leadconnectorhq.com and 2021-07-28) when unset. Only the token and Location
// ID are things the user actually has to supply.

const missing = [];
if (!hasToken) missing.push('GHL_PIT_TOKEN');
if (!hasLocation) missing.push('GHL_LOCATION_ID');

// Shape check only — never echo the token itself.
const looksLikePit = hasToken && /^pit-/.test(token);
const shapeWarning =
  hasToken && !looksLikePit
    ? 'NOTE: GHL_PIT_TOKEN does not start with "pit-". Private Integration Tokens do. If this ' +
      'is an old v1 API key or a JWT, API v2 calls will fail with 401 — generate a Private ' +
      'Integration Token instead (Settings → Other Settings → Private Integrations). '
    : '';

// "Configured" means the values are usable — whether they came from a .env file (the local-PC
// flow) or are already live in the process environment (the cloud-environment flow, where
// there's deliberately no .env file at all). File existence alone is NOT the signal — a cloud
// session with real env vars and no .env file is fully working, not "not set up".
let context;
let systemMessage = null;
if (missing.length) {
  const where = envExists
    ? '.env (see .claude/mcp-setup.md)'
    : 'this environment\'s variables (a cloud session) or a local .env file (see .claude/mcp-setup.md)';
  context =
    'GHL SETUP INCOMPLETE for the default account: these are not set: ' + missing.join(', ') + '. ' +
    (!hasToken
      ? 'Because GHL_PIT_TOKEN is empty, BOTH the /ghl API helper scripts AND the LeadConnector ' +
        'MCP will fail for the default account — the MCP authenticates with the same Private ' +
        'Integration Token. '
      : '') +
    (!hasLocation
      ? 'Because GHL_LOCATION_ID is empty, every sub-account-scoped call (contacts, ' +
        'conversations, opportunities, calendars) will fail — HighLevel requires a locationId. '
      : '') +
    shapeWarning +
    'Tell the user how to fix it: fill the missing values in ' + where + ', then (if using a ' +
    'local .env) relaunch via the claude-here launcher so the token is loaded into the ' +
    'environment. Note: other sub-accounts registered in accounts.conf are unaffected by this ' +
    'and may still work fine — check accounts.conf before assuming nothing is connected.';
  systemMessage =
    '⚠️  GoHighLevel setup incomplete for the default account — missing: ' + missing.join(', ') +
    '. See .claude/mcp-setup.md.';
} else {
  const tokenInProcess = !!(process.env.GHL_PIT_TOKEN && process.env.GHL_PIT_TOKEN.trim());
  context =
    'GHL default-account setup looks complete (GHL_PIT_TOKEN and GHL_LOCATION_ID both resolved, ' +
    'from .env and/or the live environment; GHL_API_BASE_URL/GHL_API_VERSION use safe defaults ' +
    'if unset). ' + shapeWarning +
    (tokenInProcess
      ? 'GHL_PIT_TOKEN is present in the process environment, so the leadconnector MCP server ' +
        'should connect.'
      : 'NOTE: GHL_PIT_TOKEN is only in .env, not in the process environment — if the ' +
        'leadconnector server shows as failed in /mcp, the session was not launched via the ' +
        'claude-here wrapper. Advise relaunching with `.\\claude-here.ps1` / `./claude-here.sh` ' +
        'so .mcp.json can read the token. The /ghl API skill works either way; it reads .env ' +
        'directly.') +
    ' Follow the API-vs-MCP rules in CLAUDE.md: the REST API v2 (via the /ghl skill) is the ' +
    'default and the superset; the MCP is the conversational convenience layer and only ever ' +
    'reaches this default account — other accounts in accounts.conf go through the API with ' +
    '--account/-Account. Never fetch or act on any account\'s data without the user naming it ' +
    'in that request, per CLAUDE.md. A 401/403 on a specific endpoint usually means the Private ' +
    'Integration is missing that scope — tell the user which scope to add rather than retrying ' +
    'blindly.';
  if (!tokenInProcess) {
    systemMessage =
      'ℹ️  GHL .env is filled in, but GHL_PIT_TOKEN is not in this process. If the LeadConnector ' +
      'MCP shows as failed in /mcp, relaunch via  .\\claude-here.ps1  /  ./claude-here.sh .';
  }
}

const out = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
};
if (systemMessage) out.systemMessage = systemMessage;

process.stdout.write(JSON.stringify(out));
process.exit(0);
