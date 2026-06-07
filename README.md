<div align="center">

# mcpgaze

**A transparent wiretap for MCP servers.**
See exactly what your AI client sends your server — without breaking the protocol — and catch tool-schema drift before it ships.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](#zero-dependencies-by-design)
[![MCP spec](https://img.shields.io/badge/MCP%20spec-2025--11--25-7c3aed.svg)](https://modelcontextprotocol.io/specification)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[Quickstart](#quickstart) · [Why mcpgaze](#why-mcpgaze) · [Commands](#commands) · [Docs](./docs) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md)

</div>

---

An MCP server's **stdout *is* the protocol wire** — so a single stray `console.log` corrupts every message, and the logs you actually wanted vanish into the void. `mcpgaze` sits transparently between your client and your server, forwarding every byte **untouched** while logging the whole JSON-RPC conversation through a side channel.

```
   BEFORE                              AFTER
 client ⇄ server            client ⇄ [ mcpgaze ] ⇄ server
                                          │ side channel (never stdout)
                                          ▼  log file · latencies · drift
```

On top of that live wiretap it adds schema-drift detection for CI, multi-version spec conformance, behavioral (response-shape) drift checks, record/replay, health monitoring, and failure triage — eleven commands, **zero runtime dependencies**, Apache-2.0.

> Context: a 2025 academic crawl of ~17.6k MCP registry entries ([arXiv:2509.25292](https://arxiv.org/abs/2509.25292)) found more than half invalid or low-value — i.e. abandoned or broken-on-install, not live downtime. The MCP ecosystem is young and brittle; `mcpgaze` is the instrument that tells you which half you're running.

## Quickstart

`mcpgaze` isn't published to npm yet, so build it from source (zero runtime deps, ~5 seconds):

```bash
git clone https://github.com/anma-labs/mcpgaze && cd mcpgaze
npm install && npm run build
node dist/index.js --help
```

> Once published, this becomes `npx @anma-labs/mcpgaze --help` / `npm i -g @anma-labs/mcpgaze`. Until then, substitute `node /abs/path/to/mcpgaze/dist/index.js` everywhere this README writes `mcpgaze`. See [Getting Started](./docs/getting-started.md) for the full setup, including a `mcpgaze` shell alias.

**Watch a live session:**

```bash
mcpgaze wrap --tui -- node my-server.js     # full-screen live dashboard
```

**Gate CI on tool-schema drift:**

```bash
mcpgaze snapshot -- node my-server.js               # writes mcpgaze.baseline.json (commit it)
mcpgaze diff --fail-on-drift -- node my-server.js    # exit 1 on a breaking change
```

That's the whole loop: **see** what happens live, then **lock** the contract so it can't silently change.

## Why mcpgaze

Every other MCP debugging tool — the official [Inspector](https://github.com/modelcontextprotocol/inspector), MCPJam — acts **as the client**. It can only exercise a server you point it at, with traffic *it* generates. `mcpgaze` is different: it leaves a tap in place while your **real** client (Claude Desktop, Cursor, …) drives, so you see what actually happened — in development and in production.

|  | Inspector / MCPJam | **mcpgaze** |
|---|---|---|
| Role | Acts *as* the client | Sits *between* client and server |
| Traffic seen | What the tool generates | What your real client actually sends |
| stdio + Streamable HTTP | ✓ / ✓ | ✓ / ✓ |
| Captures server stderr | — | ✓ (the logs that normally disappear) |
| Schema-drift gate for CI | — | ✓ `snapshot` / `diff` |
| Behavioral drift | — | ✓ `verify` |
| Record / replay (VCR) | — | ✓ `record` / `replay` |
| Continuous health | — | ✓ `health` |
| Runtime dependencies | many | **zero** |

### The two invariants

`mcpgaze` is engineered around two guarantees, enforced by generative tests (fuzz, differential, dogfood) on every push — not just hand-written cases:

- **(A) Wire integrity** — on the forward path, **bytes in == bytes out**. `mcpgaze` parses *copies* off the hot path; the protocol stream is never reconstructed, reordered, or re-encoded.
- **(B) Observer safety** — the observation/logging path **never throws** into the wire. Adversarial bytes (invalid UTF-8, NULs, multi-MB lines, malformed JSON) can disturb a log line, never the protocol.

Everything else in the tool is downstream of these two promises. See [Architecture](./docs/architecture.md) for how they're held.

## Commands

Eleven commands, one binary. Full reference with every flag, exit code, and example: **[docs/commands.md](./docs/commands.md)**.

| Command | What it does |
|---|---|
| [`wrap`](./docs/commands.md#wrap) | Transparent stdio proxy; logs the live session to a side channel. `--tui`, `--native`. |
| [`wrap-http`](./docs/commands.md#wrap-http) | Streamable HTTP proxy (JSON + SSE); localhost-bound, Origin-checked, path-routes many upstreams. |
| [`snapshot`](./docs/commands.md#snapshot) | Probe the server, write a tool-schema baseline you commit to git. |
| [`diff`](./docs/commands.md#diff) | Diff the live tool surface against the baseline; gate CI with `--fail-on`. |
| [`conform`](./docs/commands.md#conform) | Spec-conformance suite across protocol versions. |
| [`verify`](./docs/commands.md#verify) | Behavioral (response-shape) drift vs a recorded cassette. |
| [`record`](./docs/commands.md#record) | Wrap a server and write a replayable cassette (secrets redacted by default). |
| [`replay`](./docs/commands.md#replay) | Deterministic mock MCP server from a cassette — no backend. |
| [`health`](./docs/commands.md#health) | Continuous uptime/latency/drift monitoring, or `--once` as a liveness probe. |
| [`triage`](./docs/commands.md#triage) | Surface failures from a session log; optional Claude diagnosis with `--ai`. |
| [`preflight`](./docs/commands.md#preflight) | Find env vars a GUI client won't inherit; statically check a config's `env` block. |

---

### `wrap` — see the live session

Wrap your server command in your client config. For `claude_desktop_config.json` (Cursor and others are analogous):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/abs/path/to/mcpgaze/dist/index.js", "wrap", "--", "node", "/abs/path/server.js"]
    }
  }
}
```

Then tail the structured session log, or run standalone with a live view:

```bash
mcpgaze wrap --print -- node server.js     # standalone; pretty stream to stderr
mcpgaze wrap --tui   -- node server.js     # full-screen dashboard (zero deps, hand-drawn ANSI)
# every run also writes .mcpgaze/session-<ts>.jsonl
```

You get every JSON-RPC message (both directions), request→response **latency matched by id**, **orphaned requests** that never got a reply, parse errors, and the server's **stderr captured** alongside. The forwarded stream stays byte-exact (invariant A) — an observer error can never disturb the wire (invariant B).

→ [`wrap` reference](./docs/commands.md#wrap) · [`--native` Rust hot-path](./docs/commands.md#wrap---native) · [`--tui`](./docs/commands.md#wrap---tui)

### `snapshot` + `diff` — catch schema drift in CI

Tool schemas change silently between versions — a field flips to `required`, an enum loses a value — and agents break with no error. Treat your tool surface like a lockfile:

```bash
mcpgaze snapshot -- node server.js                  # writes mcpgaze.baseline.json (commit it)
mcpgaze diff --fail-on-drift -- node server.js       # exit 1 on a breaking change
```

```yaml
# .github/workflows/mcp.yml
- run: node dist/index.js diff --fail-on-drift -- node server.js
```

**Severity model:** removed property · new required property · type change · enum value removed · optional→required = **breaking**; required→optional = **warning**; additive changes = **info**. `--fail-on <breaking|warning|any>` sets the gate; `--update` accepts intentional drift into the baseline.

→ [`snapshot` / `diff` reference](./docs/commands.md#snapshot) · [CI recipes](./docs/ci.md)

### `conform` — spec conformance across versions

Run a conformance suite against your server for one or more protocol versions. Required checks gate CI; recommended checks warn.

```bash
mcpgaze conform -- node server.js                 # default spec (2025-06-18)
mcpgaze conform --spec 2025-11-25 -- node ...     # a specific version
mcpgaze conform --all -- node server.js           # 2025-06-18, 2025-11-25, 2026-07-28 (RC)
mcpgaze conform --json -- node server.js | jq     # machine-readable
```

Checks include: `initialize` returns a valid result with `protocolVersion` and `serverInfo.name`; `tools/list` returns named tools with object input schemas; `required[]` only names declared properties; and an unknown method returns a proper JSON-RPC error (`-32601`) instead of hanging. Exits 1 if any required check fails.

→ [`conform` reference & full check catalog](./docs/commands.md#conform)

### `record` + `replay` — VCR for MCP

Record a real session into a cassette, then replay it as a deterministic mock server with no backend — for offline client development and regression CI.

```bash
mcpgaze record --cassette s.json -- node server.js   # capture req/res pairs (secrets redacted by default)
mcpgaze replay --cassette s.json                     # serve those pairs over stdio
```

Replay matches by method + params (exact first, then a unique method-only fallback) and returns a clear JSON-RPC error for anything unrecorded instead of hanging. Cassettes are written `0600`, `*.cassette.json` is git-ignored by default, and `record` **redacts credential-shaped values by default** — review before sharing. See [Security](./SECURITY.md).

→ [`record` / `replay` reference](./docs/commands.md#record)

### `verify` — behavioral (response-shape) drift

`diff` compares *declared* schemas; `verify` catches drift the schema can't see — a server can keep an identical tool schema while its responses change shape (a field disappears, a list goes empty, a type flips). It re-issues a cassette's requests against the live server and diffs the **response shapes**.

```bash
mcpgaze verify --cassette s.json --fail-on warning --allow-tool-calls -- node server.js
#   WARNING   tools/call.results[] — array is now empty (was populated)
#   BREAKING  tools/call.total — field removed from response
```

> **Caveat:** `verify` re-executes recorded requests. Only read-only methods are re-issued unless you pass `--allow-tool-calls` — run that against a disposable instance.

→ [`verify` reference](./docs/commands.md#verify)

### `health` — continuous local monitoring

```bash
mcpgaze health --interval 30 -- node server.js     # daemon: uptime, latency, schema-drift transitions
mcpgaze health --once -- node server.js            # cron/CI liveness probe (exit 0 up / 1 down)
```

Probes `initialize` + `tools/list` on an interval, prints up↔down and drift transitions, and persists status to `.mcpgaze/health.json`.

→ [`health` reference](./docs/commands.md#health)

### `triage` — turn a failed session into a diagnosis

```bash
mcpgaze triage --log .mcpgaze/session-<ts>.jsonl              # local failure summary
ANTHROPIC_API_KEY=sk-... mcpgaze triage --log s.jsonl --ai --yes   # + Claude root-cause & fix
```

Surfaces every failure signal — error responses, orphaned requests, parse errors, crash-y stderr — and, with `--ai`, gets a plain-English root cause from Claude. The AI call uses zero extra dependencies (plain `fetch`), **redacts** secrets at the egress boundary, and requires explicit consent (`--yes` or an interactive `y`).

→ [`triage` reference](./docs/commands.md#triage)

### `preflight` — catch the env vars a GUI client won't inherit

GUI apps (Claude Desktop, etc.) do **not** inherit your shell environment, so a server that works in your terminal fails silently in production. `preflight` spawns the server twice — full env vs. the GUI-inherited subset — and names the vars that matter:

```bash
mcpgaze preflight -- node server.js
mcpgaze preflight --config claude_desktop_config.json --server my-server
```

→ [`preflight` reference](./docs/commands.md#preflight)

### `wrap-http` — the Streamable HTTP transport

For remote/HTTP MCP servers, `mcpgaze` runs as a localhost-bound proxy that forwards to your upstream and observes both plain JSON and SSE. (For HTTP, the spec gives the client no view of server stderr — so the proxy is your *only* window.)

```bash
mcpgaze wrap-http --upstream http://localhost:3000/mcp --port 7000
# point your client at http://127.0.0.1:7000/mcp
```

One proxy can front several upstreams, routed by path prefix (longest match wins):

```bash
mcpgaze wrap-http --port 7000 \
  --route /github=http://localhost:3001/mcp \
  --route /slack=http://localhost:3002/mcp
```

**Security defaults, baked in:** binds to `127.0.0.1` only, and rejects cross-origin browser requests (DNS-rebinding defense — the bug class behind the Inspector's [CVE-2025-49596](https://nvd.nist.gov/vuln/detail/CVE-2025-49596), CVSS 9.4). Multi-route credential scoping strips `Authorization`/`Cookie` unless a route opts in. Full model: [Security](./SECURITY.md) and [`wrap-http` reference](./docs/commands.md#wrap-http).

## `--native` — the Rust hot-path

A single static binary (`mcpgaze-proxy`, ~450 lines of `std`-only Rust, **no crates**) does the same byte-exact forward + observation as the Node proxy, with no Node runtime required:

```bash
cd native/mcpgaze-proxy && cargo build --release
mcpgaze wrap --native -- node server.js     # or set MCPGAZE_PROXY_BIN
```

In a 20k-round-trip microbenchmark against a mock server, the Rust proxy runs ~1.7× the Node proxy's throughput and roughly halves added latency. The headline absolute numbers are machine- and runtime-specific and the bench harness isn't committed yet, so treat them as one machine's reading — **the durable result is the relationship**: direct ≫ Rust > Node, all far above any real MCP workload. `--native` earns its place for **single-binary distribution (no Node)** and high-throughput/streaming cases; it stays opt-in.

→ [`--native` details, benchmark, and the classifier trade-off](./docs/commands.md#wrap---native)

## Zero dependencies by design

`package.json` lists **no runtime dependencies** — nothing extra enters your protocol path. The TUI is hand-drawn ANSI, the AI triage call is plain `fetch`, the Rust proxy is `std`-only. Everything in `devDependencies` (TypeScript, tsup, the MCP SDK used only as a test fixture) is build/test-time and never ships in the `dist/` you run.

## Testing & hardening

Because `mcpgaze` sits in the protocol data path, correctness is enforced by **generative** checks, not just examples:

- **Property/fuzz hunt** (`npm run test:fuzz`) — thousands of seeded-random trials assert both invariants: framing is **invariant to chunk boundaries** (a message split at any byte, including mid-multibyte, yields identical results) and the observer **never throws** on adversarial bytes.
- **Wire-integrity fuzz** (`scripts/wire-integrity.mjs`) — random *binary* payloads forwarded through the proxy come out **byte-identical**.
- **Differential oracle** (`scripts/diff-proxies.mjs`) — the Node and Rust proxies run identical traffic; their logs must **agree** on every message, keeping the two implementations honest.
- **Dogfood** (`scripts/dogfood.mjs`) — `replay` is itself an MCP server, so `mcpgaze`'s own **conformance suite runs against it**.
- **Real-SDK integration** — the suite probes and conforms a genuine `@modelcontextprotocol/sdk` server, plus a 20-cell TS + Python SDK matrix across the full command surface.

`npm run harden` runs the differential, wire-integrity, and dogfood workflows together. CI runs typecheck/test/build on Node 18/20/22, builds the Rust proxy, and runs all of the above on every push. See [CONTRIBUTING](./CONTRIBUTING.md#testing) and [Architecture](./docs/architecture.md#how-the-invariants-are-tested).

## Documentation

| Doc | For |
|---|---|
| [Getting Started](./docs/getting-started.md) | Install, wire into Claude Desktop / Cursor, read your first session log |
| [Command Reference](./docs/commands.md) | Every command, flag, exit code, and env var |
| [CI Recipes](./docs/ci.md) | Drop-in GitHub Actions for drift gating, conformance, and liveness |
| [Architecture](./docs/architecture.md) | The two invariants, framing, the Node/Rust split, module map |
| [Session Log Format](./docs/session-log.md) | The `.jsonl` event schema, for building on top of `mcpgaze` |
| [Security Policy](./SECURITY.md) | Threat model, data-at-rest, credential scoping, reporting |
| [Known Issues](./KNOWN-ISSUES.md) | Accepted, documented limitations for v1.0 |
| [Changelog](./CHANGELOG.md) | Release history |

## Where this is going (open core)

The CLI — proxy, local logging, schema snapshot/diff, CI gating — is free and open source (Apache-2.0), forever. A future hosted layer handles what a local CLI can't: **continuous** uptime/health across many servers, drift *history*, alerting, and team workspaces. The line is simple: **one dev, one server, one machine is free; aggregation across servers, time, and teams is the paid layer.**

Post-1.0 roadmap: hosted control plane (cross-server health/drift history, alerting); prebuilt per-platform `mcpgaze-proxy` binaries shipped with the npm package (so `--native` needs no `cargo`).

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev loop, the invariant rules every change must respect, and the test gates. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[Apache-2.0](./LICENSE).
