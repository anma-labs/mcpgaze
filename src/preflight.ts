import { readFileSync } from "node:fs";
import { probeServer } from "./client";

/**
 * The conservative set of environment variables a GUI-launched stdio MCP server
 * actually inherits. GUI apps (Claude Desktop, etc.) do NOT inherit your shell
 * environment, so anything outside this set that your server needs will be
 * silently missing in production even though it works in your terminal.
 */
export const GUI_INHERITED_DEFAULT: string[] =
  process.platform === "win32"
    ? ["PATH", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SystemRoot", "ProgramFiles", "ProgramData", "ComSpec", "NUMBER_OF_PROCESSORS", "OS"]
    : ["HOME", "PATH", "USER", "SHELL", "LANG", "LOGNAME", "TERM", "TMPDIR", "LC_ALL", "LC_CTYPE"];

const SUSPECT = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_API|API_|AUTH|DSN|ENDPOINT|_URL|_URI|_HOST|_PORT|ACCOUNT|REGION|BUCKET|PROJECT|DATABASE|CONN/i;

export interface PreflightResult {
  fullEnvOk: boolean;
  restrictedEnvOk: boolean;
  fullError?: string;
  restrictedError?: string;
  missingVars: string[]; // present in shell, not inherited by a GUI client
  suspectVars: string[]; // subset of missingVars that look like config/secrets
}

export interface PreflightOptions {
  allowlist?: string[];
  timeoutMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
}

function restrict(env: NodeJS.ProcessEnv, allow: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of allow) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

export async function preflight(
  command: string,
  args: string[],
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const env = options.baseEnv ?? process.env;
  const allow = options.allowlist ?? GUI_INHERITED_DEFAULT;
  const timeout = options.timeoutMs ?? 8000;

  let fullEnvOk = true;
  let fullError: string | undefined;
  try {
    await probeServer(command, args, timeout, env);
  } catch (e) {
    fullEnvOk = false;
    fullError = (e as Error).message;
  }

  let restrictedEnvOk = true;
  let restrictedError: string | undefined;
  try {
    await probeServer(command, args, timeout, restrict(env, allow));
  } catch (e) {
    restrictedEnvOk = false;
    restrictedError = (e as Error).message;
  }

  const allowSet = new Set(allow);
  const missingVars = Object.keys(env)
    .filter((k) => !allowSet.has(k))
    .sort();
  const suspectVars = missingVars.filter((k) => SUSPECT.test(k));

  return { fullEnvOk, restrictedEnvOk, fullError, restrictedError, missingVars, suspectVars };
}

// ── static config check ───────────────────────────────────────────────────

export interface ConfigFinding {
  level: "error" | "warning";
  key: string;
  message: string;
}

/**
 * Inspect an MCP client config's `env` block for a server. GUI clients do NOT
 * expand shell variables, so a value like "$HOME/x" or "${TOKEN}" is passed
 * literally — a common, baffling failure.
 */
export function checkConfigEnv(configPath: string, serverName?: string): ConfigFinding[] {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, { env?: Record<string, string> }>;
  };
  const servers = raw.mcpServers ?? {};
  const names = serverName ? [serverName] : Object.keys(servers);
  const findings: ConfigFinding[] = [];
  for (const name of names) {
    const env = servers[name]?.env ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") continue;
      if (/\$\{?[A-Z_]/i.test(value)) {
        findings.push({ level: "error", key, message: `value contains "${value}" — GUI clients do NOT expand shell variables; pass the literal value` });
      }
      if (value.trim() === "") {
        findings.push({ level: "warning", key, message: "empty value" });
      }
    }
  }
  return findings;
}
