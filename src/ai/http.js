import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPagecastAiMcpServer } from "./mcp.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const READ_ONLY_TOOLS = new Set(["pagecast_status", "pagecast_list_pages"]);

/**
 * Single-account, loopback-only, read-only MCP gateway. Not a hosted backend.
 * No proxy-header trust, CORS, credential generation or anonymous mode.
 * Production OAuth, TLS, tenant isolation and deployment are separate gates.
 */
export async function startPagecastReadOnlyHttp({ core, token, port = 0, allowedOrigins = [] }) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new TypeError("Supply an existing 32–256 character bearer token via the trusted host.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("Invalid port.");
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => {
    try { const parsed = new URL(origin); return !["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin; } catch { return true; }
  })) throw new TypeError("Allowed origins must be exact HTTP(S) origins.");
  const origins = new Set(allowedOrigins);
  const catalog = core.listTools();
  if (catalog.some((tool) => !READ_ONLY_TOOLS.has(tool.name) || tool.annotations?.readOnlyHint !== true)) throw new TypeError("The HTTP gateway accepts only Pagecast read-only tools.");
  // Freeze an allowlist here as well as in the core. A later mutable catalog
  // cannot turn this gateway into an internet-to-local mutation bridge.
  const restricted = {
    listTools: () => structuredClone(catalog),
    execute: (name, args) => READ_ONLY_TOOLS.has(name) ? core.execute(name, args) : Promise.resolve({ ok: false, error: { code: "unknown_tool", message: "Tool is disabled on the read-only gateway." } })
  };
  const expected = Buffer.from(`Bearer ${token}`);
  let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const reject = (status, message) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: message })); };
    const address = server.address();
    if (req.headers.host !== `127.0.0.1:${address.port}`) return reject(403, "Invalid host.");
    if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) return reject(403, "Invalid origin.");
    const supplied = Buffer.from(req.headers.authorization || "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reject(401, "Unauthorized.");
    if (req.url !== "/mcp") return reject(404, "Not found.");
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return reject(405, "Only POST is supported."); }
    if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return reject(415, "Expected JSON.");
    if (active >= 8) return reject(429, "Too many active requests.");
    active++;
    let mcp;
    try {
      const parts = []; let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > MAX_REQUEST_BYTES) { reject(413, "Request exceeds 64 KiB."); return; }
        parts.push(part);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { reject(400, "Invalid JSON."); return; }
      if (Array.isArray(body)) { reject(400, "JSON-RPC batches are unsupported."); return; }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      mcp = createPagecastAiMcpServer(restricted);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) reject(500, "MCP request failed."); else res.end();
    } finally { active--; if (mcp) await mcp.close().catch(() => {}); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.timeout = 30000;
  server.maxConnections = 32;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
