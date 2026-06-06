//! mcpgaze-proxy — the native hot-path for `mcpgaze wrap`.
//!
//! A zero-dependency (std-only) transparent stdio proxy. It spawns the real MCP
//! server and sits between it and the client, forwarding bytes UNTOUCHED on each
//! direction and emitting an observation log on a side channel — the same
//! invariant as the TypeScript proxy, in a single static binary with no Node
//! runtime required.
//!
//! Scope note: this hot-path does forward + capture with best-effort, allocation
//! -light JSON-RPC classification. Rich id-correlation/latency and the full
//! command surface remain in the Node CLI, which can post-process this JSONL
//! (the event schema is identical, so `mcpgaze triage` consumes it directly).

use std::env;
use std::fs::OpenOptions;
use std::io::{self, BufWriter, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

type Log = Arc<Mutex<BufWriter<std::fs::File>>>;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// One single-pass scan of a wire line, modelling the same view the Node proxy's
/// JSON parser has: only TOP-LEVEL object keys count.
///
/// History: the original classifier was three whole-line substring tests
/// (`line.contains("\"method\"")` etc.). That misfired whenever a key token
/// appeared inside a string VALUE, a NESTED object, or a batch ARRAY element, and
/// counted `id:null` as an id and a response without its `result`/`error` key as a
/// response — diverging from the Node observer (a differential audit found 88 such
/// kind disagreements on well-formed lines; see scripts/diff-proxies.mjs --corpus
/// and KNOWN-ISSUES.md). This scanner is still parse-free, allocation-light,
/// std-only and panic-free on arbitrary `&str` (char-safe, O(n)); it does NOT
/// JSON-parse, does NOT decode `\uXXXX` key/value escapes, and never validates
/// JSON grammar — the residual escaped-key / escaped-value / malformed drift is
/// documented and accepted.
struct TopLevel {
    is_object: bool, // first non-ws char is '{'
    is_array: bool,  // first non-ws char is '[' (a batch -> "unknown", as Node sees an Array)
    has_method: bool,
    has_id: bool,
    id_is_null: bool, // value of the LAST top-level "id" key is the literal null
    has_result: bool,
    has_error: bool,
    /// Raw (un-decoded) string value of the LAST top-level "method" key, or None
    /// if absent / non-string. Escapes are kept verbatim — decoding them needs the
    /// JSON string parser this hot-path deliberately omits.
    method_value: Option<String>,
}

fn recognize(k: &str) -> Option<&'static str> {
    match k {
        "method" => Some("method"),
        "id" => Some("id"),
        "result" => Some("result"),
        "error" => Some("error"),
        _ => None,
    }
}

/// Read the JSON string at value position `v` (the text just after a `:`),
/// returning its raw content with escape sequences KEPT verbatim, or None if the
/// value is not a string. Mirrors the old `string_field` value semantics exactly.
fn read_json_string(v: &str) -> Option<String> {
    let body = v.trim_start().strip_prefix('"')?;
    let mut result = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                result.push(c);
                if let Some(n) = chars.next() {
                    result.push(n);
                }
            }
            '"' => return Some(result),
            _ => result.push(c),
        }
    }
    None
}

