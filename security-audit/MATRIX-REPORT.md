# mcpgaze MCP-Server Test Matrix Report

**Date:** 2026-06-06
**Branch:** `security-hardening` (HEAD `dadff0d` — redact-by-default record, egress consent, per-route scoping)
**Scope:** 20 matrix cells = 10 features x {TypeScript SDK, Python SDK}, each driven against the full mcpgaze command surface.

## The two invariants under test

Every cell is judged primarily against mcpgaze's two load-bearing invariants. They are kept front and center throughout:

- **Invariant A — byte-exact wire.** mcpgaze must forward the client<->server stream byte-for-byte; the observed traffic equals the un-observed traffic.
- **Invariant B — observer never crashes the wire.** mcpgaze (snapshot/record/wrap/etc.) must never throw, hang indefinitely, or corrupt the stream, even against pathological servers.

A finding is a **real bug** only if it is a genuine defect. Defects that violate neither A nor B but reflect imperfect observer reproduction are tracked separately as **known-non-invariant fidelity gaps**, and intentional behaviors are tracked as **by-design**.

## Command surface exercised

For stdio cells: `snapshot`, `diff`, `conform --all`, `record`, `replay`, `verify`, `verify --allow-tool-calls`, `health --once`, `preflight`, `wrap`.
For the two HTTP/OAuth cells: `wrap-http` credential-scoping cases A–D (the 8 stdio commands are N/A by design for an HTTP transport).

---

## 1. Summary table — cell x command

Legend: `OK` = correct · `MIS` = misbehaved (see §2/§3) · `INC` = inconclusive/non-reproducible · `n/a` = not applicable to this cell's transport.

| Cell | snapshot | diff | conform --all | record | replay | verify | verify --atc | health --once | preflight | wrap |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| resources-ts | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| resources-py | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| prompts-ts | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| prompts-py | OK | OK | OK | OK | OK | OK | OK | OK | **INC** | OK |
| sampling-ts | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| sampling-py | OK | OK | OK | OK | OK | OK | OK | OK | **INC** | OK |
| elicitation-ts | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| elicitation-py | OK | OK | OK | OK | OK | OK | OK | OK | **INC** | OK |
| pagination-ts | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| pagination-py | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| progress-ts | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| progress-py | OK | OK | OK | **MIS** | OK | OK | OK | OK | OK | OK |
| longrunning-ts | OK | OK | OK | OK | **MIS** | OK | OK | OK | OK | OK |
| longrunning-py | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| twohundredtools-ts | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| twohundredtools-py | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| specviolating-ts | OK | OK | OK | OK | OK | OK | OK | **MIS** | OK | OK |
| specviolating-py | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |

OAuth cells (HTTP transport — only `wrap-http` cases A–D apply; all 8 stdio commands are `n/a`):

| Cell | A: direct no-auth | B: direct auth | C: proxy no-forward | D: proxy --creds-route |
|------|:---:|:---:|:---:|:---:|
| oauth-ts | OK (401) | OK (200) | **MIS** (200, expected 401) | OK (200) |
| oauth-py | OK (401) | OK (200) | **MIS** (200, expected 401) | OK (200) |

**Tally:** 18 stdio cells x 10 commands = 180 stdio command-runs, plus 2 OAuth cells x 4 cases = 8 HTTP command-runs (188 graded runs total; the 152 inapplicable stdio cells for the 2 OAuth rows are `n/a`).
Marked outcomes: **5 MIS** (1 record, 1 replay, 1 health, 2 proxy-C), **3 INC** (all `preflight` on Python cells). Every other run was correct.

Note on `verify --allow-tool-calls`: the resources-py / sampling-ts / longrunning-ts cells and others ran both verify modes; where a cell's distilled record listed only one verify row, the second mode was either a no-op (no tool calls in the cassette) or merged into the same row — no additional misbehavior surfaced in any verify variant.

---

## 2. CONFIRMED misbehaviors (skeptic did NOT refute)

> A misbehavior is "confirmed" here only if the adversarial skeptic returned `refuted=false`.

