"use strict";
// ============================= Microbenchmarks =============================
// Run: node src/perf/bench.js            (all)
//      node src/perf/bench.js scheduler  (one group by name)
//
// These measure the OVERHEAD of the perf primitives themselves — scheduling cost per
// task, cache get/set throughput, parser bytes/sec, metric record cost — NOT the latency
// of real engine/network calls (which these primitives are designed to hide/amortize, not
// replace). Numbers are machine-dependent; treat them as relative, and re-run before/after
// a change to detect regressions. Timing uses process.hrtime.bigint (monotonic ns).

const perf = require("./index");

function nowNs() { return process.hrtime.bigint(); }
function ms(ns) { return Number(ns) / 1e6; }

// Run `fn` for roughly `durationMs`, return { ops, opsPerSec, nsPerOp }.
async function measure(fn, durationMs, batch) {
  batch = batch || 1;
  // warmup
  for (let i = 0; i < 3; i++) await fn();
  let ops = 0;
  const start = nowNs();
  const limit = BigInt(durationMs) * 1000000n;
  for (;;) {
    for (let i = 0; i < batch; i++) await fn();
    ops += batch;
    if (nowNs() - start >= limit) break;
  }
  const elapsed = nowNs() - start;
  const opsPerSec = ops / (Number(elapsed) / 1e9);
  return { ops, opsPerSec, nsPerOp: Number(elapsed) / ops };
}

function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n.toFixed(0); }
function line(name, r, unit) { console.log("  " + name.padEnd(42) + fmt(r.opsPerSec).padStart(10) + " " + (unit || "ops") + "/s   " + r.nsPerOp.toFixed(0).padStart(8) + " ns/op"); }

const groups = {
  async scheduler() {
    console.log("\n[scheduler] task dispatch overhead (concurrency 8, trivial tasks)");
    const sched = perf.createScheduler({ concurrency: 8 });
    const r = await measure(() => sched.submit(() => 1), 800, 200);
    line("submit+run trivial task", r);
    console.log("  peak concurrency reached: " + sched.stats().maxConcurrent);

    console.log("\n[scheduler] mapLimit over 1000 trivial items");
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const t0 = nowNs();
    await perf.mapLimit(items, 16, async (x) => x * 2);
    console.log("  mapLimit(1000, limit=16): " + ms(nowNs() - t0).toFixed(2) + " ms");
  },

  async coalesce() {
    console.log("\n[coalesce] singleFlight dedupe (100 concurrent, same key)");
    let real = 0;
    const sf = perf.singleFlight(async () => { real++; return 1; });
    const t0 = nowNs();
    const rounds = 2000;
    for (let i = 0; i < rounds; i++) { await Promise.all(Array.from({ length: 100 }, () => sf("k"))); }
    const el = ms(nowNs() - t0);
    console.log("  " + (rounds * 100) + " calls in " + el.toFixed(1) + " ms; underlying fn ran " + real + " times (" + (100 * (1 - real / (rounds * 100))).toFixed(1) + "% avoided)");

    console.log("\n[coalesce] batcher coalescing 10k adds");
    let batches = 0;
    const b = perf.createBatcher((keys, its) => { batches++; return its.map((x) => x); }, { maxBatch: 256, maxWait: 0 });
    const t1 = nowNs();
    const ps = []; for (let i = 0; i < 10000; i++) ps.push(b.add(i));
    await Promise.all(ps);
    console.log("  10000 adds → " + batches + " executor calls in " + ms(nowNs() - t1).toFixed(1) + " ms");
  },

  async cache() {
    console.log("\n[cache] LRU get/set throughput");
    const c = perf.createLRU({ max: 10000 });
    for (let i = 0; i < 10000; i++) c.set("k" + i, i);
    let i = 0;
    const rGet = await measure(() => { c.get("k" + (i++ % 10000)); }, 600, 1000);
    line("LRU.get (hit)", rGet);
    let j = 0;
    const rSet = await measure(() => { c.set("x" + (j++ % 20000), j); }, 600, 1000);
    line("LRU.set (with eviction)", rSet);
    console.log("  final hitRate on get bench: " + c.stats().hitRate);

    console.log("\n[cache] memoizeAsync hit vs cold");
    let runs = 0;
    const m = perf.memoizeAsync(async (n) => { runs++; return n * n; }, { max: 1000, ttl: 60000 });
    await m(7);
    const rHit = await measure(() => m(7), 400, 1000);
    line("memoizeAsync (cached hit)", rHit);
    console.log("  underlying fn runs: " + runs + " (1 = all hits cached)");
  },

  async streams() {
    console.log("\n[streams] NDJSON parse throughput");
    const record = JSON.stringify({ type: "token", text: "hello world", idx: 1234 }) + "\n";
    const chunk = record.repeat(100);
    const bytesPerChunk = Buffer.byteLength(chunk);
    let total = 0;
    const p = perf.createNDJSONParser(() => { total++; });
    const r = await measure(() => { p.feed(chunk); }, 600, 100);
    const mbPerSec = (r.opsPerSec * bytesPerChunk) / 1e6;
    console.log("  NDJSON: " + mbPerSec.toFixed(1) + " MB/s   (" + fmt(r.opsPerSec * 100) + " records/s)   parsed " + fmt(total) + " records");

    console.log("\n[streams] SSE parse throughput");
    const ev = "data: " + JSON.stringify({ delta: "x" }) + "\n\n";
    const schunk = ev.repeat(100);
    const sbytes = Buffer.byteLength(schunk);
    let sc = 0;
    const sp = perf.createSSEParser(() => { sc++; });
    const sr = await measure(() => { sp.feed(schunk); }, 600, 100);
    console.log("  SSE:    " + ((sr.opsPerSec * sbytes) / 1e6).toFixed(1) + " MB/s   (" + fmt(sr.opsPerSec * 100) + " events/s)   parsed " + fmt(sc) + " events");
  },

  async metrics() {
    console.log("\n[metrics] record overhead");
    const m = perf.createMetrics();
    const rInc = await measure(() => { m.inc("c"); }, 400, 5000);
    line("counter inc", rInc);
    const rObs = await measure(() => { m.observe("t", Math.random() * 100); }, 400, 5000);
    line("histogram observe", rObs);

    console.log("\n[metrics] span recorder overhead");
    const rec = perf.createSpanRecorder();
    const rSpan = await measure(() => { const s = rec.span("x"); s.end(); }, 400, 2000);
    line("span start+end", rSpan);
    rec.clear();
  },
};

async function main() {
  const which = process.argv[2];
  console.log("Nexus perf microbenchmarks — node " + process.version + " on " + process.platform + "/" + process.arch);
  console.log("(overhead of the primitives, not real engine latency)");
  const names = which ? [which] : Object.keys(groups);
  for (const name of names) {
    if (!groups[name]) { console.error("unknown group: " + name + " (have: " + Object.keys(groups).join(", ") + ")"); process.exitCode = 1; continue; }
    await groups[name]();
  }
  console.log("");
}

if (require.main === module) main();
module.exports = { measure, groups };
