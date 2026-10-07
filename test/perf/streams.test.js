"use strict";
// Tests for incremental SSE and NDJSON parsers: split chunks, partial lines, multi-byte
// UTF-8 boundaries, multi-line SSE data, comments, and the [DONE] sentinel helper.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");
const { createNDJSONParser, createSSEParser, sseDataEvents, streamToParser } = require("../../src/perf/streams");

describe("perf/streams: NDJSON", () => {
  it("parses whole lines", () => {
    const out = [];
    const p = createNDJSONParser((o) => out.push(o));
    p.feed('{"a":1}\n{"a":2}\n');
    assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
    assert.equal(p.count(), 2);
  });

  it("reassembles records split across chunks", () => {
    const out = [];
    const p = createNDJSONParser((o) => out.push(o));
    p.feed('{"na');
    p.feed('me":"ne');
    p.feed('xus"}\n{"x":');
    p.feed('true}\n');
    assert.deepEqual(out, [{ name: "nexus" }, { x: true }]);
  });

  it("flushes a trailing record without newline on end()", () => {
    const out = [];
    const p = createNDJSONParser((o) => out.push(o));
    p.feed('{"a":1}\n{"a":2}');
    assert.equal(out.length, 1);
    p.end();
    assert.equal(out.length, 2);
  });

  it("handles CRLF line endings", () => {
    const out = [];
    const p = createNDJSONParser((o) => out.push(o));
    p.feed('{"a":1}\r\n{"a":2}\r\n');
    assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
  });

  it("routes invalid JSON to onError and keeps going", () => {
    const out = [], errs = [];
    const p = createNDJSONParser((o) => out.push(o), { onError: (e, line) => errs.push(line) });
    p.feed('{"ok":1}\nnot json\n{"ok":2}\n');
    assert.deepEqual(out, [{ ok: 1 }, { ok: 2 }]);
    assert.equal(errs.length, 1);
    assert.equal(errs[0], "not json");
  });

  it("reassembles a multi-byte UTF-8 char split across Buffer chunks", () => {
    const out = [];
    const p = createNDJSONParser((o) => out.push(o));
    const full = Buffer.from('{"s":"\u{1F680}"}\n', "utf8"); // rocket emoji (4 bytes)
    // split inside the emoji's bytes
    p.feed(full.slice(0, 10));
    p.feed(full.slice(10));
    assert.equal(out.length, 1);
    assert.equal(out[0].s, "\u{1F680}");
  });
});

describe("perf/streams: SSE", () => {
  it("parses simple data events", () => {
    const evs = [];
    const p = createSSEParser((e) => evs.push(e));
    p.feed("data: hello\n\n");
    p.feed("data: world\n\n");
    assert.equal(evs.length, 2);
    assert.equal(evs[0].data, "hello");
    assert.equal(evs[1].data, "world");
  });

  it("joins multi-line data fields with newlines", () => {
    const evs = [];
    const p = createSSEParser((e) => evs.push(e));
    p.feed("data: line1\ndata: line2\n\n");
    assert.equal(evs[0].data, "line1\nline2");
  });

  it("captures event type and id", () => {
    const evs = [];
    const p = createSSEParser((e) => evs.push(e));
    p.feed("event: ping\nid: 42\ndata: {}\n\n");
    assert.equal(evs[0].event, "ping");
    assert.equal(evs[0].id, "42");
  });

  it("ignores comment lines", () => {
    const evs = [];
    const p = createSSEParser((e) => evs.push(e));
    p.feed(": this is a comment\ndata: real\n\n");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].data, "real");
  });

  it("reassembles events split across chunks", () => {
    const evs = [];
    const p = createSSEParser((e) => evs.push(e));
    p.feed("data: par");
    p.feed("tial");
    p.feed("\n\n");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].data, "partial");
  });

  it("flushes a final event lacking a trailing blank line on end()", () => {
    const evs = [];
    const p = createSSEParser((e) => evs.push(e));
    p.feed("data: last");
    assert.equal(evs.length, 0);
    p.end();
    assert.equal(evs.length, 1);
    assert.equal(evs[0].data, "last");
  });

  it("strips exactly one leading space after the colon", () => {
    const evs = [];
    const p = createSSEParser((e) => evs.push(e));
    p.feed("data:  two-spaces\n\n"); // one stripped, one kept
    assert.equal(evs[0].data, " two-spaces");
  });
});

describe("perf/streams: sseDataEvents helper", () => {
  it("parses JSON data payloads and detects [DONE]", () => {
    const chunks = [];
    let done = false;
    const p = sseDataEvents((obj) => chunks.push(obj), { onDone: () => { done = true; } });
    p.feed('data: {"delta":"a"}\n\n');
    p.feed('data: {"delta":"b"}\n\n');
    p.feed("data: [DONE]\n\n");
    assert.deepEqual(chunks, [{ delta: "a" }, { delta: "b" }]);
    assert.equal(done, true);
  });

  it("reports parse errors without throwing", () => {
    const errs = [];
    const p = sseDataEvents(() => {}, { onParseError: (e, raw) => errs.push(raw) });
    p.feed("data: {bad json}\n\n");
    assert.equal(errs.length, 1);
  });
});

describe("perf/streams: streamToParser", () => {
  it("pumps a Readable through a parser", async () => {
    const out = [];
    const p = createNDJSONParser((o) => out.push(o));
    const r = Readable.from([Buffer.from('{"a":1}\n'), Buffer.from('{"b":2}\n')]);
    const count = await streamToParser(r, p);
    assert.equal(count, 2);
    assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  });
});
