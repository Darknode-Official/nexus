"use strict";
// ================= Code Actions — one-shot intelligent code operations =================
// Fast, focused operations that run without a full agent loop. Each action reads
// the relevant code, applies the transformation, and returns the result.
// These are the "superpowers" — things that take a human minutes but the agent
// does in milliseconds with structural understanding.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function run(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (e) { return e.stdout || e.stderr || ""; }
}

// ---- Inline documentation generator ----

function generateDocs(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath);
  const functions = [];

  if (/\.(js|ts|jsx|tsx|mjs)$/.test(ext)) {
    const re = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>|(\w+)\s*\([^)]*\)\s*\{)/g;
    let m;
    while ((m = re.exec(content))) {
      const name = m[1] || m[2] || m[3];
      if (!name || /^(if|for|while|switch|catch|new|return|typeof)$/.test(name)) continue;
      const lineNum = content.slice(0, m.index).split("\n").length;
      // Extract params
      const paramMatch = content.slice(m.index).match(/\(([^)]*)\)/);
      const params = paramMatch ? paramMatch[1].split(",").map(p => p.trim().split(/[:=]/)[0].trim()).filter(Boolean) : [];
      // Check if already documented
      const prevLines = content.slice(Math.max(0, m.index - 200), m.index);
      const hasDoc = /\/\*\*[\s\S]*?\*\/\s*$/.test(prevLines);
      functions.push({ name, line: lineNum, params, hasDoc });
    }
  } else if (/\.py$/.test(ext)) {
    const re = /(?:"""[\s\S]*?"""\s*)?def\s+(\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(content))) {
      const lineNum = content.slice(0, m.index).split("\n").length;
      const params = m[2].split(",").map(p => p.trim().split(/[:=]/)[0].trim()).filter(p => p && p !== "self" && p !== "cls");
      const nextLine = content.slice(m.index + m[0].length).match(/^\s*:\s*\n(\s*)"""[\s\S]*?"""/);
      functions.push({ name: m[1], line: lineNum, params, hasDoc: !!nextLine });
    }
  }

  return {
    file: filePath,
    functions,
    undocumented: functions.filter(f => !f.hasDoc),
    coverage: functions.length ? ((functions.filter(f => f.hasDoc).length / functions.length) * 100).toFixed(0) + "%" : "N/A",
  };
}

// ---- Dead code detector ----

function findDeadCode(cwd) {
  const dead = [];
  const allExports = new Map(); // name → file
  const allImports = new Set(); // names imported/used anywhere

  const files = run("find . -type f \\( -name '*.js' -o -name '*.ts' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*'", cwd).split("\n").filter(Boolean);

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(path.join(cwd, file), "utf8"); } catch (_) { continue; }

    // Collect exports
    const exportRe = /(?:module\.exports\s*=\s*\{([^}]+)\}|exports\.(\w+)|export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+))/g;
    let m;
    while ((m = exportRe.exec(content))) {
      if (m[1]) {
        for (const name of m[1].split(",").map(s => s.trim().split(/[\s:]/)[0]).filter(Boolean)) {
          allExports.set(name, file);
        }
      } else {
        const name = m[2] || m[3];
        if (name) allExports.set(name, file);
      }
    }

    // Collect imports/usage
    const importRe = /(?:require|import)\s*[\({]\s*['"]([^'"]+)['"]\s*[\)}]|(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require/g;
    while ((m = importRe.exec(content))) {
      if (m[2]) {
        for (const name of m[2].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
          allImports.add(name);
        }
      }
    }
  }

  // Exports not imported anywhere = potentially dead
  for (const [name, file] of allExports) {
    if (!allImports.has(name)) {
      dead.push({ name, file, type: "unused_export" });
    }
  }

  return { dead: dead.slice(0, 50), totalExports: allExports.size, totalImports: allImports.size };
}

// ---- Dependency graph visualizer ----

