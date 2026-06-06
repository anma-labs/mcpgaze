import { test } from "node:test";
import assert from "node:assert/strict";
import { Tui, renderFrame, TuiState } from "../tui";

/**
 * INVARIANT (B): the observer/analysis path must never throw in a way that
 * crashes the proxy. The TUI is purely an observation surface (it renders
 * logger events to a TTY off the wire) and its paint loop must never crash
 * the host process.
 *
 * DEFECT: tui.ts:98-99 computes `width = Math.max(40, cols)` then
 * `bar = "─".repeat(width)`. Math.max does NOT clamp Infinity or huge finite
 * values, so an out-of-range `columns` reported by a TTY flows straight into
 * String.prototype.repeat:
 *   - cols = Infinity   -> "─".repeat(Infinity) -> RangeError: Invalid count value
 *   - cols = 2**30      -> "─".repeat(2**30)    -> RangeError: Invalid string length
 *
 * The `??` guard at tui.ts:179 (`this.out.columns ?? 80`) only catches
 * null/undefined, NOT Infinity/huge numbers. paint() (tui.ts:177-182) has no
 * try/catch and runs from start()'s immediate call (line 169) and from a
 * setInterval (line 170). With no global process.on('uncaughtException')
 * anywhere, the throw becomes an uncaught exception in the timer callback and
 * tears down the process hosting the proxy — violating invariant (B).
 */

/** Minimal TTY-ish WriteStream that lets us inject an out-of-range column count. */
function fakeTty(columns: number): NodeJS.WriteStream {
  const stub: Partial<NodeJS.WriteStream> = {
    isTTY: true,
    columns,
    rows: 24,
    // swallow all output (alt-screen escapes, frames); never touch a real fd.
    write: (() => true) as unknown as NodeJS.WriteStream["write"],
  };
  return stub as NodeJS.WriteStream;
}

// (B) Unit-level: renderFrame is "pure: state + viewport -> string" and must
// not throw on a viewport a TTY can legitimately report.
test("renderFrame does not throw on out-of-range columns (Infinity / huge)", () => {
  const s = new TuiState("node server.js");
  assert.doesNotThrow(
    () => renderFrame(s, Infinity, 24),
    "renderFrame(state, Infinity, 24) threw — tui.ts:99 '─'.repeat(Math.max(40,Infinity)) is unguarded",
  );
  assert.doesNotThrow(
    () => renderFrame(s, 2 ** 30, 24),
    "renderFrame(state, 2**30, 24) threw — tui.ts:99 '─'.repeat(huge) raises 'Invalid string length'",
  );
});

// (B) End-to-end: the real paint() path. start() calls paint() synchronously
// (tui.ts:169) before installing the 100ms interval, so the crash surfaces
// deterministically and immediately when out.columns is Infinity.
test("Tui.start() paint loop survives a TTY reporting Infinity columns", () => {
  const tui = new Tui("node server.js", fakeTty(Infinity));
  try {
    assert.doesNotThrow(
      () => tui.start(),
      "Tui.start() threw via paint()->renderFrame — the observer crashed the wire (invariant B)",
    );
  } finally {
    // best-effort cleanup; stop() must not be the thing under test.
    try {
      tui.stop();
    } catch {
      /* ignore */
    }
  }
});
