"use strict";
// ===================== Test Intelligence — Coverage Mapping =====================
// Parse the coverage formats the agent will actually encounter into one per-file,
// per-line model, then answer the question that matters during a change: "which of
// the lines I just touched are NOT covered by any test?". That's the signal that tells
// the agent where to add a test before claiming a change is done.
//
//   parseLcov(text)             lcov.info (node --test-reporter=lcov, c8, nyc, coverage.py --lcov)
//   parseNodeTable(text)        node --experimental-test-coverage text report
//   parseCoveragePyReport(text) `coverage report -m` text (Missing column)
//   parse(text)                 auto-detect format
//   uncoveredChangedLines(cov, changedLinesByFile) -> uncovered lines within the change
//
// Unified model (per file):
//   { lines: Map<lineNo, hits>, uncovered: Set<lineNo>, lineRate, fnRate, branchRate,
//     summary: { lines:{total,covered}, functions:{...}, branches:{...} } }
// A top-level object maps normalized file path -> that record, plus a `totals` roll-up.

function norm(p) { return String(p || "").replace(/\\/g, "/").replace(/^\.\//, ""); }

function emptyFile() {
  return {
    lines: new Map(), uncovered: new Set(),
    lineRate: null, fnRate: null, branchRate: null,
    summary: { lines: { total: 0, covered: 0 }, functions: { total: 0, covered: 0 }, branches: { total: 0, covered: 0 } },
  };
}

// ---------------------------------------------------------------------------
// LCOV. Records are delimited by end_of_record. Keys we read:
//   SF:<file>  FN:<line>,<name>  FNDA:<hits>,<name>  DA:<line>,<hits>
//   LF/LH (line found/hit), FNF/FNH, BRF/BRH, BRDA:<line>,<block>,<branch>,<taken>
// ---------------------------------------------------------------------------
function parseLcov(text) {
  const files = {};
  let cur = null, curName = null;
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith("SF:")) { curName = norm(s.slice(3)); cur = files[curName] || (files[curName] = emptyFile()); continue; }
    if (!cur) continue;
    if (s.startsWith("DA:")) {
      const [ln, hits] = s.slice(3).split(",");
      const n = Number(ln), h = Number(hits);
      if (Number.isFinite(n)) { cur.lines.set(n, (cur.lines.get(n) || 0) + (Number.isFinite(h) ? h : 0)); }
    } else if (s.startsWith("LF:")) cur.summary.lines.total = Number(s.slice(3)) || cur.summary.lines.total;
    else if (s.startsWith("LH:")) cur.summary.lines.covered = Number(s.slice(3)) || cur.summary.lines.covered;
    else if (s.startsWith("FNF:")) cur.summary.functions.total = Number(s.slice(4)) || cur.summary.functions.total;
    else if (s.startsWith("FNH:")) cur.summary.functions.covered = Number(s.slice(4)) || cur.summary.functions.covered;
    else if (s.startsWith("BRF:")) cur.summary.branches.total = Number(s.slice(4)) || cur.summary.branches.total;
    else if (s.startsWith("BRH:")) cur.summary.branches.covered = Number(s.slice(4)) || cur.summary.branches.covered;
    else if (s === "end_of_record") { cur = null; curName = null; }
  }
  for (const name of Object.keys(files)) finalizeFile(files[name]);
  return wrap(files, "lcov");
}

