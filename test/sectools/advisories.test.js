"use strict";
// Tests for sectools/advisories — version logic, manifest parsing, matching.
// Run: node --test test/sectools/

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const adv = require("../../src/sectools/advisories");
const { ADVISORIES } = require("../../src/sectools/advisory-db");

describe("advisories · version comparison", () => {
  it("compares release components numerically", () => {
    assert.equal(adv.compareVersions("1.2.3", "1.2.3"), 0);
    assert.equal(adv.compareVersions("1.2.3", "1.2.4"), -1);
    assert.equal(adv.compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(adv.compareVersions("2.0.0", "1.9.9"), 1);
  });
  it("treats pre-release as lower than release", () => {
    assert.equal(adv.compareVersions("1.0.0-rc1", "1.0.0"), -1);
    assert.equal(adv.compareVersions("1.0.0", "1.0.0-rc1"), 1);
  });
  it("tolerates v-prefixes and partial versions", () => {
    assert.equal(adv.compareVersions("v1.2", "1.2.0"), 0);
  });
});

describe("advisories · satisfies", () => {
  it("handles single and compound comparators (AND)", () => {
    assert.equal(adv.satisfies("4.17.20", "<4.17.21"), true);
    assert.equal(adv.satisfies("4.17.21", "<4.17.21"), false);
    assert.equal(adv.satisfies("3.1.0", ">=3.0,<3.2.13"), true);
    assert.equal(adv.satisfies("3.3.0", ">=3.0,<3.2.13"), false);
  });
  it("handles OR groups with ||", () => {
    assert.equal(adv.satisfies("1.0.0", "<0.5.0 || >=1.0.0 <2.0.0"), true);
    assert.equal(adv.satisfies("0.6.0", "<0.5.0 || >=1.0.0"), false);
  });
});

describe("advisories · version coercion", () => {
  it("coerces npm specs to the lowest allowed version", () => {
    assert.equal(adv.coerceVersion("^4.17.0"), "4.17.0");
    assert.equal(adv.coerceVersion("~1.2.3"), "1.2.3");
    assert.equal(adv.coerceVersion(">=2.0.0 <3.0.0"), "2.0.0");
    assert.equal(adv.coerceVersion("1.2.x"), "1.2.0");
    assert.equal(adv.coerceVersion("*"), null);
    assert.equal(adv.coerceVersion("git+https://x"), null);
  });
  it("coerces pip specs", () => {
    assert.equal(adv.coercePipVersion("==2.1.0"), "2.1.0");
    assert.equal(adv.coercePipVersion(">=1.0,<2.0"), "1.0");
    assert.equal(adv.coercePipVersion("~=1.4.2"), "1.4.2");
  });
});

describe("advisories · manifest parsing", () => {
  it("parses package.json across all dependency sections", () => {
    const text = JSON.stringify({
      dependencies: { lodash: "^4.17.0" },
      devDependencies: { jest: "^29" },
      optionalDependencies: { fsevents: "*" },
    });
    const deps = adv.parsePackageJson(text);
    assert.ok(deps.find((d) => d.name === "lodash" && d.scope === "prod"));
    assert.ok(deps.find((d) => d.name === "jest" && d.scope === "dev"));
    assert.ok(deps.find((d) => d.name === "fsevents" && d.scope === "optional"));
  });

  it("returns [] for malformed package.json", () => {
    assert.deepEqual(adv.parsePackageJson("{not json"), []);
  });

  it("parses package-lock v2 packages map for exact versions", () => {
    const lock = JSON.stringify({
      packages: {
        "": { name: "root" },
        "node_modules/lodash": { version: "4.17.20" },
        "node_modules/a/node_modules/minimist": { version: "1.2.0" },
      },
    });
    const deps = adv.parsePackageLock(lock);
    assert.ok(deps.find((d) => d.name === "lodash" && d.version === "4.17.20"));
    assert.ok(deps.find((d) => d.name === "minimist" && d.version === "1.2.0"));
  });

  it("parses requirements.txt with operators, markers and extras", () => {
    const req = [
      "Django==3.1.0",
      "requests>=2.20 ; python_version>='3.6'",
      "flask[async]==2.3.0",
      "# a comment",
      "-e .",
    ].join("\n");
    const deps = adv.parseRequirementsTxt(req);
    assert.ok(deps.find((d) => d.name === "django" && d.spec.includes("3.1.0")));
    assert.ok(deps.find((d) => d.name === "requests"));
    assert.ok(deps.find((d) => d.name === "flask"));
    assert.equal(deps.find((d) => d.name === "flask").ecosystem, "pip");
  });
});

describe("advisories · matching (positive)", () => {
  it("flags a vulnerable npm manifest spec", () => {
    const deps = adv.parsePackageJson(JSON.stringify({ dependencies: { lodash: "^4.17.0", minimist: "1.2.0" } }));
    const f = adv.checkDependencies(deps);
    const ids = f.map((x) => x.package);
    assert.ok(ids.includes("lodash"));
    assert.ok(ids.includes("minimist"));
    const lo = f.find((x) => x.package === "lodash");
    assert.equal(lo.patched, "4.17.21");
    assert.equal(lo.resolvedFrom, "manifest-spec");
    assert.ok(lo.aliases.length >= 1);
  });

  it("flags vulnerable pip requirements with a range advisory", () => {
    const deps = adv.parseRequirementsTxt("Django==3.1.0\nPyYAML==5.3");
    const f = adv.checkDependencies(deps);
    assert.ok(f.find((x) => x.package === "django"));
    assert.ok(f.find((x) => x.package === "pyyaml"));
  });

  it("reports higher confidence for lockfile-resolved versions", () => {
    const f = adv.checkDependencies([{ name: "lodash", version: "4.17.20", ecosystem: "npm" }]);
    assert.equal(f[0].resolvedFrom, "lockfile");
    assert.ok(f[0].confidence > 0.9);
  });
});

describe("advisories · matching (negative)", () => {
  it("does not flag patched versions", () => {
    const deps = adv.parsePackageJson(JSON.stringify({ dependencies: { lodash: "4.17.21", axios: "1.6.5", express: "4.20.0" } }));
    assert.deepEqual(adv.checkDependencies(deps), []);
  });
  it("does not flag Django outside the vulnerable range", () => {
    assert.deepEqual(adv.checkDependencies(adv.parseRequirementsTxt("Django==3.2.13")), []);
  });
  it("skips unresolvable specs (*/git) without throwing", () => {
    const deps = adv.parsePackageJson(JSON.stringify({ dependencies: { lodash: "*" } }));
    assert.deepEqual(adv.checkDependencies(deps), []);
  });
});

describe("advisories · database", () => {
  it("every seed advisory has a valid shape", () => {
    const ids = new Set();
    for (const a of ADVISORIES) {
      assert.ok(a.id && !ids.has(a.id), "dup id " + a.id);
      ids.add(a.id);
      assert.ok(["npm", "pip"].includes(a.ecosystem), a.id);
      assert.ok(a.package && a.vulnerable && a.patched, a.id);
      assert.match(a.cwe, /^CWE-\d+$/, a.id);
    }
  });
  it("loadDatabase validates and drops malformed records", () => {
    const loaded = adv.loadDatabase(JSON.stringify([
      { package: "x", ecosystem: "npm", vulnerable: "<1.0.0", severity: "low" },
      { bogus: true },
    ]));
    assert.equal(loaded.length, 1);
  });
  it("checkDependencies honours a custom db", () => {
    const db = [{ id: "X", ecosystem: "npm", package: "mypkg", severity: "high", cwe: "CWE-1", title: "t", vulnerable: "<2.0.0", patched: "2.0.0" }];
    const f = adv.checkDependencies([{ name: "mypkg", version: "1.0.0", ecosystem: "npm" }], { db });
    assert.equal(f.length, 1);
    assert.equal(f[0].id, "X");
  });
});
