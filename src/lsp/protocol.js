"use strict";
// ============================= LSP protocol helpers =============================
// Constants, enum name maps, URI<->path conversion, and result NORMALIZERS that
// turn the Language Server Protocol's many shapes into one plain, predictable
// vocabulary the rest of Nexus can consume without caring which server produced
// it. Also the incremental-sync edit computation: given old and new document
// text, produce the minimal single-range TextDocumentContentChangeEvent so we
// send diffs, not whole files, to servers that advertise incremental sync.
//
// Everything here is pure (no I/O) and therefore trivially unit-testable.
// Zero third-party dependencies — Node stdlib only.

const { pathToFileURL, fileURLToPath } = require("node:url");

// LSP enum: TextDocumentSyncKind
const TextDocumentSyncKind = { None: 0, Full: 1, Incremental: 2 };

// LSP enum: DiagnosticSeverity (name map for readable output)
const DiagnosticSeverity = { 1: "error", 2: "warning", 3: "information", 4: "hint" };

// LSP enum: SymbolKind -> readable name
const SymbolKind = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
  12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null",
  22: "enumMember", 23: "struct", 24: "event", 25: "operator", 26: "typeParameter",
};

// LSP enum: CompletionItemKind -> readable name
const CompletionItemKind = {
  1: "text", 2: "method", 3: "function", 4: "constructor", 5: "field", 6: "variable",
  7: "class", 8: "interface", 9: "module", 10: "property", 11: "unit", 12: "value",
  13: "enum", 14: "keyword", 15: "snippet", 16: "color", 17: "file", 18: "reference",
  19: "folder", 20: "enumMember", 21: "constant", 22: "struct", 23: "event",
  24: "operator", 25: "typeParameter",
};

// LSP enum: CompletionTriggerKind
const CompletionTriggerKind = { Invoked: 1, TriggerCharacter: 2, TriggerForIncompleteCompletions: 3 };

/**
 * Convert a filesystem path to a file:// URI the way language servers expect.
 * @param {string} filePath
 * @returns {string}
 */
function pathToUri(filePath) {
  return pathToFileURL(filePath).href;
}

/**
 * Convert a file:// URI back to a filesystem path. Non-file URIs are returned
 * unchanged so callers can still display them.
 * @param {string} uri
 * @returns {string}
 */
function uriToPath(uri) {
  if (typeof uri !== "string") return uri;
  if (!uri.startsWith("file:")) return uri;
  try { return fileURLToPath(uri); } catch (_) { return uri; }
}

/** @param {number} line @param {number} character @returns {{line:number,character:number}} */
function position(line, character) {
  return { line, character };
}

/** @returns {{start:object,end:object}} */
function range(startLine, startChar, endLine, endChar) {
  return { start: position(startLine, startChar), end: position(endLine, endChar) };
}

/**
 * Normalize a Location | LocationLink into { uri, path, range }.
 * @param {object} loc
 * @returns {object|null}
 */
function normalizeLocation(loc) {
  if (!loc) return null;
  // LocationLink uses targetUri/targetRange; Location uses uri/range.
  const uri = loc.uri || loc.targetUri;
  const r = loc.range || loc.targetSelectionRange || loc.targetRange;
  if (!uri) return null;
  return { uri, path: uriToPath(uri), range: r || null };
}

/**
 * Definition/references responses may be a single Location, an array, or
 * LocationLinks. Always return an array of normalized locations.
 * @param {object|Array} result
 * @returns {Array<object>}
 */
function normalizeLocations(result) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map(normalizeLocation).filter(Boolean);
}

/**
 * Normalize a Hover result into { contents:string, range }.
 * @param {object} hover
 * @returns {object|null}
 */
function normalizeHover(hover) {
  if (!hover || hover.contents == null) return null;
  return { contents: markupToText(hover.contents), range: hover.range || null };
}

/** Flatten MarkupContent | MarkedString | array thereof into plain text. */
function markupToText(contents) {
  if (contents == null) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markupToText).filter(Boolean).join("\n\n");
  if (typeof contents === "object") {
    if (typeof contents.value === "string") return contents.value; // MarkupContent / {language,value}
  }
  return String(contents);
}

/**
 * Normalize one diagnostic into { severity, message, range, code, source }.
 * @param {object} d
 * @returns {object}
 */
function normalizeDiagnostic(d) {
  return {
    severity: DiagnosticSeverity[d.severity] || "information",
    severityCode: d.severity || 3,
    message: d.message || "",
    range: d.range || null,
    line: d.range && d.range.start ? d.range.start.line : null,
    column: d.range && d.range.start ? d.range.start.character : null,
    code: d.code != null ? d.code : null,
    source: d.source || null,
  };
}

/**
 * Normalize documentSymbol results. Servers return either a hierarchical
 * DocumentSymbol[] (with children + selectionRange) or a flat
 * SymbolInformation[] (with location). Produce a uniform nested shape.
 * @param {Array} result
 * @returns {Array<object>}
 */
