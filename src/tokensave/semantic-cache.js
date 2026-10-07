"use strict";
// ================= Near-Duplicate Semantic Response Cache =================
// Serves a cached answer when a NEW request is a near-duplicate (paraphrase, re-
// ordering, whitespace/filler changes) of a prior one. No embeddings, no network,
// no dependencies — similarity comes from SimHash over word shingles with an LSH
// banding index so lookup stays sub-linear.
//
// WHY SIMHASH: a locality-sensitive hash where similar documents produce
// Hamming-close 64-bit fingerprints. "scan the target for open ports" and
// "scan target for open ports please" differ by a filler word yet land within a
// couple of bits. The match threshold is a deterministic max-Hamming distance.
//
// LSH BANDING: the 64-bit fingerprint is split into B bands of R bits. Two
// fingerprints within the threshold almost always collide in at least one band,
// so we only compare the query against candidates sharing a band rather than the
// whole cache. Deterministic and order-independent.
//
// A complementary MinHash Jaccard estimator is provided for callers who prefer
// set-overlap similarity over SimHash Hamming distance.

const MASK64 = (1n << 64n) - 1n;

// 64-bit FNV-1a over a UTF-8 string. Deterministic, no dependencies.
function fnv1a64(str) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i) & 0xff);
    hash = (hash * prime) & MASK64;
    // Mix in the high byte of multibyte chars so wide characters still matter.
    const hi = str.charCodeAt(i) >> 8;
    if (hi) { hash ^= BigInt(hi); hash = (hash * prime) & MASK64; }
  }
  return hash & MASK64;
}

// Tokenize to lowercase word shingles (k-grams of words). k-grams capture local
// word order so "open ports scan" != "scan open ports" at the shingle level.
function shingles(text, k) {
  k = k || 2;
  const words = String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  if (words.length === 0) return [];
  if (words.length < k) return [words.join(" ")];
  const out = [];
  for (let i = 0; i + k <= words.length; i++) out.push(words.slice(i, i + k).join(" "));
  return out;
}

/**
 * Compute a 64-bit SimHash fingerprint (as a BigInt) of `text`.
 * @param {string} text
 * @param {number} [k] - shingle size (default 2)
 * @returns {bigint}
 */