// ---------------------------------------------------------------------------
// Node's --experimental-test-coverage text table. Each data row:
//   # <file> | <line %> | <branch %> | <funcs %> | <uncovered lines>
// The uncovered-lines column is a comma list of single lines and "a-b" ranges.
// ---------------------------------------------------------------------------
function parseNodeTable(text) {
  const files = {};
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  let inside = false;
  for (const raw of lines) {
    const line = raw.replace(/^#\s?/, "");
    if (/start of coverage report/.test(raw)) { inside = true; continue; }
    if (/end of coverage report/.test(raw)) { inside = false; continue; }
    if (!inside) continue;
    if (/^-+$/.test(line.trim()) || /^-{3,}/.test(line)) continue;
    if (/^\s*file\s*\|\s*line/i.test(line)) continue; // header
    const cols = line.split("|").map((c) => c.trim());
    if (cols.length < 4) continue;
    const name = cols[0];
    if (!name || name === "all files") continue;
    const rec = files[norm(name)] = emptyFile();
    rec.lineRate = pct(cols[1]);
    rec.branchRate = pct(cols[2]);
    rec.fnRate = pct(cols[3]);
    const uncoveredCol = cols[4] || "";
    for (const n of expandRanges(uncoveredCol)) rec.uncovered.add(n);
  }
  return wrap(files, "node-table");
}

// ---------------------------------------------------------------------------
// coverage.py `coverage report -m`. Rows:
//   <Name>  <Stmts>  <Miss>  <Cover%>  <Missing>
// Missing is a comma list of lines/ranges that were not executed.
// ---------------------------------------------------------------------------
function parseCoveragePyReport(text) {
  const files = {};
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (const line of lines) {
    if (/^-+$/.test(line.trim()) || /^Name\s+Stmts/.test(line) || /^TOTAL\b/.test(line)) continue;
    // Name may contain spaces rarely; match from the right for the 4 numeric-ish cols.
    const m = line.match(/^(.+?\.py)\s+(\d+)\s+(\d+)\s+(\d+)%\s*(.*)$/);
    if (!m) continue;
    const rec = files[norm(m[1])] = emptyFile();
    const stmts = Number(m[2]), miss = Number(m[3]);
    rec.summary.lines.total = stmts;
    rec.summary.lines.covered = stmts - miss;
    rec.lineRate = Number(m[4]) / 100;
    for (const n of expandRanges(m[5] || "")) rec.uncovered.add(n);
  }
  return wrap(files, "coverage.py");
}

// parse(text) — sniff the format and dispatch.
function parse(text) {
  const s = String(text == null ? "" : text);
  if (/(^|\n)SF:/.test(s) && /end_of_record/.test(s)) return parseLcov(s);
  if (/start of coverage report/.test(s)) return parseNodeTable(s);
  if (/\bStmts\b.*\bMiss\b.*\bCover\b/.test(s) || /\bMissing\b/.test(s)) return parseCoveragePyReport(s);
  // last resort: try lcov then node table
  if (/DA:\d+,/.test(s)) return parseLcov(s);
  return wrap({}, "unknown");
}

// uncoveredChangedLines(cov, changedLinesByFile)
//   changedLinesByFile: { "src/x.js": [12,13,14] } (added/modified line numbers)
//   -> { "src/x.js": [12,14], ... } limited to files we have coverage for.
// A changed line is "uncovered" if the file's model has it in `uncovered`, or has a
// hits entry of 0 for it. Changed lines with no coverage datum at all are reported
// separately under `.unknown` so callers don't mistake "not measured" for "covered".
function uncoveredChangedLines(cov, changedLinesByFile) {
  const out = {}; const unknown = {};
  for (const file of Object.keys(changedLinesByFile || {})) {
    const rec = (cov.files && cov.files[norm(file)]) || null;
    const changed = changedLinesByFile[file] || [];
    if (!rec) { unknown[norm(file)] = changed.slice(); continue; }
    const miss = [], unk = [];
    for (const ln of changed) {
      if (rec.uncovered.has(ln)) miss.push(ln);
      else if (rec.lines.has(ln)) { if (rec.lines.get(ln) === 0) miss.push(ln); }
      else unk.push(ln); // no per-line datum for this line (comment/blank/not instrumented)
    }
    if (miss.length) out[norm(file)] = miss.sort((a, b) => a - b);
    if (unk.length) unknown[norm(file)] = unk.sort((a, b) => a - b);
  }
  return { uncovered: out, unknown };
}

// --- helpers ---
function finalizeFile(rec) {
  // Derive uncovered line set from DA hits=0 entries if present.
  for (const [ln, hits] of rec.lines) if (hits === 0) rec.uncovered.add(ln);
  const total = rec.summary.lines.total || rec.lines.size;
  const covered = rec.summary.lines.covered || [...rec.lines.values()].filter((h) => h > 0).length;
  if (total) rec.lineRate = round(covered / total, 4);
  if (rec.summary.functions.total) rec.fnRate = round(rec.summary.functions.covered / rec.summary.functions.total, 4);
  if (rec.summary.branches.total) rec.branchRate = round(rec.summary.branches.covered / rec.summary.branches.total, 4);
}

function wrap(files, format) {
  const totals = { lines: { total: 0, covered: 0 }, files: Object.keys(files).length };
  for (const name of Object.keys(files)) {
    const r = files[name];
    totals.lines.total += r.summary.lines.total || r.lines.size;
    totals.lines.covered += r.summary.lines.covered || [...r.lines.values()].filter((h) => h > 0).length;
  }
  totals.lineRate = totals.lines.total ? round(totals.lines.covered / totals.lines.total, 4) : null;
  return { format, files, totals };
}

function expandRanges(s) {
  const out = [];
  for (const part of String(s || "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { const a = Number(m[1]), b = Number(m[2]); for (let i = a; i <= b; i++) out.push(i); }
    else { const n = Number(p.replace(/[^\d]/g, "")); if (Number.isFinite(n) && n > 0) out.push(n); }
  }
  return out;
}

function pct(s) { const n = Number(String(s).replace("%", "").trim()); return Number.isFinite(n) ? round(n / 100, 4) : null; }
function round(n, d) { const p = Math.pow(10, d == null ? 2 : d); return Math.round((Number(n) || 0) * p) / p; }

module.exports = { parseLcov, parseNodeTable, parseCoveragePyReport, parse, uncoveredChangedLines, expandRanges };
