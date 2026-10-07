"use strict";
// ============================= LSP framing — Content-Length codec =============================
// The base protocol of the Language Server Protocol (and JSON-RPC over stdio in
// general) frames every message with an HTTP-like header block terminated by a
// blank line, then exactly Content-Length BYTES of UTF-8 JSON payload:
//
//   Content-Length: 123\r\n
//   Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n   (optional)
//   \r\n
//   {"jsonrpc":"2.0", ...}
//
// This module is the pure, side-effect-free codec for that frame. The encoder
// turns a JS value into a framed Buffer; the `MessageReader` is a streaming
// decoder that tolerates ARBITRARY chunk boundaries — a header split mid-field,
// several messages glued into one chunk, a body that arrives one byte at a time.
// Transports feed it raw chunks and drain whole JSON values; it never blocks and
// never loses bytes across calls.
//
// Zero third-party dependencies — Node stdlib only.

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n", "ascii");
const CONTENT_LENGTH_RE = /^Content-Length:\s*(\d+)\s*$/i;

/**
 * Encode a JSON-RPC message object into a framed Buffer ready for a stream.
 * Content-Length is the UTF-8 BYTE length of the payload, not its char count.
 * @param {object} message - any JSON-serializable value
 * @returns {Buffer}
 */
function encodeMessage(message) {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, "utf8");
  const header = Buffer.from("Content-Length: " + payload.length + "\r\n\r\n", "ascii");
  return Buffer.concat([header, payload], header.length + payload.length);
}

/**
 * Parse a single header block (the text before the blank line) into a map.
 * Unknown headers are preserved; the only one the base protocol requires is
 * Content-Length. Throws on a malformed / missing Content-Length so the caller
 * can surface a clear framing error instead of silently desyncing the stream.
 * @param {string} text - header block without the trailing blank line
 * @returns {{ contentLength: number, headers: Object<string,string> }}
 */
function parseHeaders(text) {
  const headers = {};
  let contentLength = -1;
  const lines = text.split("\r\n");
  for (const line of lines) {
    if (line === "") continue;
    const m = CONTENT_LENGTH_RE.exec(line);
    if (m) {
      contentLength = parseInt(m[1], 10);
    }
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  if (contentLength < 0 || Number.isNaN(contentLength)) {
    throw new Error("LSP framing: missing or invalid Content-Length header");
  }
  return { contentLength, headers };
}

/**
 * Streaming decoder for Content-Length framed JSON-RPC.
 *
 * Usage:
 *   const reader = new MessageReader();
 *   const { messages, errors } = reader.append(chunk);
 *
 * `append` accepts any Buffer (or string) slice of the stream and returns every
 * COMPLETE message now available plus any framing/parse errors encountered. State
 * carries across calls, so splitting a frame across any number of chunks works.
 */
class MessageReader {
  constructor() {
    /** @type {Buffer} bytes seen but not yet consumed into a message */
    this.buffer = Buffer.alloc(0);
    /** @type {number} pending body length once a header block is parsed, else -1 */
    this.contentLength = -1;
    /** @type {Object<string,string>|null} headers for the pending body */
    this.headers = null;
  }

  /**
   * Feed a chunk and drain all complete messages.
   * @param {Buffer|string} chunk
   * @returns {{ messages: Array<object>, errors: Array<Error> }}
   */
  append(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this.buffer = this.buffer.length === 0 ? buf : Buffer.concat([this.buffer, buf]);
    return this._drain();
  }

  /** @returns {number} bytes buffered but not yet emitted (for diagnostics/tests) */
  pendingBytes() {
    return this.buffer.length;
  }

  _drain() {
    const messages = [];
    const errors = [];
    // Loop until we cannot complete either a header block or a body.
    for (;;) {
      if (this.contentLength < 0) {
        const sep = this.buffer.indexOf(HEADER_TERMINATOR);
        if (sep < 0) break; // header not fully arrived yet
        const headerText = this.buffer.slice(0, sep).toString("ascii");
        this.buffer = this.buffer.slice(sep + HEADER_TERMINATOR.length);
        try {
          const parsed = parseHeaders(headerText);
          this.contentLength = parsed.contentLength;
          this.headers = parsed.headers;
        } catch (err) {
          errors.push(err);
          // Resync: drop the bad header and keep scanning; the stream may recover.
          this.contentLength = -1;
          this.headers = null;
          continue;
        }
      }
      if (this.buffer.length < this.contentLength) break; // body incomplete
      const body = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;
      this.headers = null;
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch (err) {
        errors.push(new Error("LSP framing: invalid JSON payload: " + err.message));
      }
    }
    return { messages, errors };
  }
}

module.exports = { encodeMessage, parseHeaders, MessageReader, HEADER_TERMINATOR };
