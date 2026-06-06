# Security Audit Report — mcpgaze ("mcptap") CLI

**Repository:** `/home/gogetassgk/projects/mcpgaze`
**Version audited:** mcpgaze v1.0.0 (commit `a4f2173`)
**Date:** 2026-06-05
**Audit type:** Red-team / source-level review with reproducible proof-of-concept (PoC) exploits
**Author:** Lead author, security-audit working group

---

## 1. Executive Summary

mcpgaze is a developer "wiretap" proxy for the Model Context Protocol (MCP). It sits between an MCP client and an MCP server (over stdio via `wrap`/`record`, or over HTTP via `wrap-http`), logs traffic to session JSONL, records reusable **cassettes**, replays/`verify`s them, and offers an optional `triage --ai` command that ships failure context to the Anthropic API.

This audit reproduced **five** confirmed findings with self-contained, deterministic PoCs (each exits 0 on exploit and cleans up after itself). The dominant theme is **data governance at rest and in transit**: mcpgaze persists and forwards raw protocol bytes — JSON-RPC params, tool results, and verbatim server stderr — with **no redaction anywhere in the codebase** (`grep -rniE "redact|sanitize|scrub|consent|mask" src/` returns nothing on any live path). Secrets that flow through the proxy are written in cleartext to world-readable (`0644`) files, one of which (the cassette) sits on a **non-gitignored default repo-root path**, and can additionally be egressed to an external API.

There are **no critical or high findings**: nothing here is a remote, unauthenticated escalation or an RCE. The HTTP proxy is `127.0.0.1`-bound by default and Origin-checked, and several attack classes the brief flagged were probed and found **genuinely defended** (SSRF/DNS-rebinding via `--route`/redirect; cassette-as-untrusted-parser crashes including depth bombs and over-long lines; prototype pollution). Those negative results are documented in Section 6 ("Defenses That Held") because they materially scope the residual risk.

**Confirmed severity distribution:** 0 critical · 0 high · 3 medium · 2 low.

The three **medium** findings are all secret-disclosure issues (session JSONL + stderr at rest; committable cassette; `triage --ai` egress). The two **low** findings are operator-/config-gated trust-boundary issues (cross-route header leakage; cassette-driven arbitrary live requests in `verify`). The single highest-leverage remediation is to introduce a redaction pass plus `0600` file modes on every persistence/egress sink, since one shared `Logger`/cassette path underlies `wrap`, `wrap-http`, `record`, and feeds `triage`.

---

## 2. Severity-Ranked Findings (Confirmed)

| # | Severity | Finding | Attack Class | One-line Impact | Affected Files |
|---|----------|---------|--------------|-----------------|----------------|
| F-1 | **medium** | Session JSONL & cassette persist full JSON-RPC params + verbatim server stderr in plaintext, mode `0644` | Secret-at-rest | Passwords/API keys/DSNs in tool-call args and stderr are written cleartext to group/world-readable logs | `src/logger.ts`, `src/proxy.ts`, `src/framer.ts`, `src/cassette.ts`, `src/index.ts` |
| F-2 | **medium** | Cassette stores `request.params` + `response.result` verbatim at `0644` on a non-gitignored default repo-root path | Secret-at-rest | A recorded secret-bearing cassette is world-readable and staged by `git add .`, so secrets can be committed/shared | `src/cassette.ts`, `src/proxy.ts`, `src/index.ts`, `.gitignore`, `README.md` |
| F-3 | **medium** | `triage --ai` ships raw server stderr + raw JSON-RPC error bodies to Anthropic with no redaction or per-content consent | Triage egress | Secrets/DSNs/tokens/PII in failure context leave the machine to `api.anthropic.com` on an opt-in flag | `src/triage.ts`, `src/index.ts`, `src/logger.ts`, `src/proxy.ts` |
| F-4 | **low** | `Authorization`/`Cookie` forwarded to whichever upstream the path resolves to (no per-route credential scoping) | Header leakage | In a multi-route `wrap-http` config, a client's global credential lands on the wrong upstream, and that upstream's `Set-Cookie` returns to the client | `src/http-proxy.ts`, `src/index.ts` |
| F-5 | **low** | `verify` / `verify --update` re-issue attacker-controlled method/params from the cassette verbatim to the operator-chosen live server | Replay / untrusted-file parser | A hostile cassette turns `verify` into a generator of arbitrary JSON-RPC calls (incl. destructive `tools/call`) against the live server | `src/verify.ts`, `src/mcp-connection.ts`, `src/index.ts` |

---

## 2a. Remediation & Re-verification Status (2026-06-06)

Hardening patches for all five findings were authored, **applied to the working tree**, and re-verified by re-running each original PoC against the patched source. Verification gates: `tsc --noEmit` clean, `npm test` **96/96 pass** (two tests updated to assert the new secure defaults: `http-proxy.test.ts`, `conform-verify.test.ts`). A new shared `src/redact.ts` provides a conservative, dependency-free, **fail-safe** redactor used **only** on observer artifacts and triage egress — **never** on the forwarded protocol stream (invariant A) and unable to throw into the observer (invariant B). Full diff: `security-audit/patches/hardening.patch`.

