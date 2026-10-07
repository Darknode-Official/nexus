"use strict";
// Tests for the composed engine and the register() entrypoint.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const tokensave = require("../../src/tokensave");

describe("tokensave index — exports", () => {
  it("exposes register, createEngine, and all module namespaces", () => {
    assert.equal(typeof tokensave.register, "function");
    assert.equal(typeof tokensave.createEngine, "function");
    for (const m of ["compressor", "semanticCache", "contextPacker", "diffContext", "cachePlanner", "estimator"]) {
      assert.ok(tokensave[m], "missing namespace: " + m);
    }
  });

  it("exposes convenience re-exports", () => {
    assert.equal(typeof tokensave.compress, "function");
    assert.equal(typeof tokensave.pack, "function");
    assert.equal(typeof tokensave.planCache, "function");
    assert.equal(typeof tokensave.estimateTokens, "function");
    assert.equal(typeof tokensave.SemanticCache, "function");
    assert.equal(typeof tokensave.Ledger, "function");
  });
});

describe("tokensave register()", () => {
  it("attaches to a ctx object and returns the api", () => {
    const ctx = {};
    const api = tokensave.register(ctx, { model: "claude-opus-4" });
    assert.ok(ctx.tokensave === api);
    assert.ok(api.engine);
    assert.equal(api.engine.model, "claude-opus-4");
  });

  it("works without a ctx", () => {
    const api = tokensave.register(undefined, { model: "gpt-5" });
    assert.ok(api.engine);
  });
});

describe("tokensave engine — composed behavior with shared ledger", () => {
  it("compress attributes savings to the ledger", () => {
    const eng = tokensave.createEngine({ model: "gpt-5" });
    const r = eng.compress("Please kindly just fix the bug in order to pass the tests.", 2);
    assert.ok(r.saved >= 0);
    assert.ok(eng.ledger.byTechnique().compressor);
  });

  it("cache hit attributes saved tokens", () => {
    const eng = tokensave.createEngine({ model: "gpt-5" });
    const q = "how do I scan a host for open ports and services";
    eng.cacheSet(q, { answer: "nmap -sV" }, { tokens: 42 });
    const miss = eng.cacheGet("completely unrelated query about databases"); // miss
    assert.equal(miss.hit, false);
    const hit = eng.cacheGet(q);
    assert.equal(hit.hit, true);
    assert.ok(eng.ledger.byTechnique()["semantic-cache"].saved >= 42);
  });

  it("pack attributes dropped tokens as saved", () => {
    const eng = tokensave.createEngine({ model: "gpt-5" });
    const r = eng.pack([
      { id: "a", tokens: 50, relevance: 0.9 },
      { id: "b", tokens: 5000, relevance: 0.1 },
    ], 100);
    assert.ok(r.included.length >= 1);
    assert.ok(eng.ledger.byTechnique()["context-packer"]);
  });

  it("diff attributes whole-file savings", () => {
    const eng = tokensave.createEngine({ model: "gpt-5" });
    const oldText = Array.from({ length: 500 }, (_, i) => "line " + i).join("\n");
    const newText = oldText.replace("line 250", "line 250 changed");
    const r = eng.diff(oldText, newText, { neighbors: 2 });
    assert.ok(r.saved > 0);
    assert.ok(eng.ledger.byTechnique()["diff-context"].saved > 0);
  });

  it("summary and ledger report reflect accumulated savings", () => {
    const eng = tokensave.createEngine({ model: "claude-opus-4" });
    eng.compress("please just fix it really now", 2);
    const s = eng.summary();
    assert.ok(/Token-Saving Engine/.test(s));
    assert.ok(/saved/.test(eng.ledger.report()));
  });
});
