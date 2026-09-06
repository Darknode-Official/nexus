"use strict";
// ================= Git Intelligence — deep git understanding for AI agents =================
// Goes beyond `git status` — understands blame chains, commit patterns, file ownership,
// change velocity, merge risk, and generates semantic commit messages.

const { execSync } = require("child_process");
const path = require("path");

function run(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (_) { return ""; }
}

// ---- Who owns what? ----

function fileOwnership(cwd, filePath) {
  const blame = run(`git blame --porcelain "${filePath}" 2>/dev/null`, cwd);
  if (!blame) return null;
  const authors = {};
  const lines = blame.split("\n");
  for (const line of lines) {
    const m = line.match(/^author (.+)/);
    if (m) {
      const author = m[1];
      authors[author] = (authors[author] || 0) + 1;
    }
  }
  const totalLines = Object.values(authors).reduce((s, n) => s + n, 0);
  const ranked = Object.entries(authors).sort((a, b) => b[1] - a[1]).map(([author, lines]) => ({
    author, lines, percentage: totalLines ? (lines / totalLines * 100).toFixed(0) + "%" : "0%",
  }));
  return { file: filePath, totalLines, authors: ranked, primaryOwner: ranked[0]?.author || "unknown" };
}

// ---- Change velocity — how fast is this area changing? ----

function changeVelocity(cwd, days) {
  days = days || 30;
  const log = run(`git log --since="${days} days ago" --name-only --pretty=format:"" 2>/dev/null`, cwd);
  if (!log) return { files: [], hotspots: [] };
  const counts = {};
  for (const file of log.split("\n").filter(Boolean)) {
    counts[file] = (counts[file] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([file, changes]) => ({ file, changes }));
  return {
    totalChanges: Object.values(counts).reduce((s, n) => s + n, 0),
    uniqueFiles: ranked.length,
    hotspots: ranked.slice(0, 20),
    period: days + " days",
  };
}

// ---- Merge risk assessment ----

function mergeRisk(cwd, branch) {
  branch = branch || run("git branch --show-current 2>/dev/null", cwd) || "HEAD";
  const base = run("git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null", cwd);
  if (!base) return { risk: "unknown", reason: "Cannot determine merge base" };

  const behindCount = parseInt(run(`git rev-list --count ${branch}..origin/main 2>/dev/null || echo 0`, cwd)) || 0;
  const aheadCount = parseInt(run(`git rev-list --count origin/main..${branch} 2>/dev/null || echo 0`, cwd)) || 0;
  const changedFiles = run(`git diff --name-only ${base} 2>/dev/null`, cwd).split("\n").filter(Boolean);
  const mainChanged = run(`git diff --name-only ${base}..origin/main 2>/dev/null`, cwd).split("\n").filter(Boolean);
  const conflicts = changedFiles.filter(f => mainChanged.includes(f));

  let risk = "low";
  let reasons = [];
  if (conflicts.length > 5) { risk = "high"; reasons.push(`${conflicts.length} files changed on both branches`); }
  else if (conflicts.length > 0) { risk = "medium"; reasons.push(`${conflicts.length} overlapping file(s)`); }
  if (behindCount > 50) { risk = "high"; reasons.push(`${behindCount} commits behind main`); }
  else if (behindCount > 10) { if (risk !== "high") risk = "medium"; reasons.push(`${behindCount} commits behind`); }
  if (aheadCount > 30) { reasons.push(`${aheadCount} commits ahead (large PR)`); }

  return { risk, reasons, behind: behindCount, ahead: aheadCount, conflictFiles: conflicts, branch };
}

// ---- Semantic commit message generator ----

function generateCommitMessage(cwd) {
  const staged = run("git diff --cached --stat 2>/dev/null", cwd);
  const diff = run("git diff --cached 2>/dev/null", cwd);
  if (!staged) return null;

  const files = staged.split("\n").filter(l => l.includes("|")).map(l => l.trim().split(/\s+/)[0]);
  const insertions = (staged.match(/(\d+) insertion/)||[])[1] || 0;
  const deletions = (staged.match(/(\d+) deletion/)||[])[1] || 0;

  // Detect type from file patterns
  let type = "chore";
  if (files.some(f => /test|spec/.test(f))) type = "test";
  if (files.some(f => /\.md$|doc|readme/i.test(f))) type = "docs";
  if (files.some(f => /\.css|\.scss|\.less|style/i.test(f))) type = "style";
  if (files.some(f => /ci|workflow|\.yml|Dockerfile/i.test(f))) type = "ci";
  if (files.some(f => /package\.json|requirements|Cargo\.toml|go\.mod/.test(f)) && files.length === 1) type = "deps";
  if (+insertions > +deletions * 3) type = "feat";
  if (+deletions > +insertions * 2) type = "refactor";

  // Detect scope from common directory
  const dirs = files.map(f => path.dirname(f)).filter(d => d !== ".");
  const scope = dirs.length === 1 ? dirs[0].split("/").pop() : dirs.length > 0 ? commonPrefix(dirs).split("/").filter(Boolean).pop() || "" : "";

  // Generate subject from the diff content
  const addedLines = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1).trim()).filter(l => l.length > 5);
  const keywords = addedLines.slice(0, 10).join(" ").match(/\b(?:add|fix|remove|update|create|delete|rename|refactor|implement|handle|support|enable|disable)\w*/gi) || [];
  const action = keywords[0] || (type === "feat" ? "add" : type === "refactor" ? "refactor" : "update");

  return {
    type,
    scope: scope || undefined,
    subject: `${action} ${files.length === 1 ? path.basename(files[0]) : files.length + " files"} (+${insertions}, -${deletions})`,
    full: `${type}${scope ? "(" + scope + ")" : ""}: ${action} ${files.length === 1 ? path.basename(files[0]) : files.length + " files"}`,
    files,
    stats: { insertions: +insertions, deletions: +deletions },
  };
}

function commonPrefix(strs) {
  if (!strs.length) return "";
  let prefix = strs[0];
  for (const s of strs.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

// ---- Commit pattern analysis ----

function commitPatterns(cwd, limit) {
  limit = limit || 100;
  const log = run(`git log --oneline -${limit} --format="%H|%an|%ad|%s" --date=short 2>/dev/null`, cwd);
  if (!log) return null;
  const commits = log.split("\n").filter(Boolean).map(l => {
    const [hash, author, date, ...msgParts] = l.split("|");
    return { hash, author, date, message: msgParts.join("|") };
  });

  // By author
  const byAuthor = {};
  for (const c of commits) {
    byAuthor[c.author] = (byAuthor[c.author] || 0) + 1;
  }

  // By day of week
  const byDay = {};
  for (const c of commits) {
    const day = new Date(c.date).toLocaleDateString("en", { weekday: "long" });
    byDay[day] = (byDay[day] || 0) + 1;
  }

  // Conventional commit types
  const types = {};
  for (const c of commits) {
    const m = c.message.match(/^(\w+)(?:\(|:)/);
    if (m) types[m[1]] = (types[m[1]] || 0) + 1;
  }

  return {
    totalCommits: commits.length,
    authors: Object.entries(byAuthor).sort((a, b) => b[1] - a[1]),
    byDayOfWeek: byDay,
    commitTypes: Object.entries(types).sort((a, b) => b[1] - a[1]),
    recentCommits: commits.slice(0, 10).map(c => c.message),
  };
}

module.exports = { fileOwnership, changeVelocity, mergeRisk, generateCommitMessage, commitPatterns };
