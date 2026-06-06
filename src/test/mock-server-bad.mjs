// A NON-compliant MCP server: initialize result omits serverInfo.name, and a
// tool is missing its `name`. Used to prove the conformance suite catches it.
import { createInterface } from "node:readline";

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let m;
  try {
    m = JSON.parse(t);
  } catch {
    return;
  }
  if (m.method === "initialize") {
    respond(m.id, { protocolVersion: "2025-06-18", serverInfo: { version: "1" }, capabilities: {} }); // no name
  } else if (m.method === "tools/list") {
    respond(m.id, { tools: [{ description: "nameless", inputSchema: { type: "object" } }] }); // no name
  }
  // unknown methods: intentionally NO response (also a conformance failure)
});
