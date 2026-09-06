"use strict";
// ================= Agent Telemetry — performance tracking and insights =================
// Tracks every agent action: how long it took, what succeeded/failed, token usage,
// cost, and quality scores. Builds a profile of agent performance over time so you
// can see which engines are best for which tasks, where time is wasted, and what
// types of requests succeed vs fail.

const fs = require("fs");
const path = require("path");

const TELEMETRY_FILE = ".nexus/telemetry.json";
const MAX_EVENTS = 2000;

function telemetryPath(cwd) { return path.join(cwd, TELEMETRY_FILE); }

function loadTelemetry(cwd) {
  try { return JSON.parse(fs.readFileSync(telemetryPath(cwd), "utf8")); }
  catch (_) { return { events: [], summary: {}, version: 1 }; }
}

function saveTelemetry(cwd, data) {
  const dir = path.dirname(telemetryPath(cwd));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  // Trim old events
  if (data.events.length > MAX_EVENTS) data.events = data.events.slice(-MAX_EVENTS);
  fs.writeFileSync(telemetryPath(cwd), JSON.stringify(data, null, 2));
}

// ---- Event recording ----

function recordEvent(cwd, event) {
  const data = loadTelemetry(cwd);
  data.events.push({
    type: event.type || "unknown",       // prompt | tool_call | error | recovery | eval
    engine: event.engine || "",
    model: event.model || "",
    intent: event.intent || "",
    duration: event.duration || 0,        // ms
    inputTokens: event.inputTokens || 0,
    outputTokens: event.outputTokens || 0,
    cost: event.cost || 0,               // dollars
    success: event.success !== false,
    error: event.error || null,
    quality: event.quality || null,       // 1-5 from eval engine
    timestamp: Date.now(),
  });
  saveTelemetry(cwd, data);
}

// ---- Analytics ----

function computeStats(events, filter) {
  let filtered = events;
  if (filter) {
    if (filter.type) filtered = filtered.filter(e => e.type === filter.type);
    if (filter.engine) filtered = filtered.filter(e => e.engine === filter.engine);
    if (filter.since) filtered = filtered.filter(e => e.timestamp >= filter.since);
    if (filter.intent) filtered = filtered.filter(e => e.intent === filter.intent);
  }
  if (!filtered.length) return null;

  const total = filtered.length;
  const succeeded = filtered.filter(e => e.success).length;
  const totalDuration = filtered.reduce((s, e) => s + e.duration, 0);
  const totalTokens = filtered.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0);
  const totalCost = filtered.reduce((s, e) => s + e.cost, 0);
  const qualities = filtered.filter(e => e.quality != null).map(e => e.quality);

  return {
    count: total,
    successRate: total ? (succeeded / total * 100).toFixed(1) + "%" : "0%",
    avgDuration: total ? Math.round(totalDuration / total) : 0,
    totalDuration,
    totalTokens,
    totalCost: totalCost.toFixed(4),
    avgQuality: qualities.length ? (qualities.reduce((a, b) => a + b, 0) / qualities.length).toFixed(2) : null,
    errorRate: total ? ((total - succeeded) / total * 100).toFixed(1) + "%" : "0%",
  };
}

function engineComparison(events) {
  const engines = [...new Set(events.map(e => e.engine).filter(Boolean))];
  return engines.map(engine => ({
    engine,
    ...computeStats(events, { engine }),
  }));
}

function intentBreakdown(events) {
  const intents = [...new Set(events.map(e => e.intent).filter(Boolean))];
  return intents.map(intent => ({
    intent,
    ...computeStats(events, { intent }),
  }));
}

function hourlyActivity(events, hours) {
  hours = hours || 24;
  const since = Date.now() - hours * 3600 * 1000;
  const recent = events.filter(e => e.timestamp >= since);
  const buckets = {};
  for (const e of recent) {
    const hour = new Date(e.timestamp).getHours();
    buckets[hour] = (buckets[hour] || 0) + 1;
  }
  return buckets;
}

function topErrors(events, limit) {
  limit = limit || 10;
  const errors = {};
  for (const e of events) {
    if (e.error) {
      const key = String(e.error).slice(0, 80);
      errors[key] = (errors[key] || 0) + 1;
    }
  }
  return Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([error, count]) => ({ error, count }));
}

function dashboard(cwd) {
  const data = loadTelemetry(cwd);
  const events = data.events;
  const now = Date.now();
  const today = events.filter(e => e.timestamp > now - 86400000);
  const week = events.filter(e => e.timestamp > now - 7 * 86400000);

  return {
    allTime: computeStats(events),
    today: computeStats(today),
    thisWeek: computeStats(week),
    byEngine: engineComparison(events),
    byIntent: intentBreakdown(events),
    topErrors: topErrors(events),
    totalEvents: events.length,
  };
}

function dashboardText(cwd) {
  const d = dashboard(cwd);
  if (!d.allTime) return "No telemetry data yet.";
  const lines = [
    "═══ Nexus Agent Telemetry ═══",
    "",
    `All time: ${d.allTime.count} actions, ${d.allTime.successRate} success, $${d.allTime.totalCost} spent`,
    `Today: ${d.today ? d.today.count + " actions, " + d.today.successRate + " success" : "no activity"}`,
    `This week: ${d.thisWeek ? d.thisWeek.count + " actions" : "no activity"}`,
  ];
  if (d.byEngine.length > 1) {
    lines.push("", "By engine:");
    for (const e of d.byEngine) lines.push(`  ${e.engine}: ${e.count} calls, ${e.successRate} success, avg ${e.avgDuration}ms`);
  }
  if (d.topErrors.length) {
    lines.push("", "Top errors:");
    for (const e of d.topErrors.slice(0, 5)) lines.push(`  (${e.count}×) ${e.error}`);
  }
  return lines.join("\n");
}

module.exports = { recordEvent, computeStats, engineComparison, intentBreakdown, hourlyActivity, topErrors, dashboard, dashboardText, loadTelemetry, saveTelemetry };
