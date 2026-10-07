"use strict";
// ============================= Shellplan — POSIX-ish shell parser =============================
// Tokenizes and parses a command line into a structured AST so the rest of the
// shellplan subsystem can reason about it BEFORE Nexus ever runs it. This is the
// "understanding" layer; enforcement lives in ../sandbox.js (denylist) and
// ../capability.js (allowlist). We only read and describe here — nothing executes.
//
// Grammar (recursive-descent, a pragmatic subset of the POSIX shell grammar):
//
//   list      := and_or ( (';' | '&' | '\n') and_or )* [ ';' | '&' ]
//   and_or    := pipeline ( ('&&' | '||') pipeline )*
//   pipeline  := [ '!' ] command ( '|' command )*
//   command   := simple | subshell | group
//   subshell  := '(' list ')' redirs*
//   group     := '{' list '}' redirs*
//   simple    := assignment* ( word | redir )+
//
// The tokenizer is quote-aware: single quotes are literal, double quotes allow
// `$`, backtick and backslash semantics, and backslash escapes outside quotes.
// Command substitution `$(...)`/backticks, parameter expansion `$VAR`/`${...}`,
// globs, and heredocs are all recognized. See ./README.md for honest limits.

/** Operator tokens, longest first so `>>`/`&&` win over `>`/`&`. */
const OPERATORS = [
  "2>&1", "1>&2", "&>>", "&>", ">>", "<<-", "<<<", "<<", "<&", ">&",
  "||", "&&", ";;", "2>>", "2>", ">|", "|&", "|", "&", ";", "<", ">", "(", ")",
];

/** @typedef {{text:string, raw:string, quoted:boolean, glob:boolean, parts:Array, expansions:Array}} Word */

/**
 * Tokenize a shell command line into a flat token stream.
 * Heredocs are consumed inline: on `<<`/`<<-` the following word is the delimiter
 * and the body (subsequent lines up to the delimiter) is attached to the token.
 * @param {string} input
 * @returns {{tokens:Array, errors:string[]}}
 */
