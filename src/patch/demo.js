"use strict";
// ================= Runnable demo for the Nexus patch/codemod engine =================
// Exercises every capability end-to-end in a throwaway temp directory.
//   node src/patch/demo.js
// Writes nothing inside the repo; the sandbox is created under the OS temp dir and
// removed on exit.

const fs = require("fs");
const os = require("os");
const path = require("path");
const patch = require("./index");

function h(title) { console.log("\n=== " + title + " ==="); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-patch-demo-"));
try {
  // 1) Unified diff generation + parsing -------------------------------------
  h("1. Unified diff (generate + stat)");
  const before = "function greet(name) {\n  return 'hi ' + name;\n}\n";
  const after = "function greet(name) {\n  return 'hello, ' + name + '!';\n}\n";
  const ud = patch.createUnifiedDiff(before, after, { oldPath: "greet.js", newPath: "greet.js" });
  process.stdout.write(ud);
  console.log("stat:", patch.diff.diffStat(ud));

  // 2) Fuzzy apply with drift -------------------------------------------------
  h("2. Fuzzy apply with drift (lines inserted above the hunk)");
  const drifted = "// banner\n// added later\n" + before;
  const res = patch.applyPatch(drifted, patch.parseUnifiedDiff(ud)[0], {});
  console.log(patch.preview.renderApply(res));
  console.log("result:\n" + res.text);

  // 3) Clean rejection --------------------------------------------------------
  h("3. Clean rejection (context absent) — no silent half-apply");
  const rej = patch.applyPatch("totally\nunrelated\ncontent\n", patch.parseUnifiedDiff(ud)[0], {});
  console.log("ok:", rej.ok, "| rejects:\n" + patch.apply.formatRejects(rej));

  // 4) Identifier-aware codemod ----------------------------------------------
  h("4. Codemod: rename identifier (strings/comments preserved)");
  const code = 'const total = 1; // total\nconst s = "total"; use(total);\n';
  const cm = patch.codemod.renameIdentifier(code, "total", "sum");
  console.log(cm.text.trimEnd(), "| changes:", cm.changes.length);

  // 5) Transactional multi-file apply ----------------------------------------
  h("5. Transaction: atomic multi-file apply + dry-run preview");
  const fA = path.join(dir, "a.js");
  const fB = path.join(dir, "b.js");
  fs.writeFileSync(fA, "const x = 1;\n");
  fs.writeFileSync(fB, "const y = 2;\n");
  const tx = patch.begin({ cwd: dir });
  tx.stagePatch(fA, patch.createUnifiedDiff("const x = 1;\n", "const x = 10;\n"));
  tx.stageWrite(fB, "const y = 20;\n");
  console.log(patch.preview.renderTransaction(tx.preview()));
  const commit = tx.commit();
  console.log("committed:", commit.ok, "| a.js =>", fs.readFileSync(fA, "utf8").trim());

  // 6) Apply -> verify -> auto-revert ----------------------------------------
  h("6. Apply -> verify -> auto-revert (failing verify rolls back)");
  const fC = path.join(dir, "c.js");
  fs.writeFileSync(fC, "module.exports = 1;\n");
  const tx2 = patch.begin({ cwd: dir });
  tx2.stageWrite(fC, "module.exports = BROKEN;\n");
  const vr = patch.applyVerifyRevert({
    transaction: tx2,
    verify: "node -e \"require('" + fC.replace(/\\/g, "\\\\") + "')\"", // will throw -> fail
    opts: { cwd: dir, onDirty: "snapshot" },
  });
  console.log("verified:", vr.verified, "| reverted:", vr.reverted, "| c.js =>", fs.readFileSync(fC, "utf8").trim());

  h("Demo complete — all operations reversible, nothing left in the repo");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
