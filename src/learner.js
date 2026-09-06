"use strict";
// ================= Adaptive Learner — the agent gets smarter per-project over time =================
// Tracks patterns from every interaction: which approaches worked, which failed,
// what the user corrected, what tools were most useful, coding style drift.
// Uses this to adapt future behavior WITHOUT retraining — pure prompt augmentation.
//
// This is the "secret sauce" — the agent remembers YOUR project, YOUR style, YOUR
// patterns and stops making the same mistakes twice.

const fs = require("fs");
const path = require("path");

const LEARNER_FILE = ".nexus/learner.json";
const MAX_PATTERNS = 200;
const MAX_CORRECTIONS = 100;

function learnerPath(cwd) { return path.join(cwd, LEARNER_FILE); }

function loadLearner(cwd) {
  try { return JSON.parse(fs.readFileSync(learnerPath(cwd), "utf8")); }
  catch (_) { return createLearner(); }
}

function saveLearner(cwd, data) {
  const dir = path.dirname(learnerPath(cwd));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  fs.writeFileSync(learnerPath(cwd), JSON.stringify(data, null, 2));
}

function createLearner() {
  return {
    patterns: [],        // what works in this project
    corrections: [],     // user corrections (mistake → fix)
    preferences: {},     // detected user preferences
    toolStats: {},       // which tools are most effective
    failureModes: [],    // recurring failure patterns to avoid
    styleGuide: {},      // learned coding style rules
    version: 1,
  };
}

// ---- Pattern learning ----

function learnPattern(cwd, pattern) {
  const data = loadLearner(cwd);
  // Dedupe by similarity
  const existing = data.patterns.find(p =>
    p.category === pattern.category && p.description === pattern.description
  );
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastSeen = Date.now();
    existing.confidence = Math.min(1, (existing.confidence || 0.5) + 0.1);
  } else {
    data.patterns.push({
      category: pattern.category,     // "approach", "tool_choice", "error_fix", "style"
      description: pattern.description,
      context: pattern.context || "",
      confidence: pattern.confidence || 0.5,
      count: 1,
      learnedAt: Date.now(),
      lastSeen: Date.now(),
    });
  }
  // Trim old patterns
  if (data.patterns.length > MAX_PATTERNS) {
    data.patterns.sort((a, b) => (b.count * b.confidence) - (a.count * a.confidence));
    data.patterns = data.patterns.slice(0, MAX_PATTERNS);
  }
  saveLearner(cwd, data);
}

// ---- Correction learning ----

function learnCorrection(cwd, correction) {
  const data = loadLearner(cwd);
  data.corrections.push({
    mistake: correction.mistake,
    fix: correction.fix,
    category: correction.category || "general",
    timestamp: Date.now(),
  });
  if (data.corrections.length > MAX_CORRECTIONS) {
    data.corrections = data.corrections.slice(-MAX_CORRECTIONS);
  }
  // Also add as a failure mode to avoid
  data.failureModes.push({
    pattern: correction.mistake,
    avoidance: correction.fix,
    source: "user_correction",
    timestamp: Date.now(),
  });
  if (data.failureModes.length > 50) data.failureModes = data.failureModes.slice(-50);
  saveLearner(cwd, data);
}

// ---- Style learning ----

function learnStyle(cwd, rules) {
  const data = loadLearner(cwd);
  Object.assign(data.styleGuide, rules);
  saveLearner(cwd, data);
}

