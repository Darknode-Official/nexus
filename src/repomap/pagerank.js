"use strict";
// ===================== Repo Map — Personalized PageRank =====================
// A dependency-free, deterministic, weighted Personalized PageRank (PPR) over a
// directed graph. This is the importance engine behind the ranked repository map:
// nodes are files (and, downstream, symbols), edges are weighted "A references
// something defined in B" relations, and the stationary distribution of a random
// surfer that follows those edges (with restarts biased toward a personalization
// vector) is each node's structural importance.
//
// WHY PAGERANK FOR A REPO MAP: a file that is referenced by many *important*
// files is itself important — a recursive definition PageRank solves exactly. It
// naturally surfaces the handful of "load-bearing" modules an agent should always
// see, and the personalization vector lets us bias that toward the file(s) the
// agent is currently working on (eigenvector centrality "seen from" the task).
//
// METHOD: power iteration on the Google matrix
//     r = (1 - d) * p  +  d * ( W^T r  +  dangling_mass * p )
// where d is the damping factor, p the personalization vector (sums to 1), W the
// row-stochastic weighted adjacency, and dangling_mass the rank sitting on nodes
// with no out-edges (redistributed via p so probability is conserved). Iteration
// order is sorted, arithmetic is accumulation-stable, so the result is bit-for-bit
// reproducible — important because the context packer downstream relies on stable
// selection for provider prompt-cache hits.

/**
 * @typedef {Object} PageRankEdge
 * @property {string} from - source node id (the referencer)
 * @property {string} to   - target node id (the definer)
 * @property {number} [weight] - edge weight (default 1); negatives are clamped to 0
 */

/**
 * @typedef {Object} PageRankResult
 * @property {Map<string, number>} rank - node id -> score (sums to ~1)
 * @property {number} iterations - power-iteration steps taken
 * @property {boolean} converged - true if the L1 delta fell below tol
 * @property {number} delta - final L1 delta between the last two iterates
 */

/**
 * Compute weighted personalized PageRank.
 *
 * @param {Object} graph
 * @param {Iterable<string>} graph.nodes - all node ids (edges may add nodes too)
 * @param {PageRankEdge[]} [graph.edges] - weighted directed edges
 * @param {Object} [opts]
 * @param {number} [opts.damping=0.85] - teleport probability is (1 - damping)
 * @param {Map<string,number>|Object<string,number>} [opts.personalization] -
 *        restart distribution; keys not present get 0, the vector is normalized.
 *        Omitted -> uniform over all nodes (classic PageRank).
 * @param {number} [opts.tol=1e-8] - L1 convergence tolerance
 * @param {number} [opts.maxIter=200] - hard iteration cap
 * @returns {PageRankResult}
 */
