# Refactor — Automated refactoring library

Safe, reversible, cross-file code transformations for working on **existing**
codebases. This is the Nexus subsystem that lets the agent restructure code it did
not write, with the same safety contract everywhere: a dry-run preview, an explicit
safety check that **refuses when it cannot act safely** (with reasons), atomic
application across every touched file, and an optional *apply → verify(tests) →
auto-revert* wrapper. There are no silent partial changes.

It is built on two wave-1 subsystems and adds nothing of its own to the dependency
tree (Node stdlib only):

- **`src/codegraph`** — the scope-aware tokenizer/block scanner, the multi-language
  symbol table, and the cross-file import **bindings** (which local name in file B
  resolves to which exported symbol in file A). Rename and move use this to know
  *which* occurrences actually refer to the symbol being changed.
- **`src/patch`** — the transactional multi-file engine: stage writes, commit
  atomically, roll back from a checkpoint on any error, and the
  `applyVerifyRevert` harness.

## Language coverage (honest)

| Refactoring        | JavaScript / TypeScript | Other languages |
|--------------------|-------------------------|-----------------|
| rename             | yes (functions, classes, consts, imports, class-scoped methods) | refused |
| extract function   | yes | refused |
| inline variable    | yes | refused |
| inline function    | yes (simple single-expression functions) | refused |
| move symbol        | yes (top-level named declarations) | refused |
| organize imports   | yes (ESM `import`, CJS top-level `require`) | refused |

TypeScript is parsed with the same lexical machinery as JavaScript. Type-only
constructs (interfaces, type aliases, `import type`) are not symbol-indexed, so they
are not renamed/moved — the transforms act on value-level identifiers. Python / Go /
Ruby are indexed by codegraph but are **not** supported here and are refused with a
clear reason rather than mangled.

## Quick start

```js
const refactor = require("./src/refactor");

// Session over a directory (reads JS/TS, skips node_modules/dist/etc).
const r = refactor.fromDir(process.cwd());

// 1. Plan (pure — touches nothing).
const plan = r.rename({ oldName: "readCfg", newName: "readConfig" });

// 2. Inspect safety + preview the unified diffs.
if (!plan.ok) console.error(plan.safety.reasons);
else console.log(r.preview(plan).files.map(f => f.diff).join("\n"));

// 3. Apply atomically, or apply+verify+auto-revert.
r.apply(plan);                 // all files change or none do
r.applyVerify(plan, "npm test"); // reverts byte-for-byte if tests fail
```

## API

### Session: `refactor.fromDir(root, opts?)` / `new refactor.Refactorer({ files, cwd })`

`files` is an array of `{ file, source }` (paths relative to `cwd`). `fromDir`
reads them from disk for you.

Refactoring methods — each returns a **RefactorPlan** and writes nothing:

- `rename({ oldName, newName, file?, line?, force? })`
- `extract({ file, startLine, endLine, newName })`
- `inlineVariable({ file, name, force? })`
- `inlineFunction({ file, name })`
- `move({ fromFile, name, toFile })`
- `organizeImports({ file, opts? })` — `opts: { removeUnused, addMissing, sort }`

Apply modes (bound to the session `cwd`):

- `preview(plan)` → `{ ok, refactoring, safety, files: [{ file, action, diff, additions, deletions }] }`
- `apply(plan, { dryRun? })` → patch-engine commit result (`{ ok, committed, written, ... }`)
- `applyVerify(plan, verifier, { onDirty?, timeout? })` → apply, run `verifier`
  (a shell command or `() => boolean`), auto-revert on failure.

### RefactorPlan

```
{
  refactoring: "rename" | "extract" | "inline-variable" | "inline-function" | "move" | "organize-imports",
  ok: boolean,                               // safe AND computed
  safety: { safe, reasons: string[], warnings: string[] },
  edits:  Map<file, newContent|null>,        // null = delete
  before: Map<file, originalContent>,        // for in-memory diffing
  details: { ... }                           // refactoring-specific summary
}
```

