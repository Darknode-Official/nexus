"use strict";
// ============================= Caching layer =============================
// Composable in-memory and on-disk caches for Nexus, with honest hit/miss metrics.
//   • createLRU   — LRU with optional TTL and byte-size accounting (evicts by count OR
//                   by total size), plus stale-while-revalidate: a stale entry is served
//                   immediately while a refresh runs in the background, so callers never
//                   block on a re-fetch. Uses a Map for O(1) LRU ordering (Map preserves
//                   insertion order; "touch" = delete+set to move to the most-recent end).
//   • createDiskCache — JSON entries under a directory, TTL-checked on read, with a small
//                   index for size/age accounting. Survives process restarts.
//   • memoizeAsync — wrap an async fn with an LRU (optionally single-flighted) so identical
//                   calls return the cached value and concurrent misses collapse to one run.
// Size accounting is an estimate (UTF-8 byte length of JSON for objects, .length for
// strings/buffers) unless you pass your own sizeOf — it is for bounding memory, not exact.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { singleFlight } = require("./coalesce");

function estimateSize(v) {
  if (v == null) return 1;
  if (typeof v === "string") return Buffer.byteLength(v);
  if (Buffer.isBuffer(v)) return v.length;
  if (typeof v === "number" || typeof v === "boolean") return 8;
  try { return Buffer.byteLength(JSON.stringify(v)); } catch (_) { return 64; }
}

/**
 * createLRU(options)
 *   max        max number of entries (default 500; 0/Infinity = unbounded by count)
 *   maxBytes   max total estimated size; evicts LRU entries past it (default Infinity)
 *   ttl        default time-to-live ms; 0 = no expiry (default 0)
 *   staleTtl   extra ms past ttl during which a stale value may still be served under SWR
 *              (default 0 = not served stale)
 *   sizeOf     custom (value) => bytes
 * Entries: get/set/has/peek/delete/clear plus getOrLoad (SWR) and stats().
 */
function createLRU(options) {
  const o = options || {};
  const max = o.max && o.max > 0 ? o.max : (o.max === 0 ? Infinity : 500);
  const maxBytes = o.maxBytes && o.maxBytes > 0 ? o.maxBytes : Infinity;
  const defaultTtl = Math.max(0, o.ttl | 0 || 0);
  const staleTtl = Math.max(0, o.staleTtl | 0 || 0);
  const sizeOf = o.sizeOf || estimateSize;

  const map = new Map(); // key -> { value, size, expires, staleUntil, born }
  let totalBytes = 0;
  const m = { hits: 0, misses: 0, stale: 0, sets: 0, evictions: 0, expirations: 0 };

  const now = () => Date.now();
  function isExpired(e, t) { return e.expires && t >= e.expires; }

  function evictIfNeeded() {
    // Evict least-recently-used (front of Map) until within both bounds.
    while ((map.size > max || totalBytes > maxBytes) && map.size > 0) {
      const oldestKey = map.keys().next().value;
      const e = map.get(oldestKey);
      map.delete(oldestKey); totalBytes -= e.size; m.evictions++;
    }
  }

  function rawDelete(key) {
    const e = map.get(key); if (!e) return false;
    map.delete(key); totalBytes -= e.size; return true;
  }

  function set(key, value, ttl) {
    const t = now();
    const size = sizeOf(value);
    const useTtl = ttl != null ? Math.max(0, ttl | 0) : defaultTtl;
    if (map.has(key)) { totalBytes -= map.get(key).size; map.delete(key); }
    const entry = { value, size, born: t, expires: useTtl ? t + useTtl : 0, staleUntil: useTtl ? t + useTtl + staleTtl : 0 };
    map.set(key, entry); totalBytes += size; m.sets++;
    evictIfNeeded();
    return value;
  }

  // Internal get that reports freshness without counting hit/miss metrics.
  function lookup(key) {
    const e = map.get(key); if (!e) return { state: "miss" };
    const t = now();
    if (!isExpired(e, t)) { map.delete(key); map.set(key, e); return { state: "fresh", entry: e }; } // touch → MRU
    if (staleTtl && e.staleUntil && t < e.staleUntil) return { state: "stale", entry: e };
    rawDelete(key); m.expirations++; return { state: "miss" };
  }

  function get(key) {
    const r = lookup(key);
    if (r.state === "fresh") { m.hits++; return r.entry.value; }
    if (r.state === "stale") { m.hits++; m.stale++; return r.entry.value; } // served, caller may still refresh
    m.misses++; return undefined;
  }

  /**
   * getOrLoad(key, loader, ttl) — stale-while-revalidate.
   *   fresh  → return cached value, no load.
   *   stale  → return cached value NOW, kick off loader() in the background to refresh.
   *   miss   → await loader(), cache it, return it.
   * loader returns the fresh value (sync or async). Background refresh errors are swallowed
   * (the stale value already served); pass onError to observe them.
   */
  function getOrLoad(key, loader, ttl, onError) {
    const r = lookup(key);
    if (r.state === "fresh") { m.hits++; return Promise.resolve(r.entry.value); }
    if (r.state === "stale") {
      m.hits++; m.stale++;
      const served = r.entry.value;
      Promise.resolve().then(loader).then((v) => set(key, v, ttl)).catch((e) => { if (onError) onError(e); });
      return Promise.resolve(served);
    }
    m.misses++;
    return Promise.resolve().then(loader).then((v) => { set(key, v, ttl); return v; });
  }

  return {
    get, set, getOrLoad,
    has(key) { const r = lookup(key); return r.state === "fresh" || r.state === "stale"; },
    peek(key) { const e = map.get(key); return e ? e.value : undefined; }, // no touch, no expiry check
    delete: rawDelete,
    clear() { map.clear(); totalBytes = 0; },
    keys: () => Array.from(map.keys()),
    get size() { return map.size; },
    get bytes() { return totalBytes; },
    stats() {
      const total = m.hits + m.misses;
      return Object.assign({}, m, { size: map.size, bytes: totalBytes, hitRate: total ? +(m.hits / total).toFixed(4) : 0 });
    },
  };
}

