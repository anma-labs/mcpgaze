import { StringDecoder } from "node:string_decoder";
import type { JsonRpcMessage } from "./jsonrpc";

export type Direction = "c2s" | "s2c"; // client->server, server->client

export interface FramedMessage {
  direction: Direction;
  raw: string;
  msg: JsonRpcMessage | null; // null when the line was not valid JSON
  parseError?: string;
}

/**
 * MCP stdio framing is newline-delimited JSON: one message per line, and the
 * spec forbids embedded newlines inside a message. We split on "\n", buffering
 * partial lines across chunk boundaries.
 *
 * This is an OBSERVER only. It is fed COPIES of bytes that have already been
 * forwarded byte-exact on the hot path, so a parse failure here can never
 * corrupt the protocol stream. The StringDecoder makes us safe against a
 * multibyte UTF-8 character that straddles two chunks.
 */
/**
 * Upper bound on a single pending (newline-free) line. A peer that streams past
 * V8's MAX_STRING_LENGTH (~536MB) with no "\n" would overflow the `+=` and throw
 * `RangeError: Invalid string length`. Because push() is wired UNWRAPPED into
 * stream 'data' listeners in some callers (mcp-connection, the replay server),
 * that synchronous throw would crash the process. A real MCP message is tiny, so
 * past this cap we discard the over-long line and resync at the next newline —
 * the bytes have already been forwarded on the wire; only the observation drops.
 */
const MAX_LINE = 64 * 1024 * 1024; // 64 MiB, well above any real message, well below MAX_STRING_LENGTH

export class LineFramer {
  private buf = "";
  private overflow = false; // discarding an over-long, newline-free line until the next "\n"
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly onMessage: (m: FramedMessage) => void,
    private readonly direction: Direction,
  ) {}

  push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.overflow) {
      const nl = text.indexOf("\n");
      if (nl < 0) return; // still inside the over-long line; keep discarding
      this.overflow = false;
      this.buf = text.slice(nl + 1); // resync on the bytes after the terminator
    } else {
      this.buf += text;
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const trimmed = line.trim();
      if (trimmed === "") continue;
      this.emit(trimmed);
    }
    if (this.buf.length > MAX_LINE) {
      // No newline in a buffer this large: drop it rather than grow unbounded.
      this.overflow = true;
      this.buf = "";
    }
  }

  private emit(raw: string): void {
    let msg: JsonRpcMessage | null = null;
    let parseError: string | undefined;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch (e) {
      parseError = (e as Error).message;
    }
    this.onMessage({ direction: this.direction, raw, msg, parseError });
  }
}
