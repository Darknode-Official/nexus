"use strict";
// ===================== Code Graph — Duplication / DRY Detector =====================
// Finds near-duplicate code so the agent reuses an existing implementation instead
// of writing a new one (the documented DRY-violation failure mode of AI coders).
// Method (honest description):
//   1. Tokenize MASKED source into a normalized stream: language keywords and
//      operators are kept verbatim, every other identifier becomes "V" and numbers
//      become "N". This yields Type-2 clone detection — duplicates survive variable
//      renames and literal changes, while real structure (control flow, call shape)
//      is preserved.
//   2. Fingerprint with a sliding k-gram window hashed by FNV-1a.
//   3. Seed from k-grams that collide across locations, then GREEDILY EXTEND each
//      match token-by-token for as long as the normalized streams agree, so a
//      colliding window grows into the largest exact-structure clone around it. A
//      single edited line in the middle simply splits one clone into two adjacent
//      ones — reported honestly, never hidden.
//   4. Report clones >= minTokens, merging subsumed/overlapping regions.
// Also exposes token-shingle Jaccard similarity for cheap file-level comparison.
const { mask, lineIndex, locAt } = require("./tokenizer");

// Keywords worth preserving as structure across the supported languages.
const KEYWORDS = new Set((
  "if else for while do switch case break continue return function class extends " +
  "const let var new this super try catch finally throw typeof instanceof in of " +
  "async await yield import export default from as void delete " + // js/ts
  "def elif except with lambda pass raise global nonlocal assert del " + // python
  "func type struct interface package range go defer chan map select fallthrough " + // go
  "module require end unless until begin ensure rescue when then module_function" // ruby
).split(/\s+/));

const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|=>|::|->|[{}()\[\];,.<>+\-*/%=&|!?:@]/g;

// tokenize(masked) -> [{ t, off }] normalized tokens with source offsets.
function tokenize(masked) {
  const out = []; let m; TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(masked))) {
    let t = m[0];
    if (/^[A-Za-z_$]/.test(t)) t = KEYWORDS.has(t) ? t : "V";
    else if (/^\d/.test(t)) t = "N";
    out.push({ t, off: m.index });
  }
  return out;
}

const FNV_OFFSET = 2166136261;
function fnv(str) { let h = FNV_OFFSET; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// fingerprint(tokens, k) -> [{ hash, start, end }] over sliding k-gram windows
// (start/end are token indices).
function fingerprint(tokens, k) {
  const fps = [];
  for (let i = 0; i + k <= tokens.length; i++) {
    let s = "";
    for (let j = 0; j < k; j++) s += tokens[i + j].t + " ";
    fps.push({ hash: fnv(s), start: i, end: i + k });
  }
  return fps;
}

// findDuplicates(files, opts) -> { clones:[{similarity, tokens, instances:[{file,
//   startLine, endLine}]}], scanned } . files: [{file, source|masked, lang}]
function findDuplicates(files, opts) {
  opts = opts || {};
  const k = opts.k || 20, minTokens = opts.minTokens || 45, maxSeeds = opts.maxSeeds || 60;
  const prepared = files.map((f) => {
    const masked = f.masked != null ? f.masked : mask(f.source, f.lang || "javascript").masked;
    const tokens = tokenize(masked);
    return { file: f.file, tokens, starts: lineIndex(masked) };
  });

  // hash -> [{fi, pos}]
  const index = new Map();
  prepared.forEach((p, fi) => {
    for (const fp of fingerprint(p.tokens, k)) {
      (index.get(fp.hash) || index.set(fp.hash, []).get(fp.hash)).push({ fi, pos: fp.start });
    }
  });

  const covered = prepared.map(() => new Set()); // token positions already in a clone
  const clones = [];
  for (const [, locs] of index) {
    if (locs.length < 2 || locs.length > maxSeeds) continue; // skip boilerplate seen everywhere
    for (let a = 0; a < locs.length; a++) {
      for (let b = a + 1; b < locs.length; b++) {
        const A = locs[a], B = locs[b];
        if (A.fi === B.fi && Math.abs(A.pos - B.pos) < k) continue; // overlapping same-file window
        if (covered[A.fi].has(A.pos) || covered[B.fi].has(B.pos)) continue;
        const ext = extendMatch(prepared[A.fi].tokens, A.pos, prepared[B.fi].tokens, B.pos);
        if (ext < minTokens) continue;
        mark(covered[A.fi], A.pos, A.pos + ext);
        mark(covered[B.fi], B.pos, B.pos + ext);
        clones.push({
          similarity: 1.0, tokens: ext,
          instances: [span(prepared[A.fi], A.pos, ext), span(prepared[B.fi], B.pos, ext)],
        });
      }
    }
  }
  clones.sort((x, y) => y.tokens - x.tokens);
  return { clones: suppressOverlaps(clones), scanned: prepared.length };
}

// suppressOverlaps — drop a clone when all of its instances are mostly covered by
// the line ranges of larger clones already kept (avoids reporting the same region
// many times from overlapping seed windows).
function suppressOverlaps(clones) {
  const covered = new Map(); // file -> array of [start,end] kept ranges
  const overlapLen = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]) + 1);
  const kept = [];
  for (const c of clones) {
    let allCovered = true;
    for (const inst of c.instances) {
      const ranges = covered.get(inst.file) || [];
      const span = inst.endLine - inst.startLine + 1;
      let ov = 0; for (const r of ranges) ov += overlapLen([inst.startLine, inst.endLine], r);
      if (ov < span * 0.6) { allCovered = false; break; }
    }
    if (allCovered) continue;
    kept.push(c);
    for (const inst of c.instances) (covered.get(inst.file) || covered.set(inst.file, []).get(inst.file)).push([inst.startLine, inst.endLine]);
  }
  return kept;
}

// extendMatch — grow two token runs forward while they agree; returns run length.
function extendMatch(ta, pa, tb, pb) {
  let len = 0;
  while (pa + len < ta.length && pb + len < tb.length && ta[pa + len].t === tb[pb + len].t) len++;
  return len;
}

function mark(set, from, to) { for (let i = from; i < to; i++) set.add(i); }

function span(prep, pos, len) {
  const first = prep.tokens[pos].off, last = prep.tokens[Math.min(pos + len - 1, prep.tokens.length - 1)].off;
  return { file: prep.file, startLine: locAt(prep.starts, first).line, endLine: locAt(prep.starts, last).line };
}

// ---- Cheap file-level similarity (token shingles + Jaccard) ----
function shingleSet(masked, k) {
  const tokens = tokenize(masked); const set = new Set();
  for (const fp of fingerprint(tokens, k || 5)) set.add(fp.hash);
  return set;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0; const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

module.exports = { tokenize, fingerprint, findDuplicates, extendMatch, shingleSet, jaccard, fnv, KEYWORDS };
