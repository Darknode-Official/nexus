# Claim substantiation (NX-109)

Every quantitative public claim maps to a reproducible measurement. Run
`npm run stats` for the live module/line/test counts. Figures below were measured
on branch `feat/nexus-eng`.

| Claim (as published) | Measured | Status | Reproduce |
|----------------------|----------|--------|-----------|
| 61 modules, 11,860 lines | 61 / 11,860 at the inherited release; **70 / ~13,200 now** (this branch added 9 modules) | UPDATED — README architecture box refreshed to current measured counts | `ls src/*.js \| wc -l` ; `cat src/*.js \| wc -l` |
| zero-dependency test suite | 0 deps, 0 devDeps; **202 tests pass** (was 139) | CONFIRMED | `node -e "const p=require('./package.json');console.log(p.dependencies,p.devDependencies)"` ; `npm test` |
| 25 MCP servers, 6 bundled | 25 catalog entries, 6 bundled (`fetch, memory, sequential-thinking, context7, time, git`) | CONFIRMED | `node -e "const c=require('./src/mcp-catalog');console.log(Object.keys(c.MCP_CATALOG).length,c.DEFAULT_MCP.length)"` |
| 4 structured thinking modes | 4: `analyze, debug, design, decide` | CONFIRMED | `grep -oE '(analyze\|debug\|design\|decide):' src/reasoning.js \| sort -u` |
| 8 AI engines | **7 entries in the engine registry** (`claude, gemini, codex, opencode, aider, ollama, darknode`) | DISCREPANCY — the "8" counts "Any OpenAI-compat API" and "Anthropic native API" as separate engines, but they are not separate registry entries. Honest count of registry engines = 7 (plus two API transport variants). | `grep -cE '^  [a-z]+: \{' src/engines.js` |
| Cost Saver 10-30% savings | 63.5% best case (duplicated blocks), **0% on a realistic single-pass turn** | DROPPED / QUALIFIED (see NX-101, `bench/`) | `node bench/nx101-costsaver.js` |
| cowork "saves 60-80%" | unsubstantiated; default pricing was Opus-3 ($15/$75), ~3x overstated | FIXED — marketing claim removed from source; `costSavings` now derives default rates from `pricing.js` | see `src/cowork.js` diff |
| Nexus cheaper than the engine alone | full path adds ~3,900 input tok/turn (~153x bare); 0/8 tasks at or below bare | REFUTED for input; net dollars NOT YET MEASURED (needs live engines) | `node bench/nx101-overhead.js` |

## Module inventory

`bench/results/module-inventory.json` lists all 70 modules with LOC and whether a
test in `test/run.js` references them: **60/70 referenced by a test.** The
10 not directly referenced are mostly thin utilities or integration layers
(`mcp-bridge`, `report-gen`, ...); they load and lint in CI but lack dedicated
behavioural tests — flagged as the test-depth gap.

The "~194 lines/module" average is misleading: distribution is skewed. A few
modules are large (`mcp-3d-modeler` ~1,060, `nxp` ~605, `prompt-engine` ~453,
`security-rag`, `learning-engine`) while many are <120 lines. Line count is not a
proxy for production-depth.

### Depth assessment (modules read in this engagement)

Production-depth (real logic, tested): `pricing`, `costsave`, `overhead`,
`budget`, `capability`, `sandbox`, `multi-agent`, `loop`, `loop-detect`,
`error-recovery`, `eval`, `ledger`, `steering`, `knowledge-graph`, `context`,
`prompt-engine`, `cowork`, `telemetry`, `autocorrect`, `config`, `local-preflight`.

Not individually audited for depth in this pass (loads + lints, referenced by a
smoke test only): the remaining ~40 modules. Claiming each is "production-depth"
would be unverified; they are listed as **inventoried, not depth-audited**.

## Naming reconciliation

Within this repo the product is consistently `darknode nexus` (README, package
`name: nexus`). The README correctly points to `darknode-cli` as the shipping
host. No `SpartanKing18`, `sentinel nexus`, or `jawahar` references exist in
`src/`, `index.js`, or `README.md` (grep clean). The one external name,
`darknode-cli`, is the documented host package, not an inconsistency.

## Residual

- The 7-vs-8 engine count needs an owner decision: either add an 8th registry
  entry or change the published "8 engines" to "7 engines + OpenAI-compatible and
  native-API transports". Left as a documented discrepancy, not silently changed.
- Per-module production-depth audit of the ~40 unread modules is outstanding.
