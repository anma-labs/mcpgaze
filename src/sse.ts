import { StringDecoder } from "node:string_decoder";

/**
 * Server-Sent Events parser, used to observe the JSON-RPC messages carried over
 * MCP's Streamable HTTP transport without disturbing the forwarded byte stream.
 *
 * We only care about `data:` fields (each MCP SSE event's data is a JSON-RPC
 * message; multiple data lines concatenate with "\n"). Comments, `event:`,
 * `id:`, and `retry:` are ignored for logging purposes. Like LineFramer, this
 * is fed COPIES and never touches the wire.
 */
export class SseParser {
  private buf = "";
  private dataLines: string[] = [];
  private sawCr = false; // last line ended on a CR that was the final byte of a chunk
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly onEvent: (data: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    // A CR that ended the previous chunk may have been the first half of a CRLF
    // split across the chunk boundary — swallow a single leading LF if so.
    if (this.sawCr) {
      this.sawCr = false;
      if (this.buf.startsWith("\n")) this.buf = this.buf.slice(1);
    }
    // Per WHATWG, a line is terminated by CR, LF, or CRLF. Split on whichever
    // boundary comes first; a lone CR is a valid terminator, not part of the data.
    for (;;) {
      const lf = this.buf.indexOf("\n");
      const cr = this.buf.indexOf("\r");
      if (lf === -1 && cr === -1) break;

      if (cr !== -1 && (lf === -1 || cr < lf)) {
        if (cr === this.buf.length - 1) {
          // CR is the last byte we have: terminate the line, but defer — the next
          // chunk may begin with the LF half of a CRLF pair.
          const line = this.buf.slice(0, cr);
          this.buf = "";
          this.sawCr = true;
          this.handleLine(line);
          break;
        }
        const line = this.buf.slice(0, cr);
        const skip = this.buf[cr + 1] === "\n" ? 2 : 1; // CRLF consumes two, lone CR one
        this.buf = this.buf.slice(cr + skip);
        this.handleLine(line);
      } else {
        const line = this.buf.slice(0, lf);
        this.buf = this.buf.slice(lf + 1);
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return; // comment

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
  }

  private dispatch(): void {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    if (data.trim() !== "") this.onEvent(data);
  }
}