fn scan_top_level(line: &str) -> TopLevel {
    let mut t = TopLevel {
        is_object: false,
        is_array: false,
        has_method: false,
        has_id: false,
        id_is_null: false,
        has_result: false,
        has_error: false,
        method_value: None,
    };

    // Phase 1: the first non-whitespace char decides the container type.
    match line.chars().find(|c| !c.is_whitespace()) {
        Some('{') => t.is_object = true,
        Some('[') => {
            t.is_array = true;
            return t;
        }
        _ => return t, // scalar / empty -> neither object nor array -> "unknown"
    }

    // Phase 2: walk the body. depth 1 == directly inside the top-level object.
    // A quoted token is a KEY only at depth 1 while we `expect_key`; after a
    // recognized key + ':' we peek the value (id's null-ness, method's string).
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut esc = false;
    let mut expect_key = false;
    let mut reading_key = false;
    let mut cur_key = String::new(); // single reused buffer
    let mut pending_key: Option<&'static str> = None;

    for (i, c) in line.char_indices() {
        if in_str {
            if esc {
                esc = false;
                if reading_key {
                    cur_key.push(c);
                }
                continue;
            }
            match c {
                '\\' => {
                    esc = true;
                    if reading_key {
                        cur_key.push(c);
                    }
                }
                '"' => {
                    in_str = false;
                    if reading_key {
                        reading_key = false;
                        if let Some(name) = recognize(&cur_key) {
                            match name {
                                "method" => t.has_method = true,
                                "id" => t.has_id = true,
                                "result" => t.has_result = true,
                                "error" => t.has_error = true,
                                _ => {}
                            }
                            pending_key = Some(name);
                        } else {
                            pending_key = None;
                        }
                        expect_key = false; // now expect ':' then a value
                    }
                }
                _ => {
                    if reading_key {
                        cur_key.push(c);
                    }
                }
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                if depth == 1 && expect_key {
                    reading_key = true;
                    cur_key.clear();
                }
            }
            '{' => {
                depth += 1;
                if depth == 1 {
                    expect_key = true;
                }
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            '[' => depth += 1,
            ']' => depth -= 1,
            ':' => {
                if depth == 1 {
                    if let Some(name) = pending_key.take() {
                        let val = &line[i + 1..]; // ':' is 1 byte -> i+1 is a char boundary
                        if name == "id" {
                            // Assign (not OR): the LAST top-level id wins, like JSON.parse.
                            t.id_is_null = val.trim_start().starts_with("null");
                        } else if name == "method" {
                            t.method_value = read_json_string(val);
                        }
                    }
                }
            }
            ',' => {
                if depth == 1 {
                    expect_key = true;
                    pending_key = None;
                }
            }
            _ => {}
        }
    }

    t
}

/// Classify a wire line exactly as the Node proxy's `classify()` would (modulo the
/// documented parse-free residuals): only top-level fields count, `id:null` is NOT
/// an id (but `id:0` is), and response/error require their key to be PRESENT.
fn classify(t: &TopLevel) -> &'static str {
    if t.is_array || !t.is_object {
        return "unknown"; // top-level array (batch) or non-object -> unknown, as Node sees it
    }
    let id = t.has_id && !t.id_is_null;
    if t.has_method && id {
        "request"
    } else if t.has_method && !id {
        "notification"
    } else if !t.has_method && id && t.has_error {
        "error"
    } else if !t.has_method && id && t.has_result {
        "response"
    } else {
        "unknown"
    }
}

fn write_line(log: &Log, s: &str) {
    if let Ok(mut g) = log.lock() {
        let _ = g.write_all(s.as_bytes());
        let _ = g.flush();
    }
}

fn log_message(log: &Log, dir: &str, line: &str) {
    let t = scan_top_level(line);
    let kind = classify(&t);
    let method = match &t.method_value {
        Some(m) => format!("\"{}\"", json_escape(m)),
        None => "null".to_string(),
    };
    let ev = format!(
        "{{\"t\":{},\"type\":\"message\",\"dir\":\"{}\",\"kind\":\"{}\",\"method\":{},\"raw\":\"{}\"}}\n",
        now_ms(),
        dir,
        kind,
        method,
        json_escape(line),
    );
    write_line(log, &ev);
}

/// Upper bound on the observation accumulator. A peer streaming bytes with no
/// '\n' would otherwise grow `acc` without limit until allocation fails; with
/// `panic = "abort"` that aborts (SIGABRT) the whole proxy — the observer
/// crashing the wire. A real MCP message is tiny, so past this cap we discard the
/// over-long line and resync at the next newline. The bytes are already forwarded.
const MAX_LINE: usize = 1024 * 1024; // 1 MiB

