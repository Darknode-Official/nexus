#!/usr/bin/env node
"use strict";
// ================= sectools/audit — runnable directory auditor =================
// Command-line scanner that audits a directory with every sectools scanner and
// prints findings. Pure stdlib; no arguments required beyond a path.
//
// Usage:
//   node src/sectools/audit.js [path] [options]
//
// Options:
//   --json              emit findings as JSON instead of text
//   --explain          include explanation + suggested fix per finding
//   --no-secrets       skip the secret scanner
//   --no-sast          skip the SAST engine
//   --no-deps          skip the dependency advisory checker
//   --no-entropy       disable entropy-based secret detection
//   --fail-on <sev>    exit non-zero when a finding >= <sev> exists (default: high)
//   --help             show this help
//
// Exit codes: 0 = clean / below threshold, 2 = findings at/above --fail-on,
//             1 = usage error.

const path = require("path");
const sectools = require("./index");
const { severityRank } = require("./guards");

function parseArgs(argv) {
  const opts = {
    root: ".",
    json: false,
    explain: false,
    secrets: true,
    sast: true,
    deps: true,
    entropy: true,
    failOn: "high",
    help: false,
  };
  let gotPath = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json": opts.json = true; break;
      case "--explain": opts.explain = true; break;
      case "--no-secrets": opts.secrets = false; break;
      case "--no-sast": opts.sast = false; break;
      case "--no-deps": opts.deps = false; break;
      case "--no-entropy": opts.entropy = false; break;
      case "--fail-on": opts.failOn = argv[++i] || "high"; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        if (a.startsWith("--")) { opts._error = `Unknown option: ${a}`; }
        else if (!gotPath) { opts.root = a; gotPath = true; }
    }
  }
  return opts;
}

const HELP = `nexus sectools audit — scan a directory for secrets, insecure code and vulnerable deps

Usage: node src/sectools/audit.js [path] [options]

Options:
  --json             emit findings as JSON
  --explain          include explanation + suggested fix per finding
  --no-secrets       skip the secret scanner
  --no-sast          skip the SAST engine
  --no-deps          skip the dependency advisory checker
  --no-entropy       disable entropy-based secret detection
  --fail-on <sev>    exit code 2 when a finding >= <sev> exists (default: high)
  -h, --help         show this help`;

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { process.stdout.write(HELP + "\n"); return 0; }
  if (opts._error) { process.stderr.write(opts._error + "\n\n" + HELP + "\n"); return 1; }

  const root = path.resolve(opts.root);
  const report = sectools.audit(root, {
    secrets: opts.secrets,
    sast: opts.sast,
    deps: opts.deps,
    entropy: opts.entropy,
    explain: opts.explain,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(sectools.formatReport(report) + "\n");
  }

  const min = severityRank(opts.failOn);
  const hit = report.findings.some((f) => severityRank(f.severity) >= min);
  return hit ? 2 : 0;
}

// Only run when invoked directly (so tests can require this file safely).
if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { parseArgs, main, HELP };
