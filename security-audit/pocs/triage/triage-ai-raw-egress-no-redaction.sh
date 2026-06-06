#!/usr/bin/env bash
# PoC: triage --ai ships raw server stderr + raw JSON-RPC error bodies to
# api.anthropic.com with NO redaction and NO per-content consent.
#
# Two independent proofs, neither hits the real Anthropic API:
#   (A) import-level: import extractFailures/buildTriagePrompt/callClaude from
#       src/triage.ts, stub globalThis.fetch, assert all secrets appear in the
#       built prompt AND in the captured POST body, and that the URL is the
#       fixed Anthropic endpoint.
#   (B) end-to-end CLI: write a real .jsonl session log, run the actual
#       `triage --log <file> --ai` command through cmdTriage with a stubbed
#       fetch (injected via --import), and confirm the same secrets land in the
#       POST body produced by the real wiring.
#
# Deterministic and re-runnable. Creates only /tmp artifacts + a temp .mts; all
# cleaned up on exit.
set -euo pipefail

REPO="/home/gogetassgk/projects/mcpgaze"
TSX="node --import tsx"
LOG="/tmp/triage-triage-ai-raw-egress-no-redaction.jsonl"
POC_IMPORT="/tmp/triage_poc_import.mts"
FETCH_STUB="/tmp/triage_poc_fetchstub.mts"
BODY_OUT="/tmp/triage_poc_captured_body.json"

cleanup() { rm -f "$LOG" "$POC_IMPORT" "$FETCH_STUB" "$BODY_OUT"; }
trap cleanup EXIT

# The three distinct secrets we plant.
SECRET_STDERR_KEY="sk-ant-LEAK-STDERR-0123456789abcdef"
SECRET_DSN="postgres://admin:Sup3rS3cret@db.internal:5432/prod"
SECRET_RPC_TOKEN="AKIA_LEAK_RPC_TOKEN_9876"

echo "============================================================"
echo "PART A — import-level proof (prompt + captured POST body)"
echo "============================================================"

cat > "$POC_IMPORT" <<'EOF'
import { extractFailures, buildTriagePrompt, callClaude } from "/home/gogetassgk/projects/mcpgaze/src/triage.ts";

const SECRET_STDERR_KEY = "sk-ant-LEAK-STDERR-0123456789abcdef";
const SECRET_DSN = "postgres://admin:Sup3rS3cret@db.internal:5432/prod";
const SECRET_RPC_TOKEN = "AKIA_LEAK_RPC_TOKEN_9876";

// Events exactly as the proxy/logger would record them in a session JSONL.
const events = [
  {
    type: "server_stderr",
    text: `FATAL error: failed to connect ${SECRET_DSN} apikey=${SECRET_STDERR_KEY}`,
  },
  {
    type: "message",
    kind: "error",
    dir: "s2c",
    method: "tools/call",
    id: 7,
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: `auth failed token=${SECRET_RPC_TOKEN}` },
    }),
  },
];

const failures = extractFailures(events as any);
const prompt = buildTriagePrompt(failures);

console.log("-- failures extracted:", failures.length);
console.log("-- secrets present in PROMPT:");
for (const [name, s] of [["stderr sk-ant key", SECRET_STDERR_KEY], ["postgres DSN", SECRET_DSN], ["rpc AKIA token", SECRET_RPC_TOKEN]] as const) {
  console.log(`     ${name}: present in prompt = ${prompt.includes(s)}`);
}

