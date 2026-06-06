/**
 * Minimal JSON-RPC 2.0 surface for MCP. We only model the fields we need to
 * classify and correlate messages; everything else is forwarded verbatim and
 * never interpreted.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export type MessageKind =
  | "request"
  | "response"
  | "error"
  | "notification"
  | "unknown";

/** True for a present, non-null id. Note: id `0` is valid and must count. */
export function hasId(msg: JsonRpcMessage): boolean {
  return msg.id !== undefined && msg.id !== null;
}

export function classify(msg: JsonRpcMessage): MessageKind {
  const id = hasId(msg);
  if (msg.method !== undefined && id) return "request";
  if (msg.method !== undefined && !id) return "notification";
  if (msg.method === undefined && id && msg.error !== undefined) return "error";
  if (msg.method === undefined && id && msg.result !== undefined) return "response";
  return "unknown";
}
