"use strict";
// ============================= Shellplan — file-target extraction =============================
// Statically determine which paths a command READS, WRITES, or DELETES. This feeds
// the agent's impact awareness ("this will overwrite 3 files, delete 1") BEFORE
// anything runs. It combines three signals:
//   1. redirections (`> f` writes, `>> f` appends, `< f` reads, heredocs)
//   2. known tool semantics (cp/mv/rm/tee/dd/sed -i/truncate/ln/mkdir/touch/...)
//   3. a conservative argv fallback (operands that look like paths → read)
// Each target carries a confidence level. We never stat the filesystem or expand
// globs/vars — this is a static estimate, so `$VAR`/`*` are reported as dynamic.

const { decomposeCommand } = require("./decompose");

/** Access kinds. */
const READ = "read";
const WRITE = "write";
const DELETE = "delete";

/**
 * Per-tool operand semantics. Each entry maps a canonical tool (or tool:subcommand)
 * to a function (operands, flags, rec) -> targets[]. Kept data-driven and explicit.
 */
const TOOL_SEMANTICS = {
  // --- copy / move / link: last operand is the destination (write), rest read ---
  cp(ops) { return srcDest(ops, READ, WRITE); },
  install(ops) { return srcDest(ops, READ, WRITE); },
  mv(ops) { return srcDest(ops, DELETE, WRITE, /*srcDeletedOnMove*/ true); },
  rsync(ops) { return srcDest(ops, READ, WRITE); },
  ln(ops) { return srcDest(ops, READ, WRITE); },

  // --- deletion ---
  rm(ops) { return ops.map(p => mk(p, DELETE, 0.95, "rm removes its operands")); },
  rmdir(ops) { return ops.map(p => mk(p, DELETE, 0.9, "rmdir removes the directory")); },
  unlink(ops) { return ops.map(p => mk(p, DELETE, 0.95, "unlink removes the file")); },
  shred(ops) { return ops.map(p => mk(p, DELETE, 0.95, "shred overwrites then removes")); },

  // --- creation / truncation ---
  touch(ops) { return ops.map(p => mk(p, WRITE, 0.8, "touch creates/updates the file")); },
  mkdir(ops) { return ops.map(p => mk(p, WRITE, 0.85, "mkdir creates the directory")); },
  truncate(ops, flags) { return ops.map(p => mk(p, WRITE, 0.9, "truncate resizes the file")); },

  // --- read-mostly tools ---
  cat(ops) { return ops.map(p => mk(p, READ, 0.9, "cat reads its operands")); },
  less(ops) { return ops.map(p => mk(p, READ, 0.9, "pager reads the file")); },
  more(ops) { return ops.map(p => mk(p, READ, 0.9, "pager reads the file")); },
  head(ops) { return ops.map(p => mk(p, READ, 0.85, "head reads the file")); },
  tail(ops) { return ops.map(p => mk(p, READ, 0.85, "tail reads the file")); },
  grep(ops) { return ops.slice(1).map(p => mk(p, READ, 0.7, "grep reads file operands (first is the pattern)")); },
  wc(ops) { return ops.map(p => mk(p, READ, 0.85, "wc reads the file")); },
  sort(ops) { return ops.map(p => mk(p, READ, 0.8, "sort reads the file")); },
  diff(ops) { return ops.map(p => mk(p, READ, 0.85, "diff reads both files")); },
  md5sum(ops) { return ops.map(p => mk(p, READ, 0.9, "checksum reads the file")); },
  sha256sum(ops) { return ops.map(p => mk(p, READ, 0.9, "checksum reads the file")); },

  // --- tee writes to its file operands ---
  tee(ops, flags) {
    const append = flags.some(f => f.name === "-a" || f.name === "--append" || (f.letters && f.letters.includes("a")));
    return ops.map(p => mk(p, WRITE, 0.9, append ? "tee appends to the file" : "tee overwrites the file", { append }));
  },

  // --- dd: if=read of=write ---
  dd(ops, flags, rec) {
    const t = [];
    for (const a of (rec.effectiveArgv || rec.argv).slice(1)) {
      if (a.startsWith("if=")) t.push(mk(a.slice(3), READ, 0.9, "dd input file"));
      if (a.startsWith("of=")) t.push(mk(a.slice(3), WRITE, 0.95, "dd output (overwrites)"));
    }
    return t;
  },

  // --- sed: -i edits in place (write), otherwise reads ---
  sed(ops, flags, rec) {
    const inPlace = flags.some(f => f.name === "-i" || (f.name && f.name.startsWith("-i")) || f.name === "--in-place" || (f.letters && f.letters.includes("i")));
    // first operand is the script, the rest are files
    const files = ops.slice(1);
    return files.map(p => mk(p, inPlace ? WRITE : READ, inPlace ? 0.85 : 0.75, inPlace ? "sed -i edits the file in place" : "sed reads the file"));
  },
  awk(ops) { return ops.slice(1).map(p => mk(p, READ, 0.65, "awk reads file operands (first is the program)")); },

  // --- archive tools ---
  tar(ops, flags, rec) { return tarSemantics(rec); },

  // --- editors open for read+write ---
  vim(ops) { return ops.map(p => mk(p, WRITE, 0.5, "editor may modify the file")); },
  vi(ops) { return ops.map(p => mk(p, WRITE, 0.5, "editor may modify the file")); },
  nano(ops) { return ops.map(p => mk(p, WRITE, 0.5, "editor may modify the file")); },

  chmod(ops) { return ops.slice(1).map(p => mk(p, WRITE, 0.7, "chmod changes file mode (metadata write)")); },
  chown(ops) { return ops.slice(1).map(p => mk(p, WRITE, 0.7, "chown changes ownership (metadata write)")); },
};

