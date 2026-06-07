import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { probeServer, PROBE_TIMEOUT_MS } from "../client";
import { conform } from "../conform";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "real-sdk-server.mjs");
// The SDK is a heavyweight, optional dev dependency. Skip gracefully when it
// isn't installed so the core suite stays fast and network-free.
const SDK_PRESENT = existsSync(join(here, "..", "..", "node_modules", "@modelcontextprotocol", "sdk"));

test("INTEGRATION: probe a real @modelcontextprotocol/sdk server", { skip: !SDK_PRESENT && "SDK not installed" }, async () => {
  // Align with the shared probe/handshake budget (snapshot/diff/preflight all use
  // PROBE_TIMEOUT_MS). A real SDK server's cold start (SDK + zod import) can blow
  // past 10s under load, so a tighter local timeout flaked the initialize.
  const probe = await probeServer("node", [SERVER], PROBE_TIMEOUT_MS);
  assert.equal(probe.server.name, "real-sdk");
  const names = probe.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["add", "greet"]);
});

test("INTEGRATION: a real SDK server passes the conformance suite", { skip: !SDK_PRESENT && "SDK not installed" }, async () => {
  const report = await conform("node", [SERVER], "2025-06-18", PROBE_TIMEOUT_MS);
  assert.equal(report.passed, true);
  const failures = report.results.filter((r) => r.level === "required" && r.status === "fail");
  assert.equal(failures.length, 0, JSON.stringify(failures));
});
