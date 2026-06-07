import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { runHttpProxy, isAllowedOrigin, resolveRoute, buildTarget, matchRemainder, buildRoutes, routeFromUpstream, type HttpProxyHandle } from "../http-proxy";
import { Logger } from "../logger";

test("matchRemainder: prefix matching and remainders", () => {
  assert.equal(matchRemainder("/github", "/github"), "");
  assert.equal(matchRemainder("/github", "/github/mcp"), "/mcp");
  assert.equal(matchRemainder("/github", "/githubx"), null);
  assert.equal(matchRemainder("/", "/anything/here"), "/anything/here");
  assert.equal(matchRemainder("/", "/"), "");
});

test("resolveRoute: longest prefix wins", () => {
  const routes = [
    { prefix: "/", upstream: "http://a/" },
    { prefix: "/api", upstream: "http://b/mcp" },
    { prefix: "/api/v2", upstream: "http://c/mcp" },
  ];
  assert.equal(resolveRoute(routes, "/api/v2/x")?.upstream, "http://c/mcp");
  assert.equal(resolveRoute(routes, "/api/foo")?.upstream, "http://b/mcp");
  assert.equal(resolveRoute(routes, "/other")?.upstream, "http://a/");
});

test("buildTarget: appends remainder and preserves query", () => {
  assert.equal(buildTarget("http://h:3/mcp", "", ""), "http://h:3/mcp");
  assert.equal(buildTarget("http://h:3/mcp", "/sub", ""), "http://h:3/mcp/sub");
  assert.equal(buildTarget("http://h:3/mcp", "", "?a=1"), "http://h:3/mcp?a=1");
});

test("buildRoutes: --upstream becomes a route at its own path; bad --route throws", () => {
  assert.deepEqual(routeFromUpstream("http://h:3/mcp"), { prefix: "/mcp", upstream: "http://h:3/mcp", forwardCredentials: true });
  assert.deepEqual(routeFromUpstream("http://h:3"), { prefix: "/", upstream: "http://h:3", forwardCredentials: true });
  const rs = buildRoutes("http://h:3/mcp", ["/gh=http://h:4/mcp"]);
  assert.equal(rs.length, 2);
  assert.throws(() => buildRoutes(undefined, ["no-equals"]), /bad --route/);
  assert.throws(() => buildRoutes(undefined, ["gh=http://x"]), /must start with/);
  assert.throws(() => buildRoutes(undefined, []), /no upstream/);
});

test("isAllowedOrigin: no origin allowed; localhost allowed; remote rejected", () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9"), true);
  assert.equal(isAllowedOrigin("https://evil.example.com"), false);
  assert.equal(isAllowedOrigin("https://evil.example.com", ["https://evil.example.com"]), true);
});

function startUpstream(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = body ? JSON.parse(body) : {};
        if (msg.method === "tools/list") {
          const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-123" });
          res.end(payload);
        } else if (msg.method === "stream/it") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { part: 1 } })}\n\n`);
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`);
          res.end();
        } else {
          res.writeHead(404).end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

test("proxies a JSON response byte-exact and observes it", async () => {
  const up = await startUpstream();
  // Capture observations via onEvent (synchronous, in-process) instead of reading
  // the async JSONL after a fixed delay. For a non-SSE response the proxy forwards
  // byte-exact and ends the response BEFORE observing s2c (invariant A: forward
  // first), so the s2c event can land just after res.text() resolves — wait on the
  // deterministic onEvent signal rather than a fixed window.
  const observed: Array<Record<string, unknown>> = [];
  let onObserve = () => {};
  const logger = new Logger({ onEvent: (ev) => { observed.push(ev); onObserve(); } });
  const until = (pred: () => boolean, ms = 5000): Promise<void> =>
    pred()
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            onObserve = () => {};
            reject(new Error(`timed out waiting for observation: ${JSON.stringify(observed)}`));
          }, ms);
          onObserve = () => {
            if (pred()) { clearTimeout(timer); onObserve = () => {}; resolve(); }
          };
        });
  let proxy: HttpProxyHandle | undefined;
  try {
    proxy = await runHttpProxy({ routes: [routeFromUpstream(up.url)], host: "127.0.0.1", port: 0, logger });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    assert.equal(res.headers.get("mcp-session-id"), "sess-123");
    assert.deepEqual(JSON.parse(text), { jsonrpc: "2.0", id: 1, result: { tools: [] } });

    // The s2c response is recorded just after the response is ended; the c2s
    // request and the session note land no later. Wait on that deterministic
    // signal, then assert the same facts the JSONL check used to.
    await until(() => observed.some((e) => e.type === "message" && e.dir === "s2c"));
    const msgs = observed.filter((e) => e.type === "message");
    assert.ok(
      msgs.some((e) => e.dir === "c2s" && e.method === "tools/list"),
      `expected the tools/list request observed c2s; got ${JSON.stringify(msgs)}`,
    );
    assert.ok(
      msgs.some((e) => e.dir === "s2c"),
      `expected the response observed s2c; got ${JSON.stringify(msgs)}`,
    );
    assert.ok(
      observed.some((e) => e.type === "note" && typeof e.detail === "string" && (e.detail as string).includes("sess-123")),
      `expected the session-id note recorded; got ${JSON.stringify(observed)}`,
    );
  } finally {
    await proxy?.close();
    up.server.close();
  }
});