function normalizeSymbols(result) {
  if (!Array.isArray(result)) return [];
  return result.map((s) => {
    if (s.location) {
      // SymbolInformation (flat)
      return {
        name: s.name,
        kind: SymbolKind[s.kind] || "unknown",
        kindCode: s.kind,
        range: s.location.range || null,
        uri: s.location.uri,
        path: uriToPath(s.location.uri),
        containerName: s.containerName || null,
        children: [],
      };
    }
    // DocumentSymbol (hierarchical)
    return {
      name: s.name,
      detail: s.detail || null,
      kind: SymbolKind[s.kind] || "unknown",
      kindCode: s.kind,
      range: s.range || null,
      selectionRange: s.selectionRange || null,
      children: normalizeSymbols(s.children || []),
    };
  });
}

/**
 * Normalize a CompletionItem[] | CompletionList into a flat array.
 * @param {object|Array} result
 * @returns {{ isIncomplete:boolean, items:Array<object> }}
 */
function normalizeCompletion(result) {
  if (!result) return { isIncomplete: false, items: [] };
  const list = Array.isArray(result) ? { isIncomplete: false, items: result } : result;
  const items = (list.items || []).map((i) => ({
    label: i.label,
    kind: CompletionItemKind[i.kind] || null,
    detail: i.detail || null,
    insertText: i.insertText || (i.textEdit && i.textEdit.newText) || i.label,
    documentation: markupToText(i.documentation) || null,
    sortText: i.sortText || null,
    deprecated: !!i.deprecated || (Array.isArray(i.tags) && i.tags.includes(1)),
  }));
  return { isIncomplete: !!list.isIncomplete, items };
}

/**
 * Normalize a WorkspaceEdit (rename / codeAction) into a per-file edit list:
 * [{ path, uri, edits:[{range,newText}] }]. Handles both `changes` (map) and
 * `documentChanges` (array of TextDocumentEdit) forms.
 * @param {object} edit
 * @returns {Array<object>}
 */
function normalizeWorkspaceEdit(edit) {
  if (!edit) return [];
  const out = [];
  if (edit.changes && typeof edit.changes === "object") {
    for (const uri of Object.keys(edit.changes)) {
      out.push({ uri, path: uriToPath(uri), edits: edit.changes[uri] || [] });
    }
  }
  if (Array.isArray(edit.documentChanges)) {
    for (const dc of edit.documentChanges) {
      if (dc.textDocument && Array.isArray(dc.edits)) {
        out.push({ uri: dc.textDocument.uri, path: uriToPath(dc.textDocument.uri), edits: dc.edits });
      }
      // create/rename/delete file operations are passed through for visibility.
      else if (dc.kind) {
        out.push({ fileOperation: dc.kind, uri: dc.uri || dc.newUri || null, oldUri: dc.oldUri || null });
      }
    }
  }
  return out;
}

// ---------- incremental document sync ----------

/**
 * Split text into lines keeping offsets consistent with LSP positions.
 * LSP counts lines by \n, and character by UTF-16 code units; for the common
 * ASCII/BMP case code-unit count equals .length, which we use.
 */
function offsetToPosition(text, offset) {
  let line = 0;
  let last = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      last = i + 1;
    }
  }
  return { line, character: offset - last };
}

/**
 * Compute the minimal single-range change between oldText and newText as an
 * incremental TextDocumentContentChangeEvent. Finds the common prefix and
 * suffix, then the replaced middle becomes one { range, text } edit. This is
 * exactly what editors send for incremental sync and keeps payloads small.
 * @param {string} oldText
 * @param {string} newText
 * @returns {{range:object,text:string}|null} null when identical
 */
function computeIncrementalChange(oldText, newText) {
  if (oldText === newText) return null;
  const oldLen = oldText.length;
  const newLen = newText.length;
  let start = 0;
  const maxStart = Math.min(oldLen, newLen);
  while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  // common suffix, not overlapping the common prefix
  let oldEnd = oldLen;
  let newEnd = newLen;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  const startPos = offsetToPosition(oldText, start);
  const endPos = offsetToPosition(oldText, oldEnd);
  return { range: { start: startPos, end: endPos }, text: newText.slice(start, newEnd) };
}

module.exports = {
  TextDocumentSyncKind,
  DiagnosticSeverity,
  SymbolKind,
  CompletionItemKind,
  CompletionTriggerKind,
  pathToUri,
  uriToPath,
  position,
  range,
  markupToText,
  normalizeLocation,
  normalizeLocations,
  normalizeHover,
  normalizeDiagnostic,
  normalizeSymbols,
  normalizeCompletion,
  normalizeWorkspaceEdit,
  offsetToPosition,
  computeIncrementalChange,
};
