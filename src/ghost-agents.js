"use strict";
// ================= Ghost Agents — invisible background AI that monitors your work =================
//
// UNIQUE CONCEPT: While you code, ghost agents silently watch and intervene ONLY
// when they detect something wrong. They don't generate output until triggered.
//
// Types of ghosts:
//   SENTINEL — watches for security issues in real-time (SQL injection, hardcoded secrets)
//   GUARDIAN — watches for bugs before you commit (null refs, type mismatches)
//   ORACLE  — pre-fetches context you'll probably need next (based on cursor position/file)
//   CRITIC  — rates the quality of changes and warns before you commit bad code
//   SCOUT   — monitors external signals (dependency vulnerabilities, API deprecations)
//
// Ghosts are lightweight — they don't run full AI inference. They use pattern matching
// and the knowledge graph, only escalating to the AI when they find something real.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function run(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: "utf8", timeout: 5000, stdio: ["pipe","pipe","pipe"] }).trim(); }
  catch (_) { return ""; }
}

// ---- Ghost Types ----

const GHOST_TYPES = {
  sentinel: {
    name: "Sentinel",
    icon: "🛡",
    description: "Watches for security issues in real-time",
    patterns: [
      { re: /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, severity: "critical", msg: "Hardcoded secret detected" },
      { re: /\beval\s*\(/, severity: "high", msg: "eval() usage — code injection risk" },
      { re: /exec(?:Sync)?\s*\(.*\$\{/, severity: "high", msg: "Command injection via template literal" },
      { re: /innerHTML\s*=(?!.*sanitize)/i, severity: "medium", msg: "innerHTML without sanitization — XSS risk" },
      { re: /http:\/\/(?!localhost|127\.)/, severity: "low", msg: "Insecure HTTP URL" },
      { re: /TODO.*(?:auth|secur|token|cred)/i, severity: "info", msg: "Security-related TODO" },
    ],
  },
  guardian: {
    name: "Guardian",
    icon: "🔮",
    description: "Watches for bugs before you commit",
    patterns: [
      { re: /\.\w+\.\w+\.\w+(?!\?)/, severity: "medium", msg: "Deep property access without optional chaining — null risk" },
      { re: /catch\s*\([^)]*\)\s*\{\s*\}/, severity: "medium", msg: "Empty catch block — errors silently swallowed" },
      { re: /===\s*undefined(?!.*\|\|)/, severity: "low", msg: "Strict undefined check — consider nullish coalescing" },
      { re: /console\.log\s*\(/, severity: "info", msg: "console.log in code — remove before commit" },
      { re: /\/\/\s*@ts-ignore/, severity: "medium", msg: "TypeScript error suppressed — fix the type instead" },
      { re: /\bany\b(?=\s*[;,\)])/, severity: "low", msg: "TypeScript 'any' — loses type safety" },
    ],
  },
  critic: {
    name: "Critic",
    icon: "📐",
    description: "Rates code quality and warns before bad commits",
    checks: {
      functionTooLong: { threshold: 50, msg: "Function exceeds 50 lines — consider decomposing" },
      fileTooLong: { threshold: 500, msg: "File exceeds 500 lines — consider splitting" },
      tooManyParams: { threshold: 5, msg: "Function has 5+ parameters — use an options object" },
      deepNesting: { threshold: 4, msg: "Nesting depth exceeds 4 — flatten the logic" },
    },
  },
};

// ---- Ghost Scan ----

/**
 * Run all ghost agents against a file or set of files.
 * Lightweight — pattern matching only, no AI inference.
 * @param {string} cwd - project root
 * @param {string[]} files - files to scan (if empty, scans changed files)
 * @returns {{ alerts: object[], summary: object }}
 */
function scan(cwd, files) {
  if (!files || !files.length) {
    // Default: scan git changed files
    const changed = run("git diff --name-only HEAD 2>/dev/null; git diff --cached --name-only 2>/dev/null", cwd);
    files = [...new Set(changed.split("\n").filter(Boolean))];
    if (!files.length) files = run("find . -name '*.js' -o -name '*.ts' -o -name '*.py' | head -30", cwd).split("\n").filter(Boolean);
  }

  const alerts = [];

  for (const file of files) {
    const fp = path.resolve(cwd, file);
    let content;
    try { content = fs.readFileSync(fp, "utf8"); } catch (_) { continue; }
    const lines = content.split("\n");

    // Sentinel + Guardian pattern scans
    for (const ghostType of ["sentinel", "guardian"]) {
      const ghost = GHOST_TYPES[ghostType];
      for (let i = 0; i < lines.length; i++) {
        for (const pattern of ghost.patterns) {
          if (pattern.re.test(lines[i])) {
            // Skip test files
            if (/test|spec|mock|fixture/i.test(file)) continue;
            // Skip commented examples
            if (/example|placeholder|TODO.*later/i.test(lines[i])) continue;
            alerts.push({
              ghost: ghostType,
              icon: ghost.icon,
              severity: pattern.severity,
              message: pattern.msg,
              file,
              line: i + 1,
              code: lines[i].trim().slice(0, 100),
            });
          }
        }
      }
    }

    // Critic structural checks
    const critic = GHOST_TYPES.critic;
    if (lines.length > critic.checks.fileTooLong.threshold) {
      alerts.push({ ghost: "critic", icon: "📐", severity: "info", message: critic.checks.fileTooLong.msg, file, line: 1, code: `${lines.length} lines` });
    }

    // Function length check
    let funcStart = null, funcName = null, braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const funcMatch = lines[i].match(/(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=.*=>)/);
      if (funcMatch && braceDepth === 0) { funcStart = i; funcName = funcMatch[1] || funcMatch[2]; }
      braceDepth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
      if (funcStart !== null && braceDepth === 0 && i > funcStart) {
        const len = i - funcStart;
        if (len > critic.checks.functionTooLong.threshold) {
          alerts.push({ ghost: "critic", icon: "📐", severity: "medium", message: `${funcName}() is ${len} lines — ${critic.checks.functionTooLong.msg}`, file, line: funcStart + 1, code: `${funcName}()` });
        }
        funcStart = null;
      }
    }

    // Nesting depth check
    let maxNest = 0, currentNest = 0;
    for (const line of lines) {
      currentNest += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (currentNest > maxNest) maxNest = currentNest;
    }
    if (maxNest > critic.checks.deepNesting.threshold) {
      alerts.push({ ghost: "critic", icon: "📐", severity: "low", message: `Max nesting depth: ${maxNest} — ${critic.checks.deepNesting.msg}`, file, line: 1, code: "" });
    }
  }

  // Sort by severity
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  alerts.sort((a, b) => (sevOrder[a.severity] || 5) - (sevOrder[b.severity] || 5));

  const summary = {
    filesScanned: files.length,
    totalAlerts: alerts.length,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    byGhost: {},
  };
  for (const a of alerts) {
    summary.bySeverity[a.severity] = (summary.bySeverity[a.severity] || 0) + 1;
    summary.byGhost[a.ghost] = (summary.byGhost[a.ghost] || 0) + 1;
  }

  return { alerts, summary };
}

/**
 * Format alerts for display.
 */
function formatAlerts(result) {
  if (!result.alerts.length) return "✅ Ghost agents found no issues.";
  const lines = [`Ghost Scan: ${result.summary.totalAlerts} alerts across ${result.summary.filesScanned} files`, ""];
  for (const a of result.alerts) {
    const sev = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" }[a.severity] || "·";
    lines.push(`  ${sev} ${a.icon} ${a.file}:${a.line} — ${a.message}`);
    if (a.code) lines.push(`    ${a.code}`);
  }
  return lines.join("\n");
}

/**
 * Pre-commit hook — run this before committing.
 * Returns { safe, alerts, message }.
 */
function preCommitCheck(cwd) {
  const staged = run("git diff --cached --name-only", cwd).split("\n").filter(Boolean);
  if (!staged.length) return { safe: true, alerts: [], message: "Nothing staged." };
  const result = scan(cwd, staged);
  const blockers = result.alerts.filter(a => a.severity === "critical" || a.severity === "high");
  return {
    safe: blockers.length === 0,
    alerts: result.alerts,
    blockers: blockers.length,
    message: blockers.length
      ? `⛔ ${blockers.length} critical/high issues found — fix before committing.`
      : result.alerts.length
      ? `⚠ ${result.alerts.length} minor issues found — safe to commit, but consider fixing.`
      : "✅ Clean — no issues found.",
  };
}

module.exports = { GHOST_TYPES, scan, formatAlerts, preCommitCheck };
