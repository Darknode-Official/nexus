"use strict";
// ===================== Repo Map — Incremental Extraction Cache =====================
// The expensive part of building the map is per-file work: masking the source,
// parsing symbols, counting references and extracting signatures (see extract.js).
// Almost none of that changes between two map builds — usually one file was edited.
// This cache stores each file's extraction keyed by (mtimeMs, size) with a SHA-1
// content hash for verification, mirroring the codegraph cache convention so the
// two subsystems behave consistently.
//
// Fast path: compare mtime+size (a cheap stat, no read); on a match the cached
// extraction is reused and the file is never opened or re-scanned. On a miss the
// caller re-extracts and calls set(). The PageRank step itself is cheap and is
// recomputed from the (mostly cached) per-file data each build — see README for the
// honest note on what "incremental" does and does not cover here.

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const CACHE_VERSION = 1;

function sha1(text) { return crypto.createHash("sha1").update(String(text == null ? "" : text)).digest("hex"); }

class RepoMapCache {
  /** @param {string|null} file - JSON cache path, or null for in-memory only */
  constructor(file) {
    this.file = file || null;
    this.entries = Object.create(null); // relpath -> { mtime, size, hash, data }
    this.hits = 0;
    this.misses = 0;
    this.loaded = false;
  }

  /** Load from disk. Silently starts empty on any read/parse/version error. */
  load() {
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && raw.version === CACHE_VERSION && raw.entries) this.entries = raw.entries;
    } catch (_) { /* fresh cache */ }
    return this;
  }

  /**
   * Fast-path lookup by stat. Returns cached extraction data or null.
   * @param {string} relpath
   * @param {{mtimeMs:number,size:number}} stat
   */
  hit(relpath, stat) {
    const e = this.entries[relpath];
    if (e && e.mtime === stat.mtimeMs && e.size === stat.size) { this.hits++; return e.data; }
    this.misses++;
    return null;
  }

  /** Content-hash lookup (used for in-memory sources with no stat). */
  hitByHash(relpath, content) {
    const e = this.entries[relpath];
    if (e && e.hash === sha1(content)) { this.hits++; return e.data; }
    this.misses++;
    return null;
  }

  /** Store an extraction. `stat` may be null for in-memory sources. */
  set(relpath, stat, content, data) {
    this.entries[relpath] = {
      mtime: stat ? stat.mtimeMs : 0,
      size: stat ? stat.size : String(content == null ? "" : content).length,
      hash: sha1(content),
      data,
    };
    return data;
  }

  /** Drop entries for files no longer present in `liveSet`. */
  prune(liveSet) {
    for (const k of Object.keys(this.entries)) if (!liveSet.has(k)) delete this.entries[k];
  }

  /** Persist atomically via temp file + rename. Returns boolean. */
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

  summary() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits, misses: this.misses,
      hitRate: total ? +(this.hits / total).toFixed(3) : 0,
      entries: Object.keys(this.entries).length,
    };
  }
}

module.exports = { RepoMapCache, sha1, CACHE_VERSION };
