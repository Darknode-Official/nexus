"use strict";
// ============================= Shellplan — human-readable explanation =============================
// Turns the parser AST + decomposition + file targets + risk findings into a plain
// step-by-step account of what a command does. The agent can show this to a user
// BEFORE running anything. Pure formatting over the other modules — no execution.

const { parse } = require("./parser");
const { decompose } = require("./decompose");
const { extractFileTargets } = require("./filetargets");
const { classify } = require("./risk");

/**
 * Describe a single simple-command record in one plain sentence.
 * @param {object} c
 * @returns {string}
 */
function describeSimple(c) {
  if (c.kind === "subshell") return "run a subshell group (its own isolated shell)";
  if (c.kind === "group") return "run a command group in the current shell";

  const canon = c.canonical || {};
  const verbs = PROGRAM_VERBS[c.programBase];
  let base;
  if (canon.subcommand && SUBCOMMAND_VERBS[canon.tool] && SUBCOMMAND_VERBS[canon.tool][canon.subcommand]) {
    base = SUBCOMMAND_VERBS[canon.tool][canon.subcommand];
  } else if (verbs) {
    base = verbs;
  } else if (canon.subcommand) {
    base = "run `" + canon.tool + "` subcommand `" + canon.subcommand + "`";
  } else {
    base = "run `" + (c.program || "(empty)") + "`";
  }

  const parts = [base];
  if (c.operands && c.operands.length) {
    const ops = c.operands.slice(0, 4).map(o => "`" + o + "`").join(", ");
    parts.push("on " + ops + (c.operands.length > 4 ? " (+" + (c.operands.length - 4) + " more)" : ""));
  }
  if (c.assignments && c.assignments.length) {
    parts.push("with env " + c.assignments.map(a => a.name + "=" + a.value).join(", "));
  }
  let sentence = parts.join(" ");

  // redirection clauses
  const redirClauses = describeRedirs(c.redirs);
  if (redirClauses.length) sentence += ", " + redirClauses.join(", ");
  return sentence;
}

function describeRedirs(redirs) {
  const out = [];
  for (const r of redirs || []) {
    if (r.heredoc) { out.push("reading inline heredoc input (<<" + r.heredoc.delim + ")"); continue; }
    if (r.dupTo != null) { out.push("merging fd " + r.fd + " into fd " + r.dupTo); continue; }
    if (!r.target) continue;
    if (r.op === ">" || r.op === ">|") out.push("overwriting `" + r.target + "`");
    else if (r.op === ">>") out.push("appending to `" + r.target + "`");
    else if (r.op === "<") out.push("reading from `" + r.target + "`");
    else if (r.op === "2>") out.push("sending errors to `" + r.target + "`");
    else if (r.op === "2>>") out.push("appending errors to `" + r.target + "`");
    else if (r.op === "&>" || r.op === "&>>") out.push("sending all output to `" + r.target + "`");
    else out.push(r.op + " `" + r.target + "`");
  }
  return out;
}

/** Verb phrases for common standalone programs. */
const PROGRAM_VERBS = {
  ls: "list directory contents",
  cat: "print file contents",
  echo: "print text",
  cp: "copy files",
  mv: "move/rename files",
  rm: "delete files",
  mkdir: "create a directory",
  rmdir: "remove a directory",
  touch: "create or update a file timestamp",
  grep: "search text for a pattern",
  find: "search the filesystem",
  sed: "transform text with a stream editor",
  awk: "process text with awk",
  curl: "make an HTTP request / download",
  wget: "download a file",
  tar: "archive or extract files",
  chmod: "change file permissions",
  chown: "change file ownership",
  kill: "send a signal to a process",
  ps: "list processes",
  tee: "write stdin to files and stdout",
  dd: "copy/convert raw data blocks",
  ssh: "open a remote shell",
  scp: "copy files over SSH",
  sudo: "run a command as another user (root)",
  node: "run a Node.js script",
  python: "run a Python script",
  python3: "run a Python script",
};

/** Verb phrases for canonical (tool, subcommand) pairs. */
const SUBCOMMAND_VERBS = {
  git: {
    status: "show git working-tree status",
    commit: "record a git commit",
    push: "upload commits to a remote",
    pull: "fetch and merge from a remote",
    clone: "clone a repository",
    checkout: "switch branches / restore files",
    reset: "move HEAD / unstage changes",
    clean: "remove untracked files",
    rebase: "reapply commits on another base",
    merge: "merge branches",
    add: "stage changes",
    branch: "manage branches",
    log: "show commit history",
    diff: "show changes",
    stash: "stash working changes",
  },
  npm: { install: "install npm dependencies", uninstall: "remove npm dependencies", run: "run an npm script", publish: "publish a package", ci: "clean-install from the lockfile", audit: "audit dependencies for vulnerabilities" },
  docker: { run: "run a container", build: "build an image", rm: "remove containers", rmi: "remove images", ps: "list containers", exec: "run a command in a container", "compose": "orchestrate multi-container apps" },
  kubectl: { apply: "apply a manifest to the cluster", delete: "delete cluster resources", get: "list cluster resources", exec: "run a command in a pod" },
};

