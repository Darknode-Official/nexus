"use strict";
// ============================= Incremental file layer =============================
// Make repeated scans of a large repo cheap. Two pieces:
//   • createFileCache — caches per-file work (parse result, hash, metrics) keyed by path,
//     invalidated by a fast mtime+size stat check and verified by content hash only when
//     the cheap check says "maybe changed". So an unchanged file costs one stat(); a changed
//     file costs one stat() + one read+hash. getOrCompute(path, fn) returns the cached value
//     when the file is unchanged and recomputes fn(content, path) when it isn't — the core
//     of "only re-analyze what actually changed" on every re-scan.
//   • createWatcher — a recursive-ish directory watcher built on fs.watch with debounced,
//     de-duplicated change events, so a burst of saves (editors write-then-rename, formatters
//     touch many files) collapses into one "these N paths changed" callback instead of a
//     storm. fs.watch recursion isn't portable on Linux, so this walks subdirectories and
//     attaches a watch per directory, tracking new/removed dirs as they appear.
// Honest about fs.watch: it is best-effort (can miss events under heavy churn, fires
// duplicates, and semantics vary by OS). The file cache's stat check is the source of
// truth; the watcher is an optimization to know *when* to re-scan, not *whether* a file
// changed — always confirm via the cache.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function hashContent(buf) { return crypto.createHash("sha1").update(buf).digest("hex"); }

/**
 * createFileCache(options)
 *   options.hashCheck   when true, verify changes by content hash after mtime/size differs,
 *                       and treat equal-hash-different-mtime as unchanged (default true).
 *                       When false, mtime+size alone decides (faster, no reads for the check).
 *   options.encoding    how getOrCompute reads files: "utf8" (default) or null for Buffer.
 * Methods: stat(path), changed(path), getOrCompute(path, fn), get(path), invalidate(path),
 * clear(), stats().
 */
function createFileCache(options) {
  const o = options || {};
  const hashCheck = o.hashCheck !== false;
  const encoding = o.encoding === undefined ? "utf8" : o.encoding;
  const entries = new Map(); // abspath -> { mtimeMs, size, hash, value, ts }
  const m = { hits: 0, misses: 0, recomputes: 0, statCalls: 0, hashCalls: 0, reads: 0 };

  function abs(p) { return path.resolve(p); }

  function statOf(p) {
    m.statCalls++;
    try { const st = fs.statSync(p); return { mtimeMs: st.mtimeMs, size: st.size, exists: true }; }
    catch (_) { return { mtimeMs: 0, size: 0, exists: false }; }
  }

  // Determine whether a path's content differs from what's cached.
  function changed(p) {
    const key = abs(p);
    const e = entries.get(key);
    const st = statOf(key);
    if (!e) return st.exists;              // never seen → "changed" (needs compute) if it exists
    if (!st.exists) return true;           // was cached, now gone → changed
    if (e.mtimeMs === st.mtimeMs && e.size === st.size) return false; // cheap path: identical
    if (!hashCheck) return true;           // size/mtime differ and we trust that
    // mtime/size differ — confirm by hashing (editors often rewrite identical content).
    try { const buf = fs.readFileSync(key); m.reads++; m.hashCalls++; const h = hashContent(buf); return h !== e.hash; }
    catch (_) { return true; }
  }

  /**
   * getOrCompute(p, fn) — return cached value if the file is unchanged since last compute,
   * else read it, run fn(content, path), cache and return. content is string/Buffer per
   * `encoding`. Throws if the file can't be read (propagates fs error).
   */
  function getOrCompute(p, fn) {
    const key = abs(p);
    const e = entries.get(key);
    const st = statOf(key);
    if (!st.exists) { entries.delete(key); throw Object.assign(new Error("ENOENT: " + key), { code: "ENOENT" }); }

    if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) { m.hits++; return e.value; }

    // Read once; reuse the buffer for both hash and compute.
    const buf = fs.readFileSync(key); m.reads++;
    const h = hashContent(buf); m.hashCalls++;
    if (e && hashCheck && e.hash === h) {
      // Content identical despite mtime change — refresh stat metadata, keep value.
      e.mtimeMs = st.mtimeMs; e.size = st.size; m.hits++; return e.value;
    }
    m.misses++; m.recomputes++;
    const content = encoding ? buf.toString(encoding) : buf;
    const value = fn(content, key);
    entries.set(key, { mtimeMs: st.mtimeMs, size: st.size, hash: h, value, ts: Date.now() });
    return value;
  }

  return {
    stat: statOf,
    changed,
    getOrCompute,
    get(p) { const e = entries.get(abs(p)); return e ? e.value : undefined; },
    has(p) { return entries.has(abs(p)); },
    invalidate(p) { return entries.delete(abs(p)); },
    clear() { entries.clear(); },
    size: () => entries.size,
    stats() { const total = m.hits + m.misses; return Object.assign({}, m, { size: entries.size, hitRate: total ? +(m.hits / total).toFixed(4) : 0 }); },
  };
}

