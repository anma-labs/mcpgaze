#!/usr/bin/env node
// twohundredtools-ts matrix cell: MCP server registering EXACTLY 200 distinct
// tools named tool_000 .. tool_199, each with a small object inputSchema (one
// string arg) and a description. Tools are registered in a loop using the real
// @modelcontextprotocol/sdk high-level McpServer.registerTool API, which serves
// the full set via a single tools/list response (no pagination).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOTAL = 200;

const server = new McpServer(
  { name: "twohundredtools-ts", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Register exactly 200 tools: tool_000 .. tool_199.
for (let i = 0; i < TOTAL; i++) {
  const n = String(i).padStart(3, "0");
  const name = `tool_${n}`;
  server.registerTool(
    name,
    {
      title: `Tool ${n}`,
      description: `Scale test tool #${i} of ${TOTAL}; echoes its single string argument`,
      inputSchema: {
        value: z.string().describe(`An arbitrary string input for ${name}`),
      },
    },
    async ({ value }) => ({
      content: [{ type: "text", text: `${name} called with value=${JSON.stringify(value ?? "")}` }],
    })
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
