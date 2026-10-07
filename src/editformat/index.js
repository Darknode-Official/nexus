"use strict";
// ================= Nexus edit-format protocol layer — public entrypoint =================
// The glue between "model text output" and "files changed on disk". Nexus asks a
// model to edit code; the model answers with messy, free-form text containing one
// or more edits in one of several formats. This subsystem PARSES that text,
// VALIDATES and SELF-REPAIRS the edits against the real files, and DELEGATES the
// actual mutation to src/patch (atomic, reversible, verifiable).
//
//   detect        — auto-detect format(s) and extract every edit from a message
//   search-replace— the fenced <<<<<<< SEARCH / ======= / >>>>>>> REPLACE format
//   unified-diff  — tolerant parser for the sloppy diffs models emit
//   whole-file    — "here is the full new file" responses + filename inference
//   locate        — find a SEARCH block (exact -> whitespace repair -> fuzzy)
//   validate      — resolve edits against files, self-repair, or diagnose
//   apply         — stage validated edits as ONE atomic src/patch transaction
//   render        — the inverse: emit canonical edit blocks from a set of changes
//
// Safety contract:
//   * No silent guesses. Whitespace/indent/line-ending drift is auto-repaired;
//     content-level fuzzy matching is opt-in and must be strong AND unambiguous.
//   * All-or-nothing. If any edit cannot be placed, NOTHING is written and a
//     structured diagnosis is returned to drive a model-retry loop.
//   * Reversible + verifiable via the src/patch transaction / verify engine.
//
// Zero third-party dependencies — Node.js stdlib + src/patch only.

const detect = require("./detect");
const searchReplace = require("./search-replace");
const unifiedDiff = require("./unified-diff");
const wholeFile = require("./whole-file");
const locate = require("./locate");
const validate = require("./validate");
const apply = require("./apply");
const render = require("./render");
const text = require("./text");

/**
 * One-shot: take raw model output and apply the edits it contains, atomically.
 * @param {string} modelOutput - the model's full message (prose allowed)
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string} [opts.defaultPath] - fallback path for single-file contexts
 * @param {boolean} [opts.allowFuzzy=false] - permit content-fuzzy SEARCH matching
 * @param {boolean} [opts.dryRun=false] - preview only
 * @param {number} [opts.fuzz=2]
 * @param {Object<string,string|null>} [opts.files] - in-memory file map (tests/dry runs)
 * @returns {object} result of {@link apply.applyEdits} plus the detection summary
 */
function applyModelOutput(modelOutput, opts) {
  opts = opts || {};
  const det = detect.detect(modelOutput, { defaultPath: opts.defaultPath });
  if (det.edits.length === 0) {
    return {
      ok: false,
      phase: "detect",
      detection: det,
      diagnoses: [{ path: null, line: 0, reason: "no-edits", message: "no edit blocks found in model output" }],
    };
  }
  const result = apply.applyEdits(det.edits, {
    cwd: opts.cwd,
    files: opts.files,
    allowFuzzy: opts.allowFuzzy,
    dryRun: opts.dryRun,
    fuzz: opts.fuzz,
  });
  result.detection = det;
  // Surface any parse-level errors alongside validation diagnoses.
  if (det.errors.length) {
    result.parseErrors = det.errors;
  }
  return result;
}

/**
 * Parse model output into normalized edits without touching disk.
 * @param {string} modelOutput
 * @param {object} [opts] - { defaultPath, wholeFile }
 * @returns {{edits: Array, errors: Array, formats: string[]}}
 */
function parseEdits(modelOutput, opts) {
  return detect.detect(modelOutput, opts);
}

module.exports = {
  // submodules
  detect,
  searchReplace,
  unifiedDiff,
  wholeFile,
  locate,
  validate,
  apply,
  render,
  text,
  // flattened conveniences
  parseEdits,
  applyModelOutput,
  detectFormats: detect.classify,
  validateEdits: validate.validate,
  applyEdits: apply.applyEdits,
  applyEditsVerified: apply.applyEditsVerified,
  render: render.render,
  locate: locate.locate,
};
