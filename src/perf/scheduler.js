"use strict";
// ============================= Concurrent task executor =============================
// A bounded worker-pool scheduler for Nexus: run many async tasks (engine calls, tool
// invocations, file scans) with a hard concurrency cap, priorities, per-task timeouts,
// and cooperative cancellation via AbortSignal. Backpressure is explicit — a bounded
// queue rejects (or the caller can await capacity) instead of letting work pile up
// unbounded. Scheduling is deterministic: at any moment the highest-priority task is
// started next, ties broken by submission order (FIFO), so a given submission sequence
// always produces the same run order for a given concurrency.
//
// A task is any function `(signal) => value | Promise<value>`. The signal it receives
// aborts when the caller's signal aborts OR the task's timeout fires; well-behaved
// tasks should observe it (e.g. pass it to fetch/child spawns) for prompt cancellation.
// Tasks that ignore the signal still have their result rejected on timeout/abort, but
// keep running to completion in the background — this module cannot force-stop opaque
// work, only stop waiting on it and free the slot once it settles.

const { EventEmitter } = require("events");

// ---- Binary min-heap keyed on (−priority, seq): higher priority first, FIFO on ties.
// O(log n) push/pop keeps the queue cheap even with thousands of pending tasks.
class TaskHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  _less(i, j) {
    const x = this.a[i], y = this.a[j];
    if (x.priority !== y.priority) return x.priority > y.priority; // higher priority wins
    return x.seq < y.seq;                                          // then earliest submitted
  }
  push(node) {
    const a = this.a; a.push(node); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this._less(i, p)) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; }
  }
  pop() {
    const a = this.a; if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (a.length) { a[0] = last; this._down(0); }
    return top;
  }
  _down(i) {
    const a = this.a, n = a.length;
    for (;;) {
      let s = i, l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this._less(l, s)) s = l;
      if (r < n && this._less(r, s)) s = r;
      if (s === i) break;
      [a[i], a[s]] = [a[s], a[i]]; i = s;
    }
  }
  // Remove a node by identity (for cancel-while-queued). O(n) find + O(log n) fix.
  remove(node) {
    const a = this.a, idx = a.indexOf(node);
    if (idx < 0) return false;
    const last = a.pop();
    if (idx < a.length) { a[idx] = last; this._down(idx); let i = idx; while (i > 0) { const p = (i - 1) >> 1; if (this._less(i, p)) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
    return true;
  }
}

function abortError(msg) { const e = new Error(msg || "The operation was aborted"); e.name = "AbortError"; e.code = "ABORT_ERR"; return e; }
function timeoutError(ms) { const e = new Error("Task timed out after " + ms + "ms"); e.name = "TimeoutError"; e.code = "ETIMEDOUT"; return e; }

/**
 * createScheduler(options)
 *   concurrency   max tasks running at once (default 4, min 1)
 *   maxQueue      max tasks allowed to wait; 0/Infinity = unbounded (default Infinity)
 *   defaultTimeout ms applied to tasks that don't pass their own (default 0 = none)
 * Returns an EventEmitter with: submit, size, running, pending, pause, resume,
 * setConcurrency, onIdle, drain, clear. Events: "start","settle","idle","reject".
 */
function createScheduler(options) {
  const opts = options || {};
  let concurrency = Math.max(1, opts.concurrency | 0 || 4);
  const maxQueue = opts.maxQueue && opts.maxQueue > 0 ? opts.maxQueue : Infinity;
  const defaultTimeout = Math.max(0, opts.defaultTimeout | 0 || 0);

  const emitter = new EventEmitter();
  const queue = new TaskHeap();
  let running = 0;
  let seq = 0;
  let paused = false;
  let idleWaiters = [];
  const stats = { submitted: 0, completed: 0, failed: 0, timedOut: 0, cancelled: 0, maxConcurrent: 0 };

  function notifyIdle() {
    if (running === 0 && queue.size === 0) {
      emitter.emit("idle");
      const w = idleWaiters; idleWaiters = [];
      for (const r of w) r();
    }
  }

  function pump() {
    while (!paused && running < concurrency && queue.size > 0) {
      const node = queue.pop();
      runNode(node);
    }
  }

  function runNode(node) {
    running++;
    if (running > stats.maxConcurrent) stats.maxConcurrent = running;
    node.state = "running";
    emitter.emit("start", node.meta);

    const ac = new AbortController();
    node.internalAc = ac;
    // Link the caller's signal: aborting it aborts the task's signal.
    if (node.signal) {
      if (node.signal.aborted) { ac.abort(node.signal.reason); }
      else { node.onExtAbort = () => ac.abort(node.signal.reason); node.signal.addEventListener("abort", node.onExtAbort, { once: true }); }
    }
    // Timeout → abort the task signal and mark the reason.
    let timer = null;
    if (node.timeout > 0) {
      timer = setTimeout(() => { node.timedOut = true; ac.abort(timeoutError(node.timeout)); }, node.timeout);
    }

    let settled = false;
    const finish = (err, value) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      if (node.onExtAbort && node.signal) node.signal.removeEventListener("abort", node.onExtAbort);
      if (node.onQueuedAbort && node.signal) node.signal.removeEventListener("abort", node.onQueuedAbort); // release listener held since submit
      running--;
      node.state = err ? "rejected" : "fulfilled";
      if (err) {
        if (node.timedOut) { stats.timedOut++; err = err.name === "TimeoutError" ? err : timeoutError(node.timeout); }
        else if (err.name === "AbortError") stats.cancelled++;
        else stats.failed++;
        emitter.emit("reject", err, node.meta);
        node.reject(err);
      } else {
        stats.completed++;
        node.resolve(value);
      }
      emitter.emit("settle", node.meta);
      pump();
      notifyIdle();
    };

    // Run the task. Wrap sync throws and non-promise returns uniformly.
    try {
      Promise.resolve(node.fn(ac.signal)).then((v) => finish(null, v), (e) => finish(e || new Error("Task rejected")));
    } catch (e) {
      finish(e || new Error("Task threw"));
    }
  }

  function submit(fn, taskOpts) {
    const o = taskOpts || {};
    if (typeof fn !== "function") return Promise.reject(new TypeError("submit(fn): fn must be a function"));
    if (queue.size >= maxQueue) {
      const e = new Error("Scheduler queue is full (" + maxQueue + ")"); e.code = "EQUEUEFULL";
      return Promise.reject(e);
    }
    const signal = o.signal || null;
    if (signal && signal.aborted) { stats.cancelled++; return Promise.reject(abortError(signal.reason && signal.reason.message)); }

    stats.submitted++;
    const node = {
      fn,
      priority: Number.isFinite(o.priority) ? o.priority : 0,
      timeout: o.timeout != null ? Math.max(0, o.timeout | 0) : defaultTimeout,
      signal,
      seq: seq++,
      state: "queued",
      meta: { id: o.id || "t" + seq, priority: Number.isFinite(o.priority) ? o.priority : 0, name: o.name || "" },
      timedOut: false,
      resolve: null, reject: null, onExtAbort: null, onQueuedAbort: null, internalAc: null,
    };
    const p = new Promise((resolve, reject) => { node.resolve = resolve; node.reject = reject; });

    // Cancel while still queued: drop from the heap and reject immediately.
    if (signal) {
      const onQueuedAbort = () => {
        if (node.state !== "queued") return;
        if (queue.remove(node)) { stats.cancelled++; node.reject(abortError(signal.reason && signal.reason.message)); notifyIdle(); }
      };
      node.onQueuedAbort = onQueuedAbort;
      signal.addEventListener("abort", onQueuedAbort, { once: true });
      // Once running, runNode installs its own listener; this one becomes a no-op via state
      // check and is removed when the task settles (see finish()).
    }

    queue.push(node);
    pump();
    return p;
  }

  return Object.assign(emitter, {
    submit,
    size: () => queue.size + running,          // total not-yet-settled
    pending: () => queue.size,                 // waiting in queue
    running: () => running,
    isPaused: () => paused,
    pause() { paused = true; },
    resume() { paused = false; pump(); },
    setConcurrency(n) { concurrency = Math.max(1, n | 0); pump(); return concurrency; },
    getConcurrency: () => concurrency,
    stats: () => Object.assign({}, stats, { running, pending: queue.size }),
    // Resolve once the queue empties and all running tasks settle.
    onIdle() { if (running === 0 && queue.size === 0) return Promise.resolve(); return new Promise((r) => idleWaiters.push(r)); },
    drain() { return this.onIdle(); },
    // Reject every queued (not-yet-started) task; running tasks are left alone.
    clear(reason) {
      let n = 0, node;
      while ((node = queue.pop())) { stats.cancelled++; n++; node.state = "cleared"; node.reject(abortError(reason || "Scheduler cleared")); }
      notifyIdle();
      return n;
    },
  });
}

