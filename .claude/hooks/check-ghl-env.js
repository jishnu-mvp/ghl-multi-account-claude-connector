#!/usr/bin/env node
/*
 * SessionStart hook for the GoHighLevel + Claude Code connector.
 * Tells the model (and the developer) which GoHighLevel sub-accounts this session can
 * actually reach, so nobody is told to "set up .env" when they are already connected —
 * or left guessing when they are not.
 *
 * There are two ways to be connected, and this hook reports on both:
 *   1. the `ghl` MCP server's browser login   -> ~/.ghl-mcp/credentials.json
 *   2. environment variables / .env           -> GHL_PIT_TOKEN & friends (the original flow,
 *                                                and the only one that works in a cloud session)
 * Neither being present is not an error: the session just needs a ghl_login first.
 *
 * Cross-platform: runs under node, which Claude Code always ships with — no
 * cmd-vs-sh / PowerShell-vs-bash concerns. Never prints token values.
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

// Sub-accounts someone has logged in to through the `ghl` MCP server. Names and location ids
// only — the file also holds tokens, which are never read here and never printed.
function loggedInAccounts() {
  const home = process.env.GHL_MCP_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || '', '.ghl-mcp');
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, 'credentials.json'), 'utf8'));
    return Object.values(data.accounts || {}).map((a) => ({
      alias: a.alias,
      displayName: a.displayName || a.alias,
      authType: a.authType,
    }));
  } catch (_) {
    return [];
  }
}

// accounts.conf rows whose credentials are actually populated (the original flow). `resolve`
// is the same .env-then-environment lookup used for the default account, so a filled-in .env
// counts even when the session was not launched through the claude-here wrapper.
function envAccounts(resolve) {
  try {
    return fs.readFileSync(path.join(repoRoot, 'accounts.conf'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('|').map((c) => c.trim()))
      .filter((c) => c.length >= 4 && resolve(c[2]) && resolve(c[3]))
      .map((c) => ({ alias: c[0], displayName: c[1] }));
  } catch (_) {
    return [];
  }
}

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

// "Connected" means a credential is usable, from any source: a browser login, a .env file (the
// local-PC flow), or live environment variables (the cloud flow, where there is deliberately no
// .env at all). File existence alone is NOT the signal — a cloud session with real environment
// variables and no .env file is fully working, not "not set up".
const logins = loggedInAccounts();
const envRegistered = envAccounts(get);

let context;
let systemMessage = null;

// The `ghl` MCP server is the primary path now: someone logs in in their browser and is
// working, with nothing in .env and no relaunch. So the question is not "is .env filled in"
// but "can this session reach any sub-account at all, by any route".
const connected = [
  ...logins.map((a) => `${a.alias} (${a.displayName}, browser login${a.authType === 'oauth' ? ', HighLevel sign-in' : ''})`),
  ...envRegistered
    .filter((a) => !logins.some((l) => l.alias === a.alias))
    .map((a) => `${a.alias} (${a.displayName}, environment variables)`),
];

const COMMON_RULES =
  'Never fetch or act on any account\'s data unless the user named the account in that same ' +
  'request — ask which one instead of defaulting, even if only one is available, per CLAUDE.md. ' +
  'Say which account you used, by business name, in your reply. Anything outbound (a message, ' +
  'an appointment, a workflow or campaign enrolment) or destructive needs explicit confirmation ' +
  'first; the `ghl` MCP tools enforce this with a confirm flag and will hand you a dry run. ' +
  'A 401/403 means the Private Integration is missing that scope — name the scope to add rather ' +
  'than retrying or probing other endpoints.';

if (connected.length) {
  context =
    'GHL CONNECTED. Sub-accounts this session can reach: ' + connected.join('; ') + '. ' +
    shapeWarning +
    'Use the `ghl` MCP server\'s tools (ghl_accounts to list, ghl_whoami to verify, then the ' +
    'ghl_* tool for the job) — every one takes an `account` alias and there is no default. ' +
    'The /ghl skill\'s helper scripts remain the right choice for scripted or bulk work, and ' +
    'read the same environment variables as before. ' + COMMON_RULES;
  if (missing.length && !envRegistered.length) {
    systemMessage =
      'ℹ️  GoHighLevel: ' + connected.length + ' sub-account(s) connected via browser login. ' +
      'GHL_PIT_TOKEN/GHL_LOCATION_ID are not set, so the legacy helper scripts and the ' +
      'leadconnector MCP will not work for the default account — the `ghl` MCP server does.';
  }
} else {
  const cloud = !envExists;
  context =
    'GHL NOT CONNECTED YET — no sub-account is reachable in this session: nobody has logged in ' +
    'through the `ghl` MCP server (~/.ghl-mcp/credentials.json is empty or absent) and no ' +
    'account\'s environment variables are set' +
    (missing.length ? ' (missing: ' + missing.join(', ') + ')' : '') + '. ' +
    shapeWarning +
    'THE FIX, in this order: (1) call the `ghl` MCP tool ghl_login and give the user the ' +
    '127.0.0.1 link it returns — they log in in their own browser with their HighLevel ' +
    'Private Integration Token or their HighLevel email and password, and nothing needs to be ' +
    'edited, committed or relaunched; then call ghl_login_status. ' +
    (cloud
      ? '(2) BUT NOTE: this session has no .env, which usually means a cloud/web session — a ' +
        '127.0.0.1 login page is not reachable from the user\'s browser there. In that case set ' +
        'the account\'s token and Location ID in this environment\'s variables panel instead ' +
        '(the names are listed in accounts.conf), which both the `ghl` server and the /ghl ' +
        'helper scripts read.'
      : '(2) Alternatively, the original flow still works: fill GHL_PIT_TOKEN and ' +
        'GHL_LOCATION_ID in .env (see .claude/mcp-setup.md) and relaunch via the claude-here ' +
        'launcher.') + ' ' +
    'Do not attempt CRM calls until one of those is done — they will 401. ' + COMMON_RULES;
  systemMessage =
    '⚠️  GoHighLevel: no sub-account connected yet. Ask Claude to "log in to <client>" — it will ' +
    'give you a browser link (no .env editing, no relaunch).';
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