function simhash(text, k) {
  const grams = shingles(text, k);
  if (grams.length === 0) return 0n;
  const v = new Array(64).fill(0);
  // Weight by shingle frequency (common shingles count more).
  const freq = new Map();
  for (const g of grams) freq.set(g, (freq.get(g) || 0) + 1);
  for (const [g, w] of freq) {
    const h = fnv1a64(g);
    for (let b = 0; b < 64; b++) {
      if ((h >> BigInt(b)) & 1n) v[b] += w; else v[b] -= w;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= (1n << BigInt(b));
  return out;
}

/** Hamming distance between two 64-bit fingerprints. */
function hamming(a, b) {
  let x = (a ^ b) & MASK64;
  let count = 0;
  while (x) { x &= x - 1n; count++; }
  return count;
}

/** SimHash similarity in [0,1] = 1 - hamming/64. */
function simhashSimilarity(a, b) {
  return 1 - hamming(a, b) / 64;
}

// ---- MinHash (alternative set-overlap similarity) ----

// A small bank of deterministic hash permutations for MinHash signatures.
function minhashParams(numHashes) {
  const params = [];
  // Odd multipliers and varied addends derived deterministically.
  for (let i = 0; i < numHashes; i++) {
    params.push({ a: BigInt(2 * i + 1) * 0x9e3779b97f4a7c15n + 1n, b: BigInt(i) * 0x7f4a7c15n + 0x165667b1n });
  }
  return params;
}

/**
 * Compute a MinHash signature (array of BigInt) for `text`.
 * @param {string} text
 * @param {number} [numHashes] - signature length (default 32)
 * @param {number} [k] - shingle size (default 2)
 */
function minhash(text, numHashes, k) {
  numHashes = numHashes || 32;
  const params = minhashParams(numHashes);
  const grams = shingles(text, k);
  const sig = new Array(numHashes).fill(MASK64);
  for (const g of grams) {
    const h = fnv1a64(g);
    for (let i = 0; i < numHashes; i++) {
      const v = ((params[i].a * h) + params[i].b) & MASK64;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity from two MinHash signatures of equal length. */
function minhashSimilarity(sigA, sigB) {
  const n = Math.min(sigA.length, sigB.length);
  if (n === 0) return 0;
  let same = 0;
  for (let i = 0; i < n; i++) if (sigA[i] === sigB[i]) same++;
  return same / n;
}

// ================= The Cache =================

class SemanticCache {
  /**
   * @param {object} [opts]
   *   maxHamming  - max fingerprint distance to count as a hit (default 3 of 64)
   *   bands       - LSH bands (default 8; 8 bands * 8 bits = 64)
   *   maxEntries  - size bound; oldest-by-insertion evicted first (default 500)
   *   ttlMs       - entry time-to-live (default 0 = no expiry)
   *   shingleK    - shingle size for fingerprints (default 2)
   */
  constructor(opts) {
    opts = opts || {};
    this.maxHamming = opts.maxHamming == null ? 3 : opts.maxHamming;
    this.bands = opts.bands || 8;
    this.rows = Math.floor(64 / this.bands); // bits per band
    this.maxEntries = opts.maxEntries || 500;
    this.ttlMs = opts.ttlMs || 0;
    this.shingleK = opts.shingleK || 2;
    this._entries = new Map();         // id -> { id, sig, value, key, createdAt, hits }
    this._buckets = new Map();         // "band:value" -> Set(id)
    this._seq = 0;
    this.stats = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0 };
  }

  // Band keys for an entry's fingerprint.
  _bandKeys(sig) {
    const keys = [];
    for (let band = 0; band < this.bands; band++) {
      const shift = BigInt(band * this.rows);
      const mask = (1n << BigInt(this.rows)) - 1n;
      const part = (sig >> shift) & mask;
      keys.push(band + ":" + part.toString(16));
    }
    return keys;
  }

  _indexBuckets(id, sig) {
    for (const bk of this._bandKeys(sig)) {
      let set = this._buckets.get(bk);
      if (!set) { set = new Set(); this._buckets.set(bk, set); }
      set.add(id);
    }
  }

  _deindexBuckets(id, sig) {
    for (const bk of this._bandKeys(sig)) {
      const set = this._buckets.get(bk);
      if (set) { set.delete(id); if (set.size === 0) this._buckets.delete(bk); }
    }
  }

  _expired(entry, now) {
    return this.ttlMs > 0 && (now - entry.createdAt) > this.ttlMs;
  }

  _remove(id) {
    const e = this._entries.get(id);
    if (!e) return;
    this._deindexBuckets(id, e.sig);
    this._entries.delete(id);
  }

  /**
   * Store a response under its request text.
   * @param {string} requestText
   * @param {*} value - the response to cache
   * @param {object} [meta] - stored alongside, e.g. { tokens, cost }
   * @returns {string} entry id
   */
  set(requestText, value, meta) {
    const sig = simhash(requestText, this.shingleK);
    const seq = this._seq++;
    const id = "e" + seq;
    const entry = {
      id, seq, sig, value,
      key: String(requestText || ""),
      meta: meta || {},
      createdAt: Date.now(),
      hits: 0,
    };
    this._entries.set(id, entry);
    this._indexBuckets(id, sig);
    this.stats.sets++;
    // Enforce size bound (evict oldest by insertion order — Map preserves it).
    while (this._entries.size > this.maxEntries) {
      const oldest = this._entries.keys().next().value;
      this._remove(oldest);
      this.stats.evictions++;
    }
    return id;
  }

  /**
   * Look up a near-duplicate of `requestText`.
   * @param {string} requestText
   * @returns {{ hit:boolean, value?:*, distance?:number, similarity?:number, id?:string, meta?:object }}
   */
  get(requestText) {
    const now = Date.now();
    const sig = simhash(requestText, this.shingleK);

    // Gather candidates from shared LSH bands.
    const candidates = new Set();
    for (const bk of this._bandKeys(sig)) {
      const set = this._buckets.get(bk);
      if (set) for (const id of set) candidates.add(id);
    }

    let best = null;
    for (const id of candidates) {
      const e = this._entries.get(id);
      if (!e) continue;
      if (this._expired(e, now)) { this._remove(id); this.stats.expirations++; continue; }
      const dist = hamming(sig, e.sig);
      if (dist <= this.maxHamming) {
        // Deterministic tie-break: smaller distance, then earlier (smaller seq).
        if (!best || dist < best.dist || (dist === best.dist && e.seq < best.e.seq)) {
          best = { e, dist };
        }
      }
    }

    if (best) {
      best.e.hits++;
      this.stats.hits++;
      return {
        hit: true,
        value: best.e.value,
        distance: best.dist,
        similarity: +(1 - best.dist / 64).toFixed(4),
        id: best.e.id,
        meta: best.e.meta,
      };
    }
    this.stats.misses++;
    return { hit: false };
  }

  /** Remove expired entries proactively. Returns the number purged. */
  prune() {
    const now = Date.now();
    let purged = 0;
    for (const id of [...this._entries.keys()]) {
      const e = this._entries.get(id);
      if (this._expired(e, now)) { this._remove(id); this.stats.expirations++; purged++; }
    }
    return purged;
  }

  get size() { return this._entries.size; }

  /** Hit rate over all get() calls so far, in [0,1]. */
  hitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? +(this.stats.hits / total).toFixed(4) : 0;
  }

  clear() {
    this._entries.clear();
    this._buckets.clear();
    this.stats = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0 };
  }
}

module.exports = {
  SemanticCache,
  simhash, hamming, simhashSimilarity,
  minhash, minhashSimilarity,
  shingles, fnv1a64,
};
