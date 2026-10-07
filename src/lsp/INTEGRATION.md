# Nexus LSP — integration notes for the Nexus core

This subsystem is **self-contained** under `src/lsp/` and touches **no existing
file** (conflict-free merge). The wiring below must be added by the Nexus core
maintainer in the existing files listed per change. Nothing runs automatically.

## 1. Expose the subsystem from the package root

`index.js` (repo root) — add alongside the other `require`s and in `module.exports`:

```js
// Semantic intelligence
const lsp = require("./src/lsp");   // LSP client — ground-truth compiler data
// ...
module.exports = {
  // ... existing exports ...
  lsp,
};
```

That single export surfaces `lsp.NexusLsp` (the façade), `lsp.LspClient`,
`lsp.registry`, `lsp.MockServer`, and the lower-level `framing` / `rpc` /
`protocol` / `process` building blocks.

## 2. CLI subcommand

Wherever the `nexus` / `darknode nexus` CLI dispatches subcommands, add an `lsp`
command that delegates to the bundled CLI module:

```js
// pseudo-wiring in the CLI dispatcher
if (cmd === "lsp") {
  const { main } = require("./src/lsp/cli");
  main(argv.slice(1)).then((code) => process.exit(code));
  return;
}
```

`src/lsp/cli.js` already supports being invoked directly, and strips a leading
`lsp` token, so `node src/lsp/cli.js lsp diagnostics <file>` also works for a
thin shell shim.

## 3. Test wiring (package.json — maintainer action)

I **cannot modify `package.json`** under the conflict-free rule, so the new tests
are not yet in the `npm test` glob. Add `test/lsp/` to the `test` and
`test:verbose` scripts:

```jsonc
"test": "node --test test/run.js test/ui.test.js test/tokensave/ test/codegraph/ test/sectools/ test/perf/ test/patch/ test/lsp/",
```

Until then, run the suite directly:

```
node --test test/lsp/       # 117 tests, all deterministic, no server required
```

Optionally add `"lsp"` to the `requiredModules` assertion list in `test/run.js`
(additive, not required).

## 4. Suggested agent/engine wiring

The façade is the only object the agent needs. Recommended touch points:

- **Pre-edit / verification gate.** After the patch engine (`src/patch`) applies a
  change, call `lsp.diagnostics(file, { text: newContent })`. If `available` and
  any `severityCode === 1` (error) appears that was not there before, treat the
  edit as regressing and offer to revert — a real compiler check on top of
  `src/patch/verify`.

- **"Where is X used / defined" tools.** Route the agent's reference/definition
  questions to `lsp.references` / `lsp.definition` first; fall back to
  `codegraph` when `available === false`. This gives true cross-file resolution
  when a server is present and heuristics otherwise.

- **Safe rename.** Prefer `lsp.rename(file, pos, newName)` over the codemod
  identifier heuristic when a server is installed: the returned normalized
  `WorkspaceEdit` (`result.rename.changes`) feeds straight into
  `src/patch/transaction` for an atomic, reversible multi-file apply.

- **Capability advertisement.** `lsp.info()` powers a `nexus doctor`-style report
  of which language servers are installed and how to install the rest.

### Lifecycle note

`NexusLsp` spawns servers lazily (first use per language) and reuses them. Call
`await nx.dispose()` on agent shutdown to send `shutdown`/`exit` and reap the
child processes. One `NexusLsp` per workspace root is the intended pattern.

## 5. No new dependencies

Zero third-party packages are introduced. `package.json` `dependencies` are
untouched by this subsystem.
