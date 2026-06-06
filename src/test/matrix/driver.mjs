// Robust MCP stdio driver: spawns a command (the mcpgaze proxy OR a server),
// sends a scripted sequence of JSON-RPC messages, and for each *request* waits
// for the response with the matching id before sending the next line. Closes
// stdin cleanly at the end so the proxy flushes its cassette and exits.
// Usage: node driver.mjs <script.jsonl> -- <command...>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const i = process.argv.indexOf("--");
const scriptPath = process.argv[2];
const cmd = process.argv.slice(i + 1);
const lines = readFileSync(scriptPath, "utf8").split("\n").filter((l) => l.trim());
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
const waitFor = (id, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => { waiters.delete(id); rej(new Error("timeout id " + id)); }, ms);
  waiters.set(id, (m) => { clearTimeout(t); res(m); });
});
for (const line of lines) {
  const msg = JSON.parse(line);
  child.stdin.write(line + "\n");
  if (msg.id !== undefined) { try { await waitFor(msg.id, 12000); } catch (e) { console.error("[driver]", e.message); } }
}
await new Promise((r) => setTimeout(r, 400));
child.stdin.end();
await new Promise((r) => child.on("exit", r));