function srcDest(ops, srcKind, destKind, srcDeleted) {
  if (ops.length < 2) return ops.map(p => mk(p, srcKind, 0.6, "single operand"));
  const dest = ops[ops.length - 1];
  const srcs = ops.slice(0, -1);
  const out = srcs.map(p => mk(p, srcKind, 0.8, srcDeleted ? "source removed after move" : "source read"));
  out.push(mk(dest, destKind, 0.85, "destination written"));
  return out;
}

function tarSemantics(rec) {
  const argv = (rec.effectiveArgv || rec.argv).slice(1);
  const joined = argv.join(" ");
  const creating = /(^|\s)-?c/.test(argv[0] || "") || argv.some(a => /^-?c/.test(a) && !a.startsWith("--")) || argv.includes("--create");
  const extracting = /(^|\s)-?x/.test(argv[0] || "") || argv.includes("--extract");
  // -f <archive>
  const out = [];
  let archive = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-f" || argv[i] === "--file") { archive = argv[i + 1]; break; }
    const m = /^-[A-Za-z]*f$/.exec(argv[i]); // e.g. -czf  (archive is next operand)
    if (m) { archive = argv[i + 1]; break; }
  }
  if (archive) out.push(mk(archive, creating ? WRITE : READ, 0.75, creating ? "tar writes the archive" : "tar reads the archive"));
  if (extracting) out.push({ path: "(archive contents)", access: WRITE, confidence: 0.5, reason: "tar -x extracts files into cwd", dynamic: true });
  return out;
}

function mk(path, access, confidence, reason, extra) {
  return Object.assign({
    path,
    access,
    confidence,
    reason,
    dynamic: isDynamic(path),
  }, extra || {});
}

function isDynamic(path) {
  return /[$`*?]|~|\{.*\}/.test(String(path || ""));
}

function looksLikePath(op) {
  if (!op) return false;
  if (op.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(op)) return false; // URL (http://, ssh://, git://, ...)
  if (/^[\w.-]+@[\w.-]+:/.test(op)) return false;        // user@host: scp/rsync remote
  // paths: contain / or . extension, or ~, or known dotfiles
  return /[\/.]/.test(op) || /^~/.test(op) || /^\.[A-Za-z]/.test(op);
}

/**
 * Extract file targets from a single decomposed simple-command record.
 * @param {object} rec
 * @returns {Array<{path:string,access:string,confidence:number,reason:string,dynamic:boolean,source:string}>}
 */
function targetsForCommand(rec) {
  const targets = [];
  if (!rec || rec.kind !== "simple") {
    // still handle redirections on groups/subshells
    if (rec && rec.redirs) addRedirTargets(rec.redirs, targets);
    return targets;
  }

  // 1. tool semantics
  const tool = rec.canonical ? rec.canonical.tool : rec.programBase;
  const sem = TOOL_SEMANTICS[tool];
  if (sem) {
    try {
      const got = sem(rec.operands || [], rec.flags || [], rec) || [];
      for (const t of got) { t.source = "tool-semantics"; targets.push(t); }
    } catch (_) { /* defensive: never throw on malformed input */ }
  } else {
    // 3. conservative fallback: path-looking operands are reads
    for (const op of rec.operands || []) {
      if (looksLikePath(op)) targets.push(Object.assign(mk(op, READ, 0.35, "operand looks like a path (heuristic)"), { source: "heuristic" }));
    }
  }

  // 2. redirections always apply, on top of tool semantics
  addRedirTargets(rec.redirs, targets);

  return dedupe(targets);
}

function addRedirTargets(redirs, targets) {
  for (const r of redirs || []) {
    if (!r.target && !r.heredoc) continue;
    if (r.heredoc) continue; // heredoc body is inline data, not a file
    const p = r.target;
    if (r.op === ">" || r.op === ">|" || r.op === "&>") targets.push(Object.assign(mk(p, WRITE, 0.95, "redirection truncates/creates the file"), { source: "redirection" }));
    else if (r.op === ">>" || r.op === "&>>") targets.push(Object.assign(mk(p, WRITE, 0.95, "redirection appends to the file", { append: true }), { source: "redirection" }));
    else if (r.op === "<" || r.op === "<<<") targets.push(Object.assign(mk(p, READ, 0.9, "redirection reads the file"), { source: "redirection" }));
    else if (r.op === "2>" ) targets.push(Object.assign(mk(p, WRITE, 0.9, "stderr redirected (truncates)"), { source: "redirection" }));
    else if (r.op === "2>>") targets.push(Object.assign(mk(p, WRITE, 0.9, "stderr appended", { append: true }), { source: "redirection" }));
  }
}

function dedupe(targets) {
  const seen = new Map();
  for (const t of targets) {
    const key = t.path + "\u0000" + t.access;
    const prev = seen.get(key);
    if (!prev || t.confidence > prev.confidence) seen.set(key, t);
  }
  return [...seen.values()];
}

/**
 * Extract file targets for a whole command line (all simple commands).
 * @param {string} cmd
 * @returns {{reads:Array, writes:Array, deletes:Array, all:Array, errors:string[]}}
 */
function extractFileTargets(cmd) {
  const { commands, errors } = decomposeCommand(cmd);
  const all = [];
  for (const rec of commands) for (const t of targetsForCommand(rec)) all.push(Object.assign({ commandIndex: rec.index, program: rec.program }, t));
  return {
    reads: all.filter(t => t.access === READ),
    writes: all.filter(t => t.access === WRITE),
    deletes: all.filter(t => t.access === DELETE),
    all,
    errors,
  };
}

module.exports = {
  extractFileTargets,
  targetsForCommand,
  looksLikePath,
  isDynamic,
  TOOL_SEMANTICS,
  READ, WRITE, DELETE,
};
