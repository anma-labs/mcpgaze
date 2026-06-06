#!/usr/bin/env node
// pagination-ts matrix cell: MCP server exposing exactly 25 tools served in
// PAGES OF 10 via tools/list nextCursor (pages of 10, 10, 5).
//
// McpServer/registerTool auto-lists ALL tools in a single page, so we use the
// LOW-LEVEL Server API and install our own tools/list handler that slices the
// full tool set by an opaque cursor and returns { tools, nextCursor }.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PAGE_SIZE = 10;
const TOTAL = 25;

// Build the full set of 25 tools: tool_01 .. tool_25.
const ALL_TOOLS = Array.from({ length: TOTAL }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    name: `tool_${n}`,
    description: `Tool number ${i + 1} of ${TOTAL}`,
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "An arbitrary string input" },
      },
      additionalProperties: false,
    },
  };
});

const server = new Server(
  { name: "pagination-ts", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Cursor is an opaque token. We encode the next start offset as a base64url
// string so the client treats it as opaque while we can decode it server-side.
function encodeCursor(offset) {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}
function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null) return 0;
  const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    // Invalid cursor -> treat as start. (Spec allows server-defined handling.)
    return 0;
  }
  return n;
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const cursor = request.params?.cursor;
  const start = decodeCursor(cursor);
  const page = ALL_TOOLS.slice(start, start + PAGE_SIZE);
  const nextStart = start + page.length;
  const result = { tools: page };
  if (nextStart < ALL_TOOLS.length) {
    result.nextCursor = encodeCursor(nextStart);
  }
  return result;
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const value = request.params?.arguments?.value ?? "";
  const known = ALL_TOOLS.some((t) => t.name === name);
  if (!known) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  return {
    content: [{ type: "text", text: `${name} called with value=${JSON.stringify(value)}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
