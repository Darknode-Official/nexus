"use strict";
// ============================= Shellplan — command decomposition =============================
// Walks the parser AST and pulls out every *simple command* with a flat, ergonomic
// shape the rest of the subsystem can reason about: program, argv, parsed flags and
// operands, and — for multiplexers like git/npm/docker — a canonical (tool,
// subcommand) pair. Pure reading; nothing runs.

const { parse } = require("./parser");

/**
 * Known multiplexers: tools whose first operand is really a subcommand. For each
 * we record which subcommands take their own operands so flag parsing can stop at
 * the right place, and (optionally) global flags that precede the subcommand.
 * @type {Object<string,{globalFlagsTakeValue:string[], aliases?:Object<string,string>}>}
 */
const MULTIPLEXERS = {
  git: {
    // `git -C <dir> status`, `git --git-dir=<d> ...`
    globalFlagsTakeValue: ["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"],
    aliases: { co: "checkout", ci: "commit", br: "branch", st: "status" },
  },
  npm: { globalFlagsTakeValue: ["--prefix", "-C"], aliases: { i: "install", rm: "uninstall", un: "uninstall", "it": "install-test", list: "ls" } },
  pnpm: { globalFlagsTakeValue: ["--dir", "-C", "--filter"], aliases: { i: "install", rm: "remove", dlx: "dlx" } },
  yarn: { globalFlagsTakeValue: ["--cwd"], aliases: {} },
  docker: { globalFlagsTakeValue: ["-H", "--host", "--context", "--config"], aliases: { ps: "ps", rm: "rm", rmi: "rmi" } },
  kubectl: { globalFlagsTakeValue: ["-n", "--namespace", "--context", "--kubeconfig"], aliases: {} },
  cargo: { globalFlagsTakeValue: ["--manifest-path"], aliases: {} },
  go: { globalFlagsTakeValue: [], aliases: {} },
  pip: { globalFlagsTakeValue: ["--cache-dir"], aliases: {} },
  pip3: { globalFlagsTakeValue: ["--cache-dir"], aliases: {} },
  apt: { globalFlagsTakeValue: ["-o"], aliases: {} },
  "apt-get": { globalFlagsTakeValue: ["-o"], aliases: {} },
  systemctl: { globalFlagsTakeValue: ["-H", "-M"], aliases: {} },
  brew: { globalFlagsTakeValue: [], aliases: {} },
  gh: { globalFlagsTakeValue: ["-R", "--repo"], aliases: {} },
  terraform: { globalFlagsTakeValue: ["-chdir"], aliases: {} },
};

/**
 * Flatten the AST into a list of simple-command records, preserving pipeline,
 * sequence, and subshell structure as metadata on each record.
 * @param {object} ast - result of parser.parse(...)
 * @returns {Array<object>} simple command records
 */
function decompose(ast) {
  const out = [];
  if (!ast || !ast.list) return out;
  walkList(ast.list, out, { depth: 0, subshell: false });
  // index them for stable references
  out.forEach((c, idx) => { c.index = idx; });
  return out;
}

function walkList(list, out, ctx) {
  for (const part of list.parts) {
    walkAndOr(part.andOr, out, Object.assign({}, ctx, { sequenceSep: part.separator }));
  }
}

function walkAndOr(andOr, out, ctx) {
  if (!andOr) return;
  andOr.pipelines.forEach((p, pi) => {
    walkPipeline(p.pipeline, out, Object.assign({}, ctx, { connector: p.connector, background: ctx.sequenceSep === "&" }));
  });
}

