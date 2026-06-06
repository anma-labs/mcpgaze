// A mock MCP server whose non-initialize responses contain a DEEPLY NESTED
// result on a single JSON line.
//
// V8's JSON.parse is iterative and accepts the value (so the framer / connection
// happily deliver it as live.result); JSON.stringify(value, null, 2) is recursive
// and overflows the stack at the same depth. This is untrusted server output that
// the observer/serialization path must survive without crashing the process.
//
// Writes ONLY JSON-RPC to stdout (per MCP stdio framing): one message per line.
import { createInterface } from "node:readline";

const DEPTH = Number(process.env.DEEP_DEPTH ?? "20000");

function deepResultJson(depth) {
  // One-line nested object text: {"a":{"a":...{"a":1}...}}
  let s = "";
  for (let i = 0; i < depth; i++) s += '{"a":';
  s += "1";
  for (let i = 0; i < depth; i++) s += "}";
  return s; // raw JSON text for the `result` field
}

const DEEP = deepResultJson(DEPTH);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "deep", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      }) + "\n",
    );
  } else if (msg.id !== undefined && msg.id !== null) {
    // Hand-write the envelope so the deep result stays exactly one line and we
    // don't re-serialize it here (which would overflow on this server too).
    process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":${DEEP}}\n`);
  }
  // notifications/initialized and anything else without an id: ignore.
});
