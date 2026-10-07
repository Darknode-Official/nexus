"use strict";
// ============================= Shellplan — risk classification =============================
// A deterministic, explainable risk engine. NO LLM. Each rule inspects the parsed
// command (and, where a regex is clearer, the raw text) and emits a finding:
//   { id, severity, category, title, rationale, saferAlternative, match }
//
// Severities: "critical" > "high" > "medium" > "low" > "info".
// Categories: destructive, network, privilege, secret, obfuscation, instability.
//
// This complements the enforcement layers: ../sandbox.js BLOCKED/WARNED decides
// yes/no; this module EXPLAINS why a command is risky and what to do instead, so
// the agent can surface an informed choice before enforcement runs.

const { decomposeCommand } = require("./decompose");

const SEVERITY_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Rule table. Each rule has:
 *   id, severity, category, title, rationale, saferAlternative
 *   test(ctx) -> boolean | {match:string}   (ctx = { raw, commands })
 * Rules run against the whole command line; `commands` is the decomposed list so a
 * rule can be precise (check a specific program + flags) instead of only regex.
 */
const RULES = [
  // ------------------------------- DESTRUCTIVE -------------------------------
  {
    id: "rm-rf-root",
    severity: "critical",
    category: "destructive",
    title: "Recursive force-delete of a root/home path",
    rationale: "`rm -rf` on /, ~, or a bare root path can wipe the entire system or home directory irreversibly.",
    saferAlternative: "Target an explicit project-relative subdirectory, or move to trash; dry-run with `ls` first.",
    test(ctx) {
      for (const c of ctx.simple) {
        if (c.effectiveBase !== "rm") continue;
        if (!hasRecursiveForce(c)) continue;
        for (const op of c.operands) {
          const p = op.replace(/["']/g, "");
          if (p === "/" || p === "/*" || p === "~" || p === "~/" || p === "$HOME" || p === "${HOME}" || /^\/(etc|usr|bin|boot|var|lib|sys|dev|home)(\/\*?)?$/.test(p)) return { match: "rm -rf " + op };
        }
      }
      return false;
    },
  },
  {
    id: "rm-rf",
    severity: "high",
    category: "destructive",
    title: "Recursive force-delete",
    rationale: "`rm -rf` deletes directories and all contents with no confirmation and no recovery.",
    saferAlternative: "Delete specific files, use `git clean -n` to preview, or move to a trash dir instead of hard-deleting.",
    test(ctx) {
      return ctx.simple.some(c => c.effectiveBase === "rm" && hasRecursiveForce(c)) ? { match: "rm -rf" } : false;
    },
  },
  {
    id: "rm-glob",
    severity: "medium",
    category: "destructive",
    title: "Delete with a wildcard",
    rationale: "A glob in an rm target can match far more than intended, especially if a variable expands unexpectedly.",
    saferAlternative: "List what the glob matches first (`ls <glob>`), or enumerate files explicitly.",
    test(ctx) {
      return ctx.simple.some(c => c.effectiveBase === "rm" && c.operands.some(o => /[*?]/.test(o))) ? { match: "rm with glob" } : false;
    },
  },
  {
    id: "dd-device",
    severity: "critical",
    category: "destructive",
    title: "Raw disk write with dd",
    rationale: "`dd of=/dev/...` writes directly to a block device, destroying existing partitions/data.",
    saferAlternative: "Double-check the device node with `lsblk`; write to a file image instead of a device when possible.",
    test(ctx) { return /\bdd\b[^\n]*\bof=\/dev\//.test(ctx.raw) ? { match: "dd of=/dev/" } : false; },
  },
  {
    id: "mkfs",
    severity: "critical",
    category: "destructive",
    title: "Filesystem format",
    rationale: "`mkfs`/`wipefs` erases a filesystem and all its data.",
    saferAlternative: "Confirm the target device is correct and unmounted; back up first. Rarely needed from an agent.",
    test(ctx) { return /\b(mkfs(\.\w+)?|wipefs)\b/.test(ctx.raw) ? { match: "mkfs/wipefs" } : false; },
  },
  {
    id: "fork-bomb",
    severity: "critical",
    category: "destructive",
    title: "Fork bomb",
    rationale: "A self-replicating function spawns processes exponentially until the machine is unusable.",
    saferAlternative: "Never run this. If testing limits, use `ulimit -u` in a disposable container.",
    test(ctx) { return /:?\(\)\s*\{\s*:?\s*\|\s*:?\s*&\s*\}\s*;?\s*:/.test(ctx.raw) ? { match: "fork bomb pattern" } : false; },
  },
  {
    id: "git-reset-hard",
    severity: "high",
    category: "destructive",
    title: "git reset --hard",
    rationale: "Discards all uncommitted changes in the working tree and index; they cannot be recovered.",
    saferAlternative: "`git stash` to preserve changes, or `git reset --hard` only after confirming nothing is unsaved.",
    test(ctx) { return ctx.simple.some(c => c.canonical.tool === "git" && c.canonical.subcommand === "reset" && c.canonical.subArgs.includes("--hard")) ? { match: "git reset --hard" } : false; },
  },
  {
    id: "git-clean-fd",
    severity: "high",
    category: "destructive",
    title: "git clean -fd",
    rationale: "Permanently removes untracked files and directories, including ones you may have forgotten to add.",
    saferAlternative: "Run `git clean -nd` first to preview exactly what would be removed.",
    test(ctx) {
      return ctx.simple.some(c => c.canonical.tool === "git" && c.canonical.subcommand === "clean" &&
        c.canonical.subArgs.some(a => /^-[a-z]*f/.test(a))) ? { match: "git clean -f" } : false;
    },
  },
  {
    id: "git-force-push",
    severity: "high",
    category: "destructive",
    title: "Force push",
    rationale: "`git push --force` can overwrite remote history and clobber teammates' commits.",
    saferAlternative: "Use `--force-with-lease`, which refuses to overwrite work you haven't seen.",
    test(ctx) {
      return ctx.simple.some(c => c.canonical.tool === "git" && c.canonical.subcommand === "push" &&
        c.canonical.subArgs.some(a => a === "--force" || a === "-f" || a.startsWith("+")) &&
        !c.canonical.subArgs.some(a => a.startsWith("--force-with-lease"))) ? { match: "git push --force" } : false;
    },
  },
  {
    id: "truncate-redirect",
    severity: "low",
    category: "destructive",
    title: "Output redirection truncates a file",
    rationale: "`> file` replaces the file's entire contents; an existing file is overwritten without warning.",
    saferAlternative: "Use `>>` to append, or write to a new path and review before replacing.",
    test(ctx) {
      return ctx.simple.some(c => (c.redirs || []).some(r => (r.op === ">" || r.op === ">|") && r.target)) ? { match: "> file" } : false;
    },
  },

  // --------------------------------- NETWORK ---------------------------------
  {
    id: "pipe-to-shell",
    severity: "critical",
    category: "network",
    title: "Pipe remote content directly into a shell",
    rationale: "`curl ... | sh` executes code downloaded from the network with no review — a classic supply-chain/compromise vector.",
    saferAlternative: "Download to a file, inspect it, verify a checksum/signature, then run it deliberately.",
    test(ctx) { return /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(ctx.raw) ? { match: "curl | sh" } : false; },
  },
  {
    id: "remote-exec-eval",
    severity: "high",
    category: "network",
    title: "Execute downloaded content via eval/bash -c",
    rationale: "Wrapping a network fetch in eval/`bash -c \"$(...)\"` runs unreviewed remote code.",
    saferAlternative: "Fetch to a file and inspect before executing.",
    test(ctx) { return /\b(eval|bash\s+-c|sh\s+-c)\b[^\n]*\$\(\s*(curl|wget)/.test(ctx.raw) ? { match: "eval $(curl ...)" } : false; },
  },
  {
    id: "netcat-listen-exec",
    severity: "critical",
    category: "network",
    title: "Netcat bind/reverse shell",
    rationale: "`nc -e`/`nc -l ... -e` wires a shell to a network socket — a reverse/bind shell backdoor.",
    saferAlternative: "Do not expose a shell over the network. Use SSH with key auth for remote access.",
    test(ctx) { return /\b(nc|ncat|netcat)\b[^\n]*(-e\b|-c\b|\s-lp?\b[^\n]*-e)/.test(ctx.raw) ? { match: "nc -e" } : false; },
  },
  {
    id: "scp-remote-out",
    severity: "medium",
    category: "network",
    title: "Copy files to a remote host",
    rationale: "`scp`/`rsync` to a `user@host:` destination exfiltrates local files off the machine.",
    saferAlternative: "Confirm the destination host is trusted and the files are intended to leave the machine.",
    test(ctx) { return /\b(scp|rsync|sftp)\b[^\n]*\s[\w.-]+@[\w.-]+:/.test(ctx.raw) ? { match: "scp to remote" } : false; },
  },
  {
    id: "download-file",
    severity: "low",
    category: "network",
    title: "Download a file from the internet",
    rationale: "Fetching remote content introduces data of unknown provenance into the workspace.",
    saferAlternative: "Prefer pinned, checksum-verified sources; review downloaded files before use.",
    test(ctx) {
      return ctx.simple.some(c => (c.effectiveBase === "curl" && (c.flags.some(f => /o/.test(f.name) ) || c.operands.some(o => /^https?:/.test(o)))) ||
        c.effectiveBase === "wget") ? { match: "curl/wget download" } : false;
    },
  },

  // -------------------------------- PRIVILEGE --------------------------------
  {
    id: "sudo",
    severity: "medium",
    category: "privilege",
    title: "Elevated privileges via sudo",
    rationale: "`sudo` runs the command as root; mistakes have system-wide impact and bypass workspace boundaries.",
    saferAlternative: "Run unprivileged where possible; scope changes to the project directory.",
    test(ctx) { return ctx.simple.some(c => c.programBase === "sudo" || c.programBase === "doas") ? { match: "sudo" } : false; },
  },
  {
    id: "sudo-destructive",
    severity: "critical",
    category: "privilege",
    title: "Destructive command run as root",
    rationale: "A destructive operation combined with sudo removes the last guard rails — root can delete anything.",
    saferAlternative: "Never combine sudo with rm -rf / dd / mkfs from an agent. Do it manually, deliberately.",
    test(ctx) {
      const sudo = ctx.simple.some(c => c.programBase === "sudo");
      const destructive = /\brm\s+-[a-z]*r|\bdd\b|\bmkfs|\bchmod\s+(-R\s+)?777/.test(ctx.raw);
      return sudo && destructive ? { match: "sudo + destructive" } : false;
    },
  },
  {
    id: "chmod-777",
    severity: "high",
    category: "privilege",
    title: "World-writable permissions (chmod 777)",
    rationale: "Mode 777 lets any user read, write, and execute — a serious security misconfiguration.",
    saferAlternative: "Grant the minimum needed (e.g. 644 for files, 755 for dirs); use groups for shared access.",
    test(ctx) { return /\bchmod\s+(-R\s+)?(0?777|a\+rwx|ugo\+rwx)\b/.test(ctx.raw) ? { match: "chmod 777" } : false; },
  },
  {
    id: "chown-root",
    severity: "medium",
    category: "privilege",
    title: "Change ownership to root",
    rationale: "Reassigning ownership to root can lock the agent out of its own files or escalate trust.",
    saferAlternative: "Keep project files owned by the working user.",
    test(ctx) { return /\bchown\b[^\n]*\broot\b/.test(ctx.raw) ? { match: "chown root" } : false; },
  },
  {
    id: "add-sudoers",
    severity: "critical",
    category: "privilege",
    title: "Modify sudoers / user privileges",
    rationale: "Editing sudoers or adding a user to the sudo group is a persistent privilege-escalation change.",
    saferAlternative: "Manage privileges out-of-band with full human review.",
    test(ctx) { return /(\/etc\/sudoers|usermod\b[^\n]*-aG?\s+(sudo|wheel|admin)|visudo)/.test(ctx.raw) ? { match: "sudoers change" } : false; },
  },

  // ---------------------------------- SECRET ---------------------------------
  {
    id: "read-secret-file",
    severity: "high",
    category: "secret",
    title: "Read a credential/key file",
    rationale: "Printing private keys, .env, or credential files risks leaking secrets into logs or model context.",
    saferAlternative: "Reference secrets by env var without printing them; never cat key material.",
    test(ctx) {
      return ctx.simple.some(c => /^(cat|less|more|head|tail|bat|xxd|od|strings)$/.test(c.effectiveBase) &&
        c.operands.some(o => /(\.ssh\/|id_rsa|id_ed25519|\.pem\b|\.key\b|\.env\b|credentials|\.aws\/|\.netrc|secrets?)/i.test(o))) ? { match: "cat secret file" } : false;
    },
  },
  {
    id: "print-env",
    severity: "medium",
    category: "secret",
    title: "Dump the environment",
    rationale: "`env`/`printenv`/`export -p` can reveal API keys and tokens stored in environment variables.",
    saferAlternative: "Inspect a single known-safe variable instead of dumping the whole environment.",
    test(ctx) {
      return ctx.simple.some(c => (c.effectiveBase === "env" && c.operands.length === 0 && c.flags.length === 0) ||
        c.effectiveBase === "printenv" || (c.effectiveBase === "export" && c.flags.some(f => f.name === "-p"))) ? { match: "env dump" } : false;
    },
  },
  {
    id: "shadow-access",
    severity: "high",
    category: "secret",
    title: "Access /etc/shadow",
    rationale: "/etc/shadow holds password hashes; reading or copying it is a credential-theft indicator.",
    saferAlternative: "There is no legitimate agent reason to read this file.",
    test(ctx) { return /\/etc\/shadow\b/.test(ctx.raw) ? { match: "/etc/shadow" } : false; },
  },
  {
    id: "history-exfil",
    severity: "medium",
    category: "secret",
    title: "Read shell history",
    rationale: "Shell history files often contain pasted tokens, passwords, and private commands.",
    saferAlternative: "Avoid exporting history; scrub secrets from history if they were pasted.",
    test(ctx) { return /(\.bash_history|\.zsh_history|\.python_history)\b/.test(ctx.raw) ? { match: "shell history" } : false; },
  },

  // ------------------------------- OBFUSCATION -------------------------------
  {
    id: "base64-exec",
    severity: "high",
    category: "obfuscation",
    title: "Decode and execute base64",
    rationale: "Piping `base64 -d` into a shell hides the real payload from review.",
    saferAlternative: "Decode to a file and inspect the contents before running anything.",
    test(ctx) { return /\bbase64\b[^\n]*(-d|--decode)[^\n]*\|\s*(ba|z|da|k)?sh\b/.test(ctx.raw) ? { match: "base64 -d | sh" } : false; },
  },
  {
    id: "obfuscated-eval",
    severity: "medium",
    category: "obfuscation",
    title: "eval of a dynamic/encoded string",
    rationale: "`eval` on constructed or decoded strings executes code that is not visible in the command as written.",
    saferAlternative: "Avoid eval; run the intended command directly so it can be reviewed.",
    test(ctx) { return /\beval\b[^\n]*(\$\(|`|base64|xxd|tr\b)/.test(ctx.raw) ? { match: "eval of dynamic string" } : false; },
  },
  {
    id: "history-disable",
    severity: "medium",
    category: "obfuscation",
    title: "Disable shell history",
    rationale: "Unsetting HISTFILE or `set +o history` hides subsequent commands — a common anti-forensics step.",
    saferAlternative: "No legitimate reason for an agent to disable history.",
    test(ctx) { return /(unset\s+HISTFILE|HISTFILE=\s*($|;|\s)|set\s+\+o\s+history|export\s+HISTSIZE=0)/.test(ctx.raw) ? { match: "history disabled" } : false; },
  },

  // ------------------------------- INSTABILITY -------------------------------
  {
    id: "kill-9-broad",
    severity: "medium",
    category: "instability",
    title: "Force-kill processes",
    rationale: "`kill -9` / `killall` / `pkill` can terminate critical processes without clean shutdown; a broad match may kill unrelated work.",
    saferAlternative: "Target a specific PID, try a graceful signal (SIGTERM) first.",
    test(ctx) { return ctx.simple.some(c => (c.effectiveBase === "kill" && c.effectiveArgv.some(a => a === "-9" || a === "-KILL")) || c.effectiveBase === "killall" || c.effectiveBase === "pkill") ? { match: "force kill" } : false; },
  },
  {
    id: "reboot-shutdown",
    severity: "high",
    category: "instability",
    title: "Reboot or power off the machine",
    rationale: "Halting or rebooting terminates the session and any in-flight work.",
    saferAlternative: "Almost never appropriate from an agent; confirm with a human.",
    test(ctx) { return ctx.simple.some(c => /^(reboot|shutdown|halt|poweroff|init)$/.test(c.effectiveBase)) ? { match: "reboot/shutdown" } : false; },
  },
  {
    id: "overwrite-dev-null-glob",
    severity: "medium",
    category: "instability",
    title: "chmod/chown recursive on a broad path",
    rationale: "Recursive permission/ownership changes over a large or system path can break the system or be slow and irreversible.",
    saferAlternative: "Scope the recursion to a specific project subdirectory.",
    test(ctx) { return /\b(chmod|chown)\s+-R\b[^\n]*(\s\/(etc|usr|var|bin|home)\b|\s\/\s|\s~\b)/.test(ctx.raw) ? { match: "recursive chmod/chown on system path" } : false; },
  },
];

function hasRecursiveForce(c) {
  // recognize -rf, -fr, -r -f, --recursive --force, grouped letters
  const args = c.effectiveArgv.slice(1);
  const hasR = args.some(a => /^-[a-z]*r/.test(a) || a === "--recursive");
  const hasF = args.some(a => /^-[a-z]*f/.test(a) || a === "--force");
  return hasR && hasF;
}

/**
 * Classify the risk of a command line.
 * @param {string} cmd
 * @returns {{findings:Array, maxSeverity:string, score:number, byCategory:Object, errors:string[]}}
 */
function classify(cmd) {
  const { commands, errors } = decomposeCommand(cmd);
  const simple = commands.filter(c => c.kind === "simple");
  const ctx = { raw: String(cmd == null ? "" : cmd), commands, simple };

  const findings = [];
  for (const rule of RULES) {
    let res;
    try { res = rule.test(ctx); } catch (_) { res = false; }
    if (res) {
      findings.push({
        id: rule.id,
        severity: rule.severity,
        category: rule.category,
        title: rule.title,
        rationale: rule.rationale,
        saferAlternative: rule.saferAlternative,
        match: res && res.match ? res.match : rule.title,
      });
    }
  }

  let maxSeverity = "info";
  for (const f of findings) if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[maxSeverity]) maxSeverity = f.severity;

  const byCategory = {};
  for (const f of findings) (byCategory[f.category] = byCategory[f.category] || []).push(f.id);

  return { findings, maxSeverity, score: riskScore(findings), byCategory, errors };
}

/** A single 0-100 risk score, weighted by severity, saturating. */
function riskScore(findings) {
  const weight = { info: 0, low: 8, medium: 20, high: 40, critical: 70 };
  let s = 0;
  for (const f of findings) s += weight[f.severity] || 0;
  return Math.min(100, s);
}

function severityRank(sev) { return SEVERITY_ORDER[sev] != null ? SEVERITY_ORDER[sev] : -1; }

module.exports = {
  classify,
  riskScore,
  severityRank,
  RULES,
  SEVERITY_ORDER,
};
