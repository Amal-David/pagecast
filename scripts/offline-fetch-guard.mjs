// Verification-only guard: fail rather than sending test traffic off-loopback.
const realFetch = globalThis.fetch;
let blocked = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "data:" && !["127.0.0.1", "localhost", "[::1]", "pagecast.localhost"].includes(url.hostname)) {
    blocked++;
    process.stderr.write(`Blocked outbound test request to ${url.origin}\n`);
    throw new Error("Offline verification blocked external fetch.");
  }
  return realFetch(input, init);
};
process.on("exit", () => { if (blocked) process.exitCode = 1; });
