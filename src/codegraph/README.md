# Code Graph — Repo Intelligence for Nexus

The Code Graph subsystem is what lets Nexus work well on **existing** codebases
instead of only greenfield code. The measured weak spot of AI coding agents is
situational awareness of a repo they didn't write: they re-implement functions
that already exist (DRY violations), miss call sites when they change something,
and can't answer "where is this defined / what imports it / what breaks if I touch
it". Code Graph answers those questions with a fast, dependency-free static index.

Zero third-party dependencies — Node.js stdlib only.

```js
const codegraph = require("./src/codegraph");

const idx = codegraph.indexDirectory(process.cwd(), { cacheFile: ".nexus/codegraph.json" });

idx.findImplementation("parse import statement"); // reuse before writing new code
idx.impact({ file: "src/util.js", name: "readConfig" }); // what could break
idx.duplicates();   // candidate DRY violations with locations
idx.topo();         // safe build / visit order (deps before dependents)
idx.cycles();       // import cycles
idx.stats();        // counts by language, symbols, edges, cycles
```

## Supported languages

JavaScript / TypeScript (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`), Python
(`.py .pyi`), Go (`.go`), Ruby (`.rb .rake`). Adding a language is one parser
module in `lang/` plus an entry in `parse.js`.

## Architecture / modules

| Module | Responsibility |
| --- | --- |
| `tokenizer.js` | Character-level **masker**: blanks comment/string contents while preserving length and newlines, so downstream scanning never misreads a keyword inside a string and every offset maps back to an exact line/col. `keepStrings` variant preserves string contents for import-specifier scanning. |
| `blocks.js` | Brace-block scanner for C-family/JS/Go: builds a tree of `{ … }` blocks with header text and offsets, giving real scope tracking. |
| `lang/javascript.js`, `lang/python.js`, `lang/go.js`, `lang/ruby.js` | Per-language symbol parsers. Emit a normalized result (functions, classes, methods, imports, exports with locations). |
| `parse.js` | Extension → parser dispatch; normalized `parseSource(source, file)`. |
| `symbols.js` | Project symbol table + **cross-file resolution**: binds every imported local name to the concrete exported definition, following re-exports (`export {x} from`), star re-exports (`export * from`) and aliases. |
| `depgraph.js` | Module-level import graph with language-aware resolution, **cycle detection (Tarjan SCC)** and **topological ordering** (Kahn over the SCC condensation). |
| `duplication.js` | Near-duplicate / DRY detector (token shingles + greedy clone extension). |
| `search.js` | "Find existing implementation" ranking (lexical + structural, no embeddings). |
| `impact.js` | Impact / blast-radius: transitive dependents of a file or symbol. |
| `cache.js` | Incremental index cache keyed by mtime/size with SHA-1 verification. |
| `indexer.js` | Orchestrator: walk → parse (cached) → symbol table + graph → query methods. |
| `cli.js` | Runnable CLI: stats, `--dupes`, `--cycles`, `--find`, `--bench`. |

## Methodology (honest description)

**Parsing is heuristic, not a full compiler front-end — but it is scope-aware, not
a naive regex.** Every scan runs on the *masked* source, so a `function`/`class`/
`def` keyword inside a string or comment is never counted. JS/Go class members are
confirmed against the brace block they physically live in; Python attaches `def`s
to their enclosing scope via an indentation stack (a `def` nested inside a `def` is
a function, not a method); Ruby tracks `end`-matched block depth and ignores
statement-modifier `if/unless/while` so they don't open phantom scopes. This is
accurate for the vast majority of real code. It intentionally does **not** do full
type inference, macro expansion, or dynamic (`eval`, computed-member) resolution,
and TypeScript type-only constructs beyond declarations are not modeled.

**Duplication detection** is Type-2 clone detection: tokens are normalized
(identifiers → `V`, numbers → `N`, language keywords/operators kept), so clones
survive variable renames and literal changes while real structure is preserved.
A sliding k-gram window is hashed (FNV-1a); colliding windows are seeds that are
then **greedily extended token-by-token** for as long as the two normalized
streams agree, so a seed grows into the largest exact-structure clone around it.
A single edited line in the middle honestly splits one clone into two adjacent
ones — nothing is hidden. Overlapping reports from different seeds are suppressed
by line-range containment. Boilerplate seen in many places (above `maxSeeds`) is
skipped to avoid noise. Reported `similarity` is `1.0` because the extended region
is an exact structural match; `jaccard()` is available for fuzzy file-level scoring.

**Find-existing-implementation** scores each function/method with a lexical signal
(query terms matched against identifier words split from camelCase/snake_case/kebab
across name, signature, enclosing class and file path — each field weighted) plus a
structural signal (exact/prefix name hits, and parameter-count proximity when the
query is signature-shaped). No embeddings and no network — transparent and tunable.

**Impact analysis** uses the dependency graph's reverse edges (BFS with hop
distance) for module-level blast radius, and the symbol table's resolved bindings
to pinpoint the *direct* consumers of a specific symbol, yielding a severity
(`isolated` / `low` / `moderate` / `high`).

**Incremental cache** stores each file's parse result keyed by `(mtimeMs, size)`
with a SHA-1 content hash for verification. The fast path is a stat compare (no
read); on a hit the file is never opened. Measured on this repo: a warm re-index
is ~20x+ faster than cold with a 100% hit rate.

## Result shapes

```
parseSource(src, file) -> {
  lang, file, loc,
  symbols: [{ name, kind:"function"|"class"|"method"|"type", line, col,
              exported, parent, signature?, extends?, bases?, ... }],
  imports: [{ source, kind, line, names:[{imported,local}], default?, namespace?, alias?, sideEffect? }],
  exports: [{ name, kind, line, local?, source? }],
}
```

## CLI

```
node src/codegraph/cli.js [dir]                      # index + stats
node src/codegraph/cli.js [dir] --dupes              # duplicate clones
node src/codegraph/cli.js [dir] --cycles             # import cycles
node src/codegraph/cli.js [dir] --find "parse json"  # rank reusable functions
node src/codegraph/cli.js [dir] --bench              # cold vs. cached timing
```

## Tests

```
node --test test/codegraph/
```

Fixture-driven unit tests cover the tokenizer, all four language parsers, cross-file
resolution, cycle detection + topo order, duplication, search, impact and the
incremental cache (including a real cold-vs-warm cache run over a fixture tree).