function detectStyleFromEdits(cwd, edits) {
  const rules = {};
  for (const edit of edits) {
    const content = edit.content || "";
    // Detect indent
    const tabs = (content.match(/^\t/gm) || []).length;
    const spaces = (content.match(/^  /gm) || []).length;
    if (tabs + spaces > 5) rules.indent = tabs > spaces ? "tabs" : "spaces";
    // Detect semicolons
    const semi = (content.match(/;\s*$/gm) || []).length;
    const noSemi = (content.match(/[^;{}\s]\s*$/gm) || []).length;
    if (semi + noSemi > 5) rules.semicolons = semi > noSemi;
    // Detect quotes
    const single = (content.match(/'/g) || []).length;
    const double = (content.match(/"/g) || []).length;
    if (single + double > 10) rules.quotes = single > double ? "single" : "double";
    // Detect trailing commas
    if (/,\s*[\]})]/m.test(content)) rules.trailingCommas = true;
    // Detect arrow functions vs function keyword
    const arrows = (content.match(/=>/g) || []).length;
    const funcs = (content.match(/\bfunction\b/g) || []).length;
    if (arrows + funcs > 3) rules.arrowFunctions = arrows > funcs;
  }
  if (Object.keys(rules).length) learnStyle(cwd, rules);
  return rules;
}

// ---- Tool effectiveness tracking ----

function trackToolUse(cwd, toolName, success, duration) {
  const data = loadLearner(cwd);
  if (!data.toolStats[toolName]) {
    data.toolStats[toolName] = { calls: 0, successes: 0, totalDuration: 0 };
  }
  const stats = data.toolStats[toolName];
  stats.calls++;
  if (success) stats.successes++;
  stats.totalDuration += duration || 0;
  saveLearner(cwd, data);
}

// ---- Preference detection ----

function updatePreference(cwd, key, value) {
  const data = loadLearner(cwd);
  data.preferences[key] = { value, updatedAt: Date.now() };
  saveLearner(cwd, data);
}

// ---- Generate context augmentation from learned data ----

function augmentPrompt(cwd, prompt) {
  const data = loadLearner(cwd);
  const parts = [];

  // Top patterns (high confidence, frequently seen)
  const topPatterns = data.patterns
    .filter(p => p.confidence > 0.6 && p.count > 1)
    .sort((a, b) => (b.count * b.confidence) - (a.count * a.confidence))
    .slice(0, 10);
  if (topPatterns.length) {
    parts.push("## Learned Project Patterns");
    for (const p of topPatterns) {
      parts.push(`- ${p.description} (${p.category}, seen ${p.count}×)`);
    }
  }

  // Recent corrections (don't repeat mistakes)
  const recentCorrections = data.corrections.slice(-5);
  if (recentCorrections.length) {
    parts.push("\n## Recent Corrections (avoid these mistakes)");
    for (const c of recentCorrections) {
      parts.push(`- ❌ ${c.mistake} → ✅ ${c.fix}`);
    }
  }

  // Style guide
  if (Object.keys(data.styleGuide).length) {
    const style = data.styleGuide;
    const styleParts = [];
    if (style.indent) styleParts.push(style.indent);
    if (style.semicolons !== undefined) styleParts.push(style.semicolons ? "semicolons" : "no semicolons");
    if (style.quotes) styleParts.push(style.quotes + " quotes");
    if (style.arrowFunctions) styleParts.push("arrow functions preferred");
    if (style.trailingCommas) styleParts.push("trailing commas");
    if (styleParts.length) parts.push("\n## Code Style: " + styleParts.join(", "));
  }

  // Failure modes to avoid
  if (data.failureModes.length) {
    const recent = data.failureModes.slice(-3);
    parts.push("\n## Known Pitfalls");
    for (const f of recent) parts.push(`- Avoid: ${f.pattern}`);
  }

  if (!parts.length) return prompt;
  return parts.join("\n") + "\n\n" + prompt;
}

// ---- Summary ----

function learnerSummary(cwd) {
  const data = loadLearner(cwd);
  const toolRanking = Object.entries(data.toolStats)
    .map(([name, s]) => ({ name, calls: s.calls, successRate: s.calls ? (s.successes / s.calls * 100).toFixed(0) + "%" : "0%" }))
    .sort((a, b) => b.calls - a.calls);

  return {
    patterns: data.patterns.length,
    corrections: data.corrections.length,
    styleRules: Object.keys(data.styleGuide).length,
    failureModes: data.failureModes.length,
    topTools: toolRanking.slice(0, 5),
    preferences: Object.keys(data.preferences).length,
  };
}

module.exports = {
  loadLearner, saveLearner, learnPattern, learnCorrection,
  learnStyle, detectStyleFromEdits, trackToolUse, updatePreference,
  augmentPrompt, learnerSummary,
};
