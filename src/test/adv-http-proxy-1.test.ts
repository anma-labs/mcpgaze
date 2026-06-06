import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { runHttpProxy, routeFromUpstream, type HttpProxyHandle } from "../http-proxy";
import { Logger } from "../logger";

// Upstream that writes a valid SSE prelude, then destroys the socket
// mid-stream (simulating an upstream RST / crash while streaming).
function startDyingUpstream(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // One complete, well-framed SSE event the client should receive intact.
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { part: 1 } })}\n\n`);
        // Abruptly tear down the connection mid-stream so the proxy's
        // upstream.body reader.read() rejects after headers are already sent.
        setTimeout(() => res.socket?.destroy(), 50);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

// Invariant (A) BYTE-EXACT FORWARD: bytes forwarded to the client must be
// exactly the bytes the upstream produced. The proxy must never inject its
// own diagnostic text ("mcpgaze: upstream error") into the live wire body.
//
// Defect: when the upstream dies mid-SSE-stream, reader.read() rejects after
// res.writeHead() (http-proxy.ts:205) has already sent headers. The rejection
// escapes handle() and lands in the top-level catch (http-proxy.ts:149-153),
// where res.end("mcpgaze: upstream error") (line 152) runs UNCONDITIONALLY,
// appending that literal string to the already-open SSE response body.
test("SSE: upstream dying mid-stream must NOT inject 'mcpgaze: upstream error' into the wire", async () => {
  const up = await startDyingUpstream();
  const logger = new Logger({});
  let proxy: HttpProxyHandle | undefined;
  try {
    proxy = await runHttpProxy({ routes: [routeFromUpstream(up.url)], host: "127.0.0.1", port: 0, logger });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "stream/it", params: {} }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    // Drain the body. The upstream RST may surface as a read error on the
    // client side; that is acceptable (the connection genuinely ended). What is
    // NOT acceptable is the proxy fabricating non-protocol bytes in the body.
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let received = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += dec.decode(value, { stream: true });
      }
    } catch {
      // truncated upstream connection — fine; we only care about injected bytes
    }

    // The real upstream event must be forwarded byte-exact...
    assert.match(received, /"result":\{"part":1\}/);
    // ...and the proxy must NOT have appended its own error string to the wire.
    assert.ok(
      !received.includes("mcpgaze: upstream error"),
      `proxy injected non-protocol bytes into the SSE wire: ${JSON.stringify(received)}`,
    );
  } finally {
    await proxy?.close();
    up.server.close();
  }
});
