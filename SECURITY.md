# Security Policy

`mcpgaze` sits in your MCP protocol path and persists a record of the traffic it sees, so its security posture is a first-class concern. This document covers what it does with your data, the threat model, and how to report a vulnerability.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's **[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)** — on the repository, go to **Security → Report a vulnerability**. Include a description, affected version/commit, reproduction steps (a self-contained script is ideal), and impact.

We aim to acknowledge within a few days, confirm or refute, and coordinate a fix and disclosure timeline with you. Good-faith research is welcome.

## Supported versions

| Version | Supported |
|---|---|
| `1.0.x` | ✅ |
| `< 1.0` | — |

## Design guarantees (the two invariants)

`mcpgaze`'s safety rests on two invariants, enforced by generative tests on every push:

- **(A) Wire integrity** — on the forward path, bytes in == bytes out. Redaction, classification, and every other transform touch only *copies*; they never alter the forwarded protocol stream.
- **(B) Observer safety** — the observation/logging path never throws into the wire. Adversarial input degrades a log line, never your session.

A corollary worth stating plainly: **redaction is never applied to the forwarded stream.** It only ever masks on-disk artifacts and outbound triage egress. A wiretap that altered the bytes it forwards would be worse than useless.

## What gets written to disk, and where

| Artifact | Written by | Default path | Mode | Redaction |
|---|---|---|---|---|
| Session log (JSONL) | `wrap`, `wrap-http`, `record` | `.mcpgaze/session-<ts>.jsonl` | `0600` | **off** by default; `--redact` masks at rest |
| Cassette | `record` | `mcpgaze.cassette.json` | `0600` | **on** by default; `--no-redact` captures verbatim |
| Health status | `health` | `.mcpgaze/health.json` | default | n/a (tool names + a schema hash, no payloads) |

Notes:

- `.mcpgaze/` is git-ignored by default; `mcpgaze.cassette.json` and `*.cassette.json` are git-ignored by default.
- The session log can contain JSON-RPC **params/results and verbatim server stderr** — which may carry secrets. That's intentional for a live debug view, which is why the file is owner-only (`0600`). If you tee a session into a file you intend to share, pass `--redact`.
- The transport `Authorization` HTTP header is **not** logged in `wrap-http` (only the JSON-RPC body is observed). Bearer tokens appear in the log only if they're inside params/results or printed to stderr.

## Redaction

When redaction is active, a conservative, dependency-free, **fail-safe** masker (`src/redact.ts`) runs over observer artifacts and triage egress — never the wire. It:

- masks the **values of credential-named keys** (`password`, `secret`, `api_key`, `token`, `authorization`, `cookie`, `session`, `credential`, `private_key`, …), and
- masks **secret-shaped values** in free text: `user:pass@host` DSN passwords, `sk-…`/`sk-ant-…` provider keys, AWS `AKIA…` ids, GitHub/Slack prefixed tokens, `Bearer …`, and JWT-shaped blobs.

It is intentionally conservative — it can miss a bespoke secret format — and is **opt-in for at-rest artifacts** (`--redact`, except `record` which is on by default) and **always-on for triage egress**. Always review a cassette or a log before sharing it.

## `triage --ai` egress

`triage --ai` POSTs failure context to `https://api.anthropic.com/v1/messages`. It is gated so this never happens silently:

1. Requires both the `--ai` flag **and** `ANTHROPIC_API_KEY` in the environment.
2. **Always** redacts secret-shaped tokens at the egress boundary.
3. Requires explicit consent — `--yes`, or a `y` at an interactive preview that shows the exact bytes. In a non-interactive context without `--yes`, nothing is sent.

The destination is fixed to Anthropic (no attacker-controllable URL), and the API key is read from the environment, never from log content. Be mindful that *redacted* failure context still derives from your session.

## Credential scoping in `wrap-http`

`wrap-http` binds to `127.0.0.1` only and rejects cross-origin browser requests (DNS-rebinding defense — the bug class behind the MCP Inspector's [CVE-2025-49596](https://nvd.nist.gov/vuln/detail/CVE-2025-49596), CVSS 9.4). Binding to a non-loopback `--host` prints a warning; `--allow-origin` overrides the Origin policy.

For credentials:

- **Single `--upstream`/`--route`** — there's exactly one destination, so the client's `Authorization`/`Cookie` is forwarded to it (nothing can be misrouted). Pass `--no-forward-credentials` to strip them anyway.
- **Multiple `--route`s** — a path could resolve to a different upstream than the client intended to authenticate to, so credentials are **stripped unless a route opts in** (`--creds-route <prefix>`, or `--forward-credentials` for all). On the return path, `Set-Cookie`/`Mcp-Session-Id` are likewise stripped for non-opted routes.

## Cassettes are untrusted input

A cassette is a data file that `verify`/`replay` consume. A **hostile cassette** (downloaded fixture, shared CI artifact, supply-chain) can name arbitrary methods/params. Mitigations:

- `verify` re-issues **only read-only methods** by default; state-changing methods (e.g. `tools/call`) are **skipped and reported** unless you pass `--allow-tool-calls`.
- Cassettes are shape-validated on load, and the replay/verify paths are wrapped so a malformed or pathological cassette fails cleanly (no crash into the wire, no prototype pollution).

Still: only run `verify --allow-tool-calls` against a cassette you trust, and against a disposable/read-only server.

## Security audit

`mcpgaze` v1.0.0 underwent a source-level red-team audit with reproducible proof-of-concept exploits. Result: **0 critical, 0 high, 3 medium, 2 low** — all remediated or consciously mitigated (the medium findings were secret-at-rest and triage-egress governance; the low findings were the credential-scoping and untrusted-cassette surfaces described above). Several attack classes (SSRF/DNS-rebinding via routing or redirects, cassette parser crashes, prototype pollution) were probed and found defended.

The full report, the remediation status table, and self-contained PoCs live under [`security-audit/`](./security-audit/) (`REPORT.md`, `MATRIX-REPORT.md`).

## Accepted, documented limitations

A handful of low-severity behaviors are accepted for v1.0 and documented in [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) (reused-id statistics, first-Ctrl-C shutdown latency, `wrap-http` disconnect cleanup, and the Rust classifier's parse-free residuals). None violate invariant (A) or (B).
