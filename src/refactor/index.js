"use strict";
// ============================= Refactor — Automated refactoring library =============================
// Safe, reversible, cross-file code transformations for working on EXISTING codebases.
// Built on two wave-1 Nexus subsystems:
//   • codegraph — symbol table, cross-file bindings, scope-aware tokenizer/block scanner
//   • patch     — transactional multi-file apply with checkpoint rollback + verify harness
//
// Five refactorings, each with a dry-run preview (unified diff), an explicit safety
// check (refuses with reasons when it cannot act safely), atomic application, and an
// optional apply -> verify(tests) -> auto-revert wrapper. No silent partial changes.
//
//   rename          — scope-aware rename of a symbol across every file that uses it
//   extract         — pull a statement range into a new function (params + returns)
//   inlineVariable  — replace a variable with its initializer and delete the decl
//   inlineFunction  — replace calls to a simple function with its body
//   move            — relocate a declaration to another module, fixing imports/exports
//   organizeImports — remove unused, add missing, sort/group imports deterministically
//
// Language coverage: JavaScript / TypeScript. Other languages are refused honestly.
// Zero third-party dependencies — Node.js stdlib only. See README.md for the full API,
// honest language-coverage notes and safety limits.
//
// Quick start:
//   const refactor = require("./src/refactor");
//   const r = refactor.fromDir(process.cwd());
//   const p = r.rename({ oldName: "readCfg", newName: "readConfig" });
//   console.log(r.preview(p).files.map(f => f.diff).join("\n"));   // dry run
//   if (p.ok) r.apply(p);                                          // atomic apply
//   r.applyVerify(p, "npm test");                                  // apply+verify+revert

const fs = require("fs");
const path = require("path");
const { planRename } = require("./rename");
const { planExtract } = require("./extract");
const { planInlineVariable, planInlineFunction } = require("./inline");
const { planMove } = require("./move");
const { planOrganizeImports } = require("./imports");
const planMod = require("./plan");
const { supported } = require("../codegraph/parse");
const { normalize } = require("../codegraph/depgraph");

const SKIP = /(^|\/)(\.git|node_modules|\.nexus|dist|build|\.cache|\.next|out|coverage|target|__pycache__|vendor|\.venv|venv)(\/|$)/;

/** Walk a directory collecting supported {file(relative), source} records. */
function loadProject(root, opts) {
  opts = opts || {};
  const maxBytes = opts.maxBytes || 2000000;
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (SKIP.test(fp.replace(/\\/g, "/"))) continue;
      if (e.isDirectory()) walk(fp);
      else if (supported(e.name)) {
        let st; try { st = fs.statSync(fp); } catch (_) { continue; }
        if (st.size > maxBytes) continue;
        let src; try { src = fs.readFileSync(fp, "utf8"); } catch (_) { continue; }
        out.push({ file: normalize(path.relative(root, fp)), source: src });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * A refactoring session over a set of files. `files` is an array of
 * { file, source }; paths are treated relative to `cwd` for application.
 */
class Refactorer {
  /** @param {object} [opts] - { files, cwd } */
  constructor(opts) {
    opts = opts || {};
    this.cwd = opts.cwd || process.cwd();
    this.files = opts.files || [];
  }

  /** Create a session by reading a directory from disk. */
  static fromDir(root, opts) {
    return new Refactorer({ cwd: root, files: loadProject(root, opts) });
  }

  /** Replace/refresh the in-memory source for one file. */
  setFile(file, source) {
    const nf = normalize(file);
    const existing = this.files.find((f) => normalize(f.file) === nf);
    if (existing) existing.source = source;
    else this.files.push({ file: nf, source });
    return this;
  }

  // ---- refactorings: each returns a RefactorPlan ----

  /** Scope-aware cross-file rename. args: { oldName, newName, file?, line?, force? } */
  rename(args) { return planRename(Object.assign({ files: this.files }, args)); }

  /** Extract a statement range into a function. args: { file, startLine, endLine, newName } */
  extract(args) {
    const src = this._src(args.file);
    return planExtract(Object.assign({}, args, { source: src }));
  }

  /** Inline a variable. args: { file, name, force? } */
  inlineVariable(args) {
    const src = this._src(args.file);
    return planInlineVariable(Object.assign({}, args, { source: src }));
  }

  /** Inline a simple function. args: { file, name } */
  inlineFunction(args) {
    const src = this._src(args.file);
    return planInlineFunction(Object.assign({}, args, { source: src }));
  }

  /** Move a top-level declaration to another module. args: { fromFile, name, toFile } */
  move(args) { return planMove(Object.assign({ files: this.files }, args)); }

  /** Organize imports in one file. args: { file, opts? } */
  organizeImports(args) {
    const src = this._src(args.file);
    return planOrganizeImports(Object.assign({}, args, { source: src, files: this.files }));
  }

  // ---- apply modes (delegate to plan.js, bound to this.cwd) ----

  /** Unified-diff preview of a plan (writes nothing). */
  preview(plan) { return planMod.preview(plan, { cwd: this.cwd }); }

  /** Atomically apply a plan. opts: { dryRun } */
  apply(plan, opts) { return planMod.apply(plan, Object.assign({ cwd: this.cwd }, opts)); }

  /** Apply -> verify -> auto-revert. verifier: shell command or () => boolean. */
  applyVerify(plan, verifier, opts) { return planMod.applyVerify(plan, verifier, Object.assign({ cwd: this.cwd }, opts)); }

  _src(file) {
    const nf = normalize(file);
    const f = this.files.find((x) => normalize(x.file) === nf);
    if (!f) throw new Error("file not in session: " + file);
    return f.source;
  }
}

module.exports = {
  Refactorer,
  fromDir: Refactorer.fromDir,
  loadProject,
  // raw planners (pure; no disk)
  planRename, planExtract, planInlineVariable, planInlineFunction, planMove, planOrganizeImports,
  // apply helpers
  preview: planMod.preview,
  apply: planMod.apply,
  applyVerify: planMod.applyVerify,
  plan: planMod,
};
