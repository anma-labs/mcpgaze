#!/usr/bin/env bash
# PoC: mcpgaze `record` writes request.params + response.result/error VERBATIM into
# a cassette JSON file at 0644, at a default repo-root path that is NOT gitignored.
# => plaintext secrets land in version control via the README-recommended commit flow.
#
# Deterministic + re-runnable. Uses a temp workdir; cleans up on exit.
set -euo pipefail

REPO="/home/gogetassgk/projects/mcpgaze"
WORK="$(mktemp -d /tmp/atrest-cassette-XXXXXX)"
CASSETTE="$WORK/c.json"
LOG="$WORK/session.jsonl"
SERVER="$WORK/mock-server.mjs"
DRIVER="$WORK/driver.mjs"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Secrets we will smuggle through a tools/call (in BOTH request args and the result).
ARG_SECRET="sk-live-AKIA1234LEAKED"      # secret in request.params (client -> server)
PW_SECRET="hunter2"                       # secret in request.params
RESULT_SECRET="Bearer eyJLEAKEDTOKEN"     # secret in response.result (server -> client)

# ── Mock MCP server: speaks JSON-RPC over stdio, echoes a secret back in the result.
cat > "$SERVER" <<'EOF'
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // notifications: no reply
  let result;
  if (msg.method === "initialize") {
    result = { protocolVersion: "2025-06-18", serverInfo: { name: "mock", version: "0" }, capabilities: {} };
  } else if (msg.method === "tools/call") {
    // Return a secret token verbatim in the tool result.
    result = { content: [{ type: "text", text: "auth=Bearer eyJLEAKEDTOKEN" }] };
  } else {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
});
EOF

# ── Driver: acts as the MCP client. Writes JSON-RPC requests carrying secrets in
#    params to mcpgaze's stdin, then closes stdin so record() finalizes the cassette.
cat > "$DRIVER" <<'EOF'
import { spawn } from "node:child_process";

const [, , casPath, logPath, argSecret, pwSecret] = process.argv;
const REPO = process.env.REPO;

const child = spawn("node", [
  "--import", "tsx",
  `${REPO}/src/index.ts`,
  "record",
  "--cassette", casPath,
  "--log", logPath,
  "--",
  "node", process.env.SERVER_PATH,
], { stdio: ["pipe", "pipe", "inherit"] });

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

// A tools/call whose ARGUMENTS carry secrets (api_key + password).
send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
  name: "deploy",
  arguments: { api_key: argSecret, password: pwSecret, region: "us-east-1" },
}});

// Give the server time to reply, then close stdin so the proxy/server exit and the
// cassette is written.
setTimeout(() => child.stdin.end(), 400);

child.on("exit", () => process.exit(0));
EOF

echo "== running mcpgaze record (ephemeral workdir: $WORK) =="
SERVER_PATH="$SERVER" REPO="$REPO" \
  node "$DRIVER" "$CASSETTE" "$LOG" "$ARG_SECRET" "$PW_SECRET" || true

echo
echo "== cassette exists? =="
ls -l "$CASSETTE"

echo
echo "== [EVIDENCE 1] grep for the three plaintext secrets in the cassette =="
grep -oE "$ARG_SECRET|$PW_SECRET|Bearer eyJLEAKEDTOKEN" "$CASSETTE" | sort -u

echo
echo "== [EVIDENCE 2] file mode of the cassette =="
stat -c '%a %n' "$CASSETTE"

echo
echo "== [EVIDENCE 3] git-ignore delta in the real repo =="
echo "-- cassette default path (repo root): mcpgaze.cassette.json"
if git -C "$REPO" check-ignore -v mcpgaze.cassette.json; then
  echo "   (IGNORED)"
else
  echo "   NOT IGNORED (exit $?) -> staged by 'git add .'"
fi
echo "-- session log default path: .mcpgaze/session-x.jsonl"
if git -C "$REPO" check-ignore -v .mcpgaze/session-x.jsonl; then
  echo "   IGNORED"
else
  echo "   NOT IGNORED"
fi

echo
echo "== cassette contents (pretty) =="
cat "$CASSETTE"

echo
echo "== DONE =="
