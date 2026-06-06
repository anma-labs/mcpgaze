/**
 * A deliberately FOCUSED differ for MCP tool inputSchemas. It does not attempt
 * to be a general JSON Schema diff; it covers the cases that actually break
 * agents in practice: removed/added properties, required<->optional flips, type
 * changes, and enum narrowing. Honest about its scope (see README).
 */

export type Severity = "breaking" | "warning" | "info";

export interface Change {
  severity: Severity;
  path: string;
  message: string;
}

interface SchemaLike {
  type?: unknown;
  enum?: unknown[];
  properties?: Record<string, SchemaLike>;
  required?: string[];
}

function fmtType(t: unknown): string {
  return t === undefined ? "(none)" : JSON.stringify(t);
}

export function diffInputSchema(
  toolName: string,
  oldSchemaRaw: unknown,
  newSchemaRaw: unknown,
): Change[] {
  const changes: Change[] = [];
  const oldS = (oldSchemaRaw ?? {}) as SchemaLike;
  const newS = (newSchemaRaw ?? {}) as SchemaLike;
  const oldProps = oldS.properties ?? {};
  const newProps = newS.properties ?? {};
  const oldReq = new Set(oldS.required ?? []);
  const newReq = new Set(newS.required ?? []);

  // Removed properties — breaking: callers may still send them / rely on them.
  for (const k of Object.keys(oldProps)) {
    if (!(k in newProps)) {
      changes.push({ severity: "breaking", path: `${toolName}.${k}`, message: "property removed" });
    }
  }

  // Added properties — breaking only if newly required.
  for (const k of Object.keys(newProps)) {
    if (!(k in oldProps)) {
      const req = newReq.has(k);
      changes.push({
        severity: req ? "breaking" : "info",
        path: `${toolName}.${k}`,
        message: req ? "new required property added" : "new optional property added",
      });
    }
  }

  // Shared properties — inspect type, enum, and requiredness.
  for (const k of Object.keys(oldProps)) {
    if (!(k in newProps)) continue;
    const o = oldProps[k] ?? {};
    const n = newProps[k] ?? {};

    if (JSON.stringify(o.type) !== JSON.stringify(n.type)) {
      changes.push({
        severity: "breaking",
        path: `${toolName}.${k}`,
        message: `type changed from ${fmtType(o.type)} to ${fmtType(n.type)}`,
      });
    }

    if (o.enum || n.enum) {
      const oset = new Set((o.enum ?? []).map((v) => JSON.stringify(v)));
      const nset = new Set((n.enum ?? []).map((v) => JSON.stringify(v)));
      for (const v of oset) {
        if (!nset.has(v)) {
          changes.push({ severity: "breaking", path: `${toolName}.${k}`, message: `enum value removed: ${v}` });
        }
      }
      for (const v of nset) {
        if (!oset.has(v)) {
          changes.push({ severity: "info", path: `${toolName}.${k}`, message: `enum value added: ${v}` });
        }
      }
    }

    const wasReq = oldReq.has(k);
    const isReq = newReq.has(k);
    if (!wasReq && isReq) {
      changes.push({ severity: "breaking", path: `${toolName}.${k}`, message: "became required" });
    } else if (wasReq && !isReq) {
      changes.push({ severity: "warning", path: `${toolName}.${k}`, message: "no longer required" });
    }
  }

  return changes;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, breaking: 2 };

export function worstSeverity(changes: Change[]): Severity | null {
  let worst: Severity | null = null;
  for (const c of changes) {
    if (worst === null || RANK[c.severity] > RANK[worst]) worst = c.severity;
  }
  return worst;
}
