"use strict";
// ===================== Retrieval — Lexical + Structural Hybrid =====================
// BM25 is purely lexical: it has no idea that a chunk DEFINES the symbol the query
// names, or that it sits one import away from the obvious answer. Code retrieval
// improves markedly when the lexical score is fused with structural signals from
// the codegraph subsystem. This module computes three structural signals and
// blends them with the (normalized) BM25 score:
//
//   1. Symbol-name match — the query terms matched against the sub-words of the
//      symbols a chunk DEFINES (a chunk that defines `parseConfig` should beat a
//      chunk that merely mentions it). Strongest signal.
//   2. Implementation rank — codegraph's own "find existing implementation"
//      ranker, mapped from (file, line) back to the chunk that contains that
//      definition. Reuses a proven, dependency-free symbol ranker.
//   3. Import proximity — chunks whose file imports (or is imported by) a file
//      that scored a strong symbol/impl hit get a small boost, pulling the
//      neighbourhood of the answer into reach.
//
// All signals are normalized to [0,1]; the final blend is tunable (wLex/wStruct).
// Pure given its inputs; deterministic.

const { splitIdentifier } = require("./tokenize");
let normalize;
try { ({ normalize } = require("../codegraph/depgraph")); }
catch (_) { normalize = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, ""); }

const DEFAULTS = {
  wLex: 0.7,            // weight on normalized BM25
  wStruct: 0.3,         // weight on the combined structural signal
  wSymbol: 0.5,         // structural: symbol-name match
  wImpl: 0.35,          // structural: codegraph findImplementation
  wImport: 0.15,        // structural: import proximity
  implLimit: 25,        // how many codegraph hits to consider
  proximityBoost: 1.0,  // scaling for the neighbourhood boost
};

// Normalize a score map to [0,1] by its max (no-op when max<=0).
function normMap(map) {
  let max = 0;
  for (const v of map.values()) if (v > max) max = v;
  const out = new Map();
  if (max <= 0) { for (const [k] of map) out.set(k, 0); return out; }
  for (const [k, v] of map) out.set(k, v / max);
  return out;
}

/**
 * Build a line->chunk lookup per file so a codegraph (file,line) hit can be
 * attributed to the chunk that contains it.
 */
function buildLineLookup(chunks) {
  const byFile = new Map(); // normFile -> [{startLine,endLine,id}] sorted
  for (const c of chunks) {
    const nf = normalize(c.file);
    if (!byFile.has(nf)) byFile.set(nf, []);
    byFile.get(nf).push({ startLine: c.startLine, endLine: c.endLine, id: c.id });
  }
  for (const arr of byFile.values()) arr.sort((a, b) => a.startLine - b.startLine);
  return byFile;
}

function chunkAtLine(byFile, file, line) {
  const arr = byFile.get(normalize(file));
  if (!arr) return null;
  for (const c of arr) if (line >= c.startLine && line <= c.endLine) return c.id;
  return null;
}

/**
 * Compute structural scores for every chunk.
 * @param {Array<object>} chunks - retrieval chunks (with `symbols`, `name`, `file`)
 * @param {string[]} qterms - query terms
 * @param {object} [ctx] - { cgIndex?, query?, opts? }
 *   cgIndex: a codegraph index (from codegraph.indexFiles / indexDirectory) built
 *            over the SAME files; enables impl + import-proximity signals.
 * @returns {Map<string, {symbol,impl,import,total,reasons:string[]}>}
 */
