# Nexus LSP — ground-truth semantic intelligence

A dependency-free **Language Server Protocol client** for Nexus. Where
`src/codegraph` infers structure with language heuristics, this subsystem talks to
a **real language server** (when one is installed) and returns compiler-grade
answers: diagnostics, go-to-definition, find-references, hover types, document /
workspace symbols, completion, rename and formatting.

Everything here is **Node stdlib only** — no third-party packages.

## Why both codegraph and LSP?

- **codegraph** always works (no external tool), is fast, and is great for
  repo-wide structure, duplication and blast-radius heuristics.
- **LSP** is *ground truth* — it is the same engine the compiler/IDE uses — but it
  requires the matching language server to be installed on the machine.

The façade degrades gracefully: when no server is installed, every call returns
`{ available: false, reason, installHint }` so the agent can fall back to
codegraph and tell the user **exactly** what to install (the NX-107 "say what's
missing" principle).

## Quick start

```js
const lsp = require("./src/lsp");
const nx = new lsp.NexusLsp({ cwd: process.cwd() });

const d = await nx.diagnostics("src/app.ts");
if (!d.available) {
  console.log("LSP unavailable:", d.reason);
  console.log("Install:", d.installHint);     // e.g. "npm i -g typescript-language-server typescript"
} else {
  for (const diag of d.diagnostics) {
    console.log(`${diag.line + 1}:${diag.column + 1} ${diag.severity}: ${diag.message}`);
  }
}

const def = await nx.definition("src/app.ts", { line: 11, character: 4 });
const refs = await nx.references("src/app.ts", { line: 11, character: 4 });
const r = await nx.rename("src/app.ts", { line: 11, character: 4 }, "newName");

await nx.dispose();   // shut every spawned server down cleanly
```

## CLI demo

```
node src/lsp/cli.js info                      # which servers are installed + how to install the rest
node src/lsp/cli.js diagnostics src/app.ts
node src/lsp/cli.js definition  src/app.ts 12:5    # positions are 1-based line:col
node src/lsp/cli.js references  src/app.ts 12:5
node src/lsp/cli.js hover       src/app.ts 12:5
node src/lsp/cli.js symbols     src/app.ts
node src/lsp/cli.js wsymbols    "myFunction" --for src/app.ts
```

Exit codes: `0` success, `1` usage error, `2` diagnostics contained an error, `3`
feature unavailable (no server installed — reported clearly, not a crash).

## Architecture

| Module        | Responsibility |
|---------------|----------------|
| `framing.js`  | Content-Length codec; `MessageReader` reassembles messages across **any** chunk boundary (split header, split body, glued frames, resync after corruption). |
| `rpc.js`      | JSON-RPC 2.0 endpoint over any `{ input, output }` stream pair: id correlation, notifications, inbound server→client requests (with benign defaults), cancellation (AbortSignal + `$/cancelRequest`), per-request timeouts, batching, graceful close. |
| `protocol.js` | LSP enums, URI↔path, result **normalizers** (Location/LocationLink, hover markup, hierarchical vs flat symbols, completion, WorkspaceEdit), and the incremental-sync minimal-diff computation. Pure, no I/O. |
| `registry.js` | Language/extension → server map for the common servers (tsserver, pyright/pylsp, gopls, rust-analyzer, clangd, jdtls, lua-ls, bash-ls) + **PATH-based install detection** (no spawn). |
| `process.js`  | **Real-spawn** transport: `ManagedServer` spawns a server child, exposes its stdio as `{ input, output }`, surfaces stderr, enforces a startup window, and restarts on crash with bounded exponential backoff. |
| `mock.js`     | **Scripted in-memory server** over a cross-wired pipe — the deterministic, dependency-free twin of `process.js` used by the whole test suite (and the demo when nothing is installed). |
| `client.js`   | One connection, end to end: initialize/initialized/shutdown/exit + capability negotiation, document sync (open/change/close with version tracking and incremental changes), diagnostics subscription, and all feature wrappers. |
| `facade.js`   | `NexusLsp` — the high-level object the agent calls. Picks + spawns + reuses the right server per language, auto-opens documents, and returns normalized results or graceful unavailability. |
| `index.js`    | Public entrypoint. |
| `cli.js`      | Runnable demo CLI. |

## Testing & the mock/real split

The protocol logic is tested **entirely against the in-memory `MockServer`**, so
the suite is deterministic and needs no compiler installed:

```
node --test test/lsp/
```

- `framing`, `rpc`, `protocol`, `mock`, `registry`, `client`, `facade`, `cli` are
  all mock- or fixture-backed — **no external process**.
- `process.test.js` exercises the **real spawn path** using `node` itself as a
  controllable child (spawn/stop, restart-with-backoff, giveup, missing-binary).

## Honest limitations (what needs a real server)

- **No bundled language servers.** This is a *client*. Real diagnostics /
  definitions / rename require the matching server on `PATH` (`nexus lsp info`
  shows which are present). With none installed the API is fully usable but every
  feature returns `{ available: false, ... }`.
- **Character encoding.** Positions use UTF-16 code units per the LSP spec; the
  incremental-diff helper counts JS string code units, which is correct for the
  BMP (the overwhelmingly common case). Astral-plane code points inside an edited
  range are not specially split.
- **Capability-gated.** Features the server does not advertise return an
  `{ unsupported: true, capability }` marker rather than a hard error.
- **`workspace/applyEdit`** from the server is answered `{ applied: false }` — the
  client surfaces edits for Nexus's own patch engine to apply, it does not mutate
  files behind the agent's back.
