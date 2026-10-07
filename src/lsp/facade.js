"use strict";
// ============================= NexusLsp façade =============================
// The one object the rest of the agent talks to. It hides every LSP internal:
// pick the right server for a file, confirm it is installed (or report exactly
// what is missing), spawn + initialize it once and reuse it, open/sync documents
// automatically, and answer high-level questions — "diagnostics for this file",
// "where is X defined / used", "rename X" — as plain normalized objects.
//
// Graceful degradation is a first-class result, not an exception: when no server
// is installed every method returns { available:false, reason, installHint, ... }
// so callers can fall back to codegraph's heuristics and tell the user precisely
// what to install (NX-107).
//
// The connection factory is injectable, so tests drive the whole façade against
// the in-memory MockServer with no child process at all; the default factory is
// the real spawn path.
//
// Zero third-party dependencies — Node stdlib only.

const fs = require("node:fs");
const path = require("node:path");
const registry = require("./registry");
const { LspClient } = require("./client");
const { ManagedServer } = require("./process");

class NexusLsp {
  /**
   * @param {object} [opts]
   * @param {string} [opts.cwd] - workspace root
   * @param {object} [opts.env]
   * @param {number} [opts.requestTimeout]
   * @param {function} [opts.connect] - async (serverDef, ctx) => { client, dispose }
   *        Override to inject a mock transport in tests. Default = real spawn.
   */
  constructor(opts) {
    opts = opts || {};
    this.cwd = opts.cwd || process.cwd();
    this.env = opts.env || process.env;
    this.requestTimeout = opts.requestTimeout;
    this._connect = opts.connect || this._defaultConnect.bind(this);
    this._connections = new Map(); // serverId -> { client, dispose, serverDef }
    this._connecting = new Map(); // serverId -> Promise (dedupe concurrent connects)
  }

  /**
   * Resolve (and lazily create) a ready LspClient for a file. Never throws for
   * the "not installed" case — returns a structured availability result instead.
   * @param {string} filePath
   * @returns {Promise<{available:boolean, client?:LspClient, serverId?:string, reason:string, installHint?:string, candidates?:Array}>}
   */
  async clientForFile(filePath) {
    const det = registry.detect({ filePath, env: this.env });
    if (!det.available) {
      return {
        available: false,
        reason: det.reason,
        installHint: det.candidates[0] ? det.candidates[0].installHint : null,
        candidates: det.candidates,
      };
    }
    const serverDef = registry.SERVERS.find((s) => s.id === det.chosen.id);
    try {
      const client = await this._ensureConnection(serverDef);
      return { available: true, client, serverId: serverDef.id, reason: det.reason };
    } catch (err) {
      return {
        available: false,
        reason: "failed to start " + serverDef.id + ": " + (err && err.message),
        installHint: serverDef.installHint,
        candidates: det.candidates,
      };
    }
  }

  async _ensureConnection(serverDef) {
    const existing = this._connections.get(serverDef.id);
    if (existing) return existing.client;
    if (this._connecting.has(serverDef.id)) return this._connecting.get(serverDef.id);

    const p = Promise.resolve()
      .then(() => this._connect(serverDef, { cwd: this.cwd, env: this.env, requestTimeout: this.requestTimeout }))
      .then((conn) => {
        this._connections.set(serverDef.id, Object.assign({ serverDef }, conn));
        this._connecting.delete(serverDef.id);
        return conn.client;
      })
      .catch((err) => {
        this._connecting.delete(serverDef.id);
        throw err;
      });
    this._connecting.set(serverDef.id, p);
    return p;
  }

  /** Default (real) connection: spawn the server, wire an LspClient, initialize. */
  async _defaultConnect(serverDef, ctx) {
    const managed = new ManagedServer({
      command: serverDef.command,
      args: serverDef.args,
      cwd: ctx.cwd,
      env: ctx.env,
    });
    const streams = managed.start(); // throws ESERVERMISSING if binary absent
    const client = new LspClient({
      input: streams.input,
      output: streams.output,
      rootPath: ctx.cwd,
      name: serverDef.id,
      requestTimeout: ctx.requestTimeout,
    });
    await client.initialize();
    return {
      client,
      dispose: async () => {
        try { await client.shutdown(); } catch (_) { /* noop */ }
        managed.stop();
      },
    };
  }

  _readText(filePath, provided) {
    if (typeof provided === "string") return provided;
    return fs.readFileSync(filePath, "utf8");
  }

