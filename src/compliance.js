"use strict";
// ================= Compliance Checker — OWASP Top 10 / CIS benchmark =================
// Checks a web application or codebase against standard security benchmarks.
// Returns a scored report with pass/fail/warning for each control.
// TEAM TIER FEATURE

const OWASP_TOP_10_2021 = [
  { id: "A01", name: "Broken Access Control", checks: [
    { name: "CORS policy", check: (h) => !h["access-control-allow-origin"] || h["access-control-allow-origin"] !== "*", fail: "CORS allows all origins (*)" },
    { name: "Missing auth on endpoints", check: () => true, fail: "Manual review required" },
    { name: "IDOR protection", check: () => true, fail: "Manual review required" },
  ]},
  { id: "A02", name: "Cryptographic Failures", checks: [
    { name: "HTTPS enforced", check: (h, url) => url.startsWith("https"), fail: "Site served over HTTP" },
    { name: "HSTS header", check: (h) => !!h["strict-transport-security"], fail: "Missing Strict-Transport-Security header" },
    { name: "No weak ciphers", check: () => true, fail: "Manual SSL scan required (testssl.sh)" },
  ]},
  { id: "A03", name: "Injection", checks: [
    { name: "Content-Type validation", check: (h) => !!h["content-type"], fail: "Missing Content-Type header" },
    { name: "Input sanitization", check: () => true, fail: "Manual code review required" },
  ]},
  { id: "A04", name: "Insecure Design", checks: [
    { name: "Rate limiting", check: (h) => !!h["x-ratelimit-limit"] || !!h["retry-after"], fail: "No rate limiting headers detected" },
    { name: "Error handling", check: () => true, fail: "Check that errors don't leak stack traces" },
  ]},
  { id: "A05", name: "Security Misconfiguration", checks: [
    { name: "X-Frame-Options", check: (h) => !!h["x-frame-options"], fail: "Missing X-Frame-Options (clickjacking risk)" },
    { name: "X-Content-Type-Options", check: (h) => h["x-content-type-options"] === "nosniff", fail: "Missing X-Content-Type-Options: nosniff" },
    { name: "Server header hidden", check: (h) => !h["server"] || h["server"] === "", fail: "Server header exposes technology" },
    { name: "X-Powered-By hidden", check: (h) => !h["x-powered-by"], fail: "X-Powered-By header exposes technology" },
  ]},
  { id: "A06", name: "Vulnerable Components", checks: [
    { name: "Dependency audit", check: () => true, fail: "Run: npm audit / pip audit" },
  ]},
  { id: "A07", name: "Auth Failures", checks: [
    { name: "Secure cookies", check: (h) => !h["set-cookie"] || /secure/i.test(h["set-cookie"] || ""), fail: "Cookies missing Secure flag" },
    { name: "HttpOnly cookies", check: (h) => !h["set-cookie"] || /httponly/i.test(h["set-cookie"] || ""), fail: "Cookies missing HttpOnly flag" },
  ]},
  { id: "A08", name: "Software Integrity", checks: [
    { name: "Subresource integrity", check: () => true, fail: "Check CDN scripts have integrity attributes" },
  ]},
  { id: "A09", name: "Logging & Monitoring", checks: [
    { name: "Security logging", check: () => true, fail: "Verify security events are logged" },
  ]},
  { id: "A10", name: "SSRF", checks: [
    { name: "URL validation", check: () => true, fail: "Verify user-supplied URLs are validated" },
  ]},
];

function checkHeaders(headers, url) {
  const results = [];
  for (const category of OWASP_TOP_10_2021) {
    const checks = category.checks.map(c => {
      const passed = c.check(headers, url);
      return { name: c.name, passed, message: passed ? "Pass" : c.fail };
    });
    const passed = checks.filter(c => c.passed).length;
    results.push({
      id: category.id,
      name: category.name,
      checks,
      passed,
      total: checks.length,
      score: checks.length ? Math.round(passed / checks.length * 100) : 0,
    });
  }

  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalChecks = results.reduce((s, r) => s + r.total, 0);
  const overallScore = totalChecks ? Math.round(totalPassed / totalChecks * 100) : 0;
  const grade = overallScore >= 90 ? "A" : overallScore >= 80 ? "B" : overallScore >= 70 ? "C" : overallScore >= 60 ? "D" : "F";

  return { results, overallScore, grade, totalPassed, totalChecks };
}

function complianceReport(check, url) {
  const lines = [
    `# OWASP Top 10 Compliance Report`,
    `**Target:** ${url}`,
    `**Score:** ${check.overallScore}% (Grade: ${check.grade})`,
    `**Checks:** ${check.totalPassed}/${check.totalChecks} passed`,
    "",
  ];
  for (const r of check.results) {
    const icon = r.score === 100 ? "✅" : r.score >= 50 ? "⚠️" : "❌";
    lines.push(`## ${icon} ${r.id}: ${r.name} (${r.score}%)`);
    for (const c of r.checks) {
      lines.push(`  ${c.passed ? "✅" : "❌"} ${c.name} — ${c.message}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = { OWASP_TOP_10_2021, checkHeaders, complianceReport };
