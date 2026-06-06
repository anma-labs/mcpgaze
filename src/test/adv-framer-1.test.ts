import { test } from "node:test";
import assert from "node:assert/strict";
import { LineFramer } from "../framer";

/**
 * INVARIANT (B): the observer (LineFramer) must NEVER throw. framer.ts's own
 * doc-comment promises "a parse failure here can never corrupt the protocol
 * stream", and the existing suite asserts `push()` does not throw on bad JSON.
 *
 * DEFECT: framer.ts:33 — `this.buf += ... this.decoder.write(chunk)` has NO
 * upper bound. A peer that streams more than V8's MAX_STRING_LENGTH
 * (536,870,888 chars) of bytes WITHOUT a '\n' overflows the V8 string limit on
 * the `+=`, and push() throws `RangeError: Invalid string length` SYNCHRONOUSLY.
 *
 * Why this crashes the wire: push() is wired UNWRAPPED into stream 'data'
 * listeners at cassette.ts:121 (`process.stdin.on("data", c => framer.push(c))`
 * — the replay server whose stdout IS the wire) and mcp-connection.ts:44
 * (`this.child.stdout.on("data", c => this.framer.push(c))`). A synchronous
 * throw inside a 'data' listener is NOT caught by the stream's 'error' event; it
 * propagates to the event loop, and with NO process.on('uncaughtException')
 * anywhere the process is torn down mid-stream. (proxy.ts:113-128 wraps push()
 * in try/catch — these two seams do not. That asymmetry is the bug.)
 *
 * This unit test reproduces the root cause directly: push() must not throw on a
 * large single line. It FAILS today (RangeError) and goes GREEN once push()
 * bounds its buffer (e.g. caps/flushes an over-long pending line instead of
 * concatenating without limit).
 */
test("(B) push() never throws on a >512MB line without a newline", () => {
  const f = new LineFramer(() => {}, "s2c");
  // 128MB ASCII chunks (0x61 'a'), NO newline -> buffer grows unbounded.
  // The 4th push crosses MAX_STRING_LENGTH (536,870,888) and triggers the
  // unbounded `+=` overflow at framer.ts:33.
  const CHUNK = 128 * 1024 * 1024;
  const chunk = Buffer.alloc(CHUNK, 0x61);
  assert.doesNotThrow(() => {
    for (let i = 0; i < 5; i++) f.push(chunk);
  }, "LineFramer.push() must not throw — the observer must never disturb the wire");
});
