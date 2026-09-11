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
// Minimal HTTPS client built on node:https so the server needs no dependencies at all.
//
// Written by hand rather than using global fetch for two reasons: an explicit socket
// timeout, and HTTPS_PROXY support via CONNECT tunnelling (Node's fetch ignores the proxy
// environment variables, which would break the server inside a proxied cloud session).

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

function shouldBypassProxy(hostname) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!noProxy.trim()) return false;
  const host = hostname.toLowerCase();
  return noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === '*') return true;
    const bare = entry.replace(/^\./, '');
    return host === bare || host.endsWith(`.${bare}`);
  });
}

function proxyFor(target) {
  if (target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '::1') return null;
  if (shouldBypassProxy(target.hostname)) return null;
  const raw = target.protocol === 'https:'
    ? (process.env.HTTPS_PROXY || process.env.https_proxy)
    : (process.env.HTTP_PROXY || process.env.http_proxy);
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch (_) {
    return null;
  }
}

// Open a TCP tunnel through an HTTP proxy, then hand back the raw socket for TLS.
function connectThroughProxy(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const headers = { Host: `${target.hostname}:${targetPort(target)}` };
    if (proxy.username || proxy.password) {
      const creds = `${decodeURIComponent(proxy.username || '')}:${decodeURIComponent(proxy.password || '')}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    }
    const transport = proxy.protocol === 'https:' ? https : http;
    const req = transport.request({
      host: proxy.hostname,
      port,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort(target)}`,
      headers,
      timeout: timeoutMs,
      ...(proxy.protocol === 'https:' ? { servername: proxy.hostname } : {}),
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy ${proxy.hostname}:${port} refused the tunnel to ${target.hostname} (HTTP ${res.statusCode}).`));
        return;
      }
      resolve(socket);
    });
    req.once('timeout', () => { req.destroy(new Error(`Timed out connecting to proxy ${proxy.hostname}:${port}.`)); });
    req.once('error', reject);
    req.end();
  });
}

function targetPort(target) {
  return Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
}

/**
 * Perform one HTTP(S) request.
 * @returns {Promise<{status:number, headers:object, text:string}>}
 */
async function request({ method = 'GET', url, headers = {}, body, timeoutMs = 60000 }) {
  const target = new URL(url);
  const proxy = proxyFor(target);
  const isTls = target.protocol === 'https:';

  const requestOptions = {
    method,
    host: target.hostname,
    port: targetPort(target),
    path: `${target.pathname}${target.search}`,
    headers: { ...headers },
    timeout: timeoutMs,
  };

  if (body !== undefined && body !== null && body !== '') {
    requestOptions.headers['Content-Length'] = Buffer.byteLength(body);
  }

  if (proxy) {
    if (isTls) {
      // CONNECT tunnel, then speak TLS over the tunnelled socket. The TLS handshake has to
      // happen in our own createConnection, otherwise the https agent wraps the (already
      // encrypted) socket a second time and the handshake fails.
      const tunnel = await connectThroughProxy(proxy, target, timeoutMs);
      const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => tls.connect({ socket: tunnel, servername: target.hostname });
      requestOptions.agent = agent;
    } else {
      // Plain HTTP through a proxy is an absolute-form request line.
      requestOptions.host = proxy.hostname;
      requestOptions.port = Number(proxy.port) || 80;
      requestOptions.path = url;
    }
  }

  const transport = isTls ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.once('timeout', () => {
      req.destroy(new Error(`Request to ${target.hostname} timed out after ${timeoutMs}ms.`));
    });
    req.once('error', reject);
    if (body !== undefined && body !== null && body !== '') req.write(body);
    req.end();
  });
}

module.exports = { request, proxyFor, shouldBypassProxy };
