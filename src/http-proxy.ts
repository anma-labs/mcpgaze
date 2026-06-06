import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Correlator } from "./proxy";
import { SseParser } from "./sse";
import type { FramedMessage, Direction } from "./framer";
import type { JsonRpcMessage } from "./jsonrpc";
import type { Logger } from "./logger";

export interface Route {
  /** Local path prefix to match, e.g. "/github" or "/" (catch-all). */
  prefix: string;
  /** Full upstream MCP endpoint, e.g. http://localhost:3001/mcp */
  upstream: string;
}

export interface HttpWrapOptions {
  routes: Route[]; // one or more path-prefix → upstream mappings
  host: string; // bind host (default 127.0.0.1 — never 0.0.0.0 by default)
  port: number; // bind port (0 = ephemeral)
  logger: Logger;
  /** If set, only these browser Origins are allowed. Otherwise only localhost. */
  allowedOrigins?: string[];
}

export interface HttpProxyHandle {
  port: number;
  close: () => Promise<void>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isAllowedOrigin(origin: string | undefined, allowed?: string[]): boolean {
  if (!origin) return true; // non-browser clients send no Origin
  if (allowed) return allowed.includes(origin);
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * If `pathname` falls under `prefix`, return the remainder after the prefix
 * (starting with "/", or "" for an exact match); otherwise null. Prefix "/" is
 * a catch-all whose remainder is the whole pathname.
 */
export function matchRemainder(prefix: string, pathname: string): string | null {
  if (prefix === "/") return pathname === "/" ? "" : pathname;
  if (pathname === prefix) return "";
  if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length);
  return null;
}

export interface RouteMatch {
  upstream: string;
  remainder: string;
  prefix: string;
}

/** Longest-prefix-wins routing. Returns the matched upstream + path remainder. */
export function resolveRoute(routes: Route[], pathname: string): RouteMatch | null {
  let best: RouteMatch | null = null;
  for (const r of routes) {
    const remainder = matchRemainder(r.prefix, pathname);
    if (remainder === null) continue;
    if (!best || r.prefix.length > best.prefix.length) {
      best = { upstream: r.upstream, remainder, prefix: r.prefix };
    }
  }
  return best;
}

/** upstream base + remainder path (nginx-style), preserving the client query. */
export function buildTarget(upstream: string, remainder: string, search: string): string {
  const u = new URL(upstream);
  if (remainder) u.pathname = u.pathname.replace(/\/+$/, "") + remainder;
  if (search) u.search = search;
  return u.toString();
}

/** Build a single catch-ish route from a bare --upstream URL: mount at its path. */
export function routeFromUpstream(upstream: string): Route {
  const p = new URL(upstream).pathname;
  return { prefix: p && p !== "" ? p : "/", upstream };
}

/** Assemble routes from CLI inputs. `--route prefix=url` (repeatable) + --upstream. */
export function buildRoutes(upstream: string | undefined, routeSpecs: string[]): Route[] {
  const routes: Route[] = [];
  for (const spec of routeSpecs) {
    const eq = spec.indexOf("=");
    if (eq < 0) throw new Error(`bad --route "${spec}" (expected prefix=url)`);
    const prefix = spec.slice(0, eq);
    const url = spec.slice(eq + 1);
    if (!prefix.startsWith("/")) throw new Error(`route prefix must start with "/": "${prefix}"`);
    new URL(url); // validate
    routes.push({ prefix, upstream: url });
  }
  if (upstream) {
    new URL(upstream); // validate
    routes.push(routeFromUpstream(upstream));
  }
  if (routes.length === 0) throw new Error("no upstream configured (use --upstream or --route)");
  return routes;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forwardHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (["host", "connection", "content-length", "accept-encoding"].includes(lk)) continue;
    if (typeof v === "string") h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(", "));
  }
  h.set("accept-encoding", "identity"); // keep bodies parseable for observation
  return h;
}

function observe(raw: string, dir: Direction, correlator: Correlator): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const f: FramedMessage = { direction: dir, raw, msg: null, parseError: (e as Error).message };
    dir === "c2s" ? correlator.onClientToServer(f) : correlator.onServerToClient(f);
    return;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]; // tolerate legacy batches
  for (const m of list) {
    const f: FramedMessage = { direction: dir, raw, msg: m as JsonRpcMessage };
    dir === "c2s" ? correlator.onClientToServer(f) : correlator.onServerToClient(f);
  }
}

export function runHttpProxy(opts: HttpWrapOptions): Promise<HttpProxyHandle> {
  const correlator = new Correlator(opts.logger);
  const seenSessions = new Set<string>();
  const seenTargets = new Set<string>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Swallow client-side write errors (EPIPE on disconnect) so they never crash
    // the proxy via an unhandled 'error' event on the response stream.
    res.on("error", () => {});
    void handle(req, res).catch((e: unknown) => {
      opts.logger.note("proxy-error", (e as Error).message);
      if (res.writableEnded) return;
      if (res.headersSent) {
        // A response is already streaming (e.g. mid-SSE): NEVER write a diagnostic
        // body into it — that would inject non-protocol bytes onto the wire and
        // break byte-exact forwarding. Just end the stream.
        res.end();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("mcpgaze: upstream error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Security: reject cross-origin browser requests (DNS-rebinding defense).
    if (!isAllowedOrigin(req.headers.origin, opts.allowedOrigins)) {
      opts.logger.note("origin-rejected", String(req.headers.origin));
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden origin");
      return;
    }

    // Route by path prefix to the matching upstream.
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const match = resolveRoute(opts.routes, reqUrl.pathname);
    if (!match) {
      opts.logger.note("no-route", reqUrl.pathname);
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`mcpgaze: no route for ${reqUrl.pathname}`);
      return;
    }
    const target = buildTarget(match.upstream, match.remainder, reqUrl.search);
    if (!seenTargets.has(target)) {
      seenTargets.add(target);
      opts.logger.note("route", `${match.prefix} → ${target}`);
    }

    const method = req.method ?? "GET";
    const body = method === "POST" || method === "DELETE" ? await readBody(req) : undefined;
    if (body && body.length) observe(body.toString("utf8"), "c2s", correlator);

    const upstream = await fetch(target, {
      method,
      headers: forwardHeaders(req),
      body: body && body.length ? body : undefined,
      redirect: "manual",
    });

    const sid = upstream.headers.get("mcp-session-id");
    if (sid && !seenSessions.has(sid)) {
      seenSessions.add(sid);
      opts.logger.note("session", `Mcp-Session-Id=${sid}`);
    }

    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (["transfer-encoding", "content-encoding", "connection", "content-length"].includes(k)) return;
      headers[k] = v;
    });

    const ct = upstream.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream") && upstream.body) {
      res.writeHead(upstream.status, headers);
      const sse = new SseParser((data) => observe(data, "s2c", correlator));
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value); // exact upstream bytes
          res.write(buf); // forward first
          try {
            sse.push(buf);
          } catch (e) {
            opts.logger.note("observer-error", `sse ${(e as Error).message}`);
          }
        }
      } catch (e) {
        // Upstream tore down mid-stream. Headers are already sent, so we can only
        // close the response cleanly — never surface this as a top-level reject,
        // which would inject a diagnostic body into the live SSE wire.
        opts.logger.note("sse-upstream-error", (e as Error).message);
      } finally {
        await reader.cancel().catch(() => {}); // release the upstream reader
      }
      res.end();
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, headers);
      res.end(buf); // byte-exact
      if (buf.length) observe(buf.toString("utf8"), "s2c", correlator);
    }
  }

  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            opts.logger.close();
            server.close(() => r());
          }),
      });
    });
  });
}
