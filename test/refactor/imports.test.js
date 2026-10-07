"use strict";
// Tests for organize-imports: remove unused, add missing from the project symbol
// table, and deterministic grouping/sorting.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { session } = require("./fixture");

function out(p) { return [...p.edits.values()][0]; }

describe("organize-imports — remove unused", () => {
  it("drops an unused named import", () => {
    const s = session({ "m.js": "import { used, dead } from './lib';\nexport const x = used();\n" });
    const p = s.organizeImports({ file: "m.js", opts: { addMissing: false } });
    assert.ok(p.ok, JSON.stringify(p.safety));
    const t = out(p);
    assert.match(t, /import \{ used \} from '\.\/lib'/);
    assert.doesNotMatch(t, /dead/);
  });

  it("removes a fully-unused import statement", () => {
    const s = session({ "m.js": "import { a } from './x';\nimport { b } from './y';\nexport const r = b;\n" });
    const p = s.organizeImports({ file: "m.js", opts: { addMissing: false } });
    assert.ok(p.ok);
    const t = out(p);
    assert.doesNotMatch(t, /from '\.\/x'/);
    assert.match(t, /from '\.\/y'/);
  });

  it("keeps side-effect imports while removing a dead one", () => {
    const s = session({ "m.js": "import './styles.css';\nimport { a } from './x';\nimport { dead } from './z';\nexport const r = a;\n" });
    const p = s.organizeImports({ file: "m.js", opts: { addMissing: false } });
    assert.ok(p.ok, JSON.stringify(p.safety));
    const t = out(p);
    assert.match(t, /import '\.\/styles\.css'/); // side-effect kept
    assert.doesNotMatch(t, /from '\.\/z'/);       // dead import removed
  });
});

describe("organize-imports — add missing", () => {
  it("adds an import for a symbol used but not imported", () => {
    const s = session({
      "m.js": "export const r = helper(2);\n",
      "helpers.js": "export function helper(n){ return n; }\n",
    });
    const p = s.organizeImports({ file: "m.js" });
    assert.ok(p.ok, JSON.stringify(p.safety));
    assert.match(out(p), /import \{ helper \} from '\.\/helpers'/);
  });

  it("does not add an ambiguous symbol exported by two files", () => {
    const s = session({
      "m.js": "export const r = thing();\n",
      "a.js": "export function thing(){ return 1; }\n",
      "b.js": "export function thing(){ return 2; }\n",
    });
    const p = s.organizeImports({ file: "m.js" });
    // nothing unambiguous to add and no imports to sort -> refuses with a reason
    if (p.ok) assert.doesNotMatch(out(p), /import \{ thing \}/);
    else assert.ok(p.safety.reasons.length);
  });
});

describe("organize-imports — sort & group", () => {
  it("groups node builtins, externals and relatives, each sorted", () => {
    const s = session({
      "m.js": "import { z } from './zeta';\nimport react from 'react';\nimport fs from 'fs';\nimport { a } from './alpha';\nexport const r = [z, react, fs, a];\n",
    });
    const p = s.organizeImports({ file: "m.js", opts: { addMissing: false } });
    assert.ok(p.ok);
    const t = out(p);
    const iFs = t.indexOf("'fs'");
    const iReact = t.indexOf("'react'");
    const iAlpha = t.indexOf("'./alpha'");
    const iZeta = t.indexOf("'./zeta'");
    assert.ok(iFs < iReact, "builtin before external");
    assert.ok(iReact < iAlpha, "external before relative");
    assert.ok(iAlpha < iZeta, "relatives sorted");
  });
});
