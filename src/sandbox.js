"use strict";
// ================= Secure Sandbox — safe command execution with guardrails =================
// The agent needs to run commands, but unrestricted shell access is dangerous.
// The sandbox validates commands before execution, blocks destructive patterns,
// enforces resource limits, and maintains an audit trail.

const { execSync, spawn } = require("child_process");
const path = require("path");

// ---- Blocked patterns (never execute, regardless of context) ----
const BLOCKED = [
  /\brm\s+(-rf?|--recursive)\s+[\/~](?!\S*node_modules)/,  // rm -rf / or ~
  /\bmkfs\b/,                                                // format drives
  /\bdd\s+.*of=\/dev\//,                                     // disk overwrite
  /\b:?\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/,                 // fork bomb
  /\bcurl\s+.*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/,          // pipe to shell
  /\bchmod\s+777\s+\//,                                       // world-writable root
  /\bpasswd\b/,                                               // password changes
  /\busermod\b.*-aG\s+sudo/,                                  // privilege escalation
  /\bsudo\s+rm\b/,                                            // sudo rm
  /\beval\s*\(\s*\$\{?/,                                      // eval injection
  /\/etc\/shadow/,                                            // shadow file access
  /\bcryptominer\b|\bxmrig\b/i,                              // mining
];

// ---- Warned patterns (execute but flag for review) ----
const WARNED = [
  { re: /\bsudo\b/, msg: "Command uses sudo — requires elevated privileges" },
  { re: /\bcurl\b.*-[oO]/, msg: "Downloading a file from the internet" },
  { re: /\bwget\b/, msg: "Downloading a file from the internet" },
  { re: /\bnpm\s+install\b(?!\s+--save-dev)/, msg: "Installing npm packages (production)" },
  { re: /\bgit\s+push\b/, msg: "Pushing to remote repository" },
  { re: /\bgit\s+reset\s+--hard\b/, msg: "Hard reset — will discard changes" },
  { re: /\bdocker\s+rm\b/, msg: "Removing Docker containers" },
  { re: /DROP\s+(?:TABLE|DATABASE)/i, msg: "Destructive SQL operation" },
  { re: /\bkill\s+-9\b/, msg: "Force-killing a process" },
];

/**
 * Validate a command before execution.
 * @param {string} command
 * @returns {{ allowed: boolean, blocked: boolean, warnings: string[], reason: string }}
 */
function validate(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { allowed: false, blocked: true, warnings: [], reason: "Empty command" };

  // Check blocked patterns
  for (const pat of BLOCKED) {
    if (pat.test(cmd)) {
      return { allowed: false, blocked: true, warnings: [], reason: "Blocked: matches dangerous pattern " + pat.source.slice(0, 40) };
    }
  }

  // Check warned patterns
  const warnings = [];
  for (const { re, msg } of WARNED) {
    if (re.test(cmd)) warnings.push(msg);
  }

  return { allowed: true, blocked: false, warnings, reason: warnings.length ? "Allowed with warnings" : "OK" };
}

/**
 * Execute a command with resource limits and timeout.
 * @param {string} command
 * @param {object} opts - { cwd, timeout, maxOutput, env, dryRun }
 * @returns {{ stdout: string, stderr: string, exitCode: number, truncated: boolean, duration: number }}
 */
function execute(command, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 30000;
  const maxOutput = opts.maxOutput || 200000;
  const cwd = opts.cwd || process.cwd();

  // Validate first
  const check = validate(command);
  if (!check.allowed) {
    return { stdout: "", stderr: "BLOCKED: " + check.reason, exitCode: 1, truncated: false, duration: 0, blocked: true };
  }

  if (opts.dryRun) {
    return { stdout: "[DRY RUN] Would execute: " + command, stderr: "", exitCode: 0, truncated: false, duration: 0, dryRun: true, warnings: check.warnings };
  }

  const start = Date.now();
  try {
    const stdout = execSync(command, {
      cwd,
      timeout,
      encoding: "utf8",
      maxBuffer: maxOutput * 2,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const truncated = stdout.length > maxOutput;
    return {
      stdout: truncated ? stdout.slice(0, maxOutput) + "\n... (truncated)" : stdout,
      stderr: "",
      exitCode: 0,
      truncated,
      duration: Date.now() - start,
      warnings: check.warnings,
    };
  } catch (e) {
    return {
      stdout: String(e.stdout || "").slice(0, maxOutput),
      stderr: String(e.stderr || e.message || "").slice(0, maxOutput),
      exitCode: e.status || 1,
      truncated: false,
      duration: Date.now() - start,
      warnings: check.warnings,
    };
  }
}

// ---- Audit trail ----

const audit = [];
const MAX_AUDIT = 500;

function logExecution(command, result, context) {
  audit.push({
    command,
    exitCode: result.exitCode,
    blocked: result.blocked || false,
    warnings: result.warnings || [],
    duration: result.duration,
    timestamp: Date.now(),
    context: context || "",
  });
  if (audit.length > MAX_AUDIT) audit.splice(0, audit.length - MAX_AUDIT);
}

function getAudit(last) { return audit.slice(-(last || 50)); }
function auditSummary() {
  return {
    total: audit.length,
    blocked: audit.filter(a => a.blocked).length,
    warned: audit.filter(a => a.warnings.length > 0).length,
    failed: audit.filter(a => a.exitCode !== 0 && !a.blocked).length,
    avgDuration: audit.length ? Math.round(audit.reduce((s, a) => s + a.duration, 0) / audit.length) : 0,
  };
}

module.exports = { validate, execute, logExecution, getAudit, auditSummary, BLOCKED, WARNED };
