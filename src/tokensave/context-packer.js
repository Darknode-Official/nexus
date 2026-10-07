"use strict";
// ================= Context Packer =================
// Given a token budget and candidate chunks (files/snippets) each with a
// relevance score, select the subset that maximizes total relevance while
// fitting the budget. This is a 0/1 knapsack: value = relevance, weight = tokens.
//
// STRATEGY:
//   - Exact dynamic-programming knapsack when the problem is small enough
//     (items * quantized-capacity within a work cap). Quantizing token counts to
//     a coarse unit keeps the DP table bounded without materially hurting
//     packing quality.
//   - Otherwise a value-density greedy (relevance per token), which is fast and
//     within a known bound of optimal.
// Both paths use DETERMINISTIC tie-breaking so the same inputs always pack the
// same way (important for provider prompt-cache stability downstream).
//
// The report explains, per chunk, whether it was included or dropped and why.

const { estimateTokens } = require("./estimator");

// Deterministic ordering: higher relevance first, then fewer tokens, then id,
// then original index. Used as the canonical sort before any packing.
function canonicalSort(items) {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ra = a.it._relevance, rb = b.it._relevance;
      if (rb !== ra) return rb - ra;
      if (a.it._tokens !== b.it._tokens) return a.it._tokens - b.it._tokens;
      const ida = String(a.it.id || ""), idb = String(b.it.id || "");
      if (ida !== idb) return ida < idb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

// Normalize raw chunks into internal shape with resolved tokens and relevance.
function normalize(chunks, model) {
  return (chunks || []).map((c, i) => {
    const content = c.content != null ? String(c.content) : "";
    const tokens = c.tokens != null ? Math.max(0, c.tokens | 0) : estimateTokens(content, model);
    const relevance = c.relevance != null ? Number(c.relevance)
      : (c.score != null ? Number(c.score) : 0);
    return {
      id: c.id != null ? c.id : "chunk_" + i,
      label: c.label || c.id || ("chunk_" + i),
      content,
      _tokens: tokens,
      _relevance: isFinite(relevance) ? relevance : 0,
      _index: i,
      raw: c,
    };
  });
}

// Exact 0/1 knapsack over quantized token weights.
function knapsackExact(items, budget, unit) {
  const n = items.length;
  const cap = Math.max(0, Math.floor(budget / unit));
  // dp[w] = best value using some subset with quantized weight <= w.
  const dp = new Array(cap + 1).fill(0);
  const take = Array.from({ length: n }, () => new Uint8Array(cap + 1));
  for (let i = 0; i < n; i++) {
    const w = Math.ceil(items[i]._tokens / unit);
    const val = items[i]._relevance;
    if (w === 0) {
      // Zero-weight item: always take if it adds value.
      for (let c = 0; c <= cap; c++) if (val > 0) { dp[c] += val; take[i][c] = 1; }
      continue;
    }
    for (let c = cap; c >= w; c--) {
      const cand = dp[c - w] + val;
      if (cand > dp[c]) { dp[c] = cand; take[i][c] = 1; }
    }
  }
  // Backtrack to recover the chosen set (deterministic: items already canonical).
  const chosen = new Set();
  let c = cap;
  for (let i = n - 1; i >= 0; i--) {
    const w = Math.ceil(items[i]._tokens / unit);
    if (take[i][c] && c - (w === 0 ? 0 : w) >= 0) {
      chosen.add(items[i].id);
      if (w > 0) c -= w;
    }
  }
  return chosen;
}

// Value-density greedy fallback.
function knapsackGreedy(items, budget) {
  const byDensity = items
    .map((it) => ({ it, d: it._tokens > 0 ? it._relevance / it._tokens : Infinity }))
    .sort((a, b) => {
      if (b.d !== a.d) return b.d - a.d;
      if (b.it._relevance !== a.it._relevance) return b.it._relevance - a.it._relevance;
      if (a.it._tokens !== b.it._tokens) return a.it._tokens - b.it._tokens;
      return a.it._index - b.it._index;
    });
  const chosen = new Set();
  let used = 0;
  for (const { it } of byDensity) {
    if (used + it._tokens <= budget) { chosen.add(it.id); used += it._tokens; }
  }
  return chosen;
}

/**
 * Pack chunks into a token budget.
 * @param {Array<{id?,label?,content?,tokens?,relevance?,score?}>} chunks
 * @param {number} budget - max tokens
 * @param {object} [opts] - { model?, unit?, workCap? }
 * @returns {{ included, dropped, usedTokens, budget, totalRelevance, strategy, report }}
 */
function pack(chunks, budget, opts) {
  opts = opts || {};
  const model = opts.model;
  const items = canonicalSort(normalize(chunks, model));
  budget = Math.max(0, budget | 0);

  // Decide strategy: exact DP when the quantized table is affordable.
  const unit = opts.unit || Math.max(1, Math.round(budget / 400) || 1);
  const cap = Math.floor(budget / unit);
  const workCap = opts.workCap || 4_000_000;
  const useExact = items.length > 0 && (items.length * (cap + 1)) <= workCap;

  let chosen;
  let strategy;
  if (budget <= 0) { chosen = new Set(); strategy = "none"; }
  else if (useExact) { chosen = knapsackExact(items, budget, unit); strategy = "exact-dp"; }
  else { chosen = knapsackGreedy(items, budget); strategy = "greedy"; }

  const included = [];
  const dropped = [];
  let usedTokens = 0;
  let totalRelevance = 0;

  for (const it of items) {
    const base = { id: it.id, label: it.label, tokens: it._tokens, relevance: it._relevance, content: it.content };
    if (chosen.has(it.id)) {
      included.push(base);
      usedTokens += it._tokens;
      totalRelevance += it._relevance;
    } else {
      let reason;
      if (budget <= 0) reason = "zero budget";
      else if (it._tokens > budget) reason = "exceeds entire budget (" + it._tokens + " > " + budget + ")";
      else if (it._relevance <= 0) reason = "zero relevance";
      else reason = "displaced by higher value-per-token chunks";
      dropped.push(Object.assign(base, { reason }));
    }
  }

  return {
    included, dropped,
    usedTokens, budget,
    totalRelevance: +totalRelevance.toFixed(4),
    strategy,
    report: renderReport({ included, dropped, usedTokens, budget, strategy }),
  };
}

function renderReport(r) {
  const lines = [];
  lines.push("Context pack: " + r.included.length + " included, " + r.dropped.length +
    " dropped — " + r.usedTokens + "/" + r.budget + " tokens (" + r.strategy + ")");
  for (const it of r.included) {
    lines.push("  [+] " + it.label + " — " + it.tokens + " tok, rel " + it.relevance);
  }
  for (const it of r.dropped) {
    lines.push("  [-] " + it.label + " — " + it.tokens + " tok, rel " + it.relevance + " — " + it.reason);
  }
  return lines.join("\n");
}

/**
 * Assemble the packed chunks into a single context string (included only), in
 * canonical (relevance) order, each prefixed with its label.
 */
function assemble(packResult) {
  return packResult.included.map((it) => "### " + it.label + "\n" + it.content).join("\n\n");
}

module.exports = { pack, assemble, canonicalSort, normalize, knapsackExact, knapsackGreedy };