function hashKey(key) { return crypto.createHash("sha1").update(String(key)).digest("hex"); }

/**
 * createDiskCache(dir, options) — persistent JSON cache.
 *   options.ttl  default TTL ms (0 = none)
 * Entries stored as <dir>/<sha1(key)>.json = { key, value, born, expires }. Reads check
 * the TTL and delete expired files lazily. Synchronous fs for simplicity/determinism;
 * values must be JSON-serializable.
 */
function createDiskCache(dir, options) {
  const o = options || {};
  const defaultTtl = Math.max(0, o.ttl | 0 || 0);
  const m = { hits: 0, misses: 0, sets: 0, expirations: 0, errors: 0 };
  function ensure() { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
  function file(key) { return path.join(dir, hashKey(key) + ".json"); }

  return {
    get(key) {
      try {
        const rec = JSON.parse(fs.readFileSync(file(key), "utf8"));
        if (rec.expires && Date.now() >= rec.expires) { try { fs.unlinkSync(file(key)); } catch (_) {} m.expirations++; m.misses++; return undefined; }
        m.hits++; return rec.value;
      } catch (_) { m.misses++; return undefined; }
    },
    set(key, value, ttl) {
      ensure();
      const useTtl = ttl != null ? Math.max(0, ttl | 0) : defaultTtl;
      const rec = { key: String(key), value, born: Date.now(), expires: useTtl ? Date.now() + useTtl : 0 };
      try { fs.writeFileSync(file(key), JSON.stringify(rec)); m.sets++; return true; } catch (_) { m.errors++; return false; }
    },
    has(key) { try { const rec = JSON.parse(fs.readFileSync(file(key), "utf8")); return !(rec.expires && Date.now() >= rec.expires); } catch (_) { return false; } },
    delete(key) { try { fs.unlinkSync(file(key)); return true; } catch (_) { return false; } },
    clear() { try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f)); return true; } catch (_) { return false; } },
    // Delete all expired entries; returns count removed.
    prune() { let n = 0; try { for (const f of fs.readdirSync(dir)) { if (!f.endsWith(".json")) continue; try { const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); if (rec.expires && Date.now() >= rec.expires) { fs.unlinkSync(path.join(dir, f)); n++; } } catch (_) {} } } catch (_) {} return n; },
    stats() {
      let entries = 0, bytes = 0;
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) { entries++; try { bytes += fs.statSync(path.join(dir, f)).size; } catch (_) {} } } catch (_) {}
      const total = m.hits + m.misses;
      return Object.assign({}, m, { entries, bytes, hitRate: total ? +(m.hits / total).toFixed(4) : 0 });
    },
  };
}

/**
 * memoizeAsync(fn, options) — cache an async fn's results in an LRU keyed by its args.
 *   options.keyFn   derive key from args (default JSON.stringify of args)
 *   options.single  collapse concurrent identical misses into one run (default true)
 *   plus any createLRU option (max, maxBytes, ttl, staleTtl).
 * Returns the wrapped fn with .cache (the LRU) and .stats().
 */
function memoizeAsync(fn, options) {
  const o = options || {};
  const cache = createLRU(o);
  const keyFn = o.keyFn || ((...a) => (a.length <= 1 ? String(a[0]) : JSON.stringify(a)));
  const load = o.single === false ? fn : singleFlight(fn, keyFn);
  const wrapped = function (...args) {
    const k = keyFn(...args);
    return cache.getOrLoad(k, () => load(...args), o.ttl);
  };
  wrapped.cache = cache;
  wrapped.stats = () => cache.stats();
  return wrapped;
}

module.exports = { createLRU, createDiskCache, memoizeAsync, estimateSize, hashKey };