function walkPipeline(pipeline, out, ctx) {
  if (!pipeline) return;
  const piped = pipeline.commands.length > 1;
  pipeline.commands.forEach((cmd, ci) => {
    const base = {
      depth: ctx.depth,
      inSubshell: ctx.subshell,
      inPipeline: piped,
      pipePosition: piped ? ci : null,
      pipelineLength: pipeline.commands.length,
      pipedInto: ci < pipeline.commands.length - 1,
      receivesPipe: ci > 0,
      connector: ci === 0 ? ctx.connector : null,
      negated: pipeline.negated,
      background: !!ctx.background,
    };
    if (cmd.type === "command") {
      out.push(buildSimple(cmd, base));
    } else if (cmd.type === "subshell" || cmd.type === "group") {
      // record the grouping as its own node, then recurse
      out.push(Object.assign({ kind: cmd.type, program: cmd.type === "subshell" ? "(subshell)" : "(group)", argv: [], redirs: normalizeRedirs(cmd.redirs) }, base));
      walkList(cmd.list, out, Object.assign({}, ctx, { depth: ctx.depth + 1, subshell: cmd.type === "subshell" || ctx.subshell }));
    }
  });
}

function buildSimple(cmd, base) {
  const argv = cmd.words.map(w => w.text);
  const program = argv[0] || "";
  const programBase = basename(program);

  // Unwrap command runners (sudo/env/nohup/timeout/xargs/...) so the "effective"
  // program is the one actually invoked. Risk rules and file-target semantics care
  // about the inner command, not the wrapper.
  const unwrapped = unwrapRunners(argv);

  const rec = Object.assign({
    kind: "simple",
    program,
    programBase,
    argv,
    effectiveArgv: unwrapped.argv,
    effectiveProgram: unwrapped.argv[0] || "",
    effectiveBase: basename(unwrapped.argv[0] || ""),
    wrappers: unwrapped.wrappers,
    words: cmd.words,
    assignments: cmd.assignments.map(a => ({ name: a.name, value: a.value })),
    redirs: normalizeRedirs(cmd.redirs),
    hasExpansion: cmd.words.some(w => w.expansions && w.expansions.length),
    hasGlob: cmd.words.some(w => w.glob),
  }, base);

  const { flags, operands } = parseFlags(rec.effectiveArgv.slice(1));
  rec.flags = flags;
  rec.operands = operands;

  rec.canonical = canonicalize(rec.effectiveBase, rec.effectiveArgv, rec);
  return rec;
}

/**
 * Command runners that take another command as their trailing arguments. We skip
 * the runner and its own options so the effective command surfaces. Conservative:
 * when a runner's option grammar is ambiguous, we stop at the first non-flag token.
 */
const RUNNERS = {
  sudo: { valueFlags: ["-u", "-g", "-U", "-C", "-h", "-p", "-r", "-t"] },
  doas: { valueFlags: ["-u", "-C"] },
  nohup: { valueFlags: [] },
  setsid: { valueFlags: [] },
  stdbuf: { valueFlags: ["-i", "-o", "-e"] },
  nice: { valueFlags: ["-n"] },
  ionice: { valueFlags: ["-c", "-n", "-p"] },
  time: { valueFlags: ["-o", "-f"] },
  timeout: { valueFlags: ["-s", "--signal", "-k", "--kill-after"], consumeOneOperand: true }, // duration
  env: { valueFlags: ["-u", "--unset", "-C", "--chdir"], skipAssignments: true },
  command: { valueFlags: [] },
  exec: { valueFlags: [] },
  xargs: { valueFlags: ["-n", "-P", "-I", "-d", "-E", "-s", "-a"] },
};

function unwrapRunners(argv) {
  let args = argv.slice();
  const wrappers = [];
  let guard = 0;
  while (args.length && guard++ < 8) {
    const bin = basename(args[0]);
    const runner = RUNNERS[bin];
    if (!runner) break;
    wrappers.push(bin);
    let i = 1;
    if (runner.skipAssignments) while (i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i])) i++;
    while (i < args.length) {
      const tok = args[i];
      if (tok === "--") { i++; break; }
      if (tok.startsWith("-")) {
        const eq = tok.indexOf("=");
        const bare = eq !== -1 ? tok.slice(0, eq) : tok;
        if (eq === -1 && runner.valueFlags.includes(bare)) i += 2;
        else i += 1;
        continue;
      }
      break;
    }
    if (runner.consumeOneOperand && i < args.length) i += 1; // e.g. timeout <duration>
    const rest = args.slice(i);
    if (!rest.length) break; // nothing left to unwrap; keep wrapper as the program
    args = rest;
  }
  return { argv: args, wrappers };
}

