import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CassetteRecorder,
  buildIndex,
  matchRequest,
  stableStringify,
  type Cassette,
} from "../cassette";

test("stableStringify is key-order independent", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: { y: 1, x: 2 } }), '{"a":{"x":2,"y":1}}');
});

test("recorder dedups identical interactions", () => {
  const r = new CassetteRecorder();
  r.add({ method: "tools/list", params: {} }, { result: { tools: [] } });
  r.add({ method: "tools/list", params: {} }, { result: { tools: [] } });
  assert.equal(r.toCassette().interactions.length, 1);
});

test("recorder stores error responses", () => {
  const r = new CassetteRecorder();
  r.add({ method: "tools/call", params: { name: "x" } }, { error: { code: -32602, message: "bad" } });
  const it = r.toCassette().interactions[0];
  assert.equal(it.response.error?.code, -32602);
  assert.equal(it.response.result, undefined);
});

const cassette: Cassette = {
  mcpgazeVersion: "test",
  recordedAt: "now",
  interactions: [
    { request: { method: "initialize", params: { protocolVersion: "x" } }, response: { result: { ok: true } } },
    { request: { method: "tools/call", params: { name: "a" } }, response: { result: 1 } },
    { request: { method: "tools/call", params: { name: "b" } }, response: { result: 2 } },
    { request: { method: "ping" }, response: { result: {} } },
  ],
};

test("matchRequest finds exact method+params match", () => {
  const idx = buildIndex(cassette);
  const out = matchRequest(idx, "tools/call", { name: "b" });
  assert.equal(out.kind, "result");
  if (out.kind === "result") assert.equal(out.result, 2);
});

test("matchRequest falls back to method-only when unambiguous", () => {
  const idx = buildIndex(cassette);
  const out = matchRequest(idx, "ping", { anything: true });
  assert.equal(out.kind, "result");
});

test("matchRequest errors when method has multiple entries and params do not match", () => {
  const idx = buildIndex(cassette);
  const out = matchRequest(idx, "tools/call", { name: "zzz" });
  assert.equal(out.kind, "error");
  if (out.kind === "error") assert.equal(out.error.code, -32601);
});

test("matchRequest errors on unknown method", () => {
  const idx = buildIndex(cassette);
  const out = matchRequest(idx, "nope/nope", {});
  assert.equal(out.kind, "error");
});
