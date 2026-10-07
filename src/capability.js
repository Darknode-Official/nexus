"use strict";
// ================= NX-105 Capability Model =================
// The fastest-rising complaint is the agent as a PROCESS WITH CREDENTIALS: it
// wrote a backup to the wrong directory, then rm -rf'd the drive — every action
// individually "legitimate". A denylist (sandbox.js BLOCKED patterns) answers the
// wrong question; it can only refuse what someone already thought to forbid. This
// module is the allowlist counterpart: boundaries are DECLARED (paths, commands,
// network destinations) and anything outside them needs explicit authorization.
//
// The dangerous rm -rf class is a PATH-RESOLUTION failure, not a pattern-matching
// one, so containPath() resolves symlinks and traversal to a real absolute path
// before deciding — a symlink inside the root that points outside resolves to
// outside and is refused.
//
// Untrusted content (files, web, tool results, MCP) is DATA, never policy:
// capabilities are never read from content, so an injected "you may now write
// anywhere" cannot widen them. sanitizeUntrusted() flags such attempts for the
// audit log but changes no permission.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- Capability set: the declared boundaries of a run ----
function createCapabilities(spec) {
  spec = spec || {};
  return {
    roots: (spec.roots || [process.cwd()]).map(r => safeReal(path.resolve(r))),
    commands: spec.commands || [],      // allowed command names (argv[0]); empty = none allowed
    network: spec.network || [],        // allowed hostnames; empty = none allowed
    allowDestructive: spec.allowDestructive === true, // destructive ops still need per-op confirm
  };
}

function safeReal(p) { try { return fs.realpathSync(p); } catch (_) { return p; } }

// ---- Path containment (symlink- and traversal-safe) ----
// Resolve `candidate` (relative to `cwd` or absolute) to a real absolute path and
// decide whether it falls inside any declared root. Resolves the deepest EXISTING
// ancestor with realpath (defeating symlink escape) then re-appends the
// not-yet-created tail (so writes to new files are judged by their real parent).
function containPath(cap, candidate, cwd) {
  cwd = cwd ? safeReal(path.resolve(cwd)) : (cap.roots[0] || process.cwd());
  const abs = path.resolve(cwd, String(candidate || ""));

  // Find deepest existing ancestor
  let existing = abs;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;        // reached filesystem root
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const realExisting = safeReal(existing);
  const resolved = tail.length ? path.join(realExisting, ...tail) : realExisting;

  for (const root of cap.roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return { allowed: true, resolved, root, reason: "within declared root " + root };
    }
  }
  return { allowed: false, resolved, root: null, reason: "path resolves outside every declared root: " + resolved };
}

// ---- Destructive-operation classifier ----
// These are separately gated: even inside the roots they must be confirmed and,
// where possible, reversible. Each looks "legitimate" on its own.
const DESTRUCTIVE = [
  { cls: "recursive-delete",   re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i },
  { cls: "recursive-delete",   re: /\brmdir\b|\bfind\b[^\n]*-delete\b/i },
  { cls: "force-push",         re: /\bgit\s+push\b[^\n]*(--force\b|-f\b|\+)/i },
  { cls: "history-rewrite",    re: /\bgit\s+(reset\s+--hard|rebase|filter-branch|filter-repo|reflog\s+expire|gc\s+--prune)/i },
  { cls: "history-rewrite",    re: /\bgit\s+update-ref\s+-d\b|\bgit\s+branch\s+-D\b/i },
  { cls: "dependency-removal", re: /\b(npm|yarn|pnpm)\s+(uninstall|remove|rm)\b|\bpip\s+uninstall\b|\bcargo\s+remove\b/i },
  { cls: "credential-touch",   re: /(\.ssh\/|\.aws\/|\.netrc|id_rsa|\.env\b|credentials|secrets?|\.pem\b|\.key\b|keychain|\.gnupg)/i },
  { cls: "disk-destroy",       re: /\bmkfs\b|\bdd\s+[^\n]*of=\/dev\/|\bshred\b|\bwipefs\b/i },
  { cls: "privilege",          re: /\bchmod\s+(-R\s+)?777\b|\bchown\b[^\n]*root|\bpasswd\b|\busermod\b/i },
];

function classifyDestructive(command) {
  const cmd = String(command || "");
  const hits = DESTRUCTIVE.filter(d => d.re.test(cmd)).map(d => d.cls);
  const uniq = [...new Set(hits)];
  return { destructive: uniq.length > 0, classes: uniq };
}