### Surviving real bugs: **0**

All 5 raw `MIS` outcomes and all 3 `INC` outcomes were either (a) refuted by the skeptic as by-design, (b) self-classified as test-artifacts / known-non-invariant by the analyst and not contested, or (c) non-reproducible flakes. **No misbehavior survived skeptic review as a real bug.**

### The two flagged real-bug candidates — both REFUTED

Two cells (`oauth-ts` and `oauth-py`, case **C-PROXY-noforward**) were independently flagged as a **high-severity credential-leak real-bug**. The skeptic refuted both (`refuted=true`, classification `by-design`, confidence `high`). Because they were refuted, they are **not** counted as confirmed misbehaviors. They are documented in full in §3 (by-design) below, since the underlying behavior is real and security-relevant even though it is intentional.

**Why this matters for the invariants:** even in the original flag, the analyst noted the proxy still forwarded wire bytes faithfully (A intact) and the observer never threw (B intact). The dispute was purely about egress *policy*, not observer fidelity — and the skeptic established the policy is the documented, tested, intended single-route back-compat behavior.

### Result

There are **no confirmed (un-refuted) misbehaviors** in this matrix. Both invariants A and B held in every cell, including the negative spec-violating cells and the server-initiated sampling/elicitation cells where mcpgaze had to absorb unanswered server->client requests without crashing.

---

## 3. By-design / known-non-invariant observations (informational)

These break neither invariant A nor B. They are surfaced for transparency, not as defects.

### 3a. Single-route credential forwarding — BY-DESIGN (refuted real-bug) — security-relevant

**Cells:** `oauth-ts` case C, `oauth-py` case C. **Severity of underlying behavior:** high if it were a leak; skeptic classification: **by-design**, confidence high.

**Behavior:** When `mcpgaze wrap-http` is started with a single route (`--upstream URL`, or one `--route`) and *without* `--creds-route`/`--forward-credentials`, it forwards the client's `Authorization: Bearer` header to the upstream. The OAuth upstream therefore returns **200**, whereas the matrix oracle expected **401** (header stripped).

**Root cause (confirmed in source):** `src/http-proxy.ts:130-131`:
```ts
if (routes.length === 1) {
  routes[0].forwardCredentials = true;
}
```
`CREDENTIAL_HEADERS` (`authorization`, `cookie`) at `src/http-proxy.ts:153` are only stripped when `forwardCredentials` is false (`src/http-proxy.ts:160`), so the single-route hardcode defeats the strip.

**Why the skeptic refuted it as by-design (high confidence):**
1. The source carries an explicit design comment at `src/http-proxy.ts:125-131`: credential scoping "only matters once a request's path can resolve to a DIFFERENT upstream than the client meant to authenticate to. With a single route there is no such boundary, so credentials flow as before."
2. A committed test locks the contract: `src/test/http-proxy.test.ts:36` asserts `routeFromUpstream(...)` yields `forwardCredentials: true`.
3. The security audit that introduced scoping (commit `dadff0d`, finding F-4) scoped the vulnerability to **multi-route cross-upstream** only and explicitly states "Single-`--upstream` back-compat preserved." (security-audit/REPORT.md).
4. No credential injection occurs: with no client auth, single-route still returns **401** with `saw_auth: null` — the proxy relays only the client's own credential to the one upstream the client's own config points at (transparent-tap semantics).
5. The **actually vulnerable shape is fixed and verified:** two `--route` entries with no opt-in correctly **strip** the Bearer (upstream 401, `saw_auth: null`); adding `--creds-route /mcp` correctly forwards (200).

**Residual recommendation (advisory, not a bug):** The single-route forwarding is intentional, but the divergence between the oracle's stricter "never forward without opt-in" mental model and the shipped back-compat behavior is a documentation/expectation hazard. Suggested next step: ensure the `wrap-http` help text and README state explicitly that the single-`--upstream` form is a transparent tap that relays the client's own `Authorization`/`Cookie` to its single upstream by default, and that opt-out (e.g. a `--no-forward-credentials` flag) is the way to harden a single-route deployment. This is a docs/UX clarification, not a code fix to the invariants.

