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
// Cryptography: encrypt GoHighLevel credentials at rest, hash the tokens we issue, and
// compare secrets without leaking timing. node:crypto only — still no dependencies.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let keyCache = null;

/**
 * The 32-byte data key. From ENCRYPTION_KEY when set (hex, base64 or passphrase); otherwise
 * generated once and persisted 0600 in the data directory so a single self-hosted instance
 * works with no configuration.
 */
function key() {
  if (keyCache) return keyCache;
  if (config.ENCRYPTION_KEY) {
    keyCache = deriveKey(config.ENCRYPTION_KEY);
    return keyCache;
  }
  const file = path.join(config.DATA_DIR, '.encryption-key');
  try {
    keyCache = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (keyCache.length === 32) return keyCache;
  } catch (_) { /* first run */ }
  keyCache = crypto.randomBytes(32);
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${keyCache.toString('hex')}\n`, { mode: 0o600 });
  return keyCache;
}

function deriveKey(secret) {
  const raw = String(secret).trim();
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  // A passphrase: stretch it rather than truncating. The salt is fixed because the key must
  // be reproducible across restarts and replicas from the passphrase alone.
  return crypto.scryptSync(raw, 'ghl-mcp-remote/v1', 32);
}

/** AES-256-GCM. Returns "v1.<iv>.<tag>.<ciphertext>", all base64url. */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join('.');
}

function decrypt(payload) {
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Malformed ciphertext.');
  const [, iv, tag, ct] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), unb64u(iv));
  decipher.setAuthTag(unb64u(tag));
  return Buffer.concat([decipher.update(unb64u(ct)), decipher.final()]).toString('utf8');
}

/** Encrypt/decrypt whole objects, for credential blobs. */
function sealJson(value) { return encrypt(JSON.stringify(value)); }
function openJson(payload) { return JSON.parse(decrypt(payload)); }

/** Tokens are stored only as digests, so a leaked data file cannot be replayed. */
function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomId(prefix, bytes = 12) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

/** PKCE S256 verification. */
function verifyPkce(codeVerifier, codeChallenge, method = 'S256') {
  if (method !== 'S256') return false;
  if (!codeVerifier || !codeChallenge) return false;
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return timingSafeEqual(computed, codeChallenge);
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64u(str) { return Buffer.from(str, 'base64url'); }

/** Test seam. */
function resetKey() { keyCache = null; }

module.exports = {
  encrypt, decrypt, sealJson, openJson,
  digest, randomToken, randomId,
  verifyPkce, timingSafeEqual, resetKey, deriveKey,
};
