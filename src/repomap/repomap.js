"use strict";
// ===================== Repo Map — Orchestrator =====================
// Ties the subsystem together into the headline API: an always-on, ranked,
// token-budgeted overview of a WHOLE repository that Nexus can keep in context
// cheaply. Distinct from retrieval (query-driven top-N chunks): this is the global,
// structural "table of contents" of the project's most important symbols.
//
// PIPELINE:
//   walk dir -> per-file extraction (cached, incremental) -> dependency backbone
//   (codegraph depgraph) -> symbol/reference graph -> personalized PageRank
//   -> ranked files + symbols -> token-budgeted tree render.
//
// Two entrypoints:
//   repomap(dir, opts)          — from the filesystem, with an incremental cache.
//   repomapFromSources(files, o) — from in-memory { path: source } (tests / ad-hoc).

const fs = require("fs");
const path = require("path");
const parse = require("../codegraph/parse");
const { buildDepGraph, normalize } = require("../codegraph/depgraph");
const { extractFile } = require("./extract");
const { buildSymbolGraph } = require("./symbolgraph");
const { rankRepo } = require("./rank");
const { renderBudgeted } = require("./render");
const { RepoMapCache } = require("./cache");
const { estimateTokens } = require("../tokensave/estimator");

// Same vendored/build skip set the rest of Nexus uses.
const SKIP = /(^|\/)(\.git|node_modules|\.nexus|dist|build|\.cache|\.next|out|coverage|target|__pycache__|vendor|\.venv|venv)(\/|$)/;

const DEFAULT_BUDGET = 2048;

/**
 * Build a ranked, token-budgeted repository map from a directory.
 *
 * @param {string} dir - repository root
 * @param {Object} [opts]
 * @param {number} [opts.budget=2048] - token budget for the rendered map
 * @param {string} [opts.model] - model family for token estimation
 * @param {string[]} [opts.focus] - files/symbols to bias the ranking toward
 * @param {string[]} [opts.exclude] - path substrings to omit from the output
 * @param {string} [opts.cacheFile] - JSON cache path for incremental builds
 * @param {number} [opts.maxFiles] / [opts.maxBytes] / [opts.maxPerFile]
 * @param {number} [opts.damping] / [opts.tol] / [opts.maxIter]
 * @returns {RepoMapResult}
 */
function repomap(dir, opts) {
  opts = opts || {};
  const root = path.resolve(dir || ".");
  const maxFiles = opts.maxFiles || 20000;
  const maxBytes = opts.maxBytes || 2000000;
  const t0 = Date.now();

  const cache = new RepoMapCache(opts.cacheFile || null).load();

  // --- walk ---
  const found = [];
  const walk = (d) => {
    if (found.length >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (found.length >= maxFiles) return;
      const fp = path.join(d, e.name);
      if (SKIP.test(toPosix(fp))) continue;
      if (e.isDirectory()) walk(fp);
      else if (parse.supported(e.name)) found.push(fp);
    }
  };
  walk(root);

  // --- per-file extraction with incremental cache ---
  const extractions = new Map();
  const live = new Set();
  let fresh = 0, reused = 0;
  for (const abs of found) {
    let stat; try { stat = fs.statSync(abs); } catch (_) { continue; }
    if (stat.size > maxBytes) continue;
    const rel = normalize(path.relative(root, abs));
    live.add(rel);
    let data = cache.hit(rel, stat);
    if (data) { reused++; }
    else {
      let content; try { content = fs.readFileSync(abs, "utf8"); } catch (_) { continue; }
      const parsed = parse.parseSource(content, rel);
      data = extractFile(rel, content, parsed);
      cache.set(rel, stat, content, data);
      fresh++;
    }
    extractions.set(rel, data);
  }
  cache.prune(live);
  if (opts.cacheFile) cache.save();

  const result = buildFromExtractions(extractions, opts);
  result.meta = Object.assign(result.meta, {
    mode: "disk", root, elapsedMs: Date.now() - t0,
    scanned: found.length, fresh, reused, cache: cache.summary(),
  });
  result.cache = cache;
  return result;
}

/**
 * Build a repository map from in-memory sources.
 * @param {Object<string,string>|Array<{file:string,source:string}>} sources
 * @param {Object} [opts] - same as repomap() minus filesystem options
 * @returns {RepoMapResult}
 */
