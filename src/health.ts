import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { McpConnection } from "./mcp-connection";
import { stableStringify } from "./cassette";
import { PROTOCOL_VERSION } from "./client";
import { VERSION } from "./version";

export interface HealthCheck {
  at: string;
  ok: boolean;
  latencyMs?: number;
  toolCount?: number;
  toolsHash?: string;
  error?: string;
}

/** One health probe: initialize + tools/list, timed. Never throws. */
export async function healthCheckOnce(command: string, args: string[], timeoutMs = 8000): Promise<HealthCheck> {
  const at = new Date().toISOString();
  const conn = McpConnection.spawn(command, args);
  const t0 = performance.now();
  try {
    const init = await conn.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mcpgaze", version: VERSION } },
      timeoutMs,
    );
    if (init.error) return { at, ok: false, error: `initialize: ${init.error.message}` };
    conn.notify("notifications/initialized");
    const list = await conn.request("tools/list", {}, timeoutMs);
    if (list.error) return { at, ok: false, error: `tools/list: ${list.error.message}` };
    const tools = ((list.result ?? {}) as { tools?: Array<{ name?: string; inputSchema?: unknown }> }).tools ?? [];
    return {
      at,
      ok: true,
      latencyMs: Math.round(performance.now() - t0),
      toolCount: tools.length,
      toolsHash: stableStringify(tools.map((t) => ({ n: t.name, s: t.inputSchema }))),
    };
  } catch (e) {
    return { at, ok: false, error: (e as Error).message.split("\n")[0] };
  } finally {
    conn.close();
  }
}

export interface HealthSummary {
  checks: number;
  upCount: number;
  uptimePct: number;
  consecutiveFailures: number;
  p50LatencyMs: number | null;
}

export function summarize(history: HealthCheck[]): HealthSummary {
  const checks = history.length;
  const upCount = history.filter((h) => h.ok).length;
  let consecutiveFailures = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ok) break;
    consecutiveFailures++;
  }
  const lats = history.filter((h) => h.ok && typeof h.latencyMs === "number").map((h) => h.latencyMs as number).sort((a, b) => a - b);
  const p50 = lats.length ? lats[Math.floor(lats.length / 2)] : null;
  return {
    checks,
    upCount,
    uptimePct: checks ? Math.round((upCount / checks) * 1000) / 10 : 0,
    consecutiveFailures,
    p50LatencyMs: p50,
  };
}

export interface DaemonOptions {
  intervalMs?: number;
  statusPath?: string;
  once?: boolean;
  maxHistory?: number;
  onTransition?: (msg: string) => void;
  onCheck?: (c: HealthCheck) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Continuously health-check a server, tracking up/down transitions and tool-
 * schema drift, persisting status to a file. With `once`, runs a single probe
 * (handy as a cron/CI liveness check). Returns the final check.
 */
export async function runHealthDaemon(command: string, args: string[], opts: DaemonOptions = {}): Promise<HealthCheck> {
  const intervalMs = opts.intervalMs ?? 60000;
  const statusPath = opts.statusPath ?? ".mcpgaze/health.json";
  const maxHistory = opts.maxHistory ?? 500;
  const history: HealthCheck[] = [];
  let prevOk: boolean | null = null;
  let prevHash: string | undefined;
  let last: HealthCheck = { at: new Date().toISOString(), ok: false };

  const persist = (): void => {
    try {
      mkdirSync(dirname(statusPath), { recursive: true });
      writeFileSync(
        statusPath,
        JSON.stringify(
          { server: [command, ...args].join(" "), updatedAt: new Date().toISOString(), current: last, summary: summarize(history), history },
          null,
          2,
        ),
      );
    } catch {
      /* best effort */
    }
  };

  for (;;) {
    const c = await healthCheckOnce(command, args);
    last = c;
    history.push(c);
    if (history.length > maxHistory) history.shift();
    opts.onCheck?.(c);

    if (prevOk !== null && prevOk !== c.ok) {
      opts.onTransition?.(c.ok ? "recovered: server is responding again" : `DOWN: ${c.error ?? "unresponsive"}`);
    }
    if (c.ok && prevHash !== undefined && c.toolsHash !== prevHash) {
      opts.onTransition?.("schema drift: the server's tool surface changed");
    }
    prevOk = c.ok;
    if (c.ok && c.toolsHash) prevHash = c.toolsHash;

    persist();
    if (opts.once) return c;
    await sleep(intervalMs);
  }
}
