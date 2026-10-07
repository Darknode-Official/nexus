"use strict";
// ===================== Retrieval — Incremental, Persistable Store =====================
// Keeps the chunk set and the inverted index in sync with a codebase as it
// changes, without re-reading or re-tokenizing files that did not change. Mirrors
// the perf subsystem's file-cache discipline:
//
//   • Each tracked file records (sha1, mtimeMs, size). A re-sync does a cheap
//     stat() first: if mtime AND size are unchanged, the file is skipped with no
//     read. If they differ, the content is read and hashed; an equal hash still
//     skips the expensive re-chunk (editors rewrite identical bytes).
//   • add/update/remove operate per file and keep the BM25 index consistent by
//     removing a file's old chunk postings before inserting new ones.
//   • The whole store serializes to `.nexus/retrieval.json` and rehydrates from
//     it, so a warm start pays for parsing only the files that changed since.
//
// Zero dependencies beyond node:fs / node:crypto. Deterministic.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chunkFile } = require("./chunker");
const { termFrequencies } = require("./tokenize");
const { createIndex } = require("./bm25");

let normalize;
try { ({ normalize } = require("../codegraph/depgraph")); }
catch (_) { normalize = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, ""); }

function sha1(s) { return crypto.createHash("sha1").update(String(s == null ? "" : s)).digest("hex"); }

/**
 * Create a retrieval store.
 * @param {object} [opts]
 * @param {boolean} [opts.storeContent=true] - persist chunk text (so retrieval
 *   needs no file reads). When false, content is kept in memory only.
 * @param {object} [opts.chunkOpts] - forwarded to the chunker.
 */
function createStore(opts) {
  opts = opts || {};
  const storeContent = opts.storeContent !== false;
  const chunkOpts = opts.chunkOpts || {};

  const index = createIndex();
  const chunks = new Map();  // chunkId -> chunk record (+ tf Map, tokens)
  const files = new Map();   // normFile -> { hash, mtimeMs, size, chunkIds:[] }

  function removeFile(file) {
    const nf = normalize(file);
    const rec = files.get(nf);
    if (!rec) return false;
    for (const id of rec.chunkIds) { index.remove(id); chunks.delete(id); }
    files.delete(nf);
    return true;
  }

  /**
   * Add or update a file from in-memory source.
   * @param {string} file
   * @param {string} source
   * @param {object} [meta] - { mtimeMs, size } to record for fast stat checks.
   * @returns {{file,changed,chunks,hash}}
   */
  function addFile(file, source, meta) {
    const nf = normalize(file);
    const text = String(source == null ? "" : source);
    const hash = sha1(text);
    const prev = files.get(nf);
    if (prev && prev.hash === hash) {
      // Content identical — only refresh stat metadata.
      if (meta) { prev.mtimeMs = meta.mtimeMs != null ? meta.mtimeMs : prev.mtimeMs; prev.size = meta.size != null ? meta.size : prev.size; }
      return { file: nf, changed: false, chunks: prev.chunkIds.length, hash };
    }
    if (prev) removeFile(nf);

    const produced = chunkFile(nf, text, chunkOpts);
    const chunkIds = [];
    for (const c of produced) {
      const tf = termFrequencies(c.content);
      const tokens = [...tf.values()].reduce((a, v) => a + v, 0);
      const rec = {
        id: c.id, file: c.file, lang: c.lang, kind: c.kind, name: c.name,
        startLine: c.startLine, endLine: c.endLine, nLines: c.nLines,
        symbols: c.symbols, tf, tokens,
        content: storeContent ? c.content : undefined,
        _mem: c.content, // always keep in memory for the current session
      };
      chunks.set(c.id, rec);
      index.add(c.id, tf);
      chunkIds.push(c.id);
    }
    files.set(nf, {
      hash,
      mtimeMs: meta ? meta.mtimeMs : null,
      size: meta ? meta.size : text.length,
      chunkIds,
    });
    return { file: nf, changed: true, chunks: chunkIds.length, hash };
  }

  /**
   * Sync a file from disk using the fast stat path. Reads/re-chunks only when
   * mtime+size or hash changed. Removes the file from the index if it is gone.
   * @param {string} absOrRel - path to read
   * @param {string} [asFile] - the key to store it under (default: the path given)
   */
  function syncPath(absOrRel, asFile) {
    const key = normalize(asFile || absOrRel);
    let st;
    try { st = fs.statSync(absOrRel); }
    catch (_) { const removed = removeFile(key); return { file: key, changed: removed, missing: true }; }
    const prev = files.get(key);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      return { file: key, changed: false, chunks: prev.chunkIds.length };
    }
    let content;
    try { content = fs.readFileSync(absOrRel, "utf8"); }
    catch (_) { return { file: key, changed: false, error: "read-failed" }; }
    return addFile(key, content, { mtimeMs: st.mtimeMs, size: st.size });
  }

  function getChunk(id) { return chunks.get(id) || null; }
  function allChunks() { return [...chunks.values()]; }
  function content(id) { const c = chunks.get(id); return c ? (c._mem != null ? c._mem : c.content) : null; }
  function has(file) { return files.has(normalize(file)); }

  function stats() {
    return {
      files: files.size,
      chunks: chunks.size,
      index: index.stats(),
    };
  }

  // ---- Persistence ----
  function toJSON() {
    const chunkArr = [];
    for (const c of chunks.values()) {
      chunkArr.push({
        id: c.id, file: c.file, lang: c.lang, kind: c.kind, name: c.name,
        startLine: c.startLine, endLine: c.endLine, nLines: c.nLines,
        symbols: c.symbols, tokens: c.tokens,
        tf: [...c.tf.entries()],
        content: storeContent ? (c._mem != null ? c._mem : c.content) : undefined,
      });
    }
    return {
      version: 1,
      storeContent,
      files: [...files.entries()].map(([k, v]) => [k, { hash: v.hash, mtimeMs: v.mtimeMs, size: v.size, chunkIds: v.chunkIds }]),
      chunks: chunkArr,
    };
  }

  function fromJSON(snap) {
    chunks.clear(); files.clear(); index.fromJSON(null);
    if (!snap) return api;
    for (const c of (snap.chunks || [])) {
      const tf = new Map(c.tf || []);
      const rec = {
        id: c.id, file: c.file, lang: c.lang, kind: c.kind, name: c.name,
        startLine: c.startLine, endLine: c.endLine, nLines: c.nLines,
        symbols: c.symbols || [], tf, tokens: c.tokens != null ? c.tokens : [...tf.values()].reduce((a, v) => a + v, 0),
        content: c.content,
        _mem: c.content != null ? c.content : null,
      };
      chunks.set(c.id, rec);
      index.add(c.id, tf);
    }
    for (const [k, v] of (snap.files || [])) files.set(k, v);
    return api;
  }

  function save(file) {
    const target = file || opts.cacheFile;
    if (!target) throw new Error("retrieval store: no cache file given");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(toJSON()));
    return target;
  }

  function load(file) {
    const target = file || opts.cacheFile;
    if (!target) return api;
    try {
      const snap = JSON.parse(fs.readFileSync(target, "utf8"));
      fromJSON(snap);
    } catch (_) { /* cold start */ }
    return api;
  }

  const api = {
    index, addFile, removeFile, syncPath, getChunk, allChunks, content, has, stats,
    toJSON, fromJSON, save, load,
    files, chunks,
  };
  return api;
}

module.exports = { createStore, sha1 };
