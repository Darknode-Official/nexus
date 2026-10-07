"use strict";
// Tests for the Content-Length framing codec: encode byte lengths, decode whole
// messages, and the critical partial-chunk cases (split header, split body,
// several messages glued together, resync after a corrupt header).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const framing = require("../../src/lsp/framing");

function framed(obj) {
  return framing.encodeMessage(obj);
}

describe("framing.encodeMessage", () => {
  it("uses the UTF-8 BYTE length, not the character count", () => {
    const buf = framing.encodeMessage({ s: "héllo" }); // é is 2 bytes
    const text = buf.toString("utf8");
    const json = JSON.stringify({ s: "héllo" });
    const byteLen = Buffer.byteLength(json, "utf8");
    assert.ok(text.startsWith("Content-Length: " + byteLen + "\r\n\r\n"));
  });

  it("round-trips through a single-append read", () => {
    const reader = new framing.MessageReader();
    const { messages, errors } = reader.append(framed({ jsonrpc: "2.0", id: 1, method: "x" }));
    assert.equal(errors.length, 0);
    assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, method: "x" }]);
  });
});

describe("framing.parseHeaders", () => {
  it("extracts Content-Length and preserves other headers", () => {
    const h = framing.parseHeaders("Content-Length: 42\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8");
    assert.equal(h.contentLength, 42);
    assert.equal(h.headers["Content-Type"], "application/vscode-jsonrpc; charset=utf-8");
  });

  it("throws when Content-Length is missing", () => {
    assert.throws(() => framing.parseHeaders("Content-Type: text/plain"), /Content-Length/);
  });
});

describe("framing.MessageReader — partial chunks", () => {
  it("reassembles a message split across many byte-sized chunks", () => {
    const buf = framed({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    const reader = new framing.MessageReader();
    const collected = [];
    for (let i = 0; i < buf.length; i++) {
      const { messages } = reader.append(buf.slice(i, i + 1));
      collected.push(...messages);
    }
    assert.deepEqual(collected, [{ jsonrpc: "2.0", id: 7, result: { ok: true } }]);
  });

  it("handles a header split across chunks", () => {
    const buf = framed({ a: 1 });
    const reader = new framing.MessageReader();
    const r1 = reader.append(buf.slice(0, 8)); // mid-header
    assert.equal(r1.messages.length, 0);
    const r2 = reader.append(buf.slice(8));
    assert.deepEqual(r2.messages, [{ a: 1 }]);
  });

  it("drains multiple messages glued into one chunk", () => {
    const glued = Buffer.concat([framed({ id: 1 }), framed({ id: 2 }), framed({ id: 3 })]);
    const reader = new framing.MessageReader();
    const { messages } = reader.append(glued);
    assert.deepEqual(messages.map((m) => m.id), [1, 2, 3]);
  });

  it("holds an incomplete body until the rest arrives", () => {
    const buf = framed({ hello: "world" });
    const splitAt = buf.length - 3;
    const reader = new framing.MessageReader();
    assert.equal(reader.append(buf.slice(0, splitAt)).messages.length, 0);
    assert.ok(reader.pendingBytes() > 0);
    const { messages } = reader.append(buf.slice(splitAt));
    assert.deepEqual(messages, [{ hello: "world" }]);
    assert.equal(reader.pendingBytes(), 0);
  });

  it("reports a JSON parse error but keeps the stream usable", () => {
    const badBody = Buffer.from("{not json}", "utf8");
    const badFrame = Buffer.concat([Buffer.from("Content-Length: " + badBody.length + "\r\n\r\n", "ascii"), badBody]);
    const good = framed({ ok: 1 });
    const reader = new framing.MessageReader();
    const { messages, errors } = reader.append(Buffer.concat([badFrame, good]));
    assert.equal(errors.length, 1);
    assert.deepEqual(messages, [{ ok: 1 }]);
  });

  it("resyncs after a corrupt header block", () => {
    const bad = Buffer.from("GARBAGE-NO-LENGTH\r\n\r\n", "ascii");
    const good = framed({ recovered: true });
    const reader = new framing.MessageReader();
    const { messages, errors } = reader.append(Buffer.concat([bad, good]));
    assert.equal(errors.length, 1);
    assert.deepEqual(messages, [{ recovered: true }]);
  });

  it("decodes multibyte UTF-8 bodies correctly", () => {
    const reader = new framing.MessageReader();
    const { messages } = reader.append(framed({ emoji: "λ 日本語 €" }));
    assert.equal(messages[0].emoji, "λ 日本語 €");
  });
});
