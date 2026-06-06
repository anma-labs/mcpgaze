import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { updateCassette } from "../verify";
import type { Cassette } from "../cassette";

const here = dirname(fileURLToPath(import.meta.url));
const DEEP = join(here, "mock-server-deep.mjs");

// INVARIANT (B): the observer/analysis path must never throw in a way that
// crashes the proxy/server. updateCassette() re-issues recorded requests against
// the LIVE (untrusted) server and serializes the response it gets back. A server
// can return a deeply nested result on one line: V8's JSON.parse is iterative and
// happily delivers it as live.result, but JSON.stringify(cassette, null, 2) at
// verify.ts:119 is recursive and overflows the stack -> RangeError. updateCassette's
// only handler is `finally { conn.close() }`, so the RangeError rejects the promise
// and, with no global handler, crashes the process.
test("updateCassette: deeply nested live result must not crash the serializer (invariant B)", async () => {
  const cassettePath = join(tmpdir(), `adv-verify-2-${process.pid}-${Date.now()}.json`);
  const cassette: Cassette = {
    mcpgazeVersion: "test",
    recordedAt: "now",
    interactions: [
      // One verifiable interaction; the deep server answers it with a deep result.
      { request: { method: "tools/list", params: {} }, response: { result: { tools: [] } } },
    ],
  };
  writeFileSync(cassettePath, JSON.stringify(cassette));

  try {
    // Depth 20000: JSON.parse accepts it, JSON.stringify(value, null, 2) overflows.
    // Correct behavior: updateCassette resolves (or rejects with a *handled*,
    // descriptive error) WITHOUT throwing an uncaught RangeError. It must not
    // propagate a stack-overflow out of the observer path.
    let threw: unknown;
    try {
      await updateCassette("node", [DEEP], cassettePath, 8000);
    } catch (e) {
      threw = e;
    }
    assert.ok(
      !(threw instanceof RangeError),
      `updateCassette leaked a RangeError from JSON.stringify (verify.ts:119) on a deep live result: ${
        threw instanceof Error ? threw.message : String(threw)
      }`,
    );
  } finally {
    rmSync(cassettePath, { force: true });
  }
});
