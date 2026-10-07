"use strict";
// ===================== Test Intelligence — Runner Output Parsers =====================
// Robustly turn each supported runner's output into the unified model (./model.js).
// Every parser is defensive: malformed/partial output yields a best-effort Result
// rather than throwing, and anything we genuinely can't read is surfaced as
// errored:true with the raw text kept in meta — never a silent "0 failures".
//
//   parseTap(text)        node:test (TAP v13) and any TAP-13 producer
//   parseJestJson(text)   jest --json
//   parseMocha(text)      mocha --reporter json
//   parsePytest(text)     pytest default/-v text output
//   parseGoTest(text)     go test -json (NDJSON) with a plain-text fallback
//   parse(runner, out)    dispatch by runner id
const model = require("./model");

// ---------------------------------------------------------------------------
// TAP 13 (node:test default reporter). We parse `ok`/`not ok` lines, the indented
// YAML diagnostic block that follows (duration_ms, error, stack, expected/actual,
// failureType, location), and the `# tests/# pass/# fail/...` summary footer.
// ---------------------------------------------------------------------------
function parseTap(text) {
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  const tests = [];
  const summary = {};
  let i = 0;
  const reResult = /^(\s*)(ok|not ok)\s+(\d+)\s*(?:-\s*)?(.*)$/;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(reResult);
    if (!m) {
      const sm = line.match(/^#\s+(tests|pass|fail|skipped|todo|cancelled|duration_ms|suites)\s+([\d.]+)\s*$/);
      if (sm) summary[sm[1]] = Number(sm[2]);
      i++;
      continue;
    }
    const indent = m[1].length;
    let desc = m[4].trim();
    let status = m[2] === "ok" ? model.STATUS.PASS : model.STATUS.FAIL;
    // Directives: "# SKIP ...", "# TODO ...", trailing on the result line.
    let directive = null;
    const dm = desc.match(/\s+#\s*(SKIP|TODO)\b\s*(.*)$/i);
    if (dm) {
      directive = dm[1].toUpperCase();
      desc = desc.slice(0, dm.index).trim();
      if (directive === "SKIP") status = model.STATUS.SKIP;
      else if (directive === "TODO") status = model.STATUS.TODO;
    }
    // Collect the YAML diagnostic block (lines indented deeper, between --- and ...).
    const yaml = [];
    let j = i + 1;
    if ((lines[j] || "").trim() === "---") {
      j++;
      while (j < lines.length && (lines[j] || "").trim() !== "...") { yaml.push(lines[j]); j++; }
      if (j < lines.length) j++; // consume the closing ...
    }
    const diag = parseTapYaml(yaml, indent);
    const test = {
      name: desc,
      fullName: desc,
      status,
      durationMs: diag.duration_ms != null ? Number(diag.duration_ms) : 0,
      file: diag.file || (diag.location ? diag.location.replace(/:\d+:\d+$/, "") : null),
    };
    if (status === model.STATUS.FAIL) {
      test.failure = {
        message: diag.error || (diag.stack ? diag.stack.split("\n")[0] : ("failed: " + desc)),
        type: diag.name || diag.failureType || null,
        stack: diag.stack || null,
        expected: diag.expected,
        actual: diag.actual,
        operator: diag.operator || null,
        location: diag.location || null,
      };
    }
    tests.push(test);
    i = j;
  }
  // Subtest names in node:test TAP are the leaf description; top-level summary gives totals.
  const result = model.makeResult({ runner: "node:test", tests });
  // Trust the TAP footer for the fail signal if present (covers bail-out before a plan).
  if (summary.fail != null && summary.fail > 0) result.ok = false;
  result.meta = { tap: summary };
  if (!tests.length && !Object.keys(summary).length) {
    result.errored = true; result.ok = false; result.meta.raw = truncate(text);
  }
  return result;
}

// Parse the indented TAP YAML diagnostic into a flat object. Values may be scalars,
// quoted strings, or block scalars (`stack: |-`). Deliberately small, not a full YAML.
function parseTapYaml(yamlLines, baseIndent) {
  const out = {};
  let key = null, block = null, blockIndent = 0;
  for (const raw of yamlLines) {
    const line = raw.replace(/\t/g, "  ");
    if (block != null) {
      const curIndent = line.length - line.trimStart().length;
      if (line.trim() === "" || curIndent >= blockIndent) { block.push(line.slice(blockIndent)); continue; }
      out[key] = block.join("\n").replace(/\n+$/, ""); block = null; key = null;
    }
    const m = line.match(/^(\s*)([A-Za-z_][\w]*):\s?(.*)$/);
    if (!m) continue;
    key = m[2];
    const val = m[3];
    if (val === "|-" || val === "|" || val === ">-" || val === ">") {
      block = []; blockIndent = (line.length - line.trimStart().length) + 2;
    } else {
      out[key] = coerceScalar(val);
      key = null;
    }
  }
  if (block != null && key != null) out[key] = block.join("\n").replace(/\n+$/, "");
  return out;
}

function coerceScalar(v) {
  let s = String(v).trim();
  if (s === "") return "";
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

// ---------------------------------------------------------------------------
// jest --json
// ---------------------------------------------------------------------------
function parseJestJson(text) {
  const data = safeJson(text);
  if (!data) return erroredResult("jest", text);
  const tests = [];
  for (const fileRes of (data.testResults || [])) {
    const file = fileRes.name || fileRes.testFilePath || null;
    for (const a of (fileRes.assertionResults || [])) {
      const status = model.normStatus(a.status);
      const full = (a.ancestorTitles && a.ancestorTitles.length)
        ? a.ancestorTitles.join(" > ") + " > " + a.title : (a.fullName || a.title);
      const t = { name: a.title, fullName: full, file, status, durationMs: Number(a.duration) || 0 };
      if (status === model.STATUS.FAIL) {
        const msg = (a.failureMessages && a.failureMessages[0]) || "assertion failed";
        t.failure = { message: firstMeaningfulLine(msg), stack: msg, type: "AssertionError" };
      }
      tests.push(t);
    }
  }
  const result = model.makeResult({
    runner: "jest", tests,
    durationMs: data.startTime && data.endTime ? data.endTime - data.startTime : undefined,
  });
  if (data.success === false) result.ok = false;
  result.meta = { numTotalTests: data.numTotalTests, numPassedTests: data.numPassedTests, numFailedTests: data.numFailedTests };
  return result;
}

// ---------------------------------------------------------------------------
// mocha --reporter json
// ---------------------------------------------------------------------------
function parseMocha(text) {
  const data = safeJson(text);
  if (!data) return erroredResult("mocha", text);
  const failSet = new Map();
  for (const f of (data.failures || [])) failSet.set(f.fullTitle || f.title, f);
  const pendingSet = new Set((data.pending || []).map((p) => p.fullTitle || p.title));
  const tests = [];
  const source = (data.tests && data.tests.length) ? data.tests : [].concat(data.passes || [], data.failures || [], data.pending || []);
  for (const t of source) {
    const key = t.fullTitle || t.title;
    let status = model.STATUS.PASS;
    if (failSet.has(key) || (t.err && Object.keys(t.err).length)) status = model.STATUS.FAIL;
    else if (pendingSet.has(key)) status = model.STATUS.SKIP;
    const rec = { name: t.title, fullName: t.fullTitle || t.title, file: t.file || null, status, durationMs: Number(t.duration) || 0 };
    if (status === model.STATUS.FAIL) {
      // Merge the err from the failures[] list and the per-test entry; whichever carries
      // expected/actual/stack wins (mocha versions vary in which one is fully populated).
      const err = Object.assign({}, (failSet.get(key) || {}).err, t.err);
      rec.failure = { message: err.message || "test failed", stack: err.stack || null, expected: err.expected, actual: err.actual, operator: err.operator || null };
    }
    tests.push(rec);
  }
  const result = model.makeResult({ runner: "mocha", tests, durationMs: data.stats && data.stats.duration });
  result.meta = data.stats || {};
  return result;
}

// ---------------------------------------------------------------------------
// pytest — default and -v text output. We parse per-test lines where available
// (-v: "path::test NAME STATUS [ 50%]"; default: a dotted progress line + the
// "short test summary info" block), and always reconcile with the summary footer
// "=== N passed, M failed, K skipped in 1.23s ===".
// ---------------------------------------------------------------------------
function parsePytest(text) {
  const src = String(text == null ? "" : text);
  const lines = src.split(/\r?\n/);
  const byName = new Map();
  const put = (name, status, file, dur) => {
    const prev = byName.get(name);
    if (prev && prev.status === model.STATUS.FAIL) return; // never downgrade a known failure
    byName.set(name, { name, fullName: name, file: file || (name.includes("::") ? name.split("::")[0] : null), status, durationMs: dur || 0 });
  };
  // -v style lines.
  const reV = /^(\S+?::\S+?)\s+(PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\b/;
  for (const line of lines) {
    const m = line.match(reV);
    if (m) put(m[1], pyStatus(m[2]), m[1].split("::")[0]);
  }
  // short test summary info — captures failures/errors/skips even in non-verbose runs.
  let inSummary = false;
  const reSummary = /^(FAILED|ERROR|PASSED|SKIPPED|XFAIL|XPASS)\s+(\S+?)(?:\s+-\s+(.*))?$/;
  const failMsgs = new Map();
  for (const line of lines) {
    if (/short test summary info/.test(line)) { inSummary = true; continue; }
    if (inSummary) {
      if (/^={3,}/.test(line)) { inSummary = false; continue; }
      const m = line.match(reSummary);
      if (m) { put(m[2], pyStatus(m[1]), m[2].split("::")[0]); if (m[3]) failMsgs.set(m[2], m[3].trim()); }
    }
  }
  // Attach failure detail from the FAILURES sections ("___ test_name ___" ... "E   AssertionError").
  attachPytestFailures(src, byName, failMsgs);
  const tests = [...byName.values()];
  // Reconcile with the footer so counts are right even if we missed per-test lines.
  const footer = parsePytestFooter(src);
  const result = model.makeResult({ runner: "pytest", tests });
  if (footer) {
    result.meta = { footer, capturedTests: tests.length };
    // pytest's non-verbose output names only failing tests, so the per-test array can be
    // a subset of reality. Trust the footer for the authoritative counts while keeping the
    // (named) tests we did capture for triage/selection.
    const fc = reconcileCounts(footer);
    if (fc.total >= result.counts.total) result.counts = fc;
    if (footer.failed > 0 || footer.error > 0) result.ok = false;
    if (footer.durationSec != null) result.durationMs = Math.round(footer.durationSec * 1000);
  } else if (!tests.length) {
    result.errored = true; result.ok = false; result.meta = { raw: truncate(src) };
  }
  return result;
}

function pyStatus(s) {
  s = s.toUpperCase();
  if (s === "PASSED" || s === "XPASS") return model.STATUS.PASS;
  if (s === "FAILED" || s === "ERROR") return model.STATUS.FAIL;
  if (s === "SKIPPED" || s === "XFAIL") return model.STATUS.SKIP;
  return model.STATUS.FAIL;
}

function attachPytestFailures(src, byName, failMsgs) {
  // Each failure block: a header line of underscores with the test id, then lines,
  // with assertion detail prefixed "E   ". We grab the first E-line as the message.
  // Headers carry the short test name ("test_sub") while per-test entries are keyed by
  // the full id ("file.py::test_sub"), so resolve the header to an existing key.
  const lines = src.split(/\r?\n/);
  // First, attach any summary-line messages to their full-id entries.
  for (const [key, msg] of failMsgs) {
    const e = byName.get(key);
    if (e && e.status === model.STATUS.FAIL && !e.failure) e.failure = { message: msg, type: "pytest" };
  }
  const resolveKey = (short) => {
    if (byName.has(short)) return short;
    for (const k of byName.keys()) { if (k === short || k.split("::").pop() === short || k.endsWith("::" + short)) return k; }
    return short;
  };
  let cur = null, eLine = null, locLine = null;
  const flush = () => {
    if (cur) {
      const key = resolveKey(cur);
      const existing = byName.get(key);
      const message = (existing && existing.failure && existing.failure.message) || failMsgs.get(key) || eLine || "test failed";
      if (existing) {
        existing.status = model.STATUS.FAIL;
        existing.failure = { message, stack: eLine, location: locLine, type: "pytest" };
      } else {
        byName.set(key, { name: key, fullName: key, file: key.split("::")[0], status: model.STATUS.FAIL, durationMs: 0, failure: { message, stack: eLine, location: locLine, type: "pytest" } });
      }
    }
    cur = null; eLine = null; locLine = null;
  };
  for (const line of lines) {
    const h = line.match(/^_{3,}\s+(\S.*?\S)\s+_{3,}$/);
    if (h) { flush(); cur = h[1].replace(/\s+/g, ""); continue; }
    if (cur) {
      if (eLine == null) { const e = line.match(/^E\s+(.*)$/); if (e) eLine = e[1].trim(); }
      const loc = line.match(/^(\S+\.py):(\d+):/);
      if (loc && !locLine) locLine = loc[1] + ":" + loc[2];
    }
  }
  flush();
}

function parsePytestFooter(src) {
  // Last "=== ... in 0.12s ===" line wins.
  const re = /=+\s*(.*?)\s+in\s+([\d.]+)s(?:\s+\([^)]*\))?\s*=+/g;
  let m, last = null;
  while ((m = re.exec(src))) last = m;
  if (!last) return null;
  const body = last[1];
  const out = { passed: 0, failed: 0, skipped: 0, error: 0, xfailed: 0, xpassed: 0, durationSec: Number(last[2]) };
  const partRe = /(\d+)\s+(passed|failed|skipped|error|errors|xfailed|xpassed|deselected|warning|warnings)/g;
  let p;
  while ((p = partRe.exec(body))) {
    const n = Number(p[1]); const key = p[2].replace(/s$/, "");
    if (key === "error") out.error += n; else if (out[key] != null) out[key] += n;
  }
  return out;
}

function reconcileCounts(footer) {
  const pass = footer.passed + footer.xpassed;
  const fail = footer.failed + footer.error;
  const skip = footer.skipped + footer.xfailed;
  return { total: pass + fail + skip, pass, fail, skip, todo: 0 };
}

// ---------------------------------------------------------------------------
// go test -json (NDJSON). Events carry Action (run/pass/fail/skip/output) and,
// for test-level events, a Test name and Elapsed seconds. Output lines are
// accumulated per test to recover failure detail. Package-level events (no Test)
// are used only for the errored signal.
// ---------------------------------------------------------------------------
function parseGoTest(text) {
  const src = String(text == null ? "" : text);
  const lines = src.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return erroredResult("go test", src);
  let anyJson = false;
  const map = new Map(); // pkg::test -> rec
  let pkgFail = false, buildFail = false;
  for (const line of lines) {
    const ev = safeJson(line);
    if (!ev || !ev.Action) {
      if (/^(FAIL|ok|---)\b/.test(line) && !anyJson) pkgFail = pkgFail || /^FAIL/.test(line);
      if (/build failed|cannot find package|undefined:/.test(line)) buildFail = true;
      continue;
    }
    anyJson = true;
    if (!ev.Test) {
      if (ev.Action === "fail") pkgFail = true;
      continue;
    }
    const key = (ev.Package || "") + "::" + ev.Test;
    let rec = map.get(key);
    if (!rec) { rec = { name: ev.Test, fullName: (ev.Package ? ev.Package + "." : "") + ev.Test, file: ev.Package || null, status: model.STATUS.PASS, durationMs: 0, output: [] }; map.set(key, rec); }
    if (ev.Action === "output" && ev.Output != null) rec.output.push(ev.Output);
    else if (ev.Action === "pass") { rec.status = model.STATUS.PASS; rec.durationMs = (Number(ev.Elapsed) || 0) * 1000; }
    else if (ev.Action === "fail") { rec.status = model.STATUS.FAIL; rec.durationMs = (Number(ev.Elapsed) || 0) * 1000; }
    else if (ev.Action === "skip") { rec.status = model.STATUS.SKIP; rec.durationMs = (Number(ev.Elapsed) || 0) * 1000; }
  }
  const tests = [];
  for (const rec of map.values()) {
    // Only keep leaf results that resolved; subtests appear as "Parent/Child".
    const out = rec.output.join("");
    const t = { name: rec.name, fullName: rec.fullName, file: rec.file, status: rec.status, durationMs: round(rec.durationMs, 3) };
    if (rec.status === model.STATUS.FAIL) {
      t.failure = { message: extractGoFailure(out) || (rec.name + " failed"), stack: out.trim() || null, location: extractGoLocation(out), type: "go test" };
    }
    tests.push(t);
  }
  const result = model.makeResult({ runner: "go test", tests });
  if (pkgFail || buildFail) result.ok = false;
  if (buildFail && !tests.length) { result.errored = true; result.meta = { raw: truncate(src) }; }
  return result;
}

function extractGoFailure(out) {
  // Lines look like "    foo_test.go:12: expected 2, got 3". Return the first such.
  const m = out.match(/^\s*\S+_test\.go:\d+:\s*(.*)$/m);
  if (m) return m[1].trim();
  const panic = out.match(/panic:\s*(.*)$/m);
  if (panic) return "panic: " + panic[1].trim();
  return null;
}
function extractGoLocation(out) {
  const m = out.match(/(\S+_test\.go:\d+):/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
function parse(runner, out) {
  switch (String(runner)) {
    case "node:test": case "node": return parseTap(out);
    case "tap": return parseTap(out);
    case "jest": return parseJestJson(out);
    case "mocha": return parseMocha(out);
    case "pytest": return parsePytest(out);
    case "go test": case "go": return parseGoTest(out);
    default: return erroredResult(String(runner), out);
  }
}

// --- helpers ---
function safeJson(text) { try { return JSON.parse(String(text)); } catch (_) { return null; } }
function erroredResult(runner, raw) { const r = model.emptyResult(runner, { errored: true }); r.ok = false; r.meta = { raw: truncate(raw) }; return r; }
// ANSI SGR color codes, matched without a literal escape in source (repo convention:
// no raw escape sequences outside the UI theme module). ESC is char code 27.
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
function stripAnsi(s) { return String(s == null ? "" : s).replace(ANSI_RE, ""); }
function firstMeaningfulLine(s) {
  for (const line of String(s).split("\n")) { const t = stripAnsi(line).trim(); if (t && !/^at\s/.test(t)) return t; }
  return String(s).split("\n")[0] || "";
}
function truncate(s) { s = String(s == null ? "" : s); return s.length > 4000 ? s.slice(0, 4000) + "\n…[truncated]" : s; }
function round(n, d) { const p = Math.pow(10, d == null ? 2 : d); return Math.round((Number(n) || 0) * p) / p; }

module.exports = { parseTap, parseJestJson, parseMocha, parsePytest, parseGoTest, parse, parseTapYaml, parsePytestFooter };
