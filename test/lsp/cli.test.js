"use strict";
// Tests for the demo CLI. A fake facade is injected so the command dispatch,
// output formatting, exit codes, and graceful "not installed" degradation are
// all exercised deterministically. A string-collecting stream captures output.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const cli = require("../../src/lsp/cli");

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(s); return true; }, text: () => chunks.join("") };
}

// Minimal fake facade covering the methods the CLI calls.
function fakeFacade(overrides) {
  return Object.assign({
    info: () => ({ cwd: "/proj", servers: [{ id: "typescript-language-server", installed: false, extensions: [".ts"], installHint: "npm i -g typescript-language-server", resolvedPath: null }] }),
    diagnostics: async () => ({ available: true, serverId: "ts", diagnostics: [{ severity: "error", severityCode: 1, message: "boom", line: 2, column: 3, code: "E1" }] }),
    definition: async () => ({ available: true, locations: [{ path: "/proj/a.ts", uri: "file:///proj/a.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }] }),
    references: async () => ({ available: true, locations: [] }),
    hover: async () => ({ available: true, hover: { contents: "type: string" } }),
    documentSymbols: async () => ({ available: true, symbols: [{ name: "fn", kind: "function", selectionRange: { start: { line: 0, character: 9 } }, children: [] }] }),
    workspaceSymbols: async () => ({ available: true, symbols: [] }),
    dispose: async () => {},
  }, overrides);
}

describe("cli.parsePosition", () => {
  it("converts 1-based L:C to 0-based", () => {
    assert.deepEqual(cli.parsePosition("12:5"), { line: 11, character: 4 });
  });
  it("returns null for junk", () => {
    assert.equal(cli.parsePosition("nope"), null);
  });
});

describe("cli — help and info", () => {
  it("prints help with no args (exit 0)", async () => {
    const out = sink();
    const code = await cli.main([], { stdout: out, stderr: sink() });
    assert.equal(code, 0);
    assert.match(out.text(), /nexus lsp/);
  });

  it("info lists servers with install state", async () => {
    const out = sink();
    const code = await cli.main(["info"], { facade: fakeFacade(), stdout: out, stderr: sink() });
    assert.equal(code, 0);
    assert.match(out.text(), /typescript-language-server/);
    assert.match(out.text(), /missing/);
  });
});

describe("cli — diagnostics", () => {
  it("prints diagnostics and exits 2 when an error exists", async () => {
    const out = sink();
    const code = await cli.main(["diagnostics", "a.ts"], { facade: fakeFacade(), cwd: "/proj", stdout: out, stderr: sink() });
    assert.equal(code, 2);
    assert.match(out.text(), /error: boom/);
    assert.match(out.text(), /\[E1\]/);
  });

  it("exits 0 when there are no error-level diagnostics", async () => {
    const out = sink();
    const facade = fakeFacade({ diagnostics: async () => ({ available: true, serverId: "ts", diagnostics: [] }) });
    const code = await cli.main(["diagnostics", "a.ts"], { facade, cwd: "/proj", stdout: out, stderr: sink() });
    assert.equal(code, 0);
    assert.match(out.text(), /No diagnostics/);
  });

  it("degrades with exit 3 and an install hint when unavailable", async () => {
    const err = sink();
    const facade = fakeFacade({ diagnostics: async () => ({ available: false, reason: "no installed server; ...", installHint: "npm i -g typescript-language-server" }) });
    const code = await cli.main(["diagnostics", "a.ts"], { facade, cwd: "/proj", stdout: sink(), stderr: err });
    assert.equal(code, 3);
    assert.match(err.text(), /LSP unavailable/);
    assert.match(err.text(), /Install: npm i -g/);
  });

  it("errors (exit 1) with a missing file argument", async () => {
    const code = await cli.main(["diagnostics"], { facade: fakeFacade(), stdout: sink(), stderr: sink() });
    assert.equal(code, 1);
  });
});

describe("cli — position commands and json", () => {
  it("definition prints a location", async () => {
    const out = sink();
    const code = await cli.main(["definition", "a.ts", "5:3"], { facade: fakeFacade(), cwd: "/proj", stdout: out, stderr: sink() });
    assert.equal(code, 0);
    assert.match(out.text(), /a\.ts:5:3/);
  });

  it("hover prints contents", async () => {
    const out = sink();
    await cli.main(["hover", "a.ts", "1:1"], { facade: fakeFacade(), cwd: "/proj", stdout: out, stderr: sink() });
    assert.match(out.text(), /type: string/);
  });

  it("requires a position for position commands", async () => {
    const code = await cli.main(["definition", "a.ts"], { facade: fakeFacade(), stdout: sink(), stderr: sink() });
    assert.equal(code, 1);
  });

  it("--json emits machine-readable output", async () => {
    const out = sink();
    await cli.main(["diagnostics", "a.ts", "--json"], { facade: fakeFacade(), cwd: "/proj", stdout: out, stderr: sink() });
    const parsed = JSON.parse(out.text());
    assert.equal(parsed.diagnostics[0].message, "boom");
  });

  it("symbols prints the outline", async () => {
    const out = sink();
    await cli.main(["symbols", "a.ts"], { facade: fakeFacade(), cwd: "/proj", stdout: out, stderr: sink() });
    assert.match(out.text(), /function fn/);
  });

  it("unknown command exits 1", async () => {
    const code = await cli.main(["frobnicate"], { facade: fakeFacade(), stdout: sink(), stderr: sink() });
    assert.equal(code, 1);
  });
});
