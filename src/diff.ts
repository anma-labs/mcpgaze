import { readFileSync } from "node:fs";
import { probeServer } from "./client";
import { diffInputSchema, type Change } from "./schema-diff";
import type { Baseline } from "./snapshot";

export interface DiffResult {
  changes: Change[];
  toolsAdded: string[];
  toolsRemoved: string[];
}

export async function diff(
  command: string,
  args: string[],
  baselinePath: string,
): Promise<DiffResult> {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  const probe = await probeServer(command, args);

  const current: Baseline["tools"] = {};
  for (const t of probe.tools) {
    current[t.name] = { description: t.description ?? "", inputSchema: t.inputSchema ?? {} };
  }

  const baseTools = baseline.tools ?? {};
  const toolsRemoved = Object.keys(baseTools).filter((n) => !(n in current));
  const toolsAdded = Object.keys(current).filter((n) => !(n in baseTools));

  const changes: Change[] = [];
  for (const n of toolsRemoved) changes.push({ severity: "breaking", path: n, message: "tool removed" });
  for (const n of toolsAdded) changes.push({ severity: "info", path: n, message: "tool added" });

  for (const n of Object.keys(baseTools)) {
    if (!(n in current)) continue;
    changes.push(...diffInputSchema(n, baseTools[n].inputSchema, current[n].inputSchema));
    if ((baseTools[n].description ?? "") !== (current[n].description ?? "")) {
      changes.push({ severity: "info", path: n, message: "description changed" });
    }
  }

  return { changes, toolsAdded, toolsRemoved };
}
