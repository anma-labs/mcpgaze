# CI Recipes

`mcpgaze` is built to fail your build the moment an MCP server's contract changes. These are drop-in recipes; adapt the server command and paths to your project.

Throughout, `mcpgaze` is invoked as `node dist/index.js` because the package isn't on npm yet. Once it is, replace that with `npx mcpgaze`.

## The core idea

Three things can silently break an MCP server's consumers:

1. **Schema drift** — a tool's *declared* input schema changes → [`diff`](./commands.md#diff)
2. **Behavioral drift** — responses change shape while the schema stays put → [`verify`](./commands.md#verify)
3. **Spec regressions** — the server stops meeting the MCP spec → [`conform`](./commands.md#conform)

Each exits non-zero when it finds a problem, so each is a CI gate.

## Schema-drift gate (recommended baseline)

Commit a baseline (`mcpgaze snapshot -- <server>` → `mcpgaze.baseline.json`), then enforce it.

```yaml
# .github/workflows/mcp-contract.yml
name: MCP contract
on: [push, pull_request]

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }

      # Build mcpgaze (skip once it's published: use `npx mcpgaze` instead)
      - run: npm ci && npm run build
        working-directory: tools/mcpgaze   # wherever you vendor it

      # Install YOUR server's deps, then gate on schema drift
      - run: npm ci
      - run: node tools/mcpgaze/dist/index.js diff --fail-on-drift -- node server.js
```

- `--fail-on-drift` fails only on **breaking** changes (property removed, new required, type change, enum value removed, optional→required).
- Use `--fail-on warning` to also catch required→optional, or `--fail-on any` for additive changes too.
- When a change is intentional, run `mcpgaze diff --update -- node server.js` locally and commit the new baseline.

## Spec-conformance gate

Verify the server still satisfies the MCP spec — across versions if you support more than one.

```yaml
  conform:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: node tools/mcpgaze/dist/index.js conform --all -- node server.js
```

`conform` exits `1` if any **required** check fails for any tested version. Drop `--all` to test only the default version, or use `--spec 2025-11-25` to pin one. Add `--json | jq` if you want to publish a report artifact.

## Behavioral-drift gate

Catch response-shape regressions a schema diff can't see. Commit a cassette (`mcpgaze record --cassette fixtures/smoke.cassette.json -- <server>`), then re-verify it.

```yaml
  behavior:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: >
          node tools/mcpgaze/dist/index.js verify
          --cassette fixtures/smoke.cassette.json
          --fail-on warning
          -- node server.js
```

> `verify` **re-executes** the recorded requests. By default it skips state-changing methods; only add `--allow-tool-calls` against a disposable/ephemeral server. Treat committed cassettes as untrusted input — see [SECURITY.md](../SECURITY.md#cassettes-are-untrusted-input).

## Liveness probe (cron / uptime)

`health --once` is a clean liveness check: exit `0` if the server is up, `1` if it's down.

```yaml
# .github/workflows/mcp-liveness.yml
name: MCP liveness
on:
  schedule: [{ cron: "*/15 * * * *" }]   # every 15 minutes
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: node tools/mcpgaze/dist/index.js health --once -- node server.js
```

Locally or on a box you control, the daemon form tracks history and prints transitions:

```bash
mcpgaze health --interval 30 -- node server.js   # status → .mcpgaze/health.json
```

## Pre-commit hook

Catch drift before it's even pushed:

```bash
# .git/hooks/pre-commit  (chmod +x)
#!/usr/bin/env bash
node /abs/path/to/mcpgaze/dist/index.js diff --fail-on-drift -- node server.js || {
  echo "✗ tool-schema drift — run 'mcpgaze diff --update' if intentional, then re-commit."
  exit 1
}
```

## Tips

- **Vendor vs. install.** Until `mcpgaze` is on npm, either add it as a git submodule / vendored `tools/mcpgaze`, or build it in a prior CI step. Once published, `npx mcpgaze@<version>` pins a version with no build step.
- **Pin protocol versions** you actually support with `conform --spec <ver>` so a new RC doesn't surprise your gate.
- **Artifacts.** Pipe `--json` output (`conform`, or parse `diff` output) into a job artifact for a historical record.
- **Exit codes** are the contract — see the [exit-code table](./commands.md#exit-codes).
