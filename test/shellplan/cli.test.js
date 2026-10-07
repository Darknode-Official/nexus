"use strict";
// Tests for the shellplan CLI front-end: argument parsing, policy building, and the
// exit codes / output of each subcommand (stdout captured, nothing executed).

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { main, parseArgv, buildPolicy } = require("../../src/shellplan/cli");

let out, err, origOut, origErr;
beforeEach(() => {
  out = ""; err = "";
  origOut = process.stdout.write; origErr = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
});
afterEach(() => { process.stdout.write = origOut; process.stderr.write = origErr; });

describe("shellplan/cli: parseArgv", () => {
  it("collects positional args and flags", () => {
    const o = parseArgv(["explain", "ls", "-la", "--json", "--cwd", "/x", "--root", "/r", "--allow", "ls"]);
    assert.deepEqual(o._, ["explain", "ls", "-la"]);
    assert.equal(o.json, true);
    assert.equal(o.cwd, "/x");
    assert.deepEqual(o.roots, ["/r"]);
    assert.deepEqual(o.allow, ["ls"]);
  });

  it("collects repeatable --root/--allow/--net", () => {
    const o = parseArgv(["check", "cmd", "--root", "/a", "--root", "/b", "--net", "x.com", "--allow-destructive", "--confirmed"]);
    assert.deepEqual(o.roots, ["/a", "/b"]);
    assert.deepEqual(o.net, ["x.com"]);
    assert.equal(o.allowDestructive, true);
    assert.equal(o.confirmed, true);
  });

  it("buildPolicy maps flags to a policy object", () => {
    const o = parseArgv(["check", "cmd", "--root", "/a", "--allow", "git", "--net", "github.com", "--allow-destructive"]);
    const p = buildPolicy(o);
    assert.deepEqual(p.roots, ["/a"]);
    assert.deepEqual(p.commands, ["git"]);
    assert.deepEqual(p.network, ["github.com"]);
    assert.equal(p.allowDestructive, true);
  });
});

describe("shellplan/cli: subcommands", () => {
  it("explain prints a readable report", () => {
    const code = main(["explain", "rm -rf build"]);
    assert.equal(code, 0);
    assert.ok(out.includes("SUMMARY:"));
    assert.ok(out.includes("RISK"));
  });

  it("risk exits non-zero at/above threshold", () => {
    const code = main(["risk", "rm -rf /", "--threshold", "high"]);
    assert.equal(code, 1);
    assert.ok(out.includes("critical"));
  });

  it("risk exits zero for a benign command", () => {
    const code = main(["risk", "ls -la"]);
    assert.equal(code, 0);
    assert.ok(/No risk rules matched/.test(out));
  });

  it("parse prints JSON AST", () => {
    const code = main(["parse", "echo hi"]);
    assert.equal(code, 0);
    const ast = JSON.parse(out);
    assert.equal(ast.type, "script");
  });

  it("files lists targets", () => {
    main(["files", "cp a b"]);
    assert.ok(out.includes("[READ]"));
    assert.ok(out.includes("[WRITE]"));
  });

  it("plan emits JSON with steps", () => {
    main(["plan", "rm x"]);
    const p = JSON.parse(out);
    assert.ok(Array.isArray(p.steps));
  });

  it("check returns ALLOW with a permissive policy", () => {
    const code = main(["check", "ls", "--allow", "ls", "--root", process.cwd()]);
    assert.equal(code, 0);
    assert.ok(out.includes("ALLOW"));
  });

  it("check returns DENY and exit 1 for a disallowed command", () => {
    const code = main(["check", "wget http://x", "--allow", "ls"]);
    assert.equal(code, 1);
    assert.ok(out.includes("DENY"));
  });

  it("--json produces machine output for explain", () => {
    main(["explain", "ls", "--json"]);
    const obj = JSON.parse(out);
    assert.ok(obj.summary);
  });

  it("prints usage with no args", () => {
    const code = main([]);
    assert.equal(code, 0);
    assert.ok(out.includes("Usage:"));
  });

  it("errors with a subcommand but no command", () => {
    const code = main(["explain"]);
    assert.equal(code, 2);
    assert.ok(err.includes("no command given"));
  });

  it("errors on an unknown subcommand", () => {
    const code = main(["bogus", "x"]);
    assert.equal(code, 2);
    assert.ok(err.includes("unknown subcommand"));
  });
});
