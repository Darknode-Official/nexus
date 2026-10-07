"use strict";
// ===================== Test Intelligence — Assertion / Test-Skeleton Suggester =====================
// For a function that has no test, generate a ready-to-fill test skeleton in the
// project's detected framework (node:test, jest, mocha, pytest). HONEST by design:
// these are arrange/act/assert *stubs* with TODO placeholders and edge-case prompts
// derived from the signature — not magically-correct tests. The value is removing the
// boilerplate friction so the agent (or a human) fills in real expectations.
//
//   untestedFunctions(index, opts) -> [{ name, file, params, exported, kind }]
//        uses src/codegraph: a defined function is "untested" if no test file in the
//        index references it (via codegraph's symbol impact / reverse graph).
//   suggestSkeleton(fn, opts)       -> { framework, filename, code }
//   suggestForFile(index, file, o)  -> skeletons for every untested function in a file
const path = require("path");
const fs = require("fs");
const discovery = require("./discovery");

function norm(p) { return String(p || "").replace(/\\/g, "/").replace(/^\.\//, ""); }

// --- find untested functions via codegraph ---------------------------------------
// A function symbol is considered tested if any TEST file is a direct symbol user of it
// (codegraph.symbolImpact.directSymbolUsers) OR if a test file imports the module that
// defines it (weaker signal; controlled by opts.strict).
function untestedFunctions(index, opts) {
  opts = opts || {};
  const strict = opts.strict !== false; // strict: require direct symbol usage by a test
  const testFiles = new Set();
  for (const f of index.files) if (discovery.isTestFile(norm(f.file))) testFiles.add(norm(f.file));
  const srcCache = new Map();
  const out = [];
  for (const f of index.files) {
    const file = norm(f.file);
    if (testFiles.has(file)) continue; // don't suggest tests for test files
    if (opts.file && file !== norm(opts.file)) continue;
    for (const s of (f.symbols || [])) {
      if (s.kind !== "function" && s.kind !== "method") continue;
      if (s.parent && !opts.includeMethods) continue; // top-level funcs by default
      if (opts.onlyExported && !s.exported) continue;
      let tested = false;
      try {
        const imp = index.impact({ file, name: s.name });
        const users = new Set([...(imp.directSymbolUsers || [])]);
        if (!strict) for (const m of (imp.transitiveModules || [])) users.add(m.file);
        for (const u of users) if (testFiles.has(norm(u))) { tested = true; break; }
      } catch (_) { /* no impact info -> treat as untested */ }
      if (!tested) out.push({ name: s.name, file, params: resolveParams(s, f, srcCache), exported: !!s.exported, kind: s.kind, lang: f.lang, async: !!s.async });
    }
  }
  return out;
}

// resolveParams — prefer the symbol's recorded signature; if empty (codegraph records
// signatures only for methods), fall back to reading the source and extracting the
// parameter list at the definition. Returns [] when the source isn't available.
function resolveParams(symbol, fileRec, srcCache) {
  const fromSig = parseParams(symbol);
  if (fromSig.length) return fromSig;
  const src = loadSource(fileRec, srcCache);
  if (!src) return [];
  return extractParamsFromSource(src, symbol);
}

function loadSource(fileRec, srcCache) {
  const key = fileRec.abs || fileRec.file;
  if (srcCache.has(key)) return srcCache.get(key);
  let src = null;
  if (fileRec.source != null) src = String(fileRec.source);
  else if (fileRec.abs) { try { src = fs.readFileSync(fileRec.abs, "utf8"); } catch (_) { src = null; } }
  srcCache.set(key, src);
  return src;
}

// extractParamsFromSource — find the function/def header near symbol.line and read its
// parenthesized parameter list. Handles JS function/arrow/method and Python def.
function extractParamsFromSource(src, symbol) {
  const lines = src.split(/\r?\n/);
  const ln = (symbol.line || 1) - 1;
  const window = lines.slice(Math.max(0, ln), Math.min(lines.length, ln + 3)).join("\n");
  const name = escapeRe(symbol.name);
  const patterns = [
    new RegExp("(?:function\\s*\\*?\\s*)?" + name + "\\s*\\(([^)]*)\\)"),
    new RegExp(name + "\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>"),
    new RegExp(name + "\\s*:\\s*(?:async\\s*)?\\(([^)]*)\\)"),
    new RegExp("def\\s+" + name + "\\s*\\(([^)]*)\\)"),
  ];
  for (const re of patterns) {
    const m = window.match(re);
    if (m) return splitParams(m[1]);
  }
  return [];
}

function splitParams(raw) {
  return String(raw || "").split(",")
    .map((p) => p.trim().split(/[:=\s]/)[0].replace(/[{}[\]().*]/g, "").replace(/^self$|^cls$/, "").trim())
    .filter(Boolean);
}

// parseParams(symbol) -> [names] best-effort from the recorded signature, else [].
function parseParams(symbol) {
  const sig = symbol.signature || "";
  const m = sig.match(/\(([^)]*)\)/);
  if (!m) return [];
  return splitParams(m[1]);
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// --- framework-specific skeleton generators --------------------------------------
function suggestSkeleton(fn, opts) {
  opts = opts || {};
  const framework = opts.framework || defaultFramework(fn.lang);
  const gen = GENERATORS[framework] || GENERATORS["node:test"];
  return { framework, lang: fn.lang || langForFramework(framework), code: gen(fn, opts) };
}

function defaultFramework(lang) {
  if (lang === "python") return "pytest";
  if (lang === "go") return "go test";
  return "node:test";
}
function langForFramework(fw) { return fw === "pytest" ? "python" : fw === "go test" ? "go" : "javascript"; }

function importPath(fromTestFile, srcFile) {
  // relative import from a sibling test file; keep it simple & correct for the common case.
  let rel = path.posix.relative(path.posix.dirname(fromTestFile || "."), srcFile);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, "");
}

const GENERATORS = {
  "node:test": (fn, o) => {
    const call = fn.name + "(" + fn.params.join(", ") + ")";
    const aw = fn.async ? "await " : "";
    const imp = importPath(o.testFile || deriveTestFile(fn, "node:test"), fn.file);
    const edge = edgeCases(fn).map((e) => `  // edge case: ${e}`).join("\n");
    return `"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ${fn.name} } = require("${imp}");

test("${fn.name} — happy path", ${fn.async ? "async " : ""}() => {
  // Arrange
  ${arrangeLines(fn).join("\n  ")}
  // Act
  const actual = ${aw}${call};
  // Assert
  assert.equal(actual, /* TODO: expected */ undefined);
});
${edge ? "\n" + edge + "\n" : ""}// test("${fn.name} — edge cases", () => { /* TODO */ });
`;
  },
  jest: (fn, o) => {
    const call = fn.name + "(" + fn.params.join(", ") + ")";
    const aw = fn.async ? "await " : "";
    const imp = importPath(o.testFile || deriveTestFile(fn, "jest"), fn.file);
    return `const { ${fn.name} } = require("${imp}");

describe("${fn.name}", () => {
  test("happy path", ${fn.async ? "async " : ""}() => {
    // Arrange
    ${arrangeLines(fn).join("\n    ")}
    // Act
    const actual = ${aw}${call};
    // Assert
    expect(actual).toBe(/* TODO: expected */ undefined);
  });
${edgeCases(fn).map((e) => `  // test("${esc(e)}", () => { /* TODO */ });`).join("\n")}
});
`;
  },
  mocha: (fn, o) => {
    const call = fn.name + "(" + fn.params.join(", ") + ")";
    const aw = fn.async ? "await " : "";
    const imp = importPath(o.testFile || deriveTestFile(fn, "mocha"), fn.file);
    return `const assert = require("assert");
const { ${fn.name} } = require("${imp}");

describe("${fn.name}", function () {
  it("happy path", ${fn.async ? "async " : ""}function () {
    // Arrange
    ${arrangeLines(fn).join("\n    ")}
    // Act
    const actual = ${aw}${call};
    // Assert
    assert.strictEqual(actual, /* TODO: expected */ undefined);
  });
${edgeCases(fn).map((e) => `  // it("${esc(e)}", function () { /* TODO */ });`).join("\n")}
});
`;
  },
  pytest: (fn, o) => {
    const mod = path.posix.basename(fn.file).replace(/\.py$/, "");
    const call = fn.name + "(" + fn.params.join(", ") + ")";
    const arrange = fn.params.length ? fn.params.map((p) => `    ${p} = None  # TODO: arrange`).join("\n") : "    pass  # TODO: arrange";
    return `import ${mod}


def test_${fn.name}_happy_path():
    # Arrange
${arrange}
    # Act
    actual = ${mod}.${call.replace(/^\s+/, "")}
    # Assert
    assert actual == None  # TODO: expected

${edgeCases(fn).map((e) => `# def test_${fn.name}_${slug(e)}():\n#     ...  # TODO: ${e}`).join("\n")}
`;
  },
  "go test": (fn, o) => {
    const Tn = fn.name.charAt(0).toUpperCase() + fn.name.slice(1);
    return `package ${o.pkg || "main"}

import "testing"

func Test${Tn}(t *testing.T) {
	// Arrange
	// TODO: declare inputs: ${fn.params.join(", ") || "(none)"}
	// Act
	got := ${fn.name}(${fn.params.join(", ")})
	// Assert
	want := /* TODO */ got
	if got != want {
		t.Errorf("${fn.name}() = %v, want %v", got, want)
	}
}
`;
  },
};

// arrangeLines(fn) -> arrange placeholders, one per parameter.
function arrangeLines(fn) {
  if (!fn.params.length) return ["// (no arguments)"];
  return fn.params.map((p) => `const ${p} = /* TODO: arrange */ undefined;`);
}

// edgeCases(fn) -> prompts derived from parameter names/count (heuristic, honest).
function edgeCases(fn) {
  const cases = [];
  for (const p of fn.params) {
    const n = p.toLowerCase();
    if (/arr|list|items|elements|rows|xs/.test(n)) cases.push(`${p}: empty array, single element, many`);
    else if (/str|name|text|path|url|msg/.test(n)) cases.push(`${p}: empty string, whitespace, unicode`);
    else if (/num|count|n|idx|index|len|size|amount/.test(n)) cases.push(`${p}: 0, negative, max`);
    else if (/opt|options|config|cfg/.test(n)) cases.push(`${p}: missing / partial options`);
    else cases.push(`${p}: null / undefined handling`);
  }
  if (fn.async) cases.push("rejects / throws path");
  if (!cases.length) cases.push("boundary and error conditions");
  return cases;
}

function deriveTestFile(fn, framework) {
  const dir = path.posix.dirname(fn.file);
  const base = path.posix.basename(fn.file).replace(/\.[^.]+$/, "");
  if (framework === "pytest") return path.posix.join(dir, "test_" + base + ".py");
  return path.posix.join(dir, base + ".test.js");
}

// suggestForFile(index, file, opts) -> [{fn, skeleton}] for untested functions in file.
function suggestForFile(index, file, opts) {
  opts = opts || {};
  const fns = untestedFunctions(index, Object.assign({}, opts, { file }));
  return fns.map((fn) => ({ fn, skeleton: suggestSkeleton(fn, opts) }));
}

function esc(s) { return String(s).replace(/"/g, '\\"'); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40); }

module.exports = { untestedFunctions, suggestSkeleton, suggestForFile, parseParams, edgeCases, GENERATORS };
