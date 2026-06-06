import { writeFileSync, readFileSync } from "node:fs";
import { LineFramer } from "./framer";
import { VERSION } from "./version";
import { redactValue } from "./redact";
import type { PairedRequest, PairedResponse } from "./proxy";

export interface Interaction {
  request: { method: string; params?: unknown };
  response: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
}

export interface Cassette {
  mcpgazeVersion: string;
  recordedAt: string;
  interactions: Interaction[];
}

/**
 * Recursion cap. stableStringify runs on untrusted request params in the replay
 * server's stdin path (matchRequest), which has no try/catch — an unbounded
 * recursive walk of a deeply-nested value would overflow the stack and crash the
 * server mid-protocol. We truncate past this depth (far beyond any real params)
 * so the canonical key stays bounded; pathological values just collide harmlessly.
 */
const MAX_DEPTH = 200;

/** Deterministic JSON with sorted object keys, so params compare canonically. */
export function stableStringify(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (depth >= MAX_DEPTH) return '"__mcpgaze_max_depth__"'; // truncate: deeper than any real params
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v, depth + 1)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k], depth + 1)).join(",") + "}";
}

/** Collects unique request/response pairs observed during a `record` session. */
export class CassetteRecorder {
  private readonly interactions: Interaction[] = [];
  private readonly seen = new Set<string>();

  /** When true, mask credential-shaped params/results before they are persisted. */
  constructor(private readonly redact = false) {}

  add(request: PairedRequest, response: PairedResponse): void {
    const params = this.redact ? redactValue(request.params) : request.params;
    const interaction: Interaction = {
      request: { method: request.method, params },
      response: response.error
        ? { error: this.redact ? (redactValue(response.error) as Interaction["response"]["error"]) : response.error }
        : { result: this.redact ? redactValue(response.result) : response.result },
    };
    const key = stableStringify(interaction);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.interactions.push(interaction);
  }

  toCassette(): Cassette {
    return {
      mcpgazeVersion: VERSION,
      recordedAt: new Date().toISOString(),
      interactions: this.interactions,
    };
  }

  write(path: string): number {
    // 0600: a cassette stores request params and response results verbatim and
    // its default path is a non-gitignored repo-root file, so it must not be
    // group/world-readable (umask 0022 would otherwise leave it 0644).
    writeFileSync(path, JSON.stringify(this.toCassette(), null, 2) + "\n", { mode: 0o600 });
    return this.interactions.length;
  }
}

// ── replay ──────────────────────────────────────────────────────────────────

export interface CassetteIndex {
  byKey: Map<string, Interaction>; // method + stable(params)
  byMethod: Map<string, Interaction[]>;
}

export function buildIndex(cassette: Cassette): CassetteIndex {
  const byKey = new Map<string, Interaction>();
  const byMethod = new Map<string, Interaction[]>();
  for (const it of cassette.interactions) {
    byKey.set(it.request.method + "|" + stableStringify(it.request.params ?? null), it);
    const list = byMethod.get(it.request.method) ?? [];
    list.push(it);
    byMethod.set(it.request.method, list);
  }
  return { byKey, byMethod };
}

export type MatchOutcome =
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: { code: number; message: string; data?: unknown } };

/**
 * Resolve a request against a cassette: exact (method+params) match first, then
 * a unique method-only fallback, else a JSON-RPC error so the client sees a
 * clear "not recorded" instead of a hang.
 */
export function matchRequest(index: CassetteIndex, method: string, params: unknown): MatchOutcome {
  const exact = index.byKey.get(method + "|" + stableStringify(params ?? null));
  const chosen = exact ?? pickMethodOnly(index, method);
  if (!chosen) {
    return { kind: "error", error: { code: -32601, message: `no recorded interaction for "${method}"` } };
  }
  if (chosen.response.error) return { kind: "error", error: chosen.response.error };
  return { kind: "result", result: chosen.response.result };
}

function pickMethodOnly(index: CassetteIndex, method: string): Interaction | undefined {
  const list = index.byMethod.get(method);
  return list && list.length === 1 ? list[0] : undefined;
}

/**
 * Run a deterministic mock MCP server over stdio from a cassette. Speaks ONLY
 * JSON-RPC on stdout. Notifications get no reply. This is "VCR for MCP": record
 * a real session once, replay it forever in CI or for offline client dev.
 */
export function runReplayServer(cassettePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // The cassette is an untrusted file. Parse + shape-validate up front so a
    // malformed/hostile cassette fails with a clean error instead of an
    // uncaught throw mid-startup.
    let index: CassetteIndex;
    try {
      const cassette = parseCassette(readFileSync(cassettePath, "utf8"));
      index = buildIndex(cassette);
    } catch (e) {
      reject(new Error(`invalid cassette: ${(e as Error).message}`));
      return;
    }

    const framer = new LineFramer((f) => {
      if (!f.msg) return;
      const isRequest = f.msg.method !== undefined && f.msg.id !== undefined && f.msg.id !== null;
      if (!isRequest) return; // notifications and anything else: ignore
      const outcome = matchRequest(index, f.msg.method!, f.msg.params);
      const envelope =
        outcome.kind === "result"
          ? { jsonrpc: "2.0", id: f.msg.id, result: outcome.result }
          : { jsonrpc: "2.0", id: f.msg.id, error: outcome.error };
      process.stdout.write(JSON.stringify(envelope) + "\n");
    }, "c2s");

    // Guard the framer the way runProxy does: a synchronous throw from push()
    // (e.g. an over-long line) must not crash the replay server mid-protocol.
    process.stdin.on("data", (chunk: Buffer) => {
      try {
        framer.push(chunk);
      } catch {
        /* observation/parse failure: drop, never crash the wire */
      }
    });
    process.stdin.on("end", () => resolve(0));
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => resolve(0));
    }
  });
}

/** Parse + shape-validate untrusted cassette JSON. Throws a clear error on bad input. */
export function parseCassette(text: string): Cassette {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("not a JSON object");
  const c = parsed as Partial<Cassette>;
  if (!Array.isArray(c.interactions)) throw new Error("missing 'interactions' array");
  for (const it of c.interactions as unknown[]) {
    if (!it || typeof it !== "object") throw new Error("interaction is not an object");
    const req = (it as Partial<Interaction>).request;
    if (!req || typeof req !== "object" || typeof (req as { method?: unknown }).method !== "string") {
      throw new Error("interaction.request.method must be a string");
    }
  }
  return parsed as Cassette;
}
