/**
 * Shared, best-effort secret redaction for the OBSERVER side channels only.
 *
 * INVARIANT (A): this is NEVER applied to the forwarded protocol stream — only
 * to on-disk artifacts (session JSONL, cassettes) and to outbound triage egress.
 * INVARIANT (B): every entry point here is total and fail-safe; on any error the
 * caller falls back to the original value rather than letting the observer throw.
 *
 * The masking is deliberately conservative (it can miss a bespoke secret) but
 * cheap and dependency-free. It is opt-in for at-rest artifacts and always-on
 * for triage egress to an external API.
 */

const MASK = "***REDACTED***";

/** Object keys whose values are almost always credentials. Matched case-insensitively, substring. */
const SECRET_KEY = /(pass(word|wd)?|secret|api[-_]?key|access[-_]?key|token|authorization|auth|bearer|cookie|session|credential|client[-_]?secret|private[-_]?key)/i;

/**
 * Secret-shaped VALUE patterns, used when we only have a flat string (server
 * stderr, an already-stringified JSON-RPC error detail). Ordered most- to
 * least-specific; each replaces only the sensitive token, not the whole line.
 */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // Provider API keys: sk-... / sk-ant-... / AKIA... / ghp_... / xoxb-...
  [/\b(sk-[a-z]+-)?[A-Za-z0-9_-]{16,}\b(?=)/g, ""], // placeholder; real patterns below
];

// Replace the placeholder list with explicit, well-scoped patterns.
VALUE_PATTERNS.length = 0;
VALUE_PATTERNS.push(
  // user:pass@host inside a DSN/URL — keep the user + host, drop the password.
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi, `$1${MASK}$2`],
  // sk-ant-…, sk-…, and similar prefixed provider keys.
  [/\bsk-[A-Za-z0-9-]{8,}\b/g, MASK],
  // AWS-style access key ids and their secret siblings.
  [/\bAKIA[0-9A-Z]{8,}\b/g, MASK],
  [/\b(?:ASIA|AKIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z_-]{8,}\b/g, MASK],
  // GitHub / Slack / generic prefixed tokens.
  [/\b(?:gh[pousr]|xox[baprs])[-_][A-Za-z0-9-]{10,}\b/g, MASK],
  // Bearer <token>.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],
  // JWT-ish three-segment base64url blobs.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, MASK],
);

const MAX_DEPTH = 200; // mirror cassette.ts: bound the recursive walk against pathological nesting.

/** Mask secret-shaped tokens inside a free-form string (stderr, error detail). */
export function redactText(s: string): string {
  if (typeof s !== "string" || s.length === 0) return s;
  try {
    let out = s;
    for (const [re, repl] of VALUE_PATTERNS) out = out.replace(re, repl);
    return out;
  } catch {
    return s; // fail safe: never throw into the observer path.
  }
}

/**
 * Deep-clone `value`, masking the values of credential-named keys and redacting
 * secret-shaped tokens in any string leaves. Returns a NEW value; the original
 * (which is on the wire / in memory for forwarding) is never mutated.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return value;
  if (value === null) return null;
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    out[k] = SECRET_KEY.test(k) ? MASK : redactValue(obj[k], depth + 1);
  }
  return out;
}

/**
 * Redact a verbatim JSON-RPC line: parse → redact params/result → re-serialize.
 * On any parse/serialize failure, fall back to a flat text redaction so a secret
 * is never written through unredacted, and the observer never throws.
 */
export function redactRawJson(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(redactValue(parsed));
  } catch {
    return redactText(raw);
  }
}
