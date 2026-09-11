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
// Read the repo-root .env, the same way .claude/skills/ghl/scripts/ghl.sh does.
//
// The browser login makes this unnecessary for new users, but anyone already running the
// connector has their credentials in .env — and Claude Code does not necessarily launch this
// server with those values in its environment (that is what the claude-here wrapper was for).
// Reading the file directly means an existing setup works with no relaunch and no migration.
//
// Precedence matches the shell helpers: a real environment variable always wins over the file.

const fs = require('fs');
const path = require('path');

let cache = null;

function parse(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function load(repoRoot) {
  if (cache) return cache;
  try {
    cache = parse(fs.readFileSync(path.join(repoRoot, '.env'), 'utf8'));
  } catch (_) {
    cache = {};
  }
  return cache;
}

/** Look up a variable: real environment first, then the repo's .env. */
function get(name, repoRoot) {
  const live = process.env[name];
  if (live && live.trim()) return live.trim();
  const fromFile = load(repoRoot)[name];
  return fromFile && fromFile.trim() ? fromFile.trim() : undefined;
}

/** Test seam: forget the parsed file. */
function reset() {
  cache = null;
}

module.exports = { get, load, parse, reset };
