"use strict";
// ============================= Retrieval — Public API =============================
// Local, dependency-free code retrieval (RAG without embeddings or services). It
// chunks source symbol-aware, indexes it with BM25 / TF-IDF over a code-aware
// tokenizer, optionally fuses structural signals from the codegraph subsystem,
// diversifies results with MMR, and packs them into a token budget using the
// tokensave estimator + context-packer. This is the component that lets Nexus feed
// an engine ONLY the relevant code — the direct lever on token economics.
//
// Quick start:
//   const retrieval = require("./src/retrieval");
//   const idx = retrieval.indexDirectory(process.cwd(), { cacheFile: ".nexus/retrieval.json" });
//   const res = idx.retrieve("parse import statement", { budget: 1500 });
//   console.log(res.report);   // ranked chunks + why each was selected
//   console.log(res.context);  // the packed context string, ready for a prompt
//
// See README.md for the API + honest methodology, and INTEGRATION.md for wiring.

const fs = require("fs");
const path = require("path");

const tokenize = require("./tokenize");
const chunker = require("./chunker");
const bm25 = require("./bm25");
const mmr = require("./mmr");
const hybrid = require("./hybrid");
const storeMod = require("./store");
const retriever = require("./retriever");

const parse = require("../codegraph/parse");
let codegraph = null;
try { codegraph = require("../codegraph"); } catch (_) { codegraph = null; }

// Directory walk skip list — mirrors codegraph's so the two indexes see the same
// file set (important for the hybrid signal to line up).
const SKIP = /(^|\/)(\.git|node_modules|\.nexus|dist|build|\.cache|\.next|out|coverage|target|__pycache__|vendor|\.venv|venv)(\/|$)/;

function toPosix(p) { return String(p).replace(/\\/g, "/"); }

/**
 * Wrap a store with query convenience methods (and an optional codegraph index
 * for hybrid retrieval).
 */
function makeIndex(store, ctx) {
  ctx = ctx || {};
  return {
    store,
    meta: ctx.meta || {},
    cgIndex: ctx.cgIndex || null,
    /**
     * Retrieve chunks for a query. If a codegraph index is attached and
     * opts.hybrid !== false, structural signals are fused automatically.
     */
    retrieve(query, opts) {
      opts = opts || {};
      const merged = Object.assign({ cgIndex: this.cgIndex }, opts);
      return retriever.retrieve(store, query, merged);
    },
    stats() { return store.stats(); },
    save(file) { return store.save(file); },
    allChunks() { return store.allChunks(); },
  };
}

/**
 * Index in-memory sources.
 * @param {Array<{file,source}>} fileObjs
 * @param {object} [opts] - { storeContent, chunkOpts, hybrid }
 */
function indexFiles(fileObjs, opts) {
  opts = opts || {};
  const store = storeMod.createStore(opts);
  for (const fo of (fileObjs || [])) store.addFile(fo.file, fo.source);
  let cgIndex = null;
  if (opts.hybrid !== false && codegraph) {
    try { cgIndex = codegraph.indexFiles(fileObjs); } catch (_) { cgIndex = null; }
  }
  return makeIndex(store, { cgIndex, meta: { mode: "memory", files: (fileObjs || []).length } });
}

/**
 * Index a directory from disk, with an incremental, persistable cache.
 * @param {string} root
 * @param {object} [opts] - { cacheFile, maxFiles, maxBytes, storeContent,
 *   chunkOpts, hybrid }
 */
function indexDirectory(root, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 20000;
  const maxBytes = opts.maxBytes || 2000000;
  const t0 = Date.now();
  const store = storeMod.createStore(Object.assign({ cacheFile: opts.cacheFile }, opts));
  if (opts.cacheFile) store.load(opts.cacheFile);

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

  const live = new Set();
  let changed = 0, reused = 0;
  const forCodegraph = [];
  for (const abs of found) {
    let st; try { st = fs.statSync(abs); } catch (_) { continue; }
    if (st.size > maxBytes) continue;
    const rel = toPosix(path.relative(root, abs));
    live.add(rel);
    const r = store.syncPath(abs, rel);
    if (r.changed) changed++; else reused++;
    if (codegraph) {
      let content; try { content = fs.readFileSync(abs, "utf8"); } catch (_) { content = null; }
      if (content != null) forCodegraph.push({ file: rel, source: content });
    }
  }
  // Prune files that disappeared.
  for (const key of [...store.files.keys()]) if (!live.has(key)) store.removeFile(key);

  if (opts.cacheFile) store.save(opts.cacheFile);

  let cgIndex = null;
  if (opts.hybrid !== false && codegraph) {
    try { cgIndex = codegraph.indexFiles(forCodegraph); } catch (_) { cgIndex = null; }
  }

  return makeIndex(store, {
    cgIndex,
    meta: { mode: "disk", root, elapsedMs: Date.now() - t0, scanned: found.length, changed, reused },
  });
}

module.exports = {
  // high-level entrypoints
  indexFiles,
  indexDirectory,
  makeIndex,
  // query API (operate on a store directly)
  retrieve: retriever.retrieve,
  // building blocks (exposed for advanced use / testing)
  tokenize, chunker, bm25, mmr, hybrid, store: storeMod, retriever,
  createStore: storeMod.createStore,
  SKIP,
};
