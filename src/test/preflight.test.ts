import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { preflight, checkConfigEnv } from "../preflight";

const here = dirname(fileURLToPath(import.meta.url));
const NEEDS_ENV = join(here, "mock-server-env.mjs");
const PLAIN = join(here, "mock-server.mjs");

test("detects a server that depends on a non-inherited env var", async () => {
  const baseEnv = { ...process.env, MCP_SECRET: "swordfish" };
  const r = await preflight("node", [NEEDS_ENV], { baseEnv, timeoutMs: 2500 });
  assert.equal(r.fullEnvOk, true); // works with full env (MCP_SECRET present)
  assert.equal(r.restrictedEnvOk, false); // fails without it
  assert.ok(r.suspectVars.includes("MCP_SECRET"), "MCP_SECRET flagged as a suspect");
});

test("a server with no env needs passes both probes", async () => {
  // PATH/HOME are in the inherited subset, so a plain server starts either way.
  const r = await preflight("node", [PLAIN], { timeoutMs: 2500 });
  assert.equal(r.fullEnvOk, true);
  assert.equal(r.restrictedEnvOk, true);
});

test("static config check flags unexpanded shell variables and empty values", () => {
  const cfgPath = join(tmpdir(), `mcpgaze-cfg-${Date.now()}.json`);
  writeFileSync(
    cfgPath,
    JSON.stringify({
      mcpServers: {
        good: { env: { API_KEY: "sk-literal-123" } },
        bad: { env: { TOKEN: "${MY_TOKEN}", BASE_URL: "$HOME/x", EMPTY: "" } },
      },
    }),
  );
  try {
    const findings = checkConfigEnv(cfgPath, "bad");
    const keys = findings.map((f) => f.key);
    assert.ok(keys.includes("TOKEN"));
    assert.ok(keys.includes("BASE_URL"));
    assert.ok(findings.some((f) => f.key === "EMPTY" && f.level === "warning"));

    const clean = checkConfigEnv(cfgPath, "good");
    assert.equal(clean.length, 0);
  } finally {
    rmSync(cfgPath, { force: true });
  }
});
