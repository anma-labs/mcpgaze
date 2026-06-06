import { McpConnection } from "./mcp-connection";
import { VERSION } from "./version";

export const KNOWN_SPEC_VERSIONS = ["2025-06-18", "2025-11-25", "2026-07-28"] as const;
export type SpecVersion = (typeof KNOWN_SPEC_VERSIONS)[number];

export type CheckStatus = "pass" | "fail" | "warn" | "skip";
export type CheckLevel = "required" | "recommended";

export interface CheckResult {
  id: string;
  title: string;
  level: CheckLevel;
  status: CheckStatus;
  detail: string;
}

export interface ConformReport {
  protocolVersion: string;
  serverProtocolVersion: string | null;
  results: CheckResult[];
  passed: boolean; // false if any REQUIRED check failed
}

interface Ctx {
  conn: McpConnection;
  initResult: { protocolVersion?: string; serverInfo?: { name?: string }; capabilities?: unknown } | null;
  initError?: string;
  tools: Array<{ name?: string; inputSchema?: unknown }>;
  timeoutMs: number;
}

type Check = {
  id: string;
  title: string;
  level: CheckLevel;
  run: (ctx: Ctx) => Promise<Omit<CheckResult, "id" | "title" | "level">>;
};

const ok = (detail: string) => ({ status: "pass" as const, detail });
const fail = (detail: string) => ({ status: "fail" as const, detail });
const warn = (detail: string) => ({ status: "warn" as const, detail });

/** The check catalog. Pure data so each can be reasoned about and tested. */
export const CHECKS: Check[] = [
  {
    id: "init.result",
    title: "initialize returns a valid result",
    level: "required",
    run: async (c) =>
      c.initError
        ? fail(c.initError)
        : c.initResult
          ? ok("initialize responded")
          : fail("no initialize result"),
  },
  {
    id: "init.protocolVersion",
    title: "initialize result advertises a protocolVersion",
    level: "required",
    run: async (c) =>
      c.initResult?.protocolVersion
        ? ok(`server reports ${c.initResult.protocolVersion}`)
        : fail("missing protocolVersion in initialize result"),
  },
  {
    id: "init.serverInfo",
    title: "initialize result includes serverInfo.name",
    level: "required",
    run: async (c) =>
      c.initResult?.serverInfo?.name
        ? ok(`serverInfo.name = ${c.initResult.serverInfo.name}`)
        : fail("missing serverInfo.name"),
  },
  {
    id: "init.capabilities",
    title: "initialize result includes a capabilities object",
    level: "recommended",
    run: async (c) =>
      c.initResult && typeof c.initResult.capabilities === "object" && c.initResult.capabilities !== null
        ? ok("capabilities present")
        : warn("no capabilities object advertised"),
  },
  {
    id: "tools.list",
    title: "tools/list returns an array of tools",
    level: "required",
    run: async (c) => (Array.isArray(c.tools) ? ok(`${c.tools.length} tool(s)`) : fail("tools/list did not return an array")),
  },
  {
    id: "tools.names",
    title: "every tool has a non-empty name",
    level: "required",
    run: async (c) => {
      const list = Array.isArray(c.tools) ? c.tools : [];
      const bad = list.filter((t) => !t.name || typeof t.name !== "string");
      return bad.length === 0 ? ok("all tools named") : fail(`${bad.length} tool(s) missing a name`);
    },
  },
  {
    id: "tools.inputSchema",
    title: 'every tool inputSchema is an object schema (type: "object")',
    level: "recommended",
    run: async (c) => {
      const list = Array.isArray(c.tools) ? c.tools : [];
      const bad = list.filter((t) => {
        const s = t.inputSchema as { type?: unknown } | undefined;
        return !s || typeof s !== "object" || s.type !== "object";
      });
      return bad.length === 0 ? ok("all input schemas are object schemas") : warn(`${bad.length} tool(s) without an object inputSchema`);
    },
  },
  {
    id: "tools.requiredRefs",
    title: "tool required[] only names declared properties",
    level: "recommended",
    run: async (c) => {
      const offenders: string[] = [];
      for (const t of Array.isArray(c.tools) ? c.tools : []) {
        const s = t.inputSchema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
        if (!Array.isArray(s?.required)) continue; // a non-array `required` is not iterable
        const props = new Set(Object.keys(s.properties ?? {}));
        for (const r of s.required) if (!props.has(r)) offenders.push(`${t.name}.${r}`);
      }
      return offenders.length === 0 ? ok("required[] is consistent") : warn(`undeclared required fields: ${offenders.join(", ")}`);
    },
  },
  {
    id: "error.unknownMethod",
    title: "an unknown method returns a JSON-RPC error (not a hang/crash)",
    level: "required",
    run: async (c) => {
      try {
        const res = await c.conn.request("mcpgaze/definitely-not-a-method", {}, Math.min(c.timeoutMs, 4000));
        if (res.error) {
          return res.error.code === -32601
            ? ok("returns -32601 method not found")
            : warn(`returns an error, but code ${res.error.code} (expected -32601)`);
        }
        return fail("unknown method returned a result instead of an error");
      } catch (e) {
        return fail(`no error response (${(e as Error).message.split("\n")[0]})`);
      }
    },
  },
];

export async function conform(
  command: string,
  args: string[],
  protocolVersion: string,
  timeoutMs = 8000,
): Promise<ConformReport> {
  const conn = McpConnection.spawn(command, args);
  const ctx: Ctx = { conn, initResult: null, tools: [], timeoutMs };
  try {
    const init = await conn.request(
      "initialize",
      { protocolVersion, capabilities: {}, clientInfo: { name: "mcpgaze", version: VERSION } },
      timeoutMs,
    );
    if (init.error) ctx.initError = `initialize error: ${init.error.message}`;
    else ctx.initResult = (init.result ?? {}) as Ctx["initResult"];
    conn.notify("notifications/initialized");

    if (ctx.initResult) {
      try {
        const list = await conn.request("tools/list", {}, timeoutMs);
        const r = (list.result ?? {}) as { tools?: Ctx["tools"] };
        ctx.tools = r.tools ?? [];
      } catch {
        ctx.tools = [];
      }
    }

    const results: CheckResult[] = [];
    for (const chk of CHECKS) {
      // A check must never crash the whole report on adversarial server output;
      // contain any throw as a failed check so conform() always resolves.
      let r: Omit<CheckResult, "id" | "title" | "level">;
      try {
        r = await chk.run(ctx);
      } catch (e) {
        r = { status: "fail", detail: `check errored: ${(e as Error).message}` };
      }
      results.push({ id: chk.id, title: chk.title, level: chk.level, ...r });
    }
    const passed = !results.some((r) => r.level === "required" && r.status === "fail");
    return {
      protocolVersion,
      serverProtocolVersion: ctx.initResult?.protocolVersion ?? null,
      results,
      passed,
    };
  } finally {
    conn.close();
  }
}
