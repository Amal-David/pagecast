import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import { request } from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPagecastTools } from "../src/ai/index.js";
import { createPagecastAiMcpServer } from "../src/ai/mcp.js";
import { startPagecastReadOnlyHttp } from "../src/ai/http.js";

const token = "synthetic_fixture_only_not_a_real_secret_0123456789";
function core(options = {}) {
  return createPagecastTools({ server: { callTool: async (name) => ({ content: [{ type: "text", text: JSON.stringify(name === "list_pages" ? { reports: [] } : { configured: true }) }] }) }, ...options });
}
const makeClient = () => new Client({ name: "pagecast-fixture", version: "1.0.0" });

test("official MCP client initializes, discovers schemas and executes structured results", async (t) => {
  const server = createPagecastAiMcpServer(core()); const client = makeClient();
  const [a,b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a); await client.connect(b);
  const tools = await client.listTools(); ListToolsResultSchema.parse(tools);
  assert.equal(tools.tools.length, 2);
  const result = await client.callTool({ name: "pagecast_status", arguments: {} }); CallToolResultSchema.parse(result);
  assert.equal(result.structuredContent.ok, true); assert.equal(result.isError, false);
  const denied = await client.callTool({ name: "pagecast_publish_content", arguments: {} });
  assert.equal(denied.isError, true);
});

test("real stdio subprocess lists tools and reads an isolated empty store without creating it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-ai-stdio-"));
  const dataDir = path.join(root, "absent");
  const client = makeClient();
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("src/ai/stdio.js"), "--data-dir", dataDir], stderr: "pipe", env: { PAGECAST_TELEMETRY: "0", DO_NOT_TRACK: "1" } });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 2);
  const result = await client.callTool({ name: "pagecast_list_pages", arguments: {} });
  assert.deepEqual(result.structuredContent.data, { reports: [], total: 0, nextOffset: null });
  await assert.rejects(fs.access(dataDir), { code: "ENOENT" });
});

test("HTTP refuses unsafe setup", async () => {
  await assert.rejects(startPagecastReadOnlyHttp({ core: core(), token: "short" }), /bearer/);
  await assert.rejects(startPagecastReadOnlyHttp({ core: core(), token, allowedOrigins: ["*"] }), /origins/);
  await assert.rejects(startPagecastReadOnlyHttp({ core: core({ allowMutations: true, authorize: async () => true }), token }), /read-only/);
});

test("official Streamable HTTP client works on loopback with auth and cannot mutate", async (t) => {
  const gateway = await startPagecastReadOnlyHttp({ core: core(), token });
  const client = makeClient();
  t.after(async () => { await client.close(); await gateway.close(); });
  assert.equal(gateway.server.address().address, "127.0.0.1");
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal((await client.listTools()).tools.length, 2);
  assert.equal((await client.callTool({ name: "pagecast_status", arguments: {} })).structuredContent.data.configured, true);
  assert.equal((await client.callTool({ name: "pagecast_revoke_publication", arguments: { token: "fixture" } })).isError, true);
});

test("HTTP enforces authorization, host, origin, route, media type and request bounds", async (t) => {
  const gateway = await startPagecastReadOnlyHttp({ core: core(), token }); t.after(() => gateway.close());
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const post = (changes = {}) => fetch(gateway.url, { method: "POST", headers, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', ...changes });
  assert.equal((await post({ headers: {} })).status, 401);
  assert.equal((await post({ headers: { ...headers, Authorization: "Bearer wrong" } })).status, 401);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(gateway.url, { method: "POST", headers: { ...headers, Host: "attacker.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end("{}");
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post({ headers: { ...headers, Origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await post({ headers: { ...headers, Origin: "null" } })).status, 403);
  assert.equal((await post({ headers: { ...headers, "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await post({ body: "not json" })).status, 400);
  assert.equal((await post({ body: "[]" })).status, 400);
  assert.equal((await post({ body: '"' + "x".repeat(65536) + '"' })).status, 413);
  assert.equal((await fetch(gateway.url + "?token=ignored", { method: "POST", headers, body: "{}" })).status, 404);
  assert.equal((await fetch(gateway.url, { headers })).status, 405);
  const response = await post();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("HTTP exact origin allowlist still requires auth", async (t) => {
  const gateway = await startPagecastReadOnlyHttp({ core: core(), token, allowedOrigins: ["http://localhost:3000"] }); t.after(() => gateway.close());
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  const headers = { Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  assert.equal((await fetch(gateway.url, { method: "POST", headers, body })).status, 200);
  delete headers.Authorization;
  assert.equal((await fetch(gateway.url, { method: "POST", headers, body })).status, 401);
});
