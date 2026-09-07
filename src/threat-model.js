"use strict";
// ================= Threat Modeler — STRIDE-based threat modeling =================
// Analyzes an application architecture and identifies threats using the STRIDE
// framework. Generates a threat model document with mitigations.
// PRO TIER FEATURE

const STRIDE = {
  S: { name: "Spoofing", question: "Can an attacker pretend to be someone else?", mitigations: ["Strong authentication", "MFA", "Certificate pinning", "Token validation"] },
  T: { name: "Tampering", question: "Can an attacker modify data in transit or at rest?", mitigations: ["Input validation", "Integrity checks (HMAC)", "Digital signatures", "Encryption at rest"] },
  R: { name: "Repudiation", question: "Can an attacker deny performing an action?", mitigations: ["Audit logging", "Digital signatures", "Timestamps", "Non-repudiation protocols"] },
  I: { name: "Information Disclosure", question: "Can an attacker access unauthorized data?", mitigations: ["Encryption", "Access controls", "Data classification", "Minimize data exposure"] },
  D: { name: "Denial of Service", question: "Can an attacker make the system unavailable?", mitigations: ["Rate limiting", "Load balancing", "Input validation", "Resource quotas", "CDN/DDoS protection"] },
  E: { name: "Elevation of Privilege", question: "Can an attacker gain higher access than allowed?", mitigations: ["Least privilege", "RBAC", "Input validation", "Sandboxing", "Capability-based security"] },
};

function analyzeComponent(component) {
  const threats = [];
  const type = (component.type || "").toLowerCase();

  // API endpoints are vulnerable to most STRIDE categories
  if (/api|endpoint|route|server/.test(type)) {
    threats.push({ stride: "S", threat: `${component.name}: API authentication bypass`, severity: "high" });
    threats.push({ stride: "T", threat: `${component.name}: Request body tampering`, severity: "medium" });
    threats.push({ stride: "I", threat: `${component.name}: Sensitive data in responses`, severity: "medium" });
    threats.push({ stride: "D", threat: `${component.name}: No rate limiting`, severity: "medium" });
    threats.push({ stride: "E", threat: `${component.name}: Privilege escalation via parameter manipulation`, severity: "high" });
  }

  // Databases
  if (/database|db|store|cache/.test(type)) {
    threats.push({ stride: "T", threat: `${component.name}: SQL/NoSQL injection`, severity: "critical" });
    threats.push({ stride: "I", threat: `${component.name}: Unencrypted data at rest`, severity: "high" });
    threats.push({ stride: "R", threat: `${component.name}: Missing audit trail`, severity: "medium" });
  }

  // Auth systems
  if (/auth|login|session|token/.test(type)) {
    threats.push({ stride: "S", threat: `${component.name}: Credential stuffing`, severity: "high" });
    threats.push({ stride: "S", threat: `${component.name}: Session hijacking`, severity: "high" });
    threats.push({ stride: "E", threat: `${component.name}: JWT manipulation`, severity: "critical" });
  }

  // File upload/storage
  if (/file|upload|storage|cdn/.test(type)) {
    threats.push({ stride: "T", threat: `${component.name}: Malicious file upload`, severity: "high" });
    threats.push({ stride: "I", threat: `${component.name}: Path traversal`, severity: "high" });
    threats.push({ stride: "E", threat: `${component.name}: Code execution via uploaded file`, severity: "critical" });
  }

  // Add mitigations
  return threats.map(t => ({
    ...t,
    strideName: STRIDE[t.stride].name,
    question: STRIDE[t.stride].question,
    mitigations: STRIDE[t.stride].mitigations,
  }));
}

function generateThreatModel(app) {
  const allThreats = [];
  for (const component of (app.components || [])) {
    allThreats.push(...analyzeComponent(component));
  }
  allThreats.sort((a, b) => {
    const sev = { critical: 0, high: 1, medium: 2, low: 3 };
    return (sev[a.severity] || 4) - (sev[b.severity] || 4);
  });

  const stats = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const t of allThreats) stats[t.severity] = (stats[t.severity] || 0) + 1;

  return {
    app: app.name || "Application",
    components: (app.components || []).length,
    threats: allThreats,
    stats,
    totalThreats: allThreats.length,
  };
}

function threatModelMarkdown(model) {
  const lines = [
    `# Threat Model — ${model.app}`,
    `**Components:** ${model.components} | **Threats:** ${model.totalThreats}`,
    `**Critical:** ${model.stats.critical} | **High:** ${model.stats.high} | **Medium:** ${model.stats.medium}`,
    "",
  ];
  for (const t of model.threats) {
    lines.push(`### [${t.severity.toUpperCase()}] ${t.strideName}: ${t.threat}`);
    lines.push(`**Question:** ${t.question}`);
    lines.push(`**Mitigations:** ${t.mitigations.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = { STRIDE, analyzeComponent, generateThreatModel, threatModelMarkdown };