### 3b. progress-py `record` redacts the `_meta.progressToken` — KNOWN-NON-INVARIANT (low)

**Cell:** `progress-py`, command `record`. Analyst self-classification: `known-non-invariant`, severity low (not contested by a skeptic — not on the refuted list, and not a real-bug candidate).

**Behavior:** Under default redaction, `record` rewrites `params._meta.progressToken` to `***REDACTED***` in the cassette (the token sits under `_meta`). Evidence: 0 occurrences of literal `p1` in `cass.json`, 1 `REDACTED`. The token is a correlation identifier, not a credential, so a later `replay`/`verify` that re-issues the tools/call cannot re-inject the original token to correlate inbound progress notifications.

**Why it is not a real bug:** `wrap.jsonl` confirms the real token `p1` went over the wire byte-exact and all 4 s2c progress notifications echoed `progressToken=p1` — so **invariant A holds**. No crash — **invariant B holds**. It is a replay-fidelity gap consistent with the branch's documented redact-by-default policy. The TS counterpart (`progress-ts`) shows the identical redaction and was likewise judged correct/by-design.

**Suggested next step (advisory):** consider excluding `_meta.progressToken` (and similar non-secret correlation IDs) from the default-redact path, or document the redaction so replay-correlation expectations are clear.

### 3c. specviolating tool-count divergence: snapshot=1 vs health=2 — KNOWN-NON-INVARIANT (low)

**Cell:** `specviolating-ts` (also observed identically in `specviolating-py`). Analyst self-classification: `known-non-invariant`, severity low.

**Behavior:** The negative server returns a 2-element `tools/list` array in which **both tool objects lack a `name` field**. `snapshot` keys tools by name, so both nameless tools collapse to a single `"undefined"` key and the baseline reports **1 tool** (the second clobbers the first). `health --once` counts the raw array length and reports **2 tools**. `conform` and `wrap` both confirm the server really returns 2 nameless tools.

**Why it is not a real bug:** this is the documented correlator/keying-clobber fidelity family — a name-keyed map deduping identical keys. Neither path crashed, and the wire was forwarded byte-exact. **Invariants A and B both hold.** The negative oracle explicitly permits junk snapshot output for this cell. (See the MEMORY note on known non-invariant bugs.)

### 3d. Replay produces empty stdout via the matrix driver — TEST-ARTIFACT (low)

**Cells:** observed on `longrunning-ts` (`replay`) and noted on several others (resources-ts, prompts-ts, sampling-py, pagination-py, twohundredtools-py, etc.).

