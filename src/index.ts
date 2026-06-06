#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Logger } from "./logger";
import { runProxy } from "./proxy";
import { runHttpProxy, buildRoutes } from "./http-proxy";
import { snapshot } from "./snapshot";
import { diff } from "./diff";
import { CassetteRecorder, runReplayServer } from "./cassette";
import { preflight, checkConfigEnv } from "./preflight";
import { conform, KNOWN_SPEC_VERSIONS } from "./conform";
import { verify, updateCassette } from "./verify";
import { triage } from "./triage";
import { runHealthDaemon } from "./health";
import { Tui } from "./tui";
import { worstSeverity, type Severity } from "./schema-diff";
import { color } from "./colors";
import { VERSION } from "./version";

function splitOnDoubleDash(args: string[]): { opts: string[]; cmd: string[] } {
  const i = args.indexOf("--");
  if (i === -1) return { opts: args, cmd: [] };
  return { opts: args.slice(0, i), cmd: args.slice(i + 1) };
}

function getOpt(opts: string[], name: string): string | undefined {
  const i = opts.indexOf(name);
  return i >= 0 && i + 1 < opts.length ? opts[i + 1] : undefined;
}

function getOpts(opts: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < opts.length - 1; i++) if (opts[i] === name) out.push(opts[i + 1]);
  return out;
}

function hasFlag(opts: string[], name: string): boolean {
  return opts.includes(name);
}

