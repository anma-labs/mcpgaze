import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LineFramer } from "./framer";
import type { JsonRpcError } from "./jsonrpc";

export interface RawResponse {
  result?: unknown;
  error?: JsonRpcError;
}

interface Waiter {
  resolve: (v: RawResponse) => void;
  reject: (e: Error) => void;
}

/**
 * A minimal MCP client connection over stdio. Unlike `probeServer`, it exposes
 * raw request/notify primitives so higher layers (conformance, behavioral
 * verify) can drive arbitrary methods and inspect error responses without them
 * being thrown. Transport/timeout problems reject; JSON-RPC error *responses*
 * resolve as `{ error }` so callers can assert on codes.
 */
export class McpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Waiter>();
  private readonly framer: LineFramer;
  private nextId = 1;
  private stderrBuf = "";
  private closed = false;

  private constructor(command: string, args: string[], env?: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env });
    this.child.stdin.on("error", () => {});
    // A spawn failure (ENOENT / EACCES / non-executable) emits an async 'error'
    // event on the ChildProcess. With no listener it becomes an uncaught
    // exception and crashes the process; surface it as a clean rejection of every
    // in-flight request instead (mirrors proxy.ts's child 'error' handling).
    this.child.on("error", (err: Error) => {
      this.closed = true;
      for (const w of this.pending.values()) w.reject(err instanceof Error ? err : new Error(String(err)));
      this.pending.clear();
    });
    this.child.stderr.on("data", (c: Buffer) => {
      this.stderrBuf += c.toString("utf8");
    });
    this.framer = new LineFramer((f) => {
      if (!f.msg || f.msg.method !== undefined) return;
      // request() only ever issues strictly-integer ids (nextId++). Match the
      // response by exact value AND type — never via Number() coercion, which
      // would let a server-supplied id of "1" / 1.0 / true resolve the wrong
      // waiter and cross-wire one request's response onto another.
      const id = f.msg.id;
      if (typeof id !== "number" || !Number.isInteger(id)) return;
      const w = this.pending.get(id);
      if (!w) return;
      this.pending.delete(id);
      w.resolve({ result: f.msg.result, error: f.msg.error });
    }, "s2c");
    this.child.stdout.on("data", (c: Buffer) => this.framer.push(c));
    this.child.on("exit", () => {
      this.closed = true;
      for (const w of this.pending.values()) w.reject(new Error("server exited"));
      this.pending.clear();
    });
  }

  static spawn(command: string, args: string[], env?: NodeJS.ProcessEnv): McpConnection {
    return new McpConnection(command, args, env);
  }

  get stderr(): string {
    return this.stderrBuf;
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<RawResponse> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise<RawResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const tail = this.stderrBuf.trim();
        reject(
          new Error(
            `timed out after ${timeoutMs}ms on "${method}"` +
              (tail ? `\n--- server stderr ---\n${tail}` : ""),
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    this.closed = true;
    this.child.kill();
  }
}
