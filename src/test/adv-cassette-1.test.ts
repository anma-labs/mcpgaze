import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, matchRequest, type Cassette } from "../cassette";

/**
 * INVARIANT (B): the observer / replay path must NEVER throw in a way that
 * crashes the proxy/server. cassette.ts's replay server speaks JSON-RPC on
 * stdout (STDOUT IS THE WIRE) and wires stdin straight into a framer with NO
 * try/catch:
 *
 *   process.stdin.on("data", chunk => framer.push(chunk))   // cassette.ts:121
 *
 * For every request, the framer callback calls matchRequest(...) which calls
 * stableStringify(params ?? null) (cassette.ts:85). stableStringify
 * (cassette.ts:18-24) recurses once per nesting level with NO depth bound, so a
 * request whose `params` is a deeply-nested array overflows the V8 stack and
 * throws `RangeError: Maximum call stack size exceeded` SYNCHRONOUSLY inside the
 * stdin 'data' handler. There is no process.on('uncaughtException'), and the
 * throw is not in the awaited Promise chain, so main().catch (index.ts:498) does
 * NOT catch it: the replay server dies mid-protocol with a raw stack trace.
 *
 * JSON.parse happily builds the deep array first, so the crash lands precisely
 * in stableStringify, not in framing.
 */

const DEPTH = 20000; // tiny + fast to build; well past V8's default stack depth

function deepParams(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

// ── Unit-level: the function the replay server runs on every wire request ────
test("matchRequest does not throw on deeply-nested params (observer never crashes)", () => {
  const cassette: Cassette = {
    mcpgazeVersion: "0.0.0",
    recordedAt: "2024-01-01T00:00:00.000Z",
    interactions: [{ request: { method: "ping", params: {} }, response: { result: { ok: true } } }],
  };
  const index = buildIndex(cassette);
  // Replay server calls matchRequest(index, method, params) for every request.
  // A deeply-nested params value must NOT crash the observer.
  assert.doesNotThrow(() => {
    matchRequest(index, "deep", deepParams(DEPTH));
  }, "matchRequest must not throw on deeply-nested params");
});

// ── End-to-end: the actual `replay` CLI must stay alive on the wire ──────────
test("replay server survives a deeply-nested request without crashing the wire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adv-cass-"));
  const cassPath = join(dir, "cass.json");
  writeFileSync(
    cassPath,
    JSON.stringify({
      mcpgazeVersion: "0.0.0",
      recordedAt: "2024-01-01T00:00:00.000Z",
      interactions: [{ request: { method: "ping", params: {} }, response: { result: { ok: true } } }],
    }),
  );

  const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

  const open = "[".repeat(DEPTH);
  const close = "]".repeat(DEPTH);
  const deepReq = `{"jsonrpc":"2.0","id":1,"method":"deep","params":${open}1${close}}\n`;
  // A normal request afterwards proves the server is still alive on the wire.
  const pingReq = `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}\n`;

  const child = spawn(process.execPath, [cli, "replay", "--cassette", cassPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  child.stdin.write(deepReq);
  child.stdin.write(pingReq);
  child.stdin.end();

  const code: number | null = await new Promise((resolve) => {
    child.on("close", (c) => resolve(c));
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 8000).unref?.();
  });

  // INVARIANT (B): the observer must never crash the server with an uncaught throw.
  assert.ok(
    !/RangeError: Maximum call stack size exceeded/.test(stderr),
    `replay server crashed with an uncaught RangeError (observer disturbed the wire):\n${stderr.slice(0, 400)}`,
  );
  // It should reply to the well-formed requests rather than dying.
  assert.match(stdout, /"id":2/, "replay server should still answer the follow-up ping request");
  assert.equal(code, 0, `replay server exited non-zero (${code}); stderr:\n${stderr.slice(0, 400)}`);
});
