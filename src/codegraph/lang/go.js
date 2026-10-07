"use strict";
// ===================== Code Graph — Go parser =====================
// Covers .go. Extracts functions, methods (with their receiver type as parent),
// types (struct / interface / alias — reported as `class`), imports (single and
// parenthesized block form, with aliases) and exports. Go has no export keyword:
// an identifier is exported iff it starts with an uppercase letter, which we encode
// as the `exported` flag. Runs on MASKED source (raw strings, interpreted strings,
// runes and // /* */ comments blanked) so no keyword inside them is misread.
const { mask, lineIndex, locAt } = require("../tokenizer");

function reExec(re, text, fn) { let m; re.lastIndex = 0; while ((m = re.exec(text))) fn(m); }
function isExported(name) { return /^[A-Z]/.test(name); }

const RE_METHOD = /\bfunc\s*\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(/g;
const RE_FUNC   = /\bfunc\s+([A-Za-z_]\w*)\s*\(/g;
const RE_TYPE   = /\btype\s+([A-Za-z_]\w*)\s+(struct|interface)\b/g;
const RE_TYPEAL = /\btype\s+([A-Za-z_]\w*)\s+(?!struct\b|interface\b)[A-Za-z_\[\]*]/g;

function parseFile(source, opts) {
  opts = opts || {};
  const { masked } = mask(source, "go");
  const starts = lineIndex(masked);
  const loc = (off) => locAt(starts, off);
  const symbols = [], imports = [], exports = [];
  const pkg = (masked.match(/\bpackage\s+([A-Za-z_]\w*)/) || [])[1] || null;

  reExec(RE_METHOD, masked, (m) => {
    const off = m.index + m[0].lastIndexOf(m[2]);
    symbols.push({ name: m[2], kind: "method", line: loc(off).line, col: loc(off).col, exported: isExported(m[2]), parent: m[1], signature: m[0].replace(/\s+/g, " ").slice(0, 120) });
  });
  reExec(RE_FUNC, masked, (m) => {
    // skip methods (func (recv) Name) — those start with `func (`
    if (/\bfunc\s*\(/.test(m[0])) return;
    const off = m.index + m[0].indexOf(m[1]);
    symbols.push({ name: m[1], kind: "function", line: loc(off).line, col: loc(off).col, exported: isExported(m[1]), parent: null, signature: m[0].replace(/\s+/g, " ").slice(0, 120) });
  });
  reExec(RE_TYPE, masked, (m) => {
    const off = m.index + m[0].indexOf(m[1]);
    symbols.push({ name: m[1], kind: "class", line: loc(off).line, col: loc(off).col, exported: isExported(m[1]), parent: null, goKind: m[2] });
  });
  reExec(RE_TYPEAL, masked, (m) => {
    const off = m.index + m[0].indexOf(m[1]);
    symbols.push({ name: m[1], kind: "type", line: loc(off).line, col: loc(off).col, exported: isExported(m[1]), parent: null });
  });

  // Import paths are string literals, so scan a comments-only mask (offsets stay
  // aligned with `masked`).
  const specMask = mask(source, "go", { keepStrings: true }).masked;
  parseImports(specMask, loc, imports);
  for (const s of symbols) if (s.exported && s.parent == null) exports.push({ name: s.name, kind: "public", line: s.line });
  return { lang: "go", symbols, imports, exports, pkg };
}

function parseImports(masked, loc, out) {
  // block form: import ( ... )
  reExec(/\bimport\s*\(([^)]*)\)/g, masked, (m) => {
    const base = loc(m.index).line;
    const inner = m[1];
    let off = 0;
    for (const raw of inner.split("\n")) {
      const lineNo = base + off; off++;
      const mm = raw.match(/^\s*(?:([A-Za-z_.]\w*)\s+)?"([^"]+)"/);
      if (mm) out.push({ source: mm[2], kind: "import", line: lineNo, alias: mm[1] || undefined, names: [] });
    }
  });
  // single form: import "x" / import alias "x"
  reExec(/\bimport\s+(?:([A-Za-z_.]\w*)\s+)?"([^"]+)"/g, masked, (m) => {
    out.push({ source: m[2], kind: "import", line: loc(m.index).line, alias: m[1] || undefined, names: [] });
  });
}

module.exports = { parseFile, isExported, parseImports };
