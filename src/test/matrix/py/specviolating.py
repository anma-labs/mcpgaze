#!/usr/bin/env python3
"""DELIBERATELY SPEC-VIOLATING MCP server (feature=specviolating, language=py, transport=stdio).

This is the NEGATIVE matrix cell. It is hand-rolled raw newline-delimited
JSON-RPC over stdio -- it does NOT use the MCP SDK, precisely so it is free to
break the spec. The point is to confirm mcpgaze DETECTS and REPORTS the
violations (conform --> passed:false) without crashing or hanging the harness.

Intentional REQUIRED-rule violations:
  1. initialize result OMITS serverInfo.name entirely (no serverInfo object).
     -> conform check `init.serverInfo` MUST fail.
  2. tools/list returns an array of tool objects that LACK a `name` field.
     -> conform check `tools.names` MUST fail (tools.list still passes: it IS an array).
  3. ANY unknown method returns a RESULT instead of a JSON-RPC error.
     -> conform check `error.unknownMethod` MUST fail (it got a result, not -32601).

Deliberately KEPT well-behaved (so the harness can read us and so the failures
above are clean/isolated rather than the server just looking dead):
  - initialize DOES return a protocolVersion (init.result / init.protocolVersion pass).
  - tools/list IS a JSON array (tools.list passes).
  - every line of output is valid newline-delimited JSON with the right id, so
    mcpgaze never hangs waiting for a reply and never sees a parse crash.
  - notifications (messages without an id) get no reply, per spec.
"""

import json
import sys

# Pin a real protocol version so init.result / init.protocolVersion pass and the
# ONLY required failures are the three deliberate ones.
PROTOCOL_VERSION = "2025-06-18"


def send(obj):
    """Write one JSON object as a single newline-terminated line, then flush.

    Flushing every message is what guarantees mcpgaze's request->wait loop never
    blocks on a buffered-but-unsent reply (invariant B: never hang the wire)."""
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle(msg):
    """Return a response object for a request, or None for a notification/no-reply."""
    mid = msg.get("id")
    method = msg.get("method")

    # Notifications have no id -> per spec, never reply. (notifications/initialized etc.)
    if mid is None:
        return None

    if method == "initialize":
        # VIOLATION #1: omit serverInfo entirely (no serverInfo.name).
        # We still return protocolVersion + capabilities so the OTHER required
        # init checks pass and the failure is isolated to init.serverInfo.
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                # serverInfo deliberately ABSENT
            },
        }

    if method == "tools/list":
        # VIOLATION #2: tools IS an array (so tools.list passes) but each tool
        # object LACKS the REQUIRED `name` field.
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": {
                "tools": [
                    {
                        # no "name" key on purpose
                        "title": "Nameless Tool A",
                        "description": "A tool intentionally missing its name.",
                        "inputSchema": {"type": "object", "properties": {}},
                    },
                    {
                        # no "name" key on purpose
                        "title": "Nameless Tool B",
                        "description": "Another tool intentionally missing its name.",
                        "inputSchema": {"type": "object", "properties": {}},
                    },
                ]
            },
        }

    if method == "tools/call":
        # Be lenient so nothing downstream hangs: return an empty-ish result.
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": {"content": [{"type": "text", "text": "spec-violating server"}]},
        }

    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}

    # VIOLATION #3: for ANY unknown method (including mcpgaze's conformance probe
    # `mcpgaze/definitely-not-a-method`), return a RESULT instead of a JSON-RPC
    # error. Spec REQUIRES -32601 "Method not found"; we knowingly do not.
    return {
        "jsonrpc": "2.0",
        "id": mid,
        "result": {"ignored": True, "method": method},
    }


def main():
    # Line-buffered read of stdin; one JSON-RPC object per line.
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except (ValueError, TypeError):
            # Malformed input from the client: stay quiet rather than emit junk
            # that could confuse/crash the reader. (We are violating REQUIRED
            # response rules on purpose, but we never produce non-JSON output.)
            continue
        if not isinstance(msg, dict):
            continue
        try:
            resp = handle(msg)
        except Exception as exc:  # never let a handler bug kill the loop
            mid = msg.get("id") if isinstance(msg, dict) else None
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "result": {"error_caught": str(exc)}})
            continue
        if resp is not None:
            send(resp)


if __name__ == "__main__":
    main()
