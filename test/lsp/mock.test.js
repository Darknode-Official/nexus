"use strict";
// Tests for the in-memory mock language server itself: the cross-wired pipe,
// default request responses, notification tracking, incremental change
// application, and crash simulation. The mock is the backbone of every other
// deterministic test, so it gets its own coverage.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { JsonRpcEndpoint } = require("../../src/lsp/rpc");
const mock = require("../../src/lsp/mock");

function connect(server) {
  return new JsonRpcEndpoint(server.endpointStreams());
}

describe("mock.createPipe", () => {
  it("cross-wires the two channels", (t, done) => {
    const pipe = mock.createPipe();
    pipe.server.input.once("data", (d) => {
      assert.equal(d.toString(), "hello");
      done();
    });
    pipe.client.output.write("hello");
  });
});

describe("MockServer — default responses", () => {
  it("answers initialize with capabilities and serverInfo", async () => {
    const server = new mock.MockServer();
    const ep = connect(server);
    const res = await ep.request("initialize", { rootUri: "file:///x" });
    assert.ok(res.capabilities.hoverProvider);
    assert.equal(res.serverInfo.name, "mock-language-server");
    ep.close();
  });

  it("answers hover, definition and references", async () => {
    const server = new mock.MockServer();
    const ep = connect(server);
    const hover = await ep.request("textDocument/hover", { textDocument: { uri: "file:///a.js" }, position: { line: 0, character: 1 } });
    assert.match(hover.contents.value, /mock hover/);
    const def = await ep.request("textDocument/definition", { textDocument: { uri: "file:///a.js" }, position: { line: 0, character: 1 } });
    assert.equal(def.length, 1);
    const refs = await ep.request("textDocument/references", { textDocument: { uri: "file:///a.js" }, position: { line: 0, character: 1 } });
    assert.equal(refs.length, 2);
    ep.close();
  });

  it("returns an error response for unknown methods", async () => {
    const server = new mock.MockServer();
    const ep = connect(server);
    await assert.rejects(ep.request("totally/made-up"), /method not found/);
    ep.close();
  });

  it("honors per-method response overrides", async () => {
    const server = new mock.MockServer({ responses: { "textDocument/hover": () => ({ contents: "custom" }) } });
    const ep = connect(server);
    const hover = await ep.request("textDocument/hover", {});
    assert.equal(hover.contents, "custom");
    ep.close();
  });
});

describe("MockServer — notifications + document state", () => {
  it("tracks didOpen / didChange / didClose and applies changes", async () => {
    const server = new mock.MockServer();
    const ep = connect(server);
    const uri = "file:///doc.js";
    ep.notify("textDocument/didOpen", { textDocument: { uri, languageId: "javascript", version: 1, text: "abcdef" } });
    await new Promise((r) => setImmediate(r));
    assert.equal(server.openDocuments.get(uri).text, "abcdef");
    ep.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, text: "XY" }] });
    await new Promise((r) => setImmediate(r));
    assert.equal(server.openDocuments.get(uri).text, "abXYef");
    ep.notify("textDocument/didClose", { textDocument: { uri } });
    await new Promise((r) => setImmediate(r));
    assert.equal(server.openDocuments.has(uri), false);
    ep.close();
  });

  it("delivers server-pushed publishDiagnostics", async () => {
    const server = new mock.MockServer();
    const ep = connect(server);
    const got = new Promise((resolve) => ep.on("notification:textDocument/publishDiagnostics", resolve));
    server.publishDiagnostics("file:///a.js", [{ severity: 1, message: "boom", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } }]);
    const params = await got;
    assert.equal(params.diagnostics[0].message, "boom");
    ep.close();
  });
});

describe("MockServer — server->client requests and crash", () => {
  it("can issue a server->client request the endpoint auto-answers", async () => {
    const server = new mock.MockServer();
    const ep = connect(server);
    const answered = new Promise((resolve) => server.once("message", (m) => resolve(m)));
    server.sendServerRequest("workspace/configuration", { items: [{ section: "x" }] });
    const reply = await answered;
    assert.deepEqual(reply.result, [null]);
    ep.close();
  });

  it("crash() closes the endpoint and rejects pending requests", async () => {
    const server = new mock.MockServer({ responses: { "slow/op": () => new Promise(() => {}) } });
    const ep = connect(server);
    const p = ep.request("slow/op");
    server.crash();
    await assert.rejects(p);
  });
});

describe("mock.applyChanges / positionToOffset", () => {
  it("applies a full replacement when no range", () => {
    assert.equal(mock.applyChanges("old", [{ text: "new" }]), "new");
  });
  it("positionToOffset is the inverse of offsetToPosition", () => {
    const proto = require("../../src/lsp/protocol");
    const text = "ab\ncde\nf";
    for (let off = 0; off <= text.length; off++) {
      const pos = proto.offsetToPosition(text, off);
      assert.equal(mock.positionToOffset(text, pos), off);
    }
  });
});
