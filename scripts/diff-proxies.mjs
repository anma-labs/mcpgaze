// Differential oracle: drive identical traffic through the Node and Rust proxies
// and assert their observation logs agree on raw bytes, direction, and message
// CLASSIFICATION (kind) + extracted method.
//
// Two modes:
//
//   node scripts/diff-proxies.mjs
//       Legacy/`harden` mode. Sends the 4 canonical messages through the real
//       mock MCP server and asserts byte/dir/kind/method agreement. Exits non-zero
//       on any mismatch. (Unchanged behavior so `npm run harden` stays meaningful.)
//
//   node scripts/diff-proxies.mjs --corpus <file|dir> [--report <path>]
//                                 [--repeat N] [--filter <substr>] [--strict]
//       Differential classification mode. Reads a corpus of crafted JSON-RPC
//       wire lines (one JSON object per line: {id,category,line,note,predNode,
//       predRust}), feeds every line through BOTH proxies on the client->server
//       path while wrapping a passthrough sink, then aligns the two observation
//       logs by emit order and reports every case where Node and Rust disagree on
//       (kind | method | raw). Writes a machine-readable report and prints a
//       grouped divergence table. Exits 0 (findings mode) unless --strict.
//
// Why c2s + a sink child: classify() is direction-agnostic and identical for both
// directions, so exercising the client->server path exhausts the classifier while
// giving us total control over the exact bytes that get classified (the sink
// produces no server->client noise). Each non-empty, sub-MAX_LINE, newline-free
// line emits exactly one `message` event in BOTH proxies, so index alignment is
// exact. --repeat re-runs the whole corpus and flags any case whose classification
// is non-deterministic across runs (rules out flaky timing/chunk-boundary
// artifacts before we call a divergence "real").
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, rmSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUST = "native/mcpgaze-proxy/target/release/mcpgaze-proxy";
const NODE_CLI = "dist/index.js";
const MOCK = "src/test/mock-server.mjs";

// A child that swallows stdin and exits cleanly on EOF, emitting nothing on
// stdout (so the only `message` events come from the c2s lines we inject).
const SINK = ["node", "-e", "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0))"];

// MAX observable line for the Rust proxy (see native main.rs). A line larger than
// this is dropped by Rust but kept by Node — a real divergence, but one about
// observation-dropping, not classification; we exclude such lines from the aligned
// classification diff (and report them as excluded) to keep index alignment exact.
const RUST_MAX_LINE = 1024 * 1024;

// ----------------------------------------------------------------------------
// Shared: parse a proxy's JSONL log into comparable message records.
// ----------------------------------------------------------------------------
function messages(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter((e) => e && e.type === "message")
    .map((e) => ({ dir: e.dir, kind: e.kind, method: normMethod(e.method), raw: e.raw }));
}

// Node may log `method` as a string, number, object, array or null; Rust always
// logs a string or null. Normalize to a comparable scalar.
function normMethod(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ----------------------------------------------------------------------------
// Legacy/harden mode: the original 4-message agreement check.
// ----------------------------------------------------------------------------
async function legacyMode() {
  if (!existsSync(RUST)) { console.log("skip: rust binary not built"); process.exit(0); }
  const reqs = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"d","version":"1"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    '{"jsonrpc":"2.0","id":3,"method":"nope/unknown","params":{}}',
  ];
  function drive(cmd, args) {
    return new Promise((r) => {
      const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      p.on("exit", () => r());
      for (const q of reqs) p.stdin.write(q + "\n");
      setTimeout(() => p.stdin.end(), 400);
    });
  }
  rmFresh("/tmp/d-node.jsonl"); rmFresh("/tmp/d-rust.jsonl");
  await drive("node", [NODE_CLI, "wrap", "--log", "/tmp/d-node.jsonl", "--", "node", MOCK]);
  await drive(RUST, ["--log", "/tmp/d-rust.jsonl", "--", "node", MOCK]);
  const n = messages("/tmp/d-node.jsonl"), r = messages("/tmp/d-rust.jsonl");
  let mismatches = 0;
  console.log(`node saw ${n.length} messages, rust saw ${r.length}`);
  const len = Math.min(n.length, r.length);
  for (let i = 0; i < len; i++) {
    const same = n[i].dir === r[i].dir && n[i].raw === r[i].raw && n[i].kind === r[i].kind && n[i].method === r[i].method;
    if (!same) { mismatches++; console.log(`  DIVERGE [${i}] node=${JSON.stringify(n[i])} rust=${JSON.stringify(r[i])}`); }
  }
  if (n.length !== r.length) { mismatches++; console.log("  count mismatch"); }
  console.log(mismatches === 0 ? "✓ Node and Rust proxies agree on every message (raw, dir, kind, method)" : `✗ ${mismatches} divergence(s)`);
  process.exit(mismatches === 0 ? 0 : 1);
}

