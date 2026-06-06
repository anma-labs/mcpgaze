import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser } from "../sse";

function collect(): { events: string[]; parser: SseParser } {
  const events: string[] = [];
  return { events, parser: new SseParser((d) => events.push(d)) };
}

test("emits a single data event on blank line", () => {
  const { events, parser } = collect();
  parser.push('data: {"id":1}\n\n');
  assert.deepEqual(events, ['{"id":1}']);
});

test("concatenates multiple data lines with newline", () => {
  const { events, parser } = collect();
  parser.push("data: a\ndata: b\n\n");
  assert.deepEqual(events, ["a\nb"]);
});

test("ignores comments, event:, and id: fields", () => {
  const { events, parser } = collect();
  parser.push(": keep-alive\nevent: message\nid: 7\ndata: x\n\n");
  assert.deepEqual(events, ["x"]);
});

test("handles CRLF line endings", () => {
  const { events, parser } = collect();
  parser.push('data: {"ok":true}\r\n\r\n');
  assert.deepEqual(events, ['{"ok":true}']);
});

test("buffers an event split across chunks", () => {
  const { events, parser } = collect();
  parser.push("data: hel");
  parser.push("lo\n");
  assert.equal(events.length, 0);
  parser.push("\n");
  assert.deepEqual(events, ["hello"]);
});

test("two events in one push", () => {
  const { events, parser } = collect();
  parser.push("data: one\n\ndata: two\n\n");
  assert.deepEqual(events, ["one", "two"]);
});
