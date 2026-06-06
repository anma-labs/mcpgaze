import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { conform } from "../conform";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS_NOTARRAY = join(here, "mock-server-tools-notarray.mjs");

// Invariant (B): the observation/analysis path must never throw in a way that
// crashes the proxy/server. conform() must always resolve to a ConformReport,
// even when the server returns a malformed tools/list result.
//
// Defect: src/conform.ts:168 `ctx.tools = r.tools ?? []` keeps any truthy
// non-array value (e.g. a string) verbatim. The `tools.names` check at
// src/conform.ts:95 then calls `c.tools.filter(...)` unconditionally, which
// throws `TypeError: c.tools.filter is not a function`. The CHECKS loop at
// src/conform.ts:175-178 has no try/catch, so the throw rejects conform()'s
// promise. With no global unhandledRejection handler the CLI crashes.
test("conform: tools/list returning a truthy non-array does not throw", async () => {
  const report = await conform("node", [TOOLS_NOTARRAY], "2025-06-18", 3000);

  // Should resolve to a report rather than reject.
  assert.ok(report, "conform() should resolve to a ConformReport");

  // The malformed tools/list must be reported as a FAILED required check,
  // not crash the process.
  const toolsList = report.results.find((r) => r.id === "tools.list");
  assert.equal(toolsList?.status, "fail", "tools.list should fail for a non-array");

  // Every check must have produced a result (the loop completed).
  assert.equal(report.results.length, 9, "all checks should run to completion");

  // A required check failed, so the overall report must not be marked passed.
  assert.equal(report.passed, false);
});