| # | Final status | What changed | PoC re-verification |
|---|--------------|--------------|---------------------|
| F-1 | **Resolved on `record`; residual accepted on `wrap`/`wrap-http`** | File modes → `0600` (always-on). `record` redacts params + result + stderr **by default** (`--no-redact` opts out). `wrap`/`wrap-http` redaction stays **opt-in** (`--redact`) by design — a live wiretap must show exact bytes; residual mitigated to owner-only `0600`. | `record` PoC: **0** plaintext secrets in JSONL/cassette (was 4); `***REDACTED***` present; mode `600`. |
| F-2 | **Resolved** | Cassette (produced only by `record`) now redacts **by default** + `0600` + `*.cassette.json`/`mcpgaze.cassette.json` added to `.gitignore` + README corrected. | Cassette PoC: **0** plaintext secrets (was 3); mode `600`; path now git-ignored. |
| F-3 | **Resolved** | **Always-on** redaction at the egress boundary (`buildTriagePrompt`) + explicit `--yes` consent gate that previews the exact bytes; non-interactive send without `--yes` is refused. | Egress PoC: **0** raw secrets in the captured POST body even after consent; send blocked without consent. |
| F-4 | **Resolved** | Per-route credential scoping: multi-route configs strip `authorization`/`cookie` outbound and `set-cookie`/`mcp-session-id` on copy-back unless a route opts in (`--forward-credentials` / `--creds-route`). Single-`--upstream` back-compat preserved. | Header-leak PoC: defense held — credential `null` at the wrong upstream; opt-in path still forwards. |
| F-5 | **Resolved** | Read-only method allow-list by default; state-changing cassette methods skipped + reported, gated behind `--allow-tool-calls`. Added `parseCassette()` shape-validation and wrapped the replay-server stdin `framer.push` in try/catch (matching `runProxy`). | Replay PoC: **0** destructive calls reached the live server (was 2); only re-issued with `--allow-tool-calls`. |

**Design note (F-1).** The one deliberately-accepted residual: `wrap`/`wrap-http` still write the session JSONL verbatim by default, because the tool's purpose is to show the exact bytes on the wire and redacting the default debug view would defeat it. That exposure is reduced from world-readable (`0644`) to owner-only (`0600`); operators who tee a live session into a shareable file should pass `--redact`. The `record` command — whose output is an explicitly shareable/committable cassette — redacts by default, closing the highest-risk path.

---

## 3. Detailed Findings

### F-1 — Session JSONL & cassette persist plaintext params + verbatim stderr at mode 0644
**Severity:** medium  ·  **Attack class:** Secret-at-rest  ·  **Finding ID:** `jsonl-plaintext-params-and-stderr`

**Mechanism.**
`Logger.message` (`src/logger.ts:47-60`) writes the event field `raw: f.raw`, where `f.raw` is the **entire JSON-RPC line verbatim** as captured by `LineFramer.emit` (`src/framer.ts:77`). A `tools/call` whose `params.arguments` carry a password / API key / bearer token is therefore stored in cleartext in the session JSONL. Separately, `Logger.serverStderr` (`src/logger.ts:64-66`) writes `text` = the raw server stderr chunk verbatim, fed by `src/proxy.ts:141` (`opts.logger.serverStderr(chunk.toString('utf8'))`), so any connection string / token / stack trace a server prints to stderr is captured. **No redaction, masking, or filtering exists anywhere on this path.**

The sink is `createWriteStream` (`src/logger.ts:37`) opened with the default mode `0666`, which becomes `0644` under the environment umask `0022` (confirmed) — group/world-readable. The same `Logger` + `runProxy` path is shared by `wrap` (`src/index.ts:111`), `wrap-http` (`src/index.ts:169`), and `record` (`src/index.ts:196`); the default log path is `.mcpgaze/session-<ts>.jsonl`. During `record`, the cassette additionally persists `request.params` verbatim (`src/cassette.ts:43`).

**File:line anchors.**
- `src/logger.ts:37` — `createWriteStream(..., { flags: "a" })`, no `mode` → `0644`
- `src/logger.ts:47`, `:58` — `Logger.message` writes `raw: f.raw` (full wire line)
- `src/logger.ts:64`, `:65` — `Logger.serverStderr` writes raw stderr `text`
- `src/framer.ts:77` — `f.raw` is the verbatim line
- `src/proxy.ts:141` — raw stderr piped to logger
- `src/cassette.ts:43` — `request.params` persisted verbatim
- `src/index.ts:111`, `:169`, `:196` — shared `Logger`/`runProxy` across `wrap`/`wrap-http`/`record`

**Attacker model.** Not remote. This is a **local-filesystem and host-multi-tenancy** exposure: any user/process that can read the `0644` JSONL (same host, shared dev box, backup, container layer) recovers cleartext secrets that legitimately transited the proxy. No misconfiguration is required beyond the documented default workflow — recording any session with a credential-bearing `tools/call` or a server that logs a DSN to stderr is sufficient.