/// Forward bytes from `src` to `dst` UNTOUCHED, then observe complete lines.
/// The forward write happens before any observation work.
fn pump<R: Read + Send + 'static, W: Write + Send + 'static>(
    mut src: R,
    mut dst: W,
    dir: &'static str,
    log: Log,
) {
    let mut buf = [0u8; 65536];
    let mut acc: Vec<u8> = Vec::new();
    let mut overflow = false; // discarding an over-long, newline-free line
    loop {
        match src.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if dst.write_all(&buf[..n]).is_err() {
                    break;
                }
                let _ = dst.flush();
                if overflow {
                    // Forwarding already happened; find the resync point and drop
                    // everything up to (and including) the next newline.
                    match buf[..n].iter().position(|&b| b == b'\n') {
                        Some(pos) => {
                            overflow = false;
                            acc.extend_from_slice(&buf[pos + 1..n]);
                        }
                        None => continue,
                    }
                } else {
                    acc.extend_from_slice(&buf[..n]);
                }
                while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = acc.drain(..=pos).collect();
                    let text = String::from_utf8_lossy(&line[..line.len() - 1]);
                    // Trim like JS String.prototype.trim(), which also strips the
                    // U+FEFF BOM (Rust's str::trim does not) — keeps the recorded
                    // `raw` identical across the Node and Rust proxies.
                    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
                    if !trimmed.is_empty() {
                        log_message(&log, dir, trimmed);
                    }
                }
                if !overflow && acc.len() > MAX_LINE {
                    overflow = true;
                    acc = Vec::new(); // free the buffer; resync at the next newline
                }
            }
            Err(_) => break,
        }
    }
}

fn pump_stderr<R: Read + Send + 'static>(mut src: R, log: Log) {
    let mut buf = [0u8; 65536];
    loop {
        match src.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let _ = io::stderr().write_all(&buf[..n]);
                let text = String::from_utf8_lossy(&buf[..n]);
                let ev = format!(
                    "{{\"t\":{},\"type\":\"server_stderr\",\"text\":\"{}\"}}\n",
                    now_ms(),
                    json_escape(&text),
                );
                write_line(&log, &ev);
            }
            Err(_) => break,
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let sep = args.iter().position(|a| a == "--");
    let (opts, cmd) = match sep {
        Some(i) => (&args[1..i], &args[i + 1..]),
        None => {
            eprintln!("usage: mcpgaze-proxy [--log <path>] -- <server command...>");
            std::process::exit(2);
        }
    };
    if cmd.is_empty() {
        eprintln!("usage: mcpgaze-proxy [--log <path>] -- <server command...>");
        std::process::exit(2);
    }
    let mut log_path = String::from(".mcpgaze/session.jsonl");
    let mut it = opts.iter();
    while let Some(o) = it.next() {
        if o == "--log" {
            if let Some(p) = it.next() {
                log_path = p.clone();
            }
        }
    }

    if let Some(parent) = std::path::Path::new(&log_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .unwrap_or_else(|e| {
            eprintln!("mcpgaze-proxy: cannot open log {log_path}: {e}");
            std::process::exit(1);
        });
    let log: Log = Arc::new(Mutex::new(BufWriter::new(file)));

    let mut child = match Command::new(&cmd[0])
        .args(&cmd[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            write_line(
                &log,
                &format!(
                    "{{\"t\":{},\"type\":\"note\",\"code\":\"spawn-error\",\"detail\":\"{}\"}}\n",
                    now_ms(),
                    json_escape(&e.to_string())
                ),
            );
            eprintln!("mcpgaze-proxy: spawn failed: {e}");
            std::process::exit(127);
        }
    };

    let child_stdin = child.stdin.take().expect("stdin");
    let child_stdout = child.stdout.take().expect("stdout");
    let child_stderr = child.stderr.take().expect("stderr");

    // client -> server (detached: blocks on our stdin; process exit reaps it)
    {
        let log = Arc::clone(&log);
        thread::spawn(move || pump(io::stdin(), child_stdin, "c2s", log));
    }
    // server -> client (joined so we flush all wire bytes before exit)
    let out_handle = {
        let log = Arc::clone(&log);
        thread::spawn(move || pump(child_stdout, io::stdout(), "s2c", log))
    };
    let err_handle = {
        let log = Arc::clone(&log);
        thread::spawn(move || pump_stderr(child_stderr, log))
    };

    let status = child.wait().map(|s| s.code().unwrap_or(0)).unwrap_or(1);
    let _ = out_handle.join();
    let _ = err_handle.join();
    write_line(
        &log,
        &format!(
            "{{\"t\":{},\"type\":\"note\",\"code\":\"server-exit\",\"detail\":\"code={}\"}}\n",
            now_ms(),
            status
        ),
    );
    std::process::exit(status);
}
