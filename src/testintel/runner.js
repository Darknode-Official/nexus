"use strict";
// ===================== Test Intelligence — Runner Adapters =====================
// Build the right command line for each runner and (optionally) execute it, capturing
// output and normalizing it through ./parsers.js into the unified model. Execution uses
// Node's child_process; when a runner binary isn't present we return a Result with
// available:false and a clear reason instead of a cryptic spawn error.
//
//   buildCommand(runner, opts)  -> { cmd, args, parseAs, env }  (pure, no execution)
//   isAvailable(runner, opts)   -> { available, reason, cmd }
//   run(runner, opts)           -> Promise<Result>  (spawns, parses, annotates)
//   runSync(runner, opts)       -> Result           (spawnSync variant)
//
// opts (all optional): { cwd, files[], grep, coverage, jsonArgs, timeoutMs, env, extraArgs[] }
const cp = require("child_process");
const parsers = require("./parsers");
const model = require("./model");

// ---------------------------------------------------------------------------
// Command construction. Each adapter picks a reporter that gives machine-readable
// output and records how to parse it (`parseAs`).
// ---------------------------------------------------------------------------
function buildCommand(runner, opts) {
  opts = opts || {};
  const files = opts.files || [];
  switch (String(runner)) {
    case "node:test":
    case "node": {
      const args = ["--test"];
      if (opts.coverage) args.push("--experimental-test-coverage");
      if (opts.grep) args.push("--test-name-pattern", opts.grep);
      for (const f of files) args.push(f);
      args.push(...(opts.extraArgs || []));
      return { cmd: process.execPath, args, parseAs: "node:test", coverageFrom: "stdout" };
    }
    case "jest": {
      const args = ["jest", "--json"];
      if (opts.coverage) args.push("--coverage", "--coverageReporters=lcov", "--coverageReporters=json-summary");
      if (opts.grep) args.push("-t", opts.grep);
      for (const f of files) args.push(f);
      args.push(...(opts.extraArgs || []));
      return { cmd: "npx", args, parseAs: "jest", coverageFrom: "file" };
    }
    case "mocha": {
      const args = ["mocha", "--reporter", "json"];
      if (opts.grep) args.push("--grep", opts.grep);
      for (const f of files) args.push(f);
      args.push(...(opts.extraArgs || []));
      return { cmd: "npx", args, parseAs: "mocha", coverageFrom: null };
    }
    case "pytest": {
      const args = ["-v"];
      if (opts.coverage) args.push("--cov", "--cov-report=term-missing");
      if (opts.grep) args.push("-k", opts.grep);
      for (const f of files) args.push(f);
      args.push(...(opts.extraArgs || []));
      return { cmd: "pytest", args, parseAs: "pytest", coverageFrom: "stdout" };
    }
    case "go test":
    case "go": {
      const args = ["test", "-json"];
      if (opts.coverage) args.push("-cover");
      if (opts.grep) args.push("-run", opts.grep);
      const targets = files.length ? files : ["./..."];
      for (const t of targets) args.push(t);
      args.push(...(opts.extraArgs || []));
      return { cmd: "go", args, parseAs: "go test", coverageFrom: "stdout" };
    }
    default:
      throw new Error("Unknown runner: " + runner);
  }
}

// isAvailable — check the runner's launcher exists without running the suite.
// For npx-based runners we probe the local binary; for others, `--version`/`which`.
function isAvailable(runner, opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  let probe;
  switch (String(runner)) {
    case "node:test": case "node": return { available: true, reason: null, cmd: process.execPath };
    case "jest": probe = { cmd: "npx", args: ["jest", "--version"] }; break;
    case "mocha": probe = { cmd: "npx", args: ["mocha", "--version"] }; break;
    case "pytest": probe = { cmd: "pytest", args: ["--version"] }; break;
    case "go test": case "go": probe = { cmd: "go", args: ["version"] }; break;
    default: return { available: false, reason: "unknown runner", cmd: null };
  }
  try {
    const r = cp.spawnSync(probe.cmd, probe.args, { cwd, encoding: "utf8", timeout: opts.probeTimeoutMs || 15000 });
    if (r.error) return { available: false, reason: probe.cmd + " not found: " + r.error.message, cmd: probe.cmd };
    if (r.status !== 0 && !(r.stdout || r.stderr)) return { available: false, reason: probe.cmd + " exited " + r.status, cmd: probe.cmd };
    return { available: true, reason: null, cmd: probe.cmd, version: (r.stdout || r.stderr || "").trim().split("\n")[0] };
  } catch (e) {
    return { available: false, reason: String(e && e.message || e), cmd: probe.cmd };
  }
}

