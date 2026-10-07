"use strict";
// ===================== Test Intelligence — Discovery & Runner Detection =====================
// Detect which test runner(s) a project uses, by convention, and enumerate its test
// files. Detection is evidence-based and ranked by confidence so the caller can pick
// the most likely runner or ask. We never execute anything here — this is pure
// filesystem inspection. When no runner is detected we say so (empty list), rather
// than guessing and failing opaquely later.
//
//   detectRunners(root)        -> [{ runner, confidence, evidence[], command }]
//   detectPrimaryRunner(root)  -> the single best detection, or null
//   discoverTestFiles(root, o) -> absolute paths of test files by convention
//   isTestFile(path, runner)   -> boolean convention check
const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set([".git", "node_modules", ".nexus", "dist", "build", ".cache", ".next", "out", "coverage", "target", "__pycache__", "vendor", ".venv", "venv", ".tox", "htmlcov"]);

// Convention globs (as predicates) per runner.
const CONVENTIONS = {
  "node:test": (f) => /(^|\/)(test|tests)\//.test(f) || /\.(test|spec)\.(m|c)?js$/.test(f) || /(^|\/)test\.js$/.test(f),
  jest: (f) => /\.(test|spec)\.[jt]sx?$/.test(f) || /(^|\/)__tests__\//.test(f),
  mocha: (f) => /(^|\/)test\//.test(f) && /\.[jt]s$/.test(f),
  pytest: (f) => /(^|\/)test_[^/]*\.py$/.test(f) || /_test\.py$/.test(f) || /(^|\/)tests?\//.test(f) && /\.py$/.test(f),
  "go test": (f) => /_test\.go$/.test(f),
};

// readJson(file) -> parsed JSON or null.
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } }
function exists(p) { try { fs.accessSync(p); return true; } catch (_) { return false; } }
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch (_) { return ""; } }