**PoC.** `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/atrest/jsonl-plaintext-params-and-stderr.sh`
**Repro:**
```
bash /home/gogetassgk/projects/mcpgaze/security-audit/pocs/atrest/jsonl-plaintext-params-and-stderr.sh
```
Self-contained: creates a mock server + temp dir under `/tmp`, runs `node --import tsx src/index.ts record` from the repo root, greps the resulting `session.jsonl` and cassette for four planted secrets, prints the `server_stderr` line and `stat -c %a` (→ `644`), then cleans up.

**Captured evidence.**
```
[*] grep for plaintext secrets in the session JSONL:
      2 Bearer eyJLEAKEDTOKEN
      1 SUPERSECRET_DB_PW
      2 hunter2
      2 sk-live-AKIA1234LEAKED

[*] server_stderr event line (full postgres:// string verbatim):
{"t":"...","type":"server_stderr","text":"connecting: postgres://admin:SUPERSECRET_DB_PW@db.internal:5432/prod\n"}

[*] c2s tools/call message line (params.arguments verbatim):
{"...","raw":"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"login\",\"arguments\":{\"api_key\":\"sk-live-AKIA1234LEAKED\",\"password\":\"hunter2\",\"authorization\":\"Bearer eyJLEAKEDTOKEN\"}}}"}

[*] file modes (expect 644):
644 .../session.jsonl
644 .../c.json
```
All four secrets present in plaintext; the `postgres://` DSN captured verbatim from stderr; both files mode `0644`.

**Remediation.** Open the JSONL/cassette sinks with mode `0600` (`createWriteStream(path, { flags: "a", mode: 0o600 })` and `writeFileSync(..., { mode: 0o600 })`), and add an **opt-in redaction pass** that masks common credential keys (`password`, `api_key`, `token`, `authorization`, `secret`) inside params and known secret patterns (`sk-*`, `AKIA*`, bearer JWTs, `user:pass@host` DSNs) in server stderr before they are written. Note the project already knows what secrets look like — `src/preflight.ts:15` carries a `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DSN` regex — but that knowledge is applied only to env-var *names* in the preflight diagnostic and never reaches the logging path.

**Scoping precision (honest negatives).** The transport `Authorization` HTTP header is **not** logged: in `wrap-http`, `forwardHeaders` (`src/http-proxy.ts:115-125`) forwards it upstream but never hands it to the logger; only `observe()` (`src/http-proxy.ts:127-141`) feeds the JSON-RPC *body* to the logger. Bearer tokens therefore leak only when they appear inside params/result or stderr, not from the transport header. Also, the default JSONL dir `.mcpgaze/` **is** gitignored (`.gitignore:3`), so this finding is a local-filesystem concern, not a VCS one — hence medium, not higher.

---

### F-2 — Cassette stores secrets verbatim at 0644 on a non-gitignored default path
**Severity:** medium  ·  **Attack class:** Secret-at-rest  ·  **Finding ID:** `cassette-plaintext-secrets-committable`

**Mechanism.**
The `Correlator` (`src/proxy.ts:66-69`) pairs each JSON-RPC request with its response, capturing `p.params` and `f.msg.result` verbatim. During `record`, `cmdRecord` (`src/index.ts:206`) feeds those pairs to `CassetteRecorder.add` (`src/cassette.ts:43-44`), which stores `request.params` and `response.result`/`error` exactly as observed — no redaction. `write()` (`src/cassette.ts:61`) calls `writeFileSync(path, JSON.stringify(..., null, 2) + "\n")` with **no `mode` option**, so the file is created `0666 & ~umask` = `0644` (world-readable); there is no `chmod`/`0o600` anywhere.

The default cassette path is repo-root `mcpgaze.cassette.json` (`src/index.ts:195`), which `git check-ignore` **confirms is NOT ignored** (the `.gitignore` covers only `node_modules/`, `dist/`, `.mcpgaze/`, `*.log`, `.DS_Store`, and native build dirs). So `git add .` stages it. A `tools/call` carrying secrets in its arguments (client→server) and/or in the tool result (server→client) is therefore written in cleartext to a world-readable file on the default commit path. The cassette is positioned as a checked-in CI/offline regression artifact (`README.md:108` — "for offline client development and regression CI").

**File:line anchors.**
- `src/cassette.ts:43`, `:44` — `request.params` and `response.result`/`error` stored verbatim
- `src/cassette.ts:61` — `writeFileSync` with no `mode` → `0644`
- `src/proxy.ts:66-69` — Correlator captures params/result verbatim
- `src/index.ts:195` — default cassette path is repo-root `mcpgaze.cassette.json`
- `src/index.ts:206` — `cmdRecord` feeds pairs to the recorder
- `.gitignore:3` — `.mcpgaze/` ignored; the repo-root cassette is not
- `README.md:108` — cassette framed as a checked-in CI artifact

