# Architecture

`mcpgaze` is small (~3k lines of TypeScript, ~450 lines of Rust) and deliberately so. This document explains the one idea everything is built on, the two invariants that make it safe to leave in your protocol path, and how the pieces fit.

## The one primitive

> **Forward the MCP wire byte-for-byte; observe a copy on a side channel.**

Everything else — drift detection, conformance, record/replay, health, triage — is analysis layered on top of the logs that primitive produces. Get the primitive right and the rest is ordinary application code.

```
            ┌──────────────────────────── mcpgaze ────────────────────────────┐
            │                                                                  │
  client ───┼──▶ (raw bytes, forwarded untouched) ──────────────────────▶ server stdin
            │        └──▶ copy ──▶ framer ──▶ classify ──▶ logger              │
            │                                                                  │
  client ◀──┼──── (raw bytes, forwarded untouched) ◀────────────────── server stdout
            │        └──▶ copy ──▶ framer ──▶ classify ──▶ correlator ──▶ logger
            │                                                                  │
            │   server stderr ──▶ captured ──▶ logger  (and mirrored through)  │
            └──────────────────────────────────────────────────────────────────┘
                                     side channel ▼
                              .mcpgaze/session-<ts>.jsonl  (never stdout)
```

The forward path is a **direct byte copy** — the framer never sits *between* the two streams, so it cannot reorder, re-encode, or stall the wire. The observer consumes a *duplicate* of the same bytes.

## The two invariants

These are not aspirations; they're the contract the test suite enforces on every push.

### (A) Wire integrity — bytes in == bytes out

On the forward path, what the client sends arrives at the server unchanged, and vice-versa. `mcpgaze` never reconstructs a message from its parse and re-serializes it onto the wire. The observer works on copies.

Consequences that fall out of this:
- A message split across TCP/pipe chunks (even **mid-multibyte-character**) is forwarded exactly, regardless of where the boundary fell.
- Malformed JSON, binary noise, and oversized lines pass through untouched — `mcpgaze` is a wiretap, not a validator.

### (B) Observer safety — the observer never throws into the wire

The observation path (framing, classification, logging, redaction) is **total**: on any adversarial input it degrades a log line, never the protocol. Concretely:
- Line framing caps line length (`MAX_LINE = 64 MiB`) and **resyncs at the next newline** instead of buffering unboundedly or throwing.
- Classification and redaction are wrapped so a throw becomes a best-effort/raw value, never an exception on the hot path.
- The logger's file stream swallows its own I/O errors rather than propagating them.

Because of (B), you can leave `mcpgaze` in front of a flaky server and a parser bug in the observer will never take down your session.

## How the invariants are tested

Correctness here can't be covered by examples alone, so the suite is **generative**:

| Test | What it asserts |
|---|---|
| **Property/fuzz** (`npm run test:fuzz`) | Framing is invariant to chunk boundaries; the observer never throws on adversarial bytes (invalid UTF-8, NULs, multi-MB lines). |
| **Wire-integrity fuzz** (`scripts/wire-integrity.mjs`) | Random *binary* payloads forwarded through the proxy come out byte-identical. |
| **Differential oracle** (`scripts/diff-proxies.mjs`) | The Node and Rust proxies, run on identical traffic (incl. a ~280-line adversarial corpus under `scripts/corpus/`), agree on every message. |
| **Dogfood** (`scripts/dogfood.mjs`) | `replay` is itself an MCP server, so `mcpgaze` runs its own conformance suite against it. |
| **Adversarial regression** (`src/test/adv-*.test.ts`) | One reproducing test per defect found in the pre-release bug-hunt. |

`npm run harden` runs the differential, wire-integrity, and dogfood workflows together; CI runs all of it across Node 18/20/22 plus the Rust build.

## The Node ⇄ Rust split

There are **two** byte-exact proxy implementations, and they are kept honest against each other by the differential oracle:

- **Node proxy** (`src/proxy.ts`) — the default. Classifies messages by a **full JSON parse**, so its `kind`/`method` metadata is authoritative. Drives the entire command surface.
- **Rust proxy** (`native/mcpgaze-proxy/`) — opt-in via `wrap --native`. A single `std`-only static binary (no crates), `panic = "abort"`. It does the same byte-exact forward + capture, but classifies with a **parse-free, allocation-light, single-pass top-level-key scanner** (`scan_top_level`) that mirrors the Node parser's view without building a JSON tree.

