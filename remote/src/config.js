'use strict';
// Hosted-server configuration. Everything has a default that works for a local run; the
// two things a real deployment must set are PUBLIC_URL and ENCRYPTION_KEY.

const path = require('path');

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const PORT = num('PORT', 8787);
const HOST = process.env.HOST || '0.0.0.0';

// The externally reachable origin. It is the OAuth issuer, the audience every access token
// is bound to, and the base for the redirect URL registered with HighLevel — so it has to be
// exactly what clients type, with no trailing slash.
//
// On a platform that assigns URLs, fall back to the STABLE production one rather than the
// deployment-specific one: tokens are bound to this value and HighLevel has exactly one
// registered redirect URL, so it must not change with every deploy.
//   Vercel   VERCEL_PROJECT_PRODUCTION_URL — set even on previews, carries no scheme
//   Netlify  URL — the site's own production address (DEPLOY_PRIME_URL is per-deploy, so it
//            is deliberately not used); only trusted when NETLIFY says whose variable it is
const PUBLIC_URL = (
  process.env.PUBLIC_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || (process.env.NETLIFY && process.env.URL)
  || `http://localhost:${PORT}`
).replace(/\/+$/, '');

// The MCP endpoint's canonical URI (RFC 8707). Tokens are issued for this audience only.
const MCP_PATH = '/mcp';
const RESOURCE = `${PUBLIC_URL}${MCP_PATH}`;

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

// Where OAuth state and connections are kept. 'auto' picks Redis when connection details are
// present and the local disk otherwise, which is the right answer on both a container with a
// volume and a serverless platform with the Upstash integration installed.
const STORAGE = process.env.STORAGE || 'auto';
const REDIS_TIMEOUT_MS = num('REDIS_TIMEOUT_MS', 10000);

// Serverless platforms give every invocation a fresh, private filesystem, so anything written
// to disk is gone by the next request. Detecting it lets the boot audit refuse a configuration
// that would appear to work and then drop everyone's connections.
const SERVERLESS = Boolean(
  process.env.VERCEL
  || process.env.NETLIFY
  || process.env.AWS_LAMBDA_FUNCTION_NAME
  || process.env.FUNCTION_TARGET
  || process.env.K_SERVICE
  || /^(1|true)$/i.test(process.env.SERVERLESS || ''),
);

// Which platform, for the boot audit to name in its advice. Nothing branches on this.
const PLATFORM = process.env.VERCEL ? 'vercel'
  : process.env.NETLIFY ? 'netlify'
    : SERVERLESS ? 'serverless'
      : 'server';

// Encrypts GoHighLevel credentials at rest. Generated and persisted on first run if unset,
// which keeps a self-hosted single instance working out of the box; set it explicitly for
// anything with more than one replica or a rebuildable disk.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

// HighLevel marketplace app. Without it the connector still works — people connect with a
// Private Integration Token instead — but "Sign in with HighLevel" cannot be offered.
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID || '';
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET || '';
const GHL_REDIRECT_PATH = '/highlevel/callback';

// Token lifetimes. Short access tokens, rotating refresh tokens: OAuth 2.1 for public clients.
const ACCESS_TOKEN_TTL_MS = num('ACCESS_TOKEN_TTL_MS', 60 * 60 * 1000);
const REFRESH_TOKEN_TTL_MS = num('REFRESH_TOKEN_TTL_MS', 30 * 24 * 60 * 60 * 1000);
const AUTH_CODE_TTL_MS = num('AUTH_CODE_TTL_MS', 5 * 60 * 1000);
const LOGIN_SESSION_TTL_MS = num('LOGIN_SESSION_TTL_MS', 30 * 60 * 1000);

// Who may register as a client. Dynamic registration is how MCP clients get a client_id
// without a human in the loop, and it is what Claude and friends expect; turning it off means
// pre-registering clients by hand.
const ALLOW_DYNAMIC_REGISTRATION = bool('ALLOW_DYNAMIC_REGISTRATION', true);