function pageRank(graph, opts) {
  opts = opts || {};
  const damping = clamp01(opts.damping == null ? 0.85 : opts.damping);
  const tol = opts.tol == null ? 1e-8 : Math.max(0, opts.tol);
  const maxIter = opts.maxIter == null ? 200 : Math.max(1, opts.maxIter | 0);

  // --- Node set: sorted for deterministic iteration ---
  const nodeSet = new Set();
  for (const n of graph.nodes || []) nodeSet.add(String(n));
  for (const e of graph.edges || []) { nodeSet.add(String(e.from)); nodeSet.add(String(e.to)); }
  const nodes = [...nodeSet].sort();
  const N = nodes.length;
  if (N === 0) return { rank: new Map(), iterations: 0, converged: true, delta: 0 };

  const idx = new Map();
  for (let i = 0; i < N; i++) idx.set(nodes[i], i);

  // --- Out-edge accumulation (combine parallel edges, drop self-loops & bad weights) ---
  // outAdj[i] = array of { j, w }; outSum[i] = total out-weight from i.
  const outAdj = Array.from({ length: N }, () => []);
  const outMerge = Array.from({ length: N }, () => null); // lazy Map for merging duplicates
  const outSum = new Float64Array(N);
  for (const e of graph.edges || []) {
    const i = idx.get(String(e.from));
    const j = idx.get(String(e.to));
    if (i == null || j == null || i === j) continue; // ignore self-loops
    let w = Number(e.weight == null ? 1 : e.weight);
    if (!isFinite(w) || w <= 0) continue;
    let m = outMerge[i];
    if (!m) { m = outMerge[i] = new Map(); }
    m.set(j, (m.get(j) || 0) + w);
  }
  for (let i = 0; i < N; i++) {
    const m = outMerge[i];
    if (!m) continue;
    // sort targets for deterministic accumulation order
    for (const j of [...m.keys()].sort((a, b) => a - b)) {
      const w = m.get(j);
      outAdj[i].push({ j, w });
      outSum[i] += w;
    }
  }

  // --- Personalization vector (normalized; defaults to uniform) ---
  const p = buildPersonalization(opts.personalization, nodes, idx);

  // --- Power iteration ---
  let r = p.slice();
  let next = new Float64Array(N);
  let iterations = 0;
  let delta = Infinity;
  let converged = false;

  while (iterations < maxIter) {
    iterations++;
    // Teleport base: (1 - damping) * p
    for (let i = 0; i < N; i++) next[i] = (1 - damping) * p[i];

    // Dangling mass: rank on nodes with no out-edges flows back through p.
    let danglingMass = 0;
    for (let i = 0; i < N; i++) if (outSum[i] === 0) danglingMass += r[i];
    if (danglingMass > 0) {
      const dw = damping * danglingMass;
      for (let i = 0; i < N; i++) next[i] += dw * p[i];
    }

    // Edge flow: each node pushes damping * r[i] split by out-weight.
    for (let i = 0; i < N; i++) {
      const s = outSum[i];
      if (s === 0 || r[i] === 0) continue;
      const share = (damping * r[i]) / s;
      const adj = outAdj[i];
      for (let k = 0; k < adj.length; k++) next[adj[k].j] += share * adj[k].w;
    }

    // L1 delta + swap buffers.
    delta = 0;
    for (let i = 0; i < N; i++) delta += Math.abs(next[i] - r[i]);
    const tmp = r; r = next; next = tmp;
    if (delta < tol) { converged = true; break; }
  }

  // Normalize against floating drift so the distribution sums to exactly ~1.
  let sum = 0;
  for (let i = 0; i < N; i++) sum += r[i];
  const rank = new Map();
  if (sum > 0) for (let i = 0; i < N; i++) rank.set(nodes[i], r[i] / sum);
  else for (let i = 0; i < N; i++) rank.set(nodes[i], 1 / N);

  return { rank, iterations, converged, delta };
}

// Build a normalized personalization array aligned to `nodes`. Accepts a Map or a
// plain object; missing / non-positive entries are treated as 0. Falls back to a
// uniform vector when nothing usable is supplied.
function buildPersonalization(personalization, nodes, idx) {
  const N = nodes.length;
  const p = new Float64Array(N);
  let total = 0;
  if (personalization) {
    const get = personalization instanceof Map
      ? (k) => personalization.get(k)
      : (k) => personalization[k];
    for (let i = 0; i < N; i++) {
      let v = Number(get(nodes[i]));
      if (!isFinite(v) || v <= 0) v = 0;
      p[i] = v; total += v;
    }
  }
  if (total <= 0) { const u = 1 / N; for (let i = 0; i < N; i++) p[i] = u; }
  else for (let i = 0; i < N; i++) p[i] /= total;
  return p;
}

function clamp01(x) { x = Number(x); if (!isFinite(x)) return 0.85; return x < 0 ? 0 : x > 1 ? 1 : x; }

/**
 * Return node ids sorted by descending rank, with deterministic tie-breaking by
 * id. Convenience for ranking consumers.
 * @param {Map<string,number>} rankMap
 * @returns {Array<{id:string, score:number}>}
 */
function ranked(rankMap) {
  return [...rankMap.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

module.exports = { pageRank, ranked, buildPersonalization };
