"use strict";
// ===================== Refactor — CLI =====================
// Runnable command-line front end for the refactoring library. Indexes the working
// directory, plans the requested refactoring, and (by default) shows the unified-diff
// preview. Pass --apply to write the change atomically, or --verify "<cmd>" to apply,
// run the command, and auto-revert if it fails.
//
// Usage:
//   nexus refactor rename <oldName> <newName> [--file F] [--line N]
//   nexus refactor extract <file> <startLine> <endLine> <newName>
//   nexus refactor inline-var <file> <name> [--force]
//   nexus refactor inline-fn  <file> <name>
//   nexus refactor move <name> <fromFile> <toFile>
//   nexus refactor imports <file>
//
// Common flags:
//   --dir D         project root to index (default: cwd)
//   --apply         write the change (default is dry-run preview)
//   --verify "cmd"  apply, run cmd, auto-revert on failure
//   --json          machine-readable output
//
// Direct:  node src/refactor/cli.js <command> ...
const path = require("path");
const refactor = require("./index");

function flag(name) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : null; }
function has(name) { return process.argv.includes("--" + name); }

function positionals() {
  const out = [];
  const argv = process.argv.slice(3); // skip node, cli.js, command
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (!["apply", "force", "json"].includes(a.slice(2))) i++; continue; }
    out.push(a);
  }
  return out;
}

function planFor(command, sess, pos) {
  switch (command) {
    case "rename": {
      const [oldName, newName] = pos;
      return sess.rename({ oldName, newName, file: flag("file") || undefined, line: flag("line") ? Number(flag("line")) : undefined, force: has("force") });
    }
    case "extract": {
      const [file, start, end, newName] = pos;
      return sess.extract({ file, startLine: Number(start), endLine: Number(end), newName });
    }
    case "inline-var": {
      const [file, name] = pos;
      return sess.inlineVariable({ file, name, force: has("force") });
    }
    case "inline-fn": {
      const [file, name] = pos;
      return sess.inlineFunction({ file, name });
    }
    case "move": {
      const [name, fromFile, toFile] = pos;
      return sess.move({ name, fromFile, toFile });
    }
    case "imports": {
      const [file] = pos;
      return sess.organizeImports({ file });
    }
    default:
      return null;
  }
}

function main() {
  const command = process.argv[2];
  const commands = ["rename", "extract", "inline-var", "inline-fn", "move", "imports"];
  if (!command || !commands.includes(command)) {
    console.log("nexus refactor <command> ...\n  commands: " + commands.join(", ") + "\n  flags: --dir --apply --verify \"cmd\" --json --force --file --line");
    process.exitCode = command ? 1 : 0;
    return;
  }

  const dir = path.resolve(flag("dir") || process.cwd());
  const sess = refactor.Refactorer.fromDir(dir);
  const pos = positionals();
  let plan;
  try { plan = planFor(command, sess, pos); }
  catch (e) { console.error("error: " + e.message); process.exitCode = 1; return; }
  if (!plan) { console.error("bad arguments for '" + command + "'"); process.exitCode = 1; return; }

  if (has("json")) { console.log(JSON.stringify(summarize(plan, sess), null, 2)); process.exitCode = plan.ok ? 0 : 2; return; }

  if (!plan.ok) {
    console.error("REFUSED (" + plan.refactoring + "): not safe to apply");
    for (const reason of plan.safety.reasons) console.error("  - " + reason);
    process.exitCode = 2;
    return;
  }

  const pv = sess.preview(plan);
  console.log("Refactoring: " + plan.refactoring + "   files: " + pv.files.length);
  for (const w of plan.safety.warnings) console.log("  warning: " + w);
  console.log("");
  for (const f of pv.files) {
    console.log(f.diff);
  }

  const verifyCmd = flag("verify");
  if (verifyCmd) {
    console.log("\nApplying and verifying with: " + verifyCmd);
    const res = sess.applyVerify(plan, verifyCmd);
    if (res.ok) console.log("OK — change applied and verified.");
    else { console.log("REVERTED — verification failed at phase '" + res.phase + "'."); process.exitCode = 3; }
    return;
  }
  if (has("apply")) {
    const res = sess.apply(plan);
    if (res.ok && res.committed) console.log("\nApplied atomically to " + (res.written || []).length + " file(s).");
    else { console.log("\nApply failed: " + JSON.stringify(res.errors || res)); process.exitCode = 3; }
  } else {
    console.log("\n(dry-run — re-run with --apply to write, or --verify \"npm test\" to apply+verify+revert)");
  }
}

function summarize(plan, sess) {
  const out = { refactoring: plan.refactoring, ok: plan.ok, safety: plan.safety, details: plan.details || {} };
  if (plan.ok) out.files = sess.preview(plan).files.map((f) => ({ file: f.file, action: f.action, additions: f.additions, deletions: f.deletions }));
  return out;
}

if (require.main === module) main();
module.exports = { main, planFor };
