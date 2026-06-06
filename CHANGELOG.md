# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

## [1.0.0] — 2026-06-05

First public release. mcpgaze is a transparent wiretap for MCP servers: it
forwards the protocol byte-for-byte while observing the full JSON-RPC
conversation on a side channel, and adds drift detection, conformance, health
monitoring, and failure triage on top.

### Added

- **`wrap`** — transparent stdio proxy. Forwards bytes untouched (verified
  byte-exact) and logs every JSON-RPC message — with request↔response latency,
  orphaned-request detection, and the server's stderr — to a side channel,
  never to stdout (which is the protocol wire). `--tui` shows a live dashboard;
  `--native` uses the Rust fast-path.
- **`wrap-http`** — Streamable HTTP transport proxy (JSON + SSE), localhost-
  bound with Origin checks (DNS-rebinding defense). Path-prefix routing lets one
  proxy front several upstreams (`--route /a=URL --route /b=URL`).
- **`snapshot` / `diff`** — tool-schema baseline you commit to git, with a
  severity-classified drift diff and `--fail-on` to gate CI. `--update` accepts
  a new baseline.
- **`conform`** — spec-conformance suite across protocol versions
  (2025-06-18 / 2025-11-25 / 2026-07-28 RC), with `--json` and CI exit codes.
- **`verify`** — behavioral (response-shape) drift detection that catches what
  schema diffing can't; `--update` re-baselines the cassette.
- **`record` / `replay`** — record a session into a cassette and replay it as a
  deterministic mock MCP server.
- **`health`** — continuous uptime / latency / schema-drift monitoring, or
  `--once` as a cron/CI liveness probe.
- **`triage`** — surface failures from a session log, with an optional Claude
  diagnosis (`--ai`, zero extra dependencies).
- **`preflight`** — diagnose environment variables a GUI client won't inherit,
  and statically check a client config's `env` block.
- **Rust `--native` proxy** — a `std`-only single binary (no crates) for
  single-binary distribution and high-throughput cases (~1.6× the Node proxy in
  the bundled benchmark; opt-in, not a replacement).
- **Zero runtime dependencies.** Apache-2.0 licensed.

### Changed

- **Native (`--native`) proxy classifier rewritten to agree with the Node
  observer.** The old hot-path classifier substring-matched `"method"`/`"id"`/
  `"error"` anywhere on the raw line, so it mislabelled messages that carried one
  of those tokens inside a string value, a nested object, or a batch-array
  element, and it mis-handled `id:null` (counted it as an id) and responses
  missing their `result`/`error` key. It is replaced by an allocation-light,
  still-parse-free, single-pass **top-level-key scanner** (`scan_top_level` in
  `native/mcpgaze-proxy/src/main.rs`) that tracks string state and brace/bracket
  depth so only depth-1 keys of a top-level object count, distinguishes `id:null`
  from `id:0`, requires `result`/`error` to be present, and extracts `method`
  from the top-level key only. No JSON parser was added; both core invariants
  (byte-exact forwarding, observer never throws) are preserved, and allocations
  per line went *down* (the old path did three `format!`s per classify).

### Fixed

- **Node↔Rust classification divergence (`scripts/diff-proxies.mjs`).** A new
  corpus-driven differential mode (`--corpus <dir>`, `--repeat N` flaky guard,
  `--report`) was run over a ~280-line adversarial corpus
  (`scripts/corpus/`) covering key-tokens-in-values, nested ids, batch arrays,
  `id:0`/`id:null`, missing `jsonrpc`, unicode, whitespace/escaping, and
  malformed JSON. It surfaced **148** disagreements; the classifier rewrite
  eliminates **all 87 `kind` disagreements on well-formed lines** (batch arrays,
  nested keys, string-value false matches, `id:null`, `result`/`error`
  presence). The remaining 61 are confined to three documented parse-free
  residuals (malformed→`unparsed`, `\uXXXX`-escaped key names, and method-value
  escape fidelity) — see [`KNOWN-ISSUES.md`](./KNOWN-ISSUES.md) #4. New
  regression guard: `src/test/rust-node-classifier-parity.test.ts`.
- The corpus differential harness used fixed shared temp log paths, which could
  produce spurious "flaky"/alignment noise when several instances ran
  concurrently; each invocation now uses a private temp directory.

### Hardened (pre-release adversarial bug-hunt)

Before publishing, every module was put through an adversarial bug-hunt: one
adversary per module attempted to break the two core invariants (byte-exact
forwarding; observer never throws), and an independent verifier had to write and
run a reproducing test before any finding counted. **26 candidate defects were
investigated → 17 confirmed (each with a reproducing test) and fixed; 9
refuted.** By actual impact:

- **Wire integrity (1):** when an upstream died mid-SSE, an error string could
  be written into the live SSE body, corrupting the forwarded stream. Fixed: no
  body is ever written once headers are sent; the SSE loop is guarded and the
  upstream reader cancelled.
- **Correctness / observer fidelity (3):** numeric `id` coercion could cross-wire
  a reply to the wrong in-flight request (fixed: exact id match, no coercion);
  lone-CR / CR-only SSE boundaries could drop or corrupt observed events (fixed:
  full WHATWG CR/LF/CRLF handling, including chunk splits); the Rust classifier
  kept a BOM that JS strips, diverging from the Node log (fixed: trim U+FEFF).
- **Robustness / crash-prevention (13):** unhandled spawn (`ENOENT`) and stderr
  `EPIPE` errors that could crash the CLI mid-wire; unbounded recursion and
  accumulation that could stack-overflow, OOM the Rust proxy, or hit the V8
  512 MB string limit (fixed with depth/size caps and newline resync); and
  non-conformant server input (non-array `tools`, non-iterable `required`,
  non-finite terminal dimensions) that could throw out of `conform`, the replay
  server, or the TUI.

The 17 reproducing tests ship in `src/test/` as permanent regression guards
(**94 tests total**, up from 72). The Node↔Rust differential oracle, the binary
wire-integrity fuzz, and the dogfood conformance run all remained green after
the fixes (`npm run harden`).

Four of the refuted candidates were confirmed as real but non-invariant-breaking
and are consciously deferred — see [`KNOWN-ISSUES.md`](./KNOWN-ISSUES.md).

[1.0.0]: https://github.com/anma-labs/mcpgaze/releases/tag/v1.0.0
