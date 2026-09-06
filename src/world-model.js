"use strict";
// ================= World Model — simulate before you act =================
//
// WHAT THIS IS:
// Before executing a destructive or complex action, the agent SIMULATES the outcome
// in its mental model. It predicts: what files will change, what tests will break,
// what side effects will occur, and whether the action is safe.
// Only after the simulation passes does the agent execute for real.
//
// RESEARCH BASIS:
// - World models in RL (Ha & Schmidhuber 2018): agents that dream
// - Planning by simulation: MCTS + learned dynamics models
// - Counterfactual reasoning: "what if" analysis
// - State tracking: maintaining a mental model of the project state
//
// THE KEY INSIGHT:
// An agent that can predict "if I change file A, tests B and C will probably break"
// is fundamentally better than one that changes A and waits for CI to tell it.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function run(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: "utf8", timeout: 10000, stdio: ["pipe","pipe","pipe"] }).trim(); }
  catch (e) { return e.stdout || ""; }
}

// ---- Project State Snapshot ----

/**
 * Capture a snapshot of the project's current state.
 * This is the "ground truth" that simulations are checked against.
 */
function captureState(cwd) {
  const files = {};
  const fileList = run("find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -name '*.?*' 2>/dev/null | head -200", cwd).split("\n").filter(Boolean);

  for (const file of fileList) {
    try {
      const stat = fs.statSync(path.join(cwd, file));
      files[file] = { size: stat.size, modified: stat.mtimeMs };
    } catch (_) {}
  }

  return {
    files,
    fileCount: Object.keys(files).length,
    gitBranch: run("git branch --show-current 2>/dev/null", cwd),
    gitDirty: run("git status --porcelain 2>/dev/null", cwd).split("\n").filter(Boolean).length > 0,
    timestamp: Date.now(),
  };
}

// ---- Impact Prediction ----

/**
 * Predict the impact of a file change WITHOUT making it.
 * Uses the knowledge graph and dependency analysis.
 * @param {string} cwd
 * @param {string} filePath - file about to be changed
 * @param {string} changeType - "edit" | "create" | "delete"
 * @returns {{ impactedFiles, impactedTests, riskLevel, sideEffects, recommendation }}
 */
