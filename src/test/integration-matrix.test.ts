import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { probeServer } from "../client";
import { conform } from "../conform";
import { healthCheckOnce } from "../health";
import { preflight } from "../preflight";

// ─────────────────────────────────────────────────────────────────────────────
// GUARDED integration-matrix suite.
//
// Locks in the cells/commands the verifier confirmed as genuinely PASSING (see
// the per-cell passingCommands in the matrix oracle). It drives mcpgaze's
// library entrypoints (probeServer/conform/healthCheckOnce/preflight) directly,
// which is both faster than and equivalent to shelling out through the stdio
// driver for these read-only/handshake commands.
//
// Portability guarding (mirrors integration-real-sdk.test.ts's SDK_PRESENT):
//   - TS-SDK stdio cells run only when @modelcontextprotocol/sdk is installed.
//   - Python cells run only when `python3 -c "import mcp"` succeeds, honoring
//     MCPGAZE_MATRIX_PYTHONPATH so other machines can point at their own SDK.
// On a host lacking either, the relevant tests skip gracefully instead of
// failing — exactly like the existing SDK_PRESENT guard.
//
// HTTP/OAuth cells are intentionally NOT covered: the only deterministic
// behavior there is a credential-leak misbehavior (verdict=misbehaved), and an
// in-process HTTP round-trip is awkward + flaky. Skipped per the brief.
//
// preflight cells are asserted ONLY for cells the oracle marked preflight as a
// genuine pass; the Python sampling/prompts/elicitation cells whose preflight
// was a non-reproducible cold-start timing flake are excluded.
// ─────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const TS_DIR = join(here, "matrix", "ts");
const PY_DIR = join(here, "matrix", "py");

// TS SDK is a heavyweight optional dependency. Skip TS cells when absent.
const SDK_PRESENT = existsSync(join(here, "..", "..", "node_modules", "@modelcontextprotocol", "sdk"));

