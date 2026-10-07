"use strict";
// ===================== Refactor — Extract function =====================
// Pull a contiguous range of statements out of a function into a new named function
// and replace the range with a call. Parameters are computed from the FREE variables
// of the selection (names used inside it but declared in the enclosing scope), and
// the return value(s) from names declared inside the selection that are still used
// after it. `await` inside the selection makes the extracted function `async` and the
// call `await`ed.
//
// Safety: refuses when the selection carries control flow that cannot be lifted —
// a top-level `return`, `break`, `continue` or `yield` — because that would change
// semantics. Honest language coverage: JavaScript / TypeScript only.

const u = require("./util");
const plan = require("./plan");
const { detectLang } = require("../codegraph/parse");

/**
 * @param {object} args
 * @param {string} args.file
 * @param {string} args.source
 * @param {number} args.startLine - 1-based, inclusive
 * @param {number} args.endLine   - 1-based, inclusive
 * @param {string} args.newName
 * @returns {import('./plan').RefactorPlan}
 */
function planExtract(args) {
  const { file, source, newName } = args;
  if (!u.isValidIdentifier(newName)) return plan.refuse("extract", ["'" + newName + "' is not a valid function name"]);
  const lang = detectLang(file);
  if (lang !== "javascript" && lang !== "typescript") return plan.refuse("extract", ["extract supports JS/TS only (got " + lang + ")"]);

  const starts = u.lineStarts(source);
  if (args.startLine < 1 || args.endLine >= starts.length || args.startLine > args.endLine) {
    return plan.refuse("extract", ["invalid line range " + args.startLine + "-" + args.endLine]);
  }
  const selStart = u.offsetOfLine(source, args.startLine);
  const selEnd = u.offsetAfterLine(source, args.endLine);
  const selection = source.slice(selStart, selEnd);
  const masked = u.maskJs(source);
  const selMasked = masked.slice(selStart, selEnd);

  // --- Control-flow safety: no lifting return/break/continue/yield. ---
  const cf = detectTopLevelControlFlow(selMasked);
  if (cf) return plan.refuse("extract", ["selection contains a top-level '" + cf + "' which cannot be safely extracted"]);

  const isAsync = /\bawait\b/.test(selMasked);

  // --- Enclosing function scope. ---
  const root = u.scanBlocks(masked);
  const fnBlock = u.enclosingFunctionBlock(root, selStart);
  const scopeStart = fnBlock ? fnBlock.open + 1 : 0;
  const scopeEnd = fnBlock ? fnBlock.bodyEnd - 1 : source.length;

  // Names available from the enclosing scope (params + body declarations).
  const enclosingNames = new Set();
  if (fnBlock) for (const p of paramsOf(masked, fnBlock)) enclosingNames.add(p);
  for (const b of bindersInRange(masked, scopeStart, scopeEnd)) enclosingNames.add(b.name);

  // Names declared inside the selection.
  const declaredInSel = new Set(bindersInRange(masked, selStart, selEnd).map((b) => b.name));

  // Identifiers referenced inside the selection (code, not member access).
  const usedInSel = [];
  const seenUse = new Set();
  for (const id of u.identifiers(source, { masked })) {
    if (id.offset < selStart || id.offset >= selEnd) continue;
    if (id.afterDot) continue;
    if (u.KEYWORDS.has(id.name) || u.GLOBALS.has(id.name)) continue;
    if (isPropertyKey(masked, id.offset, id.name)) continue;
    if (!seenUse.has(id.name)) { seenUse.add(id.name); usedInSel.push(id.name); }
  }

  // Parameters = free variables: used in selection, available from enclosing scope,
  // not (re)declared inside the selection.
  const params = usedInSel.filter((n) => enclosingNames.has(n) && !declaredInSel.has(n));

  // Returns = declared in selection AND used after it within the enclosing scope.
  const afterRegion = masked.slice(selEnd, scopeEnd);
  const returns = [...declaredInSel].filter((n) => wordUsed(afterRegion, n));

  if (returns.length > 3) {
    return plan.refuse("extract", ["selection produces " + returns.length + " outputs (" + returns.join(", ") + "); refactor the range to be narrower"]);
  }

  // --- Build the new function. ---
  const baseIndent = fnBlock ? u.indentAt(source, fnBlock.headerStart) : "";
  const body = reindent(selection, baseIndent + "  ");
  let retLine = "";
  if (returns.length === 1) retLine = "\n" + baseIndent + "  return " + returns[0] + ";";
  else if (returns.length > 1) retLine = "\n" + baseIndent + "  return { " + returns.join(", ") + " };";
  const fnKw = (isAsync ? "async " : "") + "function ";
  const fnText =
    baseIndent + fnKw + newName + "(" + params.join(", ") + ") {\n" +
    body.replace(/\n$/, "") + retLine + "\n" +
    baseIndent + "}\n\n";

  // --- Build the call site. ---
  const callExpr = (isAsync ? "await " : "") + newName + "(" + params.join(", ") + ")";
  let callSite;
  if (returns.length === 0) callSite = baseIndent + "  " + callExpr + ";\n";
  else if (returns.length === 1) callSite = baseIndent + "  " + returnKw(masked, selStart, selEnd, returns[0]) + " " + returns[0] + " = " + callExpr + ";\n";
  else callSite = baseIndent + "  const { " + returns.join(", ") + " } = " + callExpr + ";\n";

  // Insert the new function immediately before the enclosing function (sibling),
  // or before the selection when at module scope.
  const insertAt = fnBlock ? fnBlock.headerStart : selStart;
  const edits = [];
  if (insertAt <= selStart) {
    edits.push({ start: insertAt, end: insertAt, text: fnText });
    edits.push({ start: selStart, end: selEnd, text: callSite });
  } else {
    edits.push({ start: selStart, end: selEnd, text: callSite });
    edits.push({ start: insertAt, end: insertAt, text: fnText });
  }
  const newContent = u.applyEdits(source, edits);

  const nf = norm(file);
  return {
    refactoring: "extract",
    ok: true,
    safety: plan.safety(true, [], params.length === 0 && returns.length === 0 ? ["extracted function takes no parameters and returns nothing — verify it is not relying on closure state"] : []),
    edits: new Map([[nf, newContent]]),
    before: new Map([[nf, source]]),
    details: { file: nf, newName, params, returns, async: isAsync, lines: [args.startLine, args.endLine] },
  };
}

