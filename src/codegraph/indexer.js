"use strict";
// ===================== Code Graph — Indexer (orchestrator) =====================
// Ties the subsystem together. Walks a directory (skipping vendored/build dirs the
// same way the rest of Nexus does), parses every supported file through the
// incremental cache, then builds the symbol table and dependency graph and returns
// an Index with high-level query methods: findImplementation, impact, duplicates,
// cycles, topo and stats. indexFiles() offers the same pipeline over in-memory
// sources (no filesystem) for tests and ad-hoc use.
const fs = require("fs"), path = require("path");
const parse = require("./parse");
const { buildDepGraph, detectCycles, topoOrder, normalize } = require("./depgraph");
const { buildSymbolTable } = require("./symbols");
const { buildSearchIndex, search } = require("./search");
const { findDuplicates } = require("./duplication");
const { fileImpact, symbolImpact } = require("./impact");
const { IndexCache } = require("./cache");

const SKIP = /(^|\/)(\.git|node_modules|\.nexus|dist|build|\.cache|\.next|out|coverage|target|__pycache__|vendor|\.venv|venv)(\/|$)/;

// ---- Index object: shared shape for disk and in-memory indexes ----
function makeIndex(files, sources, meta) {
  const graph = buildDepGraph(files);
  const symtab = buildSymbolTable(files);
  const searchIndex = buildSearchIndex(files);
  return {
    files, graph, symtab, searchIndex, meta: meta || {},
    // findImplementation(query, opts) — rank existing functions for reuse.
    findImplementation(query, opts) { return search(searchIndex, query, opts); },
    // impact(target) — blast radius. target: "path" | {file} | {file, name}.
    impact(target) {
      if (typeof target === "string") return fileImpact(graph, target);
      if (target && target.name) return symbolImpact(graph, symtab, target);
      return fileImpact(graph, target.file);
    },
    // duplicates(opts) — near-duplicate clones across the indexed files.
    duplicates(opts) {
      const inputs = files.map((f) => ({ file: f.file, lang: f.lang, source: sources.get(normalize(f.file)) || "" }))
        .filter((x) => x.source);
      return findDuplicates(inputs, opts);
    },
    cycles() { return detectCycles(graph.adj); },
    topo() { return topoOrder(graph.adj); },
    symbol(name) { return symtab.lookup(name); },
    stats() {
      let syms = 0, exps = 0, imps = 0, loc = 0;
      const byLang = {};
      for (const f of files) { syms += (f.symbols || []).length; exps += (f.exports || []).length; imps += (f.imports || []).length; loc += f.loc || 0; byLang[f.lang] = (byLang[f.lang] || 0) + 1; }
      return { files: files.length, symbols: syms, exports: exps, imports: imps, loc, byLang,
        edges: [...graph.adj.values()].reduce((a, s) => a + s.size, 0),
        cycles: detectCycles(graph.adj).length, externals: graph.externals.size };
    },
  };
}

// indexFiles(fileObjs) -> Index. fileObjs: [{ file, source }] (no filesystem).
function indexFiles(fileObjs) {
  const files = [], sources = new Map();
  for (const fo of fileObjs) {
    if (!parse.supported(fo.file)) continue;
    const rec = parse.parseSource(fo.source, fo.file);
    if (!rec) continue;
    rec.file = normalize(rec.file);
    files.push(rec);
    sources.set(rec.file, String(fo.source == null ? "" : fo.source));
  }
  return makeIndex(files, sources, { mode: "memory", files: files.length });
}

// indexDirectory(root, opts) -> Index. opts: { cacheFile, maxFiles, maxBytes,
//   keepSources } . Uses the incremental cache when cacheFile is given.
function indexDirectory(root, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 20000, maxBytes = opts.maxBytes || 2000000;
  const keepSources = opts.keepSources !== false;
  const t0 = Date.now();
  const cache = new IndexCache(opts.cacheFile || null).load();

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

  const files = [], sources = new Map(); const live = new Set();
  let parsed = 0, reused = 0;
  for (const abs of found) {
    let stat; try { stat = fs.statSync(abs); } catch (_) { continue; }
    if (stat.size > maxBytes) continue;
    const rel = normalize(path.relative(root, abs));
    live.add(rel);
    let record = cache.hit(rel, stat);
    let content = null;
    if (!record) {
      try { content = fs.readFileSync(abs, "utf8"); } catch (_) { continue; }
      record = parse.parseSource(content, rel);
      if (!record) continue;
      record.file = rel; record.size = stat.size;
      cache.set(rel, stat, content, record);
      parsed++;
    } else { reused++; }
    record.file = rel; record.abs = abs;
    files.push(record);
    if (keepSources) {
      if (content == null) { try { content = fs.readFileSync(abs, "utf8"); } catch (_) { content = ""; } }
      sources.set(rel, content);
    }
  }
  cache.prune(live);
  if (opts.cacheFile) cache.save();

  const idx = makeIndex(files, sources, {
    mode: "disk", root, elapsedMs: Date.now() - t0,
    scanned: found.length, parsed, reused, cache: cache.summary(),
  });
  idx.cache = cache;
  return idx;
}

function toPosix(p) { return String(p).replace(/\\/g, "/"); }

module.exports = { indexDirectory, indexFiles, makeIndex, SKIP };