function normalizeRedirs(redirs) {
  return (redirs || []).map(r => ({
    op: r.op,
    fd: r.fd,
    dupTo: r.dupTo != null ? r.dupTo : null,
    target: r.target ? r.target.text : null,
    heredoc: r.heredoc ? { delim: r.heredoc.delim, body: r.heredoc.body } : null,
  }));
}

/**
 * Generic flag parser for the args AFTER the program name. Separates `-x`,
 * `--long`, `--long=value`, grouped short flags `-abc`, and `--` terminator.
 * Values that attach to flags are left as separate operands here (tool-specific
 * value-flags are handled by canonicalize for multiplexers); this generic view is
 * deliberately conservative so callers can refine.
 * @param {string[]} args
 */
function parseFlags(args) {
  const flags = [];
  const operands = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (afterDoubleDash) { operands.push(a); continue; }
    if (a === "--") { afterDoubleDash = true; continue; }
    if (a === "-") { operands.push(a); continue; } // stdin/stdout marker
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags.push({ name: a.slice(0, eq), value: a.slice(eq + 1), long: true });
      else flags.push({ name: a, value: null, long: true });
    } else if (a.startsWith("-") && a.length > 1) {
      // grouped short flags; record each letter, keep combined too
      const letters = a.slice(1).split("");
      flags.push({ name: a, value: null, long: false, letters });
    } else {
      operands.push(a);
    }
  }
  return { flags, operands };
}

/**
 * Resolve a multiplexer command to a canonical (tool, subcommand) pair plus its
 * own argv tail. For non-multiplexers, returns { tool, subcommand:null }.
 * @param {string} programBase
 * @param {string[]} argv
 * @param {object} rec
 * @returns {{tool:string, subcommand:(string|null), subArgs:string[], chain:string[]}}
 */
function canonicalize(programBase, argv, rec) {
  const mux = MULTIPLEXERS[programBase];
  if (!mux) return { tool: programBase, subcommand: null, subArgs: argv.slice(1), chain: [programBase] };

  const rest = argv.slice(1);
  let i = 0;
  // skip global flags (and their values where known)
  while (i < rest.length) {
    const tok = rest[i];
    if (tok === "--") { i++; break; }
    if (tok.startsWith("-")) {
      const eq = tok.indexOf("=");
      const bare = eq !== -1 ? tok.slice(0, eq) : tok;
      if (eq === -1 && mux.globalFlagsTakeValue.includes(bare)) i += 2; // flag + value
      else i += 1;
      continue;
    }
    break;
  }
  let sub = rest[i] || null;
  if (sub && mux.aliases && mux.aliases[sub]) sub = mux.aliases[sub];
  const subArgs = rest.slice(i + 1);

  // docker/kubectl have a second level (docker image rm, kubectl get pods)
  let chain = [programBase];
  if (sub) chain.push(sub);
  const twoLevel = { docker: ["image", "container", "volume", "network", "system", "compose", "builder", "buildx"], kubectl: [] };
  if (twoLevel[programBase] && twoLevel[programBase].includes(sub) && subArgs[0] && !subArgs[0].startsWith("-")) {
    chain.push(subArgs[0]);
  }
  return { tool: programBase, subcommand: sub, subArgs, chain };
}

function basename(p) {
  if (!p) return "";
  const s = String(p);
  const cut = s.lastIndexOf("/");
  return cut === -1 ? s : s.slice(cut + 1);
}

/**
 * Convenience: parse a raw command string straight to simple-command records.
 * @param {string} cmd
 * @returns {{commands:Array, ast:object, errors:string[]}}
 */
function decomposeCommand(cmd) {
  const ast = parse(cmd);
  return { commands: decompose(ast), ast, errors: ast.errors };
}

module.exports = {
  decompose,
  decomposeCommand,
  canonicalize,
  parseFlags,
  basename,
  MULTIPLEXERS,
};