function dependencyGraph(cwd) {
  const graph = { nodes: [], edges: [] };
  const files = run("find . -type f \\( -name '*.js' -o -name '*.ts' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*'", cwd).split("\n").filter(Boolean);

  for (const file of files) {
    graph.nodes.push(file);
    let content;
    try { content = fs.readFileSync(path.join(cwd, file), "utf8"); } catch (_) { continue; }

    const importRe = /(?:require\s*\(\s*['"]([^'"]+)['"]|import\s+.*?from\s+['"]([^'"]+)['"])/g;
    let m;
    while ((m = importRe.exec(content))) {
      const target = m[1] || m[2];
      if (target.startsWith(".")) {
        const resolved = path.join(path.dirname(file), target).replace(/\\/g, "/");
        graph.edges.push({ from: file, to: resolved });
      }
    }
  }

  // Find circular dependencies
  const circular = [];
  const visited = new Set(), stack = new Set();
  function dfs(node, pathSoFar) {
    if (stack.has(node)) { circular.push([...pathSoFar, node]); return; }
    if (visited.has(node)) return;
    visited.add(node); stack.add(node);
    for (const edge of graph.edges) {
      if (edge.from === node) dfs(edge.to, [...pathSoFar, node]);
    }
    stack.delete(node);
  }
  for (const node of graph.nodes) dfs(node, []);

  // Find orphans (no imports, no importers)
  const imported = new Set(graph.edges.map(e => e.to));
  const importing = new Set(graph.edges.map(e => e.from));
  const orphans = graph.nodes.filter(n => !imported.has(n.replace(/\.js$/, "")) && !importing.has(n));

  return { nodes: graph.nodes.length, edges: graph.edges.length, circular: circular.slice(0, 10), orphans: orphans.slice(0, 20) };
}

// ---- Security scanner ----

function securityScan(cwd) {
  const findings = [];
  const files = run("find . -type f \\( -name '*.js' -o -name '*.ts' -o -name '*.py' \\) -not -path '*/node_modules/*' -not -path '*/.git/*'", cwd).split("\n").filter(Boolean);

  const rules = [
    { id: "HARDCODED_SECRET", severity: "critical", re: /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, msg: "Hardcoded secret" },
    { id: "EVAL", severity: "high", re: /\beval\s*\(/, msg: "eval() — code injection risk" },
    { id: "EXEC_INJECTION", severity: "high", re: /exec(?:Sync)?\s*\(.*\$\{/, msg: "Command injection via template literal" },
    { id: "SQL_INJECTION", severity: "high", re: /(?:query|execute)\s*\(.*['"].*\+\s*\w/, msg: "SQL injection — string concatenation" },
    { id: "PATH_TRAVERSAL", severity: "high", re: /\.\.\//g, msg: "Potential path traversal" },
    { id: "INSECURE_RANDOM", severity: "medium", re: /Math\.random\s*\(\).*(?:token|key|secret|id)/i, msg: "Insecure randomness for security-sensitive value" },
    { id: "NO_HTTPS", severity: "medium", re: /http:\/\/(?!localhost|127\.|0\.0\.0\.0)/, msg: "HTTP without TLS" },
    { id: "CORS_WILDCARD", severity: "medium", re: /cors\s*\(\s*\)|origin:\s*['"]?\*/, msg: "CORS wildcard — allows any origin" },
    { id: "DEBUG_MODE", severity: "low", re: /DEBUG\s*[:=]\s*(?:true|1|['"]true['"])/i, msg: "Debug mode enabled" },
    { id: "TODO_SECURITY", severity: "info", re: /(?:TODO|FIXME|HACK).*(?:secur|auth|cred|token|key)/i, msg: "Security-related TODO" },
  ];

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(path.join(cwd, file), "utf8"); } catch (_) { continue; }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const rule of rules) {
        if (rule.re.test(lines[i])) {
          // Skip test files and examples
          if (/test|spec|example|fixture|mock/i.test(file)) continue;
          if (/placeholder|example|TODO|test/i.test(lines[i])) continue;
          findings.push({ id: rule.id, severity: rule.severity, file, line: i + 1, message: rule.msg, code: lines[i].trim().slice(0, 120) });
        }
      }
    }
  }

  findings.sort((a, b) => {
    const sev = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    return (sev[a.severity] || 5) - (sev[b.severity] || 5);
  });

  return {
    findings: findings.slice(0, 100),
    bySeverity: { critical: findings.filter(f => f.severity === "critical").length, high: findings.filter(f => f.severity === "high").length, medium: findings.filter(f => f.severity === "medium").length, low: findings.filter(f => f.severity === "low").length },
    filesScanned: files.length,
  };
}

// ---- Complexity analyzer ----

function analyzeComplexity(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const functions = [];
  let currentFunc = null;
  let braceDepth = 0, maxDepth = 0, complexity = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const funcMatch = line.match(/(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?.*=>|(\w+)\s*\([^)]*\)\s*\{|def\s+(\w+))/);
    if (funcMatch && !currentFunc) {
      currentFunc = { name: funcMatch[1] || funcMatch[2] || funcMatch[3] || funcMatch[4], startLine: i + 1, complexity: 1, maxNesting: 0, lines: 0 };
      braceDepth = 0; maxDepth = 0;
    }

    if (currentFunc) {
      currentFunc.lines++;
      // Count complexity contributors
      if (/\b(if|else if|elif|case|for|while|do|catch|&&|\|\||ternary|\?[^?])/g.test(line)) currentFunc.complexity++;
      // Track nesting
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      braceDepth += opens - closes;
      if (braceDepth > maxDepth) maxDepth = braceDepth;

      if (braceDepth <= 0 && currentFunc.lines > 1) {
        currentFunc.maxNesting = maxDepth;
        functions.push(currentFunc);
        currentFunc = null;
        braceDepth = 0; maxDepth = 0;
      }
    }
  }

  // Sort by complexity
  functions.sort((a, b) => b.complexity - a.complexity);
  const avgComplexity = functions.length ? (functions.reduce((s, f) => s + f.complexity, 0) / functions.length).toFixed(1) : 0;

  return {
    file: filePath,
    totalFunctions: functions.length,
    avgComplexity: parseFloat(avgComplexity),
    hotspots: functions.filter(f => f.complexity > 10).slice(0, 10),
    allFunctions: functions.slice(0, 30),
  };
}

// ---- API endpoint extractor ----

function extractEndpoints(cwd) {
  const endpoints = [];
  const files = run("find . -type f \\( -name '*.js' -o -name '*.ts' -o -name '*.py' \\) -not -path '*/node_modules/*' -not -path '*/.git/*'", cwd).split("\n").filter(Boolean);

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(path.join(cwd, file), "utf8"); } catch (_) { continue; }

    // Express/Fastify/Hono routes
    const routeRe = /(?:app|router|server)\.(get|post|put|patch|delete|all)\s*\(\s*['"]([^'"]+)['"]/gi;
    let m;
    while ((m = routeRe.exec(content))) {
      endpoints.push({ method: m[1].toUpperCase(), path: m[2], file, line: content.slice(0, m.index).split("\n").length });
    }

    // FastAPI/Flask decorators
    const pyRouteRe = /@(?:app|router|blueprint)\.\s*(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/gi;
    while ((m = pyRouteRe.exec(content))) {
      endpoints.push({ method: m[1].toUpperCase(), path: m[2], file, line: content.slice(0, m.index).split("\n").length });
    }
  }

  return { endpoints, count: endpoints.length };
}

module.exports = { generateDocs, findDeadCode, dependencyGraph, securityScan, analyzeComplexity, extractEndpoints };
