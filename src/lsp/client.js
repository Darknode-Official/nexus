"use strict";
// ============================= LSP client =============================
// Drives one language server connection end to end on top of a JsonRpcEndpoint:
//   * Lifecycle: initialize -> initialized -> (work) -> shutdown -> exit, with
//     capability negotiation (we remember what the server actually supports).
//   * Document sync: didOpen / didChange (incremental when the server allows it,
//     else full) / didClose, with per-document version tracking.
//   * Diagnostics: subscribes to textDocument/publishDiagnostics, caches the
//     latest set per URI, and lets callers await the next batch for a file.
//   * Feature wrappers: hover, definition, references, documentSymbol,
//     workspaceSymbol, completion, rename, formatting, codeAction — each
//     capability-checked and normalized into plain objects via protocol.js.
//
// The client is transport-agnostic: hand it endpoint streams from a real spawned
// server (process.js) OR from the in-memory MockServer (mock.js). Identical code.
//
// Zero third-party dependencies — Node stdlib only.

const { EventEmitter } = require("node:events");
const { JsonRpcEndpoint } = require("./rpc");
const proto = require("./protocol");

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    completion: { completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"] } },
    rename: { prepareSupport: true },
    formatting: {},
    codeAction: {},
    publishDiagnostics: { relatedInformation: true },
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    symbol: {},
    applyEdit: false,
  },
  window: { workDoneProgress: true },
};

class LspClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {NodeJS.ReadableStream} opts.input
   * @param {NodeJS.WritableStream} opts.output
   * @param {string} [opts.rootPath] - workspace root (filesystem path)
   * @param {string} [opts.name]
   * @param {number} [opts.requestTimeout] - default per-request timeout (ms)
   */
  constructor(opts) {
    super();
    opts = opts || {};
    this.name = opts.name || "lsp-client";
    this.rootPath = opts.rootPath || process.cwd();
    this.endpoint = new JsonRpcEndpoint({
      input: opts.input,
      output: opts.output,
      name: this.name,
      defaultTimeout: typeof opts.requestTimeout === "number" ? opts.requestTimeout : 15000,
    });

    this.serverCapabilities = null;
    this.serverInfo = null;
    this.state = "created"; // created -> initializing -> ready -> shuttingDown -> stopped
    this.documents = new Map(); // uri -> { version, text, languageId }
    this.diagnostics = new Map(); // uri -> normalized diagnostics array
    this._diagWaiters = new Map(); // uri -> [{resolve, timer}]

    this.endpoint.on("notification:textDocument/publishDiagnostics", (params) => this._onDiagnostics(params));
    this.endpoint.on("notification", (n) => this.emit("notification", n));
    this.endpoint.on("error", (e) => this.emit("error", e));
    this.endpoint.on("close", (c) => {
      if (this.state !== "stopped") {
        this.state = "stopped";
        this.emit("close", c);
      }
    });
  }

  // ---------------- lifecycle ----------------

  /**
   * Perform the initialize/initialized handshake and remember capabilities.
   * @param {object} [params] - override/augment initialize params
   * @returns {Promise<object>} the server's InitializeResult
   */
  async initialize(params) {
    if (this.state !== "created") throw new Error(this.name + ": already initialized (state=" + this.state + ")");
    this.state = "initializing";
    const initParams = Object.assign({
      processId: process.pid,
      clientInfo: { name: "nexus-lsp", version: "1.0.0" },
      rootUri: proto.pathToUri(this.rootPath),
      rootPath: this.rootPath,
      workspaceFolders: [{ uri: proto.pathToUri(this.rootPath), name: "root" }],
      capabilities: CLIENT_CAPABILITIES,
    }, params || {});

    const result = await this.endpoint.request("initialize", initParams);
    this.serverCapabilities = (result && result.capabilities) || {};
    this.serverInfo = (result && result.serverInfo) || null;
    this.endpoint.notify("initialized", {});
    this.state = "ready";
    this.emit("ready", result);
    return result;
  }

  /** Whether the server advertised support for a named provider capability. */
  supports(capability) {
    const cap = this.serverCapabilities && this.serverCapabilities[capability];
    return cap !== undefined && cap !== false && cap !== null;
  }

  /** Resolve the negotiated textDocumentSync change kind (None/Full/Incremental). */
  syncKind() {
    const sync = this.serverCapabilities && this.serverCapabilities.textDocumentSync;
    if (sync == null) return proto.TextDocumentSyncKind.None;
    if (typeof sync === "number") return sync;
    return typeof sync.change === "number" ? sync.change : proto.TextDocumentSyncKind.None;
  }

  /**
   * Graceful shutdown: shutdown request, then exit notification, then close.
   * Safe to call multiple times.
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this.state === "stopped" || this.state === "shuttingDown") return;
    this.state = "shuttingDown";
    try {
      if (this.serverCapabilities) await this.endpoint.request("shutdown", null, { timeout: 5000 });
    } catch (_) { /* server may be unresponsive; proceed to exit anyway */ }
    try { this.endpoint.notify("exit"); } catch (_) { /* noop */ }
    this.endpoint.close();
    this.state = "stopped";
  }

  // ---------------- document sync ----------------

  /**
   * Open a document on the server (didOpen). Version starts at 1.
   * @param {string} filePath
   * @param {string} text
   * @param {string} [languageId]
   * @returns {object} the tracked document record
   */
  openDocument(filePath, text, languageId) {
    const uri = proto.pathToUri(filePath);
    const doc = { uri, version: 1, text, languageId: languageId || "plaintext" };
    this.documents.set(uri, doc);
    this.endpoint.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: doc.languageId, version: doc.version, text },
    });
    return doc;
  }

  /**
   * Update an open document (didChange). Sends an incremental change when the
   * server negotiated incremental sync, otherwise a full-text change. Bumps the
   * tracked version. No-op when text is unchanged.
   * @param {string} filePath
   * @param {string} newText
   * @returns {object|null} the updated record, or null if nothing changed/not open
   */
  changeDocument(filePath, newText) {
    const uri = proto.pathToUri(filePath);
    const doc = this.documents.get(uri);
    if (!doc) throw new Error(this.name + ": changeDocument on a document that is not open: " + filePath);
    if (doc.text === newText) return null;

    let contentChanges;
    if (this.syncKind() === proto.TextDocumentSyncKind.Incremental) {
      const change = proto.computeIncrementalChange(doc.text, newText);
      contentChanges = change ? [change] : [];
    } else {
      contentChanges = [{ text: newText }];
    }
    doc.version += 1;
    doc.text = newText;
    this.endpoint.notify("textDocument/didChange", {
      textDocument: { uri, version: doc.version },
      contentChanges,
    });
    return doc;
  }

  /**
   * Close a document (didClose).
   * @param {string} filePath
   */
  closeDocument(filePath) {
    const uri = proto.pathToUri(filePath);
    if (!this.documents.has(uri)) return;
    this.documents.delete(uri);
    this.endpoint.notify("textDocument/didClose", { textDocument: { uri } });
  }

  /** Ensure a file is open with the given text; opens or updates as needed. */
  ensureOpen(filePath, text, languageId) {
    const uri = proto.pathToUri(filePath);
    if (!this.documents.has(uri)) return this.openDocument(filePath, text, languageId);
    return this.changeDocument(filePath, text) || this.documents.get(uri);
  }

  // ---------------- diagnostics ----------------

  _onDiagnostics(params) {
    if (!params || !params.uri) return;
    const normalized = (params.diagnostics || []).map(proto.normalizeDiagnostic);
    this.diagnostics.set(params.uri, normalized);
    this.emit("diagnostics", { uri: params.uri, path: proto.uriToPath(params.uri), diagnostics: normalized });
    const waiters = this._diagWaiters.get(params.uri);
    if (waiters) {
      this._diagWaiters.delete(params.uri);
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve(normalized);
      }
    }
  }

  /** Last-known diagnostics for a file (possibly empty). */
  getDiagnostics(filePath) {
    return this.diagnostics.get(proto.pathToUri(filePath)) || [];
  }

  /**
   * Await the next publishDiagnostics for a file. Resolves with cached ones
   * immediately only if `useCached` is set; otherwise waits for a fresh push.
   * @param {string} filePath
   * @param {object} [opts] - { timeout, useCached }
   * @returns {Promise<Array<object>>}
   */
  waitForDiagnostics(filePath, opts) {
    opts = opts || {};
    const uri = proto.pathToUri(filePath);
    if (opts.useCached && this.diagnostics.has(uri)) return Promise.resolve(this.diagnostics.get(uri));
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      const timeout = typeof opts.timeout === "number" ? opts.timeout : 5000;
      if (timeout > 0) {
        waiter.timer = setTimeout(() => {
          const list = this._diagWaiters.get(uri);
          if (list) {
            const idx = list.indexOf(waiter);
            if (idx >= 0) list.splice(idx, 1);
          }
          resolve(this.diagnostics.get(uri) || []);
        }, timeout);
      }
      const arr = this._diagWaiters.get(uri) || [];
      arr.push(waiter);
      this._diagWaiters.set(uri, arr);
    });
  }

  // ---------------- feature wrappers ----------------

  _unsupported(capability) {
    return { unsupported: true, capability, reason: "server does not advertise " + capability };
  }

  _docPosition(filePath, position) {
    return { textDocument: { uri: proto.pathToUri(filePath) }, position };
  }

  /** Hover at a position -> { contents, range } | unsupported marker. */
  async hover(filePath, position, opts) {
    if (!this.supports("hoverProvider")) return this._unsupported("hoverProvider");
    const r = await this.endpoint.request("textDocument/hover", this._docPosition(filePath, position), opts);
    return proto.normalizeHover(r);
  }

  /** Go to definition -> array of normalized locations. */
  async definition(filePath, position, opts) {
    if (!this.supports("definitionProvider")) return this._unsupported("definitionProvider");
    const r = await this.endpoint.request("textDocument/definition", this._docPosition(filePath, position), opts);
    return proto.normalizeLocations(r);
  }

  /** Find references -> array of normalized locations. */
  async references(filePath, position, opts) {
    if (!this.supports("referencesProvider")) return this._unsupported("referencesProvider");
    const includeDeclaration = !(opts && opts.includeDeclaration === false);
    const params = Object.assign(this._docPosition(filePath, position), { context: { includeDeclaration } });
    const r = await this.endpoint.request("textDocument/references", params, opts);
    return proto.normalizeLocations(r);
  }

  /** Document symbols -> normalized (nested) symbol tree. */
  async documentSymbols(filePath, opts) {
    if (!this.supports("documentSymbolProvider")) return this._unsupported("documentSymbolProvider");
    const r = await this.endpoint.request("textDocument/documentSymbol", { textDocument: { uri: proto.pathToUri(filePath) } }, opts);
    return proto.normalizeSymbols(r);
  }

  /** Workspace symbol search -> normalized symbols. */
  async workspaceSymbols(query, opts) {
    if (!this.supports("workspaceSymbolProvider")) return this._unsupported("workspaceSymbolProvider");
    const r = await this.endpoint.request("workspace/symbol", { query: query || "" }, opts);
    return proto.normalizeSymbols(r);
  }

  /** Completion at a position -> { isIncomplete, items }. */
  async completion(filePath, position, opts) {
    if (!this.supports("completionProvider")) return this._unsupported("completionProvider");
    const params = Object.assign(this._docPosition(filePath, position), {
      context: { triggerKind: (opts && opts.triggerKind) || proto.CompletionTriggerKind.Invoked },
    });
    const r = await this.endpoint.request("textDocument/completion", params, opts);
    return proto.normalizeCompletion(r);
  }

  /** Rename a symbol -> normalized per-file WorkspaceEdit. */
  async rename(filePath, position, newName, opts) {
    if (!this.supports("renameProvider")) return this._unsupported("renameProvider");
    const params = Object.assign(this._docPosition(filePath, position), { newName });
    const r = await this.endpoint.request("textDocument/rename", params, opts);
    return { newName, changes: proto.normalizeWorkspaceEdit(r) };
  }

  /** Format a whole document -> array of TextEdits. */
  async formatting(filePath, options, opts) {
    if (!this.supports("documentFormattingProvider")) return this._unsupported("documentFormattingProvider");
    const params = {
      textDocument: { uri: proto.pathToUri(filePath) },
      options: Object.assign({ tabSize: 2, insertSpaces: true }, options || {}),
    };
    const r = await this.endpoint.request("textDocument/formatting", params, opts);
    return Array.isArray(r) ? r : [];
  }

  /** Code actions for a range -> array of actions (title/kind/edit). */
  async codeAction(filePath, range, context, opts) {
    if (!this.supports("codeActionProvider")) return this._unsupported("codeActionProvider");
    const params = {
      textDocument: { uri: proto.pathToUri(filePath) },
      range,
      context: Object.assign({ diagnostics: [] }, context || {}),
    };
    const r = await this.endpoint.request("textDocument/codeAction", params, opts);
    return (Array.isArray(r) ? r : []).map((a) => ({
      title: a.title,
      kind: a.kind || null,
      isPreferred: !!a.isPreferred,
      edit: a.edit ? proto.normalizeWorkspaceEdit(a.edit) : null,
      command: a.command || null,
    }));
  }
}

module.exports = { LspClient, CLIENT_CAPABILITIES };
