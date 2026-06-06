import { test } from "node:test";
import assert from "node:assert/strict";
import { LineFramer, type FramedMessage } from "../framer";

function collect(): { msgs: FramedMessage[]; framer: LineFramer } {
  const msgs: FramedMessage[] = [];
  const framer = new LineFramer((m) => msgs.push(m), "s2c");
  return { msgs, framer };
}

test("parses one complete line", () => {
  const { msgs, framer } = collect();
  framer.push('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].msg?.id, 1);
  assert.equal(msgs[0].parseError, undefined);
});

test("buffers a message split across chunk boundaries", () => {
  const { msgs, framer } = collect();
  framer.push('{"jsonrpc":"2.0",');
  framer.push('"id":2,"method":"x"}');
  assert.equal(msgs.length, 0); // no newline yet
  framer.push("\n");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].msg?.method, "x");
});

test("handles multiple messages in one chunk", () => {
  const { msgs, framer } = collect();
  framer.push('{"id":1,"result":1}\n{"id":2,"result":2}\n');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].msg?.id, 2);
});

test("invalid JSON yields parseError but does not throw", () => {
  const { msgs, framer } = collect();
  assert.doesNotThrow(() => framer.push("not json at all\n"));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].msg, null);
  assert.ok(msgs[0].parseError);
});

test("UTF-8 multibyte char split across chunks is reassembled", () => {
  const { msgs, framer } = collect();
  // "🐱" is 4 bytes (F0 9F 90 B1); split it across two pushes.
  const full = Buffer.from('{"id":1,"result":"🐱"}\n', "utf8");
  const cut = 10; // mid-emoji
  framer.push(full.subarray(0, cut));
  framer.push(full.subarray(cut));
  assert.equal(msgs.length, 1);
  assert.equal((msgs[0].msg?.result as string) ?? "", "🐱");
});

test("blank lines are skipped", () => {
  const { msgs, framer } = collect();
  framer.push("\n\n");
  assert.equal(msgs.length, 0);
});
