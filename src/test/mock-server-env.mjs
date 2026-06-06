// Mock MCP server that REQUIRES an env var. If MCP_SECRET is absent it never
// answers initialize (simulating a server that silently fails without its
// config) — exactly the failure mode preflight is built to catch.
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
  if (!process.env.MCP_SECRET) {
    process.stderr.write("fatal: MCP_SECRET is not set\n");
    return; // never respond -> client times out
  }
  if (m.method === "initialize") {
    respond(m.id, { protocolVersion: "2025-06-18", serverInfo: { name: "needs-env", version: "1" }, capabilities: { tools: {} } });
  } else if (m.method === "tools/list") {
    respond(m.id, { tools: [] });
  }
});
