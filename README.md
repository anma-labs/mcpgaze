# mcpgaze

**A transparent wiretap for MCP servers.** See exactly what your AI client sends your server — without breaking the protocol — and catch tool-schema drift before it ships.

> 52% of MCP servers are dead, and the #1 debugging trap is that **your server's stdout *is* the protocol** — so a single `console.log` corrupts the wire and your logs vanish. `mcpgaze` sits transparently between your client and your server, forwarding every byte untouched while logging everything through a side channel.

```
   BEFORE                              AFTER
 client ⇄ server            client ⇄ [ mcpgaze ] ⇄ server
                                          │ side channel (never stdout)
                                          ▼  log file · latencies · drift
```

Every other tool — the official Inspector, MCPJam — acts *as the client*, so it can only debug a server you point it at. `mcpgaze` leaves a tap in place while your **real** client (Claude, Cursor, …) drives, so you see what actually happened in production.

## Install

```bash
npx mcpgaze --help          # zero install
npm i -g mcpgaze            # or global
```

Zero runtime dependencies — nothing extra enters your protocol path.

## `wrap` — see the live session

Wrap your server command. In `claude_desktop_config.json` (or Cursor, etc.):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "mcpgaze", "wrap", "--", "node", "/abs/path/server.js"]
    }
  }
}
```

Then tail the structured session log in another terminal:

```bash
mcpgaze wrap --print -- node server.js     # standalone, pretty to stderr
# logs also written to .mcpgaze/session-<ts>.jsonl
```

You get every JSON-RPC message (both directions), request→response **latency matched by id**, **orphaned requests** that never got a reply, parse errors, and the server's **stderr captured** alongside — the logs that normally disappear into the void.

**The guarantee:** the forwarded stream is byte-exact. `mcpgaze` parses *copies* off the hot path; an observer error can never disturb the wire. (Verified in CI: wrapped stdout is identical, byte for byte, to the unwrapped server.)

## `snapshot` + `diff` — catch schema drift in CI

Tool schemas change silently between versions — a field flips to `required`, an enum loses a value — and agents break with no error. Treat your tool surface like a lockfile:

```bash
mcpgaze snapshot -- node server.js          # writes mcpgaze.baseline.json (commit it)
mcpgaze diff --fail-on-drift -- node server.js   # exit 1 on a breaking change
```

In GitHub Actions:

```yaml
- run: npx mcpgaze diff --fail-on-drift -- node server.js
```

Severity model: removed property / new required property / type change / enum value removed / optional→required = **breaking**; required→optional = **warning**; additive changes = **info**. `--fail-on <breaking|warning|any>` sets the gate.

## Commands

| Command | What it does |
|---|---|
| `mcpgaze wrap -- <cmd>` | Transparent stdio proxy; logs the live session to a side channel. |
| `mcpgaze wrap-http --upstream <url>` | HTTP transport proxy (JSON + SSE); path-routes multiple upstreams. |
| `mcpgaze record -- <cmd>` | Wrap a server and write a replayable cassette. |
| `mcpgaze replay --cassette <f>` | Deterministic mock MCP server from a cassette. |
| `mcpgaze snapshot -- <cmd>` | Probe the server, write a tool-schema baseline. |
| `mcpgaze diff -- <cmd>` | Diff the live tool surface against the baseline; gate CI. |
| `mcpgaze conform -- <cmd>` | Spec-conformance suite across protocol versions. |
| `mcpgaze verify --cassette <f> -- <cmd>` | Behavioral (response-shape) drift vs a cassette. |
| `mcpgaze health -- <cmd>` | Continuous uptime/latency/drift monitoring (or `--once`). |
| `mcpgaze triage --log <f>` | Surface failures from a session; optional Claude diagnosis. |
| `mcpgaze preflight -- <cmd>` | Find env vars a GUI client won't inherit; check a config's env block. |

## `wrap-http` — the Streamable HTTP transport

For remote/HTTP MCP servers the model inverts: `mcpgaze` runs as a localhost-bound proxy that forwards to your upstream and observes both plain JSON and SSE responses. (For HTTP, the spec says the client doesn't capture the server's stderr at all — so the proxy is your *only* window.)

```bash
mcpgaze wrap-http --upstream http://localhost:3000/mcp --port 7000
# then point your client at http://127.0.0.1:7000/mcp
```

**Path-aware routing.** One proxy can front several upstream servers, routed by path prefix (longest match wins), so you watch all of them through a single tap and log:

```bash
mcpgaze wrap-http --port 7000 \
  --route /github=http://localhost:3001/mcp \
  --route /slack=http://localhost:3002/mcp