The scanner deliberately doesn't JSON-parse or decode `\uXXXX` escapes, so three narrow classes of *classification metadata* can differ from the Node log (malformed JSON, escaped key names, method-value escape fidelity). The forwarded bytes and the verbatim `raw` field are always exact — only the derived summary may differ, and the Node proxy is authoritative when it matters. See [KNOWN-ISSUES.md #4](../KNOWN-ISSUES.md).

Both proxies write the **same JSONL schema** ([Session Log Format](./session-log.md)), so every downstream command (`triage`, etc.) consumes either one transparently.

### Recursion / size caps

Untrusted input gets hard bounds so neither invariant can be broken by a pathological payload:

| Bound | Where | Value |
|---|---|---|
| Max framed line | `src/framer.ts` | 64 MiB (resync, don't throw) |
| Response-shape walk depth | `src/shape.ts` | 500 |
| Cassette `stableStringify` depth | `src/cassette.ts` | 200 |
| Redaction walk depth | `src/redact.ts` | 200 |
| Rust pump line cap | `native/.../main.rs` | 1 MiB |

## Module map

| Module | Responsibility |
|---|---|
| `index.ts` | CLI dispatch, flag parsing, exit codes. |
| `proxy.ts` | stdio proxy (`runProxy`), the request↔response `Correlator` (latency, orphans). |
| `http-proxy.ts` | Streamable HTTP proxy: routing (`buildRoutes`/`resolveRoute`), upstream targeting (`buildTarget`), Origin checks, credential scoping. |
| `sse.ts` | Server-Sent Events parsing for the HTTP observer. |
| `framer.ts` | Newline framing (`LineFramer`), chunk-boundary-invariant, with the `MAX_LINE` cap + resync. |
| `jsonrpc.ts` | Message classification (`classify` → request / response / notification / error). |
| `logger.ts` | The side channel: JSONL + optional pretty stream + TUI event hook. `0600` file mode. |
| `redact.ts` | Fail-safe, dependency-free secret redaction for observer artifacts only (never the wire). |
| `mcp-connection.ts` | Spawn-and-drive an MCP server (`initialize`, `request`, `notify`) for the probe-based commands. |
| `client.ts` | `PROTOCOL_VERSION` and the handshake helper. |
| `snapshot.ts` / `diff.ts` / `schema-diff.ts` | Tool-schema baseline, drift diff, severity model. |
| `conform.ts` | The conformance check catalog and runner. |
| `verify.ts` / `shape.ts` | Behavioral drift: re-issue recorded requests, diff response *shapes*. |
| `cassette.ts` | `record` capture, `replay` server, `stableStringify`. |
| `health.ts` | The health daemon, summary stats, status persistence. |
| `triage.ts` | Failure extraction + optional (redacted, consented) Claude diagnosis. |
| `preflight.ts` | GUI-env-inheritance diagnostics and config `env` linting. |
| `tui.ts` / `colors.ts` | Hand-drawn ANSI dashboard and color helpers (zero deps). |

## The schema differ

The differ (`schema-diff.ts`) is intentionally **focused**, not general. It covers exactly the JSON-Schema changes that break agents in practice — properties added/removed, `required` flips, type changes, enum narrowing — and classifies each by severity. It is *not* a full JSON Schema diff (it won't reason about `$ref`, `allOf`, conditional schemas, etc.), and that's a deliberate scope choice: a focused differ produces actionable, low-noise CI failures. See [`diff`](./commands.md#diff) for the severity table.

## Design principles

- **Zero runtime dependencies.** Nothing extra enters your protocol path. The TUI is hand-drawn ANSI; the AI call is plain `fetch`; the Rust proxy is `std`-only. Build/test-time tooling lives in `devDependencies` and never ships.
- **The wire is sacred.** Redaction, classification, and every other transform touch only *copies*. The forward path has no opinions.
- **Fail safe, not loud.** On the observer path, when in doubt, degrade the log line and keep the session alive.
- **Honest scope.** Where a tool is deliberately partial (the schema differ, the Rust classifier), it says so in the docs and is bounded by a test, rather than pretending to be complete.