function die(msg: string): never {
  process.stderr.write(color.red(msg) + "\n");
  process.exit(2);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const HELP = `mcpgaze v${VERSION} — a transparent wiretap for MCP servers

USAGE
  mcpgaze wrap [--log <path>] [--print] [--tui] [--native] -- <server command...>
  mcpgaze wrap-http (--upstream <url> | --route <prefix>=<url> ...) [--port <n>] [--host 127.0.0.1]
  mcpgaze record [--cassette mcpgaze.cassette.json] [--log <path>] -- <server command...>
  mcpgaze replay --cassette <file>
  mcpgaze snapshot [--out mcpgaze.baseline.json] -- <server command...>
  mcpgaze diff [--baseline <f>] [--fail-on <breaking|warning|any>] [--update] -- <server command...>
  mcpgaze conform [--spec <ver>|--all] [--json] -- <server command...>
  mcpgaze verify --cassette <file> [--fail-on <sev>] [--update] -- <server command...>
  mcpgaze health [--interval <sec>] [--once] [--status <path>] -- <server command...>
  mcpgaze triage [--log <session.jsonl>] [--ai] [--model <name>]
  mcpgaze preflight [--config <file> [--server <name>]] [-- <server command...>]

COMMANDS
  wrap        Transparent stdio proxy; logs every JSON-RPC message to a side
              channel without touching the wire. --tui shows a live dashboard;
              --native uses the zero-overhead Rust single-binary proxy.
  wrap-http   Same idea for Streamable HTTP: localhost-bound, Origin-checked.
              Routes by path prefix, so one proxy can front several upstreams
              (--route /a=URL --route /b=URL); --upstream is the single-route form.
  record      Wrap a server and write a replayable cassette of req/res pairs.
  replay      Deterministic mock MCP server (stdio) from a cassette.
  snapshot    Probe the server, write a tool-schema baseline you commit to git.
  diff        Diff the live tool surface vs the baseline. --update accepts it.
  conform     Spec-conformance suite across protocol versions.
  verify      Re-issue recorded requests and diff RESPONSE SHAPES. --update
              re-baselines the cassette (accept intentional behavioral changes).
  health      Continuously health-check a server (uptime, latency, drift), or
              --once as a cron/CI liveness probe (exit 0 up / 1 down).
  triage      Read a session log, surface failures, and (with --ai) get a
              plain-English root-cause + fix from Claude.
  preflight   Diagnose env vars a GUI client won't inherit; check config env.

EXAMPLES
  mcpgaze wrap --tui -- node server.js
  mcpgaze wrap --native -- node server.js
  mcpgaze health --interval 30 -- node server.js
  mcpgaze conform --all -- node server.js
  mcpgaze diff --update -- node server.js          # accept the new tool surface
  mcpgaze verify --cassette s.json --update -- node server.js
`;

function findNativeProxy(): string | null {
  const fromEnv = process.env.MCPGAZE_PROXY_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js -> ../native/... ; src/index.ts -> ../native/...
  const candidates = [
    join(here, "..", "native", "mcpgaze-proxy", "target", "release", "mcpgaze-proxy"),
    join(here, "..", "..", "native", "mcpgaze-proxy", "target", "release", "mcpgaze-proxy"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function cmdWrap(args: string[]): Promise<void> {
  const { opts, cmd } = splitOnDoubleDash(args);
  if (cmd.length === 0) die("usage: mcpgaze wrap [--log <path>] [--print] [--tui] [--native] -- <server command...>");
  const logPath = getOpt(opts, "--log") ?? `.mcpgaze/session-${timestamp()}.jsonl`;

  // Native fast-path: hand off to the Rust single-binary proxy.
  if (hasFlag(opts, "--native")) {
    const bin = findNativeProxy();
    if (!bin) {
      process.stderr.write(color.yellow("[mcpgaze] native proxy not found; build it with `cargo build --release` in native/mcpgaze-proxy, or set MCPGAZE_PROXY_BIN. Falling back to the Node proxy.\n"));
    } else {
      const child = spawn(bin, ["--log", logPath, "--", ...cmd], { stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }
  }

  const useTui = hasFlag(opts, "--tui");
  if (useTui && !Tui.isSupported()) {
    process.stderr.write(color.yellow("[mcpgaze] --tui needs a TTY; falling back to plain logging.\n"));
  }
  const tui = useTui && Tui.isSupported() ? new Tui(cmd.join(" ")) : null;

  const logger = new Logger({
    jsonlPath: logPath,
    pretty: !tui && hasFlag(opts, "--print"),
    onEvent: tui ? (ev) => tui.update(ev) : undefined,
  });

  if (tui) {
    tui.start();
    const stop = (): void => {
      tui.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    process.stderr.write(color.dim(`[mcpgaze] logging session to ${logPath}\n`));
  }

  const code = await runProxy({ command: cmd[0], args: cmd.slice(1), logger, mirrorStderr: !tui });
  if (tui) tui.stop();
  process.exit(code);
}

async function cmdWrapHttp(args: string[]): Promise<void> {
  const { opts } = splitOnDoubleDash(args);
  const upstream = getOpt(opts, "--upstream");
  const routeSpecs = getOpts(opts, "--route");
  if (!upstream && routeSpecs.length === 0) {
    die("usage: mcpgaze wrap-http (--upstream <url> | --route <prefix>=<url> ...) [--port <n>] [--host 127.0.0.1]");
  }
  let routes;
  try {
    routes = buildRoutes(upstream, routeSpecs);
  } catch (e) {
    die((e as Error).message);
  }
  const host = getOpt(opts, "--host") ?? "127.0.0.1";
  const port = Number(getOpt(opts, "--port") ?? "0");
  const logPath = getOpt(opts, "--log") ?? `.mcpgaze/session-${timestamp()}.jsonl`;
  const allow = getOpt(opts, "--allow-origin");
  const logger = new Logger({ jsonlPath: logPath, pretty: hasFlag(opts, "--print") });
  const handle = await runHttpProxy({
    routes,
    host,
    port,
    logger,
    allowedOrigins: allow ? allow.split(",") : undefined,
  });
  process.stderr.write(color.green(`[mcpgaze] proxy listening on http://${host}:${handle.port}`) + "\n");
  for (const r of routes) {
    process.stderr.write(color.dim(`  ${r.prefix.padEnd(12)} → ${r.upstream}\n`));
  }
  process.stderr.write(color.dim(`[mcpgaze] logging to ${logPath}\n`));
  if (host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write(color.yellow(`[mcpgaze] warning: binding to ${host} exposes the proxy beyond localhost\n`));
  }
  const shutdown = (): void => void handle.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdRecord(args: string[]): Promise<void> {
  const { opts, cmd } = splitOnDoubleDash(args);
  if (cmd.length === 0) die("usage: mcpgaze record [--cassette <path>] -- <server command...>");
  const cassettePath = getOpt(opts, "--cassette") ?? "mcpgaze.cassette.json";
  const logPath = getOpt(opts, "--log") ?? `.mcpgaze/session-${timestamp()}.jsonl`;
  const logger = new Logger({ jsonlPath: logPath, pretty: hasFlag(opts, "--print") });
  const recorder = new CassetteRecorder();
  process.stderr.write(color.dim(`[mcpgaze] recording cassette to ${cassettePath}\n`));
  const code = await runProxy({
    command: cmd[0],
    args: cmd.slice(1),
    logger,
    onInteraction: ({ request, response }) => recorder.add(request, response),
  });
  const n = recorder.write(cassettePath);
  process.stderr.write(color.green(`[mcpgaze] wrote ${cassettePath} — ${n} interaction(s)\n`));
  process.exit(code);
}

async function cmdReplay(args: string[]): Promise<void> {
  const { opts } = splitOnDoubleDash(args);
  const cassettePath = getOpt(opts, "--cassette");
  if (!cassettePath) die("usage: mcpgaze replay --cassette <file>");
  const code = await runReplayServer(cassettePath);
  process.exit(code);
}

async function cmdPreflight(args: string[]): Promise<void> {
  const { opts, cmd } = splitOnDoubleDash(args);
  const configPath = getOpt(opts, "--config");

  if (configPath) {
    const findings = checkConfigEnv(configPath, getOpt(opts, "--server"));
    if (findings.length === 0) {
      process.stdout.write(color.green("✓ config env block looks clean\n"));
    } else {
      for (const f of findings) {
        const badge = f.level === "error" ? color.red("ERROR  ") : color.yellow("WARNING");
        process.stdout.write(`  ${badge}  ${color.bold(f.key)} — ${f.message}\n`);
      }
    }
    if (cmd.length === 0) return;
  }

  if (cmd.length === 0) die("usage: mcpgaze preflight [--config <file>] [-- <server command...>]");
  process.stderr.write(color.dim("[mcpgaze] probing with full env, then with the GUI-inherited subset…\n"));
  const r = await preflight(cmd[0], cmd.slice(1));

  if (!r.fullEnvOk) {
    process.stdout.write(color.red("✗ the server failed to start even with your full environment.\n"));
    if (r.fullError) process.stdout.write(color.dim(`  ${r.fullError.split("\n")[0]}\n`));
    process.exit(1);
  }
  if (r.restrictedEnvOk) {
    process.stdout.write(color.green("✓ starts cleanly with only the env a GUI client inherits — no env surprises.\n"));
    return;
  }

  process.stdout.write(
    color.yellow("⚠ starts with your full shell env but FAILS with only what a GUI client inherits.\n") +
      "  Your server likely depends on env vars Claude Desktop (and similar) won't pass.\n",
  );
  if (r.suspectVars.length) {
    process.stdout.write(color.bold("\n  Likely culprits (set in your shell, not inherited by GUI clients):\n"));
    for (const v of r.suspectVars.slice(0, 15)) process.stdout.write(`    • ${v}\n`);
    process.stdout.write(
      color.dim(`\n  Fix: pass them explicitly in your client config's "env" block (literal values, not $VARS).\n`),
    );
  }
  process.exit(1);
}

async function cmdSnapshot(args: string[]): Promise<void> {
  const { opts, cmd } = splitOnDoubleDash(args);
  if (cmd.length === 0) die("usage: mcpgaze snapshot [--out <path>] -- <server command...>");
  const outPath = getOpt(opts, "--out") ?? "mcpgaze.baseline.json";
  const baseline = await snapshot(cmd[0], cmd.slice(1), outPath);
  const n = Object.keys(baseline.tools).length;
  process.stdout.write(
    color.green(`✓ wrote ${outPath}`) +
      ` — ${n} tool${n === 1 ? "" : "s"} from ${baseline.server.name ?? "server"} ` +
      color.dim(`(protocol ${baseline.protocolVersion})`) +
      "\n",
  );
}

function thresholdMet(worst: Severity | null, failOn: string | undefined): boolean {
  if (!failOn) return false;
  if (worst === null) return false;
  const rank: Record<Severity, number> = { info: 0, warning: 1, breaking: 2 };
  const want = failOn === "any" ? 0 : failOn === "warning" ? 1 : 2; // default breaking
  return rank[worst] >= want;
}

async function cmdDiff(args: string[]): Promise<void> {
  const { opts, cmd } = splitOnDoubleDash(args);
  if (cmd.length === 0) die("usage: mcpgaze diff [--baseline <path>] [--fail-on <sev>] [--update] -- <server command...>");
  const baselinePath = getOpt(opts, "--baseline") ?? "mcpgaze.baseline.json";
  const failOn = hasFlag(opts, "--fail-on-drift") ? "breaking" : getOpt(opts, "--fail-on");

  if (hasFlag(opts, "--update")) {
    const baseline = await snapshot(cmd[0], cmd.slice(1), baselinePath);
    const n = Object.keys(baseline.tools).length;
    process.stdout.write(color.green(`✓ baseline updated`) + ` — ${n} tool(s) accepted into ${baselinePath}\n`);
    return;
  }

  const result = await diff(cmd[0], cmd.slice(1), baselinePath);

  if (result.changes.length === 0) {
    process.stdout.write(color.green("✓ no drift — tool surface matches the baseline\n"));
    return;
  }

  const badge: Record<Severity, string> = {
    breaking: color.red("BREAKING"),
    warning: color.yellow("WARNING "),
    info: color.blue("INFO    "),
  };
  process.stdout.write(color.bold(`Found ${result.changes.length} change(s):\n`));
  for (const c of result.changes) {
    process.stdout.write(`  ${badge[c.severity]}  ${color.bold(c.path)} — ${c.message}\n`);
  }

  const worst = worstSeverity(result.changes);
  if (thresholdMet(worst, failOn)) {
    process.stderr.write(color.red(`\n✗ drift at/above '${failOn}' — failing.\n`));
    process.exit(1);
  }
}

const SEV_BADGE: Record<Severity, string> = {
  breaking: color.red("BREAKING"),
  warning: color.yellow("WARNING "),
  info: color.blue("INFO    "),
};

async function cmdConform(args: string[]): Promise<void> {
  const { opts, cmd } = splitOnDoubleDash(args);
  if (cmd.length === 0) die("usage: mcpgaze conform [--spec <ver>|--all] [--json] -- <server command...>");
  const specs = hasFlag(opts, "--all")
    ? [...KNOWN_SPEC_VERSIONS]
    : [getOpt(opts, "--spec") ?? KNOWN_SPEC_VERSIONS[0]];

  const reports = [];
  for (const spec of specs) reports.push(await conform(cmd[0], cmd.slice(1), spec));

  if (hasFlag(opts, "--json")) {
    process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  } else {
    const mark: Record<string, string> = {
      pass: color.green("✓"),
      fail: color.red("✗"),
      warn: color.yellow("⚠"),
      skip: color.dim("∘"),
    };
    for (const r of reports) {
      process.stdout.write(
        color.bold(`\nProtocol ${r.protocolVersion}`) +
          color.dim(` (server reports ${r.serverProtocolVersion ?? "?"})\n`),
      );
      for (const c of r.results) {
        const lvl = c.level === "required" ? "" : color.dim(" (recommended)");
        process.stdout.write(`  ${mark[c.status]} ${c.title}${lvl} — ${color.dim(c.detail)}\n`);
      }
      process.stdout.write(r.passed ? color.green("  PASS\n") : color.red("  FAIL\n"));
    }
  }
  if (reports.some((r) => !r.passed)) process.exit(1);
}

async function cmdVerify(args: string[]): Promise<void> {
  const { opts, cmd } = splitOnDoubleDash(args);
  const cassette = getOpt(opts, "--cassette");
  if (!cassette || cmd.length === 0) die("usage: mcpgaze verify --cassette <file> [--update] -- <server command...>");

  if (hasFlag(opts, "--update")) {
    const n = await updateCassette(cmd[0], cmd.slice(1), cassette);
    process.stdout.write(color.green(`✓ cassette re-baselined`) + ` — ${n} response(s) accepted into ${cassette}\n`);
    return;
  }

  const failOn = getOpt(opts, "--fail-on");
  const r = await verify(cmd[0], cmd.slice(1), cassette);
  process.stdout.write(color.dim(`re-issued ${r.checked} recorded request(s)\n`));
  for (const e of r.errors) process.stdout.write(`  ${color.red("ERROR   ")}  ${color.bold(e.method)} — ${e.message}\n`);

  if (r.changes.length === 0 && r.errors.length === 0) {
    process.stdout.write(color.green("✓ no behavioral drift — response shapes match the cassette\n"));
    return;
  }
  for (const c of r.changes) {
    process.stdout.write(`  ${SEV_BADGE[c.severity]}  ${color.bold(c.path)} — ${c.message}\n`);
  }
  const worst = worstSeverity(r.changes);
  if (thresholdMet(worst, failOn) || (failOn && r.errors.length > 0)) {
    process.stderr.write(color.red(`\n✗ behavioral drift at/above '${failOn}' — failing.\n`));
    process.exit(1);
  }
}

async function cmdHealth(args: string[]): Promise<void> {
  const { opts, cmd } = splitOnDoubleDash(args);
  if (cmd.length === 0) die("usage: mcpgaze health [--interval <sec>] [--once] [--status <path>] -- <server command...>");
  const once = hasFlag(opts, "--once");
  const intervalMs = Number(getOpt(opts, "--interval") ?? "60") * 1000;
  const statusPath = getOpt(opts, "--status") ?? ".mcpgaze/health.json";

  if (!once) {
    process.stderr.write(
      color.dim(`[mcpgaze] health-checking every ${intervalMs / 1000}s · status → ${statusPath} · Ctrl-C to stop\n`),
    );
  }
  const last = await runHealthDaemon(cmd[0], cmd.slice(1), {
    once,
    intervalMs,
    statusPath,
    onCheck: (c) => {
      if (!once) {
        const stamp = color.dim(new Date(c.at).toLocaleTimeString());
        process.stderr.write(
          c.ok
            ? `${stamp} ${color.green("UP")}   ${c.toolCount} tools · ${c.latencyMs}ms\n`
            : `${stamp} ${color.red("DOWN")} ${c.error ?? ""}\n`,
        );
      }
    },
    onTransition: (msg) => process.stderr.write(color.bold(`  ⟫ ${msg}\n`)),
  });

  if (once) {
    process.stdout.write(
      last.ok
        ? color.green(`✓ UP`) + ` — ${last.toolCount} tools, ${last.latencyMs}ms\n`
        : color.red(`✗ DOWN`) + ` — ${last.error ?? "unresponsive"}\n`,
    );
    process.exit(last.ok ? 0 : 1);
  }
}

async function cmdTriage(args: string[]): Promise<void> {
  const { opts } = splitOnDoubleDash(args);
  const logPath = getOpt(opts, "--log");
  if (!logPath) die("usage: mcpgaze triage --log <session.jsonl> [--ai] [--model <name>]");
  const report = await triage(logPath, {
    useAi: hasFlag(opts, "--ai"),
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: getOpt(opts, "--model") ?? process.env.MCPGAZE_TRIAGE_MODEL,
  });

  if (report.failures.length === 0) {
    process.stdout.write(color.green("✓ no failure signals in this session\n"));
    return;
  }
  process.stdout.write(color.bold(`Found ${report.failures.length} failure signal(s):\n`));
  for (const f of report.failures) {
    process.stdout.write(`  ${color.red("•")} ${color.bold(f.kind)} — ${f.summary}\n`);
    if (f.detail) process.stdout.write(color.dim(`      ${f.detail}\n`));
  }
  if (report.aiDiagnosis) {
    process.stdout.write(color.bold("\n── Claude's triage ──\n") + report.aiDiagnosis + "\n");
  } else if (report.aiSkippedReason) {
    process.stdout.write(color.dim(`\n(AI triage skipped: ${report.aiSkippedReason})\n`));
  }
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case "wrap":
      return cmdWrap(rest);
    case "wrap-http":
      return cmdWrapHttp(rest);
    case "record":
      return cmdRecord(rest);
    case "replay":
      return cmdReplay(rest);
    case "snapshot":
      return cmdSnapshot(rest);
    case "diff":
      return cmdDiff(rest);
    case "conform":
      return cmdConform(rest);
    case "verify":
      return cmdVerify(rest);
    case "triage":
      return cmdTriage(rest);
    case "health":
      return cmdHealth(rest);
    case "preflight":
      return cmdPreflight(rest);
    case "-v":
    case "--version":
      process.stdout.write(VERSION + "\n");
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      die(`unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(color.red(`error: ${(e as Error).message}`) + "\n");
  process.exit(1);
});
