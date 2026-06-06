import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFailures, buildTriagePrompt, callClaude, triage, type SessionEvent } from "../triage";

const events: SessionEvent[] = [
  { type: "message", dir: "c2s", kind: "request", id: 1, method: "tools/call" },
  { type: "message", dir: "s2c", kind: "error", id: 1, method: null, raw: '{"error":{"code":-32603,"message":"boom"}}' },
  { type: "message", dir: "s2c", kind: "unparsed", parseError: "Unexpected token" },
  { type: "note", code: "orphan-request", detail: "id=7 method=slow/op never received a response" },
  { type: "server_stderr", text: "Traceback (most recent call last): KeyError" },
  { type: "note", code: "server-exit", detail: "code=0" }, // not a failure
  { type: "message", dir: "s2c", kind: "response", id: 2 }, // not a failure
];

test("extractFailures finds exactly the failure signals", () => {
  const f = extractFailures(events);
  const kinds = f.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ["orphan-request", "parse-error", "rpc-error", "server-stderr"]);
});

test("server-stderr matcher catches glued error names like TypeError", () => {
  const f = extractFailures([
    { type: "server_stderr", text: "TypeError: Cannot read properties of undefined" },
    { type: "server_stderr", text: "just a normal startup line" },
  ]);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "server-stderr");
});

test("buildTriagePrompt includes each failure and MCP guidance", () => {
  const p = buildTriagePrompt(extractFailures(events));
  assert.match(p, /Traceback/); // failure detail is included
  assert.match(p, /stdout/); // includes the stdout-is-the-wire hint
});

test("callClaude posts correct headers/body and parses text blocks", async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  // @ts-expect-error override for test
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Likely cause: " }, { type: "text", text: "stdout pollution." }] }),
    } as Response;
  };
  try {
    const out = await callClaude("hello", "sk-test", "claude-sonnet-4-6");
    assert.equal(out, "Likely cause: stdout pollution.");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.anthropic\.com/);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-test");
    assert.ok(headers["anthropic-version"]);
    assert.match(String(calls[0].init.body), /claude-sonnet-4-6/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("triage degrades gracefully without an API key", async () => {
  const p = join(tmpdir(), `sess-${Date.now()}.jsonl`);
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n"));
  try {
    const r = await triage(p, { useAi: true, apiKey: undefined });
    assert.equal(r.failures.length, 4);
    assert.equal(r.aiDiagnosis, undefined);
    assert.match(r.aiSkippedReason ?? "", /API_KEY/);
  } finally {
    rmSync(p, { force: true });
  }
});

test("triage reports no failures for a clean session", async () => {
  const p = join(tmpdir(), `clean-${Date.now()}.jsonl`);
  writeFileSync(p, JSON.stringify({ type: "message", kind: "response", id: 1 }));
  try {
    const r = await triage(p, {});
    assert.equal(r.failures.length, 0);
  } finally {
    rmSync(p, { force: true });
  }
});
