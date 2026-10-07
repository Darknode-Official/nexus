"use strict";
// ============================= Mock language server (scripted stdio peer) =============================
// A real language server (tsserver, gopls, ...) is heavy and may be absent in CI,
// which would make protocol tests flaky and environment-dependent. This module is
// a fully scripted JSON-RPC peer that speaks the exact LSP base protocol over an
// in-memory duplex pipe. It lets every transport/lifecycle/feature test run
// deterministically with ZERO external processes.
//
// It is NOT a stub for tests only — it is also how the demo CLI shows the stack
// working when no real server is installed. The real-spawn path lives in
// process.js; this is its interchangeable in-memory twin, connected by the same
// JsonRpcEndpoint.
//
// Zero third-party dependencies — Node stdlib only.

const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const framing = require("./framing");
const proto = require("./protocol");

/**
 * Build a pair of connected in-memory streams representing one duplex channel.
 * The endpoint reads `client.input` / writes `client.output`; the server reads
 * `server.input` / writes `server.output`. They are cross-wired so a write on
 * one side is readable on the other.
 * @returns {{ client:{input:PassThrough,output:PassThrough}, server:{input:PassThrough,output:PassThrough} }}
 */
function createPipe() {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  return {
    client: { input: serverToClient, output: clientToServer },
    server: { input: clientToServer, output: serverToClient },
  };
}

/**
 * A scripted mock language server.
 *
 * Capabilities and canned responses are configurable so tests can exercise the
 * "server supports X / does not support X" branches of the client. The default
 * configuration advertises the common feature set and incremental sync.
 */
