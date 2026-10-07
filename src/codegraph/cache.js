"use strict";
// ===================== Code Graph — Incremental Index Cache =====================
// Re-indexing a large repo on every query is wasteful: almost nothing changed.
// This cache stores each file's parse result keyed by (mtimeMs, size) with a SHA-1
// content hash for verification. The fast path compares mtime+size (a cheap stat,
// no read); on a match the cached parse is reused and the file is never opened. On
// a miss the caller re-parses and calls set(). The cache is a single JSON file, so
// it survives across process runs. Tracks hit/miss counts for benchmarking.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const CACHE_VERSION = 2;

function sha1(text) { return crypto.createHash("sha1").update(String(text == null ? "" : text)).digest("hex"); }

class IndexCache {
  constructor(file) {
    this.file = file || null;
    this.entries = Object.create(null); // relpath -> { mtime, size, hash, record }
    this.hits = 0; this.misses = 0;
    this.loaded = false;
  }

  // load() -> this. Silently starts empty on any read/parse error.
  load() {
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && raw.version === CACHE_VERSION && raw.entries) this.entries = raw.entries;
    } catch (_) { /* fresh cache */ }
    return this;
  }

  // hit(relpath, stat) -> cached record | null (fast path: mtime+size only).
  hit(relpath, stat) {
    const e = this.entries[relpath];
    if (e && e.mtime === stat.mtimeMs && e.size === stat.size) { this.hits++; return e.record; }
    this.misses++;
    return null;
  }

  // verify(relpath, content) -> true if the stored hash matches current content.
  verify(relpath, content) {
    const e = this.entries[relpath];
    return !!e && e.hash === sha1(content);
  }

  // set(relpath, stat, content, record) -> record (also updates the entry).
  set(relpath, stat, content, record) {
    this.entries[relpath] = { mtime: stat.mtimeMs, size: stat.size, hash: sha1(content), record };
    return record;
  }

  // prune(liveSet) — drop entries for files no longer present.
  prune(liveSet) {
    for (const k of Object.keys(this.entries)) if (!liveSet.has(k)) delete this.entries[k];
  }

  // save() -> boolean. Writes atomically via a temp file + rename.
  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp" + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries: this.entries }));
      fs.renameSync(tmp, this.file);
      return true;
    } catch (_) { return false; }
  }

  summary() { const total = this.hits + this.misses; return { hits: this.hits, misses: this.misses, hitRate: total ? +(this.hits / total).toFixed(3) : 0, entries: Object.keys(this.entries).length }; }
}

module.exports = { IndexCache, sha1, CACHE_VERSION };
