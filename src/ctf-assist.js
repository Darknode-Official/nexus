"use strict";
// ================= CTF Assistant — AI-powered CTF challenge solver =================
// Analyzes CTF challenges by category, suggests approaches, and provides hints
// without giving away the answer. Learns from solved challenges.
// PRO TIER FEATURE

const fs = require("fs");
const path = require("path");

const CATEGORIES = {
  web: {
    name: "Web Exploitation",
    techniques: ["SQL injection", "XSS", "CSRF", "SSRF", "LFI/RFI", "command injection", "deserialization", "JWT manipulation", "race condition", "IDOR"],
    tools: ["Burp Suite", "curl", "sqlmap", "ffuf", "dirsearch"],
    checklist: [
      "Check robots.txt and .git exposure",
      "Inspect cookies and headers",
      "Test all input fields for injection",
      "Check for hidden parameters",
      "Look at JavaScript source for API endpoints",
      "Test authentication bypass",
      "Check for insecure direct object references",
    ],
  },
  crypto: {
    name: "Cryptography",
    techniques: ["frequency analysis", "known plaintext", "padding oracle", "RSA attacks", "XOR", "hash cracking", "steganography"],
    tools: ["CyberChef", "hashcat", "john", "openssl", "python"],
    checklist: [
      "Identify the cipher/encoding (base64? hex? rot13?)",
      "Check for weak keys or small key sizes",
      "Look for reused nonces or IVs",
      "Try common passwords if it's a hash",
      "Check if RSA has small e or shared factors",
    ],
  },
  forensics: {
    name: "Forensics",
    techniques: ["file carving", "memory analysis", "log analysis", "metadata extraction", "steganography", "disk imaging"],
    tools: ["binwalk", "exiftool", "strings", "volatility", "foremost", "steghide"],
    checklist: [
      "Run file command to identify type",
      "Run strings to find readable text",
      "Check metadata with exiftool",
      "Run binwalk for embedded files",
      "Check for steganography (steghide, zsteg)",
      "If memory dump: use Volatility",
    ],
  },
  pwn: {
    name: "Binary Exploitation",
    techniques: ["buffer overflow", "format string", "ROP chain", "heap exploitation", "use-after-free", "ret2libc"],
    tools: ["gdb", "pwntools", "checksec", "ROPgadget", "radare2", "ghidra"],
    checklist: [
      "Run checksec to see protections (NX, ASLR, PIE, canary)",
      "Find the vulnerability (overflow? format string?)",
      "Calculate offset to return address",
      "If NX: build ROP chain or ret2libc",
      "If no ASLR: direct shellcode",
    ],
  },
  reversing: {
    name: "Reverse Engineering",
    techniques: ["static analysis", "dynamic analysis", "decompilation", "debugging", "anti-debugging bypass"],
    tools: ["ghidra", "IDA", "radare2", "ltrace", "strace", "gdb"],
    checklist: [
      "Run file to identify binary type",
      "Run strings for hardcoded flags/passwords",
      "Open in Ghidra/IDA for decompilation",
      "Look for strcmp/memcmp with constants",
      "Check for anti-debugging tricks",
      "Set breakpoints on key functions",
    ],
  },
  misc: {
    name: "Miscellaneous",
    techniques: ["OSINT", "network capture analysis", "QR codes", "encoding chains", "scripting"],
    tools: ["wireshark", "tshark", "python", "CyberChef"],
    checklist: [
      "Read the challenge description carefully for hints",
      "Check for unusual file extensions",
      "Try CyberChef auto-decode",
      "If PCAP: open in Wireshark, follow TCP streams",
      "Look for patterns in the data",
    ],
  },
};

function analyzeChallenge(description, category) {
  category = category || detectCategory(description);
  const cat = CATEGORIES[category] || CATEGORIES.misc;

  return {
    category: cat.name,
    suggestedApproach: cat.checklist,
    techniques: cat.techniques,
    tools: cat.tools,
    hints: generateHints(description, category),
    prompt: buildSolverPrompt(description, cat),
  };
}

function detectCategory(description) {
  const d = String(description).toLowerCase();
  if (/sql|xss|cookie|session|login|http|url|web|php|html|api/.test(d)) return "web";
  if (/cipher|encrypt|decrypt|rsa|aes|hash|base64|xor|key/.test(d)) return "crypto";
  if (/file|image|pcap|memory|disk|log|metadata|hidden/.test(d)) return "forensics";
  if (/binary|buffer|overflow|exploit|shellcode|rop|pwn|elf/.test(d)) return "pwn";
  if (/reverse|decompil|disassembl|crack|keygen|password/.test(d)) return "reversing";
  return "misc";
}

function generateHints(description, category) {
  const hints = [];
  const d = String(description).toLowerCase();
  if (/base64/.test(d)) hints.push("Try decoding the base64 string — it might be nested encoding");
  if (/cookie/.test(d)) hints.push("Inspect cookies in your browser dev tools — look for JWT or serialized data");
  if (/admin/.test(d)) hints.push("Try common admin paths: /admin, /login, /dashboard, /panel");
  if (/hidden/.test(d)) hints.push("Check page source, HTTP headers, and response for hidden data");
  if (/flag\{/.test(d) || /ctf\{/.test(d)) hints.push("The flag format is visible — search for similar patterns in the data");
  if (/image|png|jpg/.test(d)) hints.push("Images can hide data — try exiftool, binwalk, steghide, zsteg");
  if (!hints.length) hints.push("Start with the checklist for " + (CATEGORIES[category]?.name || "this category"));
  return hints;
}

function buildSolverPrompt(description, cat) {
  return [
    `You are a CTF mentor helping a student solve a ${cat.name} challenge.`,
    "Guide them through the process WITHOUT giving the answer directly.",
    "Ask Socratic questions that lead them to discover the solution.",
    "",
    "Relevant techniques: " + cat.techniques.join(", "),
    "Useful tools: " + cat.tools.join(", "),
    "",
    "Challenge description:",
    description,
    "",
    "Help the student step by step. Start with: what do you notice about this challenge?",
  ].join("\n");
}

module.exports = { CATEGORIES, analyzeChallenge, detectCategory, generateHints, buildSolverPrompt };