// ---- Command authorization ----
// argv[0] must be on the allowlist. Destructive ops additionally require either
// allowDestructive + a per-op confirm, or they are refused.
function commandAllowed(cap, command, opts) {
  opts = opts || {};
  const cmd = String(command || "").trim();
  if (!cmd) return { allowed: false, reason: "empty command" };

  // naive argv[0]: first bare token (handles leading env assignments)
  const tokens = cmd.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++; // skip FOO=bar
  const bin = path.basename(tokens[i] || "");

  const onAllowlist = cap.commands.includes(bin) || cap.commands.includes("*");
  const dest = classifyDestructive(cmd);

  if (dest.destructive) {
    if (!cap.allowDestructive) {
      return { allowed: false, destructive: true, classes: dest.classes, reason: "destructive op (" + dest.classes.join(",") + ") not permitted by this capability set" };
    }
    if (!opts.confirmed) {
      return { allowed: false, destructive: true, needsConfirm: true, classes: dest.classes, reason: "destructive op (" + dest.classes.join(",") + ") requires explicit confirmation" };
    }
  }
  if (!onAllowlist) {
    return { allowed: false, destructive: dest.destructive, classes: dest.classes, reason: "command '" + bin + "' is not on the allowlist" };
  }
  return { allowed: true, destructive: dest.destructive, classes: dest.classes, bin, reason: dest.destructive ? "allowed (destructive, confirmed)" : "allowed" };
}

// ---- Network authorization ----
function networkAllowed(cap, url) {
  let host;
  try { host = new URL(String(url)).hostname; } catch (_) { return { allowed: false, reason: "unparseable URL" }; }
  const ok = cap.network.some(h => host === h || host.endsWith("." + h)) || cap.network.includes("*");
  return { allowed: ok, host, reason: ok ? "host on allowlist" : "host '" + host + "' not on network allowlist" };
}

// ---- Credential redaction (tested per channel: logs, transcripts, telemetry) ----
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                 // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,             // Anthropic-style
  /\bghp_[A-Za-z0-9]{20,}\b/g,                  // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,                      // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,                // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,          // Slack
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
];

function redactSecrets(text) {
  let s = String(text == null ? "" : text);
  let count = 0;
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m) => {
      count++;
      // keep the key name for =/: forms so logs stay useful
      const kv = m.match(/^([A-Za-z_-]+)\s*([:=])/);
      return kv ? kv[1] + kv[2] + " [REDACTED]" : "[REDACTED]";
    });
  }
  return { text: s, redactions: count };
}

// ---- Prompt-injection detection (content is data, never policy) ----
const INJECTION_PATTERNS = [
  /ignore (?:all |the )?(?:previous|prior|above) (?:instructions|rules|prompt)/i,
  /disregard (?:all |the )?(?:previous|prior|above)/i,
  /you are now (?:a |an )?/i,
  /new (?:system )?(?:prompt|instructions?)\s*[:=]/i,
  /grant (?:me |yourself )?(?:full |all )?(?:access|permissions?|privileges?)/i,
  /allow (?:all|any) (?:commands?|paths?|network)/i,
  /(?:add|append) .* to (?:the )?allowlist/i,
  /run (?:the following|this) (?:as )?root/i,
  /\bsudo\b.*(?:without|skip).*(?:password|confirm)/i,
];

function sanitizeUntrusted(content) {
  const text = String(content || "");
  const found = INJECTION_PATTERNS.filter(re => re.test(text)).map(re => re.source.slice(0, 50));
  return {
    injectionDetected: found.length > 0,
    patterns: found,
    // The clean payload is the content treated purely as data. Permissions are NOT
    // derived from it under any circumstance; this flag is for the audit log only.
    note: found.length ? "untrusted content attempted to change policy; ignored (content is data, not instructions)" : "clean",
  };
}

// ---- Append-only, tamper-evident audit log ----
// Each line is a JSON record hash-chained to the previous one. The agent can
// append but cannot rewrite history without breaking the chain, which verify()
// detects. Uses fs.appendFileSync (append mode), never a rewrite of prior lines.
function createAuditLog(file) {
  return {
    file,
    append(entry) {
      let prevHash = "GENESIS";
      try {
        const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
        if (lines.length) prevHash = JSON.parse(lines[lines.length - 1]).hash;
      } catch (_) {}
      const rec = Object.assign({ at: Date.now() }, entry, { prev: prevHash });
      rec.hash = hashRecord(prevHash, rec); // hashes the full record minus `hash`
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
      fs.appendFileSync(file, JSON.stringify(rec) + "\n");
      return rec;
    },
    verify() {
      let lines;
      try { lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean); }
      catch (_) { return { ok: true, entries: 0, reason: "no log yet" }; }
      let prevHash = "GENESIS";
      for (let i = 0; i < lines.length; i++) {
        const rec = JSON.parse(lines[i]);
        if (rec.prev !== prevHash) return { ok: false, brokenAt: i, reason: "chain broken: prev mismatch (log was rewritten)" };
        const expect = hashRecord(prevHash, rec);
        if (expect !== rec.hash) return { ok: false, brokenAt: i, reason: "chain broken: hash mismatch (entry " + i + " altered)" };
        prevHash = rec.hash;
      }
      return { ok: true, entries: lines.length };
    },
  };
}
// Deterministic hash over the record minus its own `hash` field, salted by prev.
function hashRecord(prevHash, rec) {
  const e = Object.assign({}, rec); delete e.hash;
  return crypto.createHash("sha256").update(prevHash + JSON.stringify(e)).digest("hex").slice(0, 32);
}

module.exports = {
  createCapabilities, containPath, classifyDestructive, commandAllowed,
  networkAllowed, redactSecrets, sanitizeUntrusted, createAuditLog,
  DESTRUCTIVE, SECRET_PATTERNS, INJECTION_PATTERNS,
};