/** Detect a top-level control-flow statement in masked selection text. */
function detectTopLevelControlFlow(selMasked) {
  // Depth must be 0 (not inside a nested block/arrow) for the statement to "escape".
  let depth = 0;
  const tokens = /[{}]|\breturn\b|\bbreak\b|\bcontinue\b|\byield\b/g;
  let m;
  while ((m = tokens.exec(selMasked))) {
    const t = m[0];
    if (t === "{") depth++;
    else if (t === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) return t;
  }
  return null;
}

/** Parameter names of a function block (from its header `(...)`). */
function paramsOf(masked, block) {
  const header = masked.slice(block.headerStart, block.open);
  const paren = header.lastIndexOf("(");
  if (paren < 0) return [];
  const close = header.indexOf(")", paren);
  const inner = header.slice(paren + 1, close < 0 ? header.length : close);
  const out = [];
  for (let part of inner.split(",")) {
    part = part.trim();
    const m = part.match(/^(?:\{|\[)?\s*([A-Za-z_$][\w$]*)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** const/let/var/function/class binders within [start,end) (masked scan). */
function bindersInRange(masked, start, end) {
  const region = masked.slice(start, end);
  const out = [];
  const re = /(?:^|[^.\w$])(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(region))) out.push({ name: m[1], offset: start + m.index });
  // destructured
  const re2 = /(?:const|let|var)\s*[[{]([^\]}]*)[\]}]\s*=/g;
  while ((m = re2.exec(region))) {
    for (const part of m[1].split(",")) {
      const id = part.trim().match(/([A-Za-z_$][\w$]*)\s*$/);
      if (id) out.push({ name: id[1], offset: start + m.index });
    }
  }
  return out;
}

/** The declaration keyword (const/let/var) used for a name inside the selection. */
function returnKw(masked, start, end, name) {
  const region = masked.slice(start, end);
  const m = region.match(new RegExp("\\b(const|let|var)\\s+" + escapeRe(name) + "\\b"));
  return m ? (m[1] === "var" ? "let" : m[1]) : "const";
}

/** Is the identifier at offset an object-literal key (`name:`) or a decl name? */
function isPropertyKey(masked, offset, name) {
  let p = offset + name.length;
  while (masked[p] === " " || masked[p] === "\t") p++;
  // `name:` as a key — but not `?:` ternary; keys are followed directly by ':'
  // We only skip when preceded by `{` or `,` context (object literal / type).
  if (masked[p] === ":") {
    let q = offset - 1;
    while (q >= 0 && (masked[q] === " " || masked[q] === "\t" || masked[q] === "\n")) q--;
    if (masked[q] === "{" || masked[q] === ",") return true;
  }
  return false;
}

function wordUsed(masked, name) {
  return new RegExp("(?:^|[^.\\w$])" + escapeRe(name) + "\\b").test(masked);
}

/** Dedent to common indent, then re-indent every non-blank line with `indent`. */
function reindent(text, indent) {
  const lines = text.replace(/\n$/, "").split("\n");
  let min = Infinity;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const m = ln.match(/^[ \t]*/)[0].length;
    if (m < min) min = m;
  }
  if (!isFinite(min)) min = 0;
  return lines.map((ln) => (ln.trim() ? indent + ln.slice(min) : "")).join("\n") + "\n";
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function norm(p) { return require("../codegraph/depgraph").normalize(p); }

module.exports = { planExtract };
