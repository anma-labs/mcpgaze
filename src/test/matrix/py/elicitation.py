#!/usr/bin/env python3
"""MCP elicitation matrix cell server (feature=elicitation, language=py, transport=stdio).

Feature under test: SERVER-INITIATED ELICITATION.
A tool handler turns around and asks the CLIENT for structured input via the
elicitation/create server->client request (ctx.elicit(message=..., schema=...)).

Exposes:
  - 1 elicitation tool:  book_table   (handler calls ctx.elicit(...))
  - 1 plain tool:        echo         (no elicitation; keeps a trivial tool available)

Notes on expected behavior against mcpgaze:
  mcpgaze acts as a MINIMAL client during snapshot/conform/health: it advertises
  no elicitation capability and does NOT answer elicitation/create requests.
  Therefore initialize + tools/list MUST still succeed (snapshot lists 2 tools,
  conform --all PASSES, health --once is UP). Calling `book_table` will block on a
  client response that never comes, so that tools/call is expected to err/time
  out at the server side -- the key assertion is mcpgaze must NOT crash.

Built on the real Python MCP SDK (FastMCP). Elicitation schemas must be
Pydantic models with primitive field types only.
"""

from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field

mcp = FastMCP("mcpgaze-elicitation-py")


# --- Elicitation response schema (primitive fields only) -------------------
class BookingPreferences(BaseModel):
    """Structured input requested from the client/user."""

    party_size: int = Field(description="Number of guests for the reservation.")
    confirm: bool = Field(description="Whether to confirm the booking.")
    note: str = Field(default="", description="Optional note for the restaurant.")


# --- Elicitation tool: handler asks the CLIENT for structured input --------
@mcp.tool(
    name="book_table",
    title="Book a restaurant table",
    description=(
        "Book a table by asking the connected MCP client for structured "
        "booking details. This triggers a server-initiated elicitation/create "
        "request and returns a confirmation string."
    ),
)
async def book_table(restaurant: str, ctx: Context) -> str:
    """Server-initiated elicitation: ask the client for booking preferences."""
    result = await ctx.elicit(
        message=f"Please provide booking details for {restaurant}.",
        schema=BookingPreferences,
    )
    if result.action == "accept" and result.data is not None:
        data = result.data
        if data.confirm:
            return (
                f"Booked {restaurant} for {data.party_size} "
                f"(note: {data.note or 'none'})."
            )
        return f"Booking for {restaurant} not confirmed by the user."
    return f"Booking for {restaurant} was {result.action}ed."


# --- Plain tool (no elicitation) ------------------------------------------
@mcp.tool()
def echo(message: str) -> str:
    """Echo back the provided message (no elicitation involved)."""
    return f"echo: {message}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
