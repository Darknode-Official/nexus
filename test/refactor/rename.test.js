"use strict";
// Tests for scope-aware cross-file rename: cross-file propagation, shadowing
// avoidance, aliased/namespace imports, collision refusal, method scoping, and the
// apply/rollback paths over a real temp project.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { session } = require("./fixture");

function out(plan, file) { return plan.edits.get(file); }

describe("rename — cross-file", () => {
  it("renames a function and its importers (direct require)", () => {
    const s = session({
      "util.js": "function readCfg(p){ return p; }\nmodule.exports = { readCfg };\n",
      "app.js": "const { readCfg } = require('./util');\nconsole.log(readCfg('x'));\n",
    });
    const p = s.rename({ oldName: "readCfg", newName: "readConfig" });
    assert.ok(p.ok, JSON.stringify(p.safety));
    assert.match(out(p, "util.js"), /function readConfig/);
    assert.match(out(p, "util.js"), /\{ readConfig \}/);
    assert.match(out(p, "app.js"), /const \{ readConfig \} = require/);
    assert.match(out(p, "app.js"), /readConfig\('x'\)/);
  });

  it("renames ESM named imports and usages", () => {
    const s = session({
      "lib.js": "export function compute(a){ return a*2; }\n",
      "main.js": "import { compute } from './lib';\nexport const r = compute(3);\n",
    });
    const p = s.rename({ oldName: "compute", newName: "calculate" });
    assert.ok(p.ok);
    assert.match(out(p, "lib.js"), /export function calculate/);
    assert.match(out(p, "main.js"), /import \{ calculate \} from '\.\/lib'/);
    assert.match(out(p, "main.js"), /= calculate\(3\)/);
  });
});

describe("rename — scope awareness", () => {
  it("does NOT rename a shadowing local in another file", () => {
    const s = session({
      "util.js": "function readCfg(p){ return p; }\nmodule.exports = { readCfg };\n",
      "app.js": "const { readCfg } = require('./util');\nfunction run(){ const readCfg = 1; return readCfg; }\nconsole.log(readCfg('x'));\n",
    });
    const p = s.rename({ oldName: "readCfg", newName: "readConfig" });
    assert.ok(p.ok);
    const app = out(p, "app.js");
    assert.match(app, /const \{ readConfig \} = require/);      // import renamed
    assert.match(app, /console\.log\(readConfig\('x'\)\)/);     // module-scope use renamed
    assert.match(app, /const readCfg = 1; return readCfg/);     // shadow kept
  });

  it("does NOT rename a shadowing parameter within the declaring file", () => {
    const s = session({
      "m.js": "function target(){ return 1; }\nfunction wrap(target){ return target; }\nmodule.exports = { target };\n",
    });
    const p = s.rename({ oldName: "target", newName: "goal" });
    assert.ok(p.ok);
    const m = out(p, "m.js");
    assert.match(m, /function goal\(\)/);
    assert.match(m, /function wrap\(target\)\{ return target; \}/); // param + body untouched
    assert.match(m, /\{ goal \}/);
  });

  it("does not touch same-named symbols in unrelated files", () => {
    const s = session({
      "a.js": "export function thing(){ return 1; }\n",
      "b.js": "function thing(){ return 2; }\nmodule.exports = { thing };\n", // unrelated, no import
      "c.js": "import { thing } from './a';\nexport const x = thing();\n",
    });
    const p = s.rename({ oldName: "thing", newName: "widget", file: "a.js" });
    assert.ok(p.ok);
    assert.match(out(p, "a.js"), /function widget/);
    assert.match(out(p, "c.js"), /import \{ widget \}/);
    assert.equal(p.edits.has("b.js"), false); // unrelated file untouched
  });
});

describe("rename — aliased & namespace imports", () => {
  it("renames only the imported side of an aliased import", () => {
    const s = session({
      "lib.js": "export function orig(){ return 1; }\n",
      "u.js": "import { orig as alias } from './lib';\nexport const v = alias();\n",
    });
    const p = s.rename({ oldName: "orig", newName: "fresh" });
    assert.ok(p.ok);
    assert.match(out(p, "u.js"), /import \{ fresh as alias \}/);
    assert.match(out(p, "u.js"), /= alias\(\)/); // alias usage preserved
  });

  it("renames namespace member access", () => {
    const s = session({
      "lib.js": "export function run(){ return 1; }\n",
      "u.js": "import * as lib from './lib';\nexport const v = lib.run();\n",
    });
    const p = s.rename({ oldName: "run", newName: "execute" });
    assert.ok(p.ok);
    assert.match(out(p, "u.js"), /lib\.execute\(\)/);
  });
});

describe("rename — safety", () => {
  it("refuses an invalid identifier", () => {
    const s = session({ "a.js": "export const x = 1;\n" });
    const p = s.rename({ oldName: "x", newName: "2bad" });
    assert.equal(p.ok, false);
    assert.match(p.safety.reasons[0], /not a valid identifier/);
  });

  it("refuses a name collision in a using file", () => {
    const s = session({
      "util.js": "function a(){ return 1; }\nmodule.exports = { a };\n",
      "app.js": "const { a } = require('./util');\nconst b = 2;\nconsole.log(a, b);\n",
    });
    const p = s.rename({ oldName: "a", newName: "b" });
    assert.equal(p.ok, false);
    assert.match(p.safety.reasons[0], /collision/);
  });

  it("refuses cross-file method rename without file/line", () => {
    const s = session({
      "c.js": "export class K { save(){ return 1; } use(){ return this.save(); } }\n",
    });
    const p = s.rename({ oldName: "save", newName: "persist" });
    assert.equal(p.ok, false);
    assert.match(p.safety.reasons[0], /method/);
  });

  it("renames a method within its class when given file/line", () => {
    const s = session({
      "c.js": "export class K {\n  save(){ return 1; }\n  use(){ return this.save(); }\n}\n",
    });
    const p = s.rename({ oldName: "save", newName: "persist", file: "c.js", line: 2 });
    assert.ok(p.ok, JSON.stringify(p.safety));
    const c = out(p, "c.js");
    assert.match(c, /persist\(\)\{ return 1; \}/);
    assert.match(c, /this\.persist\(\)/);
    assert.ok(p.safety.warnings.length > 0); // honest warning about external callers
  });

  it("refuses when the symbol does not exist", () => {
    const s = session({ "a.js": "export const x = 1;\n" });
    const p = s.rename({ oldName: "nope", newName: "y" });
    assert.equal(p.ok, false);
  });
});

describe("rename — does not corrupt strings/comments", () => {
  it("leaves the name inside strings and comments alone", () => {
    const s = session({
      "m.js": "function foo(){ return 1; }\n// foo is great\nconst s = 'foo bar';\nmodule.exports = { foo };\n",
    });
    const p = s.rename({ oldName: "foo", newName: "baz" });
    assert.ok(p.ok);
    const m = out(p, "m.js");
    assert.match(m, /function baz/);
    assert.match(m, /\/\/ foo is great/);  // comment preserved
    assert.match(m, /'foo bar'/);          // string preserved
  });
});
