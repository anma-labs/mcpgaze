# Contributing to mcpgaze

Thanks for considering a contribution. `mcpgaze` lives in your MCP protocol path, so the bar for changes is "does this preserve the two invariants?" — read [§ The invariant rules](#the-invariant-rules) before touching anything in the forward/observe path.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Quick links

- Architecture & the two invariants → [docs/architecture.md](./docs/architecture.md)
- Command reference → [docs/commands.md](./docs/commands.md)
- Security model → [SECURITY.md](./SECURITY.md)
- Accepted limitations → [KNOWN-ISSUES.md](./KNOWN-ISSUES.md)

## Prerequisites

- **Node.js ≥ 18**
- **Rust toolchain** (`cargo`) — only if you touch the `--native` proxy or run the differential oracle

## Dev loop

```bash
npm install            # dev/build deps only (mcpgaze ships zero runtime deps)
npm run dev -- --help  # run the CLI from source via tsx (no build step)
npm run typecheck      # tsc --noEmit
npm test               # full test suite
npm run test:fuzz      # the property/fuzz invariant hunt
npm run build          # tsup → dist/
```

For changes that touch the proxy/framer/observer, also run the generative gates:

```bash
# builds, then runs the differential oracle (needs cargo), wire-integrity, and dogfood
npm run harden
```

If you changed the Rust proxy:

```bash
cd native/mcpgaze-proxy
cargo fmt           # CI runs `cargo fmt --check`
cargo build --release
```

## The invariant rules

Every change to the forward/observe path **must** preserve both invariants. CI enforces them, but you should reason about them too:

- **(A) Wire integrity — bytes in == bytes out.** Never reconstruct a message from its parse and write it back to the wire. The observer works on *copies*. Anything you add (classification, redaction, metrics) happens on the side channel, never between the two streams.
- **(B) Observer safety — never throw into the wire.** Observer code must be total: cap recursion and line length, and wrap fallible work so a throw degrades a log line instead of crashing the session. New parsing/redaction must be `try`-guarded with a safe fallback.

If a change *could* affect either invariant, it needs a **reproducing test** that would fail without your change. We keep one adversarial regression test per known defect in `src/test/adv-*.test.ts` — follow that pattern.

When you find a real defect that does **not** break (A) or (B), it may be a documented-acceptable limitation rather than a fix; discuss it and, if accepted, add it to [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) with the invariant-framing.

## Code style

- **Zero runtime dependencies.** Nothing may be added to `dependencies` in `package.json`. Build/test tooling goes in `devDependencies` and must not be imported by shipped code. The TUI is hand-drawn ANSI; the AI call is plain `fetch`; the Rust proxy is `std`-only — keep it that way.
- **Match the surrounding code** — naming, comment density, and idiom. The codebase favors small, pure, testable functions and explicit data (`conform.ts`'s check catalog is the model).
- **TypeScript** is `strict`; `npm run typecheck` must be clean.
- **Comments explain *why*,** especially around the invariants and any deliberate trade-off.

## Tests

- Add or update tests for any behavior change. Pure logic (diffing, classification, shape extraction, redaction) should have direct unit tests.
- Invariant-affecting changes need a generative or adversarial test, not just an example.
- Integration tests that need a real SDK server are **guarded** so the suite still runs without network/SDK; mirror that pattern (see `src/test/integration-*.test.ts`).
- Run `npm test` (and `npm run harden` for proxy changes) before opening a PR.

### Adding a conformance check

`conform.ts` exposes a pure-data `CHECKS` catalog. To add one: append a `Check` with an `id`, `title`, `level` (`required` | `recommended`), and a `run(ctx)` that returns `pass`/`fail`/`warn`. Required checks gate CI, so reserve `required` for genuine spec violations; prefer `recommended` (warn) for best-practice nudges. Add a unit test exercising the new check.

## Commits & pull requests

- Use clear, conventional-ish commit subjects (`fix:`, `feat:`, `docs:`, `test:`, …) — match the existing `git log`.
- Keep PRs focused; describe the change, the invariant impact (if any), and how you tested it.
- Update the docs you touch ([docs/commands.md](./docs/commands.md) for flags, [CHANGELOG.md](./CHANGELOG.md) under `[Unreleased]`, [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) for accepted limitations).
- CI must be green: typecheck + tests on Node 18/20/22, the Rust build (`cargo fmt --check`), and the hardening workflows.

## Reporting bugs & requesting features

Open an issue using the templates. For **security** issues, do **not** open a public issue — follow [SECURITY.md](./SECURITY.md).

A great bug report includes: the command you ran, what you expected, what happened, the relevant slice of the session log (`raw` lines are authoritative — redact secrets first), and your Node/OS versions.
