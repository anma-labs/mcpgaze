#!/usr/bin/env python3
"""MCP pagination matrix cell server (feature=pagination, language=py, transport=stdio).

Feature under test: tools/list PAGINATION via nextCursor.

Exposes EXACTLY 25 tools served in PAGES OF 10 (page sizes: 10, 10, 5) through
the tools/list nextCursor mechanism. The high-level FastMCP / McpServer APIs
auto-return ALL tools in a single page, so this server is built on the
LOW-LEVEL Server API where we own the ListToolsRequest handler and can slice
the tool list by an opaque cursor and emit a nextCursor for every non-final
page.

Cursor encoding: the cursor is the integer start offset of the page, encoded as
a decimal string (e.g. "10", "20"). An absent/empty cursor means "start at 0".

Expected behavior against mcpgaze:
  mcpgaze probe FOLLOWS nextCursor, so a snapshot MUST collect ALL 25 tools
  across the three pages (10 + 10 + 5), not just the first page of 10.
  initialize + tools/list succeed; conform --all PASSES. If snapshot returns
  only the first 10 tools, that is a real mcpgaze pagination bug.

Built on the real Python MCP SDK (mcp.server.lowlevel.Server).
"""

import anyio
import mcp.types as types
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server

# --- Tool catalog: exactly 25 tools ---------------------------------------
TOTAL_TOOLS = 25
PAGE_SIZE = 10

ALL_TOOLS: list[types.Tool] = [
    types.Tool(
        name=f"tool_{i:02d}",
        title=f"Tool {i:02d}",
        description=f"Paginated demo tool number {i} (1 of {TOTAL_TOOLS}).",
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
    for i in range(1, TOTAL_TOOLS + 1)
]

server = Server("mcpgaze-pagination-py")


def _decode_cursor(cursor: str | None) -> int:
    """Decode an opaque cursor into a start offset; None/empty -> 0."""
    if not cursor:
        return 0
    try:
        offset = int(cursor)
    except (TypeError, ValueError):
        # Unknown/garbage cursor -> start from the beginning rather than crash.
        return 0
    if offset < 0:
        return 0
    return offset


@server.list_tools()
async def list_tools(req: types.ListToolsRequest) -> types.ListToolsResult:
    """Return one page of tools plus a nextCursor when more pages remain."""
    cursor = req.params.cursor if req.params is not None else None
    start = _decode_cursor(cursor)

    # If the cursor is past the end, return an empty final page.
    if start >= TOTAL_TOOLS:
        return types.ListToolsResult(tools=[], nextCursor=None)

    end = min(start + PAGE_SIZE, TOTAL_TOOLS)
    page = ALL_TOOLS[start:end]

    next_cursor: str | None = str(end) if end < TOTAL_TOOLS else None
    return types.ListToolsResult(tools=page, nextCursor=next_cursor)


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.ContentBlock]:
    """Trivial echo handler so the advertised tools are actually callable."""
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
                server_name="mcpgaze-pagination-py",
                server_version="1.0.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )


if __name__ == "__main__":
    anyio.run(main)
