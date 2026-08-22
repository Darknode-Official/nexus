"use strict";
// Release-notes generator. Parses `git log` output, classifies commits by
// conventional-commit type, and renders grouped Markdown. All pure + unit-tested;
// the caller runs git and feeds the log text.

// section order + heading for each conventional-commit type
const SECTIONS = [
  ["feat", "Features"], ["fix", "Fixes"], ["perf", "Performance"],
  ["refactor", "Refactors"], ["docs", "Docs"], ["test", "Tests"],
  ["build", "Build"], ["ci", "CI"], ["chore", "Chores"], ["other", "Other"],
];
const TYPES = new Set(SECTIONS.map((s) => s[0]).filter((t) => t !== "other"));

// classify("feat(cli): add x") -> { type:"feat", scope:"cli", subject:"add x" }
function classify(subject) {
  subject = String(subject == null ? "" : subject).trim();
  const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (m && TYPES.has(m[1].toLowerCase())) {
    return { type: m[1].toLowerCase(), scope: m[2] || "", breaking: !!m[3] || /BREAKING/.test(subject), subject: m[4].trim() };
  }
  return { type: "other", scope: "", breaking: /BREAKING/.test(subject), subject };
}

// parseCommits(logText) — lines of "<hash>\t<subject>" (git log --pretty=%h%x09%s).
function parseCommits(logText) {
  const out = [];
  for (const line of String(logText == null ? "" : logText).split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const hash = tab >= 0 ? line.slice(0, tab).trim() : "";
    const subject = tab >= 0 ? line.slice(tab + 1).trim() : line.trim();
    out.push(Object.assign({ hash }, classify(subject)));
  }
  return out;
}

// groupCommits(commits) -> { feat:[...], fix:[...], ... } keyed by type (present types only).
function groupCommits(commits) {
  const g = {};
  for (const c of commits) { (g[c.type] = g[c.type] || []).push(c); }
  return g;
}

// renderChangelog(commits, opts) -> Markdown release notes.
function renderChangelog(commits, opts) {
  opts = opts || {};
  const g = groupCommits(commits);
  const L = [];
  L.push("# " + (opts.title || "Changelog") + (opts.range ? "  (" + opts.range + ")" : ""));
  L.push("");
  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length) { L.push("## Breaking changes"); for (const c of breaking) L.push("- " + (c.scope ? "**" + c.scope + ":** " : "") + c.subject + (c.hash ? "  (" + c.hash + ")" : "")); L.push(""); }
  for (const [type, heading] of SECTIONS) {
    const items = g[type]; if (!items || !items.length) continue;
    L.push("## " + heading);
    for (const c of items) L.push("- " + (c.scope ? "**" + c.scope + ":** " : "") + c.subject + (c.hash ? "  (" + c.hash + ")" : ""));
    L.push("");
  }
  if (!commits.length) L.push("_No commits in range._");
  return L.join("\n").trim() + "\n";
}

module.exports = { SECTIONS, TYPES, classify, parseCommits, groupCommits, renderChangelog };
