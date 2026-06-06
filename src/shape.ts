import type { Change } from "./schema-diff";

/**
 * A structural fingerprint of a JSON value — types and keys, not values. Used to
 * detect *behavioral* drift that schema diffing misses: a server can keep its
 * declared tool schema identical while its responses change shape (a field
 * disappears, a list goes empty, a type flips).
 */
export type Shape =
  | "null"
  | "string"
  | "number"
  | "boolean"
  | { object: Record<string, Shape> }
  | { array: Shape | null }; // null element shape => empty array observed

/**
 * Recursion cap. A deeply-nested JSON value is delivered intact off the wire
 * (V8's JSON.parse is iterative), but a recursive walk of it would overflow the
 * JS call stack and throw — an observer crash. We stop descending past this depth
 * (far beyond any real tool response) so the fingerprint/diff stays bounded.
 */
const MAX_DEPTH = 500;

export function shapeOf(value: unknown, depth = 0): Shape {
  if (value === null || value === undefined) return "null";
  if (depth >= MAX_DEPTH) return "null"; // truncate: deeper than any real response
  if (Array.isArray(value)) return { array: value.length ? shapeOf(value[0], depth + 1) : null };
  const t = typeof value;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, Shape> = {};
    for (const k of Object.keys(obj).sort()) out[k] = shapeOf(obj[k], depth + 1);
    return { object: out };
  }
  return "null";
}

function kind(s: Shape): "object" | "array" | "primitive" {
  if (typeof s === "object") return "object" in s ? "object" : "array";
  return "primitive";
}

/**
 * Diff two shapes. Severity model for behavioral drift:
 *   field removed / type changed     -> breaking (consumers relied on it)
 *   non-empty array became empty     -> warning  (could be data, could be breakage)
 *   field added / array now populated-> info
 */
export function diffShape(path: string, oldS: Shape, newS: Shape, depth = 0): Change[] {
  const changes: Change[] = [];
  if (depth >= MAX_DEPTH) return changes; // bound recursion: see MAX_DEPTH
  const ok = kind(oldS);
  const nk = kind(newS);

  if (ok !== nk) {
    changes.push({ severity: "breaking", path, message: `type changed from ${ok} to ${nk}` });
    return changes;
  }

  if (ok === "primitive") {
    if (oldS !== newS) {
      changes.push({ severity: "breaking", path, message: `type changed from ${String(oldS)} to ${String(newS)}` });
    }
    return changes;
  }

  if (ok === "object") {
    const o = (oldS as { object: Record<string, Shape> }).object;
    const n = (newS as { object: Record<string, Shape> }).object;
    for (const k of Object.keys(o)) {
      if (!(k in n)) changes.push({ severity: "breaking", path: `${path}.${k}`, message: "field removed from response" });
      else changes.push(...diffShape(`${path}.${k}`, o[k], n[k], depth + 1));
    }
    for (const k of Object.keys(n)) {
      if (!(k in o)) changes.push({ severity: "info", path: `${path}.${k}`, message: "field added to response" });
    }
    return changes;
  }

  // array
  const oe = (oldS as { array: Shape | null }).array;
  const ne = (newS as { array: Shape | null }).array;
  if (oe !== null && ne === null) {
    changes.push({ severity: "warning", path: `${path}[]`, message: "array is now empty (was populated)" });
  } else if (oe === null && ne !== null) {
    changes.push({ severity: "info", path: `${path}[]`, message: "array is now populated (was empty)" });
  } else if (oe !== null && ne !== null) {
    changes.push(...diffShape(`${path}[]`, oe, ne, depth + 1));
  }
  return changes;
}
