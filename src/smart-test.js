// Smart Test Generator — analyzes code and generates comprehensive tests:
// happy path, edge cases, error conditions, boundary values. Understands
// the code structure rather than generating templates.
const fs = require("fs");
const path = require("path");

function parseFunction(content, name) {
  // Find the function in the content
  const patterns = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`, "m"),
    new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:async\\s+)?\\(([^)]*)\\)\\s*=>`, "m"),
    new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:async\\s+)?function\\s*\\(([^)]*)\\)`, "m"),
    new RegExp(`def\\s+${name}\\s*\\(([^)]*)\\)`, "m"),
  ];

  for (const pat of patterns) {
    const m = content.match(pat);
    if (m) {
      const params = m[1].split(",").map(p => p.trim().split(/\s*[:=]\s*/)[0].replace(/[{}[\]]/g, "").trim()).filter(Boolean);
      // Extract function body (rough — find matching braces)
      const startIdx = m.index + m[0].length;
      let depth = 1, i = startIdx;
      if (content[startIdx - 1] === "{") {
        while (i < content.length && depth > 0) {
          if (content[i] === "{") depth++;
          if (content[i] === "}") depth--;
          i++;
        }
      } else {
        // Arrow function — find next function/const/export or end
        i = content.indexOf("\n\n", startIdx);
        if (i < 0) i = content.length;
      }
      const body = content.slice(startIdx, i);
      return { name, params, body, isAsync: /async/.test(m[0]) };
    }
  }
  return null;
}

function analyzeFunction(fn) {
  const analysis = {
    hasReturn: /\breturn\b/.test(fn.body),
    returnsPromise: fn.isAsync || /\.then\(|Promise/.test(fn.body),
    throwsErrors: /\bthrow\b/.test(fn.body),
    hasConditionals: /\bif\b|\bswitch\b|\?\s*:/.test(fn.body),
    hasLoops: /\bfor\b|\bwhile\b|\.forEach|\.map|\.filter|\.reduce/.test(fn.body),
    usesFileSystem: /\bfs\b|readFile|writeFile|existsSync/.test(fn.body),
    usesNetwork: /\bfetch\b|\bhttp\b|\baxios\b|\.get\(|\.post\(/.test(fn.body),
    usesDB: /\bquery\b|\bfind\b|\bsave\b|\binsert\b|\bupdate\b|\bdelete\b/i.test(fn.body),
    handlesNull: /null|undefined|\?\.|!= ?null/.test(fn.body),
    parsesInput: /parseInt|parseFloat|JSON\.parse|Number\(|\.trim\(/.test(fn.body),
    validatesInput: /\.length|typeof|instanceof|isNaN|\.test\(/.test(fn.body),
    paramTypes: fn.params.map(p => {
      if (/num|count|size|length|index|id|port|age|price|amount/i.test(p)) return "number";
      if (/str|name|email|text|msg|path|url|title|label/i.test(p)) return "string";
      if (/arr|list|items|data|entries|records/i.test(p)) return "array";
      if (/obj|config|options|opts|settings|params|ctx/i.test(p)) return "object";
      if (/flag|is[A-Z]|has[A-Z]|should|enable|active/i.test(p)) return "boolean";
      if (/fn|callback|cb|handler|hook/i.test(p)) return "function";
      return "unknown";
    }),
  };
  return analysis;
}

function generateTestCases(fn, analysis) {
  const cases = [];
  const fname = fn.name;
  const params = fn.params;

  // Happy path
  cases.push({
    name: `${fname} — happy path with valid input`,
    type: "happy",
    args: params.map((p, i) => {
      const t = analysis.paramTypes[i];
      if (t === "number") return 42;
      if (t === "string") return `"test-${p}"`;
      if (t === "array") return `["a", "b", "c"]`;
      if (t === "object") return `{ key: "value" }`;
      if (t === "boolean") return true;
      if (t === "function") return `() => {}`;
      return `"test"`;
    }),
    expectation: analysis.hasReturn ? "should return a valid result" : "should complete without error",
  });

  // Null/undefined for each param
  for (let i = 0; i < params.length; i++) {
    cases.push({
      name: `${fname} — null ${params[i]}`,
      type: "edge",
      args: params.map((_, j) => j === i ? null : (analysis.paramTypes[j] === "number" ? 1 : `"x"`)),
      expectation: analysis.throwsErrors ? "should throw an error" : "should handle gracefully",
    });
    cases.push({
      name: `${fname} — undefined ${params[i]}`,
      type: "edge",
      args: params.map((_, j) => j === i ? undefined : (analysis.paramTypes[j] === "number" ? 1 : `"x"`)),
      expectation: "should handle undefined input",
    });
  }

  // Type-specific edge cases
  for (let i = 0; i < params.length; i++) {
    const t = analysis.paramTypes[i];
    if (t === "number") {
      cases.push({ name: `${fname} — zero ${params[i]}`, type: "boundary", args: params.map((_, j) => j === i ? 0 : `"x"`), expectation: "should handle zero" });
      cases.push({ name: `${fname} — negative ${params[i]}`, type: "boundary", args: params.map((_, j) => j === i ? -1 : `"x"`), expectation: "should handle negative numbers" });
      cases.push({ name: `${fname} — very large ${params[i]}`, type: "boundary", args: params.map((_, j) => j === i ? Number.MAX_SAFE_INTEGER : `"x"`), expectation: "should handle large numbers" });
      cases.push({ name: `${fname} — NaN ${params[i]}`, type: "edge", args: params.map((_, j) => j === i ? NaN : `"x"`), expectation: "should handle NaN" });
    }
    if (t === "string") {
      cases.push({ name: `${fname} — empty string ${params[i]}`, type: "boundary", args: params.map((_, j) => j === i ? `""` : 1), expectation: "should handle empty string" });
      cases.push({ name: `${fname} — very long ${params[i]}`, type: "boundary", args: params.map((_, j) => j === i ? `"a".repeat(10000)` : 1), expectation: "should handle long strings" });
      cases.push({ name: `${fname} — special chars ${params[i]}`, type: "edge", args: params.map((_, j) => j === i ? `"<script>alert(1)</script>"` : 1), expectation: "should handle special characters safely" });
    }
    if (t === "array") {
      cases.push({ name: `${fname} — empty array ${params[i]}`, type: "boundary", args: params.map((_, j) => j === i ? "[]" : `"x"`), expectation: "should handle empty array" });
      cases.push({ name: `${fname} — single element ${params[i]}`, type: "boundary", args: params.map((_, j) => j === i ? `["only"]` : `"x"`), expectation: "should handle single-element array" });
    }
  }

  // Error conditions
  if (analysis.throwsErrors) {
    cases.push({
      name: `${fname} — error condition`,
      type: "error",
      args: params.map(() => null),
      expectation: "should throw an appropriate error",
    });
  }

  // Async
  if (analysis.returnsPromise) {
    cases.push({
      name: `${fname} — async rejection`,
      type: "error",
      args: params.map(() => `"invalid"`),
      expectation: "should reject with a meaningful error",
    });
  }

  return cases;
}

function formatTestFile(fn, cases, lang) {
  if (lang === "python") {
    let out = `import pytest\n# from your_module import ${fn.name}\n\n`;
    for (const c of cases) {
      const testName = c.name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
      out += `def test_${testName}():\n`;
      out += `    """${c.expectation}"""\n`;
      const args = c.args.map(a => a === null ? "None" : a === undefined ? "None" : String(a)).join(", ");
      if (c.type === "error") {
        out += `    with pytest.raises(Exception):\n`;
        out += `        ${fn.name}(${args})\n`;
      } else {
        out += `    result = ${fn.name}(${args})\n`;
        out += `    assert result is not None  # TODO: add specific assertion\n`;
      }
      out += "\n";
    }
    return out;
  }

  // JavaScript/TypeScript
  let out = `import { describe, it } from 'node:test';\nimport assert from 'node:assert';\n// import { ${fn.name} } from './your-module.js';\n\n`;
  out += `describe('${fn.name}', () => {\n`;
  for (const c of cases) {
    const asyncPrefix = fn.isAsync ? "async " : "";
    out += `  it('${c.name}', ${asyncPrefix}() => {\n`;
    const args = c.args.map(a => a === null ? "null" : a === undefined ? "undefined" : String(a)).join(", ");
    if (c.type === "error") {
      if (fn.isAsync) {
        out += `    await assert.rejects(() => ${fn.name}(${args}));\n`;
      } else {
        out += `    assert.throws(() => ${fn.name}(${args}));\n`;
      }
    } else {
      if (fn.isAsync) {
        out += `    const result = await ${fn.name}(${args});\n`;
      } else {
        out += `    const result = ${fn.name}(${args});\n`;
      }
      out += `    assert.ok(result !== undefined); // TODO: add specific assertion\n`;
    }
    out += `  });\n\n`;
  }
  out += `});\n`;
  return out;
}

