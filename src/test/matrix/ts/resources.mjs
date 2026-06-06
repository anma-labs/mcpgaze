#!/usr/bin/env node
// resources-ts matrix cell: MCP server exposing static resources, a resource
// template, and a simple tool, over stdio, using the real @modelcontextprotocol/sdk.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "resources-ts", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } }
);

// Static resource #1: application config (JSON).
server.registerResource(
  "app-config",
  "config://app",
  {
    title: "Application Config",
    description: "Static application configuration",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ name: "resources-ts", debug: false, maxItems: 42 }, null, 2),
      },
    ],
  })
);

// Static resource #2: a plain-text README.
server.registerResource(
  "readme",
  "docs://readme",
  {
    title: "README",
    description: "Project readme as plain text",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/plain",
        text: "resources-ts demo server.\nExposes config://app, docs://readme, and greeting://{name}.",
      },
    ],
  })
);

// Resource template: parameterized greeting.
server.registerResource(
  "greeting",
  new ResourceTemplate("greeting://{name}", { list: undefined }),
  {
    title: "Greeting",
    description: "Generate a greeting for a given name",
    mimeType: "text/plain",
  },
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/plain",
        text: `Hello, ${name}!`,
      },
    ],
  })
);

// Simple tool so tools/list is non-empty.
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