// detectRunners(root) — gather evidence for each supported runner and rank.
function detectRunners(root) {
  root = path.resolve(root || ".");
  const out = [];
  const pkg = readJson(path.join(root, "package.json"));
  const allDeps = pkg ? Object.assign({}, pkg.dependencies, pkg.devDependencies) : {};
  const testScript = pkg && pkg.scripts && pkg.scripts.test ? String(pkg.scripts.test) : "";

  // ---- JavaScript/TypeScript ----
  if (pkg) {
    // jest
    const jestEv = [];
    if (allDeps.jest || allDeps["ts-jest"] || allDeps["babel-jest"]) jestEv.push("devDependency: jest");
    if (/\bjest\b/.test(testScript)) jestEv.push("test script runs jest");
    if (pkg.jest) jestEv.push("package.json 'jest' config block");
    for (const cf of ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.ts", "jest.config.json"]) if (exists(path.join(root, cf))) jestEv.push("config: " + cf);
    if (jestEv.length) out.push({ runner: "jest", confidence: scoreJs(jestEv), evidence: jestEv, command: "npx jest" });

    // mocha
    const mochaEv = [];
    if (allDeps.mocha) mochaEv.push("devDependency: mocha");
    if (/\bmocha\b/.test(testScript)) mochaEv.push("test script runs mocha");
    for (const cf of [".mocharc.js", ".mocharc.cjs", ".mocharc.json", ".mocharc.yml", ".mocharc.yaml"]) if (exists(path.join(root, cf))) mochaEv.push("config: " + cf);
    if (mochaEv.length) out.push({ runner: "mocha", confidence: scoreJs(mochaEv), evidence: mochaEv, command: "npx mocha" });

    // node:test — the fallback for JS projects with test files and no jest/mocha.
    const nodeEv = [];
    if (/node\s+--test|node:test/.test(testScript)) nodeEv.push("test script runs node --test");
    const jsTests = discoverTestFiles(root, { runner: "node:test", limit: 1 });
    if (jsTests.length && !allDeps.jest && !allDeps.mocha) nodeEv.push("has *.test.js / test/ files, no jest/mocha dep");
    if (nodeEv.length) out.push({ runner: "node:test", confidence: /node\s+--test/.test(testScript) ? 0.9 : 0.5, evidence: nodeEv, command: "node --test" });
  } else {
    // No package.json but JS test files present -> still suggest node:test at low confidence.
    const jsTests = discoverTestFiles(root, { runner: "node:test", limit: 1 });
    if (jsTests.length) out.push({ runner: "node:test", confidence: 0.4, evidence: ["JS test files present, no package.json"], command: "node --test" });
  }

  // ---- Python / pytest ----
  const pyEv = [];
  if (exists(path.join(root, "pytest.ini"))) pyEv.push("pytest.ini");
  if (exists(path.join(root, "tox.ini")) && /\bpytest\b/.test(readText(path.join(root, "tox.ini")))) pyEv.push("tox.ini references pytest");
  if (exists(path.join(root, "conftest.py"))) pyEv.push("conftest.py");
  const pyproject = readText(path.join(root, "pyproject.toml"));
  if (/\[tool\.pytest/.test(pyproject)) pyEv.push("pyproject.toml [tool.pytest]");
  if (/\bpytest\b/.test(pyproject)) pyEv.push("pyproject.toml references pytest");
  const setupcfg = readText(path.join(root, "setup.cfg"));
  if (/\[tool:pytest\]/.test(setupcfg)) pyEv.push("setup.cfg [tool:pytest]");
  const pyTests = discoverTestFiles(root, { runner: "pytest", limit: 1 });
  if (pyTests.length) pyEv.push("test_*.py / *_test.py files present");
  if (pyEv.length) out.push({ runner: "pytest", confidence: Math.min(0.95, 0.4 + 0.15 * pyEv.length), evidence: pyEv, command: "pytest" });

  // ---- Go ----
  const goEv = [];
  if (exists(path.join(root, "go.mod"))) goEv.push("go.mod");
  const goTests = discoverTestFiles(root, { runner: "go test", limit: 1 });
  if (goTests.length) goEv.push("*_test.go files present");
  if (goEv.length) out.push({ runner: "go test", confidence: Math.min(0.95, 0.5 + 0.2 * goEv.length), evidence: goEv, command: "go test ./..." });

  return out.sort((a, b) => b.confidence - a.confidence);
}

function scoreJs(ev) {
  let s = 0.4;
  for (const e of ev) { if (/test script/.test(e)) s += 0.3; else if (/devDependency/.test(e)) s += 0.25; else s += 0.15; }
  return Math.min(0.98, s);
}

// detectPrimaryRunner(root) -> best detection or null.
function detectPrimaryRunner(root) { const r = detectRunners(root); return r.length ? r[0] : null; }

// isTestFile(file, runner) — convention check for a single path.
function isTestFile(file, runner) {
  const f = toPosix(file);
  if (runner && CONVENTIONS[runner]) return CONVENTIONS[runner](f);
  for (const k of Object.keys(CONVENTIONS)) if (CONVENTIONS[k](f)) return true;
  return false;
}

// discoverTestFiles(root, opts) — walk the tree and return test files for a runner.
// opts: { runner, limit, maxFiles }. Returns POSIX-relative paths (to root) by default,
// absolute if opts.absolute. Vendored/build dirs are skipped.
function discoverTestFiles(root, opts) {
  opts = opts || {};
  root = path.resolve(root || ".");
  const runner = opts.runner || null;
  const pred = runner && CONVENTIONS[runner] ? CONVENTIONS[runner] : (f) => Object.keys(CONVENTIONS).some((k) => CONVENTIONS[k](f));
  const limit = opts.limit || Infinity;
  const maxFiles = opts.maxFiles || 50000;
  const out = [];
  let scanned = 0;
  const walk = (dir) => {
    if (out.length >= limit || scanned >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
      scanned++;
      const abs = path.join(dir, e.name);
      const rel = toPosix(path.relative(root, abs));
      if (pred(rel)) out.push(opts.absolute ? abs : rel);
    }
  };
  walk(root);
  return out.sort();
}

function toPosix(p) { return String(p).replace(/\\/g, "/"); }

module.exports = { detectRunners, detectPrimaryRunner, discoverTestFiles, isTestFile, CONVENTIONS, SKIP_DIRS };