**Attacker model.** Two-step, operator-gated: (1) the operator records a session containing a secret-bearing `tools/call` or result, then (2) commits/shares the resulting world-readable cassette (e.g. `git add . && git commit`, push to a shared repo, attach to a CI fixture, or paste it into a ticket). Anyone with repo or CI read access then recovers the secrets. No remote attacker; impact is conditional on operator action, but the action is exactly the documented "regression CI / offline dev" workflow.

**PoC.** `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/atrest/cassette-plaintext-secrets-committable.sh`
**Repro:**
```
bash /home/gogetassgk/projects/mcpgaze/security-audit/pocs/atrest/cassette-plaintext-secrets-committable.sh
```
Stands up a mock stdio MCP server + client driver in an ephemeral `/tmp` workdir, runs `node --import tsx src/index.ts record --cassette <tmp>`, greps three planted secrets, stats the `0644` mode, and runs `git check-ignore -v mcpgaze.cassette.json` vs `.mcpgaze/session-x.jsonl` in the real repo.

**Captured evidence.**
```
== [EVIDENCE 1] grep for the three plaintext secrets in the cassette ==
Bearer eyJLEAKEDTOKEN
hunter2
sk-live-AKIA1234LEAKED
== [EVIDENCE 2] file mode of the cassette ==
644 /tmp/atrest-cassette-XXXX/c.json   (ls: -rw-r--r--)
== [EVIDENCE 3] git-ignore delta in the real repo ==
-- cassette default path: mcpgaze.cassette.json -> NOT IGNORED (git check-ignore exit 1) -> staged by 'git add .'
-- session log default path: .mcpgaze/session-x.jsonl -> IGNORED (.gitignore:3:.mcpgaze/)
```
Cassette body stored verbatim: `request.params.arguments = {api_key:"sk-live-AKIA1234LEAKED", password:"hunter2", region:"us-east-1"}`; `response.result.content[0].text = "auth=Bearer eyJLEAKEDTOKEN"`.

**Remediation.** Write cassettes (and session JSONL) with `writeFileSync(path, data, { mode: 0o600 })`; add `mcpgaze.cassette.json` and `*.cassette.json` to `.gitignore`; and redact/optionally-mask (or at minimum warn about) params + results before persisting. Correct the README so it never implies committing raw cassettes.

**Documentation note.** One auditor anchor was overstated and is corrected here: `README.md:56` ("commit it") refers to `mcpgaze.baseline.json` (the snapshot), **not** the cassette. The README never literally says "commit the cassette," though it does frame cassettes as checked-in CI/offline regression artifacts (`README.md:108`) and the default cassette path is a non-gitignored repo-root file. Severity held at medium accordingly.

---

### F-3 — `triage --ai` egresses raw stderr / error bodies to Anthropic with no redaction or consent
**Severity:** medium  ·  **Attack class:** Triage egress  ·  **Finding ID:** `triage-ai-raw-egress-no-redaction`

**Mechanism (data flow).**
1. The proxy records the **full** raw server stderr and **full** raw JSON-RPC message body verbatim into the session JSONL: `src/logger.ts:64` writes `{type:"server_stderr", text}` with the unmodified chunk (`src/proxy.ts:141` passes `chunk.toString("utf8")` straight through), and `src/logger.ts:58` writes `raw: f.raw` (unmodified wire bytes of every message, including error responses).
2. `extractFailures` (`src/triage.ts:33-47`) turns those into `Failure.detail`: for `kind==="error"` messages it sets `detail = truncate(e.raw)` (`src/triage.ts:37`); for `server_stderr` matching `STDERR_SIGNAL` it sets `detail = truncate(e.text.trim())` (`src/triage.ts:43`). `truncate` caps at 400 chars but does **not** redact — up to 400 chars of secret-bearing text survive per failure.
3. `buildTriagePrompt` (`src/triage.ts:65`) concatenates every `f.detail` into the prompt body verbatim.
4. `callClaude` (`src/triage.ts:84`, `:91`) POSTs that prompt to the fixed endpoint `https://api.anthropic.com/v1/messages` as `messages:[{role:"user", content: prompt}]`.

**Gating** (`src/index.ts:436-438`, `src/triage.ts:115`, `:128`) is *only*: the `--ai` flag is present **and** `process.env.ANTHROPIC_API_KEY` is set. There is **no** content-level consent, **no** preview of the bytes, and **no** redaction step. A repo-wide grep for `redact|sanitize|scrub|mask|consent` on the egress path finds nothing.

**Aggravating factors.** `triage --log <path>` (`src/index.ts:436`) accepts *any* session JSONL path, so an operator can point it at a colleague's or a production session full of stderr secrets; and the `STDERR_SIGNAL` regex deliberately fires on common crash lines (`error`/`fatal`/`exception`/`econnrefused`/…) — exactly the stderr most likely to embed connection strings, tokens, and stack traces with PII.

