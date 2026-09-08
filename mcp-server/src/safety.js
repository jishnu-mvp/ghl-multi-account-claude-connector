'use strict';
// The connector's safety rules, enforced in code rather than left to prompt discipline.
//
//  * Anything that reaches a real person (a message, an appointment, a workflow enrolment)
//    or destroys data refuses to run until it is called a second time with confirm: true.
//    The first call returns the exact request it would send, so there is a real dry run.
//  * Destructive writes back the record up first (read-before-write).
//  * Tokens are scrubbed from everything this server prints.

const fs = require('fs');
const path = require('path');
const config = require('./config');

class ConfirmationRequired extends Error {
  constructor(message, preview) {
    super(message);
    this.name = 'ConfirmationRequired';
    this.preview = preview;
  }
}

/**
 * Gate a side-effecting call behind an explicit confirmation.
 *
 * @param {object} opts
 * @param {boolean} opts.confirm     The caller's confirm flag.
 * @param {string}  opts.action      Human sentence: "send an SMS to contact abc123".
 * @param {string}  opts.consequence What actually happens out in the world.
 * @param {object}  opts.request     The request that would be sent (method/path/body).
 * @param {string}  [opts.accountLabel]
 */
function gate({ confirm, action, consequence, request, accountLabel }) {
  if (confirm === true) return;
  const lines = [
    'NOT SENT — confirmation required.',
    '',
    `Action      : ${action}`,
    accountLabel ? `Account     : ${accountLabel}` : null,
    `Consequence : ${consequence}`,
    '',
    'Exact request that will be sent:',
    '```',
    `${request.method} ${request.path}`,
    request.body === undefined ? '(no body)' : JSON.stringify(request.body, null, 2),
    '```',
    '',
    'Show this to the user and get an explicit go-ahead. Then call this tool again with',
    'confirm: true and identical arguments. Do not confirm on the user\'s behalf.',
  ].filter((l) => l !== null);
  throw new ConfirmationRequired(lines.join('\n'), request);
}

/**
 * Save a record to the per-user backup directory before it is changed or deleted.
 * Backups live outside the repository so CRM data never lands in git.
 * @returns {string} the file written
 */
function backup({ alias, kind, id, data }) {
  const dir = path.join(config.backupDir(), alias);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${kind}-${sanitise(id)}-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function sanitise(v) {
  return String(v).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'record';
}

// Token shapes we must never echo: Private Integration Tokens, bearer headers, OAuth
// access/refresh tokens, and HighLevel's JWT-ish agency tokens.
const REDACTIONS = [
  [/pit-[A-Za-z0-9-]{8,}/g, 'pit-<redacted>'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1<redacted>'],
  [/("(?:access_token|refresh_token|accessToken|refreshToken|client_secret|clientSecret|apiKey|api_key)"\s*:\s*")[^"]*(")/g, '$1<redacted>$2'],
  [/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]+/g, '<redacted-jwt>'],
];

function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined) return '';
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

/** Show enough of a token to recognise it, never enough to use it. */
function tokenFingerprint(token) {
  if (!token) return '<not set>';
  const t = String(token);
  return `${t.slice(0, 8)}… (${t.length} chars)`;
}

module.exports = { gate, backup, redact, tokenFingerprint, ConfirmationRequired };
