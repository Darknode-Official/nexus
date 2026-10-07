"use strict";
// ===================== Code Graph — Brace Block Scanner =====================
// Brace-delimited languages (JavaScript/TypeScript, Go, C-family) share a scope
// model: `{ ... }` nests, and the text immediately preceding an opening brace is
// the "header" that names what the block is (`class Foo`, `function bar(x)`,
// `func (r *R) M()`...). scanBlocks walks a MASKED source (see tokenizer.mask —
// strings/comments already blanked, so braces inside them never count) and builds
// a tree of blocks, each carrying the header text and precise offsets. Language
// parsers then classify headers instead of re-implementing scope tracking.
//
// Pure and language-agnostic. Input must be masked source for correctness.

// scanBlocks(masked) -> root block { start:0, bodyStart:0, bodyEnd:n, depth:-1,
//   header:"", children:[...] }. Each child block:
//   { headerStart, header, open (offset of '{'), bodyEnd (offset after '}'),
//     depth, children:[] }
// `header` is the trimmed text between the previous sibling/parent boundary and
// this block's '{'. A block whose brace never closes extends to end-of-source.
function scanBlocks(masked) {
  const s = String(masked == null ? "" : masked);
  const n = s.length;
  const root = { headerStart: 0, header: "", open: -1, bodyEnd: n, depth: -1, children: [] };
  const stack = [root];
  // boundary = offset where the current header-candidate begins (reset after any
  // '{', '}' or ';' so headers don't bleed across statements).
  let boundary = 0;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c === "{") {
      const parent = stack[stack.length - 1];
      const header = s.slice(boundary, i).replace(/\s+/g, " ").trim();
      const block = { headerStart: boundary, header, open: i, bodyEnd: n, depth: parent.depth + 1, children: [] };
      parent.children.push(block);
      stack.push(block);
      boundary = i + 1;
    } else if (c === "}") {
      if (stack.length > 1) { const b = stack.pop(); b.bodyEnd = i + 1; }
      boundary = i + 1;
    } else if (c === ";") {
      boundary = i + 1;
    }
  }
  return root;
}

// walkBlocks(root, fn) — depth-first visit of every non-root block.
function walkBlocks(root, fn) {
  for (const child of root.children) { fn(child); walkBlocks(child, fn); }
}

// topLevel(root) -> blocks at depth 0 (direct children of root).
function topLevel(root) { return root.children; }

module.exports = { scanBlocks, walkBlocks, topLevel };