test("proxies an SSE stream and observes each event", async () => {
  const up = await startUpstream();
  // Deterministic signal: capture observations via the logger's onEvent hook,
  // which fires synchronously inside the proxy's SSE read loop (sse.push →
  // observe → logger.message → onEvent) BEFORE the response is ended. So by the
  // time `res.text()` resolves, every event the proxy observed is already in
  // `observed`. The old check read the JSONL after a fixed 50ms — but the write
  // stream is async, so under load the file wasn't even created yet (ENOENT) /
  // not flushed within the window. onEvent removes the race at its source.
  const observed: Array<Record<string, unknown>> = [];
  const logger = new Logger({ onEvent: (ev) => observed.push(ev) });
  let proxy: HttpProxyHandle | undefined;
  try {
    proxy = await runHttpProxy({ routes: [routeFromUpstream(up.url)], host: "127.0.0.1", port: 0, logger });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "stream/it", params: {} }),
    });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /data: /); // SSE framing forwarded intact
    assert.match(body, /"part":1/);

    // Both the result event and the progress notification must be observed s2c.
    const s2c = observed.filter((e) => e.type === "message" && e.dir === "s2c");
    assert.ok(
      s2c.some((e) => typeof e.raw === "string" && (e.raw as string).includes('"part":1')),
      `expected the SSE result event observed s2c; got ${JSON.stringify(s2c)}`,
    );
    assert.ok(
      s2c.some((e) => e.method === "notifications/progress"),
      `expected the progress notification observed s2c; got ${JSON.stringify(s2c)}`,
    );
  } finally {
    await proxy?.close();
    up.server.close();
  }
});

test("rejects a cross-origin browser request with 403", async () => {
  const up = await startUpstream();
  const logger = new Logger({});
  let proxy: HttpProxyHandle | undefined;
  try {
    proxy = await runHttpProxy({ routes: [routeFromUpstream(up.url)], host: "127.0.0.1", port: 0, logger });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  } finally {
    await proxy?.close();
    up.server.close();
  }
});

function startNamedUpstream(name: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = body ? JSON.parse(body) : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { server: name } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

test("routes by path prefix to the correct upstream", async () => {
  const a = await startNamedUpstream("alpha");
  const b = await startNamedUpstream("bravo");
  const logger = new Logger({});
  let proxy: HttpProxyHandle | undefined;
  try {
    proxy = await runHttpProxy({
      routes: [
        { prefix: "/a", upstream: a.url },
        { prefix: "/b", upstream: b.url },
      ],
      host: "127.0.0.1",
      port: 0,
      logger,
    });
    const call = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${proxy!.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: {} }),
      });
      return (await res.json()) as { result?: { server?: string } };
    };
    assert.equal((await call("/a")).result?.server, "alpha");
    assert.equal((await call("/b")).result?.server, "bravo");

    const r404 = await fetch(`http://127.0.0.1:${proxy.port}/nope`, { method: "POST", body: "{}" });
    assert.equal(r404.status, 404);
  } finally {
    await proxy?.close();
    a.server.close();
    b.server.close();
  }
});
