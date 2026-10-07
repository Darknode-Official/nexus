"use strict";
// ============================================================================
// Lightweight, dependency-free syntax highlighter (UI-005 fenced code blocks).
// Not a full parser — a robust lexer covering the common constructs (comments,
// strings, numbers, keywords, functions) across C-family, Python, shell, JSON.
// All colors come from the theme's syntax.* tokens.
// ============================================================================

const KEYWORDS = new Set([
  // JS/TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "new", "class", "extends", "super", "this",
  "import", "export", "from", "default", "async", "await", "yield", "try", "catch",
  "finally", "throw", "typeof", "instanceof", "in", "of", "delete", "void", "null",
  "undefined", "true", "false", "interface", "type", "enum", "public", "private",
  "protected", "static", "readonly", "implements",
  // Python
  "def", "lambda", "elif", "pass", "with", "as", "global", "nonlocal", "assert",
  "raise", "except", "None", "True", "False", "and", "or", "not", "is", "self",
  // Shell / common
  "echo", "fi", "then", "elif", "esac", "done", "local", "fn", "match", "struct",
  "impl", "pub", "use", "mut", "where",
]);

function highlightLine(theme, line, lang) {
  // Tokenise into [text, token|null] spans.
  const out = [];
  let i = 0;
  const n = line.length;
  const push = (txt, tok) => { if (txt) out.push(theme.paint(txt, tok)); };
  const pushRaw = (txt) => { if (txt) out.push(txt); };

  // Whole-line comment for # (python/shell) handled inline below.
  while (i < n) {
    const ch = line[i];
    const rest = line.slice(i);

    // Line comments
    if (ch === "/" && line[i + 1] === "/") { push(line.slice(i), "syntax.comment"); break; }
    if (ch === "#" && (lang === "py" || lang === "python" || lang === "sh" || lang === "bash" || lang === "yaml" || lang === "yml" || lang === "" || lang == null)) {
      push(line.slice(i), "syntax.comment"); break;
    }
    // Block comment start (single-line slice only)
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) { push(line.slice(i), "syntax.comment"); break; }
      push(line.slice(i, end + 2), "syntax.comment"); i = end + 2; continue;
    }
    // Strings
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n && line[j] !== ch) { if (line[j] === "\\") j++; j++; }
      push(line.slice(i, Math.min(j + 1, n)), "syntax.string"); i = j + 1; continue;
    }
    // Numbers
    if (/[0-9]/.test(ch) && !/[A-Za-z_]/.test(line[i - 1] || "")) {
      const m = /^0x[0-9a-fA-F]+|^\d+\.?\d*(e[+-]?\d+)?/.exec(rest);
      if (m) { push(m[0], "syntax.number"); i += m[0].length; continue; }
    }
    // Identifiers / keywords / function calls
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
      const word = m[0];
      if (KEYWORDS.has(word)) push(word, "syntax.keyword");
      else if (line[i + word.length] === "(") push(word, "syntax.function");
      else pushRaw(word);
      i += word.length; continue;
    }
    // Operators / punctuation
    if (/[{}()[\]]/.test(ch)) { push(ch, "syntax.punctuation"); i++; continue; }
    if (/[+\-*/%=<>!&|^~?:.,;]/.test(ch)) { push(ch, "syntax.operator"); i++; continue; }

    pushRaw(ch); i++;
  }
  return out.join("");
}

module.exports = { highlightLine, KEYWORDS };
