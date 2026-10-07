#!/usr/bin/env node
"use strict";
// ================= CLI: nexus apply-edits =================
// Reads a file containing a model's message (or stdin), detects the edit
// format(s), and applies the edits atomically to the working tree.
//
//   node src/editformat/cli.js <file-with-model-output> [options]
//   cat reply.txt | node src/editformat/cli.js - [options]
//
// Options:
//   --dry-run         validate + show the unified-diff preview; write nothing
//   --verify <cmd>    after applying, run <cmd>; if it fails, auto-revert
//   --cwd <dir>       base directory for relative paths (default: process.cwd())
//   --fuzzy           allow opt-in content-fuzzy SEARCH matching
//   --fuzz <n>        unified-diff context fuzz (default 2)
//   --json            emit machine-readable JSON
//   --help            show this help
//
// Exit codes: 0 = applied (or dry-run ok), 2 = edits could not be placed
// (diagnoses printed), 1 = usage / IO error.

const fs = require("fs");
const ef = require("./index");

function parseArgs(argv) {
  const opts = { dryRun: false, verify: null, cwd: process.cwd(), fuzzy: false, fuzz: 2, json: false, file: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--verify") opts.verify = argv[++i];
    else if (a === "--cwd") opts.cwd = argv[++i];
    else if (a === "--fuzzy") opts.fuzzy = true;
    else if (a === "--fuzz") opts.fuzz = parseInt(argv[++i], 10);
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!opts.file) opts.file = a;
  }
  return opts;
}

const HELP = [
  "nexus apply-edits — apply model-emitted code edits atomically",
  "",
  "Usage: nexus apply-edits <file-with-model-output> [--dry-run] [--verify <cmd>]",
  "                         [--cwd <dir>] [--fuzzy] [--fuzz <n>] [--json]",
  "",
  "Reads the model's message, detects SEARCH/REPLACE, unified-diff or whole-file",
  "edits, self-repairs whitespace/indent drift, and commits them as one atomic",
  "transaction (or reverts if --verify fails). Use '-' to read from stdin.",
].join("\n");

function readInput(file) {
  if (file === "-" || file == null) return fs.readFileSync(0, "utf8");
  return fs.readFileSync(file, "utf8");
}

function printDiagnoses(diagnoses) {
  console.error("\nCould not place the following edits:");
  for (const d of diagnoses || []) {
    const where = d.path ? `${d.path}` : "(no path)";
    console.error(`  - ${where} (block @ line ${d.line}): [${d.reason}] ${d.message}`);
    if (d.candidates && d.candidates.length) {
      for (const c of d.candidates.slice(0, 3)) {
        console.error(`      ~ line ${c.line} (sim ${c.similarity}): ${c.excerpt}`);
      }
    }
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.file && process.stdin.isTTY) { console.error(HELP); return 1; }

  let input;
  try { input = readInput(opts.file); }
  catch (e) { console.error(`error: cannot read input: ${e.message}`); return 1; }

  const det = ef.detect.detect(input, {});
  if (det.edits.length === 0) {
    if (opts.json) console.log(JSON.stringify({ ok: false, reason: "no-edits", errors: det.errors }, null, 2));
    else console.error("No edit blocks detected in the input.");
    return 2;
  }

  // Dispatch.
  let result;
  if (opts.verify) {
    result = ef.apply.applyEditsVerified(det.edits, {
      verify: opts.verify,
      opts: { cwd: opts.cwd, allowFuzzy: opts.fuzzy, fuzz: opts.fuzz, dryRun: opts.dryRun, onDirty: "snapshot" },
    });
  } else {
    result = ef.apply.applyEdits(det.edits, {
      cwd: opts.cwd, allowFuzzy: opts.fuzzy, fuzz: opts.fuzz, dryRun: opts.dryRun,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ detection: { formats: det.formats, edits: det.edits.length }, result }, null, 2));
    return result.ok ? 0 : 2;
  }

  console.log(`Detected format(s): ${det.formats.join(", ") || "none"}  (${det.edits.length} edit(s))`);

  if (!result.ok) {
    if (result.reverted) {
      console.error("Verify command failed — changes were reverted.");
      if (result.verify) console.error((result.verify.stderr || result.verify.stdout || "").trim());
    } else if (result.phase === "validate" || result.diagnoses) {
      printDiagnoses(result.diagnoses);
    } else {
      console.error(`Failed in phase '${result.phase}': ${result.error || "see details"}`);
    }
    return 2;
  }

  if (opts.dryRun || (result.phase === "dry-run")) {
    const preview = result.preview || (result.plan && result.plan.files);
    if (result.preview) {
      for (const f of result.preview.files) {
        console.log(`\n--- ${f.action.toUpperCase()} ${f.file} (+${f.additions} -${f.deletions}) ---`);
        process.stdout.write(f.diff);
      }
    }
    console.log("\n(dry run — nothing written)");
    return 0;
  }

  if (result.phase === "done" || result.verified) {
    console.log(`Applied and verified. Files: ${(result.written || []).join(", ")}`);
    return 0;
  }
  if (result.reverted) {
    console.error("Verify command failed — changes were reverted.");
    if (result.verify) console.error((result.verify.stderr || result.verify.stdout || "").trim());
    return 2;
  }
  console.log(`Applied. Files written: ${(result.written || result.staged.map((s) => s.path)).join(", ")}`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs };
