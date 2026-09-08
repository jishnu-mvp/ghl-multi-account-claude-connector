'use strict';
// Run the connector on a platform that speaks Web Request/Response instead of Node's
// (req, res) — Netlify Functions v2, Deno Deploy, Cloudflare-style handlers.
//
// The app itself stays a plain Node request handler, because that is what a real server and
// Vercel both want. This file is the only place that knows about the other calling
// convention: it builds a request object with the small surface the app actually uses
// (method, url, headers, a readable body, a client IP) and captures what the app writes back.
//
// Buffered, not streamed, and deliberately so. Every response this connector produces is a
// complete document — a page, a JSON body, a redirect — except the legacy SSE transport,
// which needs a process that outlives the request and is already declined when SERVERLESS is
// set. So there is nothing to gain from streaming here, and a buffer is far easier to be sure
// of. A handler that finishes without ending its response is reported rather than left to
// hang the platform's timeout.

const { Readable } = require('stream');
const { EventEmitter } = require('events');

/** The bit of http.IncomingMessage the app reads, over a Web Request's body. */
function nodeRequestFrom(request, url, ip) {
  // Readable.fromWeb keeps the platform's backpressure; a bodyless request still needs a
  // stream that ends, or readBody would never resolve.
  const stream = request.body ? Readable.fromWeb(request.body) : Readable.from([]);

  stream.method = request.method;
  // The app resolves req.url against PUBLIC_URL, so hand it a path, not an absolute URL.
  stream.url = `${url.pathname}${url.search}`;
  stream.headers = Object.fromEntries([...request.headers].map(([name, value]) => [name.toLowerCase(), value]));
  stream.httpVersion = '1.1';
  // Rate limiting keys off this. On these platforms the connection address is only ever
  // available as a header, which is why TRUST_PROXY exists.
  stream.socket = { remoteAddress: ip || null };
  return stream;
}

/** Collects writeHead/setHeader/write/end into something a Response can be built from. */
class ResponseWriter extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.chunks = [];
    this.headerMap = new Map();
    this.finished = new Promise((resolve) => { this.settle = resolve; });
  }

  setHeader(name, value) {
    this.headerMap.set(String(name).toLowerCase(), value);
    return this;
  }

  getHeader(name) {
    return this.headerMap.get(String(name).toLowerCase());
  }

  removeHeader(name) {
    this.headerMap.delete(String(name).toLowerCase());
    return this;
  }

  writeHead(status, headers) {
    this.statusCode = status;
    if (headers) for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk));
    this.headersSent = true;
    return true;
  }

  end(chunk) {
    if (this.writableEnded) return this;
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk));
    this.headersSent = true;
    this.writableEnded = true;
    this.settle();
    return this;
  }

  toResponse() {
    const headers = new Headers();
    for (const [name, value] of this.headerMap) {
      for (const one of Array.isArray(value) ? value : [value]) headers.append(name, String(one));
    }
    // 204 and 304 must not carry a body, and undici rejects one outright.
    const bodyless = this.statusCode === 204 || this.statusCode === 304;
    const body = bodyless || !this.chunks.length ? null : Buffer.concat(this.chunks);
    return new Response(body, { status: this.statusCode, headers });
  }
}

/**
 * Wrap a Node request handler as a Web `Request -> Response` function.
 *
 * @param {(req, res) => any} nodeHandler  what createApp() returns
 * @param {object}   [options]
 * @param {(request: Request) => string|null} [options.clientIp]  how to read the caller's
 *        address on this platform, since there is no socket to ask
 * @param {{error: (msg: string) => void}} [options.log]
 */
function toWebHandler(nodeHandler, { clientIp, log } = {}) {
  const report = (log && log.error) || ((msg) => process.stderr.write(`[ghl-remote] ERROR ${msg}\n`));

  return async function handle(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch (_) {
      return jsonResponse(400, { error: 'invalid_request', error_description: 'That request URL could not be parsed.' });
    }

    const ip = clientIp ? clientIp(request) : null;
    const req = nodeRequestFrom(request, url, ip);
    const res = new ResponseWriter();

    try {
      await nodeHandler(req, res);
    } catch (err) {
      // createApp handles its own errors, so reaching here means the adapter or the platform
      // is at fault. Say so once, without the request's contents.
      report(`${request.method} ${url.pathname} threw through the serverless adapter: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
      if (!res.writableEnded) {
        return jsonResponse(500, { error: 'server_error', error_description: 'Something went wrong handling that request.' });
      }
    }

    if (!res.writableEnded) {
      // The only handler that deliberately leaves a response open is the legacy SSE stream,
      // which this platform cannot host — SERVERLESS should already be declining it.
      report(`${request.method} ${url.pathname} did not finish its response; streaming is not available on this platform.`);
      return jsonResponse(501, {
        error: 'transport_unavailable',
        error_description: 'This deployment cannot hold a response open. Use the Streamable HTTP endpoint instead.',
      });
    }

    return res.toResponse();
  };
}

function jsonResponse(status, body) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

module.exports = { toWebHandler, ResponseWriter, nodeRequestFrom };
