import { readFileSync } from "node:fs";

export interface SessionEvent {
  type: string;
  kind?: string;
  dir?: string;
  id?: unknown;
  method?: string | null;
  raw?: string;
  parseError?: string | null;
  latencyMs?: number | null;
  code?: string;
  detail?: string;
  text?: string;
}

export interface Failure {
  kind: string;
  summary: string;
  detail?: string;
}

// Substring (not word-bounded) so "TypeError", "ReferenceError", "OSError"
// etc. are caught — crash lines rarely have a clean word boundary before "error".
const STDERR_SIGNAL = /(error|fatal|exception|traceback|panic|unhandled|econnrefused|eaddrinuse)/i;
const NOTE_FAILURES = new Set(["orphan-request", "spawn-error", "proxy-error", "observer-error", "origin-rejected"]);

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Pull failure signals out of a session log. Pure and order-preserving. */
export function extractFailures(events: SessionEvent[]): Failure[] {
  const failures: Failure[] = [];
  for (const e of events) {
    if (e.type === "message" && e.kind === "error") {
      failures.push({ kind: "rpc-error", summary: `error response to ${e.method ?? "request"} (id ${String(e.id)})`, detail: e.raw ? truncate(e.raw) : undefined });
    } else if (e.type === "message" && e.parseError) {
      failures.push({ kind: "parse-error", summary: `malformed JSON-RPC on ${e.dir ?? "?"}`, detail: e.parseError });
    } else if (e.type === "note" && e.code && NOTE_FAILURES.has(e.code)) {
      failures.push({ kind: e.code, summary: e.code.replace(/-/g, " "), detail: e.detail });
    } else if (e.type === "server_stderr" && e.text && STDERR_SIGNAL.test(e.text)) {
      failures.push({ kind: "server-stderr", summary: "server logged an error", detail: truncate(e.text.trim()) });
    }
  }
  return failures;
}

export function parseSessionLog(path: string): SessionEvent[] {
  const text = readFileSync(path, "utf8");
  const out: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as SessionEvent);
    } catch {
      /* skip non-JSON lines */
    }
  }
  return out;
}

export function buildTriagePrompt(failures: Failure[]): string {
  const lines = failures.map((f, i) => `${i + 1}. [${f.kind}] ${f.summary}${f.detail ? `\n   ${f.detail}` : ""}`);
  return [
    "You are debugging a Model Context Protocol (MCP) server. Below are failure",
    "signals captured by a transparent proxy during a live session. For each",
    "distinct problem, give the most likely root cause and a concrete fix.",
    "Be specific and concise (a few bullets). Common MCP gotchas: writing logs to",
    "stdout corrupts the JSON-RPC wire; GUI clients don't inherit shell env vars;",
    "tool schema/signature drift breaks agents silently; default ~30s client",
    "timeouts; transport mismatches (stdio vs Streamable HTTP).",
    "",
    "Failure signals:",
    ...lines,
  ].join("\n");
}

export const DEFAULT_TRIAGE_MODEL = "claude-sonnet-4-6";

/** Zero-dependency Anthropic Messages call via fetch. */
export async function callClaude(prompt: string, apiKey: string, model = DEFAULT_TRIAGE_MODEL): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${truncate(await res.text(), 200)}`);
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

export interface TriageReport {
  failures: Failure[];
  aiDiagnosis?: string;
  aiSkippedReason?: string;
}

export interface TriageOptions {
  apiKey?: string;
  model?: string;
  useAi?: boolean;
}

export async function triage(logPath: string, opts: TriageOptions = {}): Promise<TriageReport> {
  const failures = extractFailures(parseSessionLog(logPath));
  const report: TriageReport = { failures };
  if (failures.length === 0) return report;

  if (!opts.useAi) {
    report.aiSkippedReason = "AI triage not requested (pass --ai)";
    return report;
  }
  if (!opts.apiKey) {
    report.aiSkippedReason = "no ANTHROPIC_API_KEY set";
    return report;
  }
  try {
    report.aiDiagnosis = await callClaude(buildTriagePrompt(failures), opts.apiKey, opts.model);
  } catch (e) {
    report.aiSkippedReason = (e as Error).message;
  }
  return report;
}
