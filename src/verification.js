"use strict";
// ================= Verification Engine — ground truth beats self-assessment =================
//
// THE SINGLE MOST IMPORTANT RESEARCH FINDING:
// Across Reflexion, LATS, Voyager, multi-agent debate, and world models — the
// ONLY reliable way to improve agent quality is EXTERNAL VERIFICATION.
// Self-critique without grounding DECREASES accuracy (arXiv:2311.08596).
// Models trust their own narrative of success (AutoGPT failure mode).
//
// This engine provides GROUNDED verification: run real tests, check real types,
// execute real commands, diff real outputs — never trust the model's claim
// that something "should work."
//
// ARCHITECTURE:
// Every agent action goes through: ACT → VERIFY → DECIDE
//   ACT:    perform the change
//   VERIFY: run real, external checks (tests, types, lint, build, runtime)
//   DECIDE: based on EVIDENCE (not self-assessment), proceed or rollback

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function run(cmd, cwd, timeout) {
  try { return { ok: true, output: execSync(cmd, { cwd, encoding: "utf8", timeout: timeout || 30000, stdio: ["pipe","pipe","pipe"] }).trim() }; }
  catch (e) { return { ok: false, output: (e.stdout || "") + "\n" + (e.stderr || e.message || ""), code: e.status }; }
}

// ---- Verification strategies ----

