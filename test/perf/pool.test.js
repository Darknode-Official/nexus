"use strict";
// Tests for the keep-alive connection pool using a real local HTTP server (no external
// network): basic request, JSON round-trip, socket reuse across calls, abort, timeout,
// and retry/backoff.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createPool } = require("../../src/perf/pool");

let server, base, hits;

before(async () => {
  hits = { total: 0, flaky: 0 };
  server = http.createServer((req, res) => {
    hits.total++;
    if (req.url === "/json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, method: req.method })); return; }
    if (req.url === "/echo") { let b = ""; req.on("data", (c) => b += c); req.on("end", () => res.end(b)); return; }
    if (req.url === "/slow") { setTimeout(() => res.end("late"), 200); return; }
    if (req.url === "/flaky") { hits.flaky++; if (hits.flaky < 3) { res.statusCode = 500; res.end("err"); } else { res.end("recovered"); } return; }
    res.end("hello");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => { server.close(); });

describe("perf/pool: request", () => {
  it("performs a basic GET", async () => {
    const pool = createPool();
    const res = await pool.request(base + "/");
    assert.equal(res.status, 200);
    assert.equal(res.body, "hello");
    pool.destroy();
  });

  it("sends a request body (POST)", async () => {
    const pool = createPool();
    const res = await pool.request(base + "/echo", { method: "POST", body: "payload" });
    assert.equal(res.body, "payload");
    pool.destroy();
  });

  it("round-trips JSON", async () => {
    const pool = createPool();
    const { status, data } = await pool.json(base + "/json", { method: "POST", json: { a: 1 } });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.method, "POST");
    pool.destroy();
  });

  it("reuses keep-alive sockets across sequential requests", async () => {
    const pool = createPool({ maxSockets: 2 });
    for (let i = 0; i < 5; i++) await pool.request(base + "/");
    const s = pool.stats();
    assert.equal(s.requests, 5);
    assert.ok(s.reused >= 1, "expected socket reuse, reused=" + s.reused + " created=" + s.created);
    assert.ok(s.reuseRate > 0);
    pool.destroy();
  });

  it("rejects on abort", async () => {
    const pool = createPool();
    const ac = new AbortController();
    const p = pool.request(base + "/slow", { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, (e) => e.name === "AbortError");
    pool.destroy();
  });

  it("rejects on timeout", async () => {
    const pool = createPool();
    await assert.rejects(pool.request(base + "/slow", { timeout: 30 }), (e) => e.name === "TimeoutError" || e.code === "ETIMEDOUT");
    pool.destroy();
  });

  it("does not throw on non-2xx (status is returned)", async () => {
    const pool = createPool();
    const res = await pool.request(base + "/flaky");
    assert.equal(res.status, 500);
    pool.destroy();
  });
});

describe("perf/pool: withRetry", () => {
  it("retries a failing idempotent op until it succeeds", async () => {
    hits.flaky = 0;
    const pool = createPool();
    const out = await pool.withRetry(async () => {
      const res = await pool.request(base + "/flaky");
      if (res.status >= 500) throw new Error("server " + res.status);
      return res.body;
    }, { retries: 5, baseDelay: 5, maxDelay: 20 });
    assert.equal(out, "recovered");
    assert.ok(pool.stats().retries >= 1);
    pool.destroy();
  });

  it("gives up after the retry budget", async () => {
    const pool = createPool();
    let attempts = 0;
    await assert.rejects(pool.withRetry(async () => { attempts++; throw new Error("always"); }, { retries: 2, baseDelay: 2 }), /always/);
    assert.equal(attempts, 3); // initial + 2 retries
    pool.destroy();
  });

  it("does not retry AbortError by default", async () => {
    const pool = createPool();
    let attempts = 0;
    await assert.rejects(pool.withRetry(async () => { attempts++; const e = new Error("stop"); e.name = "AbortError"; throw e; }, { retries: 3, baseDelay: 2 }));
    assert.equal(attempts, 1);
    pool.destroy();
  });
});
