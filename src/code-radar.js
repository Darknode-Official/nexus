// Code Radar — strategic codebase overview: complexity hotspots, security-sensitive
// code, dependency chains, dead code, and tech debt. Not a linter — a map.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const IGNORE = /node_modules|\.git|dist|build|__pycache__|\.pyc|\.min\.|vendor|\.lock$/;
const CODE_EXT = /\.(js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|php|sh|bash|cs|swift|kt)$/;

function walk(dir, files = []) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (IGNORE.test(f)) continue;
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        if (st.isDirectory()) walk(fp, files);
        else if (CODE_EXT.test(f)) files.push({ path: fp, size: st.size });
      } catch (_) {}
    }
  } catch (_) {}
  return files;
}

function countMetrics(content) {
  const lines = content.split("\n");
  let complexity = 0, nesting = 0, maxNesting = 0, todos = 0, longLines = 0;
  const imports = [], exports = [], functions = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(if|else|for|while|switch|catch|case)\b/.test(t)) complexity++;
    if (/[{(]\s*$/.test(t)) nesting++;
    if (/^[})]\s*/.test(t)) nesting = Math.max(0, nesting - 1);
    maxNesting = Math.max(maxNesting, nesting);
    if (/\b(TODO|FIXME|HACK|XXX|TEMP)\b/i.test(t)) todos++;
    if (line.length > 120) longLines++;
    if (/^(import |from |require\(|#include|using )/.test(t)) imports.push(t);
    if (/^(export |module\.exports)/.test(t)) exports.push(t);
    if (/^(function |def |fn |func |pub fn |async function |const \w+ = (?:async )?\()/.test(t)) {
      const name = t.match(/(?:function|def|fn|func)\s+(\w+)|const\s+(\w+)/);
      if (name) functions.push(name[1] || name[2]);
    }
  }
  return { lines: lines.length, complexity, maxNesting, todos, longLines, imports, exports, functions };
}

const SECURITY_PATTERNS = [
  { pattern: /eval\s*\(/, label: "eval()", severity: "high" },
  { pattern: /exec\s*\(|execSync\s*\(|system\s*\(|popen\s*\(/, label: "command execution", severity: "high" },
  { pattern: /innerHTML\s*=/, label: "innerHTML assignment", severity: "medium" },
  { pattern: /document\.write\s*\(/, label: "document.write", severity: "medium" },
  { pattern: /\bSQL\b.*\+.*\bvar\b|\bquery\b.*\+.*\binput\b|'\s*\+\s*req\./i, label: "potential SQL injection", severity: "high" },
  { pattern: /password\s*[:=]\s*['"][^'"]+['"]/, label: "hardcoded password", severity: "critical" },
  { pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i, label: "hardcoded API key", severity: "critical" },
  { pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i, label: "hardcoded secret", severity: "high" },
  { pattern: /Math\.random\s*\(/, label: "Math.random (not crypto-safe)", severity: "low" },
  { pattern: /http:\/\/(?!localhost|127\.0)/, label: "plaintext HTTP URL", severity: "low" },
  { pattern: /disable.*ssl|verify.*false|ssl.*false/i, label: "SSL verification disabled", severity: "high" },
  { pattern: /chmod\s+777|0777/, label: "world-writable permissions", severity: "medium" },
  { pattern: /pickle\.loads?\(|yaml\.load\(/i, label: "unsafe deserialization", severity: "high" },
  { pattern: /\bsudo\b/, label: "sudo usage", severity: "low" },
];

function scanProject(dir) {
  const cwd = dir || process.cwd();
  const files = walk(cwd);
  const results = { files: files.length, totalLines: 0, hotspots: [], techDebt: 0, languageBreakdown: {} };

  for (const f of files) {
    try {
      const content = fs.readFileSync(f.path, "utf8");
      const ext = path.extname(f.path);
      results.languageBreakdown[ext] = (results.languageBreakdown[ext] || 0) + 1;
      const m = countMetrics(content);
      results.totalLines += m.lines;
      results.techDebt += m.todos;

      const score = m.complexity + m.maxNesting * 3 + (m.lines > 300 ? 2 : 0) + (m.longLines > 10 ? 1 : 0);
      if (score > 10) {
        results.hotspots.push({
          file: path.relative(cwd, f.path),
          score,
          lines: m.lines,
          complexity: m.complexity,
          maxNesting: m.maxNesting,
          functions: m.functions.length,
          todos: m.todos,
        });
      }
    } catch (_) {}
  }

  results.hotspots.sort((a, b) => b.score - a.score);
  results.hotspots = results.hotspots.slice(0, 20);

  let out = `\n  CODE RADAR — ${path.basename(cwd)}\n`;
  out += `  ${"─".repeat(50)}\n`;
  out += `  Files: ${results.files}  |  Lines: ${results.totalLines.toLocaleString()}  |  Tech debt: ${results.techDebt} TODOs\n`;
  out += `\n  Languages:\n`;
  for (const [ext, count] of Object.entries(results.languageBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    const bar = "█".repeat(Math.min(20, Math.round((count / results.files) * 40)));
    out += `    ${ext.padEnd(6)} ${bar} ${count}\n`;
  }
  if (results.hotspots.length) {
    out += `\n  Complexity hotspots (top ${results.hotspots.length}):\n`;
    for (const h of results.hotspots) {
      const risk = h.score > 20 ? "!!!" : h.score > 15 ? "!! " : "!  ";
      out += `    ${risk} ${h.file} — score:${h.score} complexity:${h.complexity} depth:${h.maxNesting} lines:${h.lines}\n`;
    }
  }
  return out;
}

function scanSecurity(dir) {
  const cwd = dir || process.cwd();
  const files = walk(cwd);
  const findings = [];

  for (const f of files) {
    try {
      const content = fs.readFileSync(f.path, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const pat of SECURITY_PATTERNS) {
          if (pat.pattern.test(lines[i])) {
            findings.push({
              file: path.relative(cwd, f.path),
              line: i + 1,
              label: pat.label,
              severity: pat.severity,
              snippet: lines[i].trim().slice(0, 80),
            });
          }
        }
      }
    } catch (_) {}
  }

  findings.sort((a, b) => {
    const sev = { critical: 0, high: 1, medium: 2, low: 3 };
    return (sev[a.severity] || 4) - (sev[b.severity] || 4);
  });

  let out = `\n  SECURITY RADAR — ${findings.length} finding(s)\n  ${"─".repeat(50)}\n`;
  if (!findings.length) return out + "  No security-sensitive patterns detected.\n";
  for (const f of findings.slice(0, 30)) {
    const tag = { critical: "CRIT", high: "HIGH", medium: "MED ", low: "LOW " }[f.severity] || "    ";
    out += `  [${tag}] ${f.file}:${f.line} — ${f.label}\n         ${f.snippet}\n`;
  }
  return out;
}

function scanComplexity(dir) {
  const cwd = dir || process.cwd();
  const files = walk(cwd);
  const ranked = [];

  for (const f of files) {
    try {
      const content = fs.readFileSync(f.path, "utf8");
      const m = countMetrics(content);
      if (m.lines > 50) {
        ranked.push({ file: path.relative(cwd, f.path), ...m });
      }
    } catch (_) {}
  }

  ranked.sort((a, b) => b.complexity - a.complexity);
  let out = `\n  COMPLEXITY MAP\n  ${"─".repeat(50)}\n`;
  for (const r of ranked.slice(0, 20)) {
    const bar = "█".repeat(Math.min(30, r.complexity));
    out += `  ${bar} ${r.complexity} — ${r.file} (${r.lines} lines, depth ${r.maxNesting})\n`;
  }
  return out;
}

function scanDeps(dir) {
  const cwd = dir || process.cwd();
  let out = `\n  DEPENDENCY MAP\n  ${"─".repeat(50)}\n`;

  // Node.js
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      out += `  Node.js project: ${deps.length} deps, ${devDeps.length} dev deps\n`;
      if (deps.length) out += `  Production: ${deps.join(", ")}\n`;
      if (devDeps.length) out += `  Dev: ${devDeps.join(", ")}\n`;
      // Check for outdated
      try {
        const outdated = execSync("npm outdated --json 2>/dev/null", { cwd, timeout: 15000 }).toString();
        const od = JSON.parse(outdated || "{}");
        const count = Object.keys(od).length;
        if (count) out += `  Outdated: ${count} packages need updating\n`;
      } catch (_) {}
    } catch (_) {}
  }

  // Python
  const reqPath = path.join(cwd, "requirements.txt");
  if (fs.existsSync(reqPath)) {
    try {
      const reqs = fs.readFileSync(reqPath, "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#"));
      out += `  Python project: ${reqs.length} dependencies\n`;
      out += `  Packages: ${reqs.map(r => r.split(/[=<>]/)[0].trim()).join(", ")}\n`;
    } catch (_) {}
  }

  // Go
  const goMod = path.join(cwd, "go.mod");
  if (fs.existsSync(goMod)) {
    try {
      const content = fs.readFileSync(goMod, "utf8");
      const requires = content.match(/require \(([\s\S]*?)\)/);
      if (requires) {
        const deps = requires[1].split("\n").filter(l => l.trim()).length;
        out += `  Go project: ${deps} dependencies\n`;
      }
    } catch (_) {}
  }

  // Internal imports
  const files = walk(cwd);
  const importMap = {};
  for (const f of files.slice(0, 200)) {
    try {
      const content = fs.readFileSync(f.path, "utf8");
      const rel = path.relative(cwd, f.path);
      const imports = content.match(/(?:import .+ from |require\()['"]\.\/[^'"]+['"]/g) || [];
      if (imports.length) importMap[rel] = imports.length;
    } catch (_) {}
  }
  if (Object.keys(importMap).length) {
    out += `\n  Internal import counts:\n`;
    const sorted = Object.entries(importMap).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [file, count] of sorted) {
      out += `    ${count} imports — ${file}\n`;
    }
  }

  return out;
}

module.exports = { scanProject, scanSecurity, scanComplexity, scanDeps };
