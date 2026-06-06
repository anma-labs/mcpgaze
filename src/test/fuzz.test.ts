import { test } from "node:test";
import assert from "node:assert/strict";
import { LineFramer, type FramedMessage } from "../framer";
import { SseParser } from "../sse";

// Seeded PRNG (mulberry32) so any failure is reproducible from the seed.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GLYPHS = [..."abc {}\":,[]0123456789 \t\r🐱😀é中"]; // ASCII, ws, CR, multibyte

function randomLine(rand: () => number): string {
  const len = Math.floor(rand() * 40);
  let s = "";
  for (let i = 0; i < len; i++) s += GLYPHS[Math.floor(rand() * GLYPHS.length)];
  return s.replace(/\n/g, ""); // a line, by definition, has no embedded newline
}

function randomDoc(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 8);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(randomLine(rand));
  let doc = lines.join("\n");
  if (rand() < 0.5) doc += "\n"; // sometimes a trailing newline (last line complete)
  return doc;
}

function frameWhole(doc: string): string[] {
  const out: string[] = [];
  const f = new LineFramer((m: FramedMessage) => out.push(m.raw), "s2c");
  f.push(Buffer.from(doc, "utf8"));
  return out;
}

function frameChunked(doc: string, rand: () => number): string[] {
  const buf = Buffer.from(doc, "utf8");
  const out: string[] = [];
  const f = new LineFramer((m: FramedMessage) => out.push(m.raw), "s2c");
  let i = 0;
  while (i < buf.length) {
    const remaining = buf.length - i;
    const size = 1 + Math.floor(rand() * Math.max(1, Math.min(remaining, 7)));
    f.push(buf.subarray(i, i + size)); // may split a multibyte char mid-sequence
    i += size;
  }
  return out;
}

test("FUZZ: framing is invariant to chunk boundaries", () => {
  const rand = rng(0xc0ffee);
  for (let trial = 0; trial < 3000; trial++) {
    const doc = randomDoc(rand);
    const whole = frameWhole(doc);
    const chunked = frameChunked(doc, rand);
    assert.deepEqual(chunked, whole, `chunk-variance at trial ${trial} for doc ${JSON.stringify(doc)}`);
  }
});

test("FUZZ: framer never throws on adversarial raw bytes", () => {
  const rand = rng(0xbadbeef);
  for (let trial = 0; trial < 2000; trial++) {
    const len = Math.floor(rand() * 200);
    const bytes = Buffer.alloc(len);
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(rand() * 256); // includes invalid UTF-8, NULs
    const f = new LineFramer(() => {}, "c2s");
    assert.doesNotThrow(() => {
      // feed in random sub-chunks
      let i = 0;
      while (i < bytes.length) {
        const size = 1 + Math.floor(rand() * 9);
        f.push(bytes.subarray(i, i + size));
        i += size;
      }
      f.push(Buffer.from("\n")); // force a flush
    });
  }
});

test("FUZZ: framer handles a 2MB single line without crashing or mis-splitting", () => {
  const big = "x".repeat(2 * 1024 * 1024);
  const out: string[] = [];
  const f = new LineFramer((m) => out.push(m.raw), "s2c");
  // feed in 64KB chunks, no newline until the very end
  for (let i = 0; i < big.length; i += 65536) f.push(Buffer.from(big.slice(i, i + 65536)));
  assert.equal(out.length, 0); // no newline yet -> nothing emitted
  f.push(Buffer.from("\n"));
  assert.equal(out.length, 1);
  assert.equal(out[0].length, big.length);
});

test("FUZZ: SSE parsing is invariant to chunk boundaries", () => {
  const rand = rng(0x5e5e);
  for (let trial = 0; trial < 2000; trial++) {
    const events = 1 + Math.floor(rand() * 5);
    let doc = "";
    const expected: string[] = [];
    for (let e = 0; e < events; e++) {
      const data = randomLine(rand).replace(/\r/g, ""); // CR handled separately by SSE
      expected.push(data);
      doc += `data: ${data}\n\n`;
    }
    const whole: string[] = [];
    new SseParser((d) => whole.push(d)).push(doc); // reference: ignored, we compare chunked vs expected

    const buf = Buffer.from(doc, "utf8");
    const chunked: string[] = [];
    const p = new SseParser((d) => chunked.push(d));
    let i = 0;
    while (i < buf.length) {
      const size = 1 + Math.floor(rand() * 6);
      p.push(buf.subarray(i, i + size));
      i += size;
    }
    // empty-data events are dropped by the parser; filter expected accordingly
    assert.deepEqual(chunked, expected.filter((d) => d.trim() !== ""), `SSE chunk-variance at trial ${trial}`);
  }
});
