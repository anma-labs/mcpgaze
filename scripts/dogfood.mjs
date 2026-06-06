// Dogfood: mcpgaze's own `replay` server is an MCP server — run mcpgaze's
// conformance suite against it. The tool must satisfy its own spec checks.
import { spawn } from "node:child_process";

function drive(cmd, args, feed) {
  return new Promise((r) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "inherit"] });
    p.on("exit", () => r());
    for (const f of feed) p.stdin.write(f + "\n");
    setTimeout(() => p.stdin.end(), 500);
  });
}
// 1) record a cassette from the bundled mock server
await drive("node", ["dist/index.js", "record", "--cassette", "/tmp/dogfood.json", "--", "node", "src/test/mock-server.mjs"], [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"d","version":"1"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
]);
// 2) conform mcpgaze's replay server against mcpgaze's own suite
const code = await new Promise((r) => {
  const p = spawn("node", ["dist/index.js", "conform", "--", "node", "dist/index.js", "replay", "--cassette", "/tmp/dogfood.json"], { stdio: "inherit" });
  p.on("exit", (c) => r(c ?? 1));
});
console.log(code === 0 ? "✓ mcpgaze's replay server passes mcpgaze's conformance suite" : "✗ dogfood conformance failed");
process.exit(code);
