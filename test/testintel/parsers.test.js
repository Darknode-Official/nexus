"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const parsers = require("../../src/testintel/parsers");

// --- captured real node:test TAP v13 output (node v20) ---
const TAP = `TAP version 13
# Subtest: adds
ok 1 - adds
  ---
  duration_ms: 0.664859
  ...
# Subtest: fails
not ok 2 - fails
  ---
  duration_ms: 0.538894
  location: '/tmp/s.test.js:4:1'
  failureType: 'testCodeFailure'
  error: '2 == 3'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 3
  actual: 2
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/tmp/s.test.js:4:30)
    Test.run (node:internal/test_runner/test:796:25)
  ...
# Subtest: skipme
ok 3 - skipme # SKIP not ready
  ---
  duration_ms: 0.105787
  ...
1..3
# tests 3
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 34.95893`;

describe("testintel/parsers — node:test TAP", () => {
  const r = parsers.parseTap(TAP);
  it("counts pass/fail/skip correctly", () => {
    assert.deepEqual(r.counts, { total: 3, pass: 1, fail: 1, skip: 1, todo: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.runner, "node:test");
  });
  it("extracts the YAML diagnostic (error, expected/actual, operator, stack, location)", () => {
    const fail = r.tests.find((t) => t.status === "fail");
    assert.equal(fail.name, "fails");
    assert.equal(fail.failure.message, "2 == 3");
    assert.equal(fail.failure.expected, 3);
    assert.equal(fail.failure.actual, 2);
    assert.equal(fail.failure.operator, "==");
    assert.equal(fail.failure.type, "AssertionError");
    assert.match(fail.failure.stack, /TestContext/);
    assert.equal(fail.failure.location, "/tmp/s.test.js:4:1");
  });
  it("recognises SKIP directives", () => {
    assert.equal(r.tests.find((t) => t.name === "skipme").status, "skip");
  });
  it("keeps the TAP summary footer in meta", () => {
    assert.equal(r.meta.tap.pass, 1);
    assert.equal(r.meta.tap.fail, 1);
  });
  it("flags garbage input as errored rather than a silent pass", () => {
    const bad = parsers.parseTap("not test output at all");
    assert.equal(bad.errored, true);
    assert.equal(bad.ok, false);
  });
});

describe("testintel/parsers — jest --json", () => {
  const JEST = JSON.stringify({
    success: false, numTotalTests: 2, numPassedTests: 1, numFailedTests: 1,
    startTime: 1000, endTime: 1050,
    testResults: [{ name: "/a/math.test.js", assertionResults: [
      { title: "adds", status: "passed", duration: 5, ancestorTitles: ["math"] },
      { title: "breaks", status: "failed", duration: 3, ancestorTitles: ["math"], failureMessages: ["Error: expect(received).toBe(expected)\n\n  at Object.<anonymous> (/a/math.test.js:5:20)"] },
    ] }],
  });
  const r = parsers.parseJestJson(JEST);
  it("counts and marks failure", () => {
    assert.deepEqual(r.counts, { total: 2, pass: 1, fail: 1, skip: 0, todo: 0 });
    assert.equal(r.ok, false);
  });
  it("builds a fullName from ancestor titles and extracts the failure line", () => {
    const f = r.tests.find((t) => t.status === "fail");
    assert.equal(f.fullName, "math > breaks");
    assert.match(f.failure.message, /expect\(received\)/);
    assert.equal(f.file, "/a/math.test.js");
  });
  it("errors on non-JSON", () => {
    assert.equal(parsers.parseJestJson("<<not json>>").errored, true);
  });
});

describe("testintel/parsers — mocha --reporter json", () => {
  const MOCHA = JSON.stringify({
    stats: { tests: 3, passes: 1, failures: 1, pending: 1, duration: 12 },
    tests: [
      { title: "a", fullTitle: "s a", duration: 1, err: {} },
      { title: "b", fullTitle: "s b", duration: 2, err: { message: "boom", stack: "Error: boom\n at x.js:3:1", expected: 1, actual: 2 } },
      { title: "c", fullTitle: "s c", duration: 0, err: {} },
    ],
    pending: [{ title: "c", fullTitle: "s c" }],
    failures: [{ title: "b", fullTitle: "s b", err: { message: "boom", stack: "Error: boom" } }],
    passes: [{ title: "a", fullTitle: "s a" }],
  });
  const r = parsers.parseMocha(MOCHA);
  it("classifies pass/fail/pending", () => {
    assert.deepEqual(r.counts, { total: 3, pass: 1, fail: 1, skip: 1, todo: 0 });
  });
  it("extracts failure detail including expected/actual", () => {
    const f = r.tests.find((t) => t.status === "fail");
    assert.equal(f.failure.message, "boom");
    assert.equal(f.failure.expected, 1);
    assert.equal(f.failure.actual, 2);
  });
});

describe("testintel/parsers — pytest text", () => {
  const PYTEST = `test_calc.py::test_add PASSED                 [ 50%]
test_calc.py::test_sub FAILED                 [100%]

=================================== FAILURES ===================================
__________________________________ test_sub ___________________________________
    def test_sub():
>       assert sub(5, 3) == 1
E       assert 2 == 1
test_calc.py:8: AssertionError
=========================== short test summary info ============================
FAILED test_calc.py::test_sub - assert 2 == 1
========================= 1 failed, 1 passed in 0.03s ==========================`;
  const r = parsers.parsePytest(PYTEST);
  it("parses -v per-test lines and the footer", () => {
    assert.equal(r.counts.pass, 1);
    assert.equal(r.counts.fail, 1);
    assert.equal(r.ok, false);
    assert.equal(r.meta.footer.durationSec, 0.03);
  });
  it("attaches the assertion message and location to the full test id", () => {
    const f = r.tests.find((t) => t.status === "fail");
    assert.equal(f.name, "test_calc.py::test_sub");
    assert.equal(f.failure.message, "assert 2 == 1");
    assert.equal(f.failure.location, "test_calc.py:8");
  });
  it("reconciles counts from the footer when non-verbose output names only failures", () => {
    const NV = `test_m.py ..F                                [100%]

=================================== FAILURES ===================================
_________________________________ test_three __________________________________
E       assert 0 == 1
test_m.py:10: AssertionError
=========================== short test summary info ============================
FAILED test_m.py::test_three - assert 0 == 1
========================= 1 failed, 2 passed in 0.01s ==========================`;
    const nv = parsers.parsePytest(NV);
    assert.equal(nv.counts.pass, 2);
    assert.equal(nv.counts.fail, 1);
    assert.equal(nv.counts.total, 3);
    assert.equal(nv.ok, false);
  });
  it("handles an all-green footer", () => {
    const ok = parsers.parsePytest("test_x.py::test_ok PASSED [100%]\n===== 1 passed in 0.01s =====");
    assert.equal(ok.ok, true);
    assert.equal(ok.counts.pass, 1);
  });
});

describe("testintel/parsers — go test -json", () => {
  const GO = [
    { Action: "run", Package: "p", Test: "TestAdd" },
    { Action: "pass", Package: "p", Test: "TestAdd", Elapsed: 0.01 },
    { Action: "run", Package: "p", Test: "TestSub" },
    { Action: "output", Package: "p", Test: "TestSub", Output: "    calc_test.go:12: got 2 want 1\n" },
    { Action: "fail", Package: "p", Test: "TestSub", Elapsed: 0.0 },
    { Action: "fail", Package: "p", Elapsed: 0.02 },
  ].map((o) => JSON.stringify(o)).join("\n");
  const r = parsers.parseGoTest(GO);
  it("parses NDJSON events into pass/fail", () => {
    assert.deepEqual(r.counts, { total: 2, pass: 1, fail: 1, skip: 0, todo: 0 });
    assert.equal(r.ok, false);
  });
  it("extracts the *_test.go failure message and location", () => {
    const f = r.tests.find((t) => t.status === "fail");
    assert.equal(f.name, "TestSub");
    assert.equal(f.failure.message, "got 2 want 1");
    assert.equal(f.failure.location, "calc_test.go:12");
    assert.equal(f.durationMs, 0);
  });
  it("marks a build failure as errored", () => {
    const bad = parsers.parseGoTest("# p\n./x.go:3: undefined: foo\nFAIL\tp [build failed]");
    assert.equal(bad.ok, false);
  });
});

describe("testintel/parsers — dispatch", () => {
  it("routes by runner id", () => {
    assert.equal(parsers.parse("node:test", TAP).runner, "node:test");
    assert.equal(parsers.parse("go test", "{\"Action\":\"pass\",\"Package\":\"p\",\"Test\":\"T\",\"Elapsed\":0}").runner, "go test");
  });
});
