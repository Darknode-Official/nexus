"use strict";
// Tests for the LspClient against the mock server: the initialize/initialized
// handshake + capability negotiation, document sync with version tracking and
// incremental changes, the diagnostics subscription, every feature wrapper, the
// unsupported-capability path, and graceful shutdown.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mock = require("../../src/lsp/mock");
const proto = require("../../src/lsp/protocol");
const { LspClient } = require("../../src/lsp/client");

async function makeClient(serverOpts) {
  const server = new mock.MockServer(serverOpts);
  const streams = server.endpointStreams();
  const client = new LspClient({ input: streams.input, output: streams.output, rootPath: "/proj", name: "test" });
  await client.initialize();
  return { server, client };
}

describe("client — lifecycle", () => {
  it("completes the initialize/initialized handshake and records capabilities", async () => {
    const { server, client } = await makeClient();
    await new Promise((r) => setImmediate(r));
    assert.equal(client.state, "ready");
    assert.ok(client.supports("hoverProvider"));
    assert.equal(client.serverInfo.name, "mock-language-server");
    assert.equal(server.initialized, true, "server received the initialized notification");
    await client.shutdown();
  });

  it("negotiates incremental sync kind from capabilities", async () => {
    const { client } = await makeClient();
    assert.equal(client.syncKind(), proto.TextDocumentSyncKind.Incremental);
    await client.shutdown();
  });

  it("reports Full sync when the server only supports full", async () => {
    const caps = mock.defaultCapabilities();
    caps.textDocumentSync = { openClose: true, change: proto.TextDocumentSyncKind.Full };
    const { client } = await makeClient({ capabilities: caps });
    assert.equal(client.syncKind(), proto.TextDocumentSyncKind.Full);
    await client.shutdown();
  });

  it("shutdown sends shutdown + exit and stops", async () => {
    const { server, client } = await makeClient();
    const exited = new Promise((resolve) => server.once("exit", resolve));
    await client.shutdown();
    await exited;
    assert.equal(client.state, "stopped");
    assert.equal(server.shutdownRequested, true);
  });
});

describe("client — document sync", () => {
  it("opens a document at version 1 and sends full text", async () => {
    const { server, client } = await makeClient();
    client.openDocument("/proj/a.js", "const x = 1;\n", "javascript");
    await new Promise((r) => setImmediate(r));
    const doc = server.openDocuments.get(proto.pathToUri("/proj/a.js"));
    assert.equal(doc.version, 1);
    assert.equal(doc.text, "const x = 1;\n");
    await client.shutdown();
  });

  it("sends an incremental change and bumps the version", async () => {
    const { server, client } = await makeClient();
    const uri = proto.pathToUri("/proj/a.js");
    client.openDocument("/proj/a.js", "const x = 1;\n", "javascript");
    const changeSeen = new Promise((resolve) => server.once("didChange", resolve));
    client.changeDocument("/proj/a.js", "const y = 1;\n");
    const params = await changeSeen;
    assert.equal(params.textDocument.version, 2);
    assert.ok(params.contentChanges[0].range, "incremental change carries a range");
    // The mock re-applies the change; it must equal the new text.
    assert.equal(server.openDocuments.get(uri).text, "const y = 1;\n");
    await client.shutdown();
  });

  it("sends a full change when the server only supports full sync", async () => {
    const caps = mock.defaultCapabilities();
    caps.textDocumentSync = { openClose: true, change: proto.TextDocumentSyncKind.Full };
    const { server, client } = await makeClient({ capabilities: caps });
    client.openDocument("/proj/a.js", "a", "javascript");
    const changeSeen = new Promise((resolve) => server.once("didChange", resolve));
    client.changeDocument("/proj/a.js", "abc");
    const params = await changeSeen;
    assert.equal(params.contentChanges[0].range, undefined, "full change has no range");
    assert.equal(params.contentChanges[0].text, "abc");
    await client.shutdown();
  });

  it("no-ops a change when text is unchanged", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "same", "javascript");
    assert.equal(client.changeDocument("/proj/a.js", "same"), null);
    await client.shutdown();
  });

  it("closes a document", async () => {
    const { server, client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const closed = new Promise((resolve) => server.once("didClose", resolve));
    client.closeDocument("/proj/a.js");
    await closed;
    assert.equal(server.openDocuments.has(proto.pathToUri("/proj/a.js")), false);
    await client.shutdown();
  });
});