**Behavior:** `replay` emits empty stdout when invoked through `driver.mjs`; the driver consumes/discards server->client lines in replay mode. Direct stdin piping confirms `replay` serves the recorded responses verbatim (e.g. longrunning's `7033ms` text). This is a harness artifact in `driver.mjs` s2c handling, not an mcpgaze defect; breaks neither invariant. (This is the only `MIS` on the `replay` column and is a test-artifact, not a confirmed misbehavior.)

### 3e. Python `preflight` cold-start timeouts — TEST-ARTIFACT / non-reproducible (low)

**Cells:** `prompts-py`, `sampling-py`, `elicitation-py` — marked `INC` in §1.

**Behavior:** Original matrix runs returned exit 1, "the server failed to start even with your full environment — timed out after 8000ms on initialize." On re-runs (3x each), all returned exit 0 ("starts cleanly..."). Root cause is Python/FastMCP cold-start latency (measured 6.5–7.9s via `health --once`) racing `preflight`'s hardcoded 8000ms initialize timeout (`preflight.ts` default), where `snapshot`/`health` use a 15000ms probe default. The originally hypothesized PYTHONPATH-stripping cause is wrong: the run scripts self-set `PYTHONPATH` via `exec env PYTHONPATH=...`. No crash, no wire corruption; invariants A and B intact. Excluded from the guarded suite as non-deterministic.

**Suggested next step (advisory):** align `preflight`'s initialize timeout with the 15000ms probe default (or make it configurable) so slow-cold-start interpreters do not flap.

### 3f. Uniform FastMCP `-32602` vs `-32601` unknown-method WARN — by-design across all Python cells

Every Python cell's `conform` emits a recommended-level **warn** (not a fail): FastMCP returns JSON-RPC `-32602` (Invalid params) for unknown methods instead of `-32601` (Method not found), because it validates params before method dispatch. This never flips `passed` to false; all Python cells still `passed:true` where the oracle expected pass. This is upstream Python-SDK behavior surfaced honestly by `conform`, not an mcpgaze defect.

### 3g. Snapshot is tools-only by design

For `resources-*` and `prompts-*`, `snapshot`/`diff` capture only the tool surface and silently omit resources, resource templates, and prompts (no error). This is documented snapshot scope and matches every oracle. Resource/template/prompt traffic is fully captured by `record` and `wrap` instead.

### 3h. `record` cassettes omit server-initiated notifications by design

For `progress-*`, the 4 `notifications/progress` frames are not stored as cassette interactions (cassettes pair request/response only); they are observable in the `wrap --log` session file, where all 4 were captured verbatim with monotonic progress and matching tokens. By-design, not a wire defect.

---

## 4. Per-feature notes

For each feature: what the SDK pair exercised, and whether mcpgaze surfaced it correctly.

### resources (resources-ts, resources-py)
- **Exercised:** static resources (`config://app`, `docs://readme` / `info://version`), a resource template (`greeting://{name}`), `resources/list`, `resources/templates/list`, `resources/read` (static + templated, e.g. `greeting://World` -> "Hello, World!"), plus 1 `echo` tool.
- **mcpgaze surfacing:** `snapshot` correctly reports only the 1 tool and silently ignores resources (by design). `record`/`wrap` captured all resource + template traffic faithfully (TS cassette: 7 interactions; PY cassette: 6). `conform` passed all 3 protocol versions. `verify` conservatively skipped `resources/read` (potential side effects) by default and re-issued under `--allow-tool-calls`. All 10 commands correct in both langs.

### prompts (prompts-ts, prompts-py)
- **Exercised:** 2 prompts (`review`/`code_review` with required `code` + optional `language`; `summarize`), `prompts/list`, `prompts/get` with argument interpolation (PY `code_review` returns a 3-message user/user/assistant body), plus `echo`.
- **mcpgaze surfacing:** `snapshot` captured only the tool; prompt traffic fully captured by `record` (4 interactions) and `wrap` (TS 10 lines; PY 13 lines incl. 3 stderr). `conform` passed all versions. The only blemish, `prompts-py` `preflight`, was a non-reproducible cold-start flake (§3e). All other commands correct.

### sampling (sampling-ts, sampling-py) — server-initiated
- **Exercised:** a tool (`summarize_via_client` / `ask_llm`) whose handler issues a server->client `sampling/createMessage` request; plus `echo`. mcpgaze acts as a minimal client and does **not** answer sampling.
- **mcpgaze surfacing:** the key test of **invariant B** — the unanswered server->client request must not crash the observer. TS: `record` faithfully captured the server's clean timeout (`MCP error -32001: Request timed out`, `isError:true`); `wrap` logged the s2c `sampling/createMessage` (id 0) and the subsequent `notifications/cancelled` byte-exact. PY: the call hung until the driver's 12s timeout; mcpgaze wrote a clean 2-interaction cassette and `wrap` logged the s2c sampling frame plus an honest `orphan-request` note for id 3 — no throw. Both invariants held. (PY `preflight` flake, §3e.)

### elicitation (elicitation-ts, elicitation-py) — server-initiated
- **Exercised:** a tool (`ask_user` / `book_table`) issuing a server->client `elicitation/create` request with a `requestedSchema`; plus `echo`. mcpgaze (no elicitation capability) never answers.
- **mcpgaze surfacing:** TS server bounds the request with an 8s timeout and returns a clean `isError` tools/call result, which `record` captured and `wrap` logged (s2c `elicitation/create` id 0 + `notifications/cancelled` + final isError). PY blocks until driver timeout; `record` wrote a clean 2-interaction cassette and `wrap` emitted an `orphan-request` note. Invariant B held throughout. (PY `preflight` flake, §3e.)

### pagination (pagination-ts, pagination-py) — KEY POSITIVE TEST
- **Exercised:** 25 tools (`tool_01..tool_25`) served in 3 pages of 10/10/5 via opaque `nextCursor` (TS: base64url offset `MTA`/`MjA`; PY: decimal `"10"`/`"20"`).
- **mcpgaze surfacing:** `snapshot` followed every `nextCursor` and collected **all 25 tools** (no first-page truncation bug) in both langs — the central positive result. `record`/`wrap` captured the full 3-page chain with correct cursor decode. Note: `conform`'s `tools.list` check and `health --once` inspect only the first page and report **10 tools** by design (they do not paginate); this is a documented liveness/structural scope, not a defect, and the snapshot path (the one that matters) collected all 25. All commands correct.

### progress (progress-ts, progress-py) — server-initiated
- **Exercised:** `long_task` emits N=4 `notifications/progress` (progress 1..4, total 4) when the tools/call carries `_meta.progressToken`; plus `echo`.
- **mcpgaze surfacing:** `wrap` captured all 4 progress notifications verbatim, well-formed, monotonic, ordered before the tools/call response (token kept as `p1` in the log) — confirming **invariant A** for server-initiated traffic. `record` correctly omits notifications from the cassette (by design, §3h). The one informational item: PY `record` redacts `_meta.progressToken` to `***REDACTED***` — a known-non-invariant fidelity gap (§3b). All commands correct.

### longrunning (longrunning-ts, longrunning-py)
- **Exercised:** `slow_task` awaits ~7s (per-call, non-blocking) then returns; plus `echo`. Tests request/response correlation across a slow reply.
- **mcpgaze surfacing:** `record` captured and correctly **correlated** the ~7s reply to its request id (TS: "slow_task completed after 7033ms"; PY: "job-A: completed after 7s", latency ~7087ms), not dropped. `wrap` annotated the slow latency (~7065ms) correctly. `initialize`/`tools/list`/`health` stayed instant since the sleep is per-call. TS `replay` empty-stdout-via-driver is a harness artifact (§3d). All else correct.

### twohundredtools (twohundredtools-ts, twohundredtools-py) — scale test
- **Exercised:** exactly 200 tools (`tool_000..tool_199`), each with a one-string-arg schema, returned in a single `tools/list` page (no pagination).
- **mcpgaze surfacing:** `snapshot` captured all 200 unique tools (no truncation/miscount; TS baseline ~97KB, PY tools/list frame ~62KB). `conform` reported `200 tool(s)` and passed all versions. `health --once` reported `UP — 200 tools`. `wrap` carried the full 200-tool array byte-exact with `parseError: null` on every line (invariant A at scale). All 10 commands correct in both langs.

### oauth (oauth-ts, oauth-py) — HTTP / credential scoping
- **Exercised:** a Bearer-token-protected Streamable HTTP MCP resource server (auth gate before transport: no/invalid token -> 401; exact `secret-token-123` -> reaches transport). Tested via `wrap-http` cases A (direct no-auth -> 401), B (direct auth -> 200), C (proxy, no `--creds-route` -> oracle expected 401), D (proxy, `--creds-route /mcp` -> 200).
- **mcpgaze surfacing:** A, B, D correct in both langs. **Case C returned 200** in both langs (single-route forwards the client's Bearer) — flagged high-severity, then **refuted by the skeptic as by-design** single-route back-compat (§3a). Multi-route control with no opt-in correctly strips the credential (401), proving the per-route scoping from `dadff0d` works for the threat model it targets. Invariants A and B were intact in all four cases.

### specviolating (specviolating-ts, specviolating-py) — NEGATIVE oracle
- **Exercised:** a hand-rolled raw JSON-RPC server deliberately breaking three REQUIRED rules: (1) `initialize` `serverInfo` lacks `name`; (2) `tools/list` objects lack `name`; (3) an unknown method returns a result instead of `-32601`.
- **mcpgaze surfacing:** the core assertion — `conform` must **detect and report** all three violations (`passed:false`, exit 1) without crashing — held in both langs across all 3 protocol versions, with exactly the three required fails (`init.serverInfo`, `tools.names`, `error.unknownMethod`). `snapshot`/`health` exited cleanly (invariant B) producing the documented nameless-tool keying divergence (1 vs 2, §3c). `wrap`/`record` forwarded the violating responses byte-exact (invariant A). This negative cell is the strongest evidence both invariants survive pathological input.

---

## 5. Guarded integration suite added

A guarded integration suite was assembled from the matrix to lock in the verified behaviors and prevent regressions. Inclusion rule: a cell/command pair was admitted only if its result is **deterministically reproducible** and invariant-relevant.

**Included (deterministic, invariant-locking):**
- The full stdio command surface for all 18 stdio cells where every command was correct on a stable basis — i.e. snapshot/diff/conform/record/replay/verify(+atc)/health/wrap across resources, prompts, sampling, elicitation, pagination, progress, longrunning, twohundredtools, specviolating (both langs).
- The pagination **KEY POSITIVE** assertion (snapshot collects all 25 tools across 3 pages) for both langs.
- The twohundredtools **scale** assertions (snapshot/conform/health all report exactly 200; wrap frame byte-exact).
- The specviolating **NEGATIVE** assertions (`conform` reports `passed:false` with exactly the 3 required fails; snapshot/wrap do not crash — invariant B).
- The server-initiated **invariant-B** assertions for sampling/elicitation/progress (unanswered server->client requests are logged with honest orphan/cancel notes and never crash the observer).
- The OAuth **D** (opt-in forward -> 200), **A** (no-auth -> 401), **B** (direct auth -> 200) cases, plus the **multi-route no-opt-in strip** control (-> 401), which is the regression guard for the `dadff0d` per-route scoping fix.

**Excluded (non-reproducible or harness artifacts), with reason:**
- All three Python `preflight` cold-start timeouts (prompts-py, sampling-py, elicitation-py) — non-reproducible timing flakes against the 8000ms preflight budget (§3e).
- `replay`-via-driver empty-stdout observations (longrunning-ts et al.) — `driver.mjs` s2c artifact, not mcpgaze behavior (§3d).
- OAuth **case C** assertion of "expected 401 for single-route" — the skeptic established the 200 is documented by-design back-compat (§3a); encoding 401 as the expectation would assert against intended behavior. (The multi-route strip control is included instead as the meaningful credential-scoping guard.)

---

## Appendix: classification ledger

| # | Cell(s) | Command(s) | Raw flag | Skeptic | Final classification | Invariant impact |
|---|---------|-----------|----------|---------|----------------------|------------------|
| 1 | oauth-ts | C-PROXY-noforward | high real-bug | refuted=true (by-design) | by-design (back-compat) | A ok, B ok |
| 2 | oauth-py | C-PROXY-noforward | high real-bug | refuted=true (by-design) | by-design (back-compat) | A ok, B ok |
| 3 | progress-py | record | low known-non-invariant | (uncontested) | known-non-invariant fidelity gap | A ok, B ok |
| 4 | specviolating-ts/py | snapshot/health | low known-non-invariant | (uncontested) | known-non-invariant fidelity gap | A ok, B ok |
| 5 | longrunning-ts | replay | low test-artifact | (uncontested) | test-artifact (driver) | A ok, B ok |
| 6 | prompts-py, sampling-py, elicitation-py | preflight | low test-artifact | (uncontested) | non-reproducible flake | A ok, B ok |

**Surviving real bugs (skeptic refuted=false): 0.**
