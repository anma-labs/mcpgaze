import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const connModule = join(repoRoot, "src", "mcp-connection.ts");

/**
 * INVARIANT (B): an error in the transport/observer path must NEVER crash the
 * process; transport problems must surface as a clean Promise rejection.
 *
 * mcp-connection.ts:30-50 — the McpConnection constructor attaches listeners for
 * child.stdin('error'), child.stderr('data'), child.stdout('data') and
 * child('exit'), but NEVER attaches child.on('error', ...). When the server
 * command cannot be exec'd (ENOENT / non-executable / EACCES), Node emits an
 * asynchronous 'error' event on the ChildProcess EventEmitter. With no listener
 * and no global process.on('uncaughtException'), this becomes an uncaught
 * "Unhandled 'error' event" that crashes the whole process. The try/catch around
 * `await conn.request(...)` in callers (verify.ts:35, conform.ts:152,
 * client.ts:34, health.ts:21) does NOT catch it because the throw happens on a
 * separate event-loop tick inside the EventEmitter, bypassing the awaited
 * promise. (Compare proxy.ts:147, which DOES attach child.on('error', ...).)
 *
 * We run the scenario in a subprocess so that the (defective) crash can be
 * observed as a non-zero exit code instead of taking down this test runner.
 * Correct behavior: request() rejects, the harness prints REJECTED and exits 0.
 */
test("McpConnection against an unlaunchable server rejects request() instead of crashing the process", async () => {
  const harness = join(
    tmpdir(),
    `adv-mcpconn-1-${process.pid}-${Date.now()}.mjs`,
  );
  // The harness imports the REAL module by absolute path and drives the exact
  // caller pattern: build a connection, then `await request().catch()`.
  writeFileSync(
    harness,
    `import { McpConnection } from ${JSON.stringify(connModule)};

const conn = McpConnection.spawn("this-binary-does-not-exist-xyz-123", []);
let rejected = false;
await conn
  .request("ping", {}, 1000)
  .then(() => {
    console.log("RESOLVED");
  })
  .catch((e) => {
    rejected = true;
    console.log("REJECTED: " + (e && e.message ? e.message.split("\\n")[0] : e));
  });
// Give any asynchronous child 'error' event a tick to fire.
await new Promise((r) => setTimeout(r, 300));
console.log(rejected ? "CLEAN" : "NO-REJECT");
process.exit(0);
`,
  );

  const child = spawn(
    process.execPath,
    ["--import", "tsx", harness],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

  const result = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
      setTimeout(() => child.kill("SIGKILL"), 5000);
    },
  );

  rmSync(harness, { force: true });

  // The transport path must not crash: the harness must exit 0 and report a
  // clean rejection. A code-1 exit with "Unhandled 'error' event" in stderr is
  // the defect (mcp-connection.ts: missing child.on('error')).
  assert.equal(
    result.code,
    0,
    `harness exited code=${result.code} signal=${result.signal} — the unhandled ` +
      `child 'error' event crashed the process instead of rejecting request().\n` +
      `stdout: ${stdout.trim()}\nstderr: ${stderr.trim().slice(0, 600)}`,
  );
  assert.ok(
    /CLEAN/.test(stdout),
    `expected request() to reject cleanly (stdout had "CLEAN"); got stdout=${JSON.stringify(
      stdout.trim(),
    )}`,
  );
  assert.ok(
    !/Unhandled 'error' event/.test(stderr),
    `process surfaced an unhandled 'error' event from the spawn failure: ${stderr
      .trim()
      .slice(0, 400)}`,
  );
});
