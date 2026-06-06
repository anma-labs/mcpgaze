#!/usr/bin/env bash
# PoC: jsonl-plaintext-params-and-stderr
#
# Proves that mcpgaze `record` (same Logger path as `wrap`/`wrap-http`) persists,
# in PLAINTEXT and with mode 0644:
#   - the full JSON-RPC line (logger.ts:58 `raw: f.raw`), including tools/call
#     params.arguments that carry api_key / password / bearer token;
#   - verbatim server stderr (logger.ts:64-66 / proxy.ts:141), including a
#     postgres:// connection string with an embedded password.
# Also shows the cassette persists request.params verbatim (cassette.ts:43).
#
# Deterministic and re-runnable. Writes only to /tmp; cleans up on exit.
set -euo pipefail

REPO=/home/gogetassgk/projects/mcpgaze
WORK="$(mktemp -d /tmp/atrest-jsonl-poc.XXXXXX)"
LOG="$WORK/session.jsonl"
CASS="$WORK/c.json"
MOCK="$WORK/mock-server.mjs"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# 1) Mock MCP server: prints a secret-bearing connection string to stderr on
#    start, then echoes any {id,method} request back, embedding its params.
cat > "$MOCK" <<'EOF'
process.stderr.write("connecting: postgres://admin:SUPERSECRET_DB_PW@db.internal:5432/prod\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m && m.id !== undefined && m.method !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { echoBack: m.params } }) + "\n");
    }
  }
});
EOF

# 2) Drive the record command from the repo root so tsx resolves; secrets are
#    passed as tools/call arguments.
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"login","arguments":{"api_key":"sk-live-AKIA1234LEAKED","password":"hunter2","authorization":"Bearer eyJLEAKEDTOKEN"}}}' \
  | ( cd "$REPO" && node --import tsx src/index.ts record --log "$LOG" --cassette "$CASS" -- node "$MOCK" ) \
  || true

echo "=========================================================="
echo "[*] grep for plaintext secrets in the session JSONL:"
grep -oE 'sk-live-AKIA1234LEAKED|hunter2|Bearer eyJLEAKEDTOKEN|SUPERSECRET_DB_PW' "$LOG" | sort | uniq -c

echo
echo "[*] the server_stderr event line (full postgres:// string verbatim):"
grep -n 'server_stderr' "$LOG"

echo
echo "[*] the c2s tools/call message line (params.arguments verbatim):"
grep -n 'tools/call' "$LOG"

echo
echo "[*] cassette also persists request.params verbatim:"
grep -oE 'sk-live-AKIA1234LEAKED|hunter2|Bearer eyJLEAKEDTOKEN' "$CASS" | sort | uniq -c

echo
echo "[*] file modes (expect 644 = group/world-readable, no 0600):"
stat -c '%a %n' "$LOG" "$CASS"
echo "=========================================================="
