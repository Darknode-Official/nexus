"use strict";
// Tests for sectools/secrets — secret scanner + entropy + redaction.
// Run: node --test test/sectools/
// Covers POSITIVE detections and NEGATIVE (no-false-positive) fixtures.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const secrets = require("../../src/sectools/secrets");

describe("secrets · entropy", () => {
  it("computes higher entropy for random strings than repetitive ones", () => {
    const low = secrets.shannonEntropy("aaaaaaaaaaaa");
    const high = secrets.shannonEntropy("aZ3$kP9!qW2@");
    assert.ok(high > low);
    assert.ok(low < 0.5);
  });

  it("returns 0 for empty input", () => {
    assert.equal(secrets.shannonEntropy(""), 0);
  });

  it("flags a high-entropy base64 token and rejects low-entropy / placeholder", () => {
    assert.equal(secrets.hasHighEntropy("c3VwZXJzZWNyZXRrZXlfbG9uZw9921"), true);
    assert.equal(secrets.hasHighEntropy("changeme"), false);
    assert.equal(secrets.hasHighEntropy("aaaaaaaaaaaaaaaaaaaa"), false);
  });
});

describe("secrets · placeholder filtering", () => {
  it("treats templates and placeholders as non-secrets", () => {
    assert.equal(secrets.isPlaceholder("${MY_TOKEN}"), true);
    assert.equal(secrets.isPlaceholder("<your-token>"), true);
    assert.equal(secrets.isPlaceholder("process.env.API_KEY"), true);
    assert.equal(secrets.isPlaceholder("changeme"), true);
    assert.equal(secrets.isPlaceholder("xxxxxxxx"), true);
    assert.equal(secrets.isPlaceholder("a real sentence with spaces"), true);
  });

  it("does not treat a genuine token as a placeholder", () => {
    assert.equal(secrets.isPlaceholder("AKIAIOSFODNN7EXAMPLE".replace("EXAMPLE", "QF2JKLMN")), false);
  });
});

describe("secrets · provider rules (positive)", () => {
  const cases = [
    ["aws-access-key-id", 'id = "AKIAIOSFODNN7QF2JKLM"'],
    ["github-token", 'tok = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"'],
    ["google-api-key", 'k = "AIzaSyA1234567890abcdefghijklmnopqrstuv"'],
    ["slack-token", 'k = "xoxb-123456789012-' + 'abcdefghijklmNOPQRSTUVWX"'],
    ["stripe-secret-key", 'k = "sk_' + 'live_51H8xAbCdEfGhIjKlMnOpQrStUv"'],
    ["private-key-block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["db-connection-string", 'url = "postgres://user:p4ssw0rdLong@db.example.com:5432/app"'],
    ["npm-token", 'tok = "npm_abcdefghijklmnopqrstuvwxyz0123456789"'],
  ];
  for (const [id, line] of cases) {
    it(`detects ${id}`, () => {
      const f = secrets.scanText(line, { file: "f.js" });
      assert.ok(f.some((x) => x.id === id), `${id} not found in: ${JSON.stringify(f.map(x => x.id))}`);
    });
  }

  it("masks the secret value in the finding (never leaks it)", () => {
    const f = secrets.scanText('id = "AKIAIOSFODNN7QF2JKLM"', { file: "f.js" });
    const hit = f.find((x) => x.id === "aws-access-key-id");
    assert.ok(hit.match.includes("*"));
    assert.ok(!hit.match.includes("AKIAIOSFODNN7QF2JKLM"));
    assert.ok(!hit.snippet.includes("AKIAIOSFODNN7QF2JKLM"));
  });

  it("records location, severity and CWE", () => {
    const f = secrets.scanText('\n\nk = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"', { file: "f.js" });
    const hit = f.find((x) => x.id === "github-token");
    assert.equal(hit.line, 3);
    assert.ok(hit.column > 0);
    assert.equal(hit.severity, "critical");
    assert.match(hit.cwe, /^CWE-/);
  });
});

describe("secrets · negatives (no false positives)", () => {
  const safe = [
    'const url = "http://localhost:3000/api/v1/users";',
    'const id = "123e4567-e89b-12d3-a456-426614174000";',
    "const token = process.env.TOKEN;",
    'password = "changeme";',
    'apiKey = "${env.API_KEY}";',
    'const note = "insert your api key here";',
    "const sum = a + b + c + d + e + f + g + h;",
  ].join("\n");

  it("finds nothing in safe code", () => {
    const f = secrets.scanText(safe, { file: "safe.js" });
    assert.equal(f.length, 0, "unexpected: " + JSON.stringify(f.map(x => x.id + "@" + x.line)));
  });

  it("does not flag an env-var reference as a hardcoded secret", () => {
    const f = secrets.scanText('const apiKey = process.env.API_KEY || "";', { file: "f.js" });
    assert.equal(f.length, 0);
  });
});

describe("secrets · redaction", () => {
  it("masks secrets but keeps surrounding text", () => {
    const text = 'Authorization: ghp_1234567890abcdefghijklmnopqrstuvwxyz\nok';
    const { text: out, redactions } = secrets.redact(text);
    assert.ok(redactions >= 1);
    assert.ok(!out.includes("ghp_1234567890abcdefghijklmnopqrstuvwxyz"));
    assert.ok(out.includes("Authorization:"));
    assert.ok(out.includes("ok"));
  });

  it("is a no-op on text with no secrets", () => {
    const { text, redactions } = secrets.redact("just some normal text here");
    assert.equal(redactions, 0);
    assert.equal(text, "just some normal text here");
  });

  it("redacts database connection credentials", () => {
    const { text, redactions } = secrets.redact('DSN = "postgres://admin:S3cretP4ssLong@host/db"');
    assert.ok(redactions >= 1);
    assert.ok(!text.includes("S3cretP4ssLong"));
  });
});

describe("secrets · high-entropy context gating", () => {
  it("flags a high-entropy value only in a secret-like context", () => {
    const withCtx = secrets.scanText('const apiSecret = "Zx9Kp2Lm7Qr4Ts8Vw1Nc6Yb3Jd5Hf0"', { file: "f.js" });
    assert.ok(withCtx.length >= 1);
    const noCtx = secrets.scanText('const colorMap = "Zx9Kp2Lm7Qr4Ts8Vw1Nc6Yb3Jd5Hf0"', { file: "f.js" });
    // no secret-ish keyword nearby -> entropy scan stays quiet
    assert.equal(noCtx.filter((x) => x.id === "high-entropy-string").length, 0);
  });
});