**File:line anchors.**
- `src/triage.ts:37` — `detail = truncate(e.raw)` (error body, unredacted)
- `src/triage.ts:43` — `detail = truncate(e.text.trim())` (stderr, unredacted)
- `src/triage.ts:65` — prompt concatenates every `f.detail` verbatim
- `src/triage.ts:84`, `:91` — POST to fixed `api.anthropic.com/v1/messages`
- `src/triage.ts:115`, `:128` — only `--ai` + API key gate egress
- `src/index.ts:436`, `:437`, `:438` — CLI wiring of `--log` / `--ai`
- `src/logger.ts:58`, `:64`, `src/proxy.ts:141` — the verbatim source data

**Attacker model.** Operator foot-gun / data-governance flaw, not remote exfil. The egress is opt-in per invocation, the destination is fixed to Anthropic (no attacker-controlled URL), and the API key is read from env (not from log content). The harm is that the operator is **under-informed** about what leaves the machine: keys/bearer tokens printed to stderr by a crashing server, DB DSNs (`user:password@host`), file paths, usernames, internal hostnames, and any secret echoed in an error body.

**PoC.** `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/triage/triage-ai-raw-egress-no-redaction.sh`
**Repro:**
```
bash /home/gogetassgk/projects/mcpgaze/security-audit/pocs/triage/triage-ai-raw-egress-no-redaction.sh
```
Two parts, neither touching the real Anthropic API (`globalThis.fetch` is stubbed): Part A drives `src/triage.ts` at import level; Part B runs the real CLI `node src/index.ts triage --log <jsonl> --ai` with `ANTHROPIC_API_KEY=fake` and a preloaded fetch stub.

**Captured evidence.**
```
PART A (import-level):
  stderr sk-ant key present in prompt = true
  postgres DSN  present in prompt = true
  rpc AKIA token present in prompt = true
  callClaude POSTed to: https://api.anthropic.com/v1/messages
  POST body contains all three secrets: true

PART B (real CLI, fetch stubbed):
  captured POST destination URL: https://api.anthropic.com/v1/messages
  HIT: sk-ant-LEAK-STDERR-0123456789abcdef
  HIT: postgres://admin:Sup3rS3cret@db.internal:5432/prod
  HIT: AKIA_LEAK_RPC_TOKEN_9876
  RESULT B: EXPLOITABLE — real CLI 'triage --ai' egresses all three raw secrets to api.anthropic.com.

$ grep -rniE "redact|sanitize|scrub|consent|confirm|mask" src/   -> (no matches)
```

**Remediation.** Add a redaction pass over `Failure.detail` (`sk-*` / `AKIA*` / bearer-JWT / `user:pass@host` DSN-value patterns) before `buildTriagePrompt`, and require an explicit content-consent acknowledgement that previews the exact bytes before `callClaude` runs.

---

### F-4 — `Authorization`/`Cookie` forwarded to whichever upstream the path resolves to (no per-route credential scoping)
**Severity:** low  ·  **Attack class:** Header leakage  ·  **Finding ID:** `header-leak-no-route-scoping`

**Mechanism.**
`forwardHeaders` (`src/http-proxy.ts:115-125`) builds the upstream request `Headers` by copying **every** client request header, skipping only `host`/`connection`/`content-length`/`accept-encoding` (`src/http-proxy.ts:119`). `authorization` and `cookie` are therefore always forwarded. The upstream is chosen purely by longest-matching path prefix in `resolveRoute` (called at `src/http-proxy.ts:178`), and the headers are attached unconditionally at the `fetch` (`src/http-proxy.ts:195`). There is **no per-route credential allowlist, no credential-to-upstream binding, and no host check**, so a credential the client attaches lands on whichever upstream the request path resolves to.

`wrap-http` supports multiple routes to different hosts via repeated `--route prefix=URL` (`buildRoutes`; `cmdWrapHttp` `src/index.ts:154-190`). Symmetrically, the response copy-back (`src/http-proxy.ts:208-212`) strips only `transfer-encoding`/`content-encoding`/`connection`/`content-length`, so an upstream's `Set-Cookie` and `mcp-session-id` are returned to the client.

**File:line anchors.**
- `src/http-proxy.ts:115`, `:119` — copy all headers minus a 4-entry static denylist
- `src/http-proxy.ts:178` — route chosen by path prefix only
- `src/http-proxy.ts:195` — credentialed headers attached to the upstream fetch
- `src/http-proxy.ts:208` — response copy-back returns upstream `Set-Cookie`/`mcp-session-id`
- `src/index.ts:154-190` — `wrap-http` multi-route wiring

**Attacker model.** Crosses the trust boundary **between distinct upstreams the operator chose to front from one proxy** — not a remote unauthenticated bug. The proxy is `127.0.0.1`-bound by default and Origin-checked (`isAllowedOrigin`, `src/http-proxy.ts:31-39`, enforced at `:169`), so there is no remote path. Exploitation requires a specific operator-chosen multi-route config **plus** a client that reuses one global credential across routes (a careless/buggy client), **or** operator/config control to mount a hostile upstream alongside a credentialed one. Real credential-scoping gap, constrained blast radius — hence **low**.

