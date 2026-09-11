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
// Model Context Protocol server core: JSON-RPC 2.0 over newline-delimited stdio.
//
// Implemented directly rather than with the TypeScript SDK so the whole server stays
// dependency-free — `node server.js` works on a fresh machine with no install step, which
// is the difference between "anyone can use this" and "everyone has to set it up first".
//
// Hard rule of the stdio transport: stdout carries protocol frames only. Every log line
// goes to stderr.

const config = require('./config');

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

class McpServer {
  constructor({ name = config.SERVER_NAME, version = config.SERVER_VERSION, instructions = '' } = {}) {
    this.name = name;
    this.version = version;
    this.instructions = instructions;
    this.tools = new Map();
    this.protocolVersion = config.DEFAULT_PROTOCOL_VERSION;
    this.initialized = false;
  }

  /**
   * @param {object} tool
   * @param {string} tool.name
   * @param {string} tool.description
   * @param {object} tool.inputSchema     JSON Schema for the arguments.
   * @param {object} [tool.annotations]   MCP hints (readOnlyHint / destructiveHint / …).
   * @param {(args:object)=>Promise<string|object>} tool.handler
   */
  registerTool(tool) {
    if (!tool || !tool.name) throw new Error('A tool needs a name.');
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    if (typeof tool.handler !== 'function') throw new Error(`Tool ${tool.name} has no handler.`);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerTools(tools) {
    for (const tool of tools) this.registerTool(tool);
    return this;
  }

  listTools() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
  }

  /** Handle one decoded JSON-RPC message. Returns a response object, or null for notifications. */
  async handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, INVALID_REQUEST, 'A JSON-RPC message must be an object.');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize': {
          const requested = params && params.protocolVersion;
          this.protocolVersion = config.SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : config.DEFAULT_PROTOCOL_VERSION;
          this.initialized = true;
          return okResponse(id, {
            protocolVersion: this.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.name, version: this.version },
            ...(this.instructions ? { instructions: this.instructions } : {}),
          });
        }

        case 'notifications/initialized':
        case 'initialized':
        case 'notifications/cancelled':
          return null;

        case 'ping':
          return okResponse(id, {});

        case 'tools/list':
          return okResponse(id, { tools: this.listTools() });

        case 'tools/call':
          return okResponse(id, await this.callTool(params));

        // Not advertised in capabilities, but some clients probe anyway; an empty list is
        // friendlier than an error.
        case 'resources/list':
          return okResponse(id, { resources: [] });
        case 'resources/templates/list':
          return okResponse(id, { resourceTemplates: [] });
        case 'prompts/list':
          return okResponse(id, { prompts: [] });

        default:
          if (isNotification) return null;
          return errorResponse(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (err) {
      if (err && err.code === INVALID_PARAMS) {
        return errorResponse(id, INVALID_PARAMS, err.message);
      }
      return errorResponse(id, INTERNAL_ERROR, err && err.message ? err.message : String(err));
    }
  }

  /**
   * tools/call. Tool failures come back as isError results rather than protocol errors so
   * the model sees the message and can act on it (that is what the MCP spec asks for).
   */
  async callTool(params) {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = this.tools.get(name);
    if (!tool) {
      const err = new Error(`Unknown tool: ${name}. Call tools/list to see what is available.`);
      err.code = INVALID_PARAMS;
      throw err;
    }

    const validationError = validateArgs(tool.inputSchema, args);
    if (validationError) {
      return textResult(`Invalid arguments for ${name}: ${validationError}`, true);
    }

    try {
      const output = await tool.handler(args);
      if (output && typeof output === 'object' && Array.isArray(output.content)) return output;
      return textResult(typeof output === 'string' ? output : JSON.stringify(output, null, 2), false);
    } catch (err) {
      return textResult(formatToolError(err), true);
    }
  }
}

// Enough JSON Schema checking to catch the mistakes that actually happen: a missing required
// field, or a value of the wrong basic type. Full schema validation would mean a dependency.
function validateArgs(schema, args) {
  if (!schema || schema.type !== 'object') return null;
  for (const key of schema.required || []) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      return `"${key}" is required.`;
    }
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const expected = spec.type;
    if (!expected) continue;
    const types = Array.isArray(expected) ? expected : [expected];
    if (!types.some((t) => matchesType(t, value))) {
      return `"${key}" should be ${types.join(' or ')}, got ${Array.isArray(value) ? 'array' : typeof value}.`;
    }
    if (spec.enum && !spec.enum.includes(value)) {
      return `"${key}" must be one of: ${spec.enum.join(', ')}.`;
    }
  }
  return null;
}

function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

function formatToolError(err) {
  const { redact } = require('./safety');
  if (!err) return 'The tool failed for an unknown reason.';
  if (err.name === 'ConfirmationRequired') return redact(err.message);
  if (err.name === 'ApiError') {
    const parts = [redact(err.message)];
    if (err.status === 401 || err.status === 403) {
      parts.push('', 'HighLevel returned 401/403. That is a missing scope, not a transient failure —');
      parts.push('do not retry and do not try a different endpoint.');
      if (err.scopeHint) parts.push(`Scope to add: ${err.scopeHint}`);
      parts.push('Adding a scope in HighLevel issues a NEW Private Integration Token, so whoever');
      parts.push('owns this connection has to log in again (ghl_login) with the new token.');
    }
    if (err.status === 429) {
      parts.push('', 'Rate limited (~100 requests / 10s per app+location). Back off and batch — never retry-hammer.');
    }
    return parts.join('\n');
  }
  return redact(err.message || String(err));
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function okResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

/** Wire an McpServer to a pair of streams (stdin/stdout in production). */
function serve(server, { input = process.stdin, output = process.stdout, log = console.error } = {}) {
  let buffer = '';
  input.setEncoding('utf8');

  const send = (response) => {
    if (!response) return;
    output.write(`${JSON.stringify(response)}\n`);
  };

  // Requests are handled concurrently but responses are written whole, one frame per line.
  input.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        send(errorResponse(null, PARSE_ERROR, `Could not parse JSON-RPC frame: ${err.message}`));
        continue;
      }
      const messages = Array.isArray(message) ? message : [message];
      for (const msg of messages) {
        server.handleMessage(msg).then(send).catch((err) => {
          log(`[ghl-mcp] unhandled error: ${err && err.stack ? err.stack : err}`);
          send(errorResponse(msg && msg.id, INTERNAL_ERROR, 'Internal server error.'));
        });
      }
    }
  });

  input.on('end', () => { /* client closed the pipe; process exits naturally */ });
  return server;
}

module.exports = {
  McpServer,
  serve,
  validateArgs,
  formatToolError,
  textResult,
  codes: { PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR },
};
