"use strict";
// ============================= Nexus Shellplan — shell/command intelligence =============================
// Single entrypoint for the shellplan subsystem. Everything here is Node.js stdlib
// only (no third-party deps) and understands a shell command BEFORE Nexus runs it.
// It COMPLEMENTS enforcement: ../sandbox.js (denylist) and ../capability.js
// (allowlist) decide allow/deny; shellplan parses, decomposes, extracts file
// targets, classifies risk, explains, and plans. See ./README.md and
// ./INTEGRATION.md.
//
//   parser       quote-aware tokenizer + recursive-descent parser -> AST
//   decompose    simple-command extraction + git/npm/docker canonicalization
//   filetargets  static read/write/delete path extraction with confidence
//   risk         deterministic, explainable risk rules (no LLM)
//   explain      plain-language, step-by-step account of a command
//   plan         dry-run effect plan + wouldSandboxAllow policy predictor
//   saferun      guarded executor for low-risk commands only

const parser = require("./parser");
const decompose = require("./decompose");
const filetargets = require("./filetargets");
const risk = require("./risk");
const explain = require("./explain");
const plan = require("./plan");
const saferun = require("./saferun");

/**
 * One-shot analysis of a command line: AST, decomposition, file targets, risk,
 * explanation, and (if a policy is supplied) a sandbox prediction.
 * @param {string} cmd
 * @param {object} [opts] - { cwd, policy, riskThreshold }
 * @returns {object}
 */
function analyze(cmd, opts) {
  opts = opts || {};
  const ast = parser.parse(cmd);
  const commands = decompose.decompose(ast);
  const files = filetargets.extractFileTargets(cmd);
  const riskReport = risk.classify(cmd);
  const explanation = explain.explain(cmd);
  const assessment = plan.assess(cmd, opts);
  return {
    command: cmd,
    ast,
    commands,
    files,
    risk: riskReport,
    explanation,
    plan: assessment.plan,
    sandbox: assessment.sandbox,
    recommendation: assessment.recommendation,
    errors: ast.errors,
  };
}

module.exports = {
  // namespaced submodules
  parser, decompose, filetargets, risk, explain, plan, saferun,

  // flat re-exports of the primary API
  analyze,
  parse: parser.parse,
  tokenize: parser.tokenize,
  decomposeCommand: decompose.decomposeCommand,
  extractFileTargets: filetargets.extractFileTargets,
  classify: risk.classify,
  explainCommand: explain.explain,
  dryRun: plan.dryRun,
  wouldSandboxAllow: plan.wouldSandboxAllow,
  assess: plan.assess,
  safeRun: saferun.safeRun,
};