# client hits http://127.0.0.1:7000/github and .../slack
```

`--upstream URL` is the single-route shorthand (it mounts at the URL's own path). The remainder of the request path after the matched prefix is appended to the upstream (nginx-style), and the client's query string is preserved. Unmatched paths get a clear 404, and each route taken is recorded in the session log.

Security defaults, baked in: binds to `127.0.0.1` only, and rejects cross-origin browser requests (DNS-rebinding defense — the class of bug behind the Inspector's CVE-2025-49596). `--host` and `--allow-origin` override, with a warning.

## `record` + `replay` — VCR for MCP

Record a real session into a cassette, then replay it as a deterministic mock server with no backend — for offline client development and regression CI.

```bash
mcpgaze record --cassette s.json -- node server.js   # wrap + capture req/res pairs
mcpgaze replay --cassette s.json                      # serve those pairs over stdio
```

Replay matches requests by method + params (exact first, then a unique method-only fallback) and returns a clear JSON-RPC error for anything unrecorded instead of hanging. Verified: replayed responses are byte-identical to the originals.

## `preflight` — catch the env vars a GUI client won't inherit

GUI apps (Claude Desktop, etc.) do **not** inherit your shell environment — so a server that works in your terminal fails silently in production. `preflight` spawns the server twice, once with your full env and once with only the GUI-inherited subset, and tells you which vars matter:

```bash
mcpgaze preflight -- node server.js
# ⚠ starts with your full shell env but FAILS with only what a GUI client inherits.
#   Likely culprits: MCP_SECRET, DATABASE_URL …

