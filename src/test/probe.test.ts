import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { probeServer } from "../client";
import { Correlator } from "../proxy";
import type { FramedMessage } from "../framer";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "mock-server.mjs");

test("probeServer performs handshake and reads the tool surface", async () => {
  const probe = await probeServer("node", [MOCK]);
  assert.equal(probe.server.name, "mock");
  assert.equal(probe.protocolVersion, "2025-06-18");
  assert.equal(probe.tools.length, 1);
  assert.equal(probe.tools[0].name, "echo");
});

test("probeServer times out cleanly on a non-responsive server", async () => {
  // `sleep` never speaks MCP; we should reject, not hang.
  await assert.rejects(() => probeServer("sleep", ["5"], 300), /timed out/);
});

// Minimal fake logger to observe Correlator behavior without a real session.
function fakeLogger() {
  const notes: Array<{ code: string; detail: string }> = [];
  const latencies: Array<number | undefined> = [];
  const logger = {
    message(_f: FramedMessage, latencyMs?: number) {
      latencies.push(latencyMs);
    },
    note(code: string, detail: string) {
      notes.push({ code, detail });
    },
    serverStderr() {},
    close() {},
  };
  return { logger, notes, latencies };
}

test("correlator matches responses to requests and measures latency", () => {
  const { logger, latencies } = fakeLogger();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = new Correlator(logger as any);
  c.onClientToServer({ direction: "c2s", raw: "", msg: { id: 1, method: "tools/list" } });
  c.onServerToClient({ direction: "s2c", raw: "", msg: { id: 1, result: {} } });
  // First (request) has no latency; second (response) should have a number.
  assert.equal(latencies[0], undefined);
  assert.equal(typeof latencies[1], "number");
});

test("correlator reports requests that never got a response", () => {
  const { logger, notes } = fakeLogger();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = new Correlator(logger as any);
  c.onClientToServer({ direction: "c2s", raw: "", msg: { id: 42, method: "slow/op" } });
  c.reportOrphans();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].code, "orphan-request");
  assert.match(notes[0].detail, /id=42/);
});