// annotate(result, runner, extra) — attach exit/availability metadata consistently.
function annotate(result, runner, extra) {
  result.runner = runner;
  Object.assign(result, extra);
  if (result.available === undefined) result.available = true;
  return result;
}

// run — async execution. Resolves (never rejects) with a Result; execution problems
// are encoded as errored/available:false so the agent handles them uniformly.
function run(runner, opts) {
  opts = opts || {};
  const spec = safeBuild(runner, opts);
  if (spec.error) return Promise.resolve(unavailableResult(runner, spec.error));
  const avail = isAvailable(runner, opts);
  if (!avail.available) return Promise.resolve(unavailableResult(runner, avail.reason));
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "", stderr = "", done = false;
    let child;
    try {
      child = cp.spawn(spec.cmd, spec.args, { cwd: opts.cwd || process.cwd(), env: childEnv(opts) });
    } catch (e) { return resolve(unavailableResult(runner, String(e && e.message || e))); }
    const finish = (extra) => {
      if (done) return; done = true;
      const text = combineStreams(spec.parseAs, stdout, stderr);
      const result = parsers.parse(spec.parseAs, text);
      annotate(result, runner, Object.assign({ durationMs: Date.now() - started, stdout, stderr, command: spec.cmd + " " + spec.args.join(" ") }, extra));
      resolve(result);
    };
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} finish({ errored: true, timedOut: true, ok: false }); }, opts.timeoutMs) : null;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve(unavailableResult(runner, String(e && e.message || e))); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); finish({ exitCode: code }); });
  });
}

// runSync — synchronous variant (handy for the CLI and simple scripts).
function runSync(runner, opts) {
  opts = opts || {};
  const spec = safeBuild(runner, opts);
  if (spec.error) return unavailableResult(runner, spec.error);
  const avail = isAvailable(runner, opts);
  if (!avail.available) return unavailableResult(runner, avail.reason);
  const started = Date.now();
  const r = cp.spawnSync(spec.cmd, spec.args, { cwd: opts.cwd || process.cwd(), encoding: "utf8", timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer || 64 * 1024 * 1024, env: childEnv(opts) });
  if (r.error && r.error.code === "ENOENT") return unavailableResult(runner, spec.cmd + " not found");
  const text = combineStreams(spec.parseAs, r.stdout || "", r.stderr || "");
  const result = parsers.parse(spec.parseAs, text);
  annotate(result, runner, { durationMs: Date.now() - started, stdout: r.stdout, stderr: r.stderr, exitCode: r.status, command: spec.cmd + " " + spec.args.join(" "), timedOut: !!(r.error && r.error.code === "ETIMEDOUT") });
  if (r.error && r.error.code === "ETIMEDOUT") { result.errored = true; result.ok = false; }
  return result;
}

// For runners whose structured output goes to stdout but detail may be on stderr,
// pick the right stream(s) to feed the parser.
function combineStreams(parseAs, stdout, stderr) {
  if (parseAs === "jest" || parseAs === "mocha") {
    // jest prints JSON to stdout; some versions use stderr for the --json payload.
    const s = (stdout || "").trim();
    if (s.startsWith("{")) return stdout;
    const e = (stderr || "").trim();
    if (e.startsWith("{") || e.includes('"testResults"') || e.includes('"stats"')) return stderr;
    return stdout + "\n" + stderr;
  }
  if (parseAs === "pytest") return (stdout || "") + "\n" + (stderr || "");
  return stdout || stderr || "";
}

function safeBuild(runner, opts) { try { return buildCommand(runner, opts); } catch (e) { return { error: String(e && e.message || e) }; } }

// childEnv — base environment for spawned runners. Strips NODE_TEST_CONTEXT so that a
// nested `node --test` always emits the default TAP reporter (node:test switches to an
// internal V8-serialized reporter for child contexts, which we can't parse). Harmless
// outside a test context, essential inside one.
function childEnv(opts) {
  const env = Object.assign({}, process.env, (opts && opts.env) || {});
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function unavailableResult(runner, reason) {
  const r = model.emptyResult(runner, { errored: true });
  r.ok = false; r.available = false; r.reason = reason || "runner unavailable";
  r.meta = { note: "runner not available or command failed to start", reason: r.reason };
  return r;
}

module.exports = { buildCommand, isAvailable, run, runSync, combineStreams };
