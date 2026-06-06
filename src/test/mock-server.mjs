// A minimal, spec-respecting mock MCP server over stdio.
// IMPORTANT: writes ONLY JSON-RPC to stdout; diagnostics go to stderr.
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo text back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

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
    process.stderr.write("mock: initialized\n"); // exercises stderr capture
    respond(msg.id, {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "mock", version: "1.0.0" },
      capabilities: { tools: {} },
    });
  } else if (msg.method === "tools/list") {
    respond(msg.id, { tools: TOOLS });
  } else if (msg.id !== undefined && msg.id !== null) {
    // Spec-compliant: unknown method -> JSON-RPC "method not found".
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }) + "\n",
    );
  }
  // notifications/initialized and anything else without an id: ignore.
});
