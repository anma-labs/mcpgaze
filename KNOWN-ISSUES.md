# Known Issues

These limitations were identified during pre-release hardening (an adversarial
bug-hunt across every module). Each was **confirmed reproducible** but judged
**not** to violate mcpgaze's two core invariants:

- **Wire integrity** — on the forward path, bytes in == bytes out.
- **Observer safety** — the observation/logging path never throws into the
  protocol stream.

They surface only in narrow circumstances and are consciously deferred for
v1.0. If one of these is blocking you, please open an issue that references it
by number so we can prioritize.

---

## 1. Reused JSON-RPC request ids skew latency/orphan statistics

- **Where:** the request↔response correlator (`wrap`, `wrap-http`) — i.e. the
  per-request latency numbers and orphaned-request notes in the session log.
- **Symptom:** If a server reuses a request `id` while a previous request with
  the same `id` is still in flight, the correlator may attribute a response to
  the wrong request. The derived latency value and any orphan note for those
  ids can be wrong.
- **Why it's not an invariant break:** forwarding remains byte-exact and nothing
  throws — only the *derived statistics* are affected. Every raw message is
  still logged faithfully.
- **Workaround:** reusing an in-flight `id` is discouraged by JSON-RPC, so this
  is rare. When it does occur, treat the latency/orphan fields as best-effort;
  the raw `raw` field in the JSONL is authoritative.
- **Status:** accepted for v1.0.

## 2. First Ctrl-C may not exit immediately in long-running modes

- **Where:** signal handling in long-lived commands (`health --interval`,
  `wrap-http`).
- **Symptom:** under some shutdown timings the first `SIGINT` may not terminate
  the process promptly; a second Ctrl-C exits cleanly.
- **Why it's not an invariant break:** no wire corruption and no thrown error —
  this is a shutdown-latency/UX issue, not a correctness one.
- **Workaround:** press Ctrl-C again, or send `SIGTERM`.
- **Status:** accepted for v1.0; signal-path cleanup is a candidate for a
  follow-up patch.

## 3. `wrap-http`: resource cleanup on abnormal client disconnect (partial)

- **Where:** the Streamable HTTP proxy when a client disconnects mid-stream.
- **Symptom:** if a client drops the connection in the middle of an SSE
  response, some per-request resources may not be reclaimed as promptly as on a
  clean close. Over a very long-lived `wrap-http` session with many abnormal
  disconnects this could show as gradual resource growth.
- **Why it's not an invariant break:** forwarded bytes are unaffected and the
  observer does not throw; this is a lifecycle/cleanup concern.
- **Current mitigation:** the SSE path cancels the upstream reader and guards
  `res` errors, so the common cases are handled; the remaining gap is the
  abnormal-disconnect edge.
- **Status:** partially hardened; full audit of the disconnect lifecycle is a
  follow-up. Restart a long-running `wrap-http` if you observe growth.

## 4. Rust (`--native`) classifier: residual parse-free classification drift

- **Where:** the optional Rust proxy's best-effort, allocation-light message
  classifier (the `kind`/`method` fields it writes to the log).
- **History:** the original classifier substring-matched `"method"` / `"id"` /
  `"error"` *anywhere* on the raw line, so it mislabelled any message that carried
  one of those tokens inside a string value, a nested object, or a batch array
  element, and it mis-handled `id:null` and responses missing their `result`/
  `error` key. A differential audit (`node scripts/diff-proxies.mjs --corpus
  scripts/corpus`, a ~280-line adversarial corpus) found **148** Node↔Rust
  disagreements. The classifier was replaced with a single-pass, still parse-free,
  allocation-light **top-level-key scanner** (`scan_top_level` in `main.rs`) that
  mirrors the Node JSON parser's view, eliminating **all 87 `kind` disagreements
  on well-formed lines** (nested keys, batch arrays, string-value false matches,
  `id:null` vs `id:0`, and `result`/`error` presence). Guarded by
  `src/test/rust-node-classifier-parity.test.ts`.
- **Residual symptom (accepted):** because the scanner deliberately does **not**
  JSON-parse and does **not** decode `\uXXXX` escapes, three narrow classes still
  differ from the Node log:
  1. **Malformed / non-object lines** — invalid JSON (truncated, trailing comma,
     comments, `NaN`, …) and bare falsy literals (`null`, `false`, `0`, `""`)
     that Node marks `unparsed`. A non-validating scanner cannot detect a
     grammar error, so it reports a best-effort `kind` instead.
  2. **`\uXXXX`-escaped key names** — e.g. a key written `"method"`. Node's
     parser decodes the key; the scanner does not, so the key is unrecognized
     (`kind` may differ).
  3. **method-value escape fidelity** — when a top-level `method` value contains
     `\uXXXX` / `\/` / surrogate / control escapes, `kind` agrees but the logged
     `method` keeps the escapes verbatim while Node logs the decoded string.
- **Why it's not an invariant break:** this only affects the *classification
  metadata* in the `--native` log. The forwarded bytes are byte-exact and the
  `raw` field is verbatim, so no information is lost — only the derived `kind`/
  `method` summary may differ on these three classes.
- **Workaround:** the default (Node) proxy classifies by full JSON parse and is
  authoritative; use it when exact classification matters, or re-derive `kind`/
  `method` from the `raw` field (`mcpgaze triage` consumes the `--native` JSONL
  directly). The Node↔Rust differential oracle (`scripts/diff-proxies.mjs
  --corpus scripts/corpus`) tracks exactly where the two still diverge.
- **Status:** accepted; the Rust hot-path intentionally trades full JSON parsing
  for allocation-light speed and the single-binary distribution. Closing any
  residual class would require a JSON string decoder in the hot path.

---

These four were among **9 candidates refuted** by the bug-hunt's adversarial
verifier (the other refutations were not reproducible as real bugs). The **17
confirmed** defects from the same pass were all fixed before release and are
guarded by reproducing tests in `src/test/`. See `CHANGELOG.md` for the
hardening summary.