function repomapFromSources(sources, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const list = Array.isArray(sources)
    ? sources
    : Object.keys(sources).map((file) => ({ file, source: sources[file] }));
  const extractions = new Map();
  for (const { file, source } of list) {
    if (!parse.supported(file)) continue;
    const rel = normalize(file);
    const parsed = parse.parseSource(source, rel);
    extractions.set(rel, extractFile(rel, source, parsed));
  }
  const result = buildFromExtractions(extractions, opts);
  result.meta = Object.assign(result.meta, { mode: "memory", elapsedMs: Date.now() - t0, files: extractions.size });
  return result;
}

/**
 * Core build from a ready extractions map. Exposed for advanced use / testing.
 * @param {Map<string,Object>} extractions
 * @param {Object} [opts]
 * @returns {RepoMapResult}
 */
function buildFromExtractions(extractions, opts) {
  opts = opts || {};
  const budget = opts.budget == null ? DEFAULT_BUDGET : opts.budget;
  const model = opts.model;

  // Dependency backbone from the (cached) imports.
  const records = [];
  for (const [file, ex] of extractions) records.push({ file, lang: ex.lang, imports: ex.imports || [] });
  const depGraph = buildDepGraph(records);

  const graph = buildSymbolGraph(extractions, { cgIndex: { graph: depGraph } });
  const ranking = rankRepo(graph, extractions, {
    focus: opts.focus, exclude: opts.exclude,
    damping: opts.damping, tol: opts.tol, maxIter: opts.maxIter,
  });

  const rendered = renderBudgeted(ranking.files, ranking.symbols, {
    budget, model, title: opts.title || "Repository map", maxPerFile: opts.maxPerFile,
  });

  return {
    map: rendered.map,
    tokens: rendered.tokens,
    budget: rendered.budget,
    degraded: rendered.degraded,
    files: ranking.files,
    symbols: ranking.symbols,
    includedFiles: rendered.includedFiles,
    includedSymbols: rendered.includedSymbols,
    droppedSymbols: rendered.droppedSymbols,
    focus: ranking.focusResolved,
    graph: { edges: graph.edges.length, names: graph.stats.names, ambiguousNames: graph.stats.ambiguousNames,
      refEdges: graph.stats.refEdges, importEdges: graph.stats.importEdges },
    pagerank: ranking.pr,
    meta: { files: extractions.size, model: model || "generic" },
  };
}

/**
 * Estimate the token cost of dumping the FULL source of all indexed files — the
 * baseline the map is measured against. Used by the benchmark + savings reports.
 * @param {string} dir
 * @param {Object} [opts] - { model, maxFiles, maxBytes }
 * @returns {{ files:number, sourceTokens:number }}
 */
function fullSourceTokens(dir, opts) {
  opts = opts || {};
  const root = path.resolve(dir || ".");
  const maxFiles = opts.maxFiles || 20000, maxBytes = opts.maxBytes || 2000000;
  const found = [];
  const walk = (d) => {
    if (found.length >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (SKIP.test(toPosix(fp))) continue;
      if (e.isDirectory()) walk(fp);
      else if (parse.supported(e.name)) found.push(fp);
    }
  };
  walk(root);
  let tokens = 0, files = 0;
  for (const abs of found) {
    let stat; try { stat = fs.statSync(abs); } catch (_) { continue; }
    if (stat.size > maxBytes) continue;
    let content; try { content = fs.readFileSync(abs, "utf8"); } catch (_) { continue; }
    tokens += estimateTokens(content, opts.model);
    files++;
  }
  return { files, sourceTokens: tokens };
}

function toPosix(p) { return String(p).replace(/\\/g, "/"); }

/**
 * @typedef {Object} RepoMapResult
 * @property {string} map - the rendered map text (<= budget tokens)
 * @property {number} tokens - measured token count of `map`
 * @property {number} budget
 * @property {boolean} degraded - true if symbols were dropped to fit the budget
 * @property {Array<Object>} files - ranked files
 * @property {Array<Object>} symbols - ranked symbols
 * @property {Object} meta
 */

module.exports = {
  repomap, repomapFromSources, buildFromExtractions, fullSourceTokens,
  SKIP, DEFAULT_BUDGET,
};
