"use strict";
// ============================= JSON-RPC 2.0 endpoint over stdio =============================
// A full JSON-RPC 2.0 peer that speaks the LSP base protocol over any readable +
// writable pair of streams. It is transport-agnostic on purpose: give it the
// stdout/stdin of a spawned language server, OR an in-memory pipe to a mock
// server, and it behaves identically. That is what makes the whole LSP stack
// deterministically testable without a compiler installed.
//
// Responsibilities:
//   * Outbound requests with id correlation and Promise resolution.
//   * Outbound notifications (no reply expected).
//   * Inbound responses -> resolve/reject the matching pending request.
//   * Inbound server->client requests -> dispatch to registered handlers and
//     reply with a result or a JSON-RPC error (defaults keep LSP servers happy).
//   * Inbound notifications -> emit for subscribers (e.g. publishDiagnostics).
//   * Cancellation via AbortSignal -> sends $/cancelRequest and rejects locally.
//   * Per-request timeouts.
//   * Batch sends (array frame) with per-member correlation.
//   * Graceful close: reject every in-flight request, detach listeners.
//
// Zero third-party dependencies — Node stdlib only.

const { EventEmitter } = require("node:events");
const framing = require("./framing");

// Standard JSON-RPC 2.0 error codes plus the LSP-specific ones we may send/see.
const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestCancelled: -32800, // LSP
  ContentModified: -32801, // LSP
};

/**
 * Error thrown when a request's Promise rejects because the remote returned a
 * JSON-RPC error object. Carries the structured code/data for callers.
 */
class RpcError extends Error {
  constructor(error, method) {
    super((error && error.message) || "JSON-RPC error");
    this.name = "RpcError";
    this.code = error && typeof error.code === "number" ? error.code : ErrorCodes.InternalError;
    this.data = error && error.data;
    this.method = method;
  }
}

class JsonRpcEndpoint extends EventEmitter {
  /**
   * @param {object} opts
   * @param {NodeJS.ReadableStream} opts.input  - stream carrying messages FROM the peer
   * @param {NodeJS.WritableStream} opts.output - stream carrying messages TO the peer
   * @param {string} [opts.name] - label for diagnostics
   * @param {number} [opts.defaultTimeout] - ms before an unanswered request rejects (0 = none)
   */
  constructor(opts) {
    super();
    if (!opts || !opts.input || !opts.output) {
      throw new Error("JsonRpcEndpoint requires { input, output } streams");
    }
    this.input = opts.input;
    this.output = opts.output;
    this.name = opts.name || "lsp";
    this.defaultTimeout = typeof opts.defaultTimeout === "number" ? opts.defaultTimeout : 0;
    this._nextId = 0;
    this._pending = new Map(); // id -> { resolve, reject, method, timer, onAbort, signal }
    this._requestHandlers = new Map(); // method -> fn(params, id) => result | Promise
    this._reader = new framing.MessageReader();
    this._closed = false;

    this._onData = (chunk) => this._handleChunk(chunk);
    this._onInputClose = () => this.close(new Error(this.name + ": input stream closed"));
    this.input.on("data", this._onData);
    this.input.on("close", this._onInputClose);
    this.input.on("end", this._onInputClose);
  }

  /**
   * Register a handler for an inbound server->client request method.
   * The handler's return value (awaited) becomes the JSON-RPC result.
   * @param {string} method
   * @param {(params:any,id:(number|string))=>any} handler
   */
  onRequest(method, handler) {
    this._requestHandlers.set(method, handler);
    return this;
  }

