import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpConnection } from "../mcp-connection";

/**
 * INVARIANT (A): a forwarded/correlated response must correspond to the request
 * that produced it. A caller that issued request X must NEVER be handed the
 * result bytes of a *different* in-flight request Y.
 *
 * mcp-connection.ts:43-45 looks up and deletes the pending waiter via
 * `this.pending.get(Number(f.msg.id))` / `this.pending.delete(Number(f.msg.id))`.
 * request() assigns strictly numeric ids (1, 2, 3, ...). Because the lookup
 * coerces the SERVER-supplied id with Number(), any server-supplied id that is
 * merely Number()-equal to a pending numeric id matches:
 *   Number("1") === Number(1) === Number("1.0") === Number("01") === 1.
 *
 * With two requests in flight (id 1 = "first", id 2 = "second"), a server that
 * answers request #2's call carrying the STRING id "1" resolves waiter #1 with
 * request #2's payload. Caller #1 thus receives bytes that belong to request #2
 * (cross-wired), and the real request #2 hangs until timeout.
 *
 * A correct implementation must compare the response id against the pending id
 * by value AND type (e.g. an exact `=== id` match, not a Number()-coerced one),
 * so a response carrying string id "1" does NOT satisfy numeric pending id 1.
 */
test("McpConnection does not cross-wire a response to the wrong in-flight request via Number(id) coercion", async () => {
  // Inline mock server: counts incoming requests. On the 2nd request it replies
  // with id as the STRING "1" (Number("1") === 1) and a distinctive payload that
  // identifies it as request #2's answer. It never legitimately answers id 1, so
  // any resolution of the "first" promise can only be the cross-wired #2 payload.
  const serverPath = join(
    tmpdir(),
    `adv-mcpconn-2-server-${process.pid}-${Date.now()}.mjs`,
  );
  writeFileSync(
    serverPath,
    `let count = 0;
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === undefined) continue; // ignore notifications
    count++;
    if (count === 2) {
      // Answer request #2, but tag the response with the STRING id "1".
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { answeredRequest: 2, value: "WRONG" } }) + "\\n",
      );
    }
  }
});
`,
  );

  const conn = McpConnection.spawn(process.execPath, [serverPath]);

  const settle = (which: number, p: Promise<{ result?: unknown; error?: unknown }>) =>
    p.then(
      (r) => ({ which, ok: true as const, r }),
      (e: Error) => ({ which, ok: false as const, err: e.message.split("\n")[0] }),
    );

  // Two concurrent in-flight requests: id 1 ("first"), id 2 ("second").
  const p1 = settle(1, conn.request("first", {}, 1200));
  const p2 = settle(2, conn.request("second", {}, 1200));

  const [a, b] = await Promise.all([p1, p2]);
  conn.close();
  rmSync(serverPath, { force: true });

  // INVARIANT (A): the "first" caller must NEVER receive request #2's payload.
  // Under the defect, p1 resolves with { result: { answeredRequest: 2, ... } }.
  const firstGotSecondsPayload =
    a.ok &&
    a.r &&
    typeof a.r.result === "object" &&
    a.r.result !== null &&
    (a.r.result as { answeredRequest?: number }).answeredRequest === 2;

  assert.ok(
    !firstGotSecondsPayload,
    `INVARIANT A VIOLATION: caller "first" (numeric id 1) was handed request #2's ` +
      `payload because mcp-connection.ts:43-45 matched the server's STRING id "1" via ` +
      `Number("1") === 1.\n  p1 = ${JSON.stringify(a)}\n  p2 = ${JSON.stringify(b)}`,
  );
});
