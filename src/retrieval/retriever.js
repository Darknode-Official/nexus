"use strict";
// ===================== Retrieval — Query API (budget-bounded) =====================
// The entrypoint an engine actually calls: "give me the chunks most relevant to
// this query that FIT in N tokens, and tell me why each was chosen." This is the
// piece that directly serves Nexus's token-economics goal — instead of stuffing
// whole files into the prompt, the agent gets only the spans that matter, packed
// to a budget.
//
// Pipeline:
//   1. Tokenize the query (code-aware).
//   2. Rank chunks lexically with BM25 (or TF-IDF cosine).
//   3. Optionally fuse structural signals from codegraph (hybrid).
//   4. MMR re-rank the top pool to suppress near-duplicate chunks.
//   5. Pack the diversified candidates into the token budget with tokensave's
//      knapsack context-packer (token counts from tokensave's estimator).
//   6. Return the selected chunks with per-chunk scores and a "why selected"
//      explanation (matched terms, structural reasons, redundancy, budget note).
//
// Every stage is deterministic; the same store + query + options always return
// the same result.

const { queryTerms } = require("./tokenize");
const { structuralScores, blend } = require("./hybrid");
const { mmr } = require("./mmr");

// tokensave is a sibling wave-1 subsystem: token estimator + knapsack packer.
let tokensave;
try { tokensave = require("../tokensave"); }
catch (_) { tokensave = null; }

function estimateTokens(text, model) {
  if (tokensave && typeof tokensave.estimateTokens === "function") return tokensave.estimateTokens(text, model);
  // Conservative local fallback if tokensave is unavailable.
  return Math.max(1, Math.round(String(text || "").length / 4));
}

const DEFAULTS = {
  topN: 8,
  budget: null,          // null => no budget pruning, just top-N
  model: "generic",
  scorer: "bm25",        // "bm25" | "cosine"
  k1: 1.5,
  b: 0.75,
  hybrid: true,          // fuse codegraph structural signals when cgIndex given
  lambda: 0.7,           // MMR relevance/novelty trade-off
  redundancyPenalty: 0.5,// how hard near-duplicates are de-prioritized for packing
  poolFactor: 6,         // candidate pool = max(topN*poolFactor, minPool)
  minPool: 40,
  wLex: 0.7,
  wStruct: 0.3,
};

/**
 * Retrieve the most relevant chunks for a query within a token budget.
 * @param {object} store - a store from store.createStore (provides index + chunks)
 * @param {string} query
 * @param {object} [opts] - see DEFAULTS; `opts.cgIndex` enables the hybrid signal.
 * @returns {object} { query, qterms, budget, usedTokens, count, chunks[], dropped[], report, context }
 */
