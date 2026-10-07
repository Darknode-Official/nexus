"use strict";
// ================= sectools/advisory-db — bundled offline advisory database =================
// A SEED set of known-vulnerable dependency advisories used by ./advisories.js.
// It is intentionally small and curated — not a mirror of the full ecosystem — so
// Nexus can flag high-impact, well-known vulnerable versions with no network and
// no third-party dependency.
//
// ADVISORY RECORD FORMAT (stable; extend by appending records):
//   {
//     id,          // internal advisory id, "DN-<year>-<n>"
//     ecosystem,   // "npm" | "pip"
//     package,     // canonical package name (lowercased for npm; pip is case-insensitive)
//     severity,    // "critical" | "high" | "medium" | "low"
//     cwe,         // CWE identifier
//     title,       // short description
//     vulnerable,  // version range string(s) that are affected (see advisories.satisfies)
//     patched,     // the first fixed version (upgrade target)
//     aliases,     // external ids (CVE/GHSA) for cross-reference
//     references,  // URLs for the advisory
//   }
//
// UPDATING: this file is data only. To refresh, append/modify records (keep ids
// stable) or load an external JSON array of the same shape via
// advisories.loadDatabase(json). See README.md "Advisory database" for the sync
// recipe. `meta.generated` marks when this seed set was last curated.

const META = {
  name: "nexus-sectools-seed",
  generated: "2026-10-06",
  schema: 1,
  note: "Seed advisory set — curated subset of well-known CVEs, not an exhaustive mirror.",
};

