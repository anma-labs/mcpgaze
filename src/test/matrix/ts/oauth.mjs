#!/usr/bin/env node
// oauth-ts matrix cell: Bearer-token-protected Streamable HTTP MCP server.
//
// This is an OAuth *resource server*: it REQUIRES `Authorization: Bearer <token>`
// on every request to /mcp. The bearer check is express middleware that runs
// BEFORE the MCP transport handler, so the decision (401 vs allowed) depends
// purely on the Authorization header — even a minimal/malformed POST body is
// rejected with 401 when the header is missing/invalid, and accepted when the
// header is exactly "Bearer secret-token-123".
//
// Uses the REAL @modelcontextprotocol/sdk StreamableHTTPServerTransport
// (stateless mode) mounted at POST /mcp. Listens on PORT 7150 in the foreground.
//
// Oracle relevance (tested via `mcpgaze wrap-http`):
//   (a) no Authorization            -> 401 (forwarded upstream 401)
//   (b) client sends Bearer but proxy started WITHOUT --creds-route/--forward-credentials
//       -> proxy STRIPS the header  -> upstream 401  (per-route credential scoping)
//   (c) proxy started WITH --creds-route /mcp and client sends Bearer
//       -> header forwarded          -> upstream 200
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = 7150;
const HOST = "127.0.0.1";
const EXPECTED_TOKEN = "secret-token-123";
// RFC 9728 / RFC 6750: the protected resource identifier advertised in 401s.
const RESOURCE_METADATA_URL = `http://${HOST}:${PORT}/.well-known/oauth-protected-resource`;

// ---- The MCP server (real SDK). A single tool so tools/list is non-empty. ----
function buildMcpServer() {
  const server = new McpServer(
    { name: "oauth-ts", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Returns the identity tied to the bearer token used to reach this " +
        "protected resource. Only callable once the Authorization header passed " +
        "the OAuth resource-server middleware.",
      inputSchema: {},
    },
    async () => ({
      content: [
        { type: "text", text: "authenticated as bearer:secret-token-123" },
      ],
    })
  );
  return server;
}

const app = express();
app.use(express.json());

// ---- OAuth resource-server middleware: runs BEFORE the MCP transport. ----
// Emits a WWW-Authenticate header on 401 so a client/proxy can discover how to
// authenticate (RFC 6750 Bearer challenge + RFC 9728 resource_metadata pointer).
function bearerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const m = /^Bearer (.+)$/.exec(header);
  const token = m ? m[1] : null;

  if (!token) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer realm="mcp", error="invalid_request", ` +
          `error_description="Missing Authorization Bearer token", ` +
          `resource_metadata="${RESOURCE_METADATA_URL}"`
      )
      .json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing bearer token" },
        id: null,
      });
    return;
  }

  if (token !== EXPECTED_TOKEN) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer realm="mcp", error="invalid_token", ` +
          `error_description="The access token is invalid", ` +
          `resource_metadata="${RESOURCE_METADATA_URL}"`
      )
      .json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: invalid bearer token" },
        id: null,
      });
    return;
  }

  // Token is valid — attach a minimal AuthInfo for downstream handlers.
  req.auth = {
    token,
    clientId: "oauth-ts-client",
    scopes: ["mcp"],
  };
  next();
}

// RFC 9728 protected-resource metadata (public; no auth required to discover).
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `http://${HOST}:${PORT}/mcp`,
    authorization_servers: [`http://${HOST}:${PORT}`],
    bearer_methods_supported: ["header"],
  });
});

// ---- The protected MCP endpoint. Middleware runs BEFORE handleRequest. ----
// Stateless transport: a fresh transport+server per request so any
// minimal/valid initialize POST succeeds once the bearer check passes, and
// concurrency is safe.
app.post("/mcp", bearerAuth, async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE on /mcp are also protected; stateless mode doesn't support
// standalone SSE / session teardown, so report 405 (after the auth gate).
app.get("/mcp", bearerAuth, (_req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed (stateless)" },
    id: null,
  });
});
app.delete("/mcp", bearerAuth, (_req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed (stateless)" },
    id: null,
  });
});

app.listen(PORT, HOST, () => {
  // stderr so it never pollutes any stdout-based wire.
  process.stderr.write(
    `[oauth-ts] listening on http://${HOST}:${PORT}/mcp (Bearer required)\n`
  );
});