function retrieve(store, query, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  const qterms = queryTerms(query);
  const empty = {
    query, qterms, budget: opts.budget, usedTokens: 0, count: 0,
    chunks: [], dropped: [], report: "no query terms", context: "",
  };
  if (!qterms.length) return empty;

  const pool = Math.max(opts.topN * opts.poolFactor, opts.minPool);

  // 1-2. Lexical ranking.
  const lexResults = opts.scorer === "cosine"
    ? store.index.cosine(qterms, { limit: pool })
    : store.index.bm25(qterms, { limit: pool, k1: opts.k1, b: opts.b });
  if (!lexResults.length) return Object.assign({}, empty, { report: "no lexical matches" });

  // Candidate chunk records.
  const candIds = new Set(lexResults.map((r) => r.id));

  // 3. Structural fusion (optional).
  let ranked;
  if (opts.hybrid && opts.cgIndex) {
    const candChunks = [...candIds].map((id) => store.getChunk(id)).filter(Boolean);
    // Only forward explicitly-set structural weights so we never clobber the
    // hybrid DEFAULTS with `undefined`.
    const structOpts = {};
    if (opts.wSymbol != null) structOpts.wSymbol = opts.wSymbol;
    if (opts.wImpl != null) structOpts.wImpl = opts.wImpl;
    if (opts.wImport != null) structOpts.wImport = opts.wImport;
    const structMap = structuralScores(candChunks, qterms, {
      cgIndex: opts.cgIndex, query, opts: structOpts,
    });
    // structural fusion may surface chunks with zero lexical score; pull their
    // records into scope too.
    for (const [id] of structMap) if (!candIds.has(id) && store.getChunk(id)) candIds.add(id);
    ranked = blend(lexResults, structMap, { wLex: opts.wLex, wStruct: opts.wStruct });
  } else {
    let maxLex = 0; for (const r of lexResults) if (r.score > maxLex) maxLex = r.score;
    const denom = maxLex || 1;
    ranked = lexResults.map((r) => ({
      id: r.id, score: +(r.score / denom).toFixed(6), lex: +(r.score / denom).toFixed(6),
      struct: 0, matched: r.matched || [], reasons: [],
    }));
  }

  // 4. MMR diversification over the ranked pool.
  const mmrInput = ranked.slice(0, pool).map((r) => {
    const c = store.getChunk(r.id);
    return Object.assign({}, r, { terms: c ? new Set(c.tf.keys()) : new Set() });
  });
  const diversified = mmr(mmrInput, { lambda: opts.lambda, limit: pool });

  // 5. Pack into the token budget. Relevance is the blended score, discounted by
  // redundancy so near-duplicates lose to novel chunks of similar score.
  const packItems = diversified.map((r) => {
    const c = store.getChunk(r.id);
    const text = store.content(r.id) || "";
    const tokens = estimateTokens(text, opts.model);
    const relevance = Math.max(0, r.score * (1 - opts.redundancyPenalty * (r.redundancy || 0)));
    return { id: r.id, label: labelFor(c), content: text, tokens, relevance, _meta: { r, c, tokens } };
  });

  let included, dropped, usedTokens, strategy;
  if (opts.budget != null && opts.budget >= 0 && tokensave && typeof tokensave.pack === "function") {
    const packed = tokensave.pack(packItems, opts.budget, { model: opts.model });
    const incSet = new Set(packed.included.map((x) => x.id));
    included = packItems.filter((x) => incSet.has(x.id));
    dropped = packItems.filter((x) => !incSet.has(x.id)).map((x) => ({
      id: x.id, tokens: x.tokens, reason: "over budget / displaced",
    }));
    usedTokens = packed.usedTokens;
    strategy = packed.strategy;
  } else {
    // No budget: take the top-N diversified chunks.
    included = packItems.slice(0, opts.topN);
    dropped = packItems.slice(opts.topN).map((x) => ({ id: x.id, tokens: x.tokens, reason: "beyond topN" }));
    usedTokens = included.reduce((a, x) => a + x.tokens, 0);
    strategy = "topN";
  }

  // Cap to topN even under a generous budget (keep the result tight).
  if (opts.topN && included.length > opts.topN) {
    const extra = included.slice(opts.topN);
    included = included.slice(0, opts.topN);
    usedTokens = included.reduce((a, x) => a + x.tokens, 0);
    for (const x of extra) dropped.unshift({ id: x.id, tokens: x.tokens, reason: "beyond topN" });
  }

  // 6. Shape the output with "why selected".
  const outChunks = included.map((x) => {
    const r = x._meta.r, c = x._meta.c;
    return {
      id: x.id,
      file: c ? c.file : null,
      lang: c ? c.lang : null,
      kind: c ? c.kind : null,
      name: c ? c.name : null,
      startLine: c ? c.startLine : null,
      endLine: c ? c.endLine : null,
      lines: c ? (c.startLine + "-" + c.endLine) : null,
      score: r.score,
      lex: r.lex,
      struct: r.struct,
      mmrScore: r.mmrScore,
      redundancy: r.redundancy,
      tokens: x.tokens,
      why: explain(r),
      content: x.content,
    };
  });

  return {
    query, qterms,
    budget: opts.budget,
    usedTokens,
    count: outChunks.length,
    strategy,
    chunks: outChunks,
    dropped,
    report: renderReport(query, qterms, outChunks, usedTokens, opts.budget, strategy),
    context: assembleContext(outChunks),
  };
}

function labelFor(c) {
  if (!c) return "chunk";
  const nm = c.name ? (c.kind + " " + c.name) : c.kind;
  return c.file + ":" + c.startLine + "-" + c.endLine + " (" + nm + ")";
}

function explain(r) {
  const parts = [];
  if (r.matched && r.matched.length) parts.push("matched terms: " + r.matched.join(", "));
  for (const reason of (r.reasons || [])) parts.push(reason);
  if (r.redundancy > 0.01) parts.push("redundancy " + r.redundancy.toFixed(2) + " vs. already-selected");
  if (!parts.length) parts.push("lexical relevance");
  return parts;
}

function assembleContext(chunks) {
  return chunks.map((c) => "### " + c.file + ":" + c.startLine + "-" + c.endLine + "\n" + c.content).join("\n\n");
}

function renderReport(query, qterms, chunks, usedTokens, budget, strategy) {
  const lines = [];
  lines.push('retrieve("' + query + '") — ' + chunks.length + " chunk(s), " +
    usedTokens + (budget != null ? "/" + budget : "") + " tokens [" + strategy + "]");
  lines.push("  terms: " + qterms.join(" "));
  for (const c of chunks) {
    lines.push("  [" + c.score.toFixed(3) + "] " + c.file + ":" + c.startLine + "-" + c.endLine +
      " (" + (c.name ? c.name : c.kind) + ", " + c.tokens + " tok) — " + c.why.join("; "));
  }
  return lines.join("\n");
}

module.exports = { retrieve, estimateTokens, DEFAULTS };
