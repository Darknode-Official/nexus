"use strict";
// ============================= Shellplan — dry-run / execution planning =============================
// Produces an ordered plan of a command's EFFECTS without executing anything, and a
// `wouldSandboxAllow` predictor that maps a parsed command against a sandbox-style
// allowlist policy to forecast allow/deny with reasons.
//
// This is prediction, not enforcement. The authoritative gate is:
//   - ../capability.js  commandAllowed / containPath  (allowlist model)
//   - ../sandbox.js     validate / validateWithin      (denylist layer)
// `wouldSandboxAllow` deliberately mirrors that same policy shape (roots, commands,
// network, allowDestructive, confirmed) so its prediction matches what enforcement
// will actually decide. See ./INTEGRATION.md.

const path = require("path");
const { decomposeCommand } = require("./decompose");
const { extractFileTargets } = require("./filetargets");
const { classify, severityRank } = require("./risk");

/**
 * Build an ordered dry-run plan: each simple command as a step with its resolved
 * cwd expectation, env overrides, file effects, and risk findings tied to it.
 * @param {string} cmd
 * @param {object} [opts] - { cwd }
 * @returns {{steps:Array, effects:object, risk:object, cwd:string, errors:string[]}}
 */
function dryRun(cmd, opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const { commands, errors } = decomposeCommand(cmd);
  const files = extractFileTargets(cmd);
  const risk = classify(cmd);

  // Track a modeled cwd: `cd X` in a sequence changes it for later steps (not across subshells).
  let modeledCwd = cwd;
  const steps = [];
  for (const c of commands) {
    const step = {
      index: c.index,
      kind: c.kind,
      program: c.program,
      argv: c.argv,
      cwd: modeledCwd,
      env: (c.assignments || []).reduce((m, a) => { m[a.name] = a.value; return m; }, {}),
      effects: [],
      willRunConditionally: c.connector === "&&" || c.connector === "||",
      condition: c.connector || null,
      background: !!c.background,
      inSubshell: !!c.inSubshell,
    };
    // model `cd` for subsequent non-subshell steps
    if (c.kind === "simple" && c.programBase === "cd" && c.operands[0] && !c.inSubshell) {
      modeledCwd = path.resolve(modeledCwd, c.operands[0]);
      step.changesCwdTo = modeledCwd;
    }
    steps.push(step);
  }

  // attach file effects to their originating command
  for (const t of files.all) {
    const step = steps.find(s => s.index === t.commandIndex);
    if (step) step.effects.push({ path: t.path, access: t.access, confidence: t.confidence, dynamic: t.dynamic, reason: t.reason });
  }

  return {
    steps,
    effects: { reads: files.reads, writes: files.writes, deletes: files.deletes },
    risk,
    cwd,
    errors,
  };
}

/**
 * Predict whether a sandbox with the given allowlist policy would ALLOW this
 * command, mirroring capability.commandAllowed + containPath semantics.
 *
 * Policy shape (aligned with capability.createCapabilities):
 *   { roots:string[], commands:string[] ("*" = any), network:string[],
 *     allowDestructive:boolean, confirmed:boolean }
 *
 * @param {string} cmd
 * @param {object} policy
 * @param {object} [opts] - { cwd }
 * @returns {{allowed:boolean, decisions:Array, reasons:string[], perCommand:Array}}
 */
function wouldSandboxAllow(cmd, policy, opts) {
  opts = opts || {};
  policy = normalizePolicy(policy);
  const cwd = opts.cwd || (policy.roots[0] || process.cwd());
  const { commands } = decomposeCommand(cmd);
  const files = extractFileTargets(cmd);

  const perCommand = [];
  const reasons = [];
  let allowed = true;

  for (const c of commands) {
    if (c.kind !== "simple") continue;
    const dec = { index: c.index, program: c.programBase, allowed: true, reasons: [] };

    // 1. command allowlist (argv[0])
    const onList = policy.commands.includes(c.programBase) || policy.commands.includes("*");
    if (!onList) { dec.allowed = false; dec.reasons.push("command '" + c.programBase + "' is not on the allowlist"); }

    // 2. destructive gate
    const destructive = classifyDestructive(cmd, c);
    if (destructive.length) {
      if (!policy.allowDestructive) { dec.allowed = false; dec.reasons.push("destructive op (" + destructive.join(",") + ") not permitted by policy"); }
      else if (!policy.confirmed) { dec.allowed = false; dec.needsConfirm = true; dec.reasons.push("destructive op (" + destructive.join(",") + ") requires confirmation"); }
      dec.destructiveClasses = destructive;
    }

    // 3. path containment for this command's file targets
    const myTargets = files.all.filter(t => t.commandIndex === c.index);
    for (const t of myTargets) {
      if (t.dynamic) { dec.reasons.push("path '" + t.path + "' is dynamic ($/glob) — cannot be statically contained; treated as outside"); dec.allowed = false; continue; }
      const cont = containPredict(policy.roots, t.path, cwd);
      if (!cont.inside) { dec.allowed = false; dec.reasons.push(t.access + " target '" + t.path + "' resolves outside declared roots"); }
    }

    // 4. network allowlist for URLs in the command
    for (const url of extractUrls(cmd)) {
      const host = hostOf(url);
      const netOk = policy.network.includes("*") || (host && policy.network.some(h => host === h || host.endsWith("." + h)));
      if (!netOk) { dec.allowed = false; dec.reasons.push("network host '" + (host || url) + "' not on network allowlist"); }
    }

    if (dec.reasons.length === 0) dec.reasons.push("allowed");
    if (!dec.allowed) { allowed = false; for (const r of dec.reasons) reasons.push("[" + c.programBase + "] " + r); }
    perCommand.push(dec);
  }

  if (allowed) reasons.push("all commands satisfy the policy");
  return { allowed, decisions: perCommand, perCommand, reasons };
}