// Stub fetch so NOTHING reaches the real Anthropic API. Capture the request.
let captured: { url: string; body: string; headers: any } | null = null;
(globalThis as any).fetch = async (url: any, init: any) => {
  captured = { url: String(url), body: String(init?.body ?? ""), headers: init?.headers };
  return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

await callClaude(prompt, "fake-key-not-real");

if (!captured) { console.error("FAIL: fetch was never called"); process.exit(1); }
const c = captured as { url: string; body: string; headers: any };
console.log("-- callClaude POSTed to URL:", c.url);
console.log("-- x-api-key header sent   :", c.headers?.["x-api-key"]);
const allInBody = [SECRET_STDERR_KEY, SECRET_DSN, SECRET_RPC_TOKEN].every((s) => c.body.includes(s));
console.log("-- POST body contains all three secrets:", allInBody);
console.log("-- URL is fixed Anthropic endpoint     :", c.url === "https://api.anthropic.com/v1/messages");

const allInPrompt = [SECRET_STDERR_KEY, SECRET_DSN, SECRET_RPC_TOKEN].every((s) => prompt.includes(s));
if (allInPrompt && allInBody && c.url === "https://api.anthropic.com/v1/messages") {
  console.log("RESULT A: EXPLOITABLE — raw secrets egress verbatim, no redaction.");
} else {
  console.log("RESULT A: NOT reproduced.");
  process.exit(1);
}
EOF

$TSX "$POC_IMPORT"

echo
echo "============================================================"
echo "PART B — end-to-end CLI proof through real cmdTriage wiring"
echo "============================================================"

# Real session log lines, exactly the shape Logger writes.
{
  printf '%s\n' "$(node -e '
    const s = process.argv;
    console.log(JSON.stringify({t:new Date().toISOString(),type:"server_stderr",text:"FATAL error: failed to connect "+s[1]+" apikey="+s[2]}));
  ' "$SECRET_DSN" "$SECRET_STDERR_KEY")"
  printf '%s\n' "$(node -e '
    const s = process.argv;
    console.log(JSON.stringify({t:new Date().toISOString(),type:"message",dir:"s2c",kind:"error",id:7,method:"tools/call",raw:JSON.stringify({jsonrpc:"2.0",id:7,error:{code:-32000,message:"auth failed token="+s[1]}})}));
  ' "$SECRET_RPC_TOKEN")"
} > "$LOG"

echo "-- wrote session log: $LOG"

# A preload module that stubs fetch and writes the captured body to disk,
# loaded BEFORE the CLI runs via --import. This exercises the genuine
# triage()/callClaude() path; only the network egress is intercepted.
cat > "$FETCH_STUB" <<EOF
const realJSON = JSON.stringify;
(globalThis as any).fetch = async (url: any, init: any) => {
  const fs = await import("node:fs");
  fs.writeFileSync("$BODY_OUT", realJSON({ url: String(url), body: String(init?.body ?? ""), apiKeyHeader: init?.headers?.["x-api-key"] }));
  return new Response(realJSON({ content: [{ type: "text", text: "stubbed-ok" }] }), { status: 200, headers: { "content-type": "application/json" } });
};
EOF

rm -f "$BODY_OUT"
# Run the ACTUAL CLI command. ANTHROPIC_API_KEY=fake satisfies the only gate.
ANTHROPIC_API_KEY="fake-key-not-real" node --import tsx --import "$FETCH_STUB" \
  "$REPO/src/index.ts" triage --log "$LOG" --ai >/tmp/triage_poc_cli_stdout.txt 2>&1 || true

echo "-- CLI stdout (truncated):"
sed -n '1,6p' /tmp/triage_poc_cli_stdout.txt | sed 's/^/     /'

if [ ! -f "$BODY_OUT" ]; then
  echo "RESULT B: callClaude/fetch was not invoked (gate held?). See stdout above."
  exit 1
fi

echo "-- captured POST destination URL:"
node -e 'const d=require("'"$BODY_OUT"'");console.log("     "+d.url);console.log("     x-api-key header = "+d.apiKeyHeader)'
echo "-- grep for plaintext secrets in the captured POST body:"
grep -o "$SECRET_STDERR_KEY" "$BODY_OUT" | head -1 | sed 's/^/     HIT: /'
grep -o "$SECRET_DSN"        "$BODY_OUT" | head -1 | sed 's/^/     HIT: /'
grep -o "$SECRET_RPC_TOKEN"  "$BODY_OUT" | head -1 | sed 's/^/     HIT: /'

if grep -q "$SECRET_STDERR_KEY" "$BODY_OUT" && grep -q "$SECRET_DSN" "$BODY_OUT" && grep -q "$SECRET_RPC_TOKEN" "$BODY_OUT"; then
  echo "RESULT B: EXPLOITABLE — real CLI 'triage --ai' egresses all three raw secrets to api.anthropic.com."
else
  echo "RESULT B: NOT reproduced."
  exit 1
fi

rm -f /tmp/triage_poc_cli_stdout.txt
echo
echo "ALL PARTS REPRODUCED."
