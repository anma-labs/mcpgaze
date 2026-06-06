import { test } from "node:test";
import assert from "node:assert/strict";
import { healthCheckOnce } from "../health";

/**
 * Invariant (B): the observer/health path must never crash the process.
 *
 * healthCheckOnce is documented as "Never throws". But McpConnection's
 * constructor (src/mcp-connection.ts:30-50) registers listeners on
 * child.stdin/stderr/stdout/exit but NEVER on child 'error'. When the server
 * command cannot be spawned (ENOENT), Node emits an 'error' event on the
 * ChildProcess on a later tick; with no listener it is rethrown as an uncaught
 * exception, taking the whole process down. This async crash is NOT caught by
 * the try/catch in healthCheckOnce, so the function neither returns {ok:false}
 * nor rejects — it crashes the proxy.
 *
 * Against the unfixed code this test crashes the worker (the await never
 * settles). A correct fix makes healthCheckOnce resolve to {ok:false}.
 */
test("healthCheckOnce resolves {ok:false} for an unspawnable command (does not crash)", async () => {
  const result = await healthCheckOnce("definitely_not_a_real_command_xyz", [], 1000);
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});
