"use strict";
// ===================== Retrieval — Inverted Index + BM25 / TF-IDF =====================
// The lexical core. An inverted index maps each term to the documents (chunks)
// that contain it and how often (postings). Two rankers run over it:
//
//   • BM25 — the probabilistic ranking function used by production search engines
//     (Lucene/Elasticsearch defaults). It rewards term frequency with saturation
//     (k1) and normalizes for document length (b), and weights rare terms more via
//     IDF. Tunable k1/b.
//   • TF-IDF cosine — classic vector-space similarity, offered as an alternative
//     scorer and for callers who want a bounded [0,1]-ish similarity.
//
// The index supports incremental add/remove (used by the persistent store) and is
// fully DETERMINISTIC: equal documents in any insertion order produce equal
// rankings, with ties broken by document id. Zero dependencies.

/**
 * Create an empty inverted index.
 * @returns {object} index with add/remove/score methods and raw stats.
 */
function createIndex() {
  const postings = new Map();   // term -> Map(docId -> tf)
  const df = new Map();         // term -> document frequency
  const docLen = new Map();     // docId -> total token count
  let totalLen = 0;             // sum of all doc lengths (for avgdl)

  /**
   * Add a document. `terms` is the full ordered token stream (repeats allowed) OR
   * a precomputed Map(term->tf). Re-adding an existing id replaces it.
   */
  function add(docId, terms) {
    if (docLen.has(docId)) remove(docId);
    const tf = terms instanceof Map ? terms : toTf(terms);
    let len = 0;
    for (const [term, count] of tf) {
      len += count;
      let p = postings.get(term);
      if (!p) { p = new Map(); postings.set(term, p); }
      p.set(docId, count);
      df.set(term, (df.get(term) || 0) + 1);
    }
    docLen.set(docId, len);
    totalLen += len;
    return len;
  }

  /** Remove a document and all of its postings. No-op if unknown. */
  function remove(docId) {
    if (!docLen.has(docId)) return false;
    for (const [term, p] of postings) {
      if (p.has(docId)) {
        p.delete(docId);
        const d = (df.get(term) || 1) - 1;
        if (d <= 0) { df.delete(term); postings.delete(term); } else df.set(term, d);
      }
    }
    totalLen -= docLen.get(docId) || 0;
    docLen.delete(docId);
    return true;
  }

  function has(docId) { return docLen.has(docId); }
  function size() { return docLen.size; }
  function avgdl() { return docLen.size ? totalLen / docLen.size : 0; }

  // Robertson-Sparck-Jones IDF, floored at 0 so very common terms never go
  // negative (the "BM25+ nonnegative" convention).
  function idf(term) {
    const N = docLen.size;
    const n = df.get(term) || 0;
    if (N === 0 || n === 0) return 0;
    return Math.max(0, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  /**
   * BM25 ranking.
   * @param {string[]} qterms - unique query terms
   * @param {object} [opts] - { k1=1.5, b=0.75, limit=Infinity, minScore=0 }
   * @returns {Array<{id,score,matched:string[]}>} sorted desc, ties by id
   */
  function bm25(qterms, opts) {
    opts = opts || {};
    const k1 = opts.k1 == null ? 1.5 : opts.k1;
    const b = opts.b == null ? 0.75 : opts.b;
    const limit = opts.limit == null ? Infinity : opts.limit;
    const minScore = opts.minScore || 0;
    const avg = avgdl() || 1;
    const scores = new Map();   // docId -> score
    const matched = new Map();  // docId -> Set(term)

    for (const term of qterms) {
      const p = postings.get(term);
      if (!p) continue;
      const w = idf(term);
      if (w === 0) continue;
      for (const [docId, tf] of p) {
        const dl = docLen.get(docId) || 0;
        const denom = tf + k1 * (1 - b + b * (dl / avg));
        const contrib = w * ((tf * (k1 + 1)) / (denom || 1));
        scores.set(docId, (scores.get(docId) || 0) + contrib);
        let mset = matched.get(docId);
        if (!mset) { mset = new Set(); matched.set(docId, mset); }
        mset.add(term);
      }
    }
    return rank(scores, matched, minScore, limit);
  }

  /**
   * TF-IDF cosine similarity between the query and every matching document.
   * Scores are in [0,1]. Deterministic.
   * @param {string[]} qterms
   * @param {object} [opts] - { limit, minScore }
   */
  function cosine(qterms, opts) {
    opts = opts || {};
    const limit = opts.limit == null ? Infinity : opts.limit;
    const minScore = opts.minScore || 0;

    // Query vector (binary tf on unique terms, weighted by idf).
    const qvec = new Map();
    let qnorm = 0;
    for (const term of qterms) {
      const w = idf(term);
      if (w === 0) continue;
      qvec.set(term, w);
      qnorm += w * w;
    }
    qnorm = Math.sqrt(qnorm) || 1;

    // Accumulate dot products; compute each candidate doc's norm over ALL its
    // terms (not just query terms) for a true cosine.
    const dot = new Map();
    const matched = new Map();
    for (const [term, w] of qvec) {
      const p = postings.get(term);
      if (!p) continue;
      for (const [docId, tf] of p) {
        dot.set(docId, (dot.get(docId) || 0) + (tf * w) * w); // (tf*idf)*(idf) for query weight idf
        let mset = matched.get(docId); if (!mset) { mset = new Set(); matched.set(docId, mset); } mset.add(term);
      }
    }
    const docNorm = new Map();
    for (const [term, p] of postings) {
      const w = idf(term);
      if (w === 0) continue;
      for (const [docId, tf] of p) {
        if (!dot.has(docId)) continue; // only candidates
        docNorm.set(docId, (docNorm.get(docId) || 0) + (tf * w) * (tf * w));
      }
    }
    const scores = new Map();
    for (const [docId, d] of dot) {
      const dn = Math.sqrt(docNorm.get(docId) || 0) || 1;
      scores.set(docId, d / (qnorm * dn));
    }
    return rank(scores, matched, minScore, limit);
  }

  function rank(scores, matched, minScore, limit) {
    const out = [];
    for (const [id, score] of scores) {
      if (score < minScore) continue;
      out.push({ id, score: +score.toFixed(6), matched: [...(matched.get(id) || [])].sort() });
    }
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return isFinite(limit) ? out.slice(0, limit) : out;
  }

  /** Serializable snapshot of the index (for persistence). */
  function toJSON() {
    const post = {};
    for (const [term, p] of postings) post[term] = [...p.entries()];
    return {
      version: 1,
      postings: post,
      docLen: [...docLen.entries()],
      totalLen,
    };
  }

  /** Rehydrate from a toJSON() snapshot. Replaces current contents. */
  function fromJSON(snap) {
    postings.clear(); df.clear(); docLen.clear(); totalLen = 0;
    if (!snap) return api;
    for (const [term, entries] of Object.entries(snap.postings || {})) {
      const p = new Map(entries);
      postings.set(term, p);
      df.set(term, p.size);
    }
    for (const [id, len] of (snap.docLen || [])) docLen.set(id, len);
    totalLen = snap.totalLen || [...docLen.values()].reduce((a, v) => a + v, 0);
    return api;
  }

  const api = {
    add, remove, has, size, avgdl, idf, bm25, cosine, toJSON, fromJSON,
    stats: () => ({ docs: docLen.size, terms: postings.size, totalLen, avgdl: +avgdl().toFixed(2) }),
    _internals: { postings, df, docLen },
  };
  return api;
}

// Convert an ordered token stream to a term-frequency Map.
function toTf(terms) {
  const tf = new Map();
  for (const t of terms || []) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

module.exports = { createIndex, toTf };
