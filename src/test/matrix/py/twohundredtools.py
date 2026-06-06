#!/usr/bin/env python3
"""MCP 200-tool scale matrix cell server (feature=twohundredtools, language=py, transport=stdio).

Feature under test: a large tool SURFACE (scale).

Registers EXACTLY 200 distinct tools named tool_000 .. tool_199 via a loop. Each
tool has:
  - a small object inputSchema with one string arg ("value"),
  - a human-readable description.

The whole catalog is returned in a SINGLE tools/list page (no nextCursor): this
cell tests whether mcpgaze can capture/diff/health-check a large flat surface,
NOT pagination. Built on the LOW-LEVEL Server API so the 200 tools are built in
a loop and returned verbatim from one ListToolsRequest handler.

Expected behavior against mcpgaze:
  snapshot MUST capture all 200 tools; conform --all PASSES; diff vs the
  200-tool baseline reports NO drift; health --once is UP and reports 200 tools.
  If snapshot/diff truncate, choke, or miscount, that is a real mcpgaze bug.

Built on the real Python MCP SDK (mcp.server.lowlevel.Server).
"""

import anyio
import mcp.types as types
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server

# --- Tool catalog: exactly 200 tools, built in a loop ---------------------
TOTAL_TOOLS = 200

ALL_TOOLS: list[types.Tool] = [
    types.Tool(
        name=f"tool_{i:03d}",
        title=f"Tool {i:03d}",
        description=(
            f"Scale-test tool number {i} of {TOTAL_TOOLS}. "
            f"Echoes its 'value' argument back as text."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "value": {
                    "type": "string",
                    "description": "Arbitrary string echoed back by this tool.",
                }
            },
            "required": [],
        },
    )
    for i in range(TOTAL_TOOLS)
]

# Fast lookup so call_tool can validate the requested name.
_TOOL_NAMES = {t.name for t in ALL_TOOLS}

server = Server("mcpgaze-twohundredtools-py")


@server.list_tools()
async def list_tools(req: types.ListToolsRequest) -> types.ListToolsResult:
    """Return ALL 200 tools in one page (no pagination)."""
    return types.ListToolsResult(tools=ALL_TOOLS, nextCursor=None)


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.ContentBlock]:
    """Trivial echo handler so every advertised tool is actually callable."""
    if name not in _TOOL_NAMES:
        raise ValueError(f"Unknown tool: {name}")
    value = ""
    if isinstance(arguments, dict):
        value = str(arguments.get("value", ""))
    return [types.TextContent(type="text", text=f"{name}: {value}")]


async def main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="mcpgaze-twohundredtools-py",
                server_version="1.0.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )


if __name__ == "__main__":
    anyio.run(main)
