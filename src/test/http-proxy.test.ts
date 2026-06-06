import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.deepEqual(routeFromUpstream("http://h:3/mcp"), { prefix: "/mcp", upstream: "http://h:3/mcp" });
  assert.deepEqual(routeFromUpstream("http://h:3"), { prefix: "/", upstream: "http://h:3" });
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
  const logPath = join(tmpdir(), `mcpgaze-http-${Date.now()}.jsonl`);
  const logger = new Logger({ jsonlPath: logPath });
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

    await new Promise((r) => setTimeout(r, 50));
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /"method":"tools\/list"/);
    assert.match(log, /"dir":"c2s"/);
    assert.match(log, /"dir":"s2c"/);
    assert.match(log, /sess-123/); // session-id note recorded
  } finally {
    await proxy?.close();
    up.server.close();
    rmSync(logPath, { force: true });
  }
});

test("proxies an SSE stream and observes each event", async () => {
  const up = await startUpstream();
  const logPath = join(tmpdir(), `mcpgaze-sse-${Date.now()}.jsonl`);
  const logger = new Logger({ jsonlPath: logPath });
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

    await new Promise((r) => setTimeout(r, 50));
    const log = readFileSync(logPath, "utf8");
    // Both the result event and the progress notification should be observed s2c.
    // (In the JSONL, raw payloads are JSON-escaped, so match unquoted substrings.)
    assert.match(log, /part/);
    assert.match(log, /notifications\/progress/);
  } finally {
    await proxy?.close();
    up.server.close();
    rmSync(logPath, { force: true });
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
