import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { LineFramer, type FramedMessage } from "./framer";
import { classify, hasId } from "./jsonrpc";
import type { Logger } from "./logger";

export interface WrapOptions {
  command: string;
  args: string[];
  logger: Logger;
  /** Optional: receive matched request/response pairs (used by `record`). */
  onInteraction?: (pair: { request: PairedRequest; response: PairedResponse }) => void;
  /** Mirror the server's stderr through to our stderr (default true). Off in TUI mode. */
  mirrorStderr?: boolean;
}

interface Pending {
  method: string;
  params: unknown;
  at: number;
}

export interface PairedRequest {
  method: string;
  params: unknown;
}
export interface PairedResponse {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export type OnPair = (req: PairedRequest, res: PairedResponse) => void;

/**
 * Matches responses to requests by JSON-RPC id, measuring round-trip latency
 * and surfacing requests that never got an answer (a common, normally-invisible
 * failure mode). Optionally emits matched request/response pairs, which the
 * cassette recorder uses. Exported for unit testing.
 */
export class Correlator {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly logger: Logger,
    private readonly onPair?: OnPair,
  ) {}

  onClientToServer(f: FramedMessage): void {
    this.logger.message(f);
    if (f.msg && classify(f.msg) === "request" && hasId(f.msg)) {
      this.pending.set(String(f.msg.id), {
        method: f.msg.method ?? "",
        params: f.msg.params,
        at: performance.now(),
      });
    }
  }

  onServerToClient(f: FramedMessage): void {
    let latency: number | undefined;
    if (f.msg && hasId(f.msg) && f.msg.method === undefined) {
      const key = String(f.msg.id);
      const p = this.pending.get(key);
      if (p) {
        latency = performance.now() - p.at;
        this.pending.delete(key);
        this.onPair?.(
          { method: p.method, params: p.params },
          { result: f.msg.result, error: f.msg.error },
        );
      }
    }
    this.logger.message(f, latency);
  }

  reportOrphans(): void {
    for (const [id, p] of this.pending) {
      this.logger.note(
        "orphan-request",
        `id=${id} method=${p.method} never received a response`,
      );
    }
  }
}

/**
 * Spawn the real server and sit transparently between it and the client.
 *
 * INVARIANT: on each hot path we forward the original chunk byte-exact FIRST,
 * then hand a copy to an observer that can fail harmlessly. We rely on Node's
 * pipe() for backpressure and only *observe* via an extra data listener, which
 * is wrapped so an observer error can never disturb the protocol stream.
 */
export function runProxy(opts: WrapOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const correlator = new Correlator(
      opts.logger,
      opts.onInteraction
        ? (request, response) => opts.onInteraction!({ request, response })
        : undefined,
    );

    // Swallow EPIPE-style errors that happen during shutdown races. process.stderr
    // is included because we mirror the child's stderr through it (below); if the
    // consumer reading our stderr goes away mid-flood, that write must never throw
    // an unhandled 'error' and tear down the wire.
    child.stdin.on("error", () => {});
    process.stdout.on("error", () => {});
    process.stderr.on("error", () => {});

    // client (our stdin) -> server (child stdin): forward, then observe.
    process.stdin.pipe(child.stdin);
    const c2s = new LineFramer((m) => correlator.onClientToServer(m), "c2s");
    process.stdin.on("data", (chunk: Buffer) => {
      try {
        c2s.push(chunk);
      } catch (e) {
        opts.logger.note("observer-error", `c2s ${(e as Error).message}`);
      }
    });

    // server (child stdout) -> client (our stdout): forward, then observe.
    // end:false so we never try to close the shared process.stdout.
    child.stdout.pipe(process.stdout, { end: false });
    const s2c = new LineFramer((m) => correlator.onServerToClient(m), "s2c");
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        s2c.push(chunk);
      } catch (e) {
        opts.logger.note("observer-error", `s2c ${(e as Error).message}`);
      }
    });

    // server stderr -> side channel. We mirror it through to OUR stderr so that
    // a wrapping client still sees the server's logs exactly as before, and we
    // also record it (correlated by time) in the structured log.
    child.stderr.on("data", (chunk: Buffer) => {
      if (opts.mirrorStderr !== false) {
        try {
          process.stderr.write(chunk);
        } catch (e) {
          // Mirror is an observer: a synchronous throw here (e.g.
          // ERR_STREAM_DESTROYED after our stderr reader vanished mid-flood and
          // the async 'error' already destroyed the stream) must never tear down
          // the wire. Route it like the c2s/s2c observer paths.
          opts.logger.note("observer-error", `stderr-mirror ${(e as Error).message}`);
        }
      }
      opts.logger.serverStderr(chunk.toString("utf8"));
    });

    // Lifecycle.
    process.stdin.on("end", () => child.stdin.end());

    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => child.kill(sig));
    }

    child.on("error", (err) => {
      opts.logger.note("spawn-error", err.message);
      opts.logger.close();
      resolve(127);
    });

    child.on("exit", (code, signal) => {
      correlator.reportOrphans();
      opts.logger.note("server-exit", `code=${String(code)} signal=${String(signal)}`);
      opts.logger.close();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
