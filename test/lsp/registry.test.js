"use strict";
// Tests for the server registry and installation detection. PATH resolution is
// tested against a temporary directory with a fake executable, so it is
// deterministic and does not depend on what is installed on the machine.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const registry = require("../../src/lsp/registry");

describe("registry — mapping", () => {
  it("maps extensions to servers in preference order", () => {
    const ts = registry.forExtension(".ts");
    assert.equal(ts[0].id, "typescript-language-server");
    const py = registry.forExtension("py"); // leading dot optional
    assert.ok(py.find((s) => s.id === "pyright"));
    assert.ok(py.find((s) => s.id === "pylsp"));
    assert.equal(py[0].id, "pyright", "pyright preferred before pylsp");
  });

  it("maps a language id to its servers", () => {
    assert.ok(registry.forLanguage("go").find((s) => s.id === "gopls"));
    assert.ok(registry.forLanguage("rust").find((s) => s.id === "rust-analyzer"));
  });

  it("resolves a language id from a file path", () => {
    assert.equal(registry.languageIdForPath("/a/b/c.rs"), "rust");
    assert.equal(registry.languageIdForPath("/a/b/c.unknownext"), null);
  });

  it("returns [] for unknown extensions", () => {
    assert.deepEqual(registry.forExtension(".xyz"), []);
  });
});

describe("registry — executable resolution", () => {
  let dir;
  const binName = "fake-langserver";
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-reg-"));
    const bin = path.join(dir, binName);
    fs.writeFileSync(bin, "#!/bin/sh\necho hi\n");
    if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("finds an executable on a provided PATH", () => {
    const resolved = registry.resolveExecutable(binName, { env: { PATH: dir } });
    assert.ok(resolved, "should resolve the fake binary");
    assert.ok(resolved.endsWith(binName));
  });

  it("returns null when not on PATH", () => {
    assert.equal(registry.resolveExecutable("definitely-not-installed-xyz", { env: { PATH: dir } }), null);
  });

  it("resolves an explicit path when executable", () => {
    const direct = path.join(dir, binName);
    assert.equal(registry.resolveExecutable(direct, {}), direct);
  });
});

describe("registry — detect (NX-107 clarity)", () => {
  it("reports available with the chosen server when installed", () => {
    // Fake a PATH that contains a gopls shim.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-det-"));
    const bin = path.join(dir, "gopls");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
    const det = registry.detect({ filePath: "/proj/main.go", env: { PATH: dir } });
    assert.equal(det.available, true);
    assert.equal(det.chosen.id, "gopls");
    assert.match(det.reason, /installed/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a clear install hint when nothing is installed", () => {
    const det = registry.detect({ filePath: "/proj/app.ts", env: { PATH: "/nonexistent-dir-123" } });
    assert.equal(det.available, false);
    assert.ok(det.candidates.length > 0);
    assert.match(det.reason, /Install one, e\.g\./);
    assert.ok(det.candidates[0].installHint.includes("npm i -g"));
  });

  it("reports when no server handles the file type at all", () => {
    const det = registry.detect({ filePath: "/proj/data.xyz", env: { PATH: "" } });
    assert.equal(det.available, false);
    assert.equal(det.candidates.length, 0);
    assert.match(det.reason, /no known language server/);
  });

  it("listAll returns a status for every registered server", () => {
    const all = registry.listAll({ env: { PATH: "" } });
    assert.equal(all.length, registry.SERVERS.length);
    for (const s of all) {
      assert.equal(typeof s.installed, "boolean");
      assert.ok(s.installHint);
    }
  });
});
