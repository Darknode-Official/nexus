"use strict";
// ============================= Streaming parsers =============================
// Incremental parsers for the two wire formats Nexus consumes from streaming engines:
// Server-Sent Events (SSE, used by OpenAI/Anthropic/Gemini streaming endpoints) and
// newline-delimited JSON (NDJSON / JSON Lines, used by Ollama and Claude Code's driver).
// Both are feed-driven: push raw chunks (strings or Buffers, split anywhere — mid-line,
// mid-multibyte-char) and get back fully-formed events the moment they complete. Nothing
// is buffered beyond the current partial line/record, so a megabyte-long stream costs
// a line of memory, not a megabyte — essential for not blowing up on long generations.
//
// Design: a parser holds a small string buffer of the unterminated tail. feed() appends,
// extracts every complete unit, and invokes the callback per unit; the tail carries over
// to the next feed(). end() flushes any trailing unit that had no final newline.

const { StringDecoder } = require("string_decoder");

/**
 * createNDJSONParser(onRecord, options)
 *   onRecord(obj, raw)   called per parsed JSON object (raw = the source line)
 *   options.onError(err, line)  called for a line that isn't valid JSON (default: skip it)
 *   options.skipBlank    ignore blank lines (default true)
 * Returns { feed(chunk), end(), count() }. Handles \n and \r\n, and chunk boundaries
 * that fall inside a multi-byte UTF-8 character (via StringDecoder).
 */
function createNDJSONParser(onRecord, options) {
  const o = options || {};
  const onError = o.onError;
  const skipBlank = o.skipBlank !== false;
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let count = 0;

  function handleLine(line) {
    const s = line.replace(/\r$/, "");
    if (skipBlank && s.trim() === "") return;
    let obj;
    try { obj = JSON.parse(s); } catch (e) { if (onError) onError(e, s); return; }
    count++;
    onRecord(obj, s);
  }

  function feed(chunk) {
    buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  }

  function end() {
    buf += decoder.end();
    if (buf.length) { handleLine(buf); buf = ""; }
  }

  return { feed, end, count: () => count };
}

/**
 * createSSEParser(onEvent, options)
 *   onEvent({ event, data, id, retry })  called per complete SSE event (blank-line delimited).
 *       `data` is the joined data: lines (multi-line data: fields joined with "\n").
 *   options.onData(dataString)   convenience shortcut called with just the data payload.
 * Returns { feed(chunk), end(), count() }. Implements the WHATWG SSE line/field rules:
 * field "name: value" (one optional leading space stripped), lines starting ":" are
 * comments, a blank line dispatches the accumulated event. Robust to split chunks and
 * \n, \r\n, or lone \r line terminators.
 */
function createSSEParser(onEvent, options) {
  const o = options || {};
  const onData = o.onData;
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let count = 0;
  let evType = "", dataLines = [], lastId, retry;

  function dispatch() {
    if (dataLines.length === 0 && evType === "") { return; } // nothing accumulated
    const data = dataLines.join("\n");
    // Per spec, an event with only a type but no data is still dispatched; but the common
    // case (and all engine streams) always carries data. We dispatch whenever anything set.
    const ev = { event: evType || "message", data, id: lastId, retry };
    count++;
    if (onEvent) onEvent(ev);
    if (onData) onData(data);
    evType = ""; dataLines = []; retry = undefined;
  }

  function handleLine(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") { dispatch(); return; }      // blank line → dispatch
    if (line[0] === ":") return;                  // comment
    let field, value;
    const colon = line.indexOf(":");
    if (colon === -1) { field = line; value = ""; }
    else { field = line.slice(0, colon); value = line.slice(colon + 1); if (value[0] === " ") value = value.slice(1); }
    switch (field) {
      case "event": evType = value; break;
      case "data": dataLines.push(value); break;
      case "id": lastId = value; break;
      case "retry": { const n = parseInt(value, 10); if (Number.isFinite(n)) retry = n; break; }
      default: break; // unknown field ignored per spec
    }
  }

  function splitFeed(text) {
    buf += text;
    // Normalize lone \r as a line break too: scan for \n or \r (not part of \r\n handled below).
    let idx;
    while ((idx = indexOfLineBreak(buf)) !== -1) {
      const brk = buf[idx];
      let end = idx + 1;
      if (brk === "\r" && buf[idx + 1] === "\n") end = idx + 2; // consume \r\n as one
      const line = buf.slice(0, idx);
      // but if we don't yet have the char after a trailing \r, wait for more data
      if (brk === "\r" && idx === buf.length - 1) break;
      buf = buf.slice(end);
      handleLine(line);
    }
  }

  function feed(chunk) { splitFeed(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)); }

  function end() {
    buf += decoder.end();
    if (buf.length) { handleLine(buf); buf = ""; }
    dispatch(); // flush a final event missing its terminating blank line
  }

  return { feed, end, count: () => count };
}

// First index of \n or \r in s, or -1.
function indexOfLineBreak(s) {
  const n = s.indexOf("\n"), r = s.indexOf("\r");
  if (n === -1) return r;
  if (r === -1) return n;
  return Math.min(n, r);
}

/**
 * sseDataEvents(onData, options) — common shortcut: SSE stream where each event's data is
 * JSON (or the sentinel "[DONE]"). Parses data as JSON and calls onData(obj); the "[DONE]"
 * sentinel calls options.onDone() instead. onParseError(err, raw) optional.
 */
function sseDataEvents(onData, options) {
  const o = options || {};
  return createSSEParser(null, {
    onData(data) {
      const s = data.trim();
      if (s === "" ) return;
      if (s === "[DONE]") { if (o.onDone) o.onDone(); return; }
      let obj; try { obj = JSON.parse(s); } catch (e) { if (o.onParseError) o.onParseError(e, s); return; }
      onData(obj);
    },
  });
}

/**
 * streamToParser(readable, parser) — pump a Node Readable (e.g. an http response) through a
 * parser created above. Resolves with parser.count() when the stream ends, rejects on error.
 */
function streamToParser(readable, parser) {
  return new Promise((resolve, reject) => {
    readable.on("data", (c) => { try { parser.feed(c); } catch (e) { reject(e); } });
    readable.on("end", () => { try { parser.end(); resolve(parser.count()); } catch (e) { reject(e); } });
    readable.on("error", reject);
  });
}

module.exports = { createNDJSONParser, createSSEParser, sseDataEvents, streamToParser };
