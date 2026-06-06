#!/usr/bin/env python3
"""MCP OAuth matrix cell server (feature=oauth, language=py, transport=http).

Feature under test: BEARER-TOKEN-PROTECTED Streamable HTTP MCP server, i.e. an
OAuth *resource server*. Every request to /mcp must carry

    Authorization: Bearer secret-token-123

The bearer check runs as Starlette middleware (BaseHTTPMiddleware) that executes
BEFORE the MCP Streamable HTTP transport handler. The decision is made purely on
the inbound Authorization header:

  - missing header                 -> 401 (+ WWW-Authenticate: Bearer ...)
  - present but != the secret      -> 401 (+ WWW-Authenticate: Bearer ...)
  - exactly "secret-token-123"     -> request is forwarded to the MCP transport

Because the gate is middleware in front of the transport, even a minimal or
malformed POST body yields 401 vs "allowed" based solely on the header -- the
body is never parsed when the token is wrong.

The MCP server itself is a real Python MCP SDK server (FastMCP). We take its
`streamable_http_app()` -- a Starlette ASGI app that already routes /mcp to the
StreamableHTTP transport and whose lifespan starts the session manager -- and
add the bearer middleware directly to it. Starlette middleware wraps the whole
app, so the gate runs strictly BEFORE the transport route handler. We keep the
transport mounted at the literal path /mcp (streamable_http_path="/mcp") so no
trailing-slash redirect is emitted: an authorized POST to /mcp is served at /mcp.

Listens in the FOREGROUND on port 7152 (baked in; run.sh just launches it).

Expected behavior against mcpgaze (tested via wrap-http; the 8 stdio commands
are N/A by design):
  (a) POST /mcp with NO Authorization            -> upstream 401, forwarded.
  (b) proxy WITHOUT --creds-route/--forward-credentials, client sends the
      Bearer token -> proxy MUST STRIP the header -> upstream 401 (per-route
      credential scoping from the security-hardening pass). If this returns 200
      the proxy leaks credentials when not opted in -> SECURITY bug.
  (c) proxy WITH --creds-route /mcp, client sends the Bearer token -> 200.
"""

import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

# Port baked into the server: the HTTP cell listens here in the foreground.
PORT = 7152

# The one token that is allowed. Comparison is exact.
SECRET_TOKEN = "secret-token-123"

# Value for the WWW-Authenticate challenge sent on 401.
WWW_AUTHENTICATE = 'Bearer realm="mcpgaze", error="invalid_token"'


# --- The actual MCP server (real Python SDK, FastMCP) ---------------------
# Transport routed at the literal "/mcp" so an authorized POST to /mcp is served
# directly (no trailing-slash 307 redirect). stateless_http avoids needing a
# prior session id; json_response makes authorized initialize return plain JSON.
mcp = FastMCP(
    "mcpgaze-oauth-py",
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
)


@mcp.tool()
def whoami() -> str:
    """Return the identity the bearer token authorized. Reaching this tool at
    all proves the Authorization: Bearer secret-token-123 gate was passed."""
    return "authorized as: secret-token-123"


@mcp.tool()
def echo(message: str) -> str:
    """Echo back the provided message (only callable once authorized)."""
    return f"echo: {message}"


# --- Bearer middleware: runs BEFORE the MCP transport handler -------------
class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Gate every request on the Authorization header before it can reach the
    mounted MCP transport. Decision is made purely on the header value."""

    async def dispatch(self, request: Request, call_next):
        auth = request.headers.get("authorization", "")
        # Accept exactly "Bearer secret-token-123" (scheme case-insensitive).
        ok = False
        if auth:
            parts = auth.split(" ", 1)
            if len(parts) == 2 and parts[0].lower() == "bearer":
                ok = parts[1] == SECRET_TOKEN
        if not ok:
            return JSONResponse(
                {
                    "error": "invalid_token",
                    "error_description": "Missing or invalid bearer token",
                },
                status_code=401,
                headers={"WWW-Authenticate": WWW_AUTHENTICATE},
            )
        # Authorized: hand off to the MCP Streamable HTTP transport.
        return await call_next(request)


# FastMCP's own Starlette app: routes /mcp -> StreamableHTTP transport and owns
# the session-manager lifespan. We add the bearer gate as middleware, so it runs
# strictly before the transport route handler.
app = mcp.streamable_http_app()
app.add_middleware(BearerAuthMiddleware)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
