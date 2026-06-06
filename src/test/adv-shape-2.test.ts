import { test } from "node:test";
import assert from "node:assert/strict";
import type { Shape } from "../shape";
import { diffShape } from "../shape";

/**
 * INVARIANT (B): the observation/analysis path must never throw in a way that
 * crashes the proxy/server. `diffShape` is an analysis function — it compares two
 * structural fingerprints to detect behavioral drift (used by verify.ts:77).
 *
 * Defect (DISTINCT from shape-1, which is about `shapeOf`): `diffShape`
 * (src/shape.ts:44) recurses with NO depth bound of its own —
 *   line 66: `diffShape(`${path}.${k}`, o[k], n[k])`   (object branch)
 *   line 82: `diffShape(`${path}[]`, oe, ne)`           (array branch)
 * One stack frame per nesting level. Two deeply-nested but perfectly valid,
 * *matching* shapes overflow the V8 call stack and throw
 * `RangeError: Maximum call stack size exceeded`. This is independent of shapeOf:
 * building the Shape directly (no shapeOf call) still overflows.
 *
 * Reachability: verify.ts builds `recordedShape`/`liveShape` via shapeOf
 * (verify.ts:75-76) and then iterates `diffShape(method, recordedShape, liveShape)`
 * at verify.ts:77 — OUTSIDE the only inner try/catch (verify.ts:53-58, which
 * guards just conn.request) and outside the outer try (only `finally{close}`).
 * A RangeError from diffShape therefore rejects verify()'s promise, and with no
 * process.on('uncaughtException') handler the `verify` CLI command (index.ts:375)
 * crashes — the observer disturbing the wire.
 *
 * Correct behavior: an analysis primitive like diffShape must CONTAIN this
 * failure. It must not throw on a deep shape; it may cap/truncate the diff, but it
 * must return a Change[]. This test asserts diffShape does not throw.
 */

function deepShape(depth: number): Shape {
  // Build the Shape value directly (as shapeOf would produce for a deep object),
  // so the overflow is attributed to diffShape's recursion alone — not shapeOf's.
  let s: Shape = "number";
  for (let i = 0; i < depth; i++) s = { object: { a: s } } as Shape;
  return s;
}

// Depth 50000 overflows diffShape's recursion in every reasonable call context
// (the threshold is ~4000 even from a shallow caller, so 50000 is far above it
// and deterministic). The two shapes are IDENTICAL, so the diff descends the full
// depth via the object branch (src/shape.ts:66).
const DEPTH = 50000;

test("diffShape must not throw on deeply-nested matching shapes (invariant B)", () => {
  const s = deepShape(DEPTH);
  let result: unknown;
  assert.doesNotThrow(() => {
    result = diffShape("m", s, s);
  }, "diffShape threw on deeply-nested matching shapes — analysis path must contain the failure");
  assert.ok(Array.isArray(result), "diffShape should return a Change[]");
});

test("diffShape must not throw on a deeply-nested array shape (invariant B)", () => {
  let s: Shape = "number";
  for (let i = 0; i < DEPTH; i++) s = { array: s } as Shape;
  let result: unknown;
  assert.doesNotThrow(() => {
    result = diffShape("m", s, s);
  }, "diffShape threw on a deeply-nested array shape — analysis path must contain the failure");
  assert.ok(Array.isArray(result), "diffShape should return a Change[]");
});
