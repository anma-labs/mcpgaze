#!/usr/bin/env python3
"""MCP sampling matrix cell server (feature=sampling, language=py, transport=stdio).

Feature under test: SERVER-INITIATED SAMPLING.
A tool handler turns around and asks the CLIENT to sample an LLM via the
sampling/createMessage server->client request (ctx.session.create_message).

Exposes:
  - 1 sampling tool:  ask_llm   (handler calls ctx.session.create_message(...))
  - 1 plain tool:     echo      (no sampling; keeps a trivial tool available)

Notes on expected behavior against mcpgaze:
  mcpgaze acts as a MINIMAL client during snapshot/conform/health: it advertises
  no sampling capability and does NOT answer sampling/createMessage requests.
  Therefore initialize + tools/list MUST still succeed (snapshot lists 2 tools,
  conform --all PASSES, health --once is UP). Calling `ask_llm` will block on a
  client response that never comes, so that tools/call is expected to err/time
  out at the server side -- the key assertion is mcpgaze must NOT crash.

Built on the real Python MCP SDK (FastMCP).
"""

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import SamplingMessage, TextContent

mcp = FastMCP("mcpgaze-sampling-py")


# --- Sampling tool: handler asks the CLIENT to sample an LLM ---------------
@mcp.tool(
    name="ask_llm",
    title="Ask the client's LLM",
    description=(
        "Ask the connected MCP client to sample its LLM with a prompt and "
        "return the model's text. This triggers a server-initiated "
        "sampling/createMessage request."
    ),
)
async def ask_llm(prompt: str, ctx: Context) -> str:
    """Server-initiated sampling: round-trip a prompt through the client's LLM."""
    result = await ctx.session.create_message(
        messages=[
            SamplingMessage(
                role="user",
                content=TextContent(type="text", text=prompt),
            )
        ],
        max_tokens=256,
        system_prompt="You are a helpful assistant invoked via MCP sampling.",
        temperature=0.7,
    )
    content = result.content
    if isinstance(content, TextContent):
        return content.text
    return str(content)


# --- Plain tool (no sampling) ---------------------------------------------
@mcp.tool()
def echo(message: str) -> str:
    """Echo back the provided message (no sampling involved)."""
    return f"echo: {message}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