**PoC.** `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/hdrleak/header-leak-no-route-scoping.sh`
**Repro:**
```
bash /home/gogetassgk/projects/mcpgaze/security-audit/pocs/hdrleak/header-leak-no-route-scoping.sh
```
Stands up two ephemeral-port echo upstreams (A, B), starts `wrap-http --route /a=A --route /b=B --port 0`, then curls `POST /b` with `authorization: Bearer SECRET-FOR-A` + `cookie: sess=COOKIE-FOR-A`. Asserts B received A's creds and that B's `Set-Cookie` returned to the client. Deterministic; exit 0 on exploit; cleans up all PIDs/temp.

**Captured evidence.**
```
=== Sending A's credential (Bearer SECRET-FOR-A / sess=COOKIE-FOR-A) to route /b ===
response body : {"upstream":"B","authorization":"Bearer SECRET-FOR-A","cookie":"sess=COOKIE-FOR-A"}
set-cookie    : set-cookie: srv=B; Path=/
mcp-session-id: mcp-session-id: sid-B

RESULT: EXPLOITED — A's bearer token + cookie were delivered to upstream B,
        and B's session cookie (srv=B) was returned to the client.
```
Route `/b` (upstream B) echoes `"authorization":"Bearer SECRET-FOR-A"` and `"cookie":"sess=COOKIE-FOR-A"` — the credential the client labeled "for A" was delivered to B; the reverse direction returned B's `Set-Cookie: srv=B` and `mcp-session-id: sid-B` to a client that never intended to authenticate to B.

**Remediation.** Bind credentials to routes: add an optional per-route header allowlist/strip-list (drop `authorization`/`cookie` unless the route opts in) and likewise strip cross-route `Set-Cookie`/`mcp-session-id` on copy-back, instead of forwarding all headers behind a small static denylist (`src/http-proxy.ts:119` / `:210`).

---

### F-5 — `verify` / `verify --update` re-issue attacker-controlled cassette method/params to the live server
**Severity:** low  ·  **Attack class:** Replay / cassette as untrusted-file parser  ·  **Finding ID:** `verify-cassette-arbitrary-live-requests`

**Mechanism.**
`verify()` (`src/verify.ts:47`, `:54`) and `updateCassette()` (`src/verify.ts:112`, `:114`) `JSON.parse` the cassette, spawn the operator-chosen server via `McpConnection.spawn(command, args)`, then for every interaction where `isVerifiable(method)` is true (anything other than `initialize` and `notifications/*`) call `conn.request(it.request.method, it.request.params)`. `McpConnection.request` (`src/mcp-connection.ts:98`) writes `{jsonrpc, id, method, params}` straight to the child's stdin. `method` and `params` come directly from the untrusted cassette JSON with **no allow-listing, no read-only/destructive filtering, and no confirmation**, so a hostile cassette turns `verify` into a generator of arbitrary attacker-chosen JSON-RPC calls against whatever live server the operator targets after the `--`. In `--update` mode the live responses are written back into the cassette file (`src/verify.ts:130`).

**File:line anchors.**
- `src/verify.ts:47`, `:54` — iterate cassette interactions, `conn.request(method, params)`
- `src/verify.ts:112`, `:114` — same in `updateCassette`
- `src/verify.ts:130` — live responses re-baselined into the cassette under `--update`
- `src/index.ts:375` — `verify` CLI wiring
- `src/mcp-connection.ts:98` — `method`/`params` written verbatim to child stdin

**Attacker model.** No RCE, no prototype pollution, and **mcpgaze does not pick the server — the operator does** (after the `--`). The threat is a hostile/poisoned cassette (downloaded fixture, shared CI artifact, supply-chain) that an operator runs `verify` against their own live server, where it silently re-issues destructive `tools/call` or sensitive `resources/read` requests. Operator-gated and bounded to whatever the live server already exposes — hence **low**.

**PoC.** `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/replay/verify-cassette-arbitrary-live-requests.sh`
**Repro:**
```
bash /home/gogetassgk/projects/mcpgaze/security-audit/pocs/replay/verify-cassette-arbitrary-live-requests.sh
# core: MOCK_LOG=/tmp/recv.log node --import tsx src/index.ts verify --cassette <hostile.json> -- node <mock_log.mjs>
```
A mock server logs every non-`initialize` request it receives; the script greps the recv log for the verbatim destructive entries.

**Captured evidence.**
```
=== Live server receive log ===
RECV tools/call {"name":"delete_everything","arguments":{"path":"/"}}
RECV resources/read {"uri":"file:///etc/passwd"}

=== Assertions ===
PASS: destructive tools/call reached live server verbatim
PASS: sensitive resources/read reached live server verbatim
PASS: initialize correctly NOT re-issued (isVerifiable filter)

=== verify --update ===
✓ cassette re-baselined — 2 response(s) accepted
PASS: --update also re-issued the destructive call to the live server

=== Negative control ===
PASS: no prototype pollution (({}).polluted still undefined after verify)
```
Both attacker-chosen entries were transmitted to the live MCP server byte-for-byte as authored in the cassette JSON.