  /**
   * Send a request and resolve with its result.
   * @param {string} method
   * @param {any} [params]
   * @param {object} [opts] - { timeout, signal }
   * @returns {Promise<any>}
   */
  request(method, params, opts) {
    opts = opts || {};
    if (this._closed) return Promise.reject(new Error(this.name + ": endpoint closed"));
    const id = ++this._nextId;
    const msg = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null, onAbort: null, signal: opts.signal };
      const timeout = typeof opts.timeout === "number" ? opts.timeout : this.defaultTimeout;
      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          if (!this._pending.has(id)) return;
          this._settle(id, null, { code: ErrorCodes.RequestCancelled, message: "request timed out after " + timeout + "ms" });
          this.cancelRequest(id, { silent: false });
        }, timeout);
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(this._abortError());
          return;
        }
        entry.onAbort = () => {
          if (!this._pending.has(id)) return;
          this.cancelRequest(id);
          this._settle(id, null, { code: ErrorCodes.RequestCancelled, message: "request aborted" });
        };
        opts.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this._pending.set(id, entry);
      try {
        this._write(msg);
      } catch (err) {
        this._settle(id, null, { code: ErrorCodes.InternalError, message: err.message });
      }
    });
  }

  /**
   * Fire a notification (no id, no reply expected).
   * @param {string} method
   * @param {any} [params]
   */
  notify(method, params) {
    if (this._closed) return;
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this._write(msg);
  }

  /**
   * Send a batch (JSON-RPC array frame). Each member may be a request
   * ({method, params}) or notification ({method, params, notify:true}).
   * Requests resolve/reject individually; returns an array of results aligned
   * with the request members (notifications yield undefined slots).
   * @param {Array<{method:string,params?:any,notify?:boolean}>} items
   * @returns {Promise<Array<any>>}
   */
  batch(items) {
    if (this._closed) return Promise.reject(new Error(this.name + ": endpoint closed"));
    const frame = [];
    const promises = [];
    for (const item of items) {
      if (item.notify) {
        const m = { jsonrpc: "2.0", method: item.method };
        if (item.params !== undefined) m.params = item.params;
        frame.push(m);
        promises.push(Promise.resolve(undefined));
        continue;
      }
      const id = ++this._nextId;
      const m = { jsonrpc: "2.0", id, method: item.method };
      if (item.params !== undefined) m.params = item.params;
      frame.push(m);
      promises.push(new Promise((resolve, reject) => {
        this._pending.set(id, { resolve, reject, method: item.method, timer: null, onAbort: null });
      }));
    }
    this._write(frame);
    return Promise.all(promises);
  }

  /**
   * Send $/cancelRequest for an in-flight request id (LSP cancellation).
   * @param {number|string} id
   * @param {object} [opts] - { silent } if true, do not emit
   */
  cancelRequest(id, opts) {
    if (this._closed) return;
    this.notify("$/cancelRequest", { id });
    if (!(opts && opts.silent)) this.emit("cancel", id);
  }

  /** Number of in-flight requests awaiting a response. */
  pendingCount() {
    return this._pending.size;
  }

  /**
   * Close the endpoint: reject all pending requests and detach listeners.
   * @param {Error} [cause]
   */
  close(cause) {
    if (this._closed) return;
    this._closed = true;
    try {
      this.input.removeListener("data", this._onData);
      this.input.removeListener("close", this._onInputClose);
      this.input.removeListener("end", this._onInputClose);
    } catch (_) { /* streams may already be gone */ }
    const err = cause || new Error(this.name + ": endpoint closed");
    for (const [id, entry] of this._pending) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      entry.reject(err);
      this._pending.delete(id);
    }
    this.emit("close", cause);
  }

  // ----- internals -----

  _abortError() {
    const e = new Error("request aborted");
    e.name = "AbortError";
    e.code = ErrorCodes.RequestCancelled;
    return e;
  }

  _write(message) {
    if (this._closed) throw new Error(this.name + ": endpoint closed");
    this.output.write(framing.encodeMessage(message));
  }

  _handleChunk(chunk) {
    const { messages, errors } = this._reader.append(chunk);
    for (const err of errors) this.emit("error", err);
    for (const msg of messages) this._dispatch(msg);
  }

  _dispatch(msg) {
    if (Array.isArray(msg)) {
      for (const m of msg) this._dispatch(m);
      return;
    }
    if (!msg || typeof msg !== "object") {
      this.emit("error", new Error(this.name + ": non-object JSON-RPC message"));
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    const isResponse = hasId && (("result" in msg) || ("error" in msg)) && msg.method === undefined;
    if (isResponse) {
      this._settle(msg.id, msg.result, msg.error);
      return;
    }
    if (typeof msg.method === "string" && hasId) {
      this._handleInboundRequest(msg);
      return;
    }
    if (typeof msg.method === "string") {
      this.emit("notification", { method: msg.method, params: msg.params });
      this.emit("notification:" + msg.method, msg.params);
      return;
    }
    this.emit("error", new Error(this.name + ": unrecognized JSON-RPC message shape"));
  }

  _handleInboundRequest(msg) {
    const handler = this._requestHandlers.get(msg.method);
    this.emit("request", { method: msg.method, params: msg.params, id: msg.id });
    if (!handler) {
      // Harmless LSP server->client requests get benign defaults so the server
      // does not stall waiting for us; everything else is MethodNotFound.
      const fallback = this._defaultResponse(msg.method, msg.params);
      if (fallback.handled) {
        this._reply(msg.id, fallback.result, null);
      } else {
        this._reply(msg.id, null, { code: ErrorCodes.MethodNotFound, message: "method not found: " + msg.method });
      }
      return;
    }
    Promise.resolve()
      .then(() => handler(msg.params, msg.id))
      .then((result) => this._reply(msg.id, result === undefined ? null : result, null))
      .catch((err) => this._reply(msg.id, null, { code: ErrorCodes.InternalError, message: err && err.message }));
  }

  _defaultResponse(method, params) {
    switch (method) {
      case "workspace/configuration":
        // Expected: one entry per requested item; null means "use defaults".
        return { handled: true, result: Array.isArray(params && params.items) ? params.items.map(() => null) : [] };
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        return { handled: true, result: null };
      case "workspace/applyEdit":
        // We did not apply it; report refusal honestly rather than lying success.
        return { handled: true, result: { applied: false } };
      case "window/showMessageRequest":
        return { handled: true, result: null };
      default:
        return { handled: false };
    }
  }

  _reply(id, result, error) {
    if (this._closed) return;
    const msg = { jsonrpc: "2.0", id };
    if (error) msg.error = error; else msg.result = result;
    try { this._write(msg); } catch (_) { /* peer gone */ }
  }

  _settle(id, result, error) {
    const entry = this._pending.get(id);
    if (!entry) return;
    this._pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener("abort", entry.onAbort); } catch (_) { /* noop */ }
    }
    if (error) entry.reject(new RpcError(error, entry.method));
    else entry.resolve(result);
  }
}

module.exports = { JsonRpcEndpoint, RpcError, ErrorCodes };