function predictImpact(cwd, filePath, changeType) {
  const impacted = { files: [], tests: [], consumers: [] };
  const sideEffects = [];
  let riskLevel = "low";

  // 1. Find who imports/requires this file
  const basename = path.basename(filePath, path.extname(filePath));
  const consumers = run(
    `grep -rl "${basename}" . --include="*.js" --include="*.ts" --include="*.py" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null`,
    cwd
  ).split("\n").filter(f => f && f !== filePath);
  impacted.consumers = consumers;

  // 2. Find related test files
  const testPatterns = [
    filePath.replace(/\.(js|ts)$/, ".test.$1"),
    filePath.replace(/\.(js|ts)$/, ".spec.$1"),
    filePath.replace(/src\//, "test/").replace(/\.(js|ts)$/, ".test.$1"),
    filePath.replace(/src\//, "__tests__/"),
  ];
  for (const tp of testPatterns) {
    if (fs.existsSync(path.join(cwd, tp))) {
      impacted.tests.push(tp);
    }
  }

  // Also find tests that import this file
  const testConsumers = run(
    `grep -rl "${basename}" . --include="*.test.*" --include="*.spec.*" --exclude-dir=node_modules 2>/dev/null`,
    cwd
  ).split("\n").filter(Boolean);
  for (const tc of testConsumers) {
    if (!impacted.tests.includes(tc)) impacted.tests.push(tc);
  }

  // 3. Assess risk
  if (changeType === "delete") {
    riskLevel = consumers.length > 0 ? "high" : "low";
    if (consumers.length > 0) {
      sideEffects.push(`${consumers.length} file(s) import this — they will break`);
    }
  }

  if (/index\.(js|ts|py)$/.test(filePath)) {
    riskLevel = "high";
    sideEffects.push("This is a module entry point — changes affect all consumers");
  }

  if (/config|env|setting/i.test(filePath)) {
    riskLevel = riskLevel === "high" ? "high" : "medium";
    sideEffects.push("Configuration file — changes may affect application behavior globally");
  }

  if (/package\.json|Cargo\.toml|go\.mod|requirements/.test(filePath)) {
    riskLevel = "high";
    sideEffects.push("Dependency manifest — changes affect the build and all dependents");
  }

  if (consumers.length > 5) riskLevel = "high";
  else if (consumers.length > 2 && riskLevel !== "high") riskLevel = "medium";

  // 4. Recommendation
  let recommendation;
  if (riskLevel === "high") {
    recommendation = "HIGH RISK: Run tests before and after. Consider making changes incrementally. " +
      (impacted.tests.length > 0 ? `Run: ${impacted.tests[0]}` : "Write tests first.");
  } else if (riskLevel === "medium") {
    recommendation = "MEDIUM RISK: Verify the change works, check consumers.";
  } else {
    recommendation = "LOW RISK: Safe to proceed.";
  }

  return {
    file: filePath,
    changeType,
    riskLevel,
    impactedFiles: consumers.length,
    impactedTests: impacted.tests.length,
    consumers: consumers.slice(0, 20),
    tests: impacted.tests,
    sideEffects,
    recommendation,
  };
}

// ---- Simulation Engine ----

/**
 * Simulate a sequence of changes and predict the outcome.
 * @param {string} cwd
 * @param {Array<{file, changeType, description}>} changes
 * @returns {{ safe, totalRisk, predictions, blockers, recommendations }}
 */
function simulate(cwd, changes) {
  const predictions = [];
  let maxRisk = "low";
  const blockers = [];
  const recommendations = [];

  for (const change of changes) {
    const prediction = predictImpact(cwd, change.file, change.changeType);
    predictions.push(prediction);

    if (prediction.riskLevel === "high") maxRisk = "high";
    else if (prediction.riskLevel === "medium" && maxRisk !== "high") maxRisk = "medium";

    if (prediction.riskLevel === "high" && prediction.impactedFiles > 5) {
      blockers.push(`${change.file}: ${prediction.impactedFiles} dependents will be affected`);
    }

    for (const se of prediction.sideEffects) {
      recommendations.push(`${change.file}: ${se}`);
    }
  }

  // Cross-change analysis: do any changes conflict?
  const changedFiles = changes.map(c => c.file);
  const allConsumers = new Set();
  for (const p of predictions) {
    for (const c of p.consumers) {
      if (changedFiles.includes(c)) {
        blockers.push(`Circular dependency: ${p.file} and ${c} both being changed and depend on each other`);
      }
      allConsumers.add(c);
    }
  }

  // Test coverage check
  const totalTests = new Set(predictions.flatMap(p => p.tests)).size;
  if (totalTests === 0 && maxRisk !== "low") {
    recommendations.push("⚠ No tests cover any of the changed files — add tests before or after");
  }

  return {
    safe: blockers.length === 0 && maxRisk !== "high",
    totalRisk: maxRisk,
    changeCount: changes.length,
    totalImpacted: allConsumers.size,
    totalTests,
    predictions,
    blockers,
    recommendations,
  };
}

// ---- Counterfactual Reasoning ----

/**
 * Answer "what would happen if..." questions about the codebase.
 * @param {string} cwd
 * @param {string} question - e.g., "what if we delete utils.js?"
 * @returns {{ scenario, predictions, verdict }}
 */
function whatIf(cwd, question) {
  const lower = String(question || "").toLowerCase();

  // Parse the scenario
  let file = null, action = null;
  const deleteMatch = lower.match(/(?:delete|remove|drop)\s+(\S+)/);
  const changeMatch = lower.match(/(?:change|modify|edit|update)\s+(\S+)/);
  const renameMatch = lower.match(/(?:rename|move)\s+(\S+)\s+(?:to\s+)?(\S+)/);

  if (deleteMatch) { file = deleteMatch[1]; action = "delete"; }
  else if (changeMatch) { file = changeMatch[1]; action = "edit"; }
  else if (renameMatch) { file = renameMatch[1]; action = "delete"; } // rename = delete old + create new

  if (!file) {
    return { scenario: question, predictions: [], verdict: "Cannot parse scenario — specify a file and action" };
  }

  // Resolve file path
  const resolved = run(`find . -name "${path.basename(file)}" -not -path '*/node_modules/*' 2>/dev/null | head -1`, cwd);
  if (!resolved) {
    return { scenario: question, predictions: [], verdict: `File "${file}" not found` };
  }

  const impact = predictImpact(cwd, resolved, action);
  const verdict = impact.riskLevel === "high"
    ? `DANGEROUS: ${impact.impactedFiles} files depend on ${resolved}. ${impact.sideEffects.join(". ")}`
    : impact.riskLevel === "medium"
    ? `CAUTION: ${impact.impactedFiles} consumers. ${impact.recommendation}`
    : `SAFE: No significant dependencies. ${impact.recommendation}`;

  return { scenario: question, file: resolved, action, impact, verdict };
}

module.exports = { captureState, predictImpact, simulate, whatIf };
