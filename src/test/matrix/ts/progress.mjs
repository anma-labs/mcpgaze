#!/usr/bin/env node
// progress-ts matrix cell: MCP server (stdio) whose tool emits a sequence of
// notifications/progress messages (progress increasing toward total) BEFORE it
// returns the tool result. Uses the real @modelcontextprotocol/sdk.
//
// initialize + tools/list are always normal. The progress tool only emits
// progress notifications when the CLIENT supplies params._meta.progressToken
// on the tools/call request (per the MCP spec, a server MUST NOT send progress
// for a token it was never given). The SDK surfaces that token to the tool
// handler via the `extra` argument:
//   - extra._meta.progressToken  -> the token to echo back
//   - extra.sendNotification(..) -> emits a notification correlated to this call
// We send the notification at the protocol method level so it goes on the wire
// verbatim as { method:"notifications/progress", params:{ progressToken,
// progress, total, message } }.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "progress-ts", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOTAL = 4;

// The progress tool: emits TOTAL progress notifications (1..TOTAL of TOTAL)
// before returning a final result. If no progressToken was supplied by the
// client, it skips the notifications (spec-compliant) and just returns.
server.registerTool(
  "long_task",
  {
    title: "Long-running task with progress",
    description:
      "Runs a simulated multi-step task. When the caller supplies a " +
      "progressToken in params._meta, emits notifications/progress messages " +
      "(progress increasing toward total) before returning the final result.",
    inputSchema: {
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of progress steps to emit (default 4)"),
    },
  },
  async ({ steps }, extra) => {
    const total = Number.isInteger(steps) && steps > 0 ? steps : TOTAL;
    const progressToken = extra?._meta?.progressToken;

    if (progressToken !== undefined && progressToken !== null) {
      for (let i = 1; i <= total; i++) {
        // Emit a well-formed progress notification correlated to this call.
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: i,
            total,
            message: `step ${i} of ${total}`,
          },
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text:
            progressToken !== undefined && progressToken !== null
              ? `completed ${total} steps (emitted ${total} progress notifications)`
              : `completed ${total} steps (no progressToken supplied; no notifications emitted)`,
        },
      ],
    };
  }
);

// A plain tool so tools/list is meaningful even without progress.
server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo back the provided message (no progress involved)",
    inputSchema: { message: z.string().describe("Message to echo back") },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