/**
 * Produce a full explanation object + rendered text for a command line.
 * @param {string} cmd
 * @returns {{summary:string, steps:Array, structure:string, files:object, risk:object, text:string, errors:string[]}}
 */
function explain(cmd) {
  const ast = parse(cmd);
  const commands = decompose(ast);
  const files = extractFileTargets(cmd);
  const risk = classify(cmd);

  const steps = [];
  for (const c of commands) {
    const desc = describeSimple(c);
    const connectors = [];
    if (c.receivesPipe) connectors.push("receives piped input");
    if (c.pipedInto) connectors.push("its output is piped onward");
    if (c.connector === "&&") connectors.push("only if the previous step succeeded");
    if (c.connector === "||") connectors.push("only if the previous step failed");
    if (c.background) connectors.push("in the background");
    if (c.negated) connectors.push("exit status is negated");
    steps.push({
      index: c.index,
      program: c.program,
      description: desc,
      conditions: connectors,
      inSubshell: c.inSubshell,
    });
  }

  const structure = describeStructure(commands);
  const summary = buildSummary(commands, files, risk);

  const text = render(cmd, summary, steps, structure, files, risk, ast.errors);
  return { summary, steps, structure, files, risk, commands, text, errors: ast.errors };
}

function describeStructure(commands) {
  const simple = commands.filter(c => c.kind === "simple");
  const pipes = commands.filter(c => c.pipedInto).length;
  const bits = [];
  bits.push(simple.length + (simple.length === 1 ? " command" : " commands"));
  if (pipes) bits.push(pipes + (pipes === 1 ? " pipe" : " pipes"));
  if (commands.some(c => c.inSubshell)) bits.push("a subshell");
  if (commands.some(c => c.connector === "&&" || c.connector === "||")) bits.push("conditional chaining");
  if (commands.some(c => c.background)) bits.push("background execution");
  return bits.join(", ");
}

function buildSummary(commands, files, risk) {
  const progs = [...new Set(commands.filter(c => c.kind === "simple").map(c => c.programBase).filter(Boolean))];
  let s = "This runs " + (progs.length ? progs.map(p => "`" + p + "`").join(", ") : "an empty command") + ".";
  if (files.writes.length || files.deletes.length) {
    const effects = [];
    if (files.writes.length) effects.push("writes " + files.writes.length + " path(s)");
    if (files.deletes.length) effects.push("deletes " + files.deletes.length + " path(s)");
    s += " It " + effects.join(" and ") + ".";
  } else if (files.reads.length) {
    s += " It only reads files (no writes detected).";
  }
  if (risk.maxSeverity !== "info") s += " Highest risk: " + risk.maxSeverity + ".";
  return s;
}

function render(cmd, summary, steps, structure, files, risk, errors) {
  const L = [];
  L.push("COMMAND: " + cmd);
  L.push("");
  L.push("SUMMARY: " + summary);
  L.push("STRUCTURE: " + structure);
  L.push("");
  L.push("STEPS:");
  steps.forEach((s, i) => {
    let line = "  " + (i + 1) + ". " + s.description;
    if (s.conditions.length) line += " (" + s.conditions.join("; ") + ")";
    L.push(line);
  });
  if (files.all.length) {
    L.push("");
    L.push("FILE IMPACT:");
    for (const t of files.all) {
      L.push("  [" + t.access.toUpperCase() + "] " + t.path + "  (" + Math.round(t.confidence * 100) + "% confidence" + (t.dynamic ? ", dynamic" : "") + ") — " + t.reason);
    }
  }
  if (risk.findings.length) {
    L.push("");
    L.push("RISK (score " + risk.score + "/100, max " + risk.maxSeverity + "):");
    for (const f of risk.findings) {
      L.push("  [" + f.severity.toUpperCase() + "/" + f.category + "] " + f.title);
      L.push("      why: " + f.rationale);
      L.push("      safer: " + f.saferAlternative);
    }
  } else {
    L.push("");
    L.push("RISK: no risk rules matched.");
  }
  if (errors && errors.length) {
    L.push("");
    L.push("PARSE NOTES: " + errors.join("; "));
  }
  return L.join("\n");
}

module.exports = {
  explain,
  describeSimple,
  describeRedirs,
  PROGRAM_VERBS,
  SUBCOMMAND_VERBS,
};
