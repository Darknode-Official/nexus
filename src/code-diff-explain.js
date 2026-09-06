// Diff Explainer — takes a git diff and generates a semantic, human-readable
// explanation of what changed, why it likely changed, and what the impact is.
const { execSync } = require("child_process");
const path = require("path");

function getDiff(target, cwd) {
  try {
    if (!target || target === "unstaged") {
      return execSync("git diff", { cwd, encoding: "utf8", timeout: 10000 });
    }
    if (target === "staged") {
      return execSync("git diff --cached", { cwd, encoding: "utf8", timeout: 10000 });
    }
    if (/^HEAD~\d+$/.test(target)) {
      return execSync(`git diff ${target}..HEAD`, { cwd, encoding: "utf8", timeout: 10000 });
    }
    // Branch comparison
    const main = (() => {
      try { return execSync("git symbolic-ref refs/remotes/origin/HEAD", { cwd, encoding: "utf8", timeout: 5000 }).trim().replace("refs/remotes/origin/", ""); }
      catch (_) { return "main"; }
    })();
    return execSync(`git diff ${main}...${target}`, { cwd, encoding: "utf8", timeout: 10000 });
  } catch (e) {
    return execSync("git diff", { cwd, encoding: "utf8", timeout: 10000 });
  }
}

function parseDiff(raw) {
  const files = [];
  const chunks = raw.split(/^diff --git /m).filter(Boolean);
  for (const chunk of chunks) {
    const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/m);
    if (!headerMatch) continue;
    const file = headerMatch[2];
    const additions = (chunk.match(/^\+[^+]/gm) || []).length;
    const deletions = (chunk.match(/^-[^-]/gm) || []).length;
    const hunks = chunk.split(/^@@/m).slice(1);
    const changes = [];
    for (const hunk of hunks) {
      const added = hunk.split("\n").filter(l => l.startsWith("+")).map(l => l.slice(1).trim()).filter(Boolean);
      const removed = hunk.split("\n").filter(l => l.startsWith("-")).map(l => l.slice(1).trim()).filter(Boolean);
      changes.push({ added, removed });
    }
    files.push({ file, additions, deletions, changes });
  }
  return files;
}

function classifyChange(file) {
  const { additions: a, deletions: d, changes } = file;
  const allAdded = changes.flatMap(c => c.added).join("\n");
  const allRemoved = changes.flatMap(c => c.removed).join("\n");

  // Detect change type
  if (d === 0 && a > 0) return "new code added";
  if (a === 0 && d > 0) return "code removed";
  if (a > d * 3) return "major addition";
  if (d > a * 3) return "major removal";

  // Detect specific patterns
  if (/import|require|from\s+['"]/.test(allAdded) && !/import|require/.test(allRemoved)) return "new dependency added";
  if (/function |def |fn |const \w+ = /.test(allAdded) && a > d) return "new function/feature";
  if (/fix|bug|patch|correct|handle|catch/i.test(allAdded)) return "bug fix";
  if (/test|describe|it\(|expect|assert/.test(allAdded)) return "test added";
  if (/\.env|config|secret|key|password/i.test(file.file)) return "configuration change";
  if (/README|CHANGELOG|doc|\.md$/i.test(file.file)) return "documentation update";
  if (/refactor/i.test(allAdded) || (a > 5 && d > 5 && Math.abs(a - d) < 5)) return "refactoring";
  if (/security|auth|permission|sanitize|escape|validate/i.test(allAdded)) return "security improvement";
  return "modification";
}

function assessImpact(file) {
  const total = file.additions + file.deletions;
  const ext = path.extname(file.file);
  const isTest = /test|spec|__test__|_test\./i.test(file.file);
  const isConfig = /config|\.env|\.yml|\.yaml|\.json|\.toml/i.test(file.file);
  const isMigration = /migrat|schema|\.sql/i.test(file.file);

  if (isMigration) return { level: "high", reason: "database/schema change — may need migration" };
  if (isConfig) return { level: "medium", reason: "configuration change — verify in all environments" };
  if (isTest) return { level: "low", reason: "test change — low risk to production" };
  if (total > 100) return { level: "high", reason: "large change — thorough review recommended" };
  if (total > 30) return { level: "medium", reason: "moderate change — review key logic" };
  return { level: "low", reason: "small change" };
}

function explainDiff(target, cwd) {
  const dir = cwd || process.cwd();
  const raw = getDiff(target, dir);
  if (!raw.trim()) return "\n  No changes detected.\n";

  const files = parseDiff(raw);
  if (!files.length) return "\n  No parseable changes found.\n";

  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  let out = `\n  DIFF EXPLANATION — ${target || "unstaged changes"}\n`;
  out += `  ${"─".repeat(50)}\n`;
  out += `  ${files.length} file(s) changed  |  +${totalAdd} -${totalDel}  |  net ${totalAdd - totalDel > 0 ? "+" : ""}${totalAdd - totalDel} lines\n\n`;

  // Overall summary
  const types = {};
  files.forEach(f => { const t = classifyChange(f); types[t] = (types[t] || 0) + 1; });
  out += `  Summary: ${Object.entries(types).map(([t, n]) => `${n}x ${t}`).join(", ")}\n\n`;

  // Per-file breakdown
  for (const f of files) {
    const changeType = classifyChange(f);
    const impact = assessImpact(f);
    const impactBadge = { high: "[!!!]", medium: "[!! ]", low: "[!  ]" }[impact.level] || "[   ]";

    out += `  ${impactBadge} ${f.file}\n`;
    out += `         +${f.additions} -${f.deletions} — ${changeType}\n`;
    out += `         Impact: ${impact.reason}\n`;

    // Show key changes
    for (const chunk of f.changes.slice(0, 2)) {
      if (chunk.added.length) {
        const key = chunk.added.filter(l => l.length > 3 && !/^[{})\]]/. test(l)).slice(0, 2);
        if (key.length) out += `         Added: ${key[0].slice(0, 70)}\n`;
      }
      if (chunk.removed.length) {
        const key = chunk.removed.filter(l => l.length > 3 && !/^[{})\]]/. test(l)).slice(0, 2);
        if (key.length) out += `         Removed: ${key[0].slice(0, 70)}\n`;
      }
    }
    out += "\n";
  }

  // Risk assessment
  const highImpact = files.filter(f => assessImpact(f).level === "high");
  if (highImpact.length) {
    out += `  ATTENTION: ${highImpact.length} high-impact file(s) — review carefully:\n`;
    for (const f of highImpact) out += `    - ${f.file}: ${assessImpact(f).reason}\n`;
  }

  return out;
}

module.exports = { explainDiff };
