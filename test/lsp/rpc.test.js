"use strict";
// Tests for the JSON-RPC 2.0 endpoint using in-memory streams: request/response
// correlation (including out-of-order), error responses, notifications, inbound
// server->client requests + default responders, cancellation (AbortSignal and
// $/cancelRequest), timeouts, batching, and graceful close rejecting in-flight
// requests. No child process involved.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const framing = require("../../src/lsp/framing");
const { JsonRpcEndpoint, RpcError } = require("../../src/lsp/rpc");

// A tiny controllable peer: reads framed messages off `endpointOut`, lets the
// test respond on `endpointIn`. Returns the two streams plus helpers.
function makePeer() {
  const toPeer = new PassThrough(); // endpoint writes here
  const fromPeer = new PassThrough(); // endpoint reads here
  const reader = new framing.MessageReader();
  const received = [];
  const handlers = [];
  toPeer.on("data", (chunk) => {
    const { messages } = reader.append(chunk);
    for (const m of messages) {
      received.push(m);
      for (const h of handlers) h(m);
    }
  });
  return {
    endpointStreams: { input: fromPeer, output: toPeer },
    received,
    onMessage: (fn) => handlers.push(fn),
    send: (obj) => fromPeer.write(framing.encodeMessage(obj)),
  };
}

describe("rpc — request/response correlation", () => {
  it("resolves a request with the matching response result", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(Object.assign({ name: "t" }, peer.endpointStreams));
    peer.onMessage((m) => { if (m.method === "ping") peer.send({ jsonrpc: "2.0", id: m.id, result: "pong" }); });
    assert.equal(await ep.request("ping"), "pong");
    ep.close();
  });

  it("correlates concurrent, out-of-order responses", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    const ids = [];
    peer.onMessage((m) => ids.push(m.id));
    const p1 = ep.request("a");
    const p2 = ep.request("b");
    // respond to the second first
    peer.send({ jsonrpc: "2.0", id: ids[1], result: "B" });
    peer.send({ jsonrpc: "2.0", id: ids[0], result: "A" });
    assert.deepEqual(await Promise.all([p1, p2]), ["A", "B"]);
    ep.close();
  });

  it("rejects with an RpcError carrying code/data on an error response", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    peer.onMessage((m) => peer.send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "bad params", data: { x: 1 } } }));
    await assert.rejects(ep.request("x", { y: 1 }), (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, -32602);
      assert.deepEqual(err.data, { x: 1 });
      assert.equal(err.method, "x");
      return true;
    });
    ep.close();
  });
});

describe("rpc — notifications", () => {
  it("sends notifications without an id", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    ep.notify("textDocument/didOpen", { uri: "file:///a" });
    await new Promise((r) => setImmediate(r));
    assert.equal(peer.received[0].method, "textDocument/didOpen");
    assert.equal(peer.received[0].id, undefined);
    ep.close();
  });

  it("emits inbound notifications by method", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    const got = new Promise((resolve) => ep.on("notification:textDocument/publishDiagnostics", resolve));
    peer.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a", diagnostics: [] } });
    const params = await got;
    assert.equal(params.uri, "file:///a");
    ep.close();
  });
});

describe("rpc — inbound server->client requests", () => {
  it("dispatches to a registered handler and replies with its result", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    ep.onRequest("custom/echo", (params) => ({ echoed: params.v }));
    const reply = new Promise((resolve) => peer.onMessage((m) => { if (m.id === 99) resolve(m); }));
    peer.send({ jsonrpc: "2.0", id: 99, method: "custom/echo", params: { v: 5 } });
    const r = await reply;
    assert.deepEqual(r.result, { echoed: 5 });
    ep.close();
  });

  it("gives workspace/configuration a benign default (one null per item)", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    const reply = new Promise((resolve) => peer.onMessage((m) => { if (m.id === 1) resolve(m); }));
    peer.send({ jsonrpc: "2.0", id: 1, method: "workspace/configuration", params: { items: [{}, {}] } });
    assert.deepEqual((await reply).result, [null, null]);
    ep.close();
  });

  it("replies MethodNotFound for unknown inbound requests", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    const reply = new Promise((resolve) => peer.onMessage((m) => { if (m.id === 2) resolve(m); }));
    peer.send({ jsonrpc: "2.0", id: 2, method: "totally/unknown" });
    assert.equal((await reply).error.code, -32601);
    ep.close();
  });
});

describe("rpc — cancellation", () => {
  it("sends $/cancelRequest and rejects when the AbortSignal fires", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    const ac = new AbortController();
    const cancelSeen = new Promise((resolve) => peer.onMessage((m) => { if (m.method === "$/cancelRequest") resolve(m.params.id); }));
    const p = ep.request("slow", null, { signal: ac.signal });
    ac.abort();
    await assert.rejects(p);
    assert.ok((await cancelSeen) >= 1);
    ep.close();
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(ep.request("x", null, { signal: ac.signal }), /aborted/);
    ep.close();
  });

  it("manual cancelRequest emits a cancel event", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    const seen = new Promise((resolve) => ep.on("cancel", resolve));
    ep.cancelRequest(42);
    assert.equal(await seen, 42);
    ep.close();
  });
});

describe("rpc — timeouts", () => {
  it("rejects a request that is never answered within the timeout", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    await assert.rejects(ep.request("slow", null, { timeout: 20 }), /timed out/);
    ep.close();
  });
});

describe("rpc — batching", () => {
  it("sends one array frame and resolves each request member", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    // A batch is a single JSON array frame; the peer receives it as one array.
    peer.onMessage((frame) => {
      assert.ok(Array.isArray(frame), "batch should be a single array frame");
      assert.equal(frame.filter((m) => m.id === undefined).length, 1, "one notification member has no id");
      for (const m of frame) {
        if (m.id !== undefined) peer.send({ jsonrpc: "2.0", id: m.id, result: m.method.toUpperCase() });
      }
    });
    const results = await ep.batch([
      { method: "a" },
      { method: "noti", notify: true },
      { method: "b" },
    ]);
    assert.equal(results[0], "A");
    assert.equal(results[1], undefined);
    assert.equal(results[2], "B");
    ep.close();
  });
});

describe("rpc — graceful close", () => {
  it("rejects all in-flight requests on close", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    const p = ep.request("never");
    ep.close();
    await assert.rejects(p, /closed/);
    assert.equal(ep.pendingCount(), 0);
  });

  it("rejects new requests after close", async () => {
    const peer = makePeer();
    const ep = new JsonRpcEndpoint(peer.endpointStreams);
    ep.close();
    await assert.rejects(ep.request("x"), /closed/);
  });
});
