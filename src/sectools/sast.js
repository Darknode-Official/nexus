"use strict";
// ================= sectools/sast — SAST-lite static analysis engine =================
// A lightweight, regex-driven static analyzer for JavaScript/TypeScript, Python and
// shell. It is NOT a full parser; it is a precision-tuned line scanner over the
// data-driven ruleset in ./sast-rules.js. The design goal is high signal: every
// rule is tuned with excludes and language gating to keep false positives low, and
// the engine strips comments so documentation examples are not flagged.
//
// Detection limits are documented honestly in README.md — this engine will miss
// data-flow / taint across functions and files, and multi-line constructs.

const { walk, readText } = require("./walk");
const { RULES } = require("./sast-rules");
const secrets = require("./secrets");

// Map file extensions to language ids used by the ruleset.
const LANG_BY_EXT = {
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".ts": "js", ".tsx": "js", ".mts": "js", ".cts": "js",
  ".py": "py", ".pyw": "py",
  ".sh": "sh", ".bash": "sh", ".zsh": "sh", ".ksh": "sh",
};

/**
 * Infer the language id from a file path, or null when unsupported.
 * @param {string} file
 * @returns {string|null}
 */
function languageOf(file) {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  return LANG_BY_EXT[file.slice(dot).toLowerCase()] || null;
}

/**
 * Remove a trailing line comment from a source line so comment text is not
 * scanned. Naive but guarded: `//` is only treated as a comment when it is not
 * part of a URL scheme (http://), and `#` is honoured for py/sh when not clearly
 * inside a quoted string. The code portion is returned unchanged when uncertain.
 * @param {string} line
 * @param {string} lang
 * @returns {string}
 */
function stripComment(line, lang) {
  if (lang === "js") {
    // Find // that is not preceded by ':' (URL) and not inside a simple string.
    let inStr = null;
    for (let i = 0; i < line.length - 1; i++) {
      const c = line[i];
      if (inStr) { if (c === inStr && line[i - 1] !== "\\") inStr = null; continue; }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
      if (c === "/" && line[i + 1] === "/") {
        if (i > 0 && line[i - 1] === ":") continue; // http:// etc.
        return line.slice(0, i);
      }
    }
    return line;
  }
  if (lang === "py" || lang === "sh") {
    let inStr = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inStr) { if (c === inStr && line[i - 1] !== "\\") inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === "#") {
        if (lang === "sh" && i > 0 && /[\w$]/.test(line[i - 1])) continue; // ${x#...}, $#
        return line.slice(0, i);
      }
    }
    return line;
  }
  return line;
}

/**
 * Whether a rule applies to a given language id.
 * @param {object} rule
 * @param {string} lang
 */
function ruleApplies(rule, lang) {
  return rule.langs.includes("*") || rule.langs.includes(lang);
}

/**
 * Run the SAST rules over a block of source text.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.lang] language id override ("js"|"py"|"sh")
 * @param {string} [opts.file="<text>"] label used in findings
 * @param {boolean} [opts.stripComments=true]
 * @param {Array<object>} [opts.rules] rule override (defaults to the bundled set)
 * @returns {Array<object>} findings
 */
function scanText(text, opts) {
  opts = opts || {};
  const file = opts.file || "<text>";
  const lang = opts.lang || languageOf(file);
  if (!lang) return [];
  const rules = (opts.rules || RULES).filter((r) => ruleApplies(r, lang));
  const stripC = opts.stripComments !== false;
  text = String(text == null ? "" : text);
  const lines = text.split(/\r?\n/);
  const findings = [];

  // Track python triple-quote / shell heredoc block state at a coarse level so we
  // do not scan large literal blocks (reduces false positives in docstrings).
  let inPyDoc = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNo = i + 1;
    if (line.length > 4000) continue;

    if (lang === "py") {
      const triples = (line.match(/"""|'''/g) || []).length;
      if (inPyDoc) { if (triples % 2 === 1) inPyDoc = false; continue; }
      if (triples % 2 === 1) { inPyDoc = true; }
      // Blank out inline triple-quoted string bodies so code inside a one-line
      // docstring/string literal is not mistaken for executable code.
      line = line.replace(/"""[\s\S]*?"""/g, '""" """').replace(/'''[\s\S]*?'''/g, "''' '''");
    }

    const code = stripC ? stripComment(line, lang) : line;
    if (!code.trim()) continue;

    for (const rule of rules) {
      // Excludes are contextual suppressions and are tested against the FULL
      // original line (comments included) so hints like "// used for animation"
      // or a nearby safe API still suppress the finding.
      if (rule.exclude && rule.exclude.test(line)) continue;
      const m = rule.pattern.exec(code);
      if (!m) continue;
      findings.push({
        id: rule.id,
        type: "sast",
        lang,
        severity: rule.severity,
        cwe: rule.cwe,
        title: rule.title,
        message: rule.message,
        file,
        line: lineNo,
        column: m.index + 1,
        // Redact any secret in the snippet so a finding never leaks a credential
        // (e.g. a hardcoded-password rule firing on a real token).
        snippet: secrets.redact(line.trim()).text.slice(0, 200),
        confidence: rule.confidence != null ? rule.confidence : 0.6,
        remediation: rule.remediation,
        fixHint: rule.fixHint || null,
      });
    }
  }
  return findings;
}

/**
 * Scan every supported source file under a directory (or a single file).
 * @param {string} root
 * @param {object} [opts] forwarded to walk() and scanText()
 * @returns {{findings:Array<object>, filesScanned:number, truncated:boolean}}
 */
function scanDir(root, opts) {
  opts = opts || {};
  const res = walk(root, opts);
  const findings = [];
  let scanned = 0;
  for (const f of res.files) {
    const lang = languageOf(f.rel);
    if (!lang) continue;
    const text = readText(f.path, opts);
    if (text == null) continue;
    scanned++;
    findings.push(...scanText(text, Object.assign({}, opts, { file: f.rel, lang })));
  }
  return { findings, filesScanned: scanned, truncated: res.truncated };
}

module.exports = {
  LANG_BY_EXT,
  languageOf,
  stripComment,
  ruleApplies,
  scanText,
  scanDir,
  RULES,
};
