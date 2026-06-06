#!/usr/bin/env python3
"""MCP resources matrix cell server (feature=resources, language=py, transport=stdio).

Exposes:
  - 2 static resources:  config://app, info://version
  - 1 resource template: greeting://{name}
  - 1 tool:              echo  (so tools/list is non-empty)

Built on the real Python MCP SDK (FastMCP).
"""

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("mcpgaze-resources-py")


# --- Static resource #1 ---------------------------------------------------
@mcp.resource("config://app", name="app-config", mime_type="application/json")
def app_config() -> str:
    """Static application configuration as a JSON string."""
    return '{"name": "mcpgaze-resources-py", "version": "1.0.0", "debug": false}'


# --- Static resource #2 ---------------------------------------------------
@mcp.resource("info://version", name="version-info", mime_type="text/plain")
def version_info() -> str:
    """Static version banner."""
    return "mcpgaze resources matrix cell, server version 1.0.0"


# --- Resource template ----------------------------------------------------
@mcp.resource("greeting://{name}", name="greeting", mime_type="text/plain")
def greeting(name: str) -> str:
    """Templated greeting resource: greeting://{name}."""
    return f"Hello, {name}!"


# --- Tool (keeps tools/list non-empty) ------------------------------------
@mcp.tool()
def echo(message: str) -> str:
    """Echo back the provided message."""
    return f"echo: {message}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