function tokenize(input) {
  const src = String(input == null ? "" : input);
  const tokens = [];
  const errors = [];
  let i = 0;
  const n = src.length;
  // Pending heredocs collected on the current logical line, resolved at newline.
  let pendingHeredocs = [];

  function isBlank(c) { return c === " " || c === "\t"; }

  // Try to read an operator at position i. Returns the operator string or null.
  function readOperator() {
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        // A leading digit before > / < is an fd (handled in word scan); plain op here.
        return op;
      }
    }
    return null;
  }

  // Scan a single WORD (possibly spanning multiple quoted/unquoted segments).
  function readWord() {
    const startRaw = i;
    let text = "";
    let quoted = false;
    let glob = false;
    const parts = [];
    const expansions = [];

    function pushPart(type, value, isQuoted) {
      parts.push({ type, value, quoted: !!isQuoted });
    }

    while (i < n) {
      const c = src[i];
      if (isBlank(c) || c === "\n") break;
      // Operator boundary (but a bare fd-number followed by a redir is handled below).
      const opHere = readOperator();
      if (opHere && !(/[0-9]/.test(c) && (src[i + 1] === ">" || src[i + 1] === "<"))) {
        break;
      }
      if (c === "'") {
        // Single quote: everything literal until the next single quote.
        quoted = true;
        const close = src.indexOf("'", i + 1);
        if (close === -1) { errors.push("unterminated single quote"); text += src.slice(i + 1); i = n; break; }
        const val = src.slice(i + 1, close);
        text += val; pushPart("squote", val, true);
        i = close + 1;
        continue;
      }
      if (c === '"') {
        // Double quote: process escapes and expansions until the closing quote.
        quoted = true;
        const res = readDoubleQuoted();
        text += res.text;
        for (const e of res.expansions) expansions.push(e);
        pushPart("dquote", res.text, true);
        continue;
      }
      if (c === "\\") {
        // Backslash escape of the next char (line-continuation if newline).
        const nx = src[i + 1];
        if (nx === "\n") { i += 2; continue; } // line continuation
        if (nx === undefined) { text += "\\"; i += 1; break; }
        text += nx; pushPart("escape", nx, true);
        i += 2;
        continue;
      }
      if (c === "$") {
        const res = readDollar();
        text += res.text;
        if (res.expansion) { expansions.push(res.expansion); pushPart(res.expansion.type, res.text, false); }
        else pushPart("lit", res.text, false);
        continue;
      }
      if (c === "`") {
        const res = readBacktick();
        text += res.text;
        if (res.expansion) { expansions.push(res.expansion); pushPart("command_sub", res.text, false); }
        continue;
      }
      if (c === "*" || c === "?" || c === "[") {
        glob = true;
        text += c; pushPart("glob", c, false);
        i += 1;
        continue;
      }
      if (c === "~" && (text === "" )) {
        // leading tilde (home) — note as expansion but keep literal text
        text += c; pushPart("tilde", c, false);
        i += 1;
        continue;
      }
      // ordinary literal char
      text += c; pushPart("lit", c, false);
      i += 1;
    }
    return { text, raw: src.slice(startRaw, i), quoted, glob, parts, expansions };
  }

  // Read the contents of a double-quoted string (opening quote at src[i]).
  function readDoubleQuoted() {
    i += 1; // skip opening "
    let text = "";
    const expansions = [];
    while (i < n) {
      const c = src[i];
      if (c === '"') { i += 1; return { text, expansions }; }
      if (c === "\\") {
        const nx = src[i + 1];
        // In double quotes, backslash only escapes $ ` " \ and newline.
        if (nx === "$" || nx === "`" || nx === '"' || nx === "\\") { text += nx; i += 2; continue; }
        if (nx === "\n") { i += 2; continue; }
        text += "\\"; i += 1; continue;
      }
      if (c === "$") { const r = readDollar(); text += r.text; if (r.expansion) expansions.push(r.expansion); continue; }
      if (c === "`") { const r = readBacktick(); text += r.text; if (r.expansion) expansions.push(r.expansion); continue; }
      text += c; i += 1;
    }
    errors.push("unterminated double quote");
    return { text, expansions };
  }

  // Read a $-expansion: $(...), ${...}, or $NAME. i points at '$'.
  function readDollar() {
    if (src[i + 1] === "(") {
      // $( ... )  — could be arithmetic $(( )) too.
      if (src[i + 2] === "(") {
        const inner = readBalanced(i + 2, "(", ")");
        const raw = src.slice(i, inner.end);
        i = inner.end;
        return { text: raw, expansion: { type: "arithmetic", raw, body: inner.body } };
      }
      const inner = readBalanced(i + 1, "(", ")");
      const raw = src.slice(i, inner.end);
      i = inner.end;
      return { text: raw, expansion: { type: "command_sub", raw, command: inner.body.trim() } };
    }
    if (src[i + 1] === "{") {
      const close = findMatching(i + 1, "{", "}");
      if (close === -1) { errors.push("unterminated ${"); const raw = src.slice(i); i = n; return { text: raw, expansion: { type: "param", raw, name: "" } }; }
      const raw = src.slice(i, close + 1);
      const body = src.slice(i + 2, close);
      i = close + 1;
      const name = (body.match(/^[#!]?([A-Za-z_][A-Za-z0-9_]*)/) || [])[1] || body;
      return { text: raw, expansion: { type: "param", raw, name } };
    }
    // $NAME or $1 or special $? $$ $# $@ $*
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$#@*!-])/.exec(src.slice(i));
    if (m) { const raw = m[0]; i += raw.length; return { text: raw, expansion: { type: "param", raw, name: m[1] } }; }
    // lone $
    i += 1;
    return { text: "$", expansion: null };
  }

  // Read a backtick command substitution. i points at '`'.
  function readBacktick() {
    const close = src.indexOf("`", i + 1);
    if (close === -1) { errors.push("unterminated backtick"); const raw = src.slice(i); i = n; return { text: raw, expansion: { type: "command_sub", raw, command: raw.slice(1) } }; }
    const raw = src.slice(i, close + 1);
    const command = src.slice(i + 1, close).replace(/\\`/g, "`").trim();
    i = close + 1;
    return { text: raw, expansion: { type: "command_sub", raw, command } };
  }

  // Read a balanced region starting at `open` char, returns {body, end} where end is index after close.
  function readBalanced(start, openCh, closeCh) {
    // start points at the opening char
    let depth = 0;
    let j = start;
    for (; j < n; j++) {
      const c = src[j];
      if (c === "'") { const e = src.indexOf("'", j + 1); j = e === -1 ? n : e; continue; }
      if (c === '"') { j = skipDouble(j); continue; }
      if (c === openCh) depth++;
      else if (c === closeCh) { depth--; if (depth === 0) { return { body: src.slice(start + 1, j), end: j + 1 }; } }
    }
    errors.push("unterminated " + openCh + closeCh + " expansion");
    return { body: src.slice(start + 1), end: n };
  }

  function skipDouble(j) {
    j += 1;
    while (j < n) { if (src[j] === "\\") { j += 2; continue; } if (src[j] === '"') return j + 1; j += 1; }
    return n;
  }

  // Find matching close for ${ ... } honoring nested braces and quotes.
  function findMatching(start, openCh, closeCh) {
    let depth = 0;
    for (let j = start; j < n; j++) {
      const c = src[j];
      if (c === "'") { const e = src.indexOf("'", j + 1); j = e === -1 ? n : e; continue; }
      if (c === '"') { j = skipDouble(j) - 1; continue; }
      if (c === openCh) depth++;
      else if (c === closeCh) { depth--; if (depth === 0) return j; }
    }
    return -1;
  }

  // Resolve collected heredocs: read body lines from after the current newline.
  function resolveHeredocs(afterNewline) {
    let pos = afterNewline;
    for (const hd of pendingHeredocs) {
      const bodyLines = [];
      let found = false;
      while (pos < n) {
        const eol = src.indexOf("\n", pos);
        const line = eol === -1 ? src.slice(pos) : src.slice(pos, eol);
        const cmp = hd.strip ? line.replace(/^\t+/, "") : line;
        if (cmp === hd.delim) { pos = eol === -1 ? n : eol + 1; hd.token.heredoc = { delim: hd.delim, body: bodyLines.join("\n") }; found = true; break; }
        bodyLines.push(hd.strip ? line.replace(/^\t+/, "") : line);
        if (eol === -1) { pos = n; break; }
        pos = eol + 1;
      }
      if (!found) {
        hd.token.heredoc = { delim: hd.delim, body: bodyLines.join("\n"), unterminated: true };
        errors.push("unterminated heredoc <<" + hd.delim);
      }
    }
    pendingHeredocs = [];
    return pos;
  }

  while (i < n) {
    const c = src[i];
    if (isBlank(c)) { i += 1; continue; }
    if (c === "\n") {
      i += 1;
      if (pendingHeredocs.length) { i = resolveHeredocs(i); }
      tokens.push({ type: "newline", value: "\n" });
      continue;
    }
    if (c === "#" && (tokens.length === 0 || tokens[tokens.length - 1].type !== "word")) {
      // comment to end of line
      const eol = src.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      continue;
    }

    // fd-duplication combos first, so `2>&1` is never split into `2>&` + `1`.
    if (src.startsWith("2>&1", i)) { tokens.push({ type: "op", value: "2>&1" }); i += 4; continue; }
    if (src.startsWith("1>&2", i)) { tokens.push({ type: "op", value: "1>&2" }); i += 4; continue; }

    // fd-prefixed redirection like 2>, 1>>, 3<  (value carries the fd prefix so the
    // op string is self-describing, e.g. "2>>"; fd is also exposed separately).
    const fdRedir = /^(\d+)(>>|>&|>\||>|<&|<)(?!&?\d)/.exec(src.slice(i));
    if (fdRedir) {
      tokens.push({ type: "op", value: fdRedir[1] + fdRedir[2], fd: Number(fdRedir[1]) });
      i += fdRedir[0].length;
      continue;
    }

    const op = readOperator();
    if (op) {
      tokens.push({ type: "op", value: op });
      i += op.length;
      if (op === "<<" || op === "<<-") {
        // next word is the delimiter
        while (i < n && isBlank(src[i])) i += 1;
        const delimWord = readWord();
        // heredoc delimiter may be quoted (disables expansion) — we track plain delim
        const delim = delimWord.text;
        const hdToken = { type: "heredoc_delim", delim, quoted: delimWord.quoted };
        tokens.push(hdToken);
        pendingHeredocs.push({ delim, strip: op === "<<-", token: hdToken });
      }
      continue;
    }

    // otherwise a word
    const w = readWord();
    if (w.raw === "") { i += 1; continue; } // safety against zero-width
    tokens.push(Object.assign({ type: "word" }, w));
  }
  // Resolve any heredocs that never saw a newline (whole-string heredoc)
  if (pendingHeredocs.length) resolveHeredocs(n);

  return { tokens, errors };
}

// -------------------------------- Parser --------------------------------

/**
 * Parse a command line into an AST.
 * @param {string} input
 * @returns {{type:"script", list:object, errors:string[], tokens:Array}}
 */
function parse(input) {
  const { tokens, errors } = tokenize(input);
  const state = { tokens, pos: 0, errors };

  const list = parseList(state, ["__EOF__"]);
  return { type: "script", list, errors: state.errors, tokens };
}

function peek(st) { return st.tokens[st.pos]; }
function next(st) { return st.tokens[st.pos++]; }
function atEnd(st) { return st.pos >= st.tokens.length; }
function skipNewlines(st) { while (!atEnd(st) && peek(st).type === "newline") st.pos++; }

function isOp(tok, ...vals) { return tok && tok.type === "op" && vals.includes(tok.value); }

function parseList(st, stopVals) {
  const parts = [];
  skipNewlines(st);
  while (!atEnd(st)) {
    const tok = peek(st);
    if (tok.type === "op" && stopVals.includes(tok.value)) break;
    const andOr = parseAndOr(st, stopVals);
    if (!andOr) break;
    let sep = null;
    const t = peek(st);
    if (isOp(t, ";", "&")) { sep = t.value; next(st); }
    else if (t && t.type === "newline") { sep = "\n"; }
    parts.push({ andOr, separator: sep });
    skipNewlines(st);
    const after = peek(st);
    if (after && after.type === "op" && stopVals.includes(after.value)) break;
  }
  return { type: "list", parts };
}

function parseAndOr(st, stopVals) {
  const pipelines = [];
  let conn = null;
  while (true) {
    const pipe = parsePipeline(st, stopVals);
    if (!pipe) break;
    pipelines.push({ pipeline: pipe, connector: conn });
    const t = peek(st);
    if (isOp(t, "&&", "||")) { conn = t.value; next(st); skipNewlines(st); continue; }
    break;
  }
  if (!pipelines.length) return null;
  return { type: "and_or", pipelines };
}

function parsePipeline(st, stopVals) {
  let negated = false;
  const t0 = peek(st);
  if (t0 && t0.type === "word" && t0.text === "!" ) { negated = true; next(st); }
  const commands = [];
  while (true) {
    const cmd = parseCommand(st, stopVals);
    if (!cmd) break;
    commands.push(cmd);
    const t = peek(st);
    if (isOp(t, "|", "|&")) { const pipeOp = t.value; next(st); skipNewlines(st); commands[commands.length - 1]._pipeOut = pipeOp; continue; }
    break;
  }
  if (!commands.length) return null;
  return { type: "pipeline", negated, commands };
}

function parseCommand(st, stopVals) {
  skipNewlines(st);
  const tok = peek(st);
  if (!tok) return null;
  if (tok.type === "op" && stopVals.includes(tok.value)) return null;
  if (isOp(tok, "(")) {
    next(st);
    const inner = parseList(st, [")"]);
    if (isOp(peek(st), ")")) next(st); else st.errors.push("missing ) for subshell");
    const redirs = parseRedirs(st);
    return { type: "subshell", list: inner, redirs };
  }
  if (tok.type === "word" && tok.text === "{") {
    next(st);
    const inner = parseList(st, []);
    // consume closing } word
    const close = peek(st);
    if (close && close.type === "word" && close.text === "}") next(st); else st.errors.push("missing } for group");
    const redirs = parseRedirs(st);
    return { type: "group", list: inner, redirs };
  }
  return parseSimple(st, stopVals);
}

function parseRedirs(st) {
  const redirs = [];
  while (true) {
    const r = tryRedir(st);
    if (!r) break;
    redirs.push(r);
  }
  return redirs;
}

// A redirection operator is an optional fd prefix followed by a redirection symbol.
const REDIR_RE = /^(\d*)(>>|>\||>&|&>>|&>|<<<|<&|<|>)$/;

function tryRedir(st) {
  const t = peek(st);
  if (!t || t.type !== "op") return null;
  // Duplicating fd forms (2>&1) carry their target in the operator itself.
  if (t.value === "2>&1" || t.value === "1>&2") {
    next(st);
    return { op: t.value, fd: t.value === "2>&1" ? 2 : 1, dupTo: t.value === "2>&1" ? 1 : 2, target: null };
  }
  const m = REDIR_RE.exec(t.value);
  if (!m) return null;
  next(st);
  const op = t.value;
  const bare = m[2];
  const fd = t.fd != null ? t.fd : (m[1] !== "" ? Number(m[1]) : defaultFd(bare));
  // target word
  const w = peek(st);
  let target = null;
  if (w && w.type === "word") { target = { text: w.text, quoted: w.quoted, glob: w.glob, raw: w.raw }; next(st); }
  else st.errors.push("redirection '" + op + "' missing target");
  return { op, fd, target };
}

function defaultFd(bare) {
  if (bare === "<" || bare === "<&" || bare === "<<<") return 0;
  return 1;
}

function parseSimple(st, stopVals) {
  const assignments = [];
  const words = [];
  const redirs = [];
  let sawWord = false;
  let heredoc = null;

  while (!atEnd(st)) {
    const tok = peek(st);
    if (tok.type === "newline") break;
    if (tok.type === "op") {
      if (stopVals.includes(tok.value)) break;
      if (["|", "|&", "&&", "||", ";", "&", ")"].includes(tok.value)) break;
      if (tok.value === "<<" || tok.value === "<<-") {
        next(st);
        const delimTok = peek(st);
        if (delimTok && delimTok.type === "heredoc_delim") { next(st); heredoc = { delim: delimTok.delim, body: delimTok.heredoc ? delimTok.heredoc.body : "", strip: tok.value === "<<-" }; redirs.push({ op: tok.value, fd: 0, heredoc }); }
        continue;
      }
      const r = tryRedir(st);
      if (r) { redirs.push(r); continue; }
      break;
    }
    if (tok.type === "heredoc_delim") { next(st); continue; }
    if (tok.type === "word") {
      // assignment only before the first word
      if (!sawWord && isAssignment(tok.text)) {
        const eq = tok.text.indexOf("=");
        assignments.push({ name: tok.text.slice(0, eq), value: tok.text.slice(eq + 1), raw: tok.raw, quoted: tok.quoted });
        next(st);
        continue;
      }
      // closing brace of a group terminates
      if (tok.text === "}" && !sawWord) break;
      sawWord = true;
      words.push(tok);
      next(st);
      continue;
    }
    break;
  }

  if (!words.length && !assignments.length && !redirs.length) return null;
  return { type: "command", assignments, words, redirs };
}

function isAssignment(text) { return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text); }

module.exports = {
  tokenize,
  parse,
  OPERATORS,
  isAssignment,
};