const ADVISORIES = [
  // ------------------------------------------------------------------ npm
  {
    id: "DN-2021-0001", ecosystem: "npm", package: "lodash",
    severity: "high", cwe: "CWE-1321",
    title: "Prototype pollution in lodash",
    vulnerable: "<4.17.21", patched: "4.17.21",
    aliases: ["CVE-2021-23337", "CVE-2020-8203"],
    references: ["https://github.com/advisories/GHSA-35jh-r3h4-6jhm"],
  },
  {
    id: "DN-2021-0002", ecosystem: "npm", package: "minimist",
    severity: "critical", cwe: "CWE-1321",
    title: "Prototype pollution in minimist",
    vulnerable: "<1.2.6", patched: "1.2.6",
    aliases: ["CVE-2021-44906"],
    references: ["https://github.com/advisories/GHSA-xvch-5gv4-984h"],
  },
  {
    id: "DN-2023-0003", ecosystem: "npm", package: "axios",
    severity: "high", cwe: "CWE-918",
    title: "Server-side request forgery / credential leak in axios",
    vulnerable: "<1.6.0", patched: "1.6.0",
    aliases: ["CVE-2023-45857"],
    references: ["https://github.com/advisories/GHSA-wf5p-g6vw-rhxx"],
  },
  {
    id: "DN-2022-0004", ecosystem: "npm", package: "node-fetch",
    severity: "high", cwe: "CWE-200",
    title: "Exposure of sensitive information to an unauthorized actor in node-fetch",
    vulnerable: "<2.6.7", patched: "2.6.7",
    aliases: ["CVE-2022-0235"],
    references: ["https://github.com/advisories/GHSA-r683-j2x4-v87g"],
  },
  {
    id: "DN-2022-0005", ecosystem: "npm", package: "ejs",
    severity: "critical", cwe: "CWE-94",
    title: "Remote code execution via template options in ejs",
    vulnerable: "<3.1.7", patched: "3.1.7",
    aliases: ["CVE-2022-29078"],
    references: ["https://github.com/advisories/GHSA-phwq-j96m-2c2q"],
  },
  {
    id: "DN-2022-0006", ecosystem: "npm", package: "jsonwebtoken",
    severity: "high", cwe: "CWE-327",
    title: "Insecure default algorithm / key confusion in jsonwebtoken",
    vulnerable: "<9.0.0", patched: "9.0.0",
    aliases: ["CVE-2022-23529", "CVE-2022-23540"],
    references: ["https://github.com/advisories/GHSA-8cf7-32gw-wr33"],
  },
  {
    id: "DN-2023-0007", ecosystem: "npm", package: "semver",
    severity: "medium", cwe: "CWE-1333",
    title: "Regular expression denial of service in semver",
    vulnerable: "<7.5.2", patched: "7.5.2",
    aliases: ["CVE-2022-25883"],
    references: ["https://github.com/advisories/GHSA-c2qf-rxjj-qqgw"],
  },
  {
    id: "DN-2021-0008", ecosystem: "npm", package: "tar",
    severity: "high", cwe: "CWE-22",
    title: "Arbitrary file write / path traversal in tar",
    vulnerable: "<6.1.9", patched: "6.1.9",
    aliases: ["CVE-2021-37713"],
    references: ["https://github.com/advisories/GHSA-5955-9wpr-37jh"],
  },
  {
    id: "DN-2024-0009", ecosystem: "npm", package: "express",
    severity: "medium", cwe: "CWE-601",
    title: "Open redirect in express response.location/redirect",
    vulnerable: "<4.19.2", patched: "4.19.2",
    aliases: ["CVE-2024-29041"],
    references: ["https://github.com/advisories/GHSA-rv95-896h-c2vc"],
  },
  {
    id: "DN-2021-0010", ecosystem: "npm", package: "ws",
    severity: "medium", cwe: "CWE-1333",
    title: "Regular expression denial of service in ws",
    vulnerable: "<7.4.6", patched: "7.4.6",
    aliases: ["CVE-2021-32640"],
    references: ["https://github.com/advisories/GHSA-6fc8-4gx4-v693"],
  },

  // ------------------------------------------------------------------ pip
  {
    id: "DN-2022-0011", ecosystem: "pip", package: "django",
    severity: "high", cwe: "CWE-89",
    title: "SQL injection via QuerySet.annotate/aggregate in Django",
    vulnerable: ">=3.0,<3.2.13", patched: "3.2.13",
    aliases: ["CVE-2022-28346"],
    references: ["https://www.djangoproject.com/weblog/2022/apr/11/security-releases/"],
  },
  {
    id: "DN-2023-0012", ecosystem: "pip", package: "flask",
    severity: "high", cwe: "CWE-539",
    title: "Possible session cookie disclosure in Flask",
    vulnerable: "<2.2.5", patched: "2.2.5",
    aliases: ["CVE-2023-30861"],
    references: ["https://github.com/advisories/GHSA-m2qf-hxjv-5gpq"],
  },
  {
    id: "DN-2023-0013", ecosystem: "pip", package: "requests",
    severity: "medium", cwe: "CWE-200",
    title: "Proxy-Authorization header leak on redirect in requests",
    vulnerable: "<2.31.0", patched: "2.31.0",
    aliases: ["CVE-2023-32681"],
    references: ["https://github.com/advisories/GHSA-j8r2-6x86-q33q"],
  },
  {
    id: "DN-2020-0014", ecosystem: "pip", package: "pyyaml",
    severity: "critical", cwe: "CWE-502",
    title: "Arbitrary code execution via full_load / FullLoader in PyYAML",
    vulnerable: "<5.4", patched: "5.4",
    aliases: ["CVE-2020-14343"],
    references: ["https://github.com/advisories/GHSA-8q59-q68h-6hv4"],
  },
  {
    id: "DN-2021-0015", ecosystem: "pip", package: "urllib3",
    severity: "high", cwe: "CWE-1333",
    title: "Regular expression denial of service in urllib3",
    vulnerable: "<1.26.5", patched: "1.26.5",
    aliases: ["CVE-2021-33503"],
    references: ["https://github.com/advisories/GHSA-q2q7-5pp4-w6pg"],
  },
  {
    id: "DN-2020-0016", ecosystem: "pip", package: "jinja2",
    severity: "medium", cwe: "CWE-1333",
    title: "Regular expression denial of service in Jinja2 urlize",
    vulnerable: "<2.11.3", patched: "2.11.3",
    aliases: ["CVE-2020-28493"],
    references: ["https://github.com/advisories/GHSA-g3rq-g295-4j3m"],
  },
];

module.exports = { META, ADVISORIES };
