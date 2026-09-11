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
// Vercel (and any other serverless platform that wants a Node request handler) entry point.
//
// The hosted connector is a plain (req, res) handler, so there is nothing to adapt: this file
// exists because Vercel looks for functions under api/, and because it must live at the
// deployment root — remote/src/app.js requires the shared tool layer from mcp-server/, and a
// project rooted at remote/ would leave those files out of the bundle.
//
// Everything about the deployment is configured through environment variables; see
// vercel.json for the routing and remote/README.md for the required values. Two are not
// optional here: ENCRYPTION_KEY (there is no disk to keep a generated one on) and a Redis
// store (the filesystem is wiped between invocations, so grants and connections must live
// somewhere shared).

const { createApp } = require('../remote/src/app');

// Built once per instance and reused across invocations on a warm one — the tool schemas and
// the endpoint catalogue are the expensive part, and neither depends on the request.
const handler = createApp();

module.exports = handler;
