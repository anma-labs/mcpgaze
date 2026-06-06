// A REAL MCP server built on the official @modelcontextprotocol/sdk, used to
// test mcpgaze against genuine SDK framing/handshake — not a hand-rolled mock.
// Requires @modelcontextprotocol/sdk + zod (installed for integration tests).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "real-sdk", version: "1.0.0" });

server.registerTool(
  "add",
  { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "greet",
  { description: "Greet someone", inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: "text", text: `Hello, ${name}!` }] }),
);

await server.connect(new StdioServerTransport());
