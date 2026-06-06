#!/usr/bin/env node
// elicitation-ts matrix cell: MCP server (stdio) whose tool handler issues a
// server->client elicitation/create request (server-initiated elicitation).
// Uses the real @modelcontextprotocol/sdk. Initialize + tools/list must always
// succeed; the elicitation tool only resolves if the CLIENT answers the
// elicitation/create request with an ElicitResult.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const server = new McpServer(
  { name: "elicitation-ts", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// JSON Schema describing the structured input we want from the user. This is
// sent verbatim in the elicitation/create request's requestedSchema.
const requestedSchema = {
  type: "object",
  properties: {
    name: { type: "string", title: "Your name" },
    confirm: {
      type: "boolean",
      title: "Proceed?",
      description: "Whether to proceed with the action",
    },
  },
  required: ["confirm"],
};

// The elicitation tool: its handler asks the CLIENT for structured input via a
// server->client `elicitation/create` request. We issue the request at the
// lowest level (server.server.request) so it is actually put on the wire
// regardless of whether the client advertised an elicitation capability -- the
// public elicitInput() helper short-circuits with a thrown error when the
// client capability is absent, which would never exercise the wire. If the
// client never answers, we bound the wait with the request's own timeout so the
// tools/call resolves to a clean error instead of hanging forever.
server.registerTool(
  "ask_user",
  {
    title: "Ask the user for structured input",
    description:
      "Issue a server-initiated elicitation/create request asking the " +
      "connected client to collect structured input (name + confirm), then " +
      "return the user's response.",
    inputSchema: {
      prompt: z
        .string()
        .optional()
        .describe("Optional custom prompt message shown to the user"),
    },
  },
  async ({ prompt }) => {
    const message =
      prompt ?? "Please provide your name and confirm whether to proceed.";

    // Low-level server->client request: method "elicitation/create". Bounded so
    // a non-answering client yields an error, not an indefinite hang.
    const result = await server.server.request(
      {
        method: "elicitation/create",
        params: { message, requestedSchema },
      },
      ElicitResultSchema,
      { timeout: 8000 }
    );

    if (result.action !== "accept") {
      return {
        content: [
          { type: "text", text: `user did not accept (action=${result.action})` },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `user provided: ${JSON.stringify(result.content ?? {})}`,
        },
      ],
    };
  }
);

// A plain tool so tools/list works and is meaningful even without elicitation.
server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo back the provided message (no elicitation involved)",
    inputSchema: { message: z.string().describe("Message to echo back") },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
