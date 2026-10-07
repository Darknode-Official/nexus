"use strict";
// ============================= Test Intelligence — Nexus subsystem =============================
// Makes the agent's test loop fast and smart: run only the tests a change can affect,
// read failures as a short diagnosis instead of a wall of logs, tell flakes from real
// regressions, see which changed lines aren't covered, and scaffold tests for untested
// code. Everything here is Node stdlib only — zero third-party dependencies — and builds
// on the wave-1 subsystems (src/codegraph for impact/blast-radius, and src/perf is used
// where concurrent execution helps). See ./README.md for the API and honest limits, and
// ./INTEGRATION.md for wiring into the public API and the `darknode nexus` CLI.
//
// Quick start:
//   const testintel = require("./src/testintel");
//   const det = testintel.discovery.detectPrimaryRunner(process.cwd());   // which runner?
//   const sel = testintel.selectAffected(index, { changed: ["src/x.js"] });// run only these
//   const res = await testintel.run("node:test", { files: sel.selected });  // execute
//   const diag = testintel.triage(res);                                    // what broke, clustered
//
//   model      unified result model (pass/fail/skip/todo, durations, failures, counts)
//   parsers    normalize node:test TAP / jest / mocha / pytest / go test output
//   discovery  detect runner(s) + enumerate test files by convention
//   runner     build commands + execute + parse (async run / sync runSync / isAvailable)
//   affected   minimal affected-test selection via codegraph impact (+ convention fallback)
//   coverage   parse lcov / node table / coverage.py; uncovered-changed-lines
//   flaky      run N times, classify stable / flaky / consistently-failing with evidence
//   triage     cluster failures, extract salient error, summarize for the agent
//   skeleton   suggest arrange/act/assert test stubs for untested functions (via codegraph)

const model = require("./model");
const parsers = require("./parsers");
const discovery = require("./discovery");
const runner = require("./runner");
const affected = require("./affected");
const coverage = require("./coverage");
const flaky = require("./flaky");
const triage = require("./triage");
const skeleton = require("./skeleton");

module.exports = {
  // namespaced modules
  model, parsers, discovery, runner, affected, coverage, flaky, triage, skeleton,

  // flat re-exports of the primary entrypoints for ergonomic use
  // --- result model ---
  makeResult: model.makeResult,
  summarize: model.summarize,
  mergeResults: model.mergeResults,
  STATUS: model.STATUS,
  // --- parsing ---
  parse: parsers.parse,
  // --- discovery ---
  detectRunners: discovery.detectRunners,
  detectPrimaryRunner: discovery.detectPrimaryRunner,
  discoverTestFiles: discovery.discoverTestFiles,
  // --- execution ---
  run: runner.run,
  runSync: runner.runSync,
  buildCommand: runner.buildCommand,
  isAvailable: runner.isAvailable,
  // --- affected selection ---
  selectAffected: affected.selectAffected,
  selectAffectedFromRoot: affected.selectAffectedFromRoot,
  // --- coverage ---
  parseCoverage: coverage.parse,
  uncoveredChangedLines: coverage.uncoveredChangedLines,
  // --- flaky ---
  classifyFlaky: flaky.classify,
  classifyRuns: flaky.classifyRuns,
  runRepeated: flaky.runRepeated,
  // --- triage ---
  triage: triage.triage,
  clusterFailures: triage.clusterFailures,
  // --- skeletons ---
  untestedFunctions: skeleton.untestedFunctions,
  suggestSkeleton: skeleton.suggestSkeleton,
};
