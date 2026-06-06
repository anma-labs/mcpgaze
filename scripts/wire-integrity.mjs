// Wire-integrity fuzz: forward random BINARY payloads through `wrap` and assert
// the bytes emitted on the wire are identical to what the child produced.
import { spawn } from "node:child_process";

function rng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const rand = rng(0x1337);

function wrapAndCapture(payloadB64) {
  return new Promise((resolve) => {
    // child writes the exact bytes to stdout then exits; proxy must forward verbatim
    const childExpr = `process.stdout.write(Buffer.from(process.argv[1],'base64'))`;
    const p = spawn("node", ["dist/index.js","wrap","--log","/tmp/wi.jsonl","--","node","-e",childExpr,payloadB64], { stdio:["ignore","pipe","ignore"] });
    const chunks = [];
    p.stdout.on("data", (c) => chunks.push(c));
    p.on("exit", () => resolve(Buffer.concat(chunks)));
  });
}

let fails = 0;
for (let trial = 0; trial < 25; trial++) {
  const len = Math.floor(rand() * 4096);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = Math.floor(rand() * 256); // arbitrary binary incl. NULs, newlines, invalid UTF-8
  const out = await wrapAndCapture(payload.toString("base64"));
  if (Buffer.compare(out, payload) !== 0) { fails++; console.log(`  trial ${trial}: MISMATCH (len ${len}, got ${out.length})`); }
}
console.log(fails === 0 ? "✓ 25/25 random binary payloads forwarded byte-exact through the proxy" : `✗ ${fails} mismatch(es)`);
process.exit(fails === 0 ? 0 : 1);
