# mcpgaze v1.0.0

**A transparent wiretap for MCP servers — see what your AI client actually sends, without breaking the protocol.**

mcpgaze sits between your AI client and an MCP server and forwards the protocol
byte-for-byte, while logging the full JSON-RPC conversation on a side channel.
Because an MCP server's stdout *is* the protocol wire, a stray `console.log`
corrupts it — mcpgaze taps the wire without ever writing to it. On top of live
debugging it adds schema-drift detection for CI, behavioral drift checks, a
multi-version spec conformance suite, health monitoring, and failure triage.

## Highlights

- **`wrap` / `wrap-http`** — transparent stdio and Streamable HTTP (JSON + SSE)
  proxies. Byte-exact forwarding, side-channel logging with latency and orphan
  detection, a live `--tui` dashboard, and an optional Rust `--native` fast-path.
  `wrap-http` is localhost-bound with Origin checks and path-prefix routing.
- **`snapshot` / `diff`** — commit a tool-schema baseline and catch silent drift
  in CI with severity-classified diffs and `--fail-on`.
- **`conform`** — spec conformance across protocol versions, with CI exit codes.
- **`verify`** — behavioral (response-shape) drift detection.
- **`record` / `replay`** — capture a session and replay it as a deterministic
  mock MCP server.
- **`health`** — continuous uptime/latency/drift monitoring, or `--once` as a
  liveness probe.
- **`triage`** — surface failures from a log, with an optional Claude diagnosis.
- **`preflight`** — catch environment variables a GUI client won't inherit.

Zero runtime dependencies. Apache-2.0.

## Hardened before release

Every module was put through an adversarial bug-hunt that tried to break the two
core invariants (byte-exact forwarding; the observer never throws), with an
independent verifier reproducing each finding before it counted: **26 candidates
investigated, 17 fixed with reproducing tests, 9 refuted.** By impact, that's
**1 wire-integrity fix** (an SSE stream that could be corrupted when an upstream
died mid-response), **3 correctness/observer-fidelity fixes**, and **13
robustness/crash-prevention fixes**. The 17 reproducing tests ship as permanent
regression guards (94 tests total). Four accepted-risk items are documented in
[KNOWN-ISSUES.md](./KNOWN-ISSUES.md).

## Install

```bash
npm install -g mcpgaze     # or: npx mcpgaze wrap -- your-server
```

The Rust `--native` proxy is optional. Prebuilt binaries for common platforms
are attached to this release; otherwise `cd native/mcpgaze-proxy && cargo build --release`.

## Quick start

```bash
# Watch a stdio server's traffic live
mcpgaze wrap --tui -- node my-mcp-server.js

# Baseline its tool schemas, then fail CI on drift
mcpgaze snapshot --out mcpgaze.baseline.json -- node my-mcp-server.js
mcpgaze diff --baseline mcpgaze.baseline.json --fail-on breaking -- node my-mcp-server.js
```

See the [README](./README.md) for the full command reference and the
[CHANGELOG](./CHANGELOG.md) for details.
