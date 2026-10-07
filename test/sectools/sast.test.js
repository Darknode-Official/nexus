"use strict";
// Tests for sectools/sast — SAST-lite engine + ruleset.
// Run: node --test test/sectools/

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sast = require("../../src/sectools/sast");
const { RULES } = require("../../src/sectools/sast-rules");

describe("sast · language detection", () => {
  it("maps extensions to languages", () => {
    assert.equal(sast.languageOf("a.js"), "js");
    assert.equal(sast.languageOf("a.ts"), "js");
    assert.equal(sast.languageOf("a.py"), "py");
    assert.equal(sast.languageOf("a.sh"), "sh");
    assert.equal(sast.languageOf("a.txt"), null);
    assert.equal(sast.languageOf("noext"), null);
  });
});

describe("sast · ruleset integrity", () => {
  it("every rule has the required fields and a unique id", () => {
    const ids = new Set();
    for (const r of RULES) {
      assert.ok(r.id && !ids.has(r.id), "duplicate/missing id: " + r.id);
      ids.add(r.id);
      assert.ok(Array.isArray(r.langs) && r.langs.length, r.id + " langs");
      assert.ok(["critical", "high", "medium", "low"].includes(r.severity), r.id + " severity");
      assert.match(r.cwe, /^CWE-\d+$/, r.id + " cwe");
      assert.ok(r.title && r.message && r.remediation, r.id + " text fields");
      assert.ok(r.pattern instanceof RegExp, r.id + " pattern");
    }
  });
});

describe("sast · comment stripping", () => {
  it("removes JS line comments but preserves URLs", () => {
    assert.equal(sast.stripComment('const x = 1; // eval(x)', "js"), "const x = 1; ");
    assert.equal(sast.stripComment('const u = "http://x.com";', "js"), 'const u = "http://x.com";');
  });
  it("removes python/shell # comments", () => {
    assert.equal(sast.stripComment("x = 1  # os.system(x)", "py"), "x = 1  ");
  });
});

describe("sast · positive detections (JS)", () => {
  const cases = [
    ["js-child-process-exec", "cp.exec(`ls ${dir}`);"],
    ["js-sql-string-concat", 'db.query(`SELECT * FROM u WHERE id=${id}`);'],
    ["js-eval", "eval(userInput);"],
    ["js-function-constructor", "const f = new Function('return 1');"],
    ["js-weak-hash", 'crypto.createHash("md5");'],
    ["js-weak-cipher", 'crypto.createCipheriv("des", k, iv);'],
    ["js-tls-reject-unauthorized", "const a = { rejectUnauthorized: false };"],
    ["js-chmod-777", 'fs.chmodSync(p, 0o777);'],
    ["js-path-traversal", "fs.readFileSync('base/' + req.query.f);"],
  ];
  for (const [id, line] of cases) {
    it(`detects ${id}`, () => {
      const f = sast.scanText(line, { file: "x.js" });
      assert.ok(f.some((x) => x.id === id), `${id} missing in ${JSON.stringify(f.map(x => x.id))}`);
    });
  }
});

describe("sast · positive detections (Python)", () => {
  const cases = [
    ["py-os-system", 'os.system("rm " + name)'],
    ["py-subprocess-shell-true", "subprocess.run(cmd, shell=True)"],
    ["py-sql-format", 'cur.execute(f"SELECT * FROM t WHERE id={i}")'],
    ["py-eval-exec", "eval(data)"],
    ["py-pickle-loads", "pickle.loads(blob)"],
    ["py-yaml-load", "yaml.load(stream)"],
    ["py-weak-hash", "hashlib.md5(x)"],
    ["py-verify-false", "requests.get(u, verify=False)"],
    ["py-chmod-777", "os.chmod(p, 0o777)"],
  ];
  for (const [id, line] of cases) {
    it(`detects ${id}`, () => {
      const f = sast.scanText(line, { file: "x.py" });
      assert.ok(f.some((x) => x.id === id), `${id} missing in ${JSON.stringify(f.map(x => x.id))}`);
    });
  }
});

describe("sast · positive detections (shell)", () => {
  const cases = [
    ["sh-eval-untrusted", 'eval "$user_cmd"'],
    ["sh-chmod-777", "chmod -R 777 /srv/app"],
    ["sh-curl-insecure", "curl -k https://example.com/install.sh"],
  ];
  for (const [id, line] of cases) {
    it(`detects ${id}`, () => {
      const f = sast.scanText(line, { file: "x.sh" });
      assert.ok(f.some((x) => x.id === id), `${id} missing in ${JSON.stringify(f.map(x => x.id))}`);
    });
  }
});

describe("sast · negatives (no false positives)", () => {
  it("does not flag safe JS", () => {
    const safe = [
      'execFile("git", ["log"], cb);',
      'crypto.createHash("sha256");',
      "// eval(x) in a comment",
      "const r = Math.random(); // animation jitter",
      "const pw = process.env.PASSWORD;",
      "db.query('SELECT * FROM u WHERE id = $1', [id]);",
    ].join("\n");
    const f = sast.scanText(safe, { file: "safe.js" });
    assert.equal(f.length, 0, "unexpected: " + JSON.stringify(f.map(x => x.id + "@" + x.line)));
  });

  it("does not flag safe Python", () => {
    const safe = [
      "token = secrets.token_hex(16)",
      "yaml.safe_load(data)",
      "x = ast.literal_eval(s)",
      'subprocess.run(["ls", "-l"], shell=False)',
      '"""eval(bad) inside a docstring"""',
      "hashlib.sha256(x)",
    ].join("\n");
    const f = sast.scanText(safe, { file: "safe.py" });
    assert.equal(f.length, 0, "unexpected: " + JSON.stringify(f.map(x => x.id + "@" + x.line)));
  });

  it("returns nothing for unsupported languages", () => {
    assert.equal(sast.scanText("SELECT * FROM t", { file: "a.sql" }).length, 0);
  });
});

describe("sast · rule override", () => {
  it("accepts a custom ruleset", () => {
    const custom = [{
      id: "no-foo", langs: ["js"], severity: "low", cwe: "CWE-000",
      title: "foo", message: "no foo", pattern: /\bfoo\b/, remediation: "rename",
    }];
    const f = sast.scanText("const foo = 1;", { file: "x.js", rules: custom });
    assert.equal(f.length, 1);
    assert.equal(f[0].id, "no-foo");
  });
});
