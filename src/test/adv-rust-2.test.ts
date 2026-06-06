// Adversarial verifier test for candidate rust-2.
//
// Claim: the Rust hot-path proxy (native/mcpgaze-proxy/src/main.rs:137) trims
// each observed line with Rust's str::trim(), which strips only Unicode
// White_Space code points. U+FEFF (BOM / ZERO WIDTH NO-BREAK SPACE) is NOT
// White_Space, so Rust KEEPS it in the recorded `raw` field. The Node observer
// (src/framer.ts:38) uses JavaScript String.prototype.trim(), which DOES strip
// U+FEFF. So a line with a leading BOM produces a DIFFERENT `raw` field in the
// two observation logs -- the differential oracle (scripts/diff-proxies.mjs:36)
// asserts n[i].raw === r[i].raw, which this breaks.
//
// This test drives the SAME bytes through both proxies and asserts their
// recorded `raw` agree (the correct/expected behavior). Against the current
// code it FAILS, demonstrating the cross-proxy observation divergence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUST = "native/mcpgaze-proxy/target/release/mcpgaze-proxy";
const MOCK = "src/test/mock-server.mjs";

// A single JSON-RPC request line with a LEADING UTF-8 BOM (EF BB BF) before the
// JSON, terminated by '\n'. The bytes on the wire are forwarded byte-exact by
// both proxies; only the recorded observation `raw` should match too.
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const JSON_LINE = Buffer.from(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
);
const INPUT = Buffer.concat([BOM, JSON_LINE, Buffer.from("\n")]);

function drive(cmd: string, args: string[], input: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", reject);
    p.on("exit", () => resolve());
    p.stdin.write(input);
    // Give the server a moment to respond, then close stdin so it exits.
    setTimeout(() => p.stdin.end(), 300);
  });
}

function c2sRaws(path: string): string[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "message" && e.dir === "c2s")
    .map((e) => e.raw as string);
}

test("Node and Rust proxies record identical `raw` for a line with a leading BOM", async (t) => {
  if (!existsSync(RUST)) {
    t.skip("rust binary not built (native/mcpgaze-proxy/target/release/mcpgaze-proxy)");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "adv-rust-2-"));
  const nodeLog = join(dir, "node.jsonl");
  const rustLog = join(dir, "rust.jsonl");

  await drive("node", ["dist/index.js", "wrap", "--log", nodeLog, "--", "node", MOCK], INPUT);
  await drive(RUST, ["--log", rustLog, "--", "node", MOCK], INPUT);

  const nodeRaw = c2sRaws(nodeLog);
  const rustRaw = c2sRaws(rustLog);

  // Both proxies must observe exactly one c2s request line.
  assert.equal(nodeRaw.length, 1, `node should record 1 c2s message, got ${nodeRaw.length}`);
  assert.equal(rustRaw.length, 1, `rust should record 1 c2s message, got ${rustRaw.length}`);

  // The recorded `raw` of the same wire line must agree across the two proxies.
  // (This is exactly what scripts/diff-proxies.mjs asserts.)
  assert.equal(
    rustRaw[0],
    nodeRaw[0],
    "Rust and Node disagree on the recorded `raw` for a BOM-prefixed line " +
      "(Rust str::trim keeps U+FEFF; Node String.prototype.trim strips it)",
  );
});
