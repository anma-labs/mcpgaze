// A server exposing a `search` tool. With MOCK_DRIFT=1 its response SHAPE
// changes (a field disappears and the results array goes empty) while the
// declared tool schema stays identical — exactly what `verify` catches.
import { createInterface } from "node:readline";

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

const drift = process.env.MOCK_DRIFT === "1";

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
    respond(m.id, { protocolVersion: "2025-06-18", serverInfo: { name: "tooler", version: "1" }, capabilities: { tools: {} } });
  } else if (m.method === "tools/list") {
    respond(m.id, { tools: [{ name: "search", description: "search", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }] });
  } else if (m.method === "tools/call") {
    if (drift) {
      // missing `total`, empty results array
      respond(m.id, { content: [{ type: "text", text: "ok" }], results: [] });
    } else {
      respond(m.id, { content: [{ type: "text", text: "ok" }], results: [{ id: 1, title: "a" }], total: 1 });
    }
  }
});