// Python MCP SDK presence. The matrix launchers hardcode PYTHONPATH=/tmp/mcp-pylib
// for THIS machine; the test honors MCPGAZE_MATRIX_PYTHONPATH so it can detect
// availability (and skip gracefully) elsewhere.
const MATRIX_PYTHONPATH = process.env.MCPGAZE_MATRIX_PYTHONPATH;
const PY_PRESENT = (() => {
  try {
    const env = { ...process.env };
    if (MATRIX_PYTHONPATH) env.PYTHONPATH = MATRIX_PYTHONPATH;
    execFileSync("python3", ["-c", "import mcp"], { env, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const TS_SKIP = !SDK_PRESENT && "TS @modelcontextprotocol/sdk not installed";
const PY_SKIP = !PY_PRESENT && "Python mcp SDK not importable (set MCPGAZE_MATRIX_PYTHONPATH)";

// Python MCP cold-start can take ~7-8s; give every probe ample headroom so the
// suite is deterministic and never races a fixed timeout (the flaky preflight
// cells were excluded for exactly this reason).
const TS_TIMEOUT = 15000;
const PY_TIMEOUT = 25000;

const tsRun = (cell: string): { command: string; args: string[] } => ({
  command: "bash",
  args: [join(TS_DIR, `${cell}_run.sh`)],
});
const pyRun = (cell: string): { command: string; args: string[] } => ({
  command: "bash",
  args: [join(PY_DIR, `${cell}_run.sh`)],
});

const toolNames = (probe: { tools: Array<{ name: string }> }): string[] =>
  probe.tools.map((t) => t.name).sort();

function requiredFails(report: { results: Array<{ id: string; level: string; status: string }> }): string[] {
  return report.results.filter((r) => r.level === "required" && r.status === "fail").map((r) => r.id).sort();
}

// ── resources cells: snapshot/probe yields exactly the 1 tool; conform passes ──

test("resources-ts: probe yields the single tool; conform passes", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("resources");
  const probe = await probeServer(command, args, TS_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo"]);
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

test("resources-py: probe yields the single tool; conform passes", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("resources");
  const probe = await probeServer(command, args, PY_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo"]);
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

// ── prompts cells: snapshot/probe sees only the 1 tool; conform passes ────────

test("prompts-ts: probe yields the single tool; conform passes", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("prompts");
  const probe = await probeServer(command, args, TS_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo"]);
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

test("prompts-py: probe yields the single tool; conform passes", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("prompts");
  const probe = await probeServer(command, args, PY_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo"]);
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

// ── sampling cells: 2 tools, conform passes (server-initiated feature) ────────

test("sampling-ts: probe yields both tools; conform passes; health UP", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("sampling");
  const probe = await probeServer(command, args, TS_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo", "summarize_via_client"]);
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
  const h = await healthCheckOnce(command, args, TS_TIMEOUT);
  assert.equal(h.ok, true, h.error);
  assert.equal(h.toolCount, 2);
});

test("sampling-py: probe yields both tools; conform passes; health UP", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("sampling");
  const probe = await probeServer(command, args, PY_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["ask_llm", "echo"]);
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
  const h = await healthCheckOnce(command, args, PY_TIMEOUT);
  assert.equal(h.ok, true, h.error);
  assert.equal(h.toolCount, 2);
});

// ── elicitation cells: 2 tools, conform passes ───────────────────────────────

test("elicitation-ts: probe yields both tools; conform passes", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("elicitation");
  const probe = await probeServer(command, args, TS_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["ask_user", "echo"]);
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

test("elicitation-py: probe yields both tools; conform passes", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("elicitation");
  const probe = await probeServer(command, args, PY_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["book_table", "echo"]);
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

// ── pagination cells: KEY POSITIVE TEST — snapshot collects ALL 25 tools ──────

test("pagination-ts: probe follows nextCursor and collects all 25 tools; conform passes", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("pagination");
  const probe = await probeServer(command, args, TS_TIMEOUT);
  const names = toolNames(probe);
  assert.equal(names.length, 25, `expected 25 tools, got ${names.length}`);
  const expected = Array.from({ length: 25 }, (_, i) => `tool_${String(i + 1).padStart(2, "0")}`).sort();
  assert.deepEqual(names, expected);
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

test("pagination-py: probe follows nextCursor and collects all 25 tools; conform passes", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("pagination");
  const probe = await probeServer(command, args, PY_TIMEOUT);
  const names = toolNames(probe);
  assert.equal(names.length, 25, `expected 25 tools, got ${names.length}`);
  const expected = Array.from({ length: 25 }, (_, i) => `tool_${String(i + 1).padStart(2, "0")}`).sort();
  assert.deepEqual(names, expected);
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

// ── progress cells: 2 tools, conform passes ──────────────────────────────────

test("progress-ts: probe yields both tools; conform passes", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("progress");
  const probe = await probeServer(command, args, TS_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo", "long_task"]);
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

test("progress-py: probe yields both tools; conform passes", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("progress");
  const probe = await probeServer(command, args, PY_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo", "long_task"]);
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
});

// ── longrunning cells: 2 tools, conform passes (init/tools-list stay instant) ─

test("longrunning-ts: probe yields both tools; conform passes; health UP", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("longrunning");
  const probe = await probeServer(command, args, TS_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo", "slow_task"]);
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
  const h = await healthCheckOnce(command, args, TS_TIMEOUT);
  assert.equal(h.ok, true, h.error);
  assert.equal(h.toolCount, 2);
});

test("longrunning-py: probe yields both tools; conform passes; health UP", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("longrunning");
  const probe = await probeServer(command, args, PY_TIMEOUT);
  assert.deepEqual(toolNames(probe), ["echo", "slow_task"]);
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
  const h = await healthCheckOnce(command, args, PY_TIMEOUT);
  assert.equal(h.ok, true, h.error);
  assert.equal(h.toolCount, 2);
});

// ── twohundredtools cells: 200 distinct tools, no truncation; conform passes ──

test("twohundredtools-ts: probe captures all 200 tools; conform passes; health reports 200", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("twohundredtools");
  const probe = await probeServer(command, args, TS_TIMEOUT);
  const names = toolNames(probe);
  assert.equal(names.length, 200, `expected 200 tools, got ${names.length}`);
  const expected = Array.from({ length: 200 }, (_, i) => `tool_${String(i).padStart(3, "0")}`).sort();
  assert.deepEqual(names, expected);
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
  const h = await healthCheckOnce(command, args, TS_TIMEOUT);
  assert.equal(h.ok, true, h.error);
  assert.equal(h.toolCount, 200);
});

test("twohundredtools-py: probe captures all 200 tools; conform passes; health reports 200", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("twohundredtools");
  const probe = await probeServer(command, args, PY_TIMEOUT);
  const names = toolNames(probe);
  assert.equal(names.length, 200, `expected 200 tools, got ${names.length}`);
  const expected = Array.from({ length: 200 }, (_, i) => `tool_${String(i).padStart(3, "0")}`).sort();
  assert.deepEqual(names, expected);
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, true, JSON.stringify(requiredFails(report)));
  const h = await healthCheckOnce(command, args, PY_TIMEOUT);
  assert.equal(h.ok, true, h.error);
  assert.equal(h.toolCount, 200);
});

// ── spec-violating cells: NEGATIVE oracle — conform MUST report passed:false ──
// with exactly the three intended REQUIRED failures, and must not crash/hang.

const SPEC_VIOLATING_FAILS = ["error.unknownMethod", "init.serverInfo", "tools.names"];

test("specviolating-ts: conform detects all three required violations (passed:false)", { skip: TS_SKIP }, async () => {
  const { command, args } = tsRun("specviolating");
  const report = await conform(command, args, "2025-06-18", TS_TIMEOUT);
  assert.equal(report.passed, false);
  assert.deepEqual(requiredFails(report), SPEC_VIOLATING_FAILS);
});

test("specviolating-py: conform detects all three required violations (passed:false)", { skip: PY_SKIP }, async () => {
  const { command, args } = pyRun("specviolating");
  const report = await conform(command, args, "2025-06-18", PY_TIMEOUT);
  assert.equal(report.passed, false);
  assert.deepEqual(requiredFails(report), SPEC_VIOLATING_FAILS);
});

// ── preflight: only for cells the oracle marked preflight as a genuine pass ───
// (excludes prompts-py / sampling-py / elicitation-py whose preflight was a
// non-reproducible cold-start timing flake, per the oracle).

test("preflight: representative stdio cells start cleanly under the GUI-inherited env subset", { skip: TS_SKIP }, async () => {
  for (const cell of ["resources", "pagination", "twohundredtools"]) {
    const { command, args } = tsRun(cell);
    const r = await preflight(command, args, { timeoutMs: TS_TIMEOUT });
    assert.equal(r.fullEnvOk, true, `${cell}: full env: ${r.fullError}`);
    assert.equal(r.restrictedEnvOk, true, `${cell}: restricted env: ${r.restrictedError}`);
  }
});