// Optional allow-list of redirect URI hosts, e.g. "claude.ai,claude.com". Empty = any HTTPS
// redirect (plus loopback), which the OAuth 2.1 rules already require.
const ALLOWED_REDIRECT_HOSTS = (process.env.ALLOWED_REDIRECT_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Connecting by pasting a Private Integration Token. Off by default: the intended flow is
// "sign in with HighLevel", which is what lets someone pick from the sub-accounts their own
// account already covers. Kept as an operator escape hatch for testing before the HighLevel
// marketplace app exists.
const ALLOW_TOKEN_CONNECT = bool('ALLOW_TOKEN_CONNECT', false);

// Optional gate on who may create a connection at all — a shared phrase typed on the login
// page. Useful when a server is for one agency rather than the public.
const SIGNUP_PASSCODE = process.env.SIGNUP_PASSCODE || '';

const RATE_LIMIT = {
  windowMs: num('RATE_LIMIT_WINDOW_MS', 60 * 1000),
  authMax: num('RATE_LIMIT_AUTH_MAX', 30),      // per IP, on the OAuth endpoints
  mcpMax: num('RATE_LIMIT_MCP_MAX', 240),       // per token, on the MCP endpoint
};

const BRAND = {
  name: process.env.BRAND_NAME || 'GoHighLevel Connector',
  // Shown on the consent screen. Keep it factual — HighLevel's review guidelines reject
  // implied endorsement, and a white-label listing must not say "HighLevel" at all.
  operator: process.env.BRAND_OPERATOR || '',
  supportEmail: process.env.SUPPORT_EMAIL || '',
  privacyUrl: process.env.PRIVACY_URL || '',
  termsUrl: process.env.TERMS_URL || '',
};

const TRUST_PROXY = bool('TRUST_PROXY', true);
const TOOLSET = process.env.GHL_MCP_TOOLSET || 'full';

/** Are Redis connection details present, under any of the names platforms inject? */
function redisConfigured() {
  return Boolean(
    (process.env.REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)
    && (process.env.REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
  );
}

/** Problems that should stop a production boot, and warnings that should not. */
function audit() {
  const errors = [];
  const warnings = [];
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(PUBLIC_URL);

  if (!process.env.PUBLIC_URL && (process.env.VERCEL_PROJECT_PRODUCTION_URL || (process.env.NETLIFY && process.env.URL))) {
    warnings.push(`PUBLIC_URL is not set; using this site's production address, ${PUBLIC_URL}. Set it explicitly once a custom domain points here — tokens are bound to this value and HighLevel has one registered redirect URL, so it must not change afterwards.`);
  } else if (!process.env.PUBLIC_URL) {
    warnings.push(`PUBLIC_URL is not set — falling back to ${PUBLIC_URL}. Set it to the HTTPS URL clients will use, or OAuth discovery will hand out the wrong endpoints.`);
  } else if (!isLocal && !PUBLIC_URL.startsWith('https://')) {
    errors.push('PUBLIC_URL must be https:// — OAuth 2.1 requires TLS on every authorization endpoint, and HighLevel rejects a non-HTTPS redirect URL.');
  }
  if (!ENCRYPTION_KEY) {
    if (SERVERLESS) {
      errors.push('ENCRYPTION_KEY must be set on a serverless platform. There is no persistent disk to keep a generated key in, so every invocation would generate a different one and no stored connection could ever be read back. Generate one with: openssl rand -hex 32');
    } else {
      warnings.push('ENCRYPTION_KEY is not set — a key will be generated into the data directory. Set it explicitly if the disk is disposable or you run more than one instance, otherwise stored connections become unreadable.');
    }
  }
  if (SERVERLESS && String(STORAGE).toLowerCase() !== 'redis' && !redisConfigured()) {
    const where = {
      vercel: 'On Vercel: Storage → Marketplace → Upstash Redis, which injects the connection details automatically.',
      netlify: 'On Netlify: Extensions → Upstash Redis (or add REDIS_REST_URL / REDIS_REST_TOKEN from any Upstash database yourself).',
    }[PLATFORM] || 'Add a Redis store (Upstash, or anything speaking its REST API) and set REDIS_REST_URL / REDIS_REST_TOKEN.';
    errors.push(`This looks like a serverless deployment, but no Redis store is configured. The filesystem here is wiped between invocations, so OAuth grants, connections and half-finished logins would vanish and every client would be disconnected within minutes. ${where} Or deploy somewhere with a persistent disk.`);
  }
  if (!GHL_CLIENT_ID || !GHL_CLIENT_SECRET) {
    if (ALLOW_TOKEN_CONNECT) {
      warnings.push('GHL_CLIENT_ID / GHL_CLIENT_SECRET are not set — "Sign in with HighLevel" is unavailable, so people can only connect by pasting a Private Integration Token, and cannot pick from several sub-accounts. See PUBLISHING.md.');
    } else {
      errors.push('GHL_CLIENT_ID / GHL_CLIENT_SECRET are not set, and ALLOW_TOKEN_CONNECT is off, so there is no way for anyone to connect. Create the HighLevel marketplace app (PUBLISHING.md steps 1-3) and set both values — that is the only route to signing in with a HighLevel account. To test before then, set ALLOW_TOKEN_CONNECT=true.');
    }
  }
  return { errors, warnings };
}

module.exports = {
  PORT, HOST, PUBLIC_URL, MCP_PATH, RESOURCE, DATA_DIR,
  STORAGE, REDIS_TIMEOUT_MS, SERVERLESS, PLATFORM,
  ENCRYPTION_KEY,
  GHL_CLIENT_ID, GHL_CLIENT_SECRET, GHL_REDIRECT_PATH,
  ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, AUTH_CODE_TTL_MS, LOGIN_SESSION_TTL_MS,
  ALLOW_DYNAMIC_REGISTRATION, ALLOWED_REDIRECT_HOSTS, SIGNUP_PASSCODE, ALLOW_TOKEN_CONNECT,
  RATE_LIMIT, BRAND, TRUST_PROXY, TOOLSET,
  redisConfigured,
  get highlevelRedirectUri() { return `${PUBLIC_URL}${GHL_REDIRECT_PATH}`; },
  audit,
};