/**
 * createWatcher(root, options)
 *   options.debounce   ms to coalesce a burst before firing (default 50)
 *   options.ignore     (relPath) => bool  skip dirs/files (default: node_modules, .git, dotdirs)
 *   options.recursive  watch subdirectories (default true)
 * Returns { on(event, cb), start(), close(), watchedDirs() }. Events:
 *   "change" → (paths[])  debounced set of changed/created/removed absolute paths
 *   "error"  → (err)
 * Call start() to begin; close() to stop and release all fs watchers.
 */
function createWatcher(root, options) {
  const o = options || {};
  const debounceMs = o.debounce != null ? Math.max(0, o.debounce | 0) : 50;
  const recursive = o.recursive !== false;
  const defaultIgnore = (rel) => { const base = path.basename(rel); return base === "node_modules" || base === ".git" || (base.length > 1 && base[0] === "." && base !== "." ); };
  const ignore = o.ignore || defaultIgnore;
  const absRoot = path.resolve(root);

  const listeners = { change: [], error: [] };
  const watchers = new Map(); // dir -> FSWatcher
  let pending = new Set();
  let timer = null;
  let started = false;

  function emit(ev, arg) { for (const cb of listeners[ev] || []) { try { cb(arg); } catch (_) {} } }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; if (pending.size) { const paths = Array.from(pending); pending = new Set(); emit("change", paths); } }, debounceMs);
    if (timer.unref) timer.unref();
  }

  function queue(abs) { pending.add(abs); scheduleFlush(); }

  function watchDir(dir) {
    if (watchers.has(dir)) return;
    let w;
    try { w = fs.watch(dir, { persistent: false }); }
    catch (e) { emit("error", e); return; }
    w.on("error", (e) => emit("error", e));
    w.on("change", (_type, filename) => {
      if (filename == null) { queue(dir); return; }
      const abs = path.join(dir, filename.toString());
      const rel = path.relative(absRoot, abs);
      if (rel && ignore(rel)) return;
      queue(abs);
      // A new subdirectory may have appeared — attach to it; a removed one self-cleans on error.
      if (recursive) { try { if (fs.statSync(abs).isDirectory() && !watchers.has(abs)) watchTree(abs); } catch (_) {} }
    });
    watchers.set(dir, w);
  }

  function watchTree(dir) {
    const rel = path.relative(absRoot, dir);
    if (rel && ignore(rel)) return;
    watchDir(dir);
    if (!recursive) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) { if (ent.isDirectory()) watchTree(path.join(dir, ent.name)); }
  }

  return {
    on(ev, cb) { if (listeners[ev]) listeners[ev].push(cb); return this; },
    start() { if (started) return this; started = true; watchTree(absRoot); return this; },
    close() { if (timer) { clearTimeout(timer); timer = null; } for (const w of watchers.values()) { try { w.close(); } catch (_) {} } watchers.clear(); pending = new Set(); started = false; },
    watchedDirs: () => Array.from(watchers.keys()),
    flush() { if (timer) { clearTimeout(timer); timer = null; } if (pending.size) { const p = Array.from(pending); pending = new Set(); emit("change", p); } },
  };
}

module.exports = { createFileCache, createWatcher, hashContent };
