# mcpgaze documentation

Start here, then go deep.

| Doc | What you'll find |
|---|---|
| [Getting Started](./getting-started.md) | Install from source, set up a `mcpgaze` alias, wire it into Claude Desktop / Cursor, and read your first session log. |
| [Command Reference](./commands.md) | The authoritative reference — every command, every flag, exit codes, and environment variables. |
| [CI Recipes](./ci.md) | Copy-paste GitHub Actions for schema-drift gating, conformance, behavioral drift, and liveness probes. |
| [Architecture](./architecture.md) | The two core invariants, the framing/forwarding design, the Node ⇄ Rust split, and a module map. |
| [Session Log Format](./session-log.md) | The `.jsonl` event schema, so you can build dashboards and tooling on top of `mcpgaze`. |

See also, at the repo root:

- [README](../README.md) — overview and quickstart
- [SECURITY.md](../SECURITY.md) — threat model, data-at-rest, credential scoping, and how to report a vulnerability
- [KNOWN-ISSUES.md](../KNOWN-ISSUES.md) — accepted, documented limitations for v1.0
- [CONTRIBUTING.md](../CONTRIBUTING.md) — dev loop, the invariant rules, and test gates
- [CHANGELOG.md](../CHANGELOG.md) — release history

## A 60-second mental model

`mcpgaze` does one thing and builds everything on it: **it forwards the MCP wire byte-for-byte while observing a copy on a side channel.** From that single primitive come two families of command:

- **Live** — `wrap`, `wrap-http`, `record`, `replay`, `health`, `triage`: watch, capture, and diagnose a running server.
- **Contract** — `snapshot`, `diff`, `conform`, `verify`, `preflight`: lock the server's behavior down and fail CI when it changes.

Two invariants make this safe to leave in your protocol path:

- **(A) Wire integrity** — bytes in == bytes out.
- **(B) Observer safety** — the logging path never throws into the wire.

Read [Architecture](./architecture.md) for how both are held and tested.
