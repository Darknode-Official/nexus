"use strict";
// ============================= Request batching & coalescing =============================
// Cut redundant engine/tool work by never doing the same thing twice at once:
//   • singleFlight  — de-duplicate concurrent calls that share a key: the first call runs,
//                     every caller awaiting the same key in-flight shares its one promise.
//                     The slot is freed as soon as it settles (next call re-runs), so no
//                     stale results — this is coalescing, not caching.
//   • createBatcher — collect individual calls that arrive close together and hand them to
//                     one batched executor (e.g. one HTTP round-trip for N lookups), then
//                     fan the array of results back out to each caller by index.
//   • debounce / throttle — classic rate limiters for noisy triggers (file watchers,
//                     keystrokes), with cancel/flush and trailing/leading control.
// All stdlib-only, all cancellable where it makes sense.

/**
 * singleFlight(fn, keyFn?) — wrap an async fn so concurrent calls with the same key share
 * one execution. keyFn(args...) derives the key (default: first arg stringified).
 * Returns the wrapped fn with extras: .inflight() count, .has(key), .forget(key).
 */
function singleFlight(fn, keyFn) {
  const inflight = new Map();
  const key = keyFn || ((...a) => (a.length <= 1 ? String(a[0]) : JSON.stringify(a)));
  const wrapped = function (...args) {
    const k = key(...args);
    const existing = inflight.get(k);
    if (existing) return existing.promise;
    let rec;
    const promise = new Promise((resolve, reject) => { rec = { resolve, reject }; });
    rec.promise = promise;
    inflight.set(k, rec);
    // Run after registering so synchronous throws still coalesce.
    Promise.resolve().then(() => fn(...args)).then(
      (v) => { inflight.delete(k); rec.resolve(v); },
      (e) => { inflight.delete(k); rec.reject(e); }
    );
    return promise;
  };
  wrapped.inflight = () => inflight.size;
  wrapped.has = (k) => inflight.has(k);
  wrapped.forget = (k) => inflight.delete(k);
  return wrapped;
}

/**
 * createBatcher(executor, options) — coalesce many single calls into grouped executor runs.
 *   executor(keys[], items[]) => Promise<results[]>   // results aligned to keys[] by index
 *   options.maxBatch   flush when this many are queued (default 50)
 *   options.maxWait    flush at most this long after the first queued item, ms (default 10)
 *   options.keyFn      derive a de-dupe key from an item (default JSON.stringify); items
 *                      sharing a key run once and all their callers get that one result.
 * Returns add(item) => Promise<result>, plus .flush(), .size(), .pending().
 */
function createBatcher(executor, options) {
  const o = options || {};
  const maxBatch = Math.max(1, o.maxBatch | 0 || 50);
  const maxWait = Math.max(0, o.maxWait | 0 || 10);
  const keyFn = o.keyFn || ((x) => JSON.stringify(x));

  let batch = [];              // { key, item }
  let waiters = new Map();     // key -> [{resolve,reject}]
  let timer = null;

  function schedule() {
    if (batch.length >= maxBatch) { flush(); return; } // size trigger wins even if a timer is pending
    if (timer || batch.length === 0) return;
    timer = setTimeout(flush, maxWait);
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!batch.length) return Promise.resolve();
    const current = batch; batch = [];
    const currentWaiters = waiters; waiters = new Map();
    const keys = current.map((b) => b.key);
    const items = current.map((b) => b.item);
    return Promise.resolve()
      .then(() => executor(keys, items))
      .then((results) => {
        if (!Array.isArray(results) || results.length !== keys.length) {
          throw new Error("Batch executor must return an array aligned to keys (got " + (Array.isArray(results) ? results.length : typeof results) + " for " + keys.length + ")");
        }
        for (let i = 0; i < keys.length; i++) {
          const ws = currentWaiters.get(keys[i]); if (!ws) continue;
          for (const w of ws) w.resolve(results[i]);
        }
      })
      .catch((err) => { for (const ws of currentWaiters.values()) for (const w of ws) w.reject(err); });
  }

  function add(item) {
    const k = keyFn(item);
    return new Promise((resolve, reject) => {
      const existing = waiters.get(k);
      if (existing) { existing.push({ resolve, reject }); return; } // de-dupe: identical item already queued
      waiters.set(k, [{ resolve, reject }]);
      batch.push({ key: k, item });
      schedule();
    });
  }

  return { add, flush, size: () => batch.length, pending: () => waiters.size };
}

/**
 * debounce(fn, wait, options) — delay fn until `wait` ms of quiet. options.leading fires
 * on the first call, options.trailing (default true) fires after quiet. Returns a function
 * with .cancel() and .flush(). The debounced function returns a promise that resolves with
 * the result of whichever invocation ultimately runs.
 */
function debounce(fn, wait, options) {
  const o = options || {};
  const leading = !!o.leading;
  const trailing = o.trailing !== false;
  wait = Math.max(0, wait | 0);
  let timer = null, lastArgs = null, lastThis = null, pending = [], leadingDone = false;

  function invoke() {
    const args = lastArgs, ctx = lastThis, resolvers = pending;
    lastArgs = lastThis = null; pending = [];
    try { const r = fn.apply(ctx, args); for (const res of resolvers) res.resolve(r); }
    catch (e) { for (const res of resolvers) res.reject(e); }
  }

  const debounced = function (...args) {
    lastArgs = args; lastThis = this;
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      if (leading && !timer && !leadingDone) { leadingDone = true; invoke(); }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; leadingDone = false; if (trailing && pending.length) invoke(); }, wait);
    });
  };
  debounced.cancel = () => { if (timer) clearTimeout(timer); timer = null; leadingDone = false; const r = pending; pending = []; lastArgs = lastThis = null; for (const res of r) res.reject(new Error("debounce cancelled")); };
  debounced.flush = () => { if (timer) { clearTimeout(timer); timer = null; } leadingDone = false; if (pending.length) invoke(); };
  debounced.pending = () => pending.length > 0;
  return debounced;
}

/**
 * throttle(fn, wait, options) — run fn at most once per `wait` ms. options.leading
 * (default true) runs on the leading edge, options.trailing (default true) runs a final
 * time at the end of a burst. Returns a function with .cancel() and .flush().
 */
function throttle(fn, wait, options) {
  const o = options || {};
  const leading = o.leading !== false;
  const trailing = o.trailing !== false;
  wait = Math.max(0, wait | 0);
  let last = 0, timer = null, lastArgs = null, lastThis = null;

  function run(now) { last = now; const r = fn.apply(lastThis, lastArgs); lastArgs = lastThis = null; return r; }

  const throttled = function (...args) {
    const now = Date.now();
    if (!last && !leading) last = now;
    const remaining = wait - (now - last);
    lastArgs = args; lastThis = this;
    if (remaining <= 0 || remaining > wait) { if (timer) { clearTimeout(timer); timer = null; } return run(now); }
    if (!timer && trailing) { timer = setTimeout(() => { timer = null; last = leading ? Date.now() : 0; if (lastArgs) run(Date.now()); }, remaining); if (timer.unref) timer.unref(); }
    return undefined;
  };
  throttled.cancel = () => { if (timer) clearTimeout(timer); timer = null; last = 0; lastArgs = lastThis = null; };
  throttled.flush = () => { if (timer && lastArgs) { clearTimeout(timer); timer = null; return run(Date.now()); } };
  return throttled;
}

module.exports = { singleFlight, createBatcher, debounce, throttle };
