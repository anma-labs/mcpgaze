#!/usr/bin/env python3
"""MCP prompts matrix cell server (feature=prompts, language=py, transport=stdio).

Exposes:
  - 2 prompts:
      * code_review   (takes arguments: code, language) -> multi-message prompt
      * summarize     (no required args) -> single-message prompt
  - 1 tool:
      * echo          (so tools/list is non-empty)

Built on the real Python MCP SDK (FastMCP).
"""

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.prompts import base

mcp = FastMCP("mcpgaze-prompts-py")


# --- Prompt #1: takes arguments -------------------------------------------
@mcp.prompt(
    name="code_review",
    title="Code Review",
    description="Generate a review prompt for a snippet of code.",
)
def code_review(code: str, language: str = "python") -> list[base.Message]:
    """Produce a multi-turn prompt asking for a code review."""
    return [
        base.UserMessage(
            f"Please review the following {language} code for bugs, "
            f"style issues, and possible improvements:"
        ),
        base.UserMessage(f"```{language}\n{code}\n```"),
        base.AssistantMessage(
            "Sure! Here is my review of the code you provided:"
        ),
    ]


# --- Prompt #2: no required arguments -------------------------------------
@mcp.prompt(
    name="summarize",
    title="Summarize Text",
    description="Ask the assistant to summarize the given text.",
)
def summarize(text: str = "") -> str:
    """Single-message prompt requesting a concise summary."""
    return f"Summarize the following text in one paragraph:\n\n{text}"


# --- Tool (keeps tools/list non-empty) ------------------------------------
@mcp.tool()
def echo(message: str) -> str:
    """Echo back the provided message."""
    return f"echo: {message}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
