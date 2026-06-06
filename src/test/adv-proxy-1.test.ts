import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const cli = join(repoRoot, "dist", "index.js");
const floodServer = join(__dirname, "mock-server-stderr-flood.mjs");

/**
 * INVARIANT (B): an error in the observation/mirror path must never crash the proxy.
 *
 * proxy.ts:135-138 mirrors the child's stderr through to the proxy's own
 * process.stderr (line 136: `process.stderr.write(chunk)`), but installs NO
 * 'error' handler on process.stderr (line 107 only guards process.stdout).
 * When the consumer reading the proxy's stderr disappears mid-flood, the write
 * raises an unhandled 'error' (EPIPE / "write after end"). With no
 * process.on('uncaughtException') anywhere, the proxy process is torn down.
 *
 * We use a child that floods its own stderr and SURVIVES EPIPE on it and never
 * exits, so the only way the proxy can exit non-zero (without a graceful
 * "server-exit") is the proxy itself crashing on the mirror path.
 */
test("proxy survives losing its stderr reader mid-flood (mirror path never crashes the wire)", async () => {
  const logPath = join(tmpdir(), `adv-proxy-1-${process.pid}-${Date.now()}.jsonl`);

  const proxy = spawn(
    "node",
    [cli, "wrap", "--log", logPath, "--", "node", floodServer],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let got = 0;
  let destroyed = false;
  // Guard our OWN side of the pipe; we are simulating a reader that goes away.
  proxy.stderr.on("error", () => {});
  proxy.stderr.on("data", (c: Buffer) => {
    got += c.length;
    if (got > 300_000 && !destroyed) {
      destroyed = true;
      // The consumer of the proxy's stderr disappears. Subsequent
      // process.stderr.write() inside the proxy will hit a broken pipe.
      proxy.stderr.destroy();
    }
  });
  proxy.stdout.on("data", () => {});

  const result = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      let settled = false;
      const done = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      };
      proxy.on("exit", (code, signal) => done(code, signal));
      // The proxy SHOULD keep running (it survives) — so on the healthy path we
      // time out, kill it ourselves, and observe a SIGKILL (not a self-crash).
      setTimeout(() => {
        proxy.kill("SIGKILL");
      }, 2500);
    },
  );

  rmSync(logPath, { force: true });

  // Correct behavior: the observer/mirror path must not crash the proxy. The
  // ONLY ways the proxy should leave are (a) we SIGKILL it (signal === "SIGKILL",
  // code === null) or (b) a graceful exit propagated from the child (code 0).
  // A self-crash from the unhandled 'error' on process.stderr shows up as
  // code === 1, signal === null — which is the defect we are asserting against.
  assert.notEqual(
    result.code,
    1,
    `proxy crashed (code=1, signal=${result.signal}) — the stderr mirror path ` +
      `(proxy.ts:136 process.stderr.write) threw an unhandled 'error' and tore ` +
      `down the wire`,
  );
});
