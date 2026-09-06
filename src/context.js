"use strict";
// ================= Context Engine — automatic relevance-aware context gathering =================
// Before each agent turn, the context engine scans the project and assembles a focused
// context window: recent git changes, relevant files, NEXUS.md memories, project structure,
// open TODOs, and dependency info. The agent gets what it needs without manual searching.
//
// Architecture:
//   gather(cwd, query, opts) → { sections[], tokenEstimate, files[] }
//   Each section = { title, content, priority, tokens }
//   Sections are sorted by relevance and trimmed to fit the context budget.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ---- token estimation (rough: 1 token ≈ 4 chars) ----
function estimateTokens(s) { return Math.ceil(String(s || "").length / 4); }

// ---- safe shell exec ----
function run(cmd, cwd, timeout) {
  try { return execSync(cmd, { cwd, timeout: timeout || 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (_) { return ""; }
}

// ---- section builders ----

/** Project structure — tree of files, max 2 levels deep, skip noise */
function projectTree(cwd) {
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", "coverage", ".nyc_output", ".nexus"]);
  const lines = [];
  function walk(dir, prefix, depth) {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") && depth === 0 && e.name !== ".nexus") continue;
      if (SKIP.has(e.name)) continue;
      lines.push(prefix + (e.isDirectory() ? e.name + "/" : e.name));
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + "  ", depth + 1);
    }
  }
  walk(cwd, "", 0);
  return lines.join("\n");
}

/** Recent git changes — last 5 commits + current diff stats */
function gitContext(cwd) {
  const parts = [];
  const log = run("git log --oneline -5 2>/dev/null", cwd);
  if (log) parts.push("Recent commits:\n" + log);
  const status = run("git status --porcelain 2>/dev/null", cwd);
  if (status) parts.push("Working tree changes:\n" + status);
  const diffStat = run("git diff --stat HEAD 2>/dev/null", cwd);
  if (diffStat) parts.push("Diff summary:\n" + diffStat);
  return parts.join("\n\n");
}

/** NEXUS.md memories */
function memories(cwd) {
  const nexusPath = path.join(cwd, ".nexus", "NEXUS.md");
  try { return fs.readFileSync(nexusPath, "utf8").trim(); } catch (_) { return ""; }
}

/** Package/dependency info */
function dependencies(cwd) {
  const parts = [];
  // Node
  const pkgPath = path.join(cwd, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const deps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    if (deps.length) parts.push("Dependencies: " + deps.join(", "));
    if (devDeps.length) parts.push("Dev dependencies: " + devDeps.join(", "));
    if (pkg.scripts) parts.push("Scripts: " + Object.keys(pkg.scripts).join(", "));
  } catch (_) {}
  // Python
  const reqPath = path.join(cwd, "requirements.txt");
  try { const r = fs.readFileSync(reqPath, "utf8").trim(); if (r) parts.push("Python requirements:\n" + r); } catch (_) {}
  const setupPath = path.join(cwd, "setup.py");
  try { if (fs.existsSync(setupPath)) parts.push("(has setup.py)"); } catch (_) {}
  const pyprojectPath = path.join(cwd, "pyproject.toml");
  try { if (fs.existsSync(pyprojectPath)) parts.push("(has pyproject.toml)"); } catch (_) {}
  return parts.join("\n");
}

/** Open TODOs/FIXMEs in recently changed files */
function openTodos(cwd) {
  const changed = run("git diff --name-only HEAD~3 2>/dev/null || git diff --name-only HEAD 2>/dev/null", cwd);
  if (!changed) return "";
  const files = changed.split("\n").filter(Boolean).slice(0, 15);
  const todos = [];
  for (const f of files) {
    const fp = path.join(cwd, f);
    let lines;
    try { lines = fs.readFileSync(fp, "utf8").split("\n"); } catch (_) { continue; }
    lines.forEach((line, i) => {
      if (/\b(TODO|FIXME|HACK|XXX|BUG)\b/i.test(line)) {
        todos.push(f + ":" + (i + 1) + ": " + line.trim());
      }
    });
  }
  return todos.slice(0, 20).join("\n");
}

/** Files relevant to the user's query — keyword match on filenames + first lines */
function relevantFiles(cwd, query) {
  if (!query) return { text: "", files: [] };
  const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return { text: "", files: [] };
  const allFiles = run("find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/__pycache__/*' -not -name '*.lock' -not -name '*.min.js' 2>/dev/null", cwd);
  if (!allFiles) return { text: "", files: [] };
  const candidates = allFiles.split("\n").filter(Boolean);
  const scored = [];
  for (const rel of candidates) {
    const lower = rel.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (lower.includes(w)) score += 3;
      // also check first 5 lines for keyword
      try {
        const fp = path.join(cwd, rel);
        const head = fs.readFileSync(fp, "utf8").slice(0, 500).toLowerCase();
        if (head.includes(w)) score += 1;
      } catch (_) {}
    }
    if (score > 0) scored.push({ file: rel, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 8);
  const parts = [];
  const files = [];
  for (const { file } of top) {
    files.push(file);
    try {
      const content = fs.readFileSync(path.join(cwd, file), "utf8");
      const preview = content.slice(0, 1500);
      parts.push("--- " + file + " ---\n" + preview + (content.length > 1500 ? "\n... (truncated)" : ""));
    } catch (_) {
      parts.push("--- " + file + " (unreadable) ---");
    }
  }
  return { text: parts.join("\n\n"), files };
}

/** Current environment snapshot */
function envSnapshot(cwd) {
  const parts = [];
  parts.push("cwd: " + cwd);
  const branch = run("git branch --show-current 2>/dev/null", cwd);
  if (branch) parts.push("git branch: " + branch);
  const node = run("node --version 2>/dev/null", cwd);
  if (node) parts.push("node: " + node);
  const py = run("python3 --version 2>/dev/null", cwd);
  if (py) parts.push(py);
  return parts.join("  |  ");
}

// ---- main gather function ----

/**
 * Gather context for an agent turn.
 * @param {string} cwd - project root
 * @param {string} query - the user's prompt/question (for relevance matching)
 * @param {object} opts - { budget: max tokens (default 6000), sections: which to include }
 * @returns {{ sections: Array<{title, content, priority, tokens}>, tokenEstimate: number, files: string[] }}
 */
function gather(cwd, query, opts) {
  opts = opts || {};
  const budget = opts.budget || 6000;
  const include = opts.sections || ["env", "tree", "git", "memories", "deps", "todos", "relevant"];

  const builders = {
    env:      { title: "Environment",       fn: () => envSnapshot(cwd),        priority: 10 },
    memories: { title: "Project Memories",  fn: () => memories(cwd),           priority: 9  },
    git:      { title: "Git Context",       fn: () => gitContext(cwd),         priority: 8  },
    relevant: { title: "Relevant Files",    fn: () => relevantFiles(cwd, query), priority: 7, hasFiles: true },
    todos:    { title: "Open TODOs",        fn: () => openTodos(cwd),          priority: 5  },
    tree:     { title: "Project Structure", fn: () => projectTree(cwd),        priority: 4  },
    deps:     { title: "Dependencies",      fn: () => dependencies(cwd),       priority: 3  },
  };

  const sections = [];
  const allFiles = [];
  let totalTokens = 0;

  // Build sections in priority order
  const ordered = include
    .filter((k) => builders[k])
    .map((k) => ({ key: k, ...builders[k] }))
    .sort((a, b) => b.priority - a.priority);

  for (const sec of ordered) {
    if (totalTokens >= budget) break;
    const raw = sec.fn();
    let content, files;
    if (sec.hasFiles && raw && typeof raw === "object") {
      content = raw.text;
      files = raw.files || [];
    } else {
      content = raw;
      files = [];
    }
    if (!content) continue;
    const tokens = estimateTokens(content);
    // Trim content if it would exceed remaining budget
    const remaining = budget - totalTokens;
    let trimmed = content;
    if (tokens > remaining) {
      const charLimit = remaining * 4;
      trimmed = content.slice(0, charLimit) + "\n... (trimmed to fit context budget)";
    }
    const finalTokens = estimateTokens(trimmed);
    sections.push({ title: sec.title, content: trimmed, priority: sec.priority, tokens: finalTokens });
    totalTokens += finalTokens;
    allFiles.push(...files);
  }

  return { sections, tokenEstimate: totalTokens, files: allFiles };
}

/**
 * Format gathered context into a single string for injection into the system prompt.
 */
function format(gathered) {
  if (!gathered || !gathered.sections || !gathered.sections.length) return "";
  const parts = gathered.sections.map((s) =>
    "### " + s.title + "\n" + s.content
  );
  return "## Project Context (auto-gathered)\n\n" + parts.join("\n\n") +
    "\n\n_(" + gathered.tokenEstimate + " tokens of context gathered, " + gathered.files.length + " relevant files identified)_";
}

module.exports = { gather, format, estimateTokens, projectTree, gitContext, memories, dependencies, openTodos, relevantFiles, envSnapshot };