function structuralScores(chunks, qterms, ctx) {
  ctx = ctx || {};
  const opts = Object.assign({}, DEFAULTS, ctx.opts || {});
  const qset = new Set(qterms);
  const symbol = new Map();
  const impl = new Map();
  const imports = new Map();
  const reasons = new Map();
  const addReason = (id, r) => { if (!reasons.has(id)) reasons.set(id, []); reasons.get(id).push(r); };

  // --- Signal 1: symbol-name match over symbols the chunk DEFINES ---
  for (const c of chunks) {
    const names = [];
    if (c.name) names.push(c.name);
    for (const s of (c.symbols || [])) names.push(s.name);
    const words = new Set();
    for (const nm of names) for (const w of splitIdentifier(nm)) words.add(w);
    let hits = 0;
    for (const t of qset) if (words.has(t)) hits++;
    const score = qset.size ? hits / qset.size : 0;
    symbol.set(c.id, score);
    if (hits > 0) addReason(c.id, "defines symbol matching " + hits + "/" + qset.size + " query term(s)");
  }

  // --- Signal 2 + 3: codegraph findImplementation + import proximity ---
  const strongFiles = new Map(); // normFile -> best impl score (for proximity)
  if (ctx.cgIndex && ctx.query && typeof ctx.cgIndex.findImplementation === "function") {
    const byLine = buildLineLookup(chunks);
    let hits = [];
    try { hits = ctx.cgIndex.findImplementation(ctx.query, { limit: opts.implLimit }) || []; }
    catch (_) { hits = []; }
    for (const h of hits) {
      const cid = chunkAtLine(byLine, h.file, h.line);
      if (cid) {
        impl.set(cid, Math.max(impl.get(cid) || 0, h.score));
        addReason(cid, "codegraph impl match " + (h.parent ? h.parent + "." : "") + h.name + " (" + h.score.toFixed(2) + ")");
      }
      const nf = normalize(h.file);
      strongFiles.set(nf, Math.max(strongFiles.get(nf) || 0, h.score));
    }

    // Import proximity: a chunk whose file is a direct neighbour (import or
    // dependent) of a strong-hit file gets a boost proportional to that file's hit.
    const adj = ctx.cgIndex.graph && ctx.cgIndex.graph.adj;
    const rdeps = ctx.cgIndex.graph && ctx.cgIndex.graph.rdeps;
    if (adj) {
      const neighbourBoost = new Map(); // normFile -> boost
      for (const [sf, sc] of strongFiles) {
        for (const dep of (adj.get(sf) || [])) neighbourBoost.set(dep, Math.max(neighbourBoost.get(dep) || 0, sc));
        for (const dep of ((rdeps && rdeps.get(sf)) || [])) neighbourBoost.set(dep, Math.max(neighbourBoost.get(dep) || 0, sc));
      }
      for (const c of chunks) {
        const nf = normalize(c.file);
        // Don't double-reward the strong file itself; only its neighbours.
        if (!strongFiles.has(nf) && neighbourBoost.has(nf)) {
          imports.set(c.id, neighbourBoost.get(nf) * opts.proximityBoost);
          addReason(c.id, "imports/near a strong-match file");
        }
      }
    }
  }

  // Normalize each signal independently, then combine.
  const nSym = normMap(symbol);
  const nImpl = normMap(impl);
  const nImp = normMap(imports);
  const out = new Map();
  for (const c of chunks) {
    const sv = nSym.get(c.id) || 0;
    const iv = nImpl.get(c.id) || 0;
    const pv = nImp.get(c.id) || 0;
    const total = opts.wSymbol * sv + opts.wImpl * iv + opts.wImport * pv;
    out.set(c.id, {
      symbol: +sv.toFixed(4), impl: +iv.toFixed(4), import: +pv.toFixed(4),
      total: +total.toFixed(4), reasons: reasons.get(c.id) || [],
    });
  }
  return out;
}

/**
 * Blend normalized BM25 results with structural scores.
 * @param {Array<{id,score,matched}>} lexResults - BM25 output
 * @param {Map} structMap - from structuralScores()
 * @param {object} [opts] - { wLex, wStruct }
 * @returns {Array<{id,score,lex,struct,matched,reasons}>} re-sorted desc
 */
function blend(lexResults, structMap, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  let maxLex = 0;
  for (const r of lexResults) if (r.score > maxLex) maxLex = r.score;
  const denom = maxLex || 1;

  // Union of chunks that have ANY lexical or structural signal.
  const byId = new Map();
  for (const r of lexResults) byId.set(r.id, { id: r.id, lex: r.score / denom, matched: r.matched || [] });
  if (structMap) {
    for (const [id, s] of structMap) {
      if (s.total <= 0) continue;
      if (!byId.has(id)) byId.set(id, { id, lex: 0, matched: [] });
    }
  }

  const out = [];
  for (const row of byId.values()) {
    const s = structMap ? structMap.get(row.id) : null;
    const structTotal = s ? s.total : 0;
    const score = opts.wLex * row.lex + opts.wStruct * structTotal;
    out.push({
      id: row.id,
      score: +score.toFixed(6),
      lex: +row.lex.toFixed(6),
      struct: +structTotal.toFixed(6),
      matched: row.matched,
      reasons: s ? s.reasons : [],
    });
  }
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

module.exports = { structuralScores, blend, buildLineLookup, chunkAtLine, DEFAULTS };
