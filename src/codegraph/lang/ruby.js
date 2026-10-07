"use strict";
// ===================== Code Graph — Ruby parser =====================
// Covers .rb. Ruby scopes are keyword-delimited (`class`/`module`/`def` ... `end`),
// so we maintain an explicit block-depth counter and a stack of open named scopes
// to attach each `def` to its enclosing class/module (method vs. free function) and
// to nest classes/modules correctly. Statement-modifier forms (`x if y`) are not
// treated as block openers because the keyword is not the first token. Runs on
// MASKED source so `#` comments, `=begin/=end` blocks and string literals never
// trip the scanner. Extracts classes, modules, methods, functions and requires.
const { mask } = require("../tokenizer");

const RE_CLASS  = /^class\s+([A-Z]\w*(?:::\w+)*)(?:\s*<\s*([\w:]+))?/;
const RE_MODULE = /^module\s+([A-Z]\w*(?:::\w+)*)/;
const RE_DEF    = /^def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/;
const OPEN_KW   = /^(class|module|def|begin|case)\b/;
const OPEN_COND = /^(if|unless|while|until|for)\b/;
const RE_DO     = /\bdo\b(\s*\|[^|]*\|)?\s*$/;

function parseFile(source, opts) {
  opts = opts || {};
  const { masked } = mask(source, "ruby");
  const lines = masked.split("\n");
  // require/load/autoload paths are string literals -> scan a comments-only mask.
  const specLines = mask(source, "ruby", { keepStrings: true }).masked.split("\n");
  const symbols = [], imports = [], exports = [];
  const stack = []; // { kind, name, base }
  let depth = 0;

  const namedParent = () => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind === "class" || stack[k].kind === "module") return stack[k].name; return null; };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;

    const opens = (OPEN_KW.test(t) ? 1 : 0) + (OPEN_COND.test(t) ? 1 : 0) + (RE_DO.test(t) ? 1 : 0);
    const closes = (t.match(/\bend\b/g) || []).length;

    let cm, mm, dm;
    if ((cm = t.match(RE_CLASS))) {
      symbols.push({ name: cm[1], kind: "class", line: i + 1, col: raw.indexOf("class") + 1, exported: true, parent: namedParent(), extends: cm[2] || null });
      stack.push({ kind: "class", name: cm[1], base: depth });
    } else if ((mm = t.match(RE_MODULE))) {
      symbols.push({ name: mm[1], kind: "class", line: i + 1, col: raw.indexOf("module") + 1, exported: true, parent: namedParent(), rubyKind: "module" });
      stack.push({ kind: "module", name: mm[1], base: depth });
    } else if ((dm = t.match(RE_DEF))) {
      const parent = namedParent();
      symbols.push({ name: dm[1], kind: parent ? "method" : "function", line: i + 1, col: raw.indexOf("def") + 1, exported: true, parent, signature: t.slice(0, 120) });
      stack.push({ kind: "def", name: dm[1], base: depth });
    }

    // require / require_relative / load / autoload (on the string-preserving mask)
    const specRaw = specLines[i] || "";
    let im;
    const reImp = /\b(require_relative|require|load)\s+["']([^"']+)["']/g;
    while ((im = reImp.exec(specRaw))) imports.push({ source: im[2], kind: im[1], line: i + 1, names: [] });
    const au = specRaw.match(/\bautoload\s+:(\w+)\s*,\s*["']([^"']+)["']/);
    if (au) imports.push({ source: au[2], kind: "autoload", line: i + 1, names: [{ imported: au[1], local: au[1] }] });

    depth += opens - closes;
    while (stack.length && depth <= stack[stack.length - 1].base) stack.pop();
  }

  for (const s of symbols) if ((s.kind === "class" || (s.kind === "function")) && s.parent == null) exports.push({ name: s.name, kind: "public", line: s.line });
  return { lang: "ruby", symbols, imports, exports };
}

module.exports = { parseFile };
