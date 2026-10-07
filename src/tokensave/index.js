"use strict";
// ================= Token-Saving Engine — Public API =================
// Nexus's headline differentiator: cut the tokens a turn costs, measurably and
// locally (no LLM calls, zero dependencies). Six cooperating modules:
//
//   compressor      — local prompt compression (filler/whitespace/dedup), safe
//                     for code/paths/URLs/strings/identifiers.
//   semanticCache   — SimHash + LSH near-duplicate response cache (free repeats).
//   contextPacker   — knapsack selection of chunks under a token budget.
//   diffContext     — minimal context from changed hunks instead of whole files.
//   cachePlanner    — order + annotate messages for provider prompt-cache hits.
//   estimator       — dependency-free token estimator + savings Ledger.
//
// Wire it into the Nexus engine with register(ctx); see INTEGRATION.md for the
// exact edits the main agent should make. Nothing here touches global state.

const estimator = require("./estimator");
const compressor = require("./compressor");
const semanticCache = require("./semantic-cache");
const contextPacker = require("./context-packer");
const diffContext = require("./diff-context");
const cachePlanner = require("./cache-planner");

const { Ledger, estimateTokens } = estimator;

/**
 * Create a Token-Saving engine instance with a shared savings Ledger. Most
 * methods mirror the module functions but also attribute their savings to the
 * ledger, so `engine.ledger.report()` gives one honest breakdown of everything.
 *
 * @param {object} [opts] - { model?, provider?, cache?: SemanticCache opts }
 */
function createEngine(opts) {
  opts = opts || {};
  const model = opts.model || "generic";
  const provider = opts.provider || model;
  const ledger = new Ledger(model);
  const cache = new semanticCache.SemanticCache(opts.cache || {});

  return {
    model, provider, ledger, cache,

    /** Compress a prompt and attribute the saving to the ledger. */
    compress(input, level) {
      const r = compressor.compress(input, { level, model });
      ledger.record("compressor", { before: r.before, after: r.after, note: "level " + r.level });
      return r;
    },

    /** Look up a near-duplicate cached response; records the saved tokens on hit. */
    cacheGet(requestText) {
      const r = cache.get(requestText);
      if (r.hit) {
        const savedTok = (r.meta && r.meta.tokens) != null ? r.meta.tokens : estimateTokens(requestText, model);
        ledger.record("semantic-cache", { before: savedTok, after: 0, note: "hit d=" + r.distance });
      }
      return r;
    },

    /** Store a response for future near-duplicate hits. */
    cacheSet(requestText, value, meta) {
      return cache.set(requestText, value, meta);
    },

    /** Pack candidate chunks into a budget; attributes dropped tokens as saved. */
    pack(chunks, budget) {
      const r = contextPacker.pack(chunks, budget, { model });
      const dropped = r.dropped.reduce((a, d) => a + d.tokens, 0);
      if (dropped > 0) ledger.record("context-packer", { before: r.usedTokens + dropped, after: r.usedTokens, note: r.strategy });
      return r;
    },

    /** Build minimal diff context from an edit; attributes whole-file savings. */
    diff(oldText, newText, dopts) {
      const r = diffContext.fromEdit(oldText, newText, Object.assign({ model }, dopts));
      ledger.record("diff-context", { before: r.fullTokens, after: r.contextTokens, note: r.hunks.length + " hunk(s)" });
      return r;
    },

    /** Plan provider prompt-cache structure for a message array. */
    planCache(segments) {
      const r = cachePlanner.plan(segments, { provider, model });
      return r;
    },

    /** Estimate tokens with this engine's model family. */
    estimate(text) { return estimateTokens(text, model); },

    /** One-line summary of attributed savings so far. */
    summary() {
      return "Token-Saving Engine: saved " + ledger.totalSaved() + " tok (" + ledger.overallPct() +
        "%); cache hit rate " + cache.hitRate() + " over " + (cache.stats.hits + cache.stats.misses) + " lookups.";
    },
  };
}

/**
 * Register the engine with a Nexus context object. If `ctx` is provided it gets a
 * `tokensave` property; the created engine (and the raw module namespace) is
 * returned either way. See INTEGRATION.md for the CLI/engine wiring the main
 * agent should add.
 * @param {object} [ctx]
 * @param {object} [opts] - forwarded to createEngine
 */
function register(ctx, opts) {
  const engine = createEngine(opts);
  const api = {
    engine,
    createEngine,
    compressor, semanticCache, contextPacker, diffContext, cachePlanner, estimator,
  };
  if (ctx && typeof ctx === "object") ctx.tokensave = api;
  return api;
}

module.exports = {
  register,
  createEngine,
  // Re-export the module namespaces for direct use.
  compressor, semanticCache, contextPacker, diffContext, cachePlanner, estimator,
  // Convenience re-exports of the most-used functions.
  compress: compressor.compress,
  SemanticCache: semanticCache.SemanticCache,
  pack: contextPacker.pack,
  buildDiffContext: diffContext.buildContext,
  planCache: cachePlanner.plan,
  estimateTokens: estimator.estimateTokens,
  Ledger: estimator.Ledger,
};
