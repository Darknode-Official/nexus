"use strict";
// NX-101 / NX-110 fixed task set. Each task carries provenance so a reader can
// judge contamination risk for any LIVE-engine run (see bench/README.md). For the
// deterministic OVERHEAD measurement provenance is irrelevant (no model is called),
// but it is recorded here so the same set can drive the live eval harness later.
//
// provenance:
//   "synthetic"     — written for this harness, never published; safe for any engine.
//   "repo-local"    — references files in THIS private repo; safe unless the repo is public.
// class: the evaluation axis from NX-110.
module.exports = [
  { id: "t1", class: "feature-existing", provenance: "synthetic",
    task: "Add a --json flag to the telemetry dashboard command so it prints machine-readable output." },
  { id: "t2", class: "multi-file", provenance: "synthetic",
    task: "Rename the costsave.squeezeContext function to compactContext across the codebase and update all callers and tests." },
  { id: "t3", class: "diagnosis", provenance: "synthetic",
    task: "The budget enforcer stops a run one step too late; diagnose from the failing trace why the ceiling check runs after the charge instead of before." },
  { id: "t4", class: "long-horizon", provenance: "synthetic",
    task: "Implement an append-only audit log for the sandbox with rotation, a verify command, and tests, then wire it into execute()." },
  { id: "t5", class: "dependency-upgrade", provenance: "synthetic",
    task: "Upgrade the project to Node 22 features where safe and record any API that changed." },
  { id: "t6", class: "security-capability", provenance: "synthetic",
    task: "Refuse any shell command that writes outside the declared project root even via a symlink or ../ traversal." },
  { id: "t7", class: "feature-existing", provenance: "repo-local",
    task: "Add a cache-hit counter to costsave.cacheGet and surface it in cacheStats." },
  { id: "t8", class: "diagnosis", provenance: "synthetic",
    task: "Explain why cowork.costSavings reports a larger saving than pricing.js would — which pricing table is stale." },
];
