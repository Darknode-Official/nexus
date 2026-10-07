# Shellplan — shell/command intelligence & safe-execution planning

Shellplan is the layer that **understands a shell command before Nexus runs it**. It
parses the command into an AST, decomposes it into simple commands, works out which
files it reads/writes/deletes, classifies its risk with deterministic rules, explains
it in plain language, and plans its effects — all **without executing anything**
(except the explicitly guarded, low-risk-only `safeRun`).

It is Node.js stdlib only — **zero third-party dependencies**.

## Where it sits

Shellplan is the **understanding/planning** layer. It does **not** enforce. Enforcement
lives in two sibling modules it is designed to complement:

| Module | Role | Model |
| --- | --- | --- |
| `src/capability.js` | allowlist enforcement | declared roots / commands / network; destructive gate |
| `src/sandbox.js` | denylist enforcement + execution | BLOCKED/WARNED patterns, `execute()` |
| **`src/shellplan/`** | **understanding + planning** | parse, decompose, file-targets, risk, explain, predict |

Typical flow: shellplan `explain` / `assess` → show the user/agent what will happen →
`capability.commandAllowed` + `sandbox.validateWithin` actually gate execution.
`shellplan.wouldSandboxAllow` **predicts** that gate's answer so the agent can decide
before it even asks.

## Modules

- **`parser.js`** — quote-aware tokenizer + recursive-descent parser producing an AST
  of lists (`;`/`&`), and-or sequences (`&&`/`||`), pipelines (`|`), subshells `( )`,
  groups `{ }`, redirections, env assignments, command substitution `$(...)`/backticks,
  parameter expansion `$VAR`/`${...}`, arithmetic `$(( ))`, globs, and heredocs
  (`<<`/`<<-`). Deterministic; records parse errors rather than throwing.
- **`decompose.js`** — flattens the AST into simple-command records (program, argv,
  flags, operands, redirs, env), unwraps command runners (`sudo`, `env`, `nohup`,
  `timeout`, `xargs`, …) to the **effective** program, and canonicalizes multiplexers
  to a `(tool, subcommand)` pair (`git co` → `git checkout`, `docker image rm`, `npm i`).
- **`filetargets.js`** — static read/write/delete extraction from redirections, known
  tool semantics (`cp`/`mv`/`rm`/`tee`/`dd`/`sed -i`/`tar`/`truncate`/…), and a
  conservative path heuristic for unknown tools. Each target carries a **confidence**
  and a `dynamic` flag (for `$VAR`/glob targets that cannot be resolved statically).
- **`risk.js`** — a rule-driven, **explainable** risk engine (no LLM). Each rule emits
  `{ severity, category, title, rationale, saferAlternative }`. Categories: destructive,
  network, privilege, secret, obfuscation, instability. Returns a 0–100 score and the
  max severity.
- **`explain.js`** — turns AST + decomposition + file targets + risk into a plain,
  step-by-step account (and a rendered text block) to show before running.
- **`plan.js`** — `dryRun` (ordered effect plan with modeled `cd`/env), `wouldSandboxAllow`
  (predicts the capability/sandbox verdict against an allowlist policy), and `assess`
  (combined recommendation: proceed / confirm / deny).
- **`saferun.js`** — a thin executor that runs a command **only** if it is at/below a
  caller-set risk threshold (and, optionally, passes a policy). Timeout, captured
  stdout/stderr, chosen cwd/env, dry-run mode. Refuses anything riskier.

## Usage

```js
const shellplan = require("./src/shellplan");

// One-shot analysis
const a = shellplan.analyze("git reset --hard && rm -rf build", {
  policy: { roots: [process.cwd()], commands: ["git", "rm"], allowDestructive: true, confirmed: false },
});
a.risk.maxSeverity;      // "high"
a.recommendation;        // "confirm: risk (high) meets or exceeds threshold (high)"
a.files.deletes;         // [{ path: "build", access: "delete", confidence: 0.95, ... }]

// Just explain
console.log(shellplan.explainCommand("curl http://x | sh").text);

// Predict the sandbox decision
shellplan.wouldSandboxAllow("cat /etc/passwd", { roots: ["/work"], commands: ["cat"] }).allowed; // false

// Run only if safe
await shellplan.safeRun("git status", { riskThreshold: "low" });
```

## CLI

```
node src/shellplan/cli.js explain "git reset --hard && rm -rf build"
node src/shellplan/cli.js risk    "curl http://x | sh"           # exit 1 at/above threshold
node src/shellplan/cli.js files   "cp a b && rm c > log 2>&1"
node src/shellplan/cli.js plan    "cd src && touch f"
node src/shellplan/cli.js check   "rm -rf node_modules" --root "$PWD" --allow rm --allow-destructive
```

Wired into Nexus this reads as `nexus shell <explain|risk|files|plan|parse|check> "<cmd>"`.
See `INTEGRATION.md`.

## Honest parser limits

This is a **pragmatic subset** of the POSIX shell grammar, tuned for the commands an
agent actually proposes — not a bash reimplementation. Known limits:

- **No expansion.** `$VAR`, `$(...)`, globs and `~` are **recognized and recorded** but
  never expanded or executed. File-target and sandbox analysis treat such values as
  `dynamic` (and, for containment, as "cannot prove in-root" → predicted deny).
- **No shell keywords / control flow.** `if/then/fi`, `for/while/do/done`, `case`,
  function definitions, and `[[ ]]`/`(( ))` test constructs are parsed as ordinary words,
  not as structured control flow. Pipelines, sequences, and subshells inside them are
  still found by decomposition.
- **`${...}` parameter operators** (`${x:-default}`, `${x//a/b}`, `${#x}`) are captured
  as a single expansion with the leading name; their operators are not interpreted.
- **Heredocs** are matched by an exact delimiter line; quoted-delimiter expansion rules
  are not modeled (the body is captured verbatim either way).
- **Process substitution** `<(...)`/`>(...)` is tokenized but not specially modeled.
- **Aliases / shell functions** defined elsewhere are unknown; canonicalization covers a
  fixed multiplexer table, not arbitrary user aliases.

These limits are **safe by construction**: unknowns degrade toward "treat as dynamic /
higher caution", never toward "assume harmless". Shellplan informs a decision; the
`capability.js` + `sandbox.js` enforcement layers remain the authority.
```