class MockServer extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.capabilities] - override the advertised serverCapabilities
   * @param {object} [opts.serverInfo] - { name, version }
   * @param {object} [opts.responses] - method -> (params,id,server)=>result (overrides defaults)
   */
  constructor(opts) {
    super();
    opts = opts || {};
    const pipe = createPipe();
    this.input = pipe.server.input; // client -> server
    this.output = pipe.server.output; // server -> client
    this.clientStreams = pipe.client; // hand to JsonRpcEndpoint { input, output }
    this.reader = new framing.MessageReader();

    this.capabilities = opts.capabilities || defaultCapabilities();
    this.serverInfo = opts.serverInfo || { name: "mock-language-server", version: "1.0.0" };
    this.responses = opts.responses || {};

    this.initialized = false;
    this.shutdownRequested = false;
    this.received = []; // every inbound message, for test assertions
    this.openDocuments = new Map(); // uri -> { version, text }
    this._nextServerRequestId = 10000;

    this.input.on("data", (chunk) => this._onData(chunk));
  }

  /** Streams to pass to `new JsonRpcEndpoint(mock.endpointStreams())`. */
  endpointStreams() {
    return { input: this.clientStreams.input, output: this.clientStreams.output };
  }

  _onData(chunk) {
    const { messages, errors } = this.reader.append(chunk);
    for (const e of errors) this.emit("framingError", e);
    for (const m of messages) this._handle(m);
  }

  _handle(msg) {
    this.received.push(msg);
    this.emit("message", msg);
    if (msg.method && msg.id !== undefined) {
      this._handleRequest(msg);
    } else if (msg.method) {
      this._handleNotification(msg);
    }
    // responses to our server->client requests are ignored by the mock.
  }

  _handleRequest(msg) {
    this.emit("request", msg);
    // Explicit per-test override wins.
    if (typeof this.responses[msg.method] === "function") {
      Promise.resolve(this.responses[msg.method](msg.params, msg.id, this))
        .then((result) => this.respond(msg.id, result))
        .catch((err) => this.respondError(msg.id, { code: -32603, message: String(err && err.message) }));
      return;
    }
    const result = this._defaultRequestResult(msg.method, msg.params);
    if (result && result.__error) this.respondError(msg.id, result.__error);
    else this.respond(msg.id, result === undefined ? null : result);
  }

  _handleNotification(msg) {
    switch (msg.method) {
      case "initialized":
        this.initialized = true;
        this.emit("initialized");
        break;
      case "exit":
        this.emit("exit");
        this.close();
        break;
      case "textDocument/didOpen": {
        const d = msg.params.textDocument;
        this.openDocuments.set(d.uri, { version: d.version, text: d.text });
        this.emit("didOpen", d);
        break;
      }
      case "textDocument/didChange": {
        const { textDocument, contentChanges } = msg.params;
        const doc = this.openDocuments.get(textDocument.uri) || { version: 0, text: "" };
        doc.version = textDocument.version;
        doc.text = applyChanges(doc.text, contentChanges);
        this.openDocuments.set(textDocument.uri, doc);
        this.emit("didChange", msg.params);
        break;
      }
      case "textDocument/didClose":
        this.openDocuments.delete(msg.params.textDocument.uri);
        this.emit("didClose", msg.params);
        break;
      case "$/cancelRequest":
        this.emit("cancel", msg.params && msg.params.id);
        break;
      default:
        this.emit("notification", msg);
    }
  }

  _defaultRequestResult(method, params) {
    switch (method) {
      case "initialize":
        return { capabilities: this.capabilities, serverInfo: this.serverInfo };
      case "shutdown":
        this.shutdownRequested = true;
        return null;
      case "textDocument/hover":
        return { contents: { kind: "markdown", value: "**mock hover** for symbol" }, range: proto.range(0, 0, 0, 4) };
      case "textDocument/definition":
        return [{ uri: params.textDocument.uri, range: proto.range(0, 0, 0, 4) }];
      case "textDocument/references":
        return [
          { uri: params.textDocument.uri, range: proto.range(0, 0, 0, 4) },
          { uri: params.textDocument.uri, range: proto.range(5, 2, 5, 6) },
        ];
      case "textDocument/documentSymbol":
        return [{
          name: "exampleFn", kind: 12, range: proto.range(0, 0, 3, 1), selectionRange: proto.range(0, 9, 0, 18),
          children: [{ name: "inner", kind: 13, range: proto.range(1, 2, 1, 10), selectionRange: proto.range(1, 2, 1, 7), children: [] }],
        }];
      case "workspace/symbol":
        return [{ name: "exampleFn", kind: 12, location: { uri: (params && params.query ? "file:///q.js" : "file:///a.js"), range: proto.range(0, 0, 0, 9) } }];
      case "textDocument/completion":
        return {
          isIncomplete: false,
          items: [
            { label: "exampleFn", kind: 3, detail: "() => void", insertText: "exampleFn" },
            { label: "exampleVar", kind: 6, detail: "number" },
          ],
        };
      case "textDocument/rename":
        return {
          changes: {
            [params.textDocument.uri]: [
              { range: proto.range(0, 9, 0, 18), newText: params.newName },
            ],
          },
        };
      case "textDocument/formatting":
        return [{ range: proto.range(0, 0, 0, 0), newText: "" }];
      case "textDocument/codeAction":
        return [{ title: "Mock quick fix", kind: "quickfix", edit: { changes: {} } }];
      default:
        return { __error: { code: -32601, message: "mock: method not found: " + method } };
    }
  }

  /** Send a response for an inbound request id. */
  respond(id, result) {
    this._send({ jsonrpc: "2.0", id, result });
  }

  /** Send an error response for an inbound request id. */
  respondError(id, error) {
    this._send({ jsonrpc: "2.0", id, error });
  }

  /** Send a notification to the client (e.g. publishDiagnostics). */
  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Convenience: push diagnostics for a URI as the server would after analysis.
   * @param {string} uri
   * @param {Array<object>} diagnostics - raw LSP diagnostics
   */
  publishDiagnostics(uri, diagnostics) {
    this.notify("textDocument/publishDiagnostics", { uri, diagnostics: diagnostics || [] });
  }

  /** Issue a server->client request (e.g. workspace/configuration) and return its id. */
  sendServerRequest(method, params) {
    const id = ++this._nextServerRequestId;
    this._send({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  /** Simulate an abrupt crash: destroy the outbound stream so the client sees close. */
  crash() {
    this.emit("crash");
    try { this.output.destroy(); } catch (_) { /* noop */ }
    try { this.input.destroy(); } catch (_) { /* noop */ }
  }

  /** Graceful close of the mock's streams. */
  close() {
    try { this.output.end(); } catch (_) { /* noop */ }
  }

  _send(message) {
    try { this.output.write(framing.encodeMessage(message)); } catch (_) { /* stream gone */ }
  }
}

/** The default serverCapabilities the mock advertises. */
function defaultCapabilities() {
  return {
    textDocumentSync: { openClose: true, change: proto.TextDocumentSyncKind.Incremental },
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    completionProvider: { triggerCharacters: ["."] },
    renameProvider: { prepareProvider: true },
    documentFormattingProvider: true,
    codeActionProvider: true,
  };
}

/** Apply LSP contentChanges to a text buffer (supports full + incremental). */
function applyChanges(text, changes) {
  let out = text;
  for (const ch of changes || []) {
    if (!ch.range) {
      out = ch.text; // full replacement
      continue;
    }
    const startOff = positionToOffset(out, ch.range.start);
    const endOff = positionToOffset(out, ch.range.end);
    out = out.slice(0, startOff) + ch.text + out.slice(endOff);
  }
  return out;
}

/** Inverse of protocol.offsetToPosition: {line,character} -> absolute offset. */
function positionToOffset(text, pos) {
  let line = 0;
  let i = 0;
  while (line < pos.line && i < text.length) {
    if (text.charCodeAt(i) === 10) line++;
    i++;
  }
  return i + pos.character;
}

module.exports = { MockServer, createPipe, defaultCapabilities, applyChanges, positionToOffset };
