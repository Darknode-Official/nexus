# Nexus edit-format protocol layer (`src/editformat`)

The glue between **"model text output"** and **"files changed on disk."**

A coding agent asks a language model to edit code. The model answers with messy,
free-form text: prose, one or more code blocks, in one of several edit formats,
with imperfect line numbers and whitespace. This subsystem **parses** that text,
**validates and self-repairs** the edits against the real files, and **delegates
the actual mutation** to [`src/patch`](../patch) (atomic, reversible, verifiable).

It is deliberately distinct from `src/patch`:

| Layer | Responsibility |
|-------|----------------|
| `src/editformat` | Parse the model's output, locate edits in the file, repair drift, diagnose failures |
| `src/patch` | Low-level diff, fuzzy hunk apply, atomic multi-file transactions, verify->revert |

Zero third-party dependencies -- Node.js stdlib + `src/patch` only.

## Pipeline

```
model text --> detect --> validate (locate + self-repair) --> apply (src/patch tx)
                 |              |                                   |
             which formats?  where in the file? exact/repair/diag  commit | preview | verify->revert
```

## Supported edit formats

### 1. SEARCH/REPLACE blocks (`search-replace.js`)

    path/to/file.js
    (opening code fence, e.g. ```js)
    <<<<<<< SEARCH
    old code
    =======
    new code
    >>>>>>> REPLACE
    (closing code fence)

Tolerances: marker runs of 5-9 characters, label casing, trailing text after the
label, `` ``` `` or `~~~` fences of any length (or none), filename from the fence
info string / a preceding header / bold / inline-code / lead-in sentence, multiple
blocks per file, multiple files, and new-file creation via an empty SEARCH.

### 2. Unified diffs (`unified-diff.js`)

Handles the sloppy diffs models actually emit: invented or omitted `@@` line
numbers (even `@@ ... @@`), **wrong counts** (recomputed from the real lines),
`a/`...`b/` prefixes, `diff --git` headers, fenced diffs, `/dev/null` create/delete,
and context lines whose leading space was dropped. Declared line numbers are
**never trusted** -- reconciliation against the real file is delegated to
`src/patch`'s fuzzy applier.

### 3. Whole-file / fenced code (`whole-file.js`)

"Here is the full new file" responses. The filename is inferred from (in order)
the fence info string, a preceding header/sentence, or a leading path comment
(`// src/app.js`, `# app.py`). Blocks that are actually SEARCH/REPLACE or unified
-diff payloads are excluded.

### 4. Auto-detection (`detect.js`)

Given arbitrary output -- prose, several blocks, mixed formats -- detects which
format(s) are present and extracts **every** edit, ordered by position, ignoring
the surrounding explanation.

## Validation & self-repair (`locate.js`, `validate.js`)

Before anything is written, each edit is resolved against the real file:

- **exact** -- the SEARCH text is present verbatim.
- **repair (safe, automatic)** -- matched after ignoring trailing whitespace,
  normalizing tabs->spaces, ignoring leading indentation, or collapsing interior
  whitespace. The REPLACE is re-indented to match when the SEARCH was.
- **fuzzy (opt-in only)** -- content-level similarity match, applied **only** when
  `allowFuzzy` is set **and** the best candidate is both strong (>= 0.75) and
  unambiguous. Never silent.
- **ambiguous / not-found** -- the edit is **refused** and a structured diagnosis
  (reason, closest candidates with similarity and line numbers, a whitespace-only
  hint) is returned to drive a model-retry loop.

Line endings (LF / CRLF / CR) and trailing-newline state are detected and
preserved on write.

## Application (`apply.js`)

Validated edits become a **single** `src/patch` transaction:

- `applyEdits(edits, opts)` -- preview (`dryRun`) or atomic commit.
- `applyEditsVerified(edits, {verify, opts})` -- apply -> run a verify command ->
  auto-revert on failure.

**All-or-nothing:** if any single edit cannot be safely placed, **nothing** is
written. Multi-file commits are atomic and reversible via the transaction engine's
checkpoint/rollback.

## Rendering (`render.js`)

The inverse: generate canonical edit blocks from a set of `{path, before, after}`
changes, in any supported format. `render -> parse -> validate` round-trips back to
the same result, so Nexus can show or re-emit edits.

## CLI

```
node src/editformat/cli.js <file-with-model-output> [options]
cat reply.txt | node src/editformat/cli.js -        [options]
```

| Option | Effect |
|--------|--------|
| `--dry-run` | Validate and print the unified-diff preview; write nothing |
| `--verify <cmd>` | After applying, run `<cmd>`; auto-revert if it fails |
| `--cwd <dir>` | Base directory for relative paths |
| `--fuzzy` | Allow opt-in content-fuzzy SEARCH matching |
| `--fuzz <n>` | Unified-diff context fuzz (default 2) |
| `--json` | Machine-readable output |

Exit codes: `0` applied / dry-run ok, `2` edits could not be placed (diagnoses
printed), `1` usage / IO error.

## Public API

```js
const ef = require("./src/editformat");

ef.applyModelOutput(text, { cwd, defaultPath, allowFuzzy, dryRun, fuzz, files });
ef.parseEdits(text, { defaultPath });           // detect only, no disk
ef.validateEdits(edits, { cwd, files, readFile, allowFuzzy });
ef.applyEdits(edits, { cwd, dryRun });          // atomic commit via src/patch
ef.applyEditsVerified(edits, { verify, opts }); // apply -> verify -> revert
ef.render(changes, { format });                 // inverse
ef.locate(content, searchLines, { allowFuzzy });
```

## Honest limitations

- **Whole-file blocks containing `@@`/`<<<<<<<`** are treated as edit payloads, not
  whole files. A real source file that literally contains those markers cannot be
  delivered as a whole-file block; use SEARCH/REPLACE or a diff instead.
- **REPLACE re-indentation** reconstructs indentation by character count. A block
  that mixes tabs and spaces inconsistently at the same level may need manual
  review; tabs are expanded to spaces when de-indenting.
- **Fuzzy matching is a last resort.** It is off by default and, even when enabled,
  refuses weak or ambiguous matches rather than guessing. It ranks candidate
  windows of the SEARCH block's exact length; a block whose true location changed
  size will surface as a diagnosis, not an application.
- **Byte-identical binary content** is out of scope -- this layer is line-oriented
  UTF-8 text, like the rest of the patch stack.
- The parser recognizes the common `<<<<<<< SEARCH`/`=======`/`>>>>>>> REPLACE`,
  unified-diff, and whole-file conventions. Proprietary or bespoke edit DSLs are
  not parsed.
