import { color } from "./colors";

/** A logger event as seen by the TUI (loosely typed; matches Logger output). */
export interface TuiEvent {
  type: string;
  dir?: string;
  kind?: string;
  id?: unknown;
  method?: string | null;
  latencyMs?: number | null;
  parseError?: string | null;
  code?: string;
  detail?: string;
  text?: string;
}

interface Row {
  dir: string;
  kind: string;
  method: string;
  id: string;
  latencyMs: number | null;
  error: boolean;
}

export class TuiState {
  readonly serverCmd: string;
  readonly startedAt = Date.now();
  requests = 0;
  responses = 0;
  errors = 0;
  notifications = 0;
  orphans = 0;
  parseErrors = 0;
  readonly latencies: number[] = [];
  readonly recent: Row[] = [];
  lastStderr = "";

  constructor(serverCmd: string) {
    this.serverCmd = serverCmd;
  }

  ingest(e: TuiEvent): void {
    if (e.type === "message") {
      if (e.parseError) this.parseErrors++;
      switch (e.kind) {
        case "request":
          this.requests++;
          break;
        case "response":
          this.responses++;
          break;
        case "error":
          this.errors++;
          break;
        case "notification":
          this.notifications++;
          break;
      }
      if (typeof e.latencyMs === "number") this.latencies.push(e.latencyMs);
      this.recent.push({
        dir: e.dir ?? "?",
        kind: e.kind ?? "?",
        method: e.method ?? "",
        id: e.id != null ? String(e.id) : "",
        latencyMs: typeof e.latencyMs === "number" ? e.latencyMs : null,
        error: e.kind === "error",
      });
      if (this.recent.length > 200) this.recent.shift();
    } else if (e.type === "server_stderr" && e.text) {
      this.lastStderr = e.text.trim().split("\n").pop() ?? "";
    } else if (e.type === "note" && e.code === "orphan-request") {
      this.orphans++;
    }
  }
}

export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmtMs(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(0)}ms`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** Render the full TUI frame. Pure: state + viewport -> string. */
export function renderFrame(state: TuiState, cols: number, rows: number): string {
  // Clamp the viewport: a TTY can report Infinity / a huge or non-finite column
  // count, and "─".repeat(Infinity | 2**30) throws RangeError. paint() runs from
  // an unguarded timer, so that throw would crash the host process.
  const width = Math.max(40, Math.min(1000, Number.isFinite(cols) ? Math.floor(cols) : 80));
  const safeRows = Math.max(8, Math.min(1000, Number.isFinite(rows) ? Math.floor(rows) : 24));
  const bar = "─".repeat(width);
  const lines: string[] = [];

  lines.push(color.bold("mcpgaze") + color.dim(`  ⟳ ${fmtDuration(Date.now() - state.startedAt)}  ·  ${state.serverCmd}`));
  lines.push(color.dim(bar));

  // message list fills the middle; reserve 5 lines for header + 3 for footer.
  const listHeight = Math.max(3, safeRows - 8);
  const slice = state.recent.slice(-listHeight);
  for (const r of slice) {
    const arrow = r.dir === "c2s" ? color.cyan("→") : color.green("←");
    const tag = r.error
      ? color.red("ERR ")
      : r.kind === "request"
        ? color.bold("req ")
        : r.kind === "response"
          ? "res "
          : r.kind === "notification"
            ? color.gray("note")
            : "?   ";
    const id = r.id ? color.dim(`#${r.id}`) : "   ";
    const lat = r.latencyMs != null ? color.dim(` ${r.latencyMs.toFixed(1)}ms`) : "";
    lines.push(`${arrow} ${tag} ${id} ${r.method}${lat}`);
  }
  // pad to fixed height
  for (let i = slice.length; i < listHeight; i++) lines.push("");

  lines.push(color.dim(bar));
  if (state.lastStderr) lines.push(color.yellow("stderr ") + color.dim(state.lastStderr.slice(0, width - 8)));
  else lines.push(color.dim("stderr —"));

  const p50 = fmtMs(percentile(state.latencies, 50));
  const p95 = fmtMs(percentile(state.latencies, 95));
  const errPart = state.errors > 0 ? color.red(`${state.errors} err`) : color.green("0 err");
  const orphanPart = state.orphans > 0 ? color.red(`${state.orphans} orphan`) : "0 orphan";
  lines.push(
    color.dim(
      `req ${state.requests}  res ${state.responses}  notif ${state.notifications}  `,
    ) +
      `${errPart}  ${orphanPart}  ` +
      color.dim(`p50 ${p50}  p95 ${p95}`),
  );
  lines.push(color.dim("Ctrl-C to stop"));
  return lines.join("\n");
}

const ALT_ON = "\x1b[?1049h\x1b[?25l";
const ALT_OFF = "\x1b[?25h\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_DOWN = "\x1b[0J";

/** Live terminal UI driven by logger events. Renders to a TTY stream. */
export class Tui {
  private readonly state: TuiState;
  private readonly out: NodeJS.WriteStream;
  private timer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(serverCmd: string, out: NodeJS.WriteStream = process.stderr) {
    this.state = new TuiState(serverCmd);
    this.out = out;
  }

  static isSupported(out: NodeJS.WriteStream = process.stderr): boolean {
    return Boolean(out.isTTY) && !process.env.NO_TUI;
  }

  start(): void {
    this.active = true;
    this.out.write(ALT_ON);
    this.paint();
    this.timer = setInterval(() => this.paint(), 100);
  }

  update(e: Record<string, unknown>): void {
    this.state.ingest(e as unknown as TuiEvent);
  }

  private paint(): void {
    if (!this.active) return;
    const cols = this.out.columns ?? 80;
    const rows = this.out.rows ?? 24;
    this.out.write(HOME + renderFrame(this.state, cols, rows) + CLEAR_DOWN);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.out.write(ALT_OFF);
  }
}
