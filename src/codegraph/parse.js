"use strict";
// ===================== Code Graph — Parser dispatch =====================
// Maps a filename/extension to its language parser and returns a normalized parse
// result: { lang, file, symbols[], imports[], exports[], loc }. Every language
// parser emits the same shapes (see README) so downstream stages (symbol table,
// dependency graph, duplication, search) are language-agnostic.
const path = require("path");
const js = require("./lang/javascript");
const py = require("./lang/python");
const go = require("./lang/go");
const rb = require("./lang/ruby");

// extension -> { lang-id, parser }
const EXT = {
  ".js": js, ".jsx": js, ".mjs": js, ".cjs": js, ".ts": js, ".tsx": js, ".mts": js, ".cts": js,
  ".py": py, ".pyi": py,
  ".go": go,
  ".rb": rb, ".rake": rb,
};

const LANG_NAME = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".py": "python", ".pyi": "python", ".go": "go", ".rb": "ruby", ".rake": "ruby",
};

function extname(file) { return path.extname(String(file || "")).toLowerCase(); }

// detectLang(file) -> language id string or null if unsupported.
function detectLang(file) { return LANG_NAME[extname(file)] || null; }

// supported(file) -> boolean
function supported(file) { return !!EXT[extname(file)]; }

// parseSource(source, file) -> normalized parse result (null if unsupported).
function parseSource(source, file) {
  const parser = EXT[extname(file)];
  if (!parser) return null;
  const res = parser.parseFile(source, { file });
  const text = String(source == null ? "" : source);
  return Object.assign(res, {
    file: file || "",
    lang: detectLang(file) || res.lang,
    loc: text.length ? text.split("\n").length : 0,
  });
}

module.exports = { EXT, LANG_NAME, detectLang, supported, parseSource, extname };
