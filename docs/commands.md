# Command Reference

The authoritative reference for every `mcpgaze` command. Throughout, `mcpgaze` stands for your invocation of the built CLI — `node /abs/path/to/mcpgaze/dist/index.js`, or the `mcpgaze` alias/binary (see [Getting Started](./getting-started.md)).

**Conventions**

- Everything after `--` is the **server command** to run (e.g. `-- node server.js`). `mcpgaze`'s own flags go *before* `--`.
- Flags take the form `--flag value` or `--flag` (boolean). Unknown flags are ignored unless documented.
- [Exit codes](#exit-codes) and [environment variables](#environment-variables) are summarized at the end.

## Contents

- [`wrap`](#wrap) — transparent stdio proxy
  - [`wrap --tui`](#wrap---tui) · [`wrap --native`](#wrap---native)
- [`wrap-http`](#wrap-http) — Streamable HTTP proxy
- [`snapshot`](#snapshot) — write a tool-schema baseline
- [`diff`](#diff) — gate CI on tool-schema drift
- [`conform`](#conform) — spec conformance
- [`verify`](#verify) — behavioral (response-shape) drift
- [`record`](#record) / [`replay`](#replay) — VCR for MCP
- [`health`](#health) — continuous monitoring / liveness
- [`triage`](#triage) — diagnose a failed session
- [`preflight`](#preflight) — env-var diagnostics
- [Exit codes](#exit-codes) · [Environment variables](#environment-variables) · [Global flags](#global-flags)

---

## `wrap`

Transparent stdio proxy. Forwards the child server's stdin/stdout **byte-for-byte** while logging every JSON-RPC message to a side channel (a file and/or stderr), never to stdout — which in `wrap` mode carries the live protocol.

```
mcpgaze wrap [--log <path>] [--print] [--redact] [--tui] [--native] -- <server command...>
```

| Flag | Default | Description |
|---|---|---|
| `--log <path>` | `.mcpgaze/session-<ts>.jsonl` | Where to write the structured session log (JSONL, mode `0600`). |
| `--print` | off | Mirror a human-readable, color-coded rendering to **stderr** (stdout is the wire). |
| `--redact` | off | Mask credential-shaped params and stderr secrets **at rest** in the log. Never affects the forwarded wire. See [Security](../SECURITY.md#redaction). |
| `--tui` | off | Full-screen live dashboard. Needs a TTY; falls back to plain logging otherwise. See [`wrap --tui`](#wrap---tui). |
| `--native` | off | Use the Rust single-binary hot-path. See [`wrap --native`](#wrap---native). |

**What's logged:** every message (both directions), request→response latency matched by `id`, orphaned requests that never got a reply, parse errors, and the server's captured stderr. Schema: [Session Log Format](./session-log.md).

**Exit code:** forwards the wrapped server's exit code.

```bash
mcpgaze wrap --print -- node server.js
mcpgaze wrap --log /tmp/sess.jsonl -- python -m my_server
mcpgaze wrap --redact -- node server.js     # safe to tee into a shareable file
```

### `wrap --tui`

Opens a full-screen live view: the message stream (direction, latency, errors highlighted), the server's captured stderr, and running stats (req/res/notif counts, errors, orphans, p50/p95 latency). It's hand-drawn ANSI — **zero dependencies**, nothing extra enters your protocol path. Without a TTY it prints a notice and falls back to plain logging.

```bash
mcpgaze wrap --tui -- node server.js
```

### `wrap --native`

Hands the forward + observe loop to `mcpgaze-proxy`, a single static binary written in **`std`-only Rust (no crates)**. No Node runtime is required to run it, and it sustains higher throughput than the Node proxy.

Build it once:

```bash
cd native/mcpgaze-proxy && cargo build --release
```

`mcpgaze` finds the binary via, in order: the `MCPGAZE_PROXY_BIN` environment variable, then `native/mcpgaze-proxy/target/release/mcpgaze-proxy` relative to the install. If it can't be found, `wrap --native` prints a warning and **falls back to the Node proxy** — your session still runs.

```bash
mcpgaze wrap --native -- node server.js
MCPGAZE_PROXY_BIN=/opt/mcpgaze-proxy mcpgaze wrap --native -- node server.js
```

**Benchmark (honest).** In a 20k-round-trip microbenchmark against a mock server, the Rust proxy ran ~1.7× the Node proxy's throughput and roughly halved added latency. The absolute numbers are machine- and runtime-specific and the bench harness isn't committed yet, so treat them as one machine's reading; the durable result is the *relationship* — direct ≫ Rust > Node, all far above any real MCP workload. `--native` earns its place mainly for **single-binary distribution** and high-throughput/streaming cases, not because Node was too slow.

**Classifier trade-off.** The Rust path does forward + capture with a fast, parse-free, best-effort message classifier. Three narrow classes of `kind`/`method` metadata can differ from the Node log (malformed JSON, `\uXXXX`-escaped key names, method-value escape fidelity). The forwarded bytes and the `raw` field are always exact; only the derived summary may differ. The default Node proxy classifies by full JSON parse and is authoritative. Details: [KNOWN-ISSUES.md #4](../KNOWN-ISSUES.md).

---

## `wrap-http`

The same idea for the **Streamable HTTP** transport (JSON + SSE). `mcpgaze` runs as a localhost-bound HTTP proxy, forwards to your upstream(s), and observes both plain JSON and SSE responses. (For HTTP, the spec gives the client no view of the server's stderr — so the proxy is your only window into it.)

```
mcpgaze wrap-http (--upstream <url> | --route <prefix>=<url> ...) [--port <n>] [--host 127.0.0.1]
                  [--allow-origin <list>] [--log <path>] [--print] [--redact]
                  [--forward-credentials | --creds-route <prefix> ... | --no-forward-credentials]
```

| Flag | Default | Description |
|---|---|---|
| `--upstream <url>` | — | Single-route shorthand: mounts a route at the URL's own path. |
| `--route <prefix>=<url>` | — | Repeatable. Front several upstreams, routed by path prefix (longest match wins). |
| `--port <n>` | `0` (ephemeral) | Listen port. The actual port is printed on startup. |
| `--host <host>` | `127.0.0.1` | Bind address. Anything other than `127.0.0.1`/`localhost` prints a warning (it exposes the proxy beyond loopback). |
| `--allow-origin <list>` | localhost only | Comma-separated `Origin` allowlist override. Overrides the DNS-rebinding defense silently. |
| `--log <path>` | `.mcpgaze/session-<ts>.jsonl` | Structured session log path. |
| `--print` | off | Pretty rendering to stderr. |
| `--redact` | off | Redact secrets at rest in the log. |
| `--forward-credentials` | off | Forward `Authorization`/`Cookie` to **all** routes. |
| `--creds-route <prefix>` | — | Repeatable. Forward credentials only to the named route(s). |
| `--no-forward-credentials` | — | Strip credentials even in the single-route case. Cannot be combined with the two flags above. |

**Routing.** The request path after the matched prefix is appended to the upstream (nginx-style), and the client's query string is preserved. Unmatched paths get a clear `404`, and each route taken is recorded in the session log.

```bash
# single upstream
mcpgaze wrap-http --upstream http://localhost:3000/mcp --port 7000
# → client points at http://127.0.0.1:7000/mcp

# fan one proxy across several upstreams
mcpgaze wrap-http --port 7000 \
  --route /github=http://localhost:3001/mcp \
  --route /slack=http://localhost:3002/mcp
# → http://127.0.0.1:7000/github and .../slack
```

**Security defaults.** Binds `127.0.0.1` only and rejects cross-origin browser requests (DNS-rebinding defense — the class behind the Inspector's [CVE-2025-49596](https://nvd.nist.gov/vuln/detail/CVE-2025-49596)).

**Credential scoping.** A single `--upstream`/`--route` forwards the client's `Authorization`/`Cookie` to that one upstream (there's only one destination, so nothing can be misrouted); pass `--no-forward-credentials` to strip them anyway. With **multiple** routes, a path could resolve to a different upstream than the client meant to authenticate to, so credentials — and `Set-Cookie`/`Mcp-Session-Id` on the way back — are **stripped unless a route opts in** (`--creds-route /github`, or `--forward-credentials` for all). Full rationale: [SECURITY.md](../SECURITY.md#credential-scoping-in-wrap-http).

Runs until `SIGINT`/`SIGTERM`.

---

## `snapshot`

Probe the server (`initialize` + `tools/list`) and write a tool-schema **baseline** you commit to git. The baseline is the lockfile that [`diff`](#diff) checks against.

```
mcpgaze snapshot [--out mcpgaze.baseline.json] -- <server command...>
```

| Flag | Default | Description |
|---|---|---|
| `--out <path>` | `mcpgaze.baseline.json` | Where to write the baseline. |

```bash
mcpgaze snapshot -- node server.js
git add mcpgaze.baseline.json
```

The baseline records the server name, the negotiated `protocolVersion`, and each tool's input schema.

---

## `diff`

Diff the live tool surface against a baseline and classify every change by severity. Use it as a CI gate.

```
mcpgaze diff [--baseline <f>] [--fail-on <breaking|warning|any>] [--fail-on-drift] [--update] -- <server command...>
```

| Flag | Default | Description |
|---|---|---|
| `--baseline <path>` | `mcpgaze.baseline.json` | Baseline to compare against. |
| `--fail-on <sev>` | none (report only) | Exit `1` if the worst change is at or above `breaking`, `warning`, or `any`. |
| `--fail-on-drift` | — | Alias for `--fail-on breaking`. |
| `--update` | off | Re-probe and overwrite the baseline (accept the new surface). |

**Severity model:**

| Change | Severity |
|---|---|
| Property removed | breaking |
| New **required** property | breaking |
| Type changed | breaking |
| Enum value removed | breaking |
| optional → required | breaking |
| required → optional | warning |
| New optional property | info |
| Enum value added | info |

```bash
mcpgaze diff --fail-on-drift -- node server.js     # CI gate: exit 1 on breaking
mcpgaze diff --fail-on warning -- node server.js   # stricter
mcpgaze diff --update -- node server.js            # accept intentional drift
```

> The differ is deliberately focused on the cases that break agents (properties, required, type, enum). It is **not** a general JSON Schema differ — see [Architecture](./architecture.md#the-schema-differ).

---

## `conform`

Run a spec-conformance suite against your server for one or more protocol versions. Required checks gate CI; recommended checks warn.

```
mcpgaze conform [--spec <ver> | --all] [--json] -- <server command...>
```

| Flag | Default | Description |
|---|---|---|
| `--spec <ver>` | `2025-06-18` | Test a single protocol version. |
| `--all` | off | Test every known version: `2025-06-18`, `2025-11-25`, `2026-07-28` (RC). |
| `--json` | off | Emit machine-readable reports instead of the formatted view. |

> The default (no `--spec`, no `--all`) tests the **baseline** version `2025-06-18`. Pass `--spec 2025-11-25` for the current stable spec, or `--all` to cover all three. (Note: `mcpgaze`'s own client probes/advertises `2025-11-25`.)

**Check catalog:**

| Check | Level | Passes when |
|---|---|---|
| `init.result` | required | `initialize` returns a result (no error). |
| `init.protocolVersion` | required | The result advertises a `protocolVersion`. |
| `init.serverInfo` | required | The result includes `serverInfo.name`. |
| `init.capabilities` | recommended | The result includes a `capabilities` object. |
| `tools.list` | required | `tools/list` returns an array. |
| `tools.names` | required | Every tool has a non-empty string `name`. |
| `tools.inputSchema` | recommended | Every `inputSchema` is an object schema (`type: "object"`). |
| `tools.requiredRefs` | recommended | `required[]` only names declared properties. |
| `error.unknownMethod` | required | An unknown method returns JSON-RPC `-32601` (not a hang/crash). |

**Exit code:** `1` if any **required** check fails (for any tested version), else `0`.

```bash
mcpgaze conform --all -- node server.js
mcpgaze conform --spec 2025-11-25 --json -- node server.js | jq '.[].passed'
```

---

## `verify`

Behavioral (response-shape) drift detection. Where [`diff`](#diff) compares *declared* schemas, `verify` catches drift the schema can't see — a server can keep an identical tool schema while its responses change shape. It re-issues a [cassette](#record)'s recorded requests against the live server and diffs the **response shapes**.

```
mcpgaze verify --cassette <file> [--fail-on <sev>] [--update] [--allow-tool-calls] -- <server command...>
```

| Flag | Default | Description |
|---|---|---|
| `--cassette <file>` | **required** | The cassette of recorded requests to re-issue. |
| `--fail-on <sev>` | none | Exit `1` if drift (or an error, when `--fail-on` is set) reaches the threshold. |
| `--update` | off | Re-baseline: accept the live responses into the cassette. |
| `--allow-tool-calls` | off | Also re-issue **state-changing** methods (e.g. `tools/call`). Off by default — only read-only methods are re-issued. |

**Severity:** field removed / type change = **breaking**; a non-empty array that is now empty = **warning**; field added = **info**.

> ⚠ **`verify` executes the recorded requests against the live server.** By default it skips state-changing methods and reports them; `--allow-tool-calls` opts into re-issuing them. Run that against read-only tools or a disposable instance. Cassette methods are untrusted input — see [SECURITY.md](../SECURITY.md#cassettes-are-untrusted-input).

```bash
mcpgaze record --cassette s.json -- node server.js          # capture once
mcpgaze verify --cassette s.json --fail-on warning -- node server.js
mcpgaze verify --cassette s.json --update -- node server.js  # accept new shapes
```

---

## `record`

Wrap a server (exactly like [`wrap`](#wrap)) and additionally write a **cassette** — a replayable file of request/response pairs.

```
mcpgaze record [--cassette mcpgaze.cassette.json] [--log <path>] [--print] [--no-redact] -- <server command...>
```

| Flag | Default | Description |
|---|---|---|
| `--cassette <path>` | `mcpgaze.cassette.json` | Where to write the cassette (mode `0600`). |
| `--log <path>` | `.mcpgaze/session-<ts>.jsonl` | Session log path (recorded alongside). |
| `--print` | off | Pretty rendering to stderr. |
| `--no-redact` | redaction **on** | Capture params/results/stderr **verbatim**. By default `record` redacts credential-shaped values, because a cassette is a shareable/committable artifact. |

A cassette stores request `params` and response `result`/`error`. Cassettes are written `0600`, and `*.cassette.json` / `mcpgaze.cassette.json` are git-ignored by default. **Review a cassette before committing or sharing it**, especially one made with `--no-redact`.

```bash
mcpgaze record --cassette s.json -- node server.js            # redacted (default)
mcpgaze record --cassette s.json --no-redact -- node server.js # verbatim — handle with care
```

---

## `replay`

Serve a cassette as a **deterministic mock MCP server** over stdio — no backend required. Great for offline client development and regression CI.

```
mcpgaze replay --cassette <file>
```

| Flag | Default | Description |
|---|---|---|
| `--cassette <file>` | **required** | The cassette to serve. |

Replay matches incoming requests by **method + params** (exact match first, then a unique method-only fallback) and returns a clear JSON-RPC error for anything unrecorded instead of hanging. Replayed responses are byte-identical to the originals.

```bash
mcpgaze replay --cassette s.json
# point your client at: mcpgaze replay --cassette s.json
```

> `replay` is itself a conformant MCP server — `mcpgaze`'s own conformance suite is run against it in CI (the "dogfood" check).

---

## `health`

Continuously health-check a server (uptime, latency, tool-schema drift), or run a single probe as a liveness check.

```
mcpgaze health [--interval <sec>] [--once] [--status <path>] -- <server command...>
```

| Flag | Default | Description |
|---|---|---|
| `--interval <sec>` | `60` | Seconds between probes (daemon mode). |
| `--once` | off | Run a single probe and exit. |
| `--status <path>` | `.mcpgaze/health.json` | Where to persist status/history. |

Each probe runs `initialize` + `tools/list`, timed. The daemon prints up↔down and schema-drift transitions and persists a rolling history. With `--once`, it's a clean cron/CI liveness probe.

**Exit code (`--once`):** `0` if up, `1` if down. (Daemon mode runs until `SIGINT`/`SIGTERM`.)

```bash
mcpgaze health --interval 30 -- node server.js     # daemon
mcpgaze health --once -- node server.js            # liveness probe for cron/CI
```

The status file schema (`current`, `summary`, `history`) is documented in [Session Log Format](./session-log.md#health-status-file).

---

## `triage`

Read a session log (from `wrap`/`wrap-http`/`record`), surface every failure signal, and — optionally — get a plain-English root cause and fix from Claude.

```
mcpgaze triage --log <session.jsonl> [--ai] [--yes] [--model <name>]
```

| Flag | Default | Description |
|---|---|---|
| `--log <path>` | **required** | A single session-log path to analyze. |
| `--ai` | off | Send the (redacted) failure context to the Anthropic API for diagnosis. |
| `--yes` | off | Pre-consent to the `--ai` egress (skip the interactive preview/confirm). |
| `--model <name>` | `claude-sonnet-4-6` | Override the triage model (or set `MCPGAZE_TRIAGE_MODEL`). |

**Failure signals surfaced:** error responses (`rpc-error`), malformed JSON-RPC (`parse-error`), crash-y server stderr (`server-stderr`), and orphaned/spawn/proxy/observer/origin notes.

**The `--ai` egress is gated.** It requires `ANTHROPIC_API_KEY`, **redacts** secret-shaped tokens at the egress boundary, and asks for explicit consent — either `--yes`, or a `y` at the interactive preview that shows the exact bytes. Without consent (or in a non-interactive context without `--yes`), nothing is sent and the local summary still prints. See [SECURITY.md](../SECURITY.md#triage---ai-egress).

```bash
mcpgaze triage --log .mcpgaze/session-1700000000.jsonl
ANTHROPIC_API_KEY=sk-... mcpgaze triage --log s.jsonl --ai --yes
```

---

## `preflight`

GUI clients (Claude Desktop, etc.) do **not** inherit your shell environment, so a server that works in your terminal fails silently in production. `preflight` diagnoses that, two ways.

```
mcpgaze preflight [--config <file> [--server <name>]] [--timeout <ms>] [-- <server command...>]
```

| Flag | Default | Description |
|---|---|---|
| `--config <file>` | — | Statically check a client config's `env` block (e.g. flags `${VAR}` placeholders that GUI clients won't expand). |
| `--server <name>` | — | Which server entry in the config to check. |
| `--timeout <ms>` | shared probe timeout | Override the handshake budget (also `MCPGAZE_PREFLIGHT_TIMEOUT`). Raise it for slow cold starts (e.g. Python/FastMCP). |

**Dynamic check** (with a `-- <command>`): spawns the server twice — once with your full env, once with only the GUI-inherited subset — and names the vars that matter.

```bash
mcpgaze preflight -- node server.js
# ⚠ starts with your full shell env but FAILS with only what a GUI client inherits.
#   Likely culprits: MCP_SECRET, DATABASE_URL …

mcpgaze preflight --config claude_desktop_config.json --server my-server
# ERROR  API_KEY — value contains "${MY_KEY}" — GUI clients do NOT expand shell variables

mcpgaze preflight --timeout 15000 -- python -m my_server   # slow interpreter cold start
```

**Exit code:** `0` if the server starts cleanly under the restricted env (or the config is clean), `1` otherwise.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (and, for gating commands, no failure at/above the threshold). |
| `1` | A gate tripped (drift, conformance failure, `health --once` down, `preflight` failure) or a runtime error. |
| `2` | Usage error (missing required argument / bad flag value). |
| (passthrough) | `wrap`/`record` forward the wrapped server's own exit code. |

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `MCPGAZE_PROXY_BIN` | `wrap --native` | Absolute path to the `mcpgaze-proxy` binary. Checked first. |
| `MCPGAZE_PREFLIGHT_TIMEOUT` | `preflight` | Default handshake timeout in ms (overridden by `--timeout`). |
| `MCPGAZE_TRIAGE_MODEL` | `triage --ai` | Default Anthropic model (overridden by `--model`). |
| `ANTHROPIC_API_KEY` | `triage --ai` | Required to call the Anthropic API. |

## Global flags

| Flag | Effect |
|---|---|
| `-h`, `--help`, `help` | Print usage. |
| `-v`, `--version` | Print the version. |
