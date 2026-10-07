"use strict";
// ===================== Retrieval — MMR Diversification =====================
// Top-N by score alone wastes a token budget on near-duplicates: the three
// highest-scoring chunks are often the same helper copied across files, or
// overlapping windows of one big function. Maximal Marginal Relevance (Carbonell
// & Goldstein, 1998) re-ranks to balance relevance against novelty:
//
//   MMR = argmax_{c in R\S} [ λ · rel(c) − (1−λ) · max_{d in S} sim(c, d) ]
//
// λ=1 is pure relevance (no diversification); λ=0 is pure novelty. We default to
// 0.7 (relevance-leaning). Similarity is Jaccard over each chunk's term SET — a
// bounded, deterministic, dependency-free measure that captures lexical overlap
// well for code. Selection is greedy and deterministic (ties broken by id).

/** Jaccard similarity of two Sets. 0 when either is empty. */
function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Re-rank candidates with MMR.
 * @param {Array<{id, score, terms:(Set|Iterable)}>} candidates - each needs an
 *   id, a relevance score, and a `terms` set (or iterable) for similarity.
 * @param {object} [opts] - { lambda=0.7, limit=Infinity, simFn=jaccard }
 * @returns {Array<object>} selected candidates in MMR order, each annotated with
 *   `mmrScore` and `redundancy` (the max similarity to already-selected items).
 */
function mmr(candidates, opts) {
  opts = opts || {};
  const lambda = opts.lambda == null ? 0.7 : clamp01(opts.lambda);
  const limit = opts.limit == null ? Infinity : opts.limit;
  const simFn = opts.simFn || jaccard;

  // Normalize relevance to [0,1] so λ trades off against the [0,1] similarity on
  // a comparable scale. Guards against a single dominant raw score.
  const items = candidates.map((c) => ({
    ref: c,
    id: c.id,
    rel: Number(c.score) || 0,
    terms: c.terms instanceof Set ? c.terms : new Set(c.terms || []),
  }));
  const maxRel = items.reduce((m, it) => Math.max(m, it.rel), 0) || 1;
  for (const it of items) it.relN = it.rel / maxRel;

  const selected = [];
  const remaining = items.slice();

  while (remaining.length && selected.length < limit) {
    let best = null, bestVal = -Infinity, bestIdx = -1, bestRed = 0;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let maxSim = 0;
      for (const s of selected) maxSim = Math.max(maxSim, simFn(cand.terms, s.terms));
      const val = lambda * cand.relN - (1 - lambda) * maxSim;
      // Deterministic tie-break: higher val, then higher raw rel, then smaller id.
      if (
        val > bestVal + 1e-12 ||
        (Math.abs(val - bestVal) <= 1e-12 && cand.rel > (best ? best.rel : -Infinity)) ||
        (best && Math.abs(val - bestVal) <= 1e-12 && cand.rel === best.rel && cand.id < best.id)
      ) {
        best = cand; bestVal = val; bestIdx = i; bestRed = maxSim;
      }
    }
    selected.push(best);
    best.mmrScore = +bestVal.toFixed(6);
    best.redundancy = +bestRed.toFixed(6);
    remaining.splice(bestIdx, 1);
  }

  return selected.map((it) => Object.assign({}, it.ref, {
    mmrScore: it.mmrScore,
    redundancy: it.redundancy,
  }));
}

function clamp01(x) { x = Number(x); return x < 0 ? 0 : x > 1 ? 1 : x; }

module.exports = { mmr, jaccard };
