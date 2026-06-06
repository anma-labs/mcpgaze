# Session Log Format

`wrap`, `wrap-http`, and `record` write a **session log**: newline-delimited JSON (JSONL), one event per line, to `.mcpgaze/session-<timestamp>.jsonl` by default (`--log` overrides). The file is created with mode `0600` (owner-only). This is the authoritative record — every downstream command (`triage`) and any dashboard you build reads it.

> The same schema is emitted by both the Node and Rust (`--native`) proxies, so tooling is portable across them. (The Rust classifier's `kind`/`method` can differ on three narrow input classes — see [KNOWN-ISSUES.md #4](../KNOWN-ISSUES.md) — but the event shape and the verbatim `raw` field are identical.)

## Event envelope

Every line is a JSON object with at least:

| Field | Type | Description |
|---|---|---|
| `t` | string | ISO-8601 timestamp when the event was observed. |
| `type` | string | One of `message`, `server_stderr`, `note`. |

The remaining fields depend on `type`.

## `type: "message"`

A single JSON-RPC message observed on the wire (either direction).

| Field | Type | Description |
|---|---|---|
| `dir` | string | Direction: `c2s` (client→server) or `s2c` (server→client). |
| `kind` | string | `request`, `response`, `notification`, `error`, or `unparsed` (the line wasn't valid JSON). |
| `id` | string \| number \| null | The JSON-RPC `id`, or `null` for notifications / unparsed lines. |
| `method` | string \| null | The method name (requests/notifications), else `null`. |
| `latencyMs` | number \| null | For a `response`/`error`, the time since its matching request was seen (matched by `id`); else `null`. |
| `parseError` | string \| null | Set when the line couldn't be parsed as JSON-RPC; else `null`. |
| `raw` | string | The **verbatim** wire line. Authoritative. (Masked only if you passed `--redact`; the wire itself was forwarded byte-exact regardless.) |

```json
{"t":"2026-06-06T17:00:00.001Z","type":"message","dir":"c2s","kind":"request","id":2,"method":"tools/call","latencyMs":null,"parseError":null,"raw":"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{...}}"}
{"t":"2026-06-06T17:00:00.042Z","type":"message","dir":"s2c","kind":"response","id":2,"method":null,"latencyMs":41.3,"parseError":null,"raw":"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{...}}"}
```

> **`raw` is the source of truth.** The `kind`/`method`/`latencyMs` fields are *derived* convenience metadata. If they ever disagree with `raw` (e.g. on a reused in-flight `id`, see [KNOWN-ISSUES.md #1](../KNOWN-ISSUES.md)), trust `raw`.

## `type: "server_stderr"`

A chunk of the wrapped server's stderr — the logs that normally vanish, captured alongside the protocol.

| Field | Type | Description |
|---|---|---|
| `text` | string | The verbatim stderr chunk (masked if `--redact`). |

```json
{"t":"2026-06-06T17:00:00.010Z","type":"server_stderr","text":"[server] connected to db\n"}
```

## `type: "note"`

An observation `mcpgaze` itself made about the session.

| Field | Type | Description |
|---|---|---|
| `code` | string | A short machine code (see below). |
| `detail` | string | Human-readable detail. |

Failure-relevant note codes (these drive [`triage`](./commands.md#triage)):

| `code` | Meaning |
|---|---|
| `orphan-request` | A request was seen but never got a matching response. |
| `spawn-error` | The server process failed to spawn (e.g. `ENOENT`). |
| `proxy-error` | The proxy hit an error on its own path (never the wire). |
| `observer-error` | The observation path degraded an event (and kept going). |
| `origin-rejected` | (`wrap-http`) A cross-origin request was rejected by the DNS-rebinding defense. |

Other informational notes (e.g. which route a `wrap-http` request took) may also appear; treat unknown `code`s as informational.

```json
{"t":"2026-06-06T17:00:05.000Z","type":"note","code":"orphan-request","detail":"id 7 (tools/call) never answered after 5000ms"}
```

## Recipes (`jq`)

```bash
LOG=.mcpgaze/session-*.jsonl

# Every error response
jq 'select(.type=="message" and .kind=="error")' $LOG

# Slowest 10 requests by latency
jq -c 'select(.latencyMs) | {method, id, latencyMs}' $LOG | sort -t: -k3 -n | tail

# Everything the server printed to stderr
jq -r 'select(.type=="server_stderr") | .text' $LOG

# All mcpgaze notes (orphans, spawn errors, …)
jq -c 'select(.type=="note") | {code, detail}' $LOG

# Reconstruct just the raw wire, client→server
jq -r 'select(.type=="message" and .dir=="c2s") | .raw' $LOG
```

---

## Health status file

`health` persists a separate status file (default `.mcpgaze/health.json`, pretty-printed JSON — *not* JSONL). Shape:

```json
{
  "server": "node server.js",
  "updatedAt": "2026-06-06T17:05:00.000Z",
  "current": { "at": "...", "ok": true, "latencyMs": 12, "toolCount": 8, "toolsHash": "…" },
  "summary": {
    "checks": 120,
    "upCount": 119,
    "uptimePct": 99.2,
    "consecutiveFailures": 0,
    "p50LatencyMs": 11
  },
  "history": [ { "at": "...", "ok": true, "latencyMs": 12, "toolCount": 8, "toolsHash": "…" } ]
}
```

| Field | Description |
|---|---|
| `server` | The wrapped command. |
| `updatedAt` | When the file was last written. |
| `current` | The most recent probe (a `HealthCheck`). |
| `summary.checks` / `upCount` / `uptimePct` | Totals over the rolling history. |
| `summary.consecutiveFailures` | Length of the current failure streak (0 when up). |
| `summary.p50LatencyMs` | Median latency over successful probes. |
| `history[]` | Rolling probe history (capped, oldest dropped). |

A `HealthCheck` is `{ at, ok, latencyMs?, toolCount?, toolsHash?, error? }`. `toolsHash` is a stable hash of the tool surface; a change between probes is what `health` reports as **schema drift**.