**Remediation.** In `verify`/`updateCassette`, either restrict re-issued methods to a read-only allow-list (`tools/list`, `resources/list`, `prompts/list`, `ping`) or require an explicit operator opt-in flag (e.g. `--allow-tool-calls`) before re-issuing `tools/call` and other state-changing methods; warn loudly that cassette methods are untrusted.

---

## 4. Cross-Cutting Root Cause & Recommended Fix Order

All three medium findings share a single root cause: **mcpgaze persists/egresses raw protocol bytes through one shared `Logger`/cassette path with zero redaction and default file modes.** The highest-leverage remediations, in order:

1. **`0600` on every sink** (`src/logger.ts:37`, `src/cassette.ts:61`) — one-line-each change, removes the world-readable exposure underpinning F-1 and F-2.
2. **A single shared redaction utility** applied at the `Logger`/cassette write boundary and reused in `triage.ts` before `buildTriagePrompt` — closes F-1, F-2, F-3 content leakage at once. Reuse the existing secret-pattern knowledge in `src/preflight.ts:15`.
3. **`.gitignore` the cassette** (`mcpgaze.cassette.json`, `*.cassette.json`) — closes the VCS vector in F-2.
4. **Content consent/preview** before `triage --ai` egress (F-3).
5. **Per-route credential scoping** (F-4) and **read-only allow-list / opt-in flag** in `verify` (F-5) — config-/operator-gated, lower priority.

---

## 5. Appendix — Dropped / Not-Exploitable Candidates

No additional candidate findings were dropped during this engagement. Every reproduced finding survived triage into Section 3. Two **severity recalibrations** and one **anchor correction** were made and are recorded inline for transparency:

- **F-4 (`header-leak-no-route-scoping`)** was recalibrated from an initial *medium* to **low**: the mechanism is genuine and reproduced, but exploitation requires a specific operator-chosen multi-route config plus a client reusing one global credential across routes (or operator control to mount a hostile upstream). The proxy is `127.0.0.1`-bound and Origin-checked, so there is no remote unauthenticated path; the boundary crossed is between upstreams the operator deliberately fronted from one dev wiretap. Constrained blast radius → low.
- **F-2 (`cassette-plaintext-secrets-committable`)** — anchor correction: `README.md:56` ("commit it") refers to `mcpgaze.baseline.json` (the snapshot), **not** the cassette. The README never literally says "commit the cassette," though it frames cassettes as checked-in CI artifacts (`README.md:108`) and the default cassette path is a non-gitignored repo-root file. Severity held at medium.

(Defense-class probes that produced **no** finding are documented in Section 6 rather than here, since they are negative results, not dropped candidates.)

---

## 6. Defenses That Held (Honest Negatives)

This section records attack classes that were probed and found **genuinely defended**. These negatives materially scope the residual risk above.

### 6.1 wrap-http SSRF / DNS-rebinding via `--route` or redirect — **HOLDS**
No client-controlled input (path, `--route` remainder, query, raw/absolute request target, or upstream redirect) can steer the proxy to an internal or unintended **host**.

- **Host is structurally un-influenceable.** `buildTarget` (`src/http-proxy.ts:73-78`) parses the configured upstream with `new URL(upstream)` and then assigns **only** `u.pathname` and `u.search`; assigning these on a WHATWG `URL` cannot change the authority (host/port/userinfo). Routing keys off `reqUrl.pathname` only (`src/http-proxy.ts:177-178`), so any authority a client sneaks into `req.url` is discarded before `buildTarget` runs. Verified end-to-end: double-slash authority `//127.0.0.1:<internal>/secret`, userinfo `/@127.0.0.1:<internal>`, and absolute-form request target `POST http://127.0.0.1:<internal>/secret` (over a raw socket) all reached the **intended** host — every attack response carried `host: 127.0.0.1:<intendedPort>`.
- **Dot-segment traversal cannot climb above the configured host.** `new URL(req.url, "http://localhost")` normalizes `.`/`..`/decoded `%2e%2e` **before** `resolveRoute`. `%2f`-encoded slashes survive but are passed as opaque path bytes (no separator semantics), so they can't climb either. A literal `..` remainder *would* re-normalize inside `buildTarget`, but is unreachable because the local `new URL` already stripped it.
- **SSRF-by-redirect is impossible.** The fetch uses `redirect: "manual"` (`src/http-proxy.ts:199`); a mock upstream returning `302 Location: http://127.0.0.1:<internal>/secret` caused the proxy to forward the 302 + Location to the **client** (empty body) — it never fetched the internal host.
- **Origin check + loopback bind.** `isAllowedOrigin` (`src/http-proxy.ts:31-39`) returns 403 for `Origin: http://evil.com` and allows missing/localhost Origins. The no-Origin browser bypass (cross-origin form POST/img/sendBeacon) is reachable but only reaches the **same fixed upstream host** — zero host control, so not an SSRF/rebinding primitive. The classic Host-header rebinding concern is mitigated because the default bind is `127.0.0.1` (`src/index.ts:167`) and a rebound request still cannot redirect the operator-pinned upstream. Binding to a non-loopback `--host` is an explicit, warned-about operator opt-out (`src/index.ts:184-186`), not an attacker capability.

