import { McpConnection } from "./mcp-connection";
import { VERSION } from "./version";

export const PROTOCOL_VERSION = "2025-11-25";

/**
 * Default handshake/probe timeout (ms), shared so the probe-driven commands stay
 * aligned: snapshot/diff (via probeServer) and preflight use the same budget, so
 * a slow-cold-start server can't pass one and flake the other. Override per call,
 * or for preflight via --timeout / MCPGAZE_PREFLIGHT_TIMEOUT.
 */
export const PROBE_TIMEOUT_MS = 15000;

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ServerInfo {
  name?: string;
  version?: string;
}

export interface Probe {
  protocolVersion: string;
  server: ServerInfo;
  tools: ToolDef[];
}

/**
 * Spawn an MCP server over stdio, perform the initialize handshake, and read
 * the full (paginated) tool surface. Used by snapshot/diff. Throws on an RPC
 * error response or a timeout. Implemented over McpConnection.
 */
export async function probeServer(
  command: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
  env?: NodeJS.ProcessEnv,
): Promise<Probe> {
  const conn = McpConnection.spawn(command, args, env);
  try {
    const init = await conn.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mcpgaze", version: VERSION },
      },
      timeoutMs,
    );
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
    const initResult = (init.result ?? {}) as { protocolVersion?: string; serverInfo?: ServerInfo };

    conn.notify("notifications/initialized");

    const tools: ToolDef[] = [];
    let cursor: string | undefined;
    do {
      const page = await conn.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      if (page.error) throw new Error(`tools/list failed: ${page.error.message}`);
      const r = (page.result ?? {}) as { tools?: ToolDef[]; nextCursor?: string };
      for (const t of r.tools ?? []) {
        tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      }
      cursor = r.nextCursor;
    } while (cursor);

    return {
      protocolVersion: initResult.protocolVersion ?? PROTOCOL_VERSION,
      server: initResult.serverInfo ?? {},
      tools,
    };
  } finally {
    conn.close();
  }
}
