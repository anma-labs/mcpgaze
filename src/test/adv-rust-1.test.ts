// Adversarial verifier test for candidate rust-1.
//
// Invariant under attack: (B) THE OBSERVER NEVER DISTURBS THE WIRE -- an error
// in the observation/analysis path must never crash the proxy.
//
// Claim: in the Rust hot-path proxy `pump()` the observer accumulates EVERY
// forwarded byte into an unbounded `Vec<u8>` (native/mcpgaze-proxy/src/main.rs:133
// `acc.extend_from_slice(&buf[..n])`) and only ever drains bytes up to a '\n'
// (main.rs:134 `while let Some(pos) = acc.iter().position(|&b| b == b'\n')`).
// A peer that streams bytes with NO newline makes `acc` grow without bound.
// Cargo.toml sets `panic = "abort"`, so when allocation fails Rust's
// alloc-error handler calls abort() (SIGABRT) and the whole proxy dies.
// The forward `write_all` at main.rs:129 happens BEFORE accumulation, so this is
// purely an observer-path crash -- violating invariant (B).
//
// This test runs the proxy under a small virtual-memory cap (ulimit -v) and
// drives a bounded, newline-free stream through it. A correctly-bounded
// observer would survive (the bytes are forwarded fine); the current code
// aborts with SIGABRT. We assert the proxy is NOT killed by a signal.
//
// A control case drives the SAME memory cap with small newline-terminated lines
// and asserts survival -- proving the cap itself is benign and that it is the
// missing newline (unbounded `acc`) that crashes the proxy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

const RUST = "native/mcpgaze-proxy/target/release/mcpgaze-proxy";

// 16 MB virtual-memory cap (in KB). The proxy starts and forwards fine under
// this cap when input is newline-terminated; a newline-free flood overflows the
// unbounded `acc` well before this and aborts.
const VM_CAP_KB = 16384;

// 32 MB of newline-free bytes -- far exceeds the cap once accumulated in `acc`.
const FLOOD_BYTES = 32 * 1024 * 1024;

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Spawn the rust proxy under a `ulimit -v` cap (applied ONLY to the proxy via
 * `bash -c "ulimit ...; exec ..."`), feed it `input`, and resolve with the
 * proxy's exit code/signal. The data-generating parent is NOT capped.
 */
function runCapped(logPath: string, input: Buffer): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const script = `ulimit -v ${VM_CAP_KB}; exec '${RUST}' --log '${logPath}' -- cat`;
    const p = spawn("bash", ["-c", script], { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", reject);
    p.on("exit", (code, signal) => resolve({ code, signal }));

    // Write the input respecting backpressure, then close stdin. If the proxy
    // dies mid-write the pipe breaks; swallow EPIPE so the harness itself does
    // not throw (we are testing the proxy, not this writer).
    p.stdin.on("error", () => {});
    p.stdin.write(input, () => {
      p.stdin.end();
    });
  });
}

test("Rust proxy observer must not crash the wire on a newline-free stream (unbounded acc)", async (t) => {
  if (!existsSync(RUST)) {
    t.skip("rust binary not built (native/mcpgaze-proxy/target/release/mcpgaze-proxy)");
    return;
  }
  if (platform() !== "linux") {
    t.skip("requires ulimit -v (linux)");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "adv-rust-1-"));

  // CONTROL: small newline-terminated lines under the SAME cap -> must survive.
  // ~512 KB delivered as 80-byte lines; `acc` never holds more than one line.
  const line = Buffer.from("A".repeat(79) + "\n");
  const controlChunks: Buffer[] = [];
  for (let i = 0; i < 512 * 1024 / line.length; i++) controlChunks.push(line);
  const control = Buffer.concat(controlChunks);
  const controlRes = await runCapped(join(dir, "control.jsonl"), control);
  assert.equal(
    controlRes.signal,
    null,
    `control (newline-terminated lines) was killed by signal ${controlRes.signal}; ` +
      `the memory cap itself should be benign`,
  );

  // ATTACK: same memory cap, a bounded newline-FREE flood. With a bounded
  // observer the proxy forwards these bytes and exits cleanly. The current
  // unbounded `acc` grows until allocation fails and `panic = "abort"` fires
  // SIGABRT, crashing the proxy -- violating invariant (B).
  const flood = Buffer.alloc(FLOOD_BYTES, 0x41); // 'A', no '\n'
  const floodRes = await runCapped(join(dir, "flood.jsonl"), flood);

  // SIGABRT shows as signal "SIGABRT" (or code 134 = 128+6 if reported as code).
  const killedBySignal = floodRes.signal !== null;
  const abortedByCode = floodRes.code === 134;
  assert.equal(
    killedBySignal || abortedByCode,
    false,
    `Rust proxy crashed on a newline-free observation stream ` +
      `(signal=${floodRes.signal}, code=${floodRes.code}). The observer's ` +
      `unbounded \`acc\` (main.rs:133) overflowed memory and \`panic = "abort"\` ` +
      `aborted the proxy. The observer must never crash the wire (invariant B).`,
  );
});
