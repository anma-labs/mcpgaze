import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { classify, type MessageKind } from "./jsonrpc";
import type { FramedMessage } from "./framer";
import { color } from "./colors";

export interface LoggerOptions {
  /** Structured machine-readable sink (one JSON object per line). */
  jsonlPath?: string;
  /** Mirror a human-readable rendering to the pretty stream. */
  pretty?: boolean;
  /** Defaults to process.stderr. Never stdout in wrap mode — that is the wire. */
  prettyStream?: NodeJS.WritableStream;
  /** Observe every event (used to drive the live TUI). */
  onEvent?: (ev: Record<string, unknown>) => void;
}

type Event = Record<string, unknown> & { t: string; type: string };

/**
 * The observability side channel. Everything mcpgaze learns about the session
 * exits through here — a file and/or stderr — and NEVER through stdout, which
 * in wrap mode carries the live protocol bytes.
 */
export class Logger {
  private file?: WriteStream;
  private readonly pretty: boolean;
  private readonly out: NodeJS.WritableStream;
  private readonly onEvent?: (ev: Record<string, unknown>) => void;

  constructor(opts: LoggerOptions) {
    this.pretty = Boolean(opts.pretty);
    this.out = opts.prettyStream ?? process.stderr;
    this.onEvent = opts.onEvent;
    if (opts.jsonlPath) {
      mkdirSync(dirname(opts.jsonlPath), { recursive: true });
      this.file = createWriteStream(opts.jsonlPath, { flags: "a" });
      this.file.on("error", () => {});
    }
  }

  private write(ev: Event): void {
    this.file?.write(JSON.stringify(ev) + "\n");
    this.onEvent?.(ev);
  }

  message(f: FramedMessage, latencyMs?: number): void {
    const kind: MessageKind | "unparsed" = f.msg ? classify(f.msg) : "unparsed";
    const ev: Event = {
      t: new Date().toISOString(),
      type: "message",
      dir: f.direction,
      kind,
      id: f.msg?.id ?? null,
      method: f.msg?.method ?? null,
      latencyMs: latencyMs ?? null,
      parseError: f.parseError ?? null,
      raw: f.raw,
    };
    this.write(ev);
    if (this.pretty) this.renderMessage(ev, kind);
  }

  serverStderr(text: string): void {
    this.write({ t: new Date().toISOString(), type: "server_stderr", text });
    // Not re-rendered: the proxy already mirrors raw server stderr through.
  }

  note(code: string, detail: string): void {
    this.write({ t: new Date().toISOString(), type: "note", code, detail });
    if (this.pretty) this.out.write(color.dim(`• ${code}: ${detail}\n`));
  }

  private renderMessage(ev: Event, kind: string): void {
    const arrow =
      ev.dir === "c2s" ? color.cyan("→ to server  ") : color.green("← to client  ");
    const tag =
      kind === "error"
        ? color.red("ERROR")
        : kind === "request"
          ? color.bold("req")
          : kind === "response"
            ? "res"
            : kind === "notification"
              ? color.gray("notif")
              : color.yellow(kind);
    const id = ev.id !== null ? color.dim(`#${String(ev.id)} `) : "";
    const method = ev.method ? String(ev.method) : "";
    const lat =
      typeof ev.latencyMs === "number"
        ? color.dim(` (${(ev.latencyMs as number).toFixed(1)}ms)`)
        : "";
    const pe = ev.parseError ? color.red(`  !parse: ${String(ev.parseError)}`) : "";
    this.out.write(`${arrow}${tag} ${id}${method}${lat}${pe}\n`);
  }

  close(): void {
    this.file?.end();
  }
}
