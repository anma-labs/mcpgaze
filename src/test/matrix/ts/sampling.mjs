#!/usr/bin/env node
// sampling-ts matrix cell: MCP server (stdio) whose tool handler issues a
// server->client sampling/createMessage request. Uses the real
// @modelcontextprotocol/sdk. Initialize + tools/list must always succeed; the
// sampling tool only resolves if the CLIENT answers the sampling request.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "sampling-ts", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// The sampling tool: its handler asks the CLIENT to sample an LLM via
// server.server.createMessage(...). If the client (e.g. mcpgaze in minimal-
// client mode) never answers, the request stays pending; we bound it with the
// request's own timeout so the tools/call resolves to a clean error instead of
// hanging forever.
server.registerTool(
  "summarize_via_client",
  {
    title: "Summarize via client sampling",
    description:
      "Ask the connected client to sample an LLM (sampling/createMessage) " +
      "to summarize the provided text, then return the model's reply.",
    inputSchema: {
      text: z.string().describe("Text for the client's LLM to summarize"),
    },
  },
  async ({ text }) => {
    const result = await server.server.createMessage(
      {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Summarize the following in one sentence:\n\n${text}`,
            },
          },
        ],
        maxTokens: 200,
      },
      // Bound the wait so a non-answering client yields an error, not a hang.
      { timeout: 8000 }
    );

    const reply =
      result?.content?.type === "text"
        ? result.content.text
        : JSON.stringify(result?.content ?? result);

    return { content: [{ type: "text", text: `model said: ${reply}` }] };
  }
);

// A plain tool so tools/list works and is meaningful even without sampling.
server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo back the provided message (no sampling involved)",
    inputSchema: { message: z.string().describe("Message to echo back") },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
