// Adversarial verifier test for candidate rust-3.
//
// Inverse of the long-standing "Rust classify substring divergence" known bug.
// The native proxy's classifier used to substring-match "method"/"id"/"error"
// ANYWHERE on the raw line (native/mcpgaze-proxy/src/main.rs `has_key`), so it
// disagreed with the Node observer (src/jsonrpc.ts `classify`, which JSON-parses)
// whenever a key token sat inside a string VALUE, a NESTED object, or a batch
// ARRAY element; it also counted `id:null` as an id and a response missing its
// `result`/`error` key as a response. A differential audit
// (`node scripts/diff-proxies.mjs --corpus scripts/corpus`) found 87 such KIND
// disagreements on WELL-FORMED lines. main.rs now uses an allocation-light,
// parse-free, single-pass TOP-LEVEL-key scanner (`scan_top_level`) that mirrors
// Node's parser view.
//
// Part 1 drives the previously-divergent representatives through BOTH proxies and
// asserts they now AGREE on kind AND method.
//
// Part 2 PINS the deliberately-accepted residual boundary: the scanner does not
// JSON-parse and does not decode \uXXXX escapes, so a \u-escaped method VALUE
// still differs on the `method` column (while kind agrees). This is documented in
// KNOWN-ISSUES.md; if that residual is ever closed, update the doc and this test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUST = "native/mcpgaze-proxy/target/release/mcpgaze-proxy";
// A child that swallows stdin and exits on EOF, producing no stdout — so the only
// observed messages are the crafted client->server lines, classified by both
// proxies via the same direction-agnostic classifier.
const SINK = [
  "-e",
  "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0))",
];

interface Msg {
  kind: string;
  method: string | null;
}

function drive(cmd: string, args: string[], lines: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", reject);
    p.on("exit", () => resolve());
    p.stdin.on("error", () => {});
    p.stdin.write(lines.map((l) => l + "\n").join(""));
    p.stdin.end();
  });
}

function c2sMessages(path: string): Msg[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "message" && e.dir === "c2s")
    .map((e) => ({ kind: e.kind as string, method: (e.method ?? null) as string | null }));
}

async function bothProxies(lines: string[]): Promise<{ node: Msg[]; rust: Msg[] }> {
  const dir = mkdtempSync(join(tmpdir(), "adv-rust-3-"));
  const nodeLog = join(dir, "node.jsonl");
  const rustLog = join(dir, "rust.jsonl");
  await drive("node", ["dist/index.js", "wrap", "--log", nodeLog, "--", "node", ...SINK], lines);
  await drive(RUST, ["--log", rustLog, "--", "node", ...SINK], lines);
  return { node: c2sMessages(nodeLog), rust: c2sMessages(rustLog) };
}

// Representatives of every formerly-divergent class that is now fixed. The
// trailing comment is the asymmetry the old substring heuristic got wrong.
const TIGHTENED: { line: string; why: string }[] = [
  { line: '[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]', why: "batch array: tokens live inside array elements" },
  { line: '{"jsonrpc":"2.0","method":"notifications/progress","params":{"id":5}}', why: "nested id under params" },
  { line: '{"id":1,"result":{"method":"x"}}', why: "nested method under result" },
  { line: '{"id":4,"result":{"error":null}}', why: "nested error under result" },
  { line: '{"id":1,"result":"method"}', why: 'string VALUE equal to "method"' },
  { line: '{"jsonrpc":"2.0","error":{"code":-32600,"message":"bad"}}', why: "error without id" },
  { line: '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"p"}}', why: "id:null is not an id" },
  { line: '{"id":null,"method":"notify"}', why: "id:null + method -> notification not request" },
  { line: '{"id":0}', why: "id present (0) but no result/error -> unknown" },
  { line: '{"jsonrpc":"2.0","id":7}', why: "bare id, no result/error -> unknown" },
  { line: '{"id":1,"id":null,"method":"go"}', why: "duplicate id, last (null) wins -> notification" },
];

test("native classifier now AGREES with Node on the formerly-divergent classes", async (t) => {
  if (!existsSync(RUST)) {
    t.skip("rust binary not built (native/mcpgaze-proxy/target/release/mcpgaze-proxy)");
    return;
  }
  const lines = TIGHTENED.map((c) => c.line);
  const { node, rust } = await bothProxies(lines);

  assert.equal(node.length, lines.length, `node observed ${node.length}/${lines.length} c2s lines`);
  assert.equal(rust.length, lines.length, `rust observed ${rust.length}/${lines.length} c2s lines`);

  for (let i = 0; i < lines.length; i++) {
    assert.equal(
      rust[i].kind,
      node[i].kind,
      `KIND mismatch for ${TIGHTENED[i].why}\n  line: ${lines[i]}\n  node=${node[i].kind} rust=${rust[i].kind}`,
    );
    assert.equal(
      rust[i].method,
      node[i].method,
      `METHOD mismatch for ${TIGHTENED[i].why}\n  line: ${lines[i]}\n  node=${JSON.stringify(node[i].method)} rust=${JSON.stringify(rust[i].method)}`,
    );
  }
});

test("accepted residual: a \\uXXXX-escaped method VALUE still differs (kind agrees)", async (t) => {
  if (!existsSync(RUST)) {
    t.skip("rust binary not built");
    return;
  }
  // "method":"ping" decodes to "ping". The parse-free scanner
  // does NOT decode \u escapes (by design — see KNOWN-ISSUES.md "method VALUE
  // fidelity"), so it records the raw escapes while Node records the decoded text.
  const line = '{"jsonrpc":"2.0","id":1,"method":"\\u0070\\u0069\\u006e\\u0067"}';
  const { node, rust } = await bothProxies([line]);

  assert.equal(node.length, 1);
  assert.equal(rust.length, 1);
  // The CLASSIFICATION agrees (this is the part the fix guarantees)...
  assert.equal(rust[0].kind, node[0].kind, "kind should agree (both request)");
  assert.equal(rust[0].kind, "request");
  // ...but the extracted method value is the documented, accepted divergence.
  assert.equal(node[0].method, "ping", "Node decodes the \\u escapes");
  assert.equal(rust[0].method, "\\u0070\\u0069\\u006e\\u0067", "Rust keeps them verbatim");
  assert.notEqual(
    rust[0].method,
    node[0].method,
    "if this no longer diverges the parse-free residual was closed — update KNOWN-ISSUES.md and this test",
  );
});