// ----------------------------------------------------------------------------
// Corpus mode helpers.
// ----------------------------------------------------------------------------
function rmFresh(p) { try { rmSync(p); } catch {} }

function loadCorpus(arg) {
  let files = [];
  const st = statSync(arg);
  if (st.isDirectory()) {
    files = readdirSync(arg).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(arg, f));
  } else {
    files = [arg];
  }
  const cases = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    let lineNo = 0;
    for (const ln of text.split("\n")) {
      lineNo++;
      const s = ln.trim();
      if (!s) continue;
      let obj;
      try { obj = JSON.parse(s); } catch (e) {
        console.error(`! ${f}:${lineNo} not valid JSON corpus entry: ${e.message}`);
        continue;
      }
      if (typeof obj.line !== "string") {
        console.error(`! ${f}:${lineNo} corpus entry missing string "line"`);
        continue;
      }
      cases.push({
        id: obj.id ?? `${obj.category ?? "case"}-${cases.length}`,
        category: obj.category ?? "uncategorized",
        line: obj.line,
        note: obj.note ?? "",
        predNode: obj.predNode ?? null,
        predRust: obj.predRust ?? null,
        source: `${f}:${lineNo}`,
      });
    }
  }
  return cases;
}

// A corpus line is "testable" (yields exactly one aligned message event in both
// proxies) iff it is non-empty after a JS-style trim (which both proxies apply,
// incl. stripping a leading BOM), contains no embedded newline (which would split
// into multiple events), and is within Rust's observable line cap.
function classifyTestability(line) {
  if (line.includes("\n")) return "embedded-newline (multi-line framing, not classification)";
  // JS trim also strips U+FEFF; both proxies normalize this identically.
  const trimmed = line.replace(/^[\s﻿]+|[\s﻿]+$/g, "");
  if (trimmed === "") return "empty-after-trim (both proxies skip)";
  if (Buffer.byteLength(line, "utf8") > RUST_MAX_LINE) return "exceeds-rust-max-line (observation-drop, not classification)";
  return null; // testable
}

function driveCorpus(cmd, args, lines, logPath) {
  rmFresh(logPath);
  const input = lines.map((l) => l + "\n").join("");
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    p.on("error", finish);
    p.on("exit", finish);
    p.stdin.on("error", () => {});
    p.stdin.write(input);
    p.stdin.end();
  }).then(async () => {
    // Filesystem flush grace: the proxy flushes its log before exit, but give the
    // OS a beat before we read it back.
    await new Promise((r) => setTimeout(r, 60));
    return messages(logPath);
  });
}

