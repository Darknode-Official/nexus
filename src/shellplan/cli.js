#!/usr/bin/env node
"use strict";
// ============================= Shellplan CLI =============================
// A small runnable front-end for the shellplan subsystem. Wired into the Nexus CLI
// it reads as `nexus shell <sub> "<cmd>"`; standalone it is:
//   node src/shellplan/cli.js explain "git reset --hard && rm -rf build"
//
// Subcommands:
//   explain  <cmd>    plain-language, step-by-step account (+ file impact + risk)
//   risk     <cmd>    risk findings only (exit code = max severity rank)
//   parse    <cmd>    pretty-print the AST as JSON
//   files    <cmd>    list read/write/delete targets
//   plan     <cmd>    ordered dry-run effect plan (JSON)
//   check    <cmd>    wouldSandboxAllow against --root/--allow/--net/--allow-destructive
//
// Flags: --json (machine output), --cwd <dir>, --root <dir> (repeatable),
//        --allow <cmd> (repeatable, "*" = any), --net <host> (repeatable),
//        --allow-destructive, --confirmed, --threshold <sev>

const shellplan = require("./index");

function parseArgv(argv) {
  const out = { _: [], roots: [], allow: [], net: [], json: false, allowDestructive: false, confirmed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--allow-destructive") out.allowDestructive = true;
    else if (a === "--confirmed") out.confirmed = true;
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--threshold") out.threshold = argv[++i];
    else if (a === "--root") out.roots.push(argv[++i]);
    else if (a === "--allow") out.allow.push(argv[++i]);
    else if (a === "--net") out.net.push(argv[++i]);
    else out._.push(a);
  }
  return out;
}

function buildPolicy(o) {
  return {
    roots: o.roots.length ? o.roots : [o.cwd || process.cwd()],
    commands: o.allow,
    network: o.net,
    allowDestructive: o.allowDestructive,
    confirmed: o.confirmed,
  };
}

const USAGE = [
  "nexus shell — understand a command before running it",
  "",
  "Usage: nexus shell <explain|risk|parse|files|plan|check> \"<command>\" [flags]",
  "",
  "Flags:",
  "  --json                 machine-readable output",
  "  --cwd <dir>            base directory for path resolution",
  "  --root <dir>           sandbox root (repeatable); for `check`",
  "  --allow <cmd>          allowlisted command (repeatable, '*' = any); for `check`",
  "  --net <host>           allowlisted network host (repeatable); for `check`",
  "  --allow-destructive    policy permits destructive ops (still needs --confirmed)",
  "  --confirmed            destructive op has been confirmed",
  "  --threshold <sev>      risk threshold for `risk` exit code (default high)",
].join("\n");

function main(argv) {
  const o = parseArgv(argv);
  const sub = o._[0];
  const cmd = o._.slice(1).join(" ");

  if (!sub || sub === "help" || sub === "-h" || sub === "--help") { process.stdout.write(USAGE + "\n"); return 0; }
  if (!cmd) { process.stderr.write("error: no command given\n\n" + USAGE + "\n"); return 2; }

  const opts = { cwd: o.cwd };

  switch (sub) {
    case "explain": {
      const r = shellplan.explainCommand(cmd);
      if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      else process.stdout.write(r.text + "\n");
      return 0;
    }
    case "risk": {
      const r = shellplan.classify(cmd);
      const threshold = o.threshold || "high";
      if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      else {
        if (!r.findings.length) process.stdout.write("No risk rules matched. (score 0/100)\n");
        else {
          process.stdout.write("Risk score " + r.score + "/100, max severity " + r.maxSeverity + "\n");
          for (const f of r.findings) {
            process.stdout.write("  [" + f.severity.toUpperCase() + "/" + f.category + "] " + f.title + "\n");
            process.stdout.write("      why:   " + f.rationale + "\n");
            process.stdout.write("      safer: " + f.saferAlternative + "\n");
          }
        }
      }
      // exit code: non-zero when at/above threshold
      return shellplan.risk.severityRank(r.maxSeverity) >= shellplan.risk.severityRank(threshold) ? 1 : 0;
    }
    case "parse": {
      const ast = shellplan.parse(cmd);
      process.stdout.write(JSON.stringify(ast, null, 2) + "\n");
      return ast.errors.length ? 1 : 0;
    }
    case "files": {
      const f = shellplan.extractFileTargets(cmd);
      if (o.json) { process.stdout.write(JSON.stringify(f, null, 2) + "\n"); return 0; }
      if (!f.all.length) { process.stdout.write("No file targets detected.\n"); return 0; }
      for (const t of f.all) process.stdout.write("[" + t.access.toUpperCase() + "] " + t.path + "  (" + Math.round(t.confidence * 100) + "%" + (t.dynamic ? ", dynamic" : "") + ") — " + t.reason + "\n");
      return 0;
    }
    case "plan": {
      const p = shellplan.dryRun(cmd, opts);
      process.stdout.write(JSON.stringify(p, null, 2) + "\n");
      return 0;
    }
    case "check": {
      const policy = buildPolicy(o);
      const pred = shellplan.wouldSandboxAllow(cmd, policy, opts);
      if (o.json) { process.stdout.write(JSON.stringify(pred, null, 2) + "\n"); }
      else {
        process.stdout.write((pred.allowed ? "ALLOW" : "DENY") + "\n");
        for (const r of pred.reasons) process.stdout.write("  - " + r + "\n");
      }
      return pred.allowed ? 0 : 1;
    }
    default:
      process.stderr.write("unknown subcommand: " + sub + "\n\n" + USAGE + "\n");
      return 2;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgv, buildPolicy };