function generateTests(target, cwd) {
  const dir = cwd || process.cwd();

  if (!target || target === "--help") {
    return "\n  Smart Test Generator\n  Usage: /test-gen <function-name>  or  /test-gen <file.js>\n";
  }

  // If target is a file, scan all functions in it
  const isFile = /\.\w+$/.test(target);
  if (isFile) {
    const fp = path.resolve(dir, target);
    if (!fs.existsSync(fp)) return `\n  File not found: ${target}\n`;
    const content = fs.readFileSync(fp, "utf8");
    const lang = /\.py$/.test(target) ? "python" : "javascript";

    // Find all exported/public functions
    const funcNames = [];
    const patterns = [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/g,
      /def\s+(\w+)\s*\(/g,
    ];
    for (const pat of patterns) {
      let m;
      while ((m = pat.exec(content)) !== null) {
        if (!funcNames.includes(m[1]) && m[1] !== "constructor") funcNames.push(m[1]);
      }
    }

    if (!funcNames.length) return `\n  No functions found in ${target}\n`;

    let out = `\n  SMART TEST GENERATOR — ${target}\n  ${"─".repeat(50)}\n`;
    out += `  Found ${funcNames.length} function(s): ${funcNames.join(", ")}\n\n`;

    let allTests = "";
    for (const name of funcNames) {
      const fn = parseFunction(content, name);
      if (!fn) continue;
      const analysis = analyzeFunction(fn);
      const cases = generateTestCases(fn, analysis);
      allTests += formatTestFile(fn, cases, lang);
      out += `  ${name}(${fn.params.join(", ")}): ${cases.length} test cases generated\n`;
    }

    // Write test file
    const ext = lang === "python" ? ".py" : ".test.js";
    const testFile = target.replace(/\.\w+$/, ext.startsWith(".test") ? ext : `_test${ext}`);
    const testPath = path.resolve(dir, testFile);
    fs.writeFileSync(testPath, allTests);
    out += `\n  Test file written: ${testFile}\n`;
    return out;
  }

  // Single function name — search for it
  const files = fs.readdirSync(dir).filter(f => /\.(js|ts|py)$/.test(f));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    const fn = parseFunction(content, target);
    if (fn) {
      const analysis = analyzeFunction(fn);
      const cases = generateTestCases(fn, analysis);
      const lang = /\.py$/.test(file) ? "python" : "javascript";
      const testCode = formatTestFile(fn, cases, lang);
      const ext = lang === "python" ? "_test.py" : ".test.js";
      const testFile = `${target}${ext}`;
      fs.writeFileSync(path.join(dir, testFile), testCode);

      let out = `\n  SMART TEST GENERATOR — ${target}()\n  ${"─".repeat(50)}\n`;
      out += `  Found in: ${file}\n`;
      out += `  Parameters: ${fn.params.join(", ") || "(none)"}\n`;
      out += `  Async: ${fn.isAsync ? "yes" : "no"}\n`;
      out += `  Analysis:\n`;
      if (analysis.hasReturn) out += `    - Returns a value\n`;
      if (analysis.throwsErrors) out += `    - Throws errors\n`;
      if (analysis.hasConditionals) out += `    - Has conditional logic\n`;
      if (analysis.usesFileSystem) out += `    - Uses filesystem\n`;
      if (analysis.usesNetwork) out += `    - Makes network calls\n`;
      out += `\n  Generated ${cases.length} test cases:\n`;
      for (const c of cases) {
        const badge = { happy: "+", edge: "~", boundary: "|", error: "!" }[c.type] || " ";
        out += `    [${badge}] ${c.name}\n`;
      }
      out += `\n  Written to: ${testFile}\n`;
      return out;
    }
  }

  return `\n  Function '${target}' not found in current directory.\n  Try: /test-gen <filename.js>\n`;
}

module.exports = { generateTests };