mcpgaze preflight --config claude_desktop_config.json --server my-server
# ERROR  API_KEY — value contains "${MY_KEY}" — GUI clients do NOT expand shell variables
```

## `conform` — spec conformance across versions

Run a conformance suite against your server for one or more protocol versions. Required checks gate CI; recommended checks warn.

```bash
mcpgaze conform -- node server.js                 # latest known spec
mcpgaze conform --all -- node server.js           # 2025-06-18, 2025-11-25, 2026-07-28 RC
mcpgaze conform --json -- node server.js | jq     # machine-readable
```

Checks include: initialize returns a valid result with `protocolVersion` and `serverInfo.name`; `tools/list` returns named tools with object input schemas; `required[]` only names declared properties; and an unknown method returns a proper JSON-RPC error (`-32601`) instead of hanging or crashing. Exits 1 if any required check fails.

## `verify` — behavioral (response-shape) drift

`diff` compares *declared* schemas; `verify` catches drift the schema can't see — a server can keep an identical tool schema while its responses change shape (a field disappears, a list goes empty, a type flips). It re-issues the requests in a cassette against the live server and diffs the **response shapes**.

```bash
mcpgaze record --cassette s.json -- node server.js   # capture real behavior once
mcpgaze verify --cassette s.json --fail-on warning -- node server.js
#   WARNING   tools/call.results[] — array is now empty (was populated)
#   BREAKING  tools/call.total — field removed from response
```

Severity: field removed / type change = **breaking**; non-empty array now empty = **warning**; field added = **info**. **Caveat:** `verify` executes the recorded tool calls against the live server — run it against read-only tools or a disposable instance.

## `triage` — turn a failed session into a diagnosis

Read a session log (from `wrap`/`wrap-http`), surface every failure signal — error responses, orphaned requests, parse errors, and crash-y server stderr — and, with `--ai`, get a plain-English root cause and fix from Claude.

```bash
mcpgaze triage --log .mcpgaze/session-*.jsonl          # local failure summary
ANTHROPIC_API_KEY=sk-... mcpgaze triage --log s.jsonl --ai
```

The AI call is optional and uses zero extra dependencies (plain `fetch`); without a key, `triage` still prints the structured local summary. (`--ai` sends the failure context to the Anthropic API — be mindful of sensitive payloads in logs.)

## `wrap --tui` — live dashboard

`mcpgaze wrap --tui -- node server.js` opens a full-screen live view: the message stream (with direction, latency, and errors highlighted), the server's captured stderr, and running stats (req/res/notif counts, errors, orphans, p50/p95 latency). Zero dependencies — it's hand-drawn ANSI, so nothing extra enters your protocol path. Falls back to plain logging when there's no TTY.

## `wrap --native` — the Rust hot-path

A single static binary (`mcpgaze-proxy`, written in `std`-only Rust, no crates) does the same byte-exact forward + observation as the Node proxy, with no Node runtime required. Build it once:

```bash
cd native/mcpgaze-proxy && cargo build --release
mcpgaze wrap --native -- node server.js     # or set MCPGAZE_PROXY_BIN
```

**Honest benchmark** (20k round-trips through each proxy, mock server):

| | throughput | vs Node proxy |
|---|---|---|
| direct (no proxy) | ~124k req/s | — |
| Node proxy | ~47k req/s | 1.0× |
| Rust proxy | ~78k req/s | **~1.6×** |

Rust is genuinely ~64% faster and roughly halves added latency — but even the Node proxy at 47k req/s far exceeds any real MCP workload. So `--native` earns its place mainly for **single-binary distribution (no Node)** and high-throughput/streaming cases, not because Node was too slow. It stays opt-in. (The Rust path does forward + capture with best-effort classification; full id-correlation and the rest of the command surface live in the Node CLI, which reads the same JSONL.)

## `health` — continuous local monitoring

Know the moment your server joins the 52% dead. `health` probes a server on an interval (initialize + tools/list), tracks uptime / latency / tool-schema drift, prints up↔down and drift transitions, and persists status to `.mcpgaze/health.json`.

```bash
mcpgaze health --interval 30 -- node server.js     # daemon
mcpgaze health --once -- node server.js            # cron/CI liveness probe (exit 0 up / 1 down)
```

(The hosted, cross-server, historical version of this is the paid layer; the local daemon is free.)

## Re-baselining — accept drift on purpose

When drift is intentional, accept it into the baseline instead of fighting the check — the `--updateSnapshot` pattern, for both drift kinds:

```bash
mcpgaze diff --update -- node server.js                      # accept the new tool surface
mcpgaze verify --cassette s.json --update -- node server.js  # accept the new response shapes
```

## Testing & hardening

Because mcpgaze sits in the protocol data path, correctness is enforced by *generative* checks, not just hand-written cases:

- **Property/fuzz hunt** (`npm run test:fuzz`) — thousands of seeded-random trials assert the two core invariants: framing is **invariant to chunk boundaries** (a message split at any byte, including mid-multibyte, yields identical results) and the observer **never throws** on adversarial bytes (invalid UTF-8, NULs, multi-MB lines).
- **Wire-integrity fuzz** (`scripts/wire-integrity.mjs`) — random *binary* payloads forwarded through the proxy must come out **byte-identical**.
- **Differential oracle** (`scripts/diff-proxies.mjs`) — the Node and Rust proxies are run on identical traffic; their logs must **agree** on every message (raw, direction, classification), keeping the two implementations honest.
- **Dogfood** (`scripts/dogfood.mjs`) — `replay` is itself an MCP server, so mcpgaze's own **conformance suite is run against it**; the tool must satisfy its own spec checks.
- **Real-SDK integration** — the suite probes and conforms a genuine `@modelcontextprotocol/sdk` server, not only hand-rolled mocks.

`npm run harden` runs the differential, wire-integrity, and dogfood workflows together. CI (`.github/workflows/ci.yml`) runs typecheck/test/build on Node 18/20/22, builds the Rust proxy, and runs all of the above on every push.

## Roadmap (post-1.0)

- Hosted control plane: cross-server health/drift history, alerting, team workspaces (the open-core paid layer).
- Prebuilt per-platform `mcpgaze-proxy` binaries shipped with the npm package (so `--native` needs no `cargo`).

## Where this is going (open core)

The CLI — proxy, local logging, schema snapshot/diff, CI gating — is free and open source (Apache-2.0), forever. A future hosted layer will handle what a local CLI can't: **continuous** uptime/health monitoring across many servers (know the moment one of yours joins the 52%), drift *history*, alerting, and team workspaces. The line is simple: one dev, one server, one machine is free; aggregation across servers, time, and teams is the paid layer.

## Scope & honesty

The schema differ is deliberately focused on the cases that break agents (properties, required, type, enum) — it is not a general JSON Schema differ. The current MCP spec target is `2025-06-18`; conformance across versions is on the roadmap.

## License

Apache-2.0.
