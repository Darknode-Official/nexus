# Retrieval — Local Code RAG (token-efficient context selection)

Dependency-free local retrieval for Nexus. It answers one question well:

> *"Which chunks of this codebase are most relevant to this query, and which of
> them fit in N tokens?"*

That is the lever on **token economics**: instead of pasting whole files into a
prompt, Nexus feeds an engine only the spans that matter. On this repo the
budget-bounded retriever returns **~90% fewer tokens** than the naive
"paste the whole candidate files" baseline, while keeping the relevant symbol on
top (see the benchmark below).

No embeddings. No external services. No third-party dependencies — Node stdlib
only. Everything is **deterministic**: the same store + query + options always
returns the same result (which keeps provider prompt-caches stable downstream).

## Pipeline

```
source files
   │  chunker.js          symbol-aware chunks (via codegraph) + window fallback
   ▼
chunks ──► tokenize.js    code-aware tokens (camelCase/snake_case split, operators)
   │
   ▼  bm25.js             inverted index → BM25 ranking (tunable k1/b) + TF-IDF cosine
ranked
   │  hybrid.js           + codegraph structural signals (symbol match, impl rank,
   ▼                        import proximity)
diversified ── mmr.js     MMR: suppress near-duplicate chunks
   │
   ▼  retriever.js        pack into a token budget (tokensave estimator + packer)
result: chunks + scores + why-selected + assembled context string
```

`store.js` keeps the chunk set and index in sync with a changing codebase
incrementally (mtime/hash), and persists to `.nexus/retrieval.json`.

## Quick start

```js
const retrieval = require("./src/retrieval");

// Index a directory (incremental, cached).
const idx = retrieval.indexDirectory(process.cwd(), { cacheFile: ".nexus/retrieval.json" });

// Retrieve within a 1500-token budget.
const res = idx.retrieve("parse import statement", { budget: 1500, topN: 8 });

console.log(res.report);    // ranked chunks + why each was selected
console.log(res.context);   // the packed context string, ready to drop into a prompt
```

In-memory (no filesystem), e.g. for tests:

```js
const idx = retrieval.indexFiles([{ file: "a.js", source: "..." }]);
idx.retrieve("compute checksum", { budget: 800 });
```

## CLI

```
node src/retrieval/cli.js "<query>" [dir] [options]

  --budget N     token budget for the returned context (default 1500)
  --top N        max chunks to return (default 8)
  --model M      model family for token estimation (default generic)
  --cosine       use TF-IDF cosine instead of BM25
  --no-hybrid    disable codegraph structural fusion
  --context      print the assembled context string (the packed code)
  --stats        print index statistics only
  --bench        cold vs. warm (cached) index timing
```

Intended Nexus surface: `nexus retrieve "<query>" --budget N`.

## API

### Entrypoints (`require("./src/retrieval")`)
- `indexDirectory(root, opts)` → index. opts: `cacheFile`, `maxFiles`, `maxBytes`,
  `storeContent`, `chunkOpts`, `hybrid`.
- `indexFiles([{file, source}], opts)` → index (in-memory).
- `createStore(opts)` → a raw store (lower-level).
- `retrieve(store, query, opts)` → result (the raw query function).

### Index object
- `idx.retrieve(query, opts)` → result (uses the attached codegraph index for
  hybrid automatically unless `opts.hybrid === false`).
- `idx.stats()`, `idx.save(file)`, `idx.allChunks()`, `idx.cgIndex`, `idx.store`.

### `retrieve` options
| option | default | meaning |
|---|---|---|
| `budget` | `null` | token budget; `null` ⇒ return top-N by score |
| `topN` | `8` | max chunks returned |
| `model` | `"generic"` | model family for token estimation |
| `scorer` | `"bm25"` | `"bm25"` or `"cosine"` |
| `k1`, `b` | `1.5`, `0.75` | BM25 parameters |
| `hybrid` | `true` | fuse codegraph signals (needs `cgIndex`) |
| `lambda` | `0.7` | MMR relevance/novelty trade-off |
| `wLex`, `wStruct` | `0.7`, `0.3` | lexical vs. structural blend weights |

### Result shape
```js
{
  query, qterms, budget, usedTokens, count, strategy,
  chunks: [{
    id, file, lang, kind, name, startLine, endLine, lines,
    score, lex, struct, mmrScore, redundancy, tokens,
    why: ["matched terms: ...", "codegraph impl match ...", ...],
    content,
  }],
  dropped: [{ id, tokens, reason }],
  report,     // human-readable ranking
  context,    // assembled, budget-bounded context string
}
```

## Methodology (honest)

- **Chunking** prefers *symbols* (functions/methods/classes) using the codegraph
  parser's line-accurate symbol table, with a preamble chunk for the import
  header. Files codegraph can't parse (or symbols larger than `maxLines`) fall
  back to overlapping sliding windows. Chunk ids are derived from symbol
  *identity + order* (`file::name~ordinal`), **not** absolute line numbers, so
  inserting code above a function does not change its id — only its line span.

- **BM25** is the Okapi BM25 ranking function (the Lucene/Elasticsearch default
  family) with length normalization and a non-negative IDF floor. `k1` controls
  term-frequency saturation, `b` controls length normalization. A TF-IDF cosine
  scorer is also provided for callers who want a bounded [0,1] similarity.

- **Tokenization** is code-aware: identifiers are split on
  camelCase/snake_case/kebab/digit boundaries *and* the whole collapsed
  identifier is kept, so both "parse config" and `parseConfig` hit. Multi-char
  operators are preserved. Natural-language stop words are dropped but
  programming keywords are kept (developers search for them).

- **Hybrid** adds structural signals the lexical score can't see: a chunk that
  *defines* a matching symbol, codegraph's own `findImplementation` ranking
  mapped back to the owning chunk, and an import-proximity boost for chunks one
  hop from a strong match. All signals are normalized to [0,1] and blended.

- **MMR** (Carbonell & Goldstein, 1998) re-ranks to balance relevance against
  novelty (Jaccard over each chunk's term set), so a budget isn't spent on three
  copies of the same helper.

- **Budgeting** reuses the `tokensave` subsystem: its deterministic token
  *estimator* (within ~±15% of real tokenizers, enough for budgeting) and its
  knapsack *context-packer* select the highest-value subset that fits. Near-
  duplicates are discounted by their MMR redundancy before packing.

### What this is NOT
- Not semantic/embedding search — it is lexical + structural. It will miss
  synonyms a BM25 query doesn't contain (e.g. "auth" vs "login") unless the terms
  co-occur in the code. This is the deliberate price of zero dependencies and
  full determinism.
- The token *estimate* is a heuristic, not a real BPE count; budgets are
  conservative, not exact.

## How it ties to token savings

A coding agent's dominant cost is prompt tokens. The usual failure mode is
dumping whole files "to be safe". This subsystem replaces that with a ranked,
diversified, budget-bounded selection of only the relevant spans. The self
benchmark (`node src/retrieval/bench.js`) reports, per query, retrieved tokens vs.
the whole-file baseline. On this repo:

```
overall token saving vs whole-file: ~90%   (avg query latency < 30ms)
warm re-index: ~3x faster than cold via the incremental cache
```

Those tokens not spent on context are tokens available for reasoning — or simply
not paid for.

## Tests

```
node --test test/retrieval/
```

Covers tokenization edge cases, BM25 ranking correctness on fixtures, TF-IDF
cosine, incremental add/update/remove + persistence, disk sync mtime/hash,
MMR diversification, hybrid structural signals, and budget-bounded retrieval.
