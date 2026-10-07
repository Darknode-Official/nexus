"use strict";
// Tests for move-symbol: declaration relocation, export/import fixup on both sides,
// importer rewriting (including splitting a multi-name import), and dependency
// warnings.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { session } = require("./fixture");

describe("move — ESM", () => {
  it("moves a function and repoints its importers", () => {
    const s = session({
      "a.js": "export function helper(x){ return x + 1; }\nexport function other(){ return helper(2); }\n",
      "b.js": "",
      "c.js": "import { helper } from './a';\nexport const v = helper(3);\n",
    });
    const p = s.move({ fromFile: "a.js", name: "helper", toFile: "b.js" });
    assert.ok(p.ok, JSON.stringify(p.safety));
    assert.match(p.edits.get("b.js"), /export function helper/);
    assert.doesNotMatch(p.edits.get("a.js"), /export function helper/);
    assert.match(p.edits.get("a.js"), /import \{ helper \} from '\.\/b'/); // still used by other()
    assert.match(p.edits.get("c.js"), /import \{ helper \} from '\.\/b'/);
  });

  it("splits a multi-name import, keeping the non-moved name on the old path", () => {
    const s = session({
      "a.js": "export function helper(x){ return x + 1; }\nexport const K = 9;\n",
      "b.js": "export const q = 1;\n",
      "c.js": "import { helper, K } from './a';\nexport const v = helper(K);\n",
    });
    const p = s.move({ fromFile: "a.js", name: "helper", toFile: "b.js" });
    assert.ok(p.ok);
    const c = p.edits.get("c.js");
    assert.match(c, /import \{ K \} from '\.\/a'/);
    assert.match(c, /import \{ helper \} from '\.\/b'/);
  });
});

describe("move — CommonJS destination", () => {
  it("renders the moved declaration for a CJS destination", () => {
    const s = session({
      "a.js": "export function util(){ return 1; }\n",
      "b.js": "const x = require('path');\nmodule.exports = { x };\n",
    });
    const p = s.move({ fromFile: "a.js", name: "util", toFile: "b.js" });
    assert.ok(p.ok);
    const b = p.edits.get("b.js");
    assert.match(b, /function util\(\)\{ return 1; \}/);
    assert.match(b, /module\.exports\.util = util;/);
    assert.doesNotMatch(b, /export function util/);
  });
});

describe("move — dependencies & safety", () => {
  it("warns when the moved decl uses a non-exported symbol of the source", () => {
    const s = session({
      "a.js": "function secret(){ return 42; }\nexport function pub(){ return secret(); }\n",
      "b.js": "",
    });
    const p = s.move({ fromFile: "a.js", name: "pub", toFile: "b.js" });
    assert.ok(p.ok);
    assert.ok(p.safety.warnings.some((w) => /secret/.test(w)), "should warn about secret");
    assert.match(p.edits.get("b.js"), /import \{ secret \} from '\.\/a'/);
  });

  it("refuses moving to the same file", () => {
    const s = session({ "a.js": "export const x = 1;\n" });
    const p = s.move({ fromFile: "a.js", name: "x", toFile: "a.js" });
    assert.equal(p.ok, false);
  });

  it("refuses an unknown symbol", () => {
    const s = session({ "a.js": "export const x = 1;\n", "b.js": "" });
    const p = s.move({ fromFile: "a.js", name: "nope", toFile: "b.js" });
    assert.equal(p.ok, false);
  });
});