function normalizePolicy(policy) {
  policy = policy || {};
  return {
    roots: (policy.roots && policy.roots.length ? policy.roots : [process.cwd()]).map(r => path.resolve(r)),
    commands: policy.commands || [],
    network: policy.network || [],
    allowDestructive: policy.allowDestructive === true,
    confirmed: policy.confirmed === true,
  };
}

// Mirror of capability.js DESTRUCTIVE classes, scoped to one command where possible.
const DESTRUCTIVE_RULES = [
  { cls: "recursive-delete", re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i },
  { cls: "recursive-delete", re: /\brmdir\b|\bfind\b[^\n]*-delete\b/i },
  { cls: "force-push", re: /\bgit\s+push\b[^\n]*(--force\b|-f\b|\+)/i },
  { cls: "history-rewrite", re: /\bgit\s+(reset\s+--hard|rebase|filter-branch|filter-repo|reflog\s+expire|gc\s+--prune)/i },
  { cls: "history-rewrite", re: /\bgit\s+update-ref\s+-d\b|\bgit\s+branch\s+-D\b/i },
  { cls: "dependency-removal", re: /\b(npm|yarn|pnpm)\s+(uninstall|remove|rm)\b|\bpip\s+uninstall\b|\bcargo\s+remove\b/i },
  { cls: "credential-touch", re: /(\.ssh\/|\.aws\/|\.netrc|id_rsa|\.env\b|credentials|secrets?|\.pem\b|\.key\b|keychain|\.gnupg)/i },
  { cls: "disk-destroy", re: /\bmkfs\b|\bdd\s+[^\n]*of=\/dev\/|\bshred\b|\bwipefs\b/i },
  { cls: "privilege", re: /\bchmod\s+(-R\s+)?777\b|\bchown\b[^\n]*root|\bpasswd\b|\busermod\b/i },
];

function classifyDestructive(rawFull, c) {
  // Prefer matching the single command's reconstructed text for precision; fall
  // back to the full line for cross-command patterns.
  const text = c ? c.argv.join(" ") : rawFull;
  const hits = new Set();
  for (const r of DESTRUCTIVE_RULES) if (r.re.test(text)) hits.add(r.cls);
  return [...hits];
}

// Predict capability.containPath: resolve relative to cwd, no filesystem access
// (static), so symlink resolution is approximated by lexical normalization. We
// report inside/outside against declared roots.
function containPredict(roots, candidate, cwd) {
  const abs = path.resolve(cwd, String(candidate || "").replace(/^~(?=\/|$)/, process.env.HOME || "~"));
  for (const root of roots) {
    const r = path.resolve(root);
    if (abs === r || abs.startsWith(r + path.sep)) return { inside: true, resolved: abs, root: r };
  }
  return { inside: false, resolved: abs, root: null };
}

function extractUrls(cmd) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s"'`|>&]+/g;
  let m;
  while ((m = re.exec(String(cmd || "")))) out.push(m[0]);
  return out;
}

function hostOf(url) { try { return new URL(url).hostname; } catch (_) { return null; } }

/**
 * A compact, combined assessment: the dry-run plan, the risk, and (if a policy is
 * given) the sandbox prediction, plus a single recommended action.
 * @param {string} cmd
 * @param {object} [opts] - { cwd, policy, riskThreshold }
 */
function assess(cmd, opts) {
  opts = opts || {};
  const plan = dryRun(cmd, { cwd: opts.cwd });
  const sandbox = opts.policy ? wouldSandboxAllow(cmd, opts.policy, { cwd: opts.cwd }) : null;
  const threshold = opts.riskThreshold || "high";
  const overThreshold = severityRank(plan.risk.maxSeverity) >= severityRank(threshold);

  let recommendation;
  if (sandbox && !sandbox.allowed) recommendation = "deny: sandbox policy would reject this";
  else if (overThreshold) recommendation = "confirm: risk (" + plan.risk.maxSeverity + ") meets or exceeds threshold (" + threshold + ")";
  else recommendation = "proceed: within policy and under the risk threshold";

  return { plan, risk: plan.risk, sandbox, recommendation, overThreshold };
}

module.exports = {
  dryRun,
  wouldSandboxAllow,
  assess,
  normalizePolicy,
  extractUrls,
};