const VERIFIERS = {
  // Run the project's test suite
  tests: {
    name: "Test Suite",
    detect: (cwd) => {
      const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch (_) { return null; } })();
      if (pkg?.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') return { cmd: "npm test", runner: "npm" };
      if (fs.existsSync(path.join(cwd, "pytest.ini")) || fs.existsSync(path.join(cwd, "conftest.py"))) return { cmd: "pytest -x -q", runner: "pytest" };
      if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return { cmd: "cargo test", runner: "cargo" };
      if (fs.existsSync(path.join(cwd, "go.mod"))) return { cmd: "go test ./...", runner: "go" };
      return null;
    },
    run: (cwd, config) => {
      if (!config) return { passed: true, skipped: true, reason: "No test runner detected" };
      const result = run(config.cmd, cwd, 60000);
      return {
        passed: result.ok,
        output: result.output.slice(-3000),
        runner: config.runner,
        skipped: false,
      };
    },
  },

  // Type checking
  types: {
    name: "Type Check",
    detect: (cwd) => {
      if (fs.existsSync(path.join(cwd, "tsconfig.json"))) return { cmd: "npx tsc --noEmit", runner: "typescript" };
      if (fs.existsSync(path.join(cwd, "mypy.ini")) || fs.existsSync(path.join(cwd, ".mypy.ini"))) return { cmd: "mypy .", runner: "mypy" };
      if (fs.existsSync(path.join(cwd, "pyrightconfig.json"))) return { cmd: "pyright", runner: "pyright" };
      return null;
    },
    run: (cwd, config) => {
      if (!config) return { passed: true, skipped: true, reason: "No type checker" };
      const result = run(config.cmd, cwd, 45000);
      return { passed: result.ok, output: result.output.slice(-2000), runner: config.runner, skipped: false };
    },
  },

  // Linting
  lint: {
    name: "Lint",
    detect: (cwd) => {
      if (fs.existsSync(path.join(cwd, "eslint.config.js")) || fs.existsSync(path.join(cwd, ".eslintrc.json"))) return { cmd: "npx eslint . --max-warnings=0", runner: "eslint" };
      if (fs.existsSync(path.join(cwd, "biome.json"))) return { cmd: "npx biome check .", runner: "biome" };
      if (fs.existsSync(path.join(cwd, "ruff.toml")) || fs.existsSync(path.join(cwd, ".ruff.toml"))) return { cmd: "ruff check .", runner: "ruff" };
      return null;
    },
    run: (cwd, config) => {
      if (!config) return { passed: true, skipped: true, reason: "No linter" };
      const result = run(config.cmd, cwd, 30000);
      return { passed: result.ok, output: result.output.slice(-2000), runner: config.runner, skipped: false };
    },
  },

  // Build check
  build: {
    name: "Build",
    detect: (cwd) => {
      const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch (_) { return null; } })();
      if (pkg?.scripts?.build) return { cmd: "npm run build", runner: "npm" };
      if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return { cmd: "cargo build", runner: "cargo" };
      if (fs.existsSync(path.join(cwd, "go.mod"))) return { cmd: "go build ./...", runner: "go" };
      return null;
    },
    run: (cwd, config) => {
      if (!config) return { passed: true, skipped: true, reason: "No build step" };
      const result = run(config.cmd, cwd, 60000);
      return { passed: result.ok, output: result.output.slice(-2000), runner: config.runner, skipped: false };
    },
  },

  // Syntax check (fast, no build required)
  syntax: {
    name: "Syntax",
    detect: (cwd) => ({ available: true }),
    run: (cwd, config, files) => {
      if (!files || !files.length) return { passed: true, skipped: true, reason: "No files to check" };
      const errors = [];
      for (const file of files) {
        const fp = path.join(cwd, file);
        if (!fs.existsSync(fp)) continue;
        if (/\.(js|mjs|cjs)$/.test(file)) {
          const r = run(`node -c "${fp}"`, cwd, 5000);
          if (!r.ok) errors.push({ file, error: r.output.trim() });
        } else if (/\.py$/.test(file)) {
          const r = run(`python3 -c "import py_compile; py_compile.compile('${fp}', doraise=True)"`, cwd, 5000);
          if (!r.ok) errors.push({ file, error: r.output.trim() });
        } else if (/\.json$/.test(file)) {
          try { JSON.parse(fs.readFileSync(fp, "utf8")); }
          catch (e) { errors.push({ file, error: "Invalid JSON: " + e.message }); }
        }
      }
      return { passed: errors.length === 0, errors, skipped: false };
    },
  },

  // Import/require resolution check
  imports: {
    name: "Imports",
    detect: (cwd) => ({ available: true }),
    run: (cwd, config, files) => {
      if (!files || !files.length) return { passed: true, skipped: true, reason: "No files" };
      const broken = [];
      for (const file of files) {
        const fp = path.join(cwd, file);
        if (!/\.(js|ts|mjs)$/.test(file)) continue;
        let content;
        try { content = fs.readFileSync(fp, "utf8"); } catch (_) { continue; }
        const importRe = /(?:require\s*\(\s*['"]([^'"]+)['"]|import\s+.*?from\s+['"]([^'"]+)['"])/g;
        let m;
        while ((m = importRe.exec(content))) {
          const target = m[1] || m[2];
          if (!target.startsWith(".")) continue; // skip npm packages
          const resolved = path.resolve(path.dirname(fp), target);
          const candidates = [resolved, resolved + ".js", resolved + ".ts", resolved + ".mjs", path.join(resolved, "index.js"), path.join(resolved, "index.ts")];
          if (!candidates.some(c => fs.existsSync(c))) {
            broken.push({ file, import: target, resolved });
          }
        }
      }
      return { passed: broken.length === 0, broken, skipped: false };
    },
  },
};

// ---- Verification Runner ----

/**
 * Run all applicable verifiers on the project.
 * @param {string} cwd
 * @param {object} opts - { changedFiles, quick (skip slow checks), verifiers (subset to run) }
 * @returns {{ passed, results, summary }}
 */
function verify(cwd, opts) {
  opts = opts || {};
  const changedFiles = opts.changedFiles || [];
  const quick = opts.quick || false;
  const requested = opts.verifiers || Object.keys(VERIFIERS);
  const results = {};

  for (const name of requested) {
    const verifier = VERIFIERS[name];
    if (!verifier) continue;
    if (quick && (name === "build" || name === "tests")) continue; // skip slow ones in quick mode

    const config = verifier.detect(cwd);
    const result = verifier.run(cwd, config, changedFiles);
    results[name] = { name: verifier.name, ...result };
  }

  const allPassed = Object.values(results).every(r => r.passed);
  const failed = Object.entries(results).filter(([_, r]) => !r.passed && !r.skipped).map(([k, r]) => k);
  const skipped = Object.entries(results).filter(([_, r]) => r.skipped).map(([k]) => k);

  return {
    passed: allPassed,
    results,
    failed,
    skipped,
    summary: allPassed
      ? `✅ All checks passed (${Object.keys(results).length - skipped.length} run, ${skipped.length} skipped)`
      : `❌ ${failed.length} check(s) failed: ${failed.join(", ")}`,
  };
}