async function corpusMode(opts) {
  if (!existsSync(RUST)) { console.log("skip: rust binary not built"); process.exit(0); }
  if (!existsSync(NODE_CLI)) { console.log("skip: dist/index.js not built (run npm run build)"); process.exit(0); }

  let cases = loadCorpus(opts.corpus);
  if (opts.filter) cases = cases.filter((c) => String(c.id).includes(opts.filter) || c.category.includes(opts.filter));

  const excluded = [];
  const testable = [];
  for (const c of cases) {
    const reason = classifyTestability(c.line);
    if (reason) excluded.push({ ...c, reason });
    else testable.push(c);
  }

  console.log(`corpus: ${cases.length} cases (${testable.length} testable, ${excluded.length} excluded); repeat=${opts.repeat}`);
  const lines = testable.map((c) => c.line);

  // Run the corpus `repeat` times through each proxy. Run 0 is canonical for the
  // divergence diff; runs 1..N-1 are used only to detect non-determinism.
  //
  // CONCURRENCY SAFETY: each invocation gets its OWN temp dir and each run its OWN
  // log file. The proxies open logs with append mode, so sharing a fixed path
  // across concurrently-running harness invocations (e.g. parallel per-category
  // verifiers) would let one run read another's bytes back — manifesting as bogus
  // "flaky"/alignment noise that is a harness artifact, not classifier behavior.
  const tmpDir = mkdtempSync(join(tmpdir(), "mcpgaze-diff-"));
  const nodeRuns = [], rustRuns = [];
  for (let run = 0; run < opts.repeat; run++) {
    const ln = join(tmpDir, `node-${run}.jsonl`), lr = join(tmpDir, `rust-${run}.jsonl`);
    nodeRuns.push(await driveCorpus("node", [NODE_CLI, "wrap", "--log", ln, "--", ...SINK], lines, ln));
    rustRuns.push(await driveCorpus(RUST, ["--log", lr, "--", ...SINK], lines, lr));
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  // Determinism check: a case is flaky if its (kind,method,raw) differs across
  // runs for the SAME proxy.
  const flaky = [];
  function checkFlaky(runs, who) {
    const base = runs[0];
    for (let run = 1; run < runs.length; run++) {
      const r = runs[run];
      const len = Math.min(base.length, r.length);
      for (let i = 0; i < len; i++) {
        if (base[i].kind !== r[i].kind || base[i].method !== r[i].method || base[i].raw !== r[i].raw) {
          flaky.push({ who, run, index: i, id: testable[i]?.id, base: base[i], got: r[i] });
        }
      }
      if (base.length !== r.length) flaky.push({ who, run, countMismatch: [base.length, r.length] });
    }
  }
  if (opts.repeat > 1) { checkFlaky(nodeRuns, "node"); checkFlaky(rustRuns, "rust"); }

  const node = nodeRuns[0], rust = rustRuns[0];

  // Alignment guard. With only testable lines, both proxies should emit exactly
  // `testable.length` message events in the same order.
  const alignOk = node.length === testable.length && rust.length === testable.length;
  if (!alignOk) {
    console.log(`! alignment warning: testable=${testable.length} node=${node.length} rust=${rust.length} (results may be offset)`);
  }

  const divergences = [];
  const len = Math.min(node.length, rust.length, testable.length);
  for (let i = 0; i < len; i++) {
    const c = testable[i], n = node[i], r = rust[i];
    const cols = [];
    if (n.raw !== r.raw) cols.push("raw");
    if (n.kind !== r.kind) cols.push("kind");
    if (n.method !== r.method) cols.push("method");
    if (cols.length) {
      divergences.push({
        id: c.id, category: c.category, note: c.note, line: c.line,
        predNode: c.predNode, predRust: c.predRust,
        node: { kind: n.kind, method: n.method, raw: n.raw },
        rust: { kind: r.kind, method: r.method, raw: r.raw },
        cols,
      });
    }
  }

  // Group + summarize.
  const byCategory = {};
  for (const d of divergences) {
    (byCategory[d.category] ??= { count: 0, cols: {} }).count++;
    for (const col of d.cols) byCategory[d.category].cols[col] = (byCategory[d.category].cols[col] ?? 0) + 1;
  }

  const report = {
    corpus: opts.corpus,
    counts: {
      cases: cases.length, testable: testable.length, excluded: excluded.length,
      divergences: divergences.length, agreements: len - divergences.length,
      flaky: flaky.length,
    },
    alignOk,
    byCategory,
    divergences,
    excluded: excluded.map((e) => ({ id: e.id, category: e.category, reason: e.reason, line: e.line })),
    flaky,
  };
  if (opts.report) { writeFileSync(opts.report, JSON.stringify(report, null, 2)); console.log(`report -> ${opts.report}`); }

  // Pretty table.
  printTable(divergences);
  console.log("\nby category:");
  for (const [cat, v] of Object.entries(byCategory).sort()) {
    console.log(`  ${cat}: ${v.count} (${Object.entries(v.cols).map(([k, n]) => `${k}:${n}`).join(", ")})`);
  }
  if (excluded.length) {
    console.log(`\nexcluded (${excluded.length}): ${[...new Set(excluded.map((e) => e.reason.split(" ")[0]))].join(", ")}`);
  }
  if (opts.repeat > 1) {
    console.log(flaky.length ? `\n⚠ ${flaky.length} FLAKY observation(s) across ${opts.repeat} runs (non-deterministic!)` : `\n✓ deterministic across ${opts.repeat} runs (no flaky cases)`);
  }
  console.log(`\n${divergences.length} divergence(s) over ${len} testable cases; ${len - divergences.length} agree.`);

  if (opts.strict && divergences.length) process.exit(1);
  process.exit(0);
}

function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function printTable(divs) {
  if (!divs.length) { console.log("\n(no divergences)"); return; }
  console.log("");
  const rows = divs.map((d) => [
    trunc(d.id, 22), trunc(d.cols.join("+"), 14),
    trunc(`${d.node.kind}/${d.node.method ?? "-"}`, 22),
    trunc(`${d.rust.kind}/${d.rust.method ?? "-"}`, 22),
    trunc(d.line, 46),
  ]);
  const head = ["id", "cols", "node kind/method", "rust kind/method", "line"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  console.log(fmt(head));
  console.log(w.map((x) => "-".repeat(x)).join("  "));
  for (const r of rows) console.log(fmt(r));
}

// ----------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const corpus = get("--corpus");
  if (!corpus) return legacyMode();
  return corpusMode({
    corpus,
    report: get("--report"),
    repeat: Math.max(1, Number(get("--repeat") ?? "1")),
    filter: get("--filter"),
    strict: argv.includes("--strict"),
  });
}
main();