**Findings list for this class: empty.**

### 6.2 Header leakage — redirect leak & route-steering desync — **HOLDS** (one real flaw split out as F-4)
- **Redirect credential leakage prevented.** With `redirect: "manual"` (`src/http-proxy.ts:199`), an upstream 302 to an "evil" host that records `Authorization` saw `authorization=null`; the proxy returned the 302 + Location to the client and never followed it. Whether the credential is re-sent on the follow-up is the downstream client's decision under normal cross-origin credential-stripping — not the proxy's.
- **No route-steering desync via traversal.** The **same** normalized pathname (from `new URL(req.url, "http://localhost")`, `src/http-proxy.ts:177`) feeds both `resolveRoute` (picks the upstream) and `buildTarget` (builds the path), so there is no "authenticate/route as A but fetch B's path" mismatch. Verified: `/a/../b/x` → routes wholly to B remainder `/x`; `/a/..%2fb` stays literal and routes to A.
- The genuinely unscoped header forwarding is captured as **F-4** above.

### 6.3 Secret-at-rest — **NO defenses** (confirmed leak; see F-1/F-2)
There are essentially no defenses against this class — see F-1 and F-2. Precision retained in those findings: the transport `Authorization` header is not logged (only the JSON-RPC body is), and the JSONL dir is gitignored while the cassette path is not.

### 6.4 Triage egress — **NO content defenses** (confirmed leak; see F-3)
What genuinely holds: egress is opt-in per invocation (cannot happen without `--ai` **and** an API key), the destination is fixed to Anthropic (no attacker-controlled exfil URL), and the API key is read from env, not from log content. There is no content-level redaction or consent — see F-3.

### 6.5 Replay / cassette as an untrusted-file parser — **HARDENED** (one operator-gated surface = F-5)
The live-crash vectors the brief flagged are already hardened; verified empirically:

1. **Depth-bomb guard HOLDS on both paths.** `MAX_DEPTH=200` (`src/cassette.ts:29`): params nested to depth 50,000 — sent on the replay server stdin and baked into the cassette so `buildIndex` `stableStringify`s it at load — produced **no** `RangeError`; the server stayed alive and answered a follow-up `ping` (exit 0). Matches `adv-cassette-1.test.ts`.
2. **Over-long-line claim is stale.** Current `src/framer.ts:62-66` does **not** throw on an over-long line; it sets `overflow=true`, drops the over-long newline-free line, and resyncs at the next newline. A 70 MiB line (both chunked at 64 KiB and as a single push) returned no-throw and then correctly emitted the next `ping`. The only theoretical V8 `MAX_STRING_LENGTH` throw is unreachable because the 64 MiB `MAX_LINE` check discards before the buffer can grow. Matches the June 2026 hardening pass recorded in project memory.
3. **Malformed/schema-invalid cassettes throw cleanly at startup.** `runReplayServer` (`src/cassette.ts:116`) does `JSON.parse` + `buildIndex` synchronously, so a throw synchronously rejects the promise, caught by `main` (`src/index.ts:498`) → one-line error, exit 1, **no** stack trace. Exercised: malformed JSON, missing/`non-array` interactions, element missing `request`, null element — all exit 1 cleanly **before any wire byte flows** (so the "no mid-protocol crash" invariant is not violated). `verify`/`updateCassette` likewise throw before `spawn`, and the in-loop throw is inside a `try` with a `finally` that closes the connection (`src/verify.ts:83-85`), so the child is reaped — no hang, no leak.
4. **No prototype pollution.** A cassette with `method: "__proto__"` and params containing `__proto__`/`constructor.prototype` keys left a fresh `{}` unpolluted after `verify`. By construction: `buildIndex` stores via `Map.set` and `stableStringify` reads via `Object.keys` and only stringifies — nothing assigns attacker keys into a JS object.
5. **Non-string method / missing result|error are robust.** Numeric/object `method` coerces to a non-matching key → clean `-32601` reply; a response with neither `result` nor `error` yields a slightly-malformed-but-non-crashing envelope (robustness only).

The one behavior worth recording is the documented, operator-gated cassette-to-arbitrary-live-requests surface in `verify` — captured as **F-5**.

---

## 7. Reproduction Index

| Finding | PoC script |
|---------|-----------|
| F-1 | `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/atrest/jsonl-plaintext-params-and-stderr.sh` |
| F-2 | `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/atrest/cassette-plaintext-secrets-committable.sh` |
| F-3 | `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/triage/triage-ai-raw-egress-no-redaction.sh` |
| F-4 | `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/hdrleak/header-leak-no-route-scoping.sh` |
| F-5 | `/home/gogetassgk/projects/mcpgaze/security-audit/pocs/replay/verify-cassette-arbitrary-live-requests.sh` |

Each PoC is self-contained, deterministic, stands up its own ephemeral mock servers/temp dirs, asserts the exploit, exits 0 on success, and cleans up all spawned PIDs and temp files. None of the PoCs contact the real Anthropic API (`fetch` is stubbed) or any external network.
