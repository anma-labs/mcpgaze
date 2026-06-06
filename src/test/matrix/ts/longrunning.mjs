#!/usr/bin/env node
// longrunning-ts matrix cell: MCP server (stdio) with a slow tool that sleeps
// ~7 seconds before returning a result. Uses the real @modelcontextprotocol/sdk.
//
// CRITICAL invariant: initialize and tools/list MUST stay fast. Only the
// tools/call handler for `slow_task` blocks (via an awaited timer); the
// transport's read loop keeps running, so request/response correlation across
// the slow reply is exercised. Because the sleep is awaited inside the per-call
// handler (not at module top level), it never delays initialize/tools/list.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "longrunning-ts", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Default sleep ~7s: comfortably above the oracle's "slow" expectation yet
// safely under the 12s driver timeout so a tools/call completes.
const DEFAULT_SLEEP_MS = 7000;

// The slow tool: awaits a timer (~7s) then returns a normal result. The await
// yields to the event loop, so the transport can still read/parse incoming
// lines; the response is delivered with the correct id once the timer fires.
server.registerTool(
  "slow_task",
  {
    title: "Long-running task",
    description:
      "Sleeps for ~7 seconds (configurable via ms) and then returns a result. " +
      "Used to verify a client keeps request/response correlation across a " +
      "slow reply. initialize and tools/list are unaffected.",
    inputSchema: {
      ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Sleep duration in milliseconds (default 7000)"),
    },
  },
  async ({ ms }) => {
    const dur = Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_SLEEP_MS;
    const startedAt = Date.now();
    await sleep(dur);
    const elapsed = Date.now() - startedAt;
    return {
      content: [
        {
          type: "text",
          text: `slow_task completed after ${elapsed}ms (requested ${dur}ms)`,
        },
      ],
    };
  }
);

// A plain fast tool so tools/list has a second, instant entry and we can show
// that non-slow calls are unaffected.
server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo back the provided message immediately (no sleep)",
    inputSchema: { message: z.string().describe("Message to echo back") },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
