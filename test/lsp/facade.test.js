"use strict";
// Tests for the NexusLsp façade. A custom connection factory injects a
// mock-backed LspClient so the whole high-level surface is exercised with no
// child process. Also covers the graceful "server not installed" degradation
// using an empty PATH, and connection reuse across files of the same language.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mock = require("../../src/lsp/mock");
const proto = require("../../src/lsp/protocol");
const { LspClient } = require("../../src/lsp/client");
const { NexusLsp } = require("../../src/lsp/facade");

// Build a façade whose connections are mock-backed. Tracks created servers so a
// test can push diagnostics or assert reuse.
function mockFacade(opts) {
  opts = opts || {};
  const created = [];
  const connect = async (serverDef, ctx) => {
    const server = new mock.MockServer(opts.serverOpts);
    const streams = server.endpointStreams();
    const client = new LspClient({ input: streams.input, output: streams.output, rootPath: ctx.cwd, name: serverDef.id });
    await client.initialize();
    created.push({ serverDef, server, client });
    return { client, dispose: async () => { await client.shutdown(); } };
  };
  // Force detection to believe a server is installed by injecting a PATH with a shim.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-fac-"));
  for (const name of ["typescript-language-server", "gopls", "pyright-langserver"]) {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, "#!/bin/sh\n");
    if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  }
  const lsp = new NexusLsp({ cwd: ctx(), env: { PATH: dir }, connect });
  return { lsp, created, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  function ctx() { return opts.cwd || "/proj"; }
}

describe("facade — availability", () => {
  it("degrades gracefully when no server is installed (empty PATH)", async () => {
    const lsp = new NexusLsp({ cwd: "/proj", env: { PATH: "/nope-123" } });
    const res = await lsp.diagnostics("/proj/app.ts", { text: "x" });
    assert.equal(res.available, false);
    assert.match(res.reason, /no installed server/);
    assert.ok(res.installHint.includes("typescript-language-server"));
    await lsp.dispose();
  });

  it("reports when no server type handles the file", async () => {
    const lsp = new NexusLsp({ cwd: "/proj", env: { PATH: "" } });
    const res = await lsp.hover("/proj/data.xyz", proto.position(0, 0), { text: "x" });
    assert.equal(res.available, false);
    assert.match(res.reason, /no known language server/);
    await lsp.dispose();
  });

  it("info() lists every server with install status", async () => {
    const lsp = new NexusLsp({ cwd: "/proj", env: { PATH: "" } });
    const info = lsp.info();
    assert.ok(info.servers.length >= 5);
    assert.ok(info.servers.every((s) => typeof s.installed === "boolean"));
    await lsp.dispose();
  });
});

describe("facade — high-level operations (mock-backed)", () => {
  it("returns diagnostics after the server pushes them", async () => {
    const { lsp, created, cleanup } = mockFacade();
    try {
      const p = lsp.diagnostics("/proj/app.ts", { text: "const x=1", timeout: 1000 });
      // Wait for the connection, then push diagnostics from the created mock.
      await waitFor(() => created.length > 0);
      created[0].server.publishDiagnostics(proto.pathToUri("/proj/app.ts"), [
        { severity: 2, message: "unused", range: proto.range(0, 6, 0, 7) },
      ]);
      const res = await p;
      assert.equal(res.available, true);
      assert.equal(res.diagnostics[0].severity, "warning");
      assert.equal(res.diagnostics[0].message, "unused");
    } finally {
      await lsp.dispose();
      cleanup();
    }
  });

  it("definition / references / hover / symbols / completion all work", async () => {
    const { lsp, cleanup } = mockFacade();
    try {
      const def = await lsp.definition("/proj/app.ts", proto.position(0, 0), { text: "x" });
      assert.equal(def.available, true);
      assert.equal(def.locations.length, 1);

      const refs = await lsp.references("/proj/app.ts", proto.position(0, 0), { text: "x" });
      assert.equal(refs.locations.length, 2);

      const hov = await lsp.hover("/proj/app.ts", proto.position(0, 0), { text: "x" });
      assert.match(hov.hover.contents, /mock hover/);

      const syms = await lsp.documentSymbols("/proj/app.ts", { text: "x" });
      assert.equal(syms.symbols[0].name, "exampleFn");

      const comp = await lsp.completion("/proj/app.ts", proto.position(0, 0), { text: "x" });
      assert.equal(comp.completion.items.length, 2);
    } finally {
      await lsp.dispose();
      cleanup();
    }
  });

  it("rename returns a normalized WorkspaceEdit", async () => {
    const { lsp, cleanup } = mockFacade();
    try {
      const r = await lsp.rename("/proj/app.ts", proto.position(0, 9), "renamed", { text: "x" });
      assert.equal(r.available, true);
      assert.equal(r.rename.changes[0].edits[0].newText, "renamed");
    } finally {
      await lsp.dispose();
      cleanup();
    }
  });

  it("reuses one connection per language across multiple files", async () => {
    const { lsp, created, cleanup } = mockFacade();
    try {
      await lsp.hover("/proj/a.ts", proto.position(0, 0), { text: "x" });
      await lsp.hover("/proj/b.ts", proto.position(0, 0), { text: "y" });
      assert.equal(created.length, 1, "same TS server reused for both files");
    } finally {
      await lsp.dispose();
      cleanup();
    }
  });

  it("opens distinct servers for distinct languages", async () => {
    const { lsp, created, cleanup } = mockFacade();
    try {
      await lsp.hover("/proj/a.ts", proto.position(0, 0), { text: "x" });
      await lsp.hover("/proj/main.go", proto.position(0, 0), { text: "y" });
      assert.equal(created.length, 2);
      const ids = created.map((c) => c.serverDef.id).sort();
      assert.deepEqual(ids, ["gopls", "typescript-language-server"]);
    } finally {
      await lsp.dispose();
      cleanup();
    }
  });

  it("workspaceSymbols works through the façade", async () => {
    const { lsp, cleanup } = mockFacade();
    try {
      const res = await lsp.workspaceSymbols("example", { forFile: "/proj/a.ts" });
      assert.equal(res.available, true);
      assert.equal(res.symbols[0].name, "exampleFn");
    } finally {
      await lsp.dispose();
      cleanup();
    }
  });
});

function waitFor(predicate, timeout) {
  timeout = timeout || 1000;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("waitFor timed out"));
      setImmediate(tick);
    };
    tick();
  });
}
