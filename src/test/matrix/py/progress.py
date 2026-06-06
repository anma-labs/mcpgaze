#!/usr/bin/env python3
"""MCP progress matrix cell server (feature=progress, language=py, transport=stdio).

Feature under test: PROGRESS NOTIFICATIONS DURING A TOOL CALL.

When a tools/call arrives carrying params._meta.progressToken, the tool handler
emits several notifications/progress messages (progress increasing toward total)
before it returns its final result.

How this is wired:
  FastMCP populates ctx.request_context.meta.progressToken from the inbound
  request's params._meta.progressToken. ctx.report_progress(progress, total,
  message) then turns into a server->client notifications/progress message:
      {"jsonrpc":"2.0","method":"notifications/progress",
       "params":{"progressToken":<token>,"progress":<n>,"total":<t>,"message":...}}
  If NO progressToken was supplied, report_progress is a no-op (per spec: the
  server must not send progress for a token the client didn't ask for).

Exposes:
  - 1 progress tool:  long_task  (emits 4 progress notifications, then returns)
  - 1 plain tool:     echo       (no progress; keeps a trivial tool available)

Expected behavior against mcpgaze:
  initialize + tools/list succeed (snapshot lists 2 tools, conform --all PASSES,
  health --once is UP). When record/wrap drive a tools/call with
  params._meta.progressToken set, the captured session log / cassette MUST
  contain the notifications/progress messages, well-formed, with the matching
  progressToken and monotonically increasing progress values. If mcpgaze drops
  or garbles those notifications, that is a real mcpgaze bug.

Built on the real Python MCP SDK (FastMCP).
"""

import anyio
from mcp.server.fastmcp import Context, FastMCP

mcp = FastMCP("mcpgaze-progress-py")

# Number of progress steps emitted by long_task before it returns.
STEPS = 4


# --- Progress tool: emits several progress notifications before returning ---
@mcp.tool(
    name="long_task",
    title="Run a long task with progress",
    description=(
        "Run a multi-step task that emits notifications/progress updates "
        "(progress increasing toward a total) while it works, then returns a "
        "completion string. Progress is only emitted when the caller supplies "
        "params._meta.progressToken."
    ),
)
async def long_task(label: str, ctx: Context) -> str:
    """Emit STEPS progress notifications (1..STEPS of STEPS), then finish.

    report_progress is a no-op unless the inbound request carried a
    progressToken, so this tool is safe to call without one as well.
    """
    for step in range(1, STEPS + 1):
        await ctx.report_progress(
            progress=step,
            total=STEPS,
            message=f"{label}: step {step}/{STEPS}",
        )
        # Tiny yield so the notifications are flushed as distinct wire frames
        # rather than coalesced; keeps the run fast for the smoke test.
        await anyio.sleep(0.01)
    return f"{label}: completed {STEPS}/{STEPS} steps"


# --- Plain tool (no progress) ---------------------------------------------
@mcp.tool()
def echo(message: str) -> str:
    """Echo back the provided message (no progress involved)."""
    return f"echo: {message}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
