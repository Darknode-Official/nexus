"use strict";
// ============================= Code Graph — Repo Intelligence =============================
// Nexus subsystem that lets the agent work on EXISTING codebases instead of only
// greenfield: a multi-language symbol index, a cross-file symbol graph, a module
// dependency graph (cycles + topological order), a DRY/duplication detector, a
// "find existing implementation" query API, impact/blast-radius analysis, and an
// incremental (mtime/hash) cache. Zero third-party dependencies — Node stdlib only.
//
// Quick start:
//   const codegraph = require("./src/codegraph");
//   const idx = codegraph.indexDirectory(process.cwd(), { cacheFile: ".nexus/codegraph.json" });
//   idx.findImplementation("parse import statement");   // reuse before you write
//   idx.impact({ file: "src/util.js", name: "readConfig" });  // what could break
//   idx.duplicates();                                   // candidate DRY violations
//   idx.topo();                                         // safe build/visit order
//
// See README.md for the full API and the honest methodology write-up.

const tokenizer = require("./tokenizer");
const blocks = require("./blocks");
const parse = require("./parse");
const depgraph = require("./depgraph");
const symbols = require("./symbols");
const duplication = require("./duplication");
const search = require("./search");
const impact = require("./impact");
const cache = require("./cache");
const indexer = require("./indexer");
const js = require("./lang/javascript");
const py = require("./lang/python");
const go = require("./lang/go");
const rb = require("./lang/ruby");

module.exports = {
  // high-level entrypoints
  indexDirectory: indexer.indexDirectory,
  indexFiles: indexer.indexFiles,
  parseSource: parse.parseSource,
  detectLang: parse.detectLang,
  // building blocks (exposed for advanced use / testing)
  tokenizer, blocks, parse, depgraph, symbols, duplication, search, impact, cache, indexer,
  lang: { javascript: js, python: py, go, ruby: rb },
};
