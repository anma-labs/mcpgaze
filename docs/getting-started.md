# Getting Started

This guide takes you from a clone to a live wiretap in a few minutes.

## Requirements

- **Node.js ≥ 18** (`node --version`)
- Optional, only for `--native`: a **Rust toolchain** (`cargo`) — [rustup.rs](https://rustup.rs)

`mcpgaze` has **zero runtime dependencies**; the only install step is building the TypeScript to `dist/`.

## Install from source

`mcpgaze` isn't published to npm yet, so build it from source:

```bash
git clone https://github.com/anma-labs/mcpgaze
cd mcpgaze
npm install      # dev/build deps only — nothing ships in dist/
npm run build    # tsup → dist/index.js
node dist/index.js --help
```

### Make a `mcpgaze` command

So the rest of the docs read naturally, alias the built entrypoint:

```bash
# bash/zsh — add to ~/.bashrc or ~/.zshrc
alias mcpgaze='node /abs/path/to/mcpgaze/dist/index.js'
```

```fish
# fish
alias --save mcpgaze='node /abs/path/to/mcpgaze/dist/index.js'
```

Now `mcpgaze --help` works anywhere. (Once the package is published, `npm i -g mcpgaze` will install a real `mcpgaze` binary and you can drop the alias.)

> **In client configs**, prefer the full, absolute invocation — GUI clients don't load your shell aliases. Use `"command": "node", "args": ["/abs/.../dist/index.js", "wrap", "--", ...]`.

## Your first wiretap

Point `wrap` at any stdio MCP server. The `--` separates `mcpgaze`'s flags from the command it runs:

```bash
mcpgaze wrap --print -- node my-server.js
```

You'll see a pretty, color-coded stream on stderr — requests, responses (with latency matched by id), notifications, and the server's own stderr — while a machine-readable copy lands in `.mcpgaze/session-<timestamp>.jsonl`.

Prefer a dashboard? Use the full-screen TUI (needs a real terminal; falls back to plain logging without a TTY):

```bash
mcpgaze wrap --tui -- node my-server.js
```

### Read the log

The session log is newline-delimited JSON — one event per line. A quick look with `jq`:

```bash
# every error response
jq 'select(.type=="message" and .kind=="error")' .mcpgaze/session-*.jsonl

# slowest requests
jq -c 'select(.latencyMs) | {method, latencyMs}' .mcpgaze/session-*.jsonl | sort -t: -k2 -n | tail

# everything the server printed to stderr
jq -r 'select(.type=="server_stderr") | .text' .mcpgaze/session-*.jsonl
```

The full event schema is documented in [Session Log Format](./session-log.md).

## Wire it into a real client

The whole point of `mcpgaze` is to watch your **real** client drive the server. Wrap the server command in the client's config.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": [
        "/abs/path/to/mcpgaze/dist/index.js",
        "wrap",
        "--log", "/abs/path/to/logs/my-server.jsonl",
        "--",
        "node", "/abs/path/to/my-server.js"
      ]
    }
  }
}
```

Restart Claude Desktop, use the server normally, then tail the log:

```bash
tail -f /abs/path/to/logs/my-server.jsonl | jq -c '{type, kind, method, latencyMs}'
```

### Cursor / other clients

The pattern is identical: wherever the client specifies `command` + `args` for an MCP server, set `command` to `node` and prepend `dist/index.js wrap --` before the real server command. Anything that runs an MCP server over stdio can be wrapped.

### Remote / HTTP servers

For Streamable HTTP servers, run the proxy in front of the upstream and point your client at the proxy:

```bash
mcpgaze wrap-http --upstream http://localhost:3000/mcp --port 7000
# client → http://127.0.0.1:7000/mcp
```

See the [`wrap-http` reference](./commands.md#wrap-http).

## Lock the contract (CI)

Once you can see what your server does, stop it from silently changing:

```bash
# 1. Baseline the tool schemas and commit the result
mcpgaze snapshot -- node my-server.js
git add mcpgaze.baseline.json

# 2. In CI, fail the build on a breaking change
mcpgaze diff --fail-on-drift -- node my-server.js
```

Ready-to-paste workflows are in [CI Recipes](./ci.md).

## Where to go next

- **[Command Reference](./commands.md)** — every flag and exit code.
- **[CI Recipes](./ci.md)** — drift gating, conformance, and liveness as GitHub Actions.
- **[Architecture](./architecture.md)** — why this is safe to leave in your protocol path.
- **[Security](../SECURITY.md)** — what's written to disk, what gets redacted, and credential scoping for `wrap-http`.
