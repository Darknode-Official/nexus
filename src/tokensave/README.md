# Token-Saving Engine (`src/tokensave`)

Nexus's headline cost differentiator: cut the tokens every turn costs, **locally,
deterministically, and measurably**. No LLM calls, no network, no third-party
dependencies — pure Node.js standard library, consistent with the repo's
zero-dependency claim.

Six cooperating modules, each usable on its own:

| Module | File | What it saves |
|--------|------|----------------|
| Prompt compressor | `compressor.js` | Input tokens: filler, whitespace, redundant instructions |
| Semantic cache | `semantic-cache.js` | Whole turns: near-duplicate requests served from cache (free) |
| Context packer | `context-packer.js` | Input tokens: optimal chunk subset under a budget |
| Diff-context builder | `diff-context.js` | Input tokens: changed hunks instead of whole files |
| Prompt-cache planner | `cache-planner.js` | Input $: structure messages for provider prompt-cache hits |
| Token accountant | `estimator.js` | (measures everything) estimator + savings ledger |

## Quick start

```js
const tokensave = require("./src/tokensave");

// One engine with a shared savings ledger:
const eng = tokensave.createEngine({ model: "claude-opus-4" });

const c = eng.compress("Please kindly fix the bug in order to pass the tests.", 2);
// -> { text, before, after, saved, savedPct, level, protectedRegions }

const d = eng.diff(oldFileText, newFileText, { neighbors: 3 });
// -> minimal context around the edit; d.saved tokens vs the whole file

console.log(eng.ledger.report());   // attributed savings, per technique
console.log(eng.summary());         // one-line rollup
```

Or use any module directly: `tokensave.compressor.compress(...)`,
`new tokensave.semanticCache.SemanticCache(...)`, `tokensave.contextPacker.pack(...)`, etc.

## API

### `estimator.js`
- `estimateTokens(text, model?) -> number` — deterministic heuristic token count.
- `estimateMessages(messages, model?) -> number` — includes per-message framing.
- `familyOf(model) -> "gpt"|"claude"|"gemini"|"llama"|"generic"`.
- `new Ledger(model)` — `.record(technique, {before, after | beforeText, afterText, note})`,
  `.totalSaved()`, `.overallPct()`, `.byTechnique()`, `.report()`.

### `compressor.js`
- `compress(input, { level=2, model }) -> { text, before, after, saved, savedPct, level, protectedRegions }`.
- Levels: `0` whitespace only · `1` + filler words · `2` + politeness phrases + redundant-sentence dedup · `3` + connective trimming.
- **Safety contract:** content inside fenced code blocks, inline code, URLs, file
  paths, quoted strings, and technical identifiers (camelCase / snake_case /
  dotted / `CONST_CASE`) is masked before any transform and restored
  byte-for-byte. `mask`/`unmask` round-trip to the exact original.

### `semantic-cache.js`
- `new SemanticCache({ maxHamming=3, bands=8, maxEntries=500, ttlMs=0, shingleK=2 })`.
- `.set(requestText, value, meta?) -> id`, `.get(requestText) -> { hit, value?, distance?, similarity?, id?, meta? }`.
- `.prune()`, `.clear()`, `.hitRate()`, `.size`, `.stats`.
- Similarity is SimHash Hamming distance over word shingles, indexed by LSH bands
  for sub-linear lookup. `simhash`, `hamming`, `minhash`, `minhashSimilarity`
  are exported for direct use.

### `context-packer.js`
- `pack(chunks, budget, { model, unit?, workCap? }) -> { included, dropped, usedTokens, budget, totalRelevance, strategy, report }`.
- Each chunk: `{ id?, label?, content?, tokens?, relevance?|score? }`. Tokens are
  estimated from `content` when not given.
- Exact 0/1 knapsack (`exact-dp`) when the quantized table is affordable, else a
  value-density `greedy`. Deterministic tie-breaking throughout. `dropped[].reason`
  explains every exclusion.
- `assemble(result) -> string` concatenates included chunks with labels.

### `diff-context.js`
- `changedLineRanges(oldText, newText) -> [{start, end}]` (1-based, LCS-based).
- `buildContext(fileText, ranges, { neighbors=3, includeSymbols=true, model, lineNumbers=true })`
  `-> { context, hunks, fullTokens, contextTokens, saved, savedPct, lines }`.
- `fromEdit(oldText, newText, opts)` — diff then build in one call.

### `cache-planner.js`
- `plan(segments, { provider, model }) -> { provider, messages, breakpoints, stablePrefixTokens, dynamicTokens, estimatedCacheableTokens, qualifies, reordered, notes }`.
- Each segment: `{ role?, content, stable?, kind? }`. `kind` of
  `system|tools|context|instructions|docs|schema|examples` is treated as
  prefix-stable by default.
- Anthropic: emits up to 4 `cache_control:{type:"ephemeral"}` breakpoints on the
  stable prefix. OpenAI: no flags (caching is automatic ≥ ~1024-token prefix); it
  orders stable-first and reports eligibility. `describe(provider)` documents each.

## Savings methodology (honest, NX-101 style)

All counts are **heuristic estimates**, not billing-grade. The real tokenizers
(tiktoken / Claude BPE) are large data tables we deliberately do not vendor, so
the estimator approximates them (word-run density + coarse punctuation charging,
tuned per model family). Expect roughly **±15%** absolute error versus a real
tokenizer. It is deterministic, which is what matters for the packer and diff
builder making stable decisions, and good enough for budgeting and for attributing
*relative* savings.

What each technique actually saves, and where it does **not**:

- **Diff-context** is the big win and the most reliable: a small edit in a large
  file routinely avoids 90%+ of the file's tokens (benchmark: a one-line change in
  an 800-line file saves ~98%). On a tiny file, or an edit that touches most
  lines, it saves little or nothing — by design, `saved` is `0` when there are no
  hunks.
- **Context packer** saves exactly the tokens of the chunks it drops; if
  everything already fits the budget, it saves nothing (and shouldn't pretend to).
- **Prompt compressor** is modest: typically **15–35%** of a *verbose* prose
  prompt at level 2. On already-terse prompts, or prompts that are mostly code
  (which is protected and never touched), savings approach **0%** — correctly.
  Levels 2 and 3 often tie when there are no leading connectives to trim.
- **Semantic cache** saves a *whole turn* on a hit, but only on genuine
  near-duplicates. The default is deliberately conservative (`maxHamming:3`,
  `shingleK:2`) to avoid returning a cached answer to a request that only *looks*
  similar — a wrong hit is worse than a miss here. Short prompts have noisier
  fingerprints, so near-duplicate recall improves as prompts get longer. Callers
  who want aggressive paraphrase matching can raise `maxHamming` (≈8–12 works well
  for sentence-length prompts) or set `shingleK:1` (order-insensitive, higher
  recall, slightly higher false-hit risk).
- **Prompt-cache planner** does not reduce token *counts*; it reduces token
  *cost* by making a provider's prompt cache reusable. The dollar saving depends
  entirely on the provider's cache-read discount and on the prefix actually
  repeating across calls.

Run the benchmark to see before/after on sample inputs:

```bash
node src/tokensave/benchmark.js           # generic model family
node src/tokensave/benchmark.js claude    # estimate for a family
```

## Integration

This subsystem adds only new files under `src/tokensave/`. The CLI/engine wiring
(what to call from where) is described in `INTEGRATION.md` so it can be applied
without merge conflicts.