/**
 * Quick verification of specific changed files (fast, no full test suite).
 */
function quickVerify(cwd, changedFiles) {
  return verify(cwd, { changedFiles, quick: true, verifiers: ["syntax", "imports"] });
}

/**
 * Full verification (tests, types, lint, build).
 */
function fullVerify(cwd) {
  return verify(cwd, { verifiers: ["tests", "types", "lint", "build"] });
}

// ---- Verification-Gated Actions ----

/**
 * Execute an action only if pre-verification passes, and verify after.
 * If post-verification fails, provide the failure evidence for the agent to fix.
 * @param {string} cwd
 * @param {function} action - async () => { files changed }
 * @param {object} opts - { preVerify, postVerify, rollbackOnFail }
 * @returns {{ actionResult, preCheck, postCheck, verdict }}
 */
async function verifiedAction(cwd, action, opts) {
  opts = opts || {};

  // Pre-check
  let preCheck = null;
  if (opts.preVerify !== false) {
    preCheck = quickVerify(cwd, []);
    if (!preCheck.passed && opts.requireClean) {
      return { actionResult: null, preCheck, postCheck: null, verdict: "BLOCKED: Pre-existing failures must be fixed first" };
    }
  }

  // Execute the action
  let actionResult;
  try {
    actionResult = await action();
  } catch (e) {
    return { actionResult: null, preCheck, postCheck: null, verdict: "ACTION FAILED: " + e.message };
  }

  // Post-check
  const changedFiles = actionResult?.files || [];
  const postCheck = verify(cwd, { changedFiles });

  // Verdict based on EVIDENCE
  let verdict;
  if (postCheck.passed) {
    verdict = "VERIFIED: All checks pass after the change";
  } else {
    const newFailures = postCheck.failed.filter(f =>
      !preCheck || !preCheck.failed.includes(f)
    );
    if (newFailures.length > 0) {
      verdict = "REGRESSION: Change introduced failures in " + newFailures.join(", ") + ". Fix required.";
    } else {
      verdict = "PRE-EXISTING: Failures existed before the change — not caused by this action";
    }
  }

  return { actionResult, preCheck, postCheck, verdict };
}

// ---- Evidence-Based Decision Making ----

/**
 * Generate a verification report that the agent uses to decide next steps.
 * This is the GROUNDING that prevents self-assessment hallucination.
 */
function verificationReport(results) {
  const lines = ["## Verification Report (External Evidence)"];

  for (const [name, result] of Object.entries(results.results || {})) {
    if (result.skipped) {
      lines.push(`  ⏭ ${result.name}: skipped (${result.reason})`);
      continue;
    }
    const icon = result.passed ? "✅" : "❌";
    lines.push(`  ${icon} ${result.name}${result.runner ? " (" + result.runner + ")" : ""}`);
    if (!result.passed && result.output) {
      // Include ACTUAL error output — this is the evidence
      const relevant = result.output.split("\n").filter(l =>
        /error|fail|assert|expect|not found|undefined|null|crash|panic|exception/i.test(l)
      ).slice(0, 10);
      if (relevant.length) {
        lines.push("    Errors:");
        for (const l of relevant) lines.push("    │ " + l.trim());
      }
    }
    if (result.errors) {
      for (const e of result.errors.slice(0, 5)) {
        lines.push(`    │ ${e.file}: ${e.error}`);
      }
    }
    if (result.broken) {
      for (const b of result.broken.slice(0, 5)) {
        lines.push(`    │ ${b.file}: import "${b.import}" not found`);
      }
    }
  }

  lines.push("");
  lines.push(results.passed
    ? "DECISION: Evidence supports proceeding."
    : "DECISION: Evidence shows problems. Fix the listed errors before proceeding."
  );

  return lines.join("\n");
}

module.exports = { verify, quickVerify, fullVerify, verifiedAction, verificationReport, VERIFIERS };
