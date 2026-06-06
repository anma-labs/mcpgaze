import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeOf } from "../shape";

/**
 * INVARIANT (B): the observation/analysis path must never throw in a way that
 * crashes the proxy/server or corrupts the stream. `shapeOf` is an analysis
 * function — it computes a structural fingerprint of a JSON value for behavioral
 * drift detection (used by verify.ts:75-76).
 *
 * Defect: shapeOf (src/shape.ts:17) recurses with NO depth bound —
 *   line 19: `{ array: ... shapeOf(value[0]) }`
 *   line 27: `out[k] = shapeOf(obj[k])`
 * A deeply-nested but perfectly valid JSON value overflows the V8 call stack and
 * throws `RangeError: Maximum call stack size exceeded`.
 *
 * Reachability: such a value is genuinely deliverable from the wire. V8's
 * JSON.parse is ITERATIVE and accepts these depths without error (verified for
 * depths well past 20000), so the framer/connection deliver the value intact to
 * the analysis layer. In verify.ts the shapeOf calls at lines 75-76 sit OUTSIDE
 * the inner try/catch (verify.ts:53-58 guards only conn.request), so the
 * RangeError escapes the for-loop and the outer try; only `finally { conn.close() }`
 * runs and verify()'s promise REJECTS — the observer disturbing the wire.
 *
 * Correct behavior: an analysis primitive like shapeOf must CONTAIN this failure.
 * It must not throw on a deeply-nested value; it may cap/truncate the fingerprint,
 * but it must return a Shape. This test asserts shapeOf does not throw.
 */

function deepObject(depth: number): unknown {
  // Build the value via JSON.parse from a one-line JSON string so it mirrors a
  // value as it would arrive off the wire (and proves JSON.parse accepts it).
  let s = "1";
  for (let i = 0; i < depth; i++) s = '{"a":' + s + "}";
  return JSON.parse(s);
}

function deepArray(depth: number): unknown {
  let s = "1";
  for (let i = 0; i < depth; i++) s = "[" + s + "]";
  return JSON.parse(s);
}

// Depth 50000 overflows shapeOf's stack in every call context (the threshold is
// context-dependent — lower with a deep caller stack — but 50000 is far above it,
// so this is deterministic). JSON.parse accepts the same depth, so it is reachable.
const DEPTH = 50000;

test("shapeOf must not throw on a deeply-nested object value (invariant B)", () => {
  const value = deepObject(DEPTH);
  let result: unknown;
  assert.doesNotThrow(() => {
    result = shapeOf(value);
  }, "shapeOf threw on a deeply-nested object — analysis path must contain the failure");
  assert.ok(result !== undefined, "shapeOf should return a Shape");
});

test("shapeOf must not throw on a deeply-nested array value (invariant B)", () => {
  const value = deepArray(DEPTH);
  let result: unknown;
  assert.doesNotThrow(() => {
    result = shapeOf(value);
  }, "shapeOf threw on a deeply-nested array — analysis path must contain the failure");
  assert.ok(result !== undefined, "shapeOf should return a Shape");
});
