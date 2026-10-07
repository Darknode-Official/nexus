"use strict";
// Tests for the real-spawn ManagedServer. We cannot assume a language server is
// installed, so these use `node` itself (always present) as a controllable child
// process: a long-lived stub to test spawn/stop, and an immediately-exiting stub
// to test bounded restart-with-backoff and the final giveup. The missing-binary
// path is tested directly (no spawn).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ManagedServer } = require("../../src/lsp/process");

describe("process — preflight / missing binary (NX-107)", () => {
  it("preflight reports a clear reason when the binary is absent", () => {
    const m = new ManagedServer({ command: "definitely-not-a-real-langserver-xyz" });
    const pre = m.preflight();
    assert.equal(pre.ok, false);
    assert.match(pre.reason, /not installed|not on PATH/);
  });

  it("start() throws ESERVERMISSING rather than a raw ENOENT", () => {
    const m = new ManagedServer({ command: "definitely-not-a-real-langserver-xyz" });
    assert.throws(() => m.start(), (err) => {
      assert.equal(err.code, "ESERVERMISSING");
      return true;
    });
  });

  it("preflight resolves `node` which is always installed", () => {
    const m = new ManagedServer({ command: process.execPath });
    const pre = m.preflight();
    assert.equal(pre.ok, true);
    assert.ok(pre.resolvedPath);
  });
});

describe("process — spawn and stop a live child", () => {
  it("spawns a long-lived child and exposes its stdio streams", async () => {
    const m = new ManagedServer({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); setInterval(()=>{}, 1000);"],
    });
    const started = new Promise((resolve) => m.once("start", resolve));
    const streams = m.start();
    const info = await started;
    assert.ok(info.pid > 0);
    assert.ok(streams.input && streams.output, "exposes input+output streams");
    const exited = new Promise((resolve) => m.once("exit", resolve));
    m.stop();
    const ex = await exited;
    assert.ok(ex, "emitted exit after stop");
  });
});

describe("process — restart on crash with bounded backoff", () => {
  it("restarts up to maxRestarts then gives up", async () => {
    const m = new ManagedServer({
      command: process.execPath,
      args: ["-e", "process.exit(1);"], // crash immediately
      maxRestarts: 2,
      restartBaseDelay: 10,
    });
    const restarts = [];
    m.on("restart", (r) => restarts.push(r.attempt));
    const gaveUp = new Promise((resolve) => m.once("giveup", resolve));
    m.start();
    const g = await gaveUp;
    assert.equal(g.restarts, 2, "attempted exactly maxRestarts restarts");
    assert.deepEqual(restarts, [1, 2]);
  });

  it("does not restart after an intentional stop", async () => {
    const m = new ManagedServer({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); setInterval(()=>{}, 1000);"],
      maxRestarts: 3,
      restartBaseDelay: 10,
    });
    let restarted = false;
    m.on("restart", () => { restarted = true; });
    m.start();
    await new Promise((r) => setTimeout(r, 30));
    const exited = new Promise((resolve) => m.once("exit", resolve));
    m.stop();
    await exited;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(restarted, false, "no restart after stop()");
  });
});
