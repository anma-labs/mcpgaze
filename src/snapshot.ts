import { writeFileSync } from "node:fs";
import { probeServer } from "./client";
import { VERSION } from "./version";

export interface Baseline {
  mcpgazeVersion: string;
  capturedAt: string;
  protocolVersion: string;
  server: { name?: string; version?: string };
  tools: Record<string, { description: string; inputSchema: unknown }>;
}

export async function buildBaseline(command: string, args: string[]): Promise<Baseline> {
  const probe = await probeServer(command, args);
  const tools: Baseline["tools"] = {};
  for (const t of probe.tools) {
    tools[t.name] = { description: t.description ?? "", inputSchema: t.inputSchema ?? {} };
  }
  return {
    mcpgazeVersion: VERSION,
    capturedAt: new Date().toISOString(),
    protocolVersion: probe.protocolVersion,
    server: probe.server,
    tools,
  };
}

export async function snapshot(command: string, args: string[], outPath: string): Promise<Baseline> {
  const baseline = await buildBaseline(command, args);
  writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n");
  return baseline;
}