describe("client — diagnostics subscription", () => {
  it("caches diagnostics and resolves waiters on push", async () => {
    const { server, client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const wait = client.waitForDiagnostics("/proj/a.js", { timeout: 1000 });
    server.publishDiagnostics(proto.pathToUri("/proj/a.js"), [
      { severity: 1, message: "bad", range: proto.range(0, 0, 0, 1) },
    ]);
    const diags = await wait;
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, "error");
    assert.deepEqual(client.getDiagnostics("/proj/a.js"), diags);
    await client.shutdown();
  });

  it("waitForDiagnostics times out to the cached/empty set", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const diags = await client.waitForDiagnostics("/proj/a.js", { timeout: 15 });
    assert.deepEqual(diags, []);
    await client.shutdown();
  });
});

describe("client — feature wrappers", () => {
  it("hover returns normalized contents", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const h = await client.hover("/proj/a.js", proto.position(0, 0));
    assert.match(h.contents, /mock hover/);
    await client.shutdown();
  });

  it("definition and references return normalized locations", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const def = await client.definition("/proj/a.js", proto.position(0, 0));
    assert.equal(def.length, 1);
    assert.ok(def[0].path);
    const refs = await client.references("/proj/a.js", proto.position(0, 0));
    assert.equal(refs.length, 2);
    await client.shutdown();
  });

  it("documentSymbols returns a normalized nested tree", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const syms = await client.documentSymbols("/proj/a.js");
    assert.equal(syms[0].name, "exampleFn");
    assert.equal(syms[0].kind, "function");
    assert.equal(syms[0].children[0].name, "inner");
    await client.shutdown();
  });

  it("completion returns a normalized list", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const c = await client.completion("/proj/a.js", proto.position(0, 0));
    assert.equal(c.isIncomplete, false);
    assert.equal(c.items[0].label, "exampleFn");
    assert.equal(c.items[0].kind, "function");
    await client.shutdown();
  });

  it("rename returns a normalized WorkspaceEdit", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const r = await client.rename("/proj/a.js", proto.position(0, 9), "renamed");
    assert.equal(r.newName, "renamed");
    assert.equal(r.changes[0].edits[0].newText, "renamed");
    await client.shutdown();
  });

  it("formatting returns the server's TextEdits", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const edits = await client.formatting("/proj/a.js");
    assert.ok(Array.isArray(edits));
    await client.shutdown();
  });

  it("codeAction returns normalized actions", async () => {
    const { client } = await makeClient();
    client.openDocument("/proj/a.js", "x", "javascript");
    const actions = await client.codeAction("/proj/a.js", proto.range(0, 0, 0, 1), { diagnostics: [] });
    assert.equal(actions[0].title, "Mock quick fix");
    assert.equal(actions[0].kind, "quickfix");
    await client.shutdown();
  });

  it("returns an unsupported marker when the server lacks a capability", async () => {
    const caps = mock.defaultCapabilities();
    delete caps.renameProvider;
    const { client } = await makeClient({ capabilities: caps });
    const r = await client.rename("/proj/a.js", proto.position(0, 0), "x");
    assert.equal(r.unsupported, true);
    assert.equal(r.capability, "renameProvider");
    await client.shutdown();
  });

  it("workspaceSymbols queries across the workspace", async () => {
    const { client } = await makeClient();
    const syms = await client.workspaceSymbols("example");
    assert.equal(syms[0].name, "exampleFn");
    await client.shutdown();
  });
});
