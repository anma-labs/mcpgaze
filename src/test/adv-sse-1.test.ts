import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser } from "../sse";

/**
 * Adversarial repro for candidate sse-1 (invariant A).
 *
 * Per the WHATWG SSE/EventStream parsing spec, a line is terminated by
 * U+000D CR, U+000A LF, or a CRLF pair. A lone CR (CR not followed by LF) is a
 * VALID line/event boundary. src/sse.ts only splits on "\n" (line 22) and only
 * strips a *trailing* "\r" (line 25), so lone-CR streams are mis-parsed.
 *
 * Because src/http-proxy.ts:206-214 feeds SseParser the exact upstream bytes
 * forwarded on the wire, mis-parsing means the observer's logged JSON-RPC
 * messages diverge from what the peer actually sent (bytes-on-wire !=
 * observed), violating invariant (A): byte-exact / faithful observation.
 *
 * These tests assert the SPEC-CORRECT result, so they FAIL against the current
 * (unfixed) parser and turn GREEN once lone-CR boundaries are handled.
 */

function collect(): { events: string[]; parser: SseParser } {
  const events: string[] = [];
  return { events, parser: new SseParser((d) => events.push(d)) };
}

// (1) Corruption: a lone CR between two data lines must terminate the first
//     line. Spec-correct concatenation of two data fields in one event is
//     "a\nb". The current parser instead merges into the garbage string
//     "a\rdata: b".
test("lone CR terminates a data line (no merge corruption)", () => {
  const { events, parser } = collect();
  parser.push("data: a\rdata: b\n\n");
  assert.deepEqual(events, ["a\nb"]);
});

// (2) Blindness: a CR-only event stream carries two complete JSON-RPC
//     responses on the wire, but the current parser never sees a "\n" and emits
//     ZERO events — the observer goes blind while the proxy forwards every byte.
test("CR-only event boundaries are observed (no blindness)", () => {
  const { events, parser } = collect();
  const a = '{"jsonrpc":"2.0","id":1,"result":"a"}';
  const b = '{"jsonrpc":"2.0","id":2,"result":"b"}';
  parser.push(Buffer.from(`data: ${a}\r\rdata: ${b}\r\r`, "utf8"));
  assert.deepEqual(events, [a, b]);
});