The pure planners are also exported directly (no session): `planRename`,
`planExtract`, `planInlineVariable`, `planInlineFunction`, `planMove`,
`planOrganizeImports`.

## How each refactoring stays safe

**rename** — resolves the real binding of the symbol. In the declaring file it
renames only occurrences governed by the target's scope, skipping any inner binder
of the same name (a nested `const`, a parameter, a `catch` binding, a `function`
declaration) — so a shadowing local is never touched. Across files it follows
codegraph import bindings: a direct import is renamed scope-aware in the importer; an
aliased import (`import { old as a }`) has only the *imported* side changed and the
alias usages kept; a namespace/default-object import has its `ns.old` member accesses
renamed. It **refuses** on an invalid new name, a name collision in any file it would
edit, an ambiguous symbol (pass `{ file, line }`), or a cross-file method rename
(dynamic dispatch) — a class-scoped method rename is offered instead with a warning.

**extract function** — computes parameters from the *free variables* of the selection
(names used inside it but declared in the enclosing scope) and return values from
names declared inside that are still used after it (one → `return x`, several →
`return { a, b }` destructured at the call site). `await` makes the function `async`
and the call `await`ed. It **refuses** a selection carrying a top-level `return`,
`break`, `continue` or `yield` — control flow that cannot be lifted without changing
semantics.

**inline variable** — replaces references with `(initializer)` and deletes the
declaration. Allowed when the variable is used once, or the initializer is
side-effect-free (no calls) and the variable is never reassigned; `force` overrides.

**inline function** — replaces calls to a *simple* function (an arrow with an
expression body, or a `function` whose body is a single `return <expr>`) with the
expression, substituting arguments for parameters. **Refuses** recursion,
`this`/`arguments`, rest/default/destructured parameters, multi-statement bodies, and
argument-count mismatches.

**move symbol** — relocates a top-level declaration, rendering it for the
destination's module system (ESM `export` vs CJS `module.exports`), repoints every
importer (splitting a multi-name import so unmoved names stay put), adds an import
back into the source file if it still uses the symbol, and adds imports in the
destination for any source-module symbols the declaration depends on (warning if any
are not exported). Default exports and re-export chains are refused.

**organize imports** — removes unused names (and empty statements, keeping
side-effect imports), adds missing ones looked up in the project symbol table (only
when exactly one file exports the name — ambiguous names are skipped), and reorders
the contiguous leading import block into node-builtin / external / relative groups,
each sorted by specifier. Imports buried mid-file are left in place so side-effect
ordering is preserved.

## Safety limits (what it will *not* do)

- No full type inference — the free-variable/return analysis for extract is a
  lexical heuristic; it is conservative and refuses control-flow it cannot lift, but
  review the preview for closures over `this` or mutable captured state.
- rename does not rewrite dynamic access (`obj["readCfg"]`, reflection) or update
  external callers of a class method.
- move handles top-level named declarations only; it does not reorder the destination
  or resolve a dependency that itself needs moving.
- All transforms are **preview-first**: when in doubt, read the diff before `apply`.

## CLI

```
nexus refactor rename <oldName> <newName> [--file F] [--line N]
nexus refactor extract <file> <startLine> <endLine> <newName>
nexus refactor inline-var <file> <name> [--force]
nexus refactor inline-fn  <file> <name>
nexus refactor move <name> <fromFile> <toFile>
nexus refactor imports <file>

  --dir D          project root (default: cwd)
  --apply          write the change (default is a dry-run preview)
  --verify "cmd"   apply, run cmd, auto-revert on failure
  --json           machine-readable output
```

Direct: `node src/refactor/cli.js <command> ...`

## Tests

```
node --test test/refactor/
```

Fixture projects live in OS temp dirs (`test/refactor/fixture.js`); nothing is
written inside the repo.
