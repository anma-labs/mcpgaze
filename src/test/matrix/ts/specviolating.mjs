#!/usr/bin/env node
// specviolating-ts matrix cell: a DELIBERATELY spec-violating MCP server.
//
// This is hand-rolled RAW newline-delimited JSON-RPC over stdio -- it does NOT
// use @modelcontextprotocol/sdk, because the whole point is to break REQUIRED
// rules the SDK would enforce. mcpgaze's `conform` suite is expected to DETECT
// and REPORT these violations (passed:false) without crashing or hanging.
//
// Violations baked in (each maps to a REQUIRED conform check it should fail):
//   1. initialize result OMITS serverInfo.name        -> init.serverInfo: fail
//   2. tools/list returns tools that LACK a `name`     -> tools.names:     fail
//   3. an unknown method RETURNS A RESULT (not error)  -> error.unknownMethod: fail
//
// It is otherwise well-behaved on the WIRE: every request id gets exactly one
// response line, lines are single-line JSON, and it never crashes/hangs. That
// keeps mcpgaze's invariants (A: byte-exact forward, B: observer never crashes)
// intact while still tripping the conformance failures above.

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

function send(obj) {
  // One JSON object per line, newline-delimited. Single line, no embedded \n.
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  // Notifications (no id): never reply. Includes notifications/initialized.
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  const id = msg.id;

  switch (msg.method) {
    case "initialize": {
      // VIOLATION #1: serverInfo present but WITHOUT a `name` field. We keep
      // protocolVersion and a capabilities object so the ONLY init failure is
      // the missing serverInfo.name (matches the negative oracle precisely).
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            // name: deliberately omitted
            version: "0.0.0-spec-violating",
          },
        },
      });
      return;
    }

    case "tools/list": {
      // VIOLATION #2: tools is an array, but the tool objects LACK a `name`.
      // This trips tools.names (required) while tools.list (is-array) passes,
      // so the failure is the specific named-tool requirement.
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              // name: deliberately omitted
              description: "a tool with no name (spec violation)",
              inputSchema: { type: "object", properties: {} },
            },
            {
              // name: deliberately omitted
              title: "Nameless Two",
              description: "another nameless tool",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
      return;
    }

    case "resources/list": {
      send({ jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    }

    case "prompts/list": {
      send({ jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    }

    case "ping": {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    default: {
      // VIOLATION #3: an UNKNOWN method must return a JSON-RPC error
      // (-32601 method not found). Instead we return a (bogus) RESULT. This
      // trips error.unknownMethod (required). We DO still reply, so mcpgaze's
      // request never hangs -- invariant B is preserved.
      send({
        jsonrpc: "2.0",
        id,
        result: { ok: true, note: "unknown methods get a result here, on purpose" },
      });
      return;
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Ignore unparseable input rather than crash; we are violating semantics,
    // not the transport. (No id to reply to anyway.)
    return;
  }
  try {
    handle(msg);
  } catch {
    // Never let a handler throw kill the process / hang the wire.
  }
});

// When stdin closes, exit cleanly so the harness/proxy never hangs.
rl.on("close", () => process.exit(0));
