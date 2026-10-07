"use strict";
// ============================================================================
// Motion and spinners (UI-007).
// One spinner vocabulary, ~100ms/frame, animation only where it signals real
// activity. Respects reduced-motion and NO_COLOR (static indicator + a changing
// elapsed-time count) and never animates when not a TTY. The redraw strategy
// keeps scrollback clean: a transient region is repainted in place with cursor
// control; durable content is appended. Scrollback is a transcript, not frames.
// ============================================================================

const themeMod = require("./theme");
const symbolsMod = require("./symbols");

class Spinner {
  // opts: { label, stream, intervalMs, theme }
  constructor(opts = {}) {
    this.theme = opts.theme || themeMod.get();
    this.s = symbolsMod.make(this.theme.unicode);
    this.stream = opts.stream || process.stdout;
    this.label = opts.label || "working";
    this.intervalMs = opts.intervalMs || 100; // 80-120ms band (UI-007)
    this.frames = this.s.spinnerFrames;
    this.frame = 0;
    this.startedAt = 0;
    this.timer = null;
    // Animate only on a real TTY with motion allowed; otherwise degrade.
    this.animated = !!(this.stream && this.stream.isTTY) && this.theme.motion !== false;
    this.lastStaticSecond = -1;
  }

  // The single-line frame string (no cursor control) — used for snapshots.
  frameText(elapsedSec) {
    const t = this.theme;
    if (this.animated) {
      const glyph = t.paint(this.frames[this.frame % this.frames.length], "semantic.accent", { bold: true });
      return glyph + " " + t.paint(this.label, "text.primary") + "  " + t.paint(elapsedSec.toFixed(0) + "s", "role.system");
    }
    // Reduced-motion / non-TTY: a static indicator with a changing elapsed count.
    const glyph = t.paint(this.s.spinnerStatic, "semantic.accent", { bold: true });
    return glyph + " " + t.paint(this.label, "text.primary") + "  " + t.paint(elapsedSec.toFixed(0) + "s", "role.system");
  }

  start(label) {
    if (label) this.label = label;
    this.startedAt = Date.now();
    if (!this.animated) {
      // Non-TTY: one durable line, then periodic elapsed updates on their own
      // lines so a piped transcript stays readable (no frame flooding).
      this.stream.write(this.frameText(0) + "\n");
      if (this.theme.motion === false && this.stream && this.stream.isTTY) return this;
      return this;
    }
    this.stream.write(this.theme.control.hideCursor);
    this.render();
    this.timer = setInterval(() => { this.frame++; this.render(); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  render() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    if (!this.animated) return;
    // Transient region: carriage-return + clear-line, repaint in place.
    this.stream.write("\r" + this.theme.control.clearLine + this.frameText(elapsed));
  }

  // Replace the transient spinner with a durable final line (append to transcript).
  stop(finalLine) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.animated) {
      this.stream.write("\r" + this.theme.control.clearLine);
      this.stream.write(this.theme.control.showCursor);
    }
    if (finalLine) this.stream.write(finalLine + "\n");
    return this;
  }

  succeed(msg) { const t = this.theme; return this.stop(t.paint(this.s.ok, "semantic.success", { bold: true }) + " " + t.paint(msg || this.label, "text.primary")); }
  fail(msg) { const t = this.theme; return this.stop(t.paint(this.s.fail, "semantic.error", { bold: true }) + " " + t.paint(msg || this.label, "text.primary")); }
}

function create(opts) { return new Spinner(opts); }

module.exports = { Spinner, create };
