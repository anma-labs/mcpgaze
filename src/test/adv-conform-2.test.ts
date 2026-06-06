import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { conform } from "../conform";

const here = dirname(fileURLToPath(import.meta.url));
const REQUIRED_NONARRAY = join(here, "mock-server-required-nonarray.mjs");

// Invariant (B): the observation/analysis path must never throw in a way that
// crashes the proxy/server. conform() must always resolve to a ConformReport,
// even when the server returns a malformed tool inputSchema.
//
// Defect: src/conform.ts:119 guards the `tools.requiredRefs` check with only
// `if (!s?.required) continue;`, which passes any truthy `required` value.
// src/conform.ts:121 then does `for (const r of s.required)`. If `required` is
// a truthy NON-ITERABLE value (a number, plain object, or boolean true) the
// for..of throws `TypeError: ... is not iterable`. The CHECKS loop at
// src/conform.ts:175-178 has no try/catch, so the throw rejects conform()'s
// promise. With no global unhandledRejection handler the CLI crashes.
test("conform: tool inputSchema.required as a non-iterable value does not throw", async () => {
  const report = await conform("node", [REQUIRED_NONARRAY], "2025-06-18", 3000);

  // Should resolve to a report rather than reject.
  assert.ok(report, "conform() should resolve to a ConformReport");

  // Every check must have produced a result (the loop completed).
  assert.equal(report.results.length, 9, "all checks should run to completion");

  // The requiredRefs check is "recommended"; a malformed schema must surface as
  // a non-pass status rather than crash the process.
  const requiredRefs = report.results.find((r) => r.id === "tools.requiredRefs");
  assert.ok(requiredRefs, "tools.requiredRefs check should be present");
  assert.notEqual(requiredRefs?.status, undefined, "tools.requiredRefs must have a status");
});
