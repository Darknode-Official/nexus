"use strict";
// ============================= Repo Map — Ranked, Token-Budgeted Repository Map =============================
// An always-on, compressed overview of the WHOLE repository that Nexus can put in
// context cheaply — a flagship token-saver and repo-intelligence feature. Unlike
// retrieval (query-driven top-N chunks), this is a GLOBAL, ranked, budget-bounded
// summary of the project's most important symbols and their relationships: the
// project's structural table of contents.
//
// HOW IT WORKS (see README.md for the full, honest methodology):
//   1. Symbol/reference graph — who defines what, who references what, built over
//      the codegraph parse data (zero third-party deps).
//   2. Personalized PageRank — eigenvector-style importance over that graph, with
//      an optional focus (seed files/symbols) to bias toward the current task.
//   3. Signature extraction — one compact, body-free declaration line per ranked
//      symbol (the map is signatures + structure, not source).
//   4. Token-budgeted render — greedily fills a token budget with the highest-
//      ranked content and is GUARANTEED to fit (1k / 2k / 4k ...), degrading
//      gracefully (fewer symbols per file) as the budget shrinks.
//   5. Incremental — per-file extraction is cached by mtime/size/hash, so a changed
//      file is re-scanned but the rest are reused.
//
// Quick start:
//   const repomap = require("./src/repomap");
//   const r = repomap.repomap(process.cwd(), { budget: 2000 });
//   console.log(r.map);                               // the map, <= 2000 tokens
//   repomap.repomap(".", { budget: 2000, focus: ["src/retrieval/bm25.js"] });

const repomapMod = require("./repomap");
const pagerank = require("./pagerank");
const symbolgraph = require("./symbolgraph");
const rank = require("./rank");
const render = require("./render");
const signature = require("./signature");
const extract = require("./extract");
const cache = require("./cache");

/**
 * Register the Repo Map engine with a Nexus context object. If `ctx` is provided it
 * gets a `repomap` property exposing the bound API. See INTEGRATION.md for the exact
 * CLI/engine wiring the main agent should add.
 * @param {object} [ctx]
 * @param {object} [defaults] - default options merged into every call (e.g. { model })
 * @returns {object} the api namespace
 */
function register(ctx, defaults) {
  defaults = defaults || {};
  const api = {
    /** Build a map from a directory (incremental via opts.cacheFile). */
    map(dir, opts) { return repomapMod.repomap(dir, Object.assign({}, defaults, opts)); },
    /** Build a map from in-memory sources. */
    mapSources(sources, opts) { return repomapMod.repomapFromSources(sources, Object.assign({}, defaults, opts)); },
    /** Baseline: tokens to dump every file's full source. */
    fullSourceTokens: repomapMod.fullSourceTokens,
    // building blocks
    repomap: repomapMod.repomap,
    repomapFromSources: repomapMod.repomapFromSources,
    buildFromExtractions: repomapMod.buildFromExtractions,
    pagerank, symbolgraph, rank, render, signature, extract, cache,
  };
  if (ctx && typeof ctx === "object") ctx.repomap = api;
  return api;
}

module.exports = {
  register,
  // high-level entrypoints
  repomap: repomapMod.repomap,
  repomapFromSources: repomapMod.repomapFromSources,
  buildFromExtractions: repomapMod.buildFromExtractions,
  fullSourceTokens: repomapMod.fullSourceTokens,
  // building blocks (exposed for advanced use / testing)
  pagerank, symbolgraph, rank, render, signature, extract, cache,
  SKIP: repomapMod.SKIP, DEFAULT_BUDGET: repomapMod.DEFAULT_BUDGET,
};