  _degraded(avail) {
    return { available: false, reason: avail.reason, installHint: avail.installHint, candidates: avail.candidates };
  }

  /**
   * Diagnostics for a file: opens/syncs it, waits for the server's first push,
   * returns normalized diagnostics. Degrades to { available:false } with a clear
   * reason when no server is installed.
   * @param {string} filePath
   * @param {object} [opts] - { text, timeout }
   */
  async diagnostics(filePath, opts) {
    opts = opts || {};
    const avail = await this.clientForFile(filePath);
    if (!avail.available) return this._degraded(avail);
    const client = avail.client;
    const text = this._readText(filePath, opts.text);
    const languageId = registry.languageIdForPath(filePath) || "plaintext";
    client.ensureOpen(filePath, text, languageId);
    const diagnostics = await client.waitForDiagnostics(filePath, { timeout: opts.timeout });
    return { available: true, serverId: avail.serverId, path: filePath, diagnostics };
  }

  async _withOpenDoc(filePath, opts, fn) {
    const avail = await this.clientForFile(filePath);
    if (!avail.available) return this._degraded(avail);
    const client = avail.client;
    const text = this._readText(filePath, opts && opts.text);
    const languageId = registry.languageIdForPath(filePath) || "plaintext";
    client.ensureOpen(filePath, text, languageId);
    const result = await fn(client);
    return Object.assign({ available: true, serverId: avail.serverId }, result);
  }

  /** Hover at a position. */
  async hover(filePath, position, opts) {
    return this._withOpenDoc(filePath, opts, async (c) => ({ hover: await c.hover(filePath, position) }));
  }

  /** Definition locations for the symbol at a position. */
  async definition(filePath, position, opts) {
    return this._withOpenDoc(filePath, opts, async (c) => ({ locations: await c.definition(filePath, position) }));
  }

  /** Reference locations for the symbol at a position. */
  async references(filePath, position, opts) {
    return this._withOpenDoc(filePath, opts, async (c) => ({
      locations: await c.references(filePath, position, { includeDeclaration: !(opts && opts.includeDeclaration === false) }),
    }));
  }

  /** Document symbol outline. */
  async documentSymbols(filePath, opts) {
    return this._withOpenDoc(filePath, opts, async (c) => ({ symbols: await c.documentSymbols(filePath) }));
  }

  /** Completion proposals at a position. */
  async completion(filePath, position, opts) {
    return this._withOpenDoc(filePath, opts, async (c) => ({ completion: await c.completion(filePath, position, opts) }));
  }

  /** Rename the symbol at a position across the workspace. */
  async rename(filePath, position, newName, opts) {
    return this._withOpenDoc(filePath, opts, async (c) => ({ rename: await c.rename(filePath, position, newName) }));
  }

  /** Format a whole document; returns the proposed TextEdits. */
  async formatting(filePath, options, opts) {
    return this._withOpenDoc(filePath, opts, async (c) => ({ edits: await c.formatting(filePath, options) }));
  }

  /**
   * Workspace-wide symbol search. Picks any installed server (optionally scoped
   * by a representative file extension via opts.forFile).
   * @param {string} query
   * @param {object} [opts] - { forFile }
   */
  async workspaceSymbols(query, opts) {
    opts = opts || {};
    let det;
    if (opts.forFile) det = registry.detect({ filePath: opts.forFile, env: this.env });
    else det = registry.detect({ env: this.env });
    if (!det.available) return { available: false, reason: det.reason };
    const serverDef = registry.SERVERS.find((s) => s.id === det.chosen.id);
    try {
      const client = await this._ensureConnection(serverDef);
      return { available: true, serverId: serverDef.id, symbols: await client.workspaceSymbols(query) };
    } catch (err) {
      return { available: false, reason: "failed to start " + serverDef.id + ": " + (err && err.message) };
    }
  }

  /**
   * Availability snapshot for every known server (what is installed, what to
   * install). Useful for `nexus lsp info`.
   */
  info() {
    return { cwd: this.cwd, servers: registry.listAll({ env: this.env }) };
  }

  /** Shut down and release every live connection. */
  async dispose() {
    const disposals = [];
    for (const [, conn] of this._connections) {
      if (typeof conn.dispose === "function") disposals.push(Promise.resolve().then(conn.dispose));
    }
    this._connections.clear();
    await Promise.all(disposals);
  }
}

module.exports = { NexusLsp };
