"use strict";
// ============================= Managed server process (real spawn) =============================
// The REAL-SPAWN side of the transport, cleanly separated from the mock-tested
// protocol logic. It launches a language-server child process, exposes its
// stdout/stdin as the { input, output } pair an LspClient/JsonRpcEndpoint needs,
// surfaces stderr for diagnostics, enforces a startup timeout, and restarts the
// child on crash with bounded exponential backoff.
//
// This module does real I/O (child_process). It is exercised by the integration
// path, not the deterministic unit tests — those use mock.js instead. Keeping
// the two apart is deliberate so the protocol suite never depends on a compiler
// being installed.
//
// Zero third-party dependencies — Node stdlib only.

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const registry = require("./registry");

class ManagedServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.command - executable (looked up on PATH)
   * @param {string[]} [opts.args]
   * @param {string} [opts.cwd]
   * @param {object} [opts.env]
   * @param {number} [opts.maxRestarts] - default 3
   * @param {number} [opts.restartBaseDelay] - ms, default 500
   * @param {number} [opts.startupTimeout] - ms to consider the spawn healthy, default 10000
   */
  constructor(opts) {
    super();
    if (!opts || !opts.command) throw new Error("ManagedServer requires { command }");
    this.command = opts.command;
    this.args = opts.args || [];
    this.cwd = opts.cwd || process.cwd();
    this.env = opts.env || process.env;
    this.maxRestarts = typeof opts.maxRestarts === "number" ? opts.maxRestarts : 3;
    this.restartBaseDelay = typeof opts.restartBaseDelay === "number" ? opts.restartBaseDelay : 500;
    this.startupTimeout = typeof opts.startupTimeout === "number" ? opts.startupTimeout : 10000;

    this.child = null;
    this.restarts = 0;
    this.stopped = false;
    this.lastStderr = "";
    this._startupTimer = null;
  }

  /**
   * Verify the executable exists before attempting a spawn. Returns a clear,
   * structured result so the facade/CLI can report precisely what is missing
   * (NX-107) rather than surfacing a raw ENOENT.
   * @returns {{ ok:boolean, resolvedPath:(string|null), reason:string }}
   */
  preflight() {
    const resolved = registry.resolveExecutable(this.command, { env: this.env });
    if (!resolved) {
      return { ok: false, resolvedPath: null, reason: "'" + this.command + "' is not installed / not on PATH" };
    }
    return { ok: true, resolvedPath: resolved, reason: "found at " + resolved };
  }

  /**
   * Spawn the child. Throws (with a clear message) if the binary is missing.
   * @returns {{ input:NodeJS.ReadableStream, output:NodeJS.WritableStream }}
   */
  start() {
    const pre = this.preflight();
    if (!pre.ok) {
      const err = new Error(pre.reason);
      err.code = "ESERVERMISSING";
      throw err;
    }
    this.stopped = false;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (err) => this.emit("error", err));
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => {
        this.lastStderr = (this.lastStderr + d).slice(-8192);
        this.emit("stderr", d);
      });
    }
    child.on("exit", (code, signal) => this._onExit(code, signal));

    // Startup health: if the process dies within the window, that is a failed start.
    this._startupTimer = setTimeout(() => { this._startupTimer = null; this.emit("healthy"); }, this.startupTimeout);
    if (this._startupTimer.unref) this._startupTimer.unref();

    this.emit("start", { pid: child.pid, resolvedPath: pre.resolvedPath });
    return { input: child.stdout, output: child.stdin };
  }

  _onExit(code, signal) {
    if (this._startupTimer) { clearTimeout(this._startupTimer); this._startupTimer = null; }
    this.emit("exit", { code, signal, stderr: this.lastStderr });
    this.child = null;
    if (this.stopped) return;
    // Unplanned exit -> attempt a bounded restart.
    if (this.restarts < this.maxRestarts) {
      const delay = this.restartBaseDelay * Math.pow(2, this.restarts);
      this.restarts += 1;
      const timer = setTimeout(() => {
        if (this.stopped) return;
        try {
          const streams = this.start();
          this.emit("restart", { attempt: this.restarts, streams });
        } catch (err) {
          this.emit("error", err);
        }
      }, delay);
    } else {
      this.emit("giveup", { restarts: this.restarts, stderr: this.lastStderr });
    }
  }

  /** Reset the restart counter (call after a confirmed-healthy run). */
  markHealthy() {
    this.restarts = 0;
  }

  /** Stop the child for good (no restart). */
  stop(signal) {
    this.stopped = true;
    if (this._startupTimer) { clearTimeout(this._startupTimer); this._startupTimer = null; }
    if (this.child) {
      try { this.child.kill(signal || "SIGTERM"); } catch (_) { /* already gone */ }
    }
  }
}

/**
 * Build a ManagedServer from a registry server definition.
 * @param {object} serverDef - entry from registry.SERVERS
 * @param {object} [opts] - { cwd, env, maxRestarts, startupTimeout }
 * @returns {ManagedServer}
 */
function fromRegistry(serverDef, opts) {
  opts = opts || {};
  return new ManagedServer({
    command: serverDef.command,
    args: serverDef.args,
    cwd: opts.cwd,
    env: opts.env,
    maxRestarts: opts.maxRestarts,
    startupTimeout: opts.startupTimeout,
    restartBaseDelay: opts.restartBaseDelay,
  });
}

module.exports = { ManagedServer, fromRegistry };
