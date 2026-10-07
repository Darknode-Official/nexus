"use strict";
// Tests for the incremental, persistable store: add/update/remove by file, hash
// short-circuit, disk sync with mtime fast path, prune, and JSON/disk round-trips.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore, sha1 } = require("../../src/retrieval/store");

describe("Retrieval — store incremental ops", () => {
  it("adds a file and indexes its chunks", () => {
    const s = createStore();
    const r = s.addFile("a.js", "export function foo(){ return 1; }\nexport function bar(){ return 2; }\n");
    assert.equal(r.changed, true);
    assert.equal(r.chunks, 2);
    assert.equal(s.stats().files, 1);
    assert.ok(s.index.bm25(["foo"]).length === 1);
  });

  it("short-circuits when re-adding identical content (hash match)", () => {
    const s = createStore();
    const src = "export function foo(){ return 1; }\n";
    s.addFile("a.js", src);
    const r = s.addFile("a.js", src);
    assert.equal(r.changed, false, "unchanged content is not re-chunked");
  });

  it("replaces chunks on update and keeps the index consistent", () => {
    const s = createStore();
    s.addFile("a.js", "export function foo(){ return 1; }\n");
    s.addFile("a.js", "export function renamed(){ return 1; }\n");
    assert.equal(s.index.bm25(["foo"]).length, 0, "old term gone");
    assert.equal(s.index.bm25(["renamed"]).length, 1, "new term present");
    assert.equal(s.stats().chunks, 1);
  });

  it("removes a file and all of its postings", () => {
    const s = createStore();
    s.addFile("a.js", "export function foo(){ return 1; }\n");
    assert.equal(s.removeFile("a.js"), true);
    assert.equal(s.stats().chunks, 0);
    assert.equal(s.index.bm25(["foo"]).length, 0);
    assert.equal(s.removeFile("a.js"), false, "removing again is a no-op");
  });

  it("exposes chunk content and metadata", () => {
    const s = createStore();
    s.addFile("a.js", "export function foo(){ return 1; }\n");
    const c = s.allChunks()[0];
    assert.equal(c.file, "a.js");
    assert.ok(s.content(c.id).includes("function foo"));
  });
});

describe("Retrieval — store disk sync (mtime/hash)", () => {
  it("syncs from disk and skips unchanged files on the fast path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ret-store-"));
    const fp = path.join(dir, "m.js");
    fs.writeFileSync(fp, "export function alpha(){ return 1; }\n");
    const s = createStore();
    const r1 = s.syncPath(fp, "m.js");
    assert.equal(r1.changed, true);
    const r2 = s.syncPath(fp, "m.js");
    assert.equal(r2.changed, false, "unchanged mtime+size => fast skip");

    // Modify and re-sync.
    fs.writeFileSync(fp, "export function beta(){ return 2; }\n");
    const r3 = s.syncPath(fp, "m.js");
    assert.equal(r3.changed, true);
    assert.equal(s.index.bm25(["beta"]).length, 1);

    // Delete and re-sync => removed from index.
    fs.rmSync(fp);
    const r4 = s.syncPath(fp, "m.js");
    assert.equal(r4.missing, true);
    assert.equal(s.stats().files, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Retrieval — store persistence", () => {
  it("round-trips via toJSON/fromJSON preserving rankings", () => {
    const s = createStore();
    s.addFile("a.js", "export function parseThing(){ return 1; }\n");
    s.addFile("b.js", "export function other(){ return 2; }\n");
    const snap = JSON.parse(JSON.stringify(s.toJSON()));
    const s2 = createStore();
    s2.fromJSON(snap);
    assert.equal(s2.stats().chunks, 2);
    assert.deepEqual(
      s.index.bm25(["parse", "thing"]).map((h) => h.id),
      s2.index.bm25(["parse", "thing"]).map((h) => h.id),
    );
    assert.ok(s2.content(s2.allChunks()[0].id), "content restored from snapshot");
  });

  it("saves to and loads from a cache file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ret-save-"));
    const cacheFile = path.join(dir, ".nexus", "retrieval.json");
    const s = createStore({ cacheFile });
    s.addFile("a.js", "export function saved(){ return 1; }\n");
    s.save();
    assert.ok(fs.existsSync(cacheFile));
    const s2 = createStore({ cacheFile });
    s2.load();
    assert.equal(s2.index.bm25(["saved"]).length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sha1 is stable and content-addressed", () => {
    assert.equal(sha1("abc"), sha1("abc"));
    assert.notEqual(sha1("abc"), sha1("abd"));
  });
});
