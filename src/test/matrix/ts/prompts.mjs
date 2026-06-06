#!/usr/bin/env node
// prompts-ts matrix cell: MCP server exposing two prompts (one parameterized)
// plus a tool, over stdio, using the real @modelcontextprotocol/sdk.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "prompts-ts", version: "1.0.0" },
  { capabilities: { prompts: {}, tools: {} } }
);

// Prompt #1: "review" — takes arguments (code + optional language).
server.registerPrompt(
  "review",
  {
    title: "Code Review",
    description: "Generate a code-review prompt for the given snippet",
    argsSchema: {
      code: z.string().describe("The code to review"),
      language: z.string().optional().describe("Programming language of the code"),
    },
  },
  ({ code, language }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please review the following ${language ?? "code"} for bugs, style, and clarity:\n\n${code}`,
        },
      },
    ],
  })
);

// Prompt #2: "summarize" — no arguments.
server.registerPrompt(
  "summarize",
  {
    title: "Summarize",
    description: "Ask the assistant to summarize the prior conversation",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Summarize the key points of our conversation so far in three bullets.",
        },
      },
    ],
  })
);

// At least one tool so tools/list is non-empty.
server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo back the provided message",
    inputSchema: { message: z.string().describe("Message to echo back") },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
