import { readFileSync, writeFileSync } from "node:fs";
import { McpConnection } from "./mcp-connection";
import { shapeOf, diffShape } from "./shape";
import type { Change } from "./schema-diff";
import { PROTOCOL_VERSION } from "./client";
import { VERSION } from "./version";
import { parseCassette, type Interaction } from "./cassette";

export interface VerifyResult {
  checked: number;
  changes: Array<Change & { method: string }>;
  errors: Array<{ method: string; message: string }>;
  /** Verifiable state-changing methods skipped because re-issuing them wasn't opted into. */
  skipped: string[];
}

export interface VerifyOptions {
  timeoutMs?: number;
  /**
   * The cassette is untrusted JSON: its method/params are re-issued verbatim to
   * the live server. By default we re-issue only read-only methods; opt in to
   * also re-issue state-changing calls (tools/call, etc).
   */
  allowToolCalls?: boolean;
}

/** Read-only MCP methods that are safe to re-issue from an untrusted cassette. */
const READ_ONLY_METHODS = new Set([
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "ping",
  "completion/complete",
]);

/** Methods we never re-issue: handshake + fire-and-forget notifications. */
function isVerifiable(method: string): boolean {
  return method !== "initialize" && !method.startsWith("notifications/");
}

/**
 * Whether to re-issue this recorded method against the live server. State-
 * changing methods (anything outside the read-only allow-list) are skipped
 * unless the operator opts in — a hostile cassette must not be able to drive
 * arbitrary tools/call or resources/read at the live server through verify.
 */
function shouldReissue(method: string, allowToolCalls: boolean): boolean {
  if (!isVerifiable(method)) return false;
  return allowToolCalls || READ_ONLY_METHODS.has(method);
}

/**
 * Re-issue each recorded request against the LIVE server and compare the SHAPE
 * of the response to the recorded one. Catches drift that `diff` (declared
 * schemas) cannot see.
 *
 * Caveat: this executes real tool calls. Run it against read-only tools or a
 * disposable/test server instance.
 */
export async function verify(
  command: string,
  args: string[],
  cassettePath: string,
  timeoutMs = 15000,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const allowToolCalls = Boolean(opts.allowToolCalls);
  const cassette = parseCassette(readFileSync(cassettePath, "utf8"));
  const conn = McpConnection.spawn(command, args);
  const result: VerifyResult = { checked: 0, changes: [], errors: [], skipped: [] };

  try {
    const init = await conn.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mcpgaze", version: VERSION } },
      timeoutMs,
    );
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
    conn.notify("notifications/initialized");

    for (const it of cassette.interactions as Interaction[]) {
      const method = it.request.method;
      if (!isVerifiable(method)) continue;
      if (!shouldReissue(method, allowToolCalls)) {
        result.skipped.push(method); // state-changing + not opted in
        continue;
      }
      result.checked++;

      let live;
      try {
        live = await conn.request(method, it.request.params, timeoutMs);
      } catch (e) {
        result.errors.push({ method, message: (e as Error).message.split("\n")[0] });
        continue;
      }

      const recordedIsError = it.response.error !== undefined;
      const liveIsError = live.error !== undefined;
      if (recordedIsError !== liveIsError) {
        result.changes.push({
          method,
          severity: "breaking",
          path: method,
          message: recordedIsError
            ? "recorded an error but the live server now returns a result"
            : "recorded a result but the live server now returns an error",
        });
        continue;
      }
      if (recordedIsError) continue; // both errors: nothing shape-wise to compare

      const recordedShape = shapeOf(it.response.result);
      const liveShape = shapeOf(live.result);
      for (const c of diffShape(method, recordedShape, liveShape)) {
        result.changes.push({ method, ...c });
      }
    }

    return result;
  } finally {
    conn.close();
  }
}

/**
 * Re-baseline: re-issue each recorded request against the live server and
 * overwrite the cassette's responses with what the server returns now. This is
 * how you "accept" intentional behavioral drift so `verify` stops flagging it —
 * the same idea as `--updateSnapshot`. Returns the number of updated entries.
 */
export async function updateCassette(
  command: string,
  args: string[],
  cassettePath: string,
  timeoutMs = 15000,
  opts: VerifyOptions = {},
): Promise<number> {
  const allowToolCalls = Boolean(opts.allowToolCalls);
  const cassette = parseCassette(readFileSync(cassettePath, "utf8"));
  const conn = McpConnection.spawn(command, args);
  let updated = 0;
  try {
    const init = await conn.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mcpgaze", version: VERSION } },
      timeoutMs,
    );
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
    conn.notify("notifications/initialized");

    for (const it of cassette.interactions as Interaction[]) {
      if (!shouldReissue(it.request.method, allowToolCalls)) continue;
      const live = await conn.request(it.request.method, it.request.params, timeoutMs);
      it.response = live.error ? { error: live.error } : { result: live.result };
      updated++;
    }
    cassette.recordedAt = new Date().toISOString();
    // The live server is untrusted: a deeply-nested result stored verbatim above
    // overflows V8's recursive JSON.stringify. Contain that here so the observer
    // path surfaces a clean, handled error instead of an uncaught RangeError.
    let serialized: string;
    try {
      serialized = JSON.stringify(cassette, null, 2) + "\n";
    } catch (e) {
      throw new Error(
        `failed to serialize updated cassette (a live response is too deeply nested): ${(e as Error).message}`,
      );
    }
    writeFileSync(cassettePath, serialized, { mode: 0o600 }); // see CassetteRecorder.write
    return updated;
  } finally {
    conn.close();
  }
}