/**
 * mapLimit(items, limit, worker) — run `worker(item, index, signal)` over items with
 * at most `limit` in flight, preserving output order. Rejects on the first error
 * (and cancels the rest via an internal AbortController). A convenience built on the
 * scheduler for the common "process N things, bounded" case.
 */
async function mapLimit(items, limit, worker, options) {
  const arr = Array.from(items || []);
  const results = new Array(arr.length);
  if (!arr.length) return results;
  const sched = createScheduler({ concurrency: Math.max(1, limit | 0 || 1) });
  const ac = new AbortController();
  // Every submitted task attaches an abort listener to this one signal; raise the cap so a
  // large fan-out doesn't trip Node's MaxListenersExceededWarning (these are bounded and cleaned up).
  try { require("events").setMaxListeners(arr.length + Math.max(1, limit | 0 || 1) + 16, ac.signal); } catch (_) {}
  const ext = options && options.signal;
  if (ext) { if (ext.aborted) throw abortError(); ext.addEventListener("abort", () => ac.abort(ext.reason), { once: true }); }
  try {
    await Promise.all(arr.map((item, i) =>
      sched.submit((signal) => worker(item, i, signal), { signal: ac.signal, priority: options && options.priority })
        .then((v) => { results[i] = v; }, (e) => { ac.abort(e); throw e; })
    ));
    return results;
  } catch (e) {
    ac.abort(e);
    throw e;
  }
}

module.exports = { createScheduler, mapLimit, TaskHeap, abortError, timeoutError };
