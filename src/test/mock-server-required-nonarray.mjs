// A mock MCP server whose tools/list returns a tool with inputSchema.required
// set to a TRUTHY NON-ITERABLE value (a number). Spec-respecting for initialize;
// deliberately malformed for tools/list.
// Used to exercise invariant (B): conform()'s observation path must not throw.
import { createInterface } from "node:readline";

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

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
    respond(msg.id, {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "mock", version: "1.0.0" },
      capabilities: { tools: {} },
    });
  } else if (msg.method === "tools/list") {
    // `required` is a number: truthy (passes the `!s?.required` guard) but
    // non-iterable, so `for (const r of s.required)` throws TypeError.
    respond(msg.id, {
      tools: [{ name: "t", inputSchema: { type: "object", properties: {}, required: 5 } }],
    });
  } else if (msg.id !== undefined && msg.id !== null) {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }) + "\n",
    );
  }
});
