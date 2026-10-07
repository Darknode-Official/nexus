# Repo Map — Ranked, Token-Budgeted Repository Map

An always-on, compressed overview of a **whole** repository that Nexus can put in
context cheaply. It is the project's **structural table of contents**: the most
important symbols (functions, classes, methods) and how they relate, ranked by
structural importance and trimmed to fit a token budget.

This is **distinct from retrieval**:

| | Retrieval (`src/retrieval`) | Repo Map (`src/repomap`) |
|---|---|---|
| Question | "What's relevant to *this query*?" | "What is this *whole project*?" |
| Output | Top-N source chunks | Global ranked signature tree |
| Scope | A slice | Everything, compressed |
| Trigger | A query | Always on |
| Cost | ~budget per query | One cheap map per turn |

Zero third-party dependencies — Node stdlib only. It builds on `src/codegraph`
(parsing, tokenizer, dependency graph) and `src/tokensave` (token estimator).

## Quick start

```js
const repomap = require("./src/repomap");

// Global map that fits in ~2000 tokens:
const r = repomap.repomap(process.cwd(), { budget: 2000 });
console.log(r.map);          // the rendered map (guaranteed <= budget tokens)
console.log(r.tokens);       // measured token count
console.log(r.files[0]);     // top-ranked file { file, score, lang, loc, symbolCount }

// Bias the ranking toward the files/symbols you're working on:
repomap.repomap(".", { budget: 2000, focus: ["src/retrieval/bm25.js", "rankRepo"] });

// In-memory (no filesystem):
repomap.repomapFromSources({ "a.js": "export function f(){}" }, { budget: 500 });
```

## CLI

```
node src/repomap/cli.js [dir] [options]      # surfaced as `nexus repomap`

  --budget N         token budget (default 2048)
  --focus <f>        bias toward a file/symbol (repeatable or comma-list)
  --exclude <p>      omit paths containing <p>
  --model M          token-estimation model family (default generic)
  --max-per-file N   cap symbols shown per file (default 40)
  --no-cache         disable the incremental cache
  --stats            print ranking/graph stats instead of the map
  --savings          print map tokens vs. full-source tokens
  --bench            cold vs. warm (cached) build timing
```

The map goes to **stdout** and the one-line status to **stderr**, so it pipes
cleanly. Self-benchmark: `node src/repomap/benchmark.js [dir]`.

## Methodology (honest)

### 1. Symbol / reference graph (`symbolgraph.js`)
Nodes are files. We compute, from the codegraph parse data:

- `definers[name]` — the set of files that **define** a symbol called `name`.
- per file, an identifier → **reference count** over the *masked* source (so
  identifiers inside strings/comments never count).

Then, for every identifier `name` used `c` times in file `R`, for every file `D`
that defines `name` (with `D ≠ R`) we add a directed edge `R → D` with weight

```
weight = nameWeight(name) · sqrt(c) / |definers[name]|
```

- `sqrt(c)` — repeated use matters, with diminishing returns.
- `1 / |definers|` — **ambiguity damping**: a `run` defined in ten files should
  not dominate; a uniquely-named symbol carries a crisp edge.
- `nameWeight` — descriptive identifiers (long / compound `camelCase` or
  `snake_case`) outweigh short noise.

On top of that we lay an **import backbone**: codegraph resolves relative imports
to concrete files, so each resolved dependency `R → M` gets a small guaranteed
edge. That keeps the dependency structure in the ranking even when exported names
are re-exported or used indirectly. (This is the same construction aider pioneered
for its "repo map", reimplemented here from first principles over codegraph.)

### 2. Personalized PageRank (`pagerank.js`)
Importance is the stationary distribution of a random surfer on that weighted
graph:

```
r = (1 − d)·p + d·( Wᵀ r + dangling_mass·p )
```

`d` is damping (0.85), `W` the row-stochastic weighted adjacency, `p` the
**personalization vector**. Dangling nodes (no out-edges) redistribute their rank
through `p` so probability is conserved. Power iteration runs to an L1 tolerance
(`1e-8`) or an iteration cap. It is **deterministic** (sorted iteration, stable
accumulation), which matters because the context packer downstream relies on
stable selection for provider prompt-cache hits.

**Why PageRank?** A file referenced by many *important* files is itself important
— a recursive definition PageRank solves exactly. It surfaces the handful of
load-bearing modules an agent should always see.

