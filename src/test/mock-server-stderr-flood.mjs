// Mock MCP server that floods its OWN stderr forever and survives EPIPE on it.
// Used to exercise the proxy's stderr mirror path (proxy.ts:135-138). Because it
// ignores its own stderr write errors and never exits on its own, any non-zero
// exit of the proxy can only come from the PROXY crashing, not the child.
process.stderr.on("error", () => {});
process.stdout.on("error", () => {});
const big = Buffer.alloc(65536, 0x41); // 64 KiB of 'A'
(function spray() {
  for (let i = 0; i < 100; i++) {
    try {
      process.stderr.write(big);
    } catch {
      /* ignore */
    }
  }
  setImmediate(spray);
})();
// Keep the process alive (acts like a server waiting on stdin).
process.stdin.resume();
