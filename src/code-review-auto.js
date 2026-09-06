// Auto Code Reviewer — reviews staged/changed code for bugs, security issues,
// performance problems, and style inconsistencies. Generates a structured review.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEV_BADGE = { critical: "CRIT", high: "HIGH", medium: "MED ", low: "LOW ", info: "INFO" };

const RULES = [
  // Security
  { id: "SEC001", sev: "critical", msg: "Hardcoded secret/password", test: l => /(?:password|secret|api[_-]?key)\s*[:=]\s*['"][^'"]{4,}['"]/i.test(l) && !/example|placeholder|test|TODO/i.test(l) },
  { id: "SEC002", sev: "high", msg: "eval() usage — potential code injection", test: l => /\beval\s*\(/.test(l) },
  { id: "SEC003", sev: "high", msg: "Command injection risk — user input in exec", test: l => /exec(?:Sync)?\s*\(.*\$\{|exec(?:Sync)?\s*\(.*\+\s*(?:req|input|user|param)/i.test(l) },
  { id: "SEC004", sev: "high", msg: "SQL injection — string concatenation in query", test: l => /(?:query|sql|execute)\s*\(.*['"].*\+\s*(?:req|input|user|param)/i.test(l) },
  { id: "SEC005", sev: "medium", msg: "innerHTML assignment — XSS risk", test: l => /\.innerHTML\s*=/.test(l) && !/textContent|escape|sanitize/i.test(l) },
  { id: "SEC006", sev: "medium", msg: "Insecure random — use crypto.randomBytes instead", test: l => /Math\.random\s*\(\)/.test(l) && /token|key|secret|nonce|salt|id/i.test(l) },
  { id: "SEC007", sev: "high", msg: "SSL/TLS verification disabled", test: l => /rejectUnauthorized\s*:\s*false|verify\s*[:=]\s*false|NODE_TLS_REJECT_UNAUTHORIZED/i.test(l) },

  // Bugs
  { id: "BUG001", sev: "high", msg: "=== comparison with null/undefined should use == or explicit check", test: l => /===\s*null\b/.test(l) && /\|\|/.test(l) },
  { id: "BUG002", sev: "medium", msg: "Async function without await or .catch()", test: l => /async\s+(?:function|\()/.test(l) },
  { id: "BUG003", sev: "medium", msg: "Empty catch block — errors silently swallowed", test: l => /catch\s*\([^)]*\)\s*\{\s*\}/.test(l) },
  { id: "BUG004", sev: "low", msg: "console.log in production code", test: l => /console\.log\s*\(/.test(l) },
  { id: "BUG005", sev: "medium", msg: "TODO/FIXME — unfinished work", test: l => /\b(TODO|FIXME|HACK|XXX)\b/i.test(l) },
  { id: "BUG006", sev: "high", msg: "Potential null reference — no null check before access", test: l => /\.\w+\.\w+\.\w+/.test(l) && !/\?\./. test(l) && /(?:data|result|response|res|resp|user|item)\.\w+\.\w+/.test(l) },

  // Performance
  { id: "PERF001", sev: "medium", msg: "Sync I/O in potentially async context", test: l => /(?:readFileSync|writeFileSync|execSync|existsSync)\s*\(/.test(l) },
  { id: "PERF002", sev: "low", msg: "Nested loop — O(n^2) potential", test: l => /for\s*\(.*for\s*\(|\.forEach.*\.forEach|\.map.*\.map/.test(l) },
  { id: "PERF003", sev: "low", msg: "String concatenation in loop — use array + join", test: l => /\+=\s*['"`]/.test(l) },

  // Style
  { id: "STY001", sev: "info", msg: "Magic number — consider named constant", test: l => /(?:===?|!==?|[<>]=?|return)\s+\d{2,}(?!\d*\.\d)/.test(l) && !/(?:port|status|code|timeout|delay|interval|size|length|index|offset|limit|max|min)\b/i.test(l) },
  { id: "STY002", sev: "info", msg: "Line too long (>120 chars)", test: l => l.length > 120 },
  { id: "STY003", sev: "info", msg: "Deeply nested code (4+ levels)", test: l => /^\s{16,}\S/.test(l) },
];

function getChangedFiles(target, cwd) {
  try {
    if (target && target !== "--strict" && fs.existsSync(path.resolve(cwd, target))) {
      return [{ file: target, content: fs.readFileSync(path.resolve(cwd, target), "utf8") }];
    }
    const diff = execSync("git diff --cached --name-only", { cwd, encoding: "utf8", timeout: 5000 }).trim();
    if (!diff) {
      const unstaged = execSync("git diff --name-only", { cwd, encoding: "utf8", timeout: 5000 }).trim();
      if (!unstaged) return [];
      return unstaged.split("\n").filter(f => /\.(js|ts|py|rb|go|rs|java|c|cpp|php)$/.test(f)).map(f => {
        try { return { file: f, content: fs.readFileSync(path.resolve(cwd, f), "utf8") }; }
        catch (_) { return null; }
      }).filter(Boolean);
    }
    return diff.split("\n").filter(f => /\.(js|ts|py|rb|go|rs|java|c|cpp|php)$/.test(f)).map(f => {
      try { return { file: f, content: fs.readFileSync(path.resolve(cwd, f), "utf8") }; }
      catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

function autoReview(target, cwd) {
  const dir = cwd || process.cwd();
  const strict = target === "--strict";
  const files = getChangedFiles(strict ? null : target, dir);

  if (!files.length) return "\n  No changed files to review. Stage changes with `git add` first.\n";

  const findings = [];
  for (const { file, content } of files) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const rule of RULES) {
        if (!strict && SEVERITY[rule.sev] >= SEVERITY.info) continue;
        try {
          if (rule.test(lines[i])) {
            findings.push({
              file,
              line: i + 1,
              rule: rule.id,
              severity: rule.sev,
              message: rule.msg,
              snippet: lines[i].trim().slice(0, 80),
            });
          }
        } catch (_) {}
      }
    }
  }

  findings.sort((a, b) => (SEVERITY[a.severity] || 9) - (SEVERITY[b.severity] || 9));

  let out = `\n  AUTO CODE REVIEW — ${files.length} file(s)${strict ? " (strict mode)" : ""}\n`;
  out += `  ${"─".repeat(50)}\n`;

  if (!findings.length) {
    out += "  No issues found. Code looks clean.\n";
    return out;
  }

  // Summary
  const bySev = {};
  findings.forEach(f => { bySev[f.severity] = (bySev[f.severity] || 0) + 1; });
  out += `  Findings: ${findings.length} — `;
  out += Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(", ") + "\n\n";

  // Group by file
  const byFile = {};
  findings.forEach(f => { (byFile[f.file] = byFile[f.file] || []).push(f); });

  for (const [file, issues] of Object.entries(byFile)) {
    out += `  ${file} (${issues.length} issue${issues.length > 1 ? "s" : ""}):\n`;
    for (const f of issues) {
      out += `    [${SEV_BADGE[f.severity]}] L${f.line} ${f.rule}: ${f.message}\n`;
      out += `           ${f.snippet}\n`;
    }
    out += "\n";
  }

  // Verdict
  const crits = bySev.critical || 0;
  const highs = bySev.high || 0;
  if (crits) out += `  VERDICT: BLOCK — ${crits} critical issue(s) must be fixed before merge.\n`;
  else if (highs > 2) out += `  VERDICT: REQUEST CHANGES — ${highs} high-severity issues found.\n`;
  else if (highs) out += `  VERDICT: APPROVE WITH COMMENTS — ${highs} high-severity issue(s) to address.\n`;
  else out += `  VERDICT: APPROVE — minor issues only.\n`;

  return out;
}

module.exports = { autoReview };
