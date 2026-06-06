import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TuiState, renderFrame, percentile, type TuiEvent } from "../tui";
import { healthCheckOnce, summarize, type HealthCheck } from "../health";

const here = dirname(fileURLToPath(import.meta.url));
const GOOD = join(here, "mock-server.mjs");

test("percentile picks the right sample", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10], 50), 10);
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(xs, 50), 6);
  assert.equal(percentile(xs, 95), 10);
});

test("TuiState aggregates counts and latencies", () => {
  const s = new TuiState("node server.js");
  const evs: TuiEvent[] = [
    { type: "message", dir: "c2s", kind: "request", id: 1, method: "tools/list" },
    { type: "message", dir: "s2c", kind: "response", id: 1, latencyMs: 12 },
    { type: "message", dir: "s2c", kind: "error", id: 2, latencyMs: 30 },
    { type: "message", dir: "c2s", kind: "notification", method: "notifications/initialized" },
    { type: "server_stderr", text: "boot ok\nlistening" },
    { type: "note", code: "orphan-request", detail: "id=9 ..." },
  ];
  for (const e of evs) s.ingest(e);
  assert.equal(s.requests, 1);
  assert.equal(s.responses, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.notifications, 1);
  assert.equal(s.orphans, 1);
  assert.equal(s.lastStderr, "listening");
  assert.deepEqual(s.latencies, [12, 30]);
});

test("renderFrame includes key stats and methods", () => {
  const s = new TuiState("node server.js");
  s.ingest({ type: "message", dir: "c2s", kind: "request", id: 1, method: "resources/read" });
  s.ingest({ type: "message", dir: "s2c", kind: "response", id: 1, latencyMs: 7 });
  const frame = renderFrame(s, 80, 24);
  assert.match(frame, /mcpgaze/);
  assert.match(frame, /resources\/read/);
  assert.match(frame, /req 1/);
  assert.match(frame, /p50/);
});

test("summarize computes uptime and consecutive failures", () => {
  const hist: HealthCheck[] = [
    { at: "t1", ok: true, latencyMs: 10 },
    { at: "t2", ok: true, latencyMs: 20 },
    { at: "t3", ok: false, error: "down" },
    { at: "t4", ok: false, error: "down" },
  ];
  const s = summarize(hist);
  assert.equal(s.checks, 4);
  assert.equal(s.upCount, 2);
  assert.equal(s.uptimePct, 50);
  assert.equal(s.consecutiveFailures, 2);
  assert.equal(s.p50LatencyMs, 20);
});

test("healthCheckOnce reports a healthy server", async () => {
  const c = await healthCheckOnce("node", [GOOD], 3000);
  assert.equal(c.ok, true);
  assert.equal(c.toolCount, 1);
  assert.ok(typeof c.latencyMs === "number");
  assert.ok(c.toolsHash);
});

test("healthCheckOnce reports a down server", async () => {
  const c = await healthCheckOnce("sleep", ["5"], 300);
  assert.equal(c.ok, false);
  assert.ok(c.error);
});
