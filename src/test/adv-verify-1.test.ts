import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { verify } from "../verify";
import type { Cassette } from "../cassette";

/**
 * INVARIANT (B): the observation/analysis path must never throw in a way that
 * crashes the proxy/server. `verify()` re-issues recorded requests against a
 * LIVE server and compares response SHAPES.
 *
 * Defect: verify.ts:75-76 call shapeOf(it.response.result) and
 * shapeOf(live.result) OUTSIDE the inner try/catch (the inner try at
 * verify.ts:53-58 guards ONLY conn.request). shapeOf (shape.ts:17, self-
 * recursing at shape.ts:27 `out[k] = shapeOf(obj[k])`) has NO depth bound.
 *
 * A live server can return a deeply-nested but perfectly valid JSON result.
 * The wire/framer path handles it fine (JSON.parse is iterative), so it is
 * delivered to verify() intact — but shapeOf overflows the JS call stack with
 * RangeError: Maximum call stack size exceeded. That throw escapes the
 * for-loop and the outer try; only `finally { conn.close() }` runs, so
 * verify()'s promise REJECTS. There is no global uncaughtException/
 * unhandledRejection handler, so in the CLI (index.ts:375 `await verify(...)`)
 * this rejection crashes the process — the observer disturbing the wire.
 *
 * Correct behavior: verify() should NOT throw on a deeply-nested response. It
 * may report the comparison as an error/change, but it must contain the
 * analysis failure. This test asserts verify() resolves without throwing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DEEP_SERVER = join(here, "mock-server-deep.mjs");

function writeCassette(path: string): void {
  const cassette: Cassette = {
    mcpgazeVersion: "test",
    recordedAt: "now",
    interactions: [
      // One verifiable interaction. The recorded result shape is shallow; the
      // LIVE server returns a deeply-nested result that blows shapeOf's stack.
      {
        request: { method: "tools/list", params: {} },
        response: { result: { tools: [] } },
      },
    ],
  };
  writeFileSync(path, JSON.stringify(cassette));
}

test("verify: deeply-nested live response must not crash the observer (invariant B)", async () => {
  const p = join(tmpdir(), `adv-verify-cass-${process.pid}-${Date.now()}.json`);
  writeCassette(p);
  try {
    // Must resolve without throwing. Against the unfixed code this rejects with
    // RangeError: Maximum call stack size exceeded thrown at shape.ts via shapeOf.
    const r = await verify("node", [DEEP_SERVER], p, 8000);
    // If we get here the observer contained the failure (correct behavior).
    assert.ok(r, "verify() resolved with a result instead of throwing");
  } finally {
    rmSync(p, { force: true });
  }
});
