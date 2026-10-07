"use strict";
// ============================= Connection / agent pooling =============================
// Keep-alive HTTP(S) connection pooling for Nexus engine/tool API calls, stdlib-only.
// Node's http.Agent already multiplexes sockets per host:port when keepAlive is on; this
// module wraps that into a managed pool with sane bounds, a request helper that reuses the
// right agent by protocol, retry/backoff for idempotent calls, and live socket metrics so
// pool pressure is visible. Reusing warm TCP+TLS sockets removes handshake latency from
// every call after the first — the dominant cost when a tool hits the same endpoint
// repeatedly. One pool per Nexus process is the intended usage.

const http = require("http");
const https = require("https");
const { URL } = require("url");

/**
 * createPool(options)
 *   maxSockets        max concurrent sockets per host (default 16)
 *   maxFreeSockets    max idle kept-alive sockets per host (default 8)
 *   keepAliveMsecs    TCP keep-alive probe interval (default 1000)
 *   timeout           socket inactivity timeout ms (default 30000)
 *   maxTotalSockets   hard cap across all hosts (default 256)
 * Returns { request, json, agentFor, stats, destroy, http: Agent, https: Agent }.
 */
function createPool(options) {
  const o = options || {};
  const agentOpts = {
    keepAlive: true,
    maxSockets: o.maxSockets || 16,
    maxFreeSockets: o.maxFreeSockets || 8,
    keepAliveMsecs: o.keepAliveMsecs || 1000,
    maxTotalSockets: o.maxTotalSockets || 256,
    scheduling: "lifo", // reuse the hottest socket first → better keep-alive locality
    timeout: o.timeout || 30000,
  };
  const httpAgent = new http.Agent(agentOpts);
  const httpsAgent = new https.Agent(agentOpts);
  const defaultTimeout = o.timeout || 30000;

  const m = { requests: 0, reused: 0, created: 0, errors: 0, retries: 0, bytesIn: 0, bytesOut: 0 };
  // Count socket reuse vs fresh connects for an honest reuse ratio.
  for (const ag of [httpAgent, httpsAgent]) {
    ag.on("free", () => {});
    ag.on("keylog", () => {});
  }

  function agentFor(protocol) { return protocol === "https:" ? httpsAgent : httpAgent; }

  /**
   * request(url, opts) — one HTTP(S) request over the pool.
   *   opts.method, opts.headers, opts.body (string|Buffer), opts.signal (AbortSignal),
   *   opts.timeout (ms). Resolves { status, headers, body (string), url }. Rejects on
   *   network error, abort, or timeout. Does NOT throw on non-2xx — inspect status.
   */
  function request(url, opts) {
    const options2 = opts || {};
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (e) { return reject(new Error("Invalid URL: " + url)); }
      const lib = u.protocol === "https:" ? https : http;
      const agent = agentFor(u.protocol);
      const signal = options2.signal;
      if (signal && signal.aborted) { const e = new Error("Request aborted"); e.name = "AbortError"; return reject(e); }

      m.requests++;
      const body = options2.body != null ? (Buffer.isBuffer(options2.body) ? options2.body : Buffer.from(String(options2.body))) : null;
      const headers = Object.assign({}, options2.headers);
      if (body && headers["content-length"] == null && headers["Content-Length"] == null) headers["Content-Length"] = body.length;

      const req = lib.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: options2.method || "GET", headers, agent,
      });

      // Reuse detection: 'socket' fires with a socket; if it's already connected it was reused.
      req.on("socket", (socket) => {
        if (socket.reusedSocket || (socket.connecting === false && !socket.pending)) m.reused++; else m.created++;
      });

      let onAbort = null;
      if (signal) { onAbort = () => { req.destroy(Object.assign(new Error("Request aborted"), { name: "AbortError" })); }; signal.addEventListener("abort", onAbort, { once: true }); }

      const to = options2.timeout || defaultTimeout;
      req.setTimeout(to, () => { req.destroy(Object.assign(new Error("Request timed out after " + to + "ms"), { name: "TimeoutError", code: "ETIMEDOUT" })); });

      req.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => { chunks.push(c); m.bytesIn += c.length; });
        res.on("end", () => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), url });
        });
      });
      req.on("error", (err) => { m.errors++; if (signal && onAbort) signal.removeEventListener("abort", onAbort); reject(err); });

      if (body) { req.write(body); m.bytesOut += body.length; }
      req.end();
    });
  }

  /**
   * json(url, opts) — request + JSON encode/decode. opts.json sets the request body (and
   * Content-Type). Resolves { status, headers, data }. Throws on invalid JSON response.
   */
  async function json(url, opts) {
    const o2 = Object.assign({}, opts);
    o2.headers = Object.assign({ Accept: "application/json" }, o2.headers);
    if (o2.json !== undefined) { o2.body = JSON.stringify(o2.json); o2.headers["Content-Type"] = "application/json"; delete o2.json; }
    const res = await request(url, o2);
    let data = null;
    if (res.body) { try { data = JSON.parse(res.body); } catch (e) { const err = new Error("Invalid JSON response (status " + res.status + ")"); err.status = res.status; err.body = res.body.slice(0, 500); throw err; } }
    return { status: res.status, headers: res.headers, data };
  }

  /**
   * withRetry(fn, options) — retry an idempotent async op with exponential backoff + jitter.
   *   retries (default 3), baseDelay ms (default 100), maxDelay ms (default 2000),
   *   shouldRetry(err, attempt) => bool (default: retry network/5xx-ish, never AbortError).
   */
  async function withRetry(fn, options) {
    const r = options || {};
    const retries = r.retries != null ? r.retries : 3;
    const base = r.baseDelay || 100, maxDelay = r.maxDelay || 2000;
    const shouldRetry = r.shouldRetry || ((err) => err && err.name !== "AbortError");
    let attempt = 0, lastErr;
    for (;;) {
      try { return await fn(attempt); }
      catch (err) {
        lastErr = err;
        if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
        m.retries++;
        const delay = Math.min(maxDelay, base * Math.pow(2, attempt)) * (0.5 + Math.random() * 0.5);
        await new Promise((res) => { setTimeout(res, delay); });
        attempt++;
      }
    }
    throw lastErr; // unreachable
  }

  function socketCounts(agent) {
    const count = (obj) => { let n = 0; if (obj) for (const k in obj) n += Array.isArray(obj[k]) ? obj[k].length : 0; return n; };
    return { active: count(agent.sockets), free: count(agent.freeSockets), queued: count(agent.requests) };
  }

  return {
    request, json, withRetry, agentFor,
    http: httpAgent, https: httpsAgent,
    stats() {
      const total = m.reused + m.created;
      return Object.assign({}, m, {
        reuseRate: total ? +(m.reused / total).toFixed(4) : 0,
        sockets: { http: socketCounts(httpAgent), https: socketCounts(httpsAgent) },
      });
    },
    destroy() { httpAgent.destroy(); httpsAgent.destroy(); },
  };
}

module.exports = { createPool };
