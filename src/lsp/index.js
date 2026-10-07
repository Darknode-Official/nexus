"use strict";
// ============================= Nexus LSP subsystem — public entrypoint =============================
// Ground-truth semantic intelligence for Nexus. Where codegraph infers structure
// with language heuristics, this subsystem talks to a REAL language server when
// one is installed and returns compiler-grade answers: diagnostics, definitions,
// references, hover types, symbols, completion, rename and formatting.
//
//   framing   — Content-Length codec with robust partial-chunk handling
//   rpc       — JSON-RPC 2.0 endpoint (correlation, notifications, cancellation,
//               batching, timeouts, graceful close)
//   protocol  — LSP enums, URI<->path, result normalizers, incremental diff
//   registry  — language/extension -> server map + install detection (NX-107)
//   process   — managed child-process spawn with restart-on-crash (real path)
//   mock      — scripted in-memory server (deterministic, dependency-free tests)
//   client    — lifecycle + document sync + feature wrappers for one connection
//   facade    — NexusLsp: the high-level object the agent actually calls
//
// Quick start (high level):
//   const lsp = require("./src/lsp");
//   const nx = new lsp.NexusLsp({ cwd: process.cwd() });
//   const d = await nx.diagnostics("src/app.ts");
//   if (!d.available) console.log("LSP unavailable:", d.reason, d.installHint);
//   else console.log(d.diagnostics);
//   await nx.dispose();
//
// See README.md for the full API and an honest note on what needs a real server.
// Zero third-party dependencies — Node stdlib only.

const framing = require("./framing");
const rpc = require("./rpc");
const protocol = require("./protocol");
const registry = require("./registry");
const processMgr = require("./process");
const mock = require("./mock");
const { LspClient, CLIENT_CAPABILITIES } = require("./client");
const { NexusLsp } = require("./facade");

module.exports = {
  // high-level entrypoints
  NexusLsp,
  LspClient,
  // building blocks (exposed for advanced use / testing)
  framing,
  rpc,
  protocol,
  registry,
  process: processMgr,
  mock,
  CLIENT_CAPABILITIES,
  // frequently used helpers, surfaced for convenience
  JsonRpcEndpoint: rpc.JsonRpcEndpoint,
  RpcError: rpc.RpcError,
  MockServer: mock.MockServer,
  ManagedServer: processMgr.ManagedServer,
};
