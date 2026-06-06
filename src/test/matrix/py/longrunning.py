#!/usr/bin/env python3
"""MCP long-running matrix cell server (feature=longrunning, language=py, transport=stdio).

Feature under test: LONG-RUNNING OPERATION (a slow tool).

The `slow_task` tool awaits ~7 seconds (anyio.sleep) before returning its
result. Because the sleep is an `await` on the async event loop -- not a
blocking `time.sleep` -- the FastMCP session loop stays free to process other
inbound traffic. In particular, `initialize` and `tools/list` are answered
immediately and are NOT blocked behind the slow tool call. This exercises
mcpgaze's ability to keep request/response correlation across a slow reply
without dropping the request->response pair.

Exposes:
  - 1 slow tool:  slow_task  (awaits ~7s, then returns a completion string)
  - 1 plain tool: echo       (returns instantly; keeps a fast tool available)

Expected behavior against mcpgaze:
  initialize + tools/list succeed and are FAST (snapshot lists 2 tools,
  conform PASSES, health --once is UP -- none of these touch the slow tool).
  When a tools/call to slow_task is driven through (driver timeout 12s, sleep
  ~7s) the call MUST COMPLETE and the captured cassette/session log MUST
  contain the slow tool-call request paired with its matching response id. If
  mcpgaze drops or mis-correlates the slow pair, that is a real mcpgaze bug.

Built on the real Python MCP SDK (FastMCP).
"""

import anyio
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("mcpgaze-longrunning-py")

# Seconds the slow tool awaits before returning. Chosen ~7s: comfortably above
# a "fast" threshold yet well under the 12s driver timeout so the call lands.
SLEEP_SECONDS = 7.0


# --- Slow tool: awaits ~7s, then returns ----------------------------------
@mcp.tool(
    name="slow_task",
    title="Run a slow (long-running) task",
    description=(
        "Simulate a long-running operation: await roughly 7 seconds, then "
        "return a completion string. The await is non-blocking, so initialize "
        "and tools/list are answered immediately and are never blocked behind "
        "this call."
    ),
)
async def slow_task(label: str = "task") -> str:
    """Await SLEEP_SECONDS, then return a completion string.

    Uses anyio.sleep (an async await) rather than time.sleep so the session
    event loop remains free to service initialize / tools/list / other calls
    concurrently while this coroutine is suspended.
    """
    await anyio.sleep(SLEEP_SECONDS)
    return f"{label}: completed after {SLEEP_SECONDS:g}s"


# --- Plain tool (instant; keeps a fast tool available) --------------------
@mcp.tool()
def echo(message: str) -> str:
    """Echo back the provided message instantly (no delay)."""
    return f"echo: {message}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
