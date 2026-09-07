"use strict";
// ================= Vulnerability Scanner — automated security header + config checks =================
// Scans a URL or local project for common vulnerabilities without attacking.
// Safe, passive, read-only. Uses HTTP headers and public information only.
// PRO TIER FEATURE

const https = require("https");
const http = require("http");

function fetchHeaders(url, timeout) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeout || 10000 }, (res) => {
      const headers = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
      resolve({ status: res.statusCode, headers, url });
    });
    req.on("error", (e) => reject(new Error("Cannot reach " + url + ": " + e.message)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout reaching " + url)); });
  });
}

const CHECKS = [
  // Security headers
  { id: "hsts", name: "HSTS", check: (h) => !!h["strict-transport-security"], severity: "high", fix: "Add Strict-Transport-Security header" },
  { id: "xframe", name: "X-Frame-Options", check: (h) => !!h["x-frame-options"], severity: "medium", fix: "Add X-Frame-Options: DENY or SAMEORIGIN" },
  { id: "xctype", name: "X-Content-Type-Options", check: (h) => h["x-content-type-options"] === "nosniff", severity: "medium", fix: "Add X-Content-Type-Options: nosniff" },
  { id: "csp", name: "Content-Security-Policy", check: (h) => !!h["content-security-policy"], severity: "high", fix: "Add a Content-Security-Policy header" },
  { id: "referrer", name: "Referrer-Policy", check: (h) => !!h["referrer-policy"], severity: "low", fix: "Add Referrer-Policy: strict-origin-when-cross-origin" },
  { id: "perms", name: "Permissions-Policy", check: (h) => !!h["permissions-policy"], severity: "low", fix: "Add Permissions-Policy to restrict browser features" },

  // Information leakage
  { id: "server", name: "Server header hidden", check: (h) => !h["server"], severity: "low", fix: "Remove or obscure the Server header" },
  { id: "powered", name: "X-Powered-By hidden", check: (h) => !h["x-powered-by"], severity: "low", fix: "Remove X-Powered-By header" },

  // Cookie security
  { id: "cookie_secure", name: "Cookies use Secure flag", check: (h) => !h["set-cookie"] || /secure/i.test(h["set-cookie"] || ""), severity: "high", fix: "Add Secure flag to all cookies" },
  { id: "cookie_http", name: "Cookies use HttpOnly flag", check: (h) => !h["set-cookie"] || /httponly/i.test(h["set-cookie"] || ""), severity: "medium", fix: "Add HttpOnly flag to session cookies" },
  { id: "cookie_same", name: "Cookies use SameSite", check: (h) => !h["set-cookie"] || /samesite/i.test(h["set-cookie"] || ""), severity: "medium", fix: "Add SameSite=Lax or Strict to cookies" },

  // CORS
  { id: "cors", name: "CORS not wildcard", check: (h) => !h["access-control-allow-origin"] || h["access-control-allow-origin"] !== "*", severity: "medium", fix: "Don't use Access-Control-Allow-Origin: * in production" },

  // HTTPS
  { id: "https", name: "HTTPS enabled", check: (h, meta) => meta.url.startsWith("https"), severity: "critical", fix: "Enable HTTPS with a valid TLS certificate" },
];

async function scanUrl(url) {
  const { status, headers } = await fetchHeaders(url);
  const results = [];

  for (const check of CHECKS) {
    const passed = check.check(headers, { url });
    results.push({
      id: check.id,
      name: check.name,
      passed,
      severity: check.severity,
      fix: passed ? null : check.fix,
    });
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);
  const score = results.length ? Math.round(passed / results.length * 100) : 0;
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

  return { url, status, score, grade, passed, total: results.length, results, failed, headers };
}

function scanReport(scan) {
  const lines = [
    `# Security Scan — ${scan.url}`,
    `**Score:** ${scan.score}% (Grade: ${scan.grade}) | **Status:** ${scan.status}`,
    `**Passed:** ${scan.passed}/${scan.total}`,
    "",
  ];
  for (const r of scan.results) {
    lines.push(`${r.passed ? "✅" : "❌"} **${r.name}** ${r.passed ? "" : `— ${r.fix}`}`);
  }
  return lines.join("\n");
}

module.exports = { scanUrl, scanReport, CHECKS, fetchHeaders };
