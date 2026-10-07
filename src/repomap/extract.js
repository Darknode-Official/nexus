"use strict";
// ===================== Repo Map — Per-file Extraction =====================
// Turns one file's source into the three things the ranked map needs:
//   1. defs       — the symbols this file DEFINES (name, kind, line, parent, sig)
//   2. refs       — identifier -> reference count across the whole file body
//                   (how often the file *uses* each name)
//   3. signatures — the compact declaration line for each defined symbol
//
// References are extracted from the codegraph MASKED source, so identifiers that
// only appear inside strings or comments never count as references. We then drop
// language keywords and the file's own import/require machinery so the reference
// signal reflects real symbol usage. This per-file unit is deliberately pure and
// self-contained: the incremental cache stores exactly this object keyed by the
// file's content hash, so an unchanged file is never re-scanned.

const { mask } = require("../codegraph/tokenizer");
const parse = require("../codegraph/parse");
const { extractSignature } = require("./signature");

// Identifiers so common they carry no structural signal — excluded from the
// reference graph. Union of control-flow / primitive keywords across the supported
// languages plus a few ubiquitous globals.
const STOPWORDS = new Set([
  // shared control flow / declarations
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "yield", "await", "async", "function", "class", "const",
  "let", "var", "new", "delete", "typeof", "instanceof", "in", "of", "void",
  "this", "super", "null", "true", "false", "undefined", "try", "catch",
  "finally", "throw", "import", "export", "from", "as", "require", "module",
  "exports", "extends", "implements", "interface", "type", "enum", "public",
  "private", "protected", "static", "readonly", "abstract", "override", "get",
  "set", "with", "debugger",
  // python
  "def", "elif", "pass", "lambda", "global", "nonlocal", "and", "or", "not",
  "is", "None", "True", "False", "self", "cls", "raise", "except", "with",
  "assert", "del", "print", "range", "len", "str", "int", "float", "list",
  "dict", "set", "tuple", "bool", "object",
  // go
  "func", "package", "struct", "interface", "map", "chan", "go", "defer",
  "select", "fallthrough", "range", "nil", "iota", "string", "error", "byte",
  "rune", "bool", "int", "int32", "int64", "uint", "uint32", "uint64", "float64",
  // ruby
  "end", "then", "elsif", "unless", "until", "begin", "ensure", "rescue",
  "module", "attr", "attr_accessor", "attr_reader", "attr_writer", "nil", "puts",
  // ubiquitous globals / noise
  "console", "log", "length", "push", "pop", "map", "filter", "reduce", "slice",
  "join", "split", "Object", "Array", "String", "Number", "Boolean", "JSON",
  "Math", "Date", "Promise", "Error", "err", "e", "i", "j", "k", "v", "x", "y",
  "z", "a", "b", "c", "d", "n", "fn", "cb", "ok", "to", "it", "at",
]);

const IDENT_RE_DEFAULT = /[A-Za-z_$][A-Za-z0-9_$]*/g;
// Python/Go/Ruby identifiers use no `$`; the default is a harmless superset.

/**
 * Extract per-file map data from source.
 *
 * @param {string} file - relative path (used for lang detection + labelling)
 * @param {string} source - full file text
 * @param {Object} [parsed] - optional pre-computed codegraph parse record; if
 *        omitted this re-parses via codegraph (so callers can share work).
 * @returns {{
 *   file:string, lang:string, loc:number,
 *   defs: Array<Object>,
 *   signatures: Object<string,string>,
 *   refs: Object<string,number>,
 *   defNames: string[]
 * }}
 */
function extractFile(file, source, parsed) {
  const text = String(source == null ? "" : source);
  const rec = parsed || parse.parseSource(text, file) || { lang: parse.detectLang(file) || "javascript", symbols: [], loc: 0 };
  const lang = rec.lang || parse.detectLang(file) || "javascript";

  // --- Definitions + their signatures ---
  const defs = [];
  const signatures = Object.create(null);
  const defNames = [];
  for (const sym of (rec.symbols || [])) {
    if (!sym || !sym.name) continue;
    const def = {
      name: sym.name,
      kind: sym.kind,
      line: sym.line || 0,
      col: sym.col || 0,
      parent: sym.parent || null,
      exported: !!sym.exported,
    };
    defs.push(def);
    if (!defNames.includes(sym.name)) defNames.push(sym.name);
    // A symbol-qualified key keeps methods on different classes distinct.
    const key = sigKey(def);
    if (signatures[key] == null) {
      signatures[key] = extractSignature(text, sym, lang);
    }
  }

  // --- References: identifier frequency over the masked body ---
  const refs = extractReferences(text, lang);

  // Imports are retained (minimal fields) so the dependency backbone can be rebuilt
  // from cached extractions alone — an unchanged file never needs re-reading.
  const imports = (rec.imports || []).map((imp) => ({ source: imp.source, kind: imp.kind }));

  return {
    file, lang, loc: rec.loc || (text ? text.split("\n").length : 0),
    defs, signatures, refs, defNames, imports,
  };
}

// Stable key for a symbol's signature within a file (handles method overloads on
// distinct classes and same-named free functions).
function sigKey(def) {
  return (def.parent ? def.parent + "." : "") + def.name + "#" + def.kind + "@" + def.line;
}

/**
 * Count identifier references in masked source. Keywords, stopwords and pure
 * numeric-looking tokens are excluded. Returns a plain object ident -> count.
 * @param {string} source
 * @param {string} lang
 * @returns {Object<string,number>}
 */
function extractReferences(source, lang) {
  const masked = mask(source, maskLang(lang)).masked;
  const refs = Object.create(null);
  let m;
  IDENT_RE_DEFAULT.lastIndex = 0;
  while ((m = IDENT_RE_DEFAULT.exec(masked))) {
    const id = m[0];
    if (id.length < 2) continue;          // single chars carry no signal
    if (STOPWORDS.has(id)) continue;
    // Skip tokens that are property accesses right after a dot would require
    // lookbehind; instead we accept them — a referenced `.method` name still ties
    // the file to the class that defines that method, which is desirable.
    refs[id] = (refs[id] || 0) + 1;
  }
  return refs;
}

function maskLang(lang) {
  if (lang === "typescript") return "javascript";
  if (lang === "javascript" || lang === "go" || lang === "python" || lang === "ruby") return lang;
  return "javascript";
}

module.exports = {
  extractFile,
  extractReferences,
  sigKey,
  STOPWORDS,
};