**Personalization / focus.** When you pass `focus: [files/symbols]`, those become
the restart distribution: the ranking then answers "what matters *relative to this
task*" — the seed files, what they depend on, and what depends on them float up.
Empty focus → uniform restart → the global, task-agnostic ranking.

### 3. Symbol ranking (`rank.js`)
Each file's PageRank is split among the symbols it defines, in proportion to the
inbound reference weight each symbol attracted, with a small floor (so every
definition still appears) and a boost for exported/public symbols (the file's API
surface). Per-file symbol scores sum back to the file's PageRank, so file and
symbol scores are on one comparable scale.

### 4. Signature extraction (`signature.js`)
The map is **signatures + structure, not bodies**. For each symbol we emit one
compact declaration line — the header up to (but excluding) the body `{`, `=>` or
Python `:`. Bracket depth is counted on the codegraph *masked* view, so a `{`
inside a string never fools it; multi-line signatures are joined. This never reads
a body, so it cannot leak implementation and its cost is bounded by the signature
length regardless of function size. Supports JS/TS, Python, Go and Ruby.

### 5. Token-budgeted rendering (`render.js`)
A value-density greedy fills the budget: symbols are considered highest-score
first, and a file "pays" for its header line only once its first symbol is kept.
As the budget shrinks, each file keeps fewer symbols and low-rank files drop out
(**graceful degradation**). A final **verification pass** measures the rendered
string with the token estimator and trims the lowest-ranked lines until it fits —
so the returned map is **guaranteed at or under the budget**, never an estimate
that might blow it.

### 6. Incremental (`cache.js`)
Per-file extraction (mask + parse + reference counts + signatures) is the
expensive step and is cached by `(mtimeMs, size)` with a SHA-1 verification hash,
exactly like the codegraph cache. An unchanged file is **never re-opened or
re-scanned**; a changed file is re-extracted; deleted files are pruned. The cached
extraction also carries the file's imports, so the dependency backbone rebuilds
from cache alone.

**What "incremental" does and does not cover (honest note):** the cached step is
the per-file extraction. The graph assembly and PageRank are *recomputed* each
build — they are cheap (milliseconds for thousands of nodes; see the benchmark),
so true incremental PageRank was not worth its complexity and failure modes. The
measured win is real: on this repo a warm build is ~20–25× faster than a cold one
because 99%+ of files skip extraction.

## How it saves tokens

Dumping a repository's full source into context is enormous and mostly wasteful —
the agent rarely needs every line to orient itself. The map replaces that with a
ranked list of the *signatures that matter*.

Measured on **this repository** (`node src/repomap/benchmark.js .`,
`generic` model family):

```
files indexed:   266        symbols ranked: 1609
full source:     ~593,000 tokens (266 files)

budget   map tok   files   symbols   savings   ratio
1024     1021      34      55        99.8%     ~581x
2048     2044      64      108       99.7%     ~290x
4096     4057      98      227       99.3%     ~146x

build timing:    cold ~0.8s, warm ~0.03s (~24x, 266 cached)
```

So a 2k-token map — well under 0.4% of the full source — still names the ~100
most important symbols across the ~65 most important files, with their call
signatures. That is the difference between an agent that always knows the shape of
the project and one that burns its context window re-reading files.

## API

- `repomap(dir, opts)` → `RepoMapResult` (filesystem, incremental via `opts.cacheFile`)
- `repomapFromSources(sources, opts)` → `RepoMapResult` (in-memory)
- `buildFromExtractions(extractions, opts)` → `RepoMapResult` (advanced)
- `fullSourceTokens(dir, opts)` → `{ files, sourceTokens }` (the baseline)
- `register(ctx, defaults)` → bound API (`ctx.repomap`)

**Options:** `budget` (default 2048), `model`, `focus[]`, `exclude[]`,
`cacheFile`, `maxFiles`, `maxBytes`, `maxPerFile`, `damping`, `tol`, `maxIter`.

**`RepoMapResult`:** `{ map, tokens, budget, degraded, files[], symbols[],
includedFiles[], includedSymbols, droppedSymbols, focus, graph, pagerank, meta }`.

Building blocks are re-exported for advanced use/testing: `pagerank`,
`symbolgraph`, `rank`, `render`, `signature`, `extract`, `cache`.
