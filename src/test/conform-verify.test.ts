import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { conform } from "../conform";
import { verify } from "../verify";
import type { Cassette } from "../cassette";

const here = dirname(fileURLToPath(import.meta.url));
const GOOD = join(here, "mock-server.mjs");
const BAD = join(here, "mock-server-bad.mjs");
const TOOL = join(here, "mock-server-tool.mjs");

test("conform: compliant server passes all required checks", async () => {
  const r = await conform("node", [GOOD], "2025-06-18", 3000);
  assert.equal(r.passed, true);
  const required = r.results.filter((x) => x.level === "required");
  assert.ok(required.every((x) => x.status === "pass"), JSON.stringify(required.filter((x) => x.status !== "pass")));
  assert.ok(r.results.find((x) => x.id === "error.unknownMethod")?.status === "pass");
});

test("conform: non-compliant server fails required checks", async () => {
  const r = await conform("node", [BAD], "2025-06-18", 3000);
  assert.equal(r.passed, false);
  assert.equal(r.results.find((x) => x.id === "init.serverInfo")?.status, "fail");
  assert.equal(r.results.find((x) => x.id === "tools.names")?.status, "fail");
  assert.equal(r.results.find((x) => x.id === "error.unknownMethod")?.status, "fail"); // hangs -> fail
});

function writeCassette(path: string): void {
  const cassette: Cassette = {
    mcpgazeVersion: "test",
    recordedAt: "now",
    interactions: [
      { request: { method: "initialize", params: {} }, response: { result: {} } },
      {
        request: { method: "tools/call", params: { name: "search", arguments: { q: "x" } } },
        response: { result: { content: [{ type: "text", text: "ok" }], results: [{ id: 1, title: "a" }], total: 1 } },
      },
    ],
  };
  writeFileSync(path, JSON.stringify(cassette));
}

test("verify: matching server reports no behavioral drift", async () => {
  const p = join(tmpdir(), `cass-${Date.now()}-a.json`);
  writeCassette(p);
  try {
    const r = await verify("node", [TOOL], p, 4000);
    assert.equal(r.checked, 1); // initialize is skipped
    assert.equal(r.changes.length, 0, JSON.stringify(r.changes));
  } finally {
    rmSync(p, { force: true });
  }
});

test("verify: drift detected when MOCK_DRIFT=1", async () => {
  const p = join(tmpdir(), `cass-${Date.now()}-c.json`);
  writeCassette(p);
  const prev = process.env.MOCK_DRIFT;
  process.env.MOCK_DRIFT = "1";
  try {
    const r = await verify("node", [TOOL], p, 4000);
    assert.equal(r.checked, 1);
    assert.ok(r.changes.some((c) => c.severity === "breaking" && /field removed/.test(c.message)), "total removed -> breaking");
    assert.ok(r.changes.some((c) => c.severity === "warning" && /now empty/.test(c.message)), "results emptied -> warning");
  } finally {
    if (prev === undefined) delete process.env.MOCK_DRIFT;
    else process.env.MOCK_DRIFT = prev;
    rmSync(p, { force: true });
  }
});
