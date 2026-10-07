"use strict";
// ===================== Refactor — Inline variable / function =====================
// The inverse of extract. Two bounded, safe transforms:
//
//   inlineVariable — replace references to a `const/let name = <expr>;` with `(expr)`
//     and delete the declaration. Allowed when the variable is used once, or the
//     expression is side-effect-free (no calls) and the variable is never reassigned.
//     `force` overrides the multi-use/side-effect guard.
//
//   inlineFunction — replace calls to a SIMPLE function (an arrow with an expression
//     body, or a `function` whose body is a single `return <expr>;`) with the
//     expression, substituting arguments for parameters, then delete the declaration.
//     Refuses recursion, `this`/`arguments`, rest/default/destructured params, and
//     arity mismatches.
//
// Language coverage: JavaScript / TypeScript, single file (local scope).

const u = require("./util");
const plan = require("./plan");
const { detectLang } = require("../codegraph/parse");

/**
 * @param {object} args - { file, source, name, force? }
 * @returns {import('./plan').RefactorPlan}
 */
function planInlineVariable(args) {
  const { file, source, name } = args;
  const lang = detectLang(file);
  if (lang !== "javascript" && lang !== "typescript") return plan.refuse("inline-variable", ["inline supports JS/TS only"]);
  const masked = u.maskJs(source);

  const declRe = new RegExp("(?:^|[^.\\w$])(const|let|var)\\s+(" + escapeRe(name) + ")\\s*=", "g");
  const decls = [];
  let m;
  while ((m = declRe.exec(masked))) {
    const kwStart = m.index + m[0].indexOf(m[1]);
    const nameOffset = m.index + m[0].indexOf(name, m[0].indexOf(m[1]) + m[1].length);
    decls.push({ kw: m[1], kwStart, nameOffset, eq: m.index + m[0].length - 1 });
  }
  if (decls.length === 0) return plan.refuse("inline-variable", ["no `const/let/var " + name + " = ...` declaration found"]);
  if (decls.length > 1) return plan.refuse("inline-variable", ["multiple declarations of '" + name + "'; inline-variable needs a single declaration"]);

  const decl = decls[0];
  const exprStart = skipWs(masked, decl.eq + 1);
  const semi = findStatementEnd(masked, exprStart);
  if (semi < 0) return plan.refuse("inline-variable", ["could not find the end of the declaration statement"]);
  const expr = source.slice(exprStart, semi).trim();

  // Usages: whole-word code occurrences excluding the declaration name token.
  const usages = u.occurrences(source, name, { masked }).filter((o) => o.offset !== decl.nameOffset);
  if (usages.length === 0) return plan.refuse("inline-variable", ["'" + name + "' is never used; nothing to inline (remove it instead)"]);

  const reassigned = isReassigned(masked, name, decl.nameOffset);
  const hasCall = /\(/.test(u.maskJs(expr));
  const warnings = [];
  if (!args.force) {
    if (reassigned) return plan.refuse("inline-variable", ["'" + name + "' is reassigned; inlining would change behavior (use force to override)"]);
    if (usages.length > 1 && hasCall) {
      return plan.refuse("inline-variable", ["'" + name + "' is used " + usages.length + "x and its initializer may have side effects; refusing to duplicate it (use force to override)"]);
    }
  } else {
    if (reassigned) warnings.push("forced: '" + name + "' is reassigned — inlined with the initializer value only");
  }

  // Replace usages with (expr); delete the declaration statement (whole line).
  const wrapped = needsParens(expr) ? "(" + expr + ")" : expr;
  const edits = usages.map((o) => ({ start: o.offset, end: o.offset + name.length, text: wrapped }));
  const stmt = fullStatementRange(source, decl.kwStart, semi);
  edits.push({ start: stmt.start, end: stmt.end, text: "" });

  const newContent = u.applyEdits(source, edits);
  const nf = norm(file);
  return {
    refactoring: "inline-variable",
    ok: true,
    safety: plan.safety(true, [], warnings),
    edits: new Map([[nf, newContent]]),
    before: new Map([[nf, source]]),
    details: { file: nf, name, expr, usages: usages.length },
  };
}

/**
 * @param {object} args - { file, source, name, force? }
 * @returns {import('./plan').RefactorPlan}
 */
function planInlineFunction(args) {
  const { file, source, name } = args;
  const lang = detectLang(file);
  if (lang !== "javascript" && lang !== "typescript") return plan.refuse("inline-function", ["inline supports JS/TS only"]);
  const masked = u.maskJs(source);

  const sig = findSimpleFunction(source, masked, name);
  if (!sig.ok) return plan.refuse("inline-function", sig.reasons);

  if (/\bthis\b|\barguments\b/.test(u.maskJs(sig.body))) {
    return plan.refuse("inline-function", ["'" + name + "' uses `this`/`arguments`; cannot inline safely"]);
  }
  if (sig.params.some((p) => /[.={[\]]/.test(p))) {
    return plan.refuse("inline-function", ["'" + name + "' has rest/default/destructured parameters; cannot inline safely"]);
  }
  if (wordUsed(u.maskJs(sig.body), name)) {
    return plan.refuse("inline-function", ["'" + name + "' is recursive; cannot inline"]);
  }

  // Find and rewrite every call site.
  const callOffsets = findCallSites(source, masked, name).filter((c) => c.nameOffset !== sig.nameOffset);
  if (callOffsets.length === 0) return plan.refuse("inline-function", ["no call sites of '" + name + "' found"]);

  const edits = [];
  const warnings = [];
  for (const c of callOffsets) {
    const argList = parseArgs(source.slice(c.argsStart, c.argsEnd));
    if (argList.length !== sig.params.length) {
      return plan.refuse("inline-function", ["call at offset " + c.nameOffset + " passes " + argList.length + " args but '" + name + "' has " + sig.params.length + " params"]);
    }
    const substituted = substitute(sig.body, sig.params, argList);
    edits.push({ start: c.nameOffset, end: c.callEnd, text: "(" + substituted + ")" });
  }
  // Remove the declaration statement.
  edits.push({ start: sig.declStart, end: sig.declEnd, text: "" });

  const newContent = u.applyEdits(source, edits);
  const nf = norm(file);
  return {
    refactoring: "inline-function",
    ok: true,
    safety: plan.safety(true, [], warnings),
    edits: new Map([[nf, newContent]]),
    before: new Map([[nf, source]]),
    details: { file: nf, name, params: sig.params, callSites: callOffsets.length },
  };
}

/** Locate a simple inlinable function: arrow-expr or single-return function. */
function findSimpleFunction(source, masked, name) {
  // Arrow: const name = (a,b) => expr;   or   const name = a => expr;
  let re = new RegExp("(?:^|[^.\\w$])(const|let|var)\\s+(" + escapeRe(name) + ")\\s*=\\s*(?:async\\s+)?(\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>", "g");
  let m = re.exec(masked);
  if (m) {
    const nameOffset = m.index + m[0].indexOf(name, m[0].indexOf(m[2]));
    const paramsRaw = m[3];
    const params = parseParamList(paramsRaw);
    const arrowEnd = m.index + m[0].length;
    const bodyStart = skipWs(masked, arrowEnd);
    if (masked[bodyStart] === "{") {
      // block-body arrow: accept only a single `return expr;`
      const close = matchBrace(masked, bodyStart);
      const inner = source.slice(bodyStart + 1, close).trim();
      const rm = inner.match(/^return\s+([\s\S]+?);?$/);
      if (!rm || /;/.test(u.maskJs(inner).replace(/;?\s*$/, ""))) return { ok: false, reasons: ["'" + name + "' arrow body is not a single return expression"] };
      const declStart = lineStart(source, nameOffset);
      const declEnd = findStatementEnd(masked, close) + 0;
      return { ok: true, name, nameOffset, params, body: rm[1].trim(), declStart, declEnd: endOfStatement(masked, close) };
    }
    const semi = findStatementEnd(masked, bodyStart);
    const body = source.slice(bodyStart, semi).trim();
    return { ok: true, name, nameOffset, params, body, declStart: lineStart(source, nameOffset), declEnd: endOfStatement(masked, semi - 1) };
  }
  // function name(a,b) { return expr; }
  re = new RegExp("(?:^|[^.\\w$])function\\s+(" + escapeRe(name) + ")\\s*\\(([^)]*)\\)\\s*\\{", "g");
  m = re.exec(masked);
  if (m) {
    const nameOffset = m.index + m[0].indexOf(name);
    const params = parseParamList(m[2]);
    const brace = m.index + m[0].length - 1;
    const close = matchBrace(masked, brace);
    const inner = source.slice(brace + 1, close).trim();
    const rm = inner.match(/^return\s+([\s\S]+?);?$/);
    if (!rm) return { ok: false, reasons: ["'" + name + "' is not a single-return function; cannot inline"] };
    // Reject multiple statements.
    const innerMasked = u.maskJs(inner).replace(/;\s*$/, "");
    if (/;/.test(innerMasked)) return { ok: false, reasons: ["'" + name + "' body has multiple statements; cannot inline"] };
    return { ok: true, name, nameOffset, params, body: rm[1].trim(), declStart: lineStart(source, nameOffset), declEnd: endOfStatement(masked, close) };
  }
  return { ok: false, reasons: ["no simple (single-expression) function '" + name + "' found"] };
}

function parseParamList(raw) {
  raw = raw.replace(/^\(|\)$/g, "").trim();
  if (!raw) return [];
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

/** Find `name(` call sites, returning name/arg offsets with balanced parens. */
function findCallSites(source, masked, name) {
  const out = [];
  const L = name.length;
  let i = 0;
  const n = masked.length;
  while (i <= n - L) {
    if (masked.startsWith(name, i) && !u.ID_CHAR.test(masked[i - 1] || "") && !u.ID_CHAR.test(masked[i + L] || "")) {
      let k = i - 1; while (k >= 0 && (masked[k] === " " || masked[k] === "\t")) k--;
      if (masked[k] === ".") { i += L; continue; } // method call, not ours
      let j = i + L; while (masked[j] === " " || masked[j] === "\t") j++;
      if (masked[j] === "(") {
        const close = matchParen(masked, j);
        if (close > 0) { out.push({ nameOffset: i, argsStart: j + 1, argsEnd: close, callEnd: close + 1 }); i = close + 1; continue; }
      }
    }
    i++;
  }
  return out;
}

/** Split a top-level argument list (respecting nested brackets). */
function parseArgs(text) {
  const masked = u.maskJs(text);
  const args = [];
  let depth = 0, start = 0, any = false;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
    if (!/\s/.test(c)) any = true;
  }
  const tail = text.slice(start).trim();
  if (tail) args.push(tail);
  else if (any && args.length) args.push("");
  return any ? args : [];
}

/** Substitute params->args in a body expression (whole-word, code only). */
function substitute(body, params, args) {
  let out = body;
  // Replace right-to-left by offset to keep positions valid; recompute per param.
  for (let p = 0; p < params.length; p++) {
    const occ = u.occurrences(out, params[p], {}).sort((a, b) => b.offset - a.offset);
    const arg = needsParens(args[p]) ? "(" + args[p] + ")" : args[p];
    for (const o of occ) out = out.slice(0, o.offset) + arg + out.slice(o.offset + params[p].length);
  }
  return out;
}

// ---- small lexical helpers ----
function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }
function lineStart(s, i) { while (i > 0 && s[i - 1] !== "\n") i--; return i; }
function matchBrace(masked, open) { return matchPair(masked, open, "{", "}"); }
function matchParen(masked, open) { return matchPair(masked, open, "(", ")"); }
function matchPair(masked, open, o, c) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === o) depth++;
    else if (masked[i] === c) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** End offset (exclusive) of the statement whose expression starts at `start`. */
function findStatementEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return i;
    else if (c === "\n" && depth === 0) {
      // Allow ASI: if next non-space is not a continuation, treat newline as end.
      let j = i + 1; while (j < masked.length && /\s/.test(masked[j])) j++;
      if (depth === 0 && (masked[j] === "}" || j >= masked.length)) return i;
    }
  }
  return masked.length;
}

/** Offset just past the terminating `;` (and trailing newline) after `from`. */
function endOfStatement(masked, from) {
  let i = from;
  while (i < masked.length && masked[i] !== ";" && masked[i] !== "\n") i++;
  if (masked[i] === ";") i++;
  if (masked[i] === "\n") i++;
  return i;
}

/**
 * Full range of a declaration statement for clean removal. Starts at the decl
 * keyword, but extends back to the line start (and swallows the trailing newline)
 * only when the keyword is the first non-space token on its line — so a declaration
 * sharing a line with other code (e.g. `function f(){ const x = ...; ... }`) removes
 * just the statement, not the whole line.
 */
function fullStatementRange(source, kwStart, semiOffset) {
  let end = semiOffset;
  while (end < source.length && source[end] !== ";" && source[end] !== "\n") end++;
  if (source[end] === ";") end++;
  const ls = lineStart(source, kwStart);
  const prefix = source.slice(ls, kwStart);
  if (prefix.trim() === "") {
    // Declaration is alone on its line: remove the indentation and trailing newline.
    if (source[end] === "\n") end++;
    return { start: ls, end };
  }
  // Shares the line: drop one leading space so `{ const x; next }` -> `{ next }`.
  let start = kwStart;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  return { start, end };
}

function isReassigned(masked, name, declOffset) {
  const re = new RegExp("(?:^|[^.\\w$])" + escapeRe(name) + "\\s*(=(?!=)|\\+\\+|--|\\+=|-=|\\*=|/=)", "g");
  let m;
  while ((m = re.exec(masked))) {
    const off = m.index + m[0].indexOf(name);
    if (off !== declOffset) return true;
  }
  return false;
}

function needsParens(expr) {
  const e = expr.trim();
  if (/^[\w$.]+$/.test(e)) return false;          // plain identifier / member
  if (/^["'`].*["'`]$/.test(e)) return false;      // string literal
  if (/^-?\d[\d_.eE]*$/.test(e)) return false;     // number
  if (/^\([\s\S]*\)$/.test(e)) return false;        // already parenthesized
  return true;
}

function wordUsed(masked, name) { return new RegExp("(?:^|[^.\\w$])" + escapeRe(name) + "\\s*\\(").test(masked); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function norm(p) { return require("../codegraph/depgraph").normalize(p); }

module.exports = { planInlineVariable, planInlineFunction };
