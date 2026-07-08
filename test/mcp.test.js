import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPagecastMcpServer } from "../src/mcp.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-mcp-"));
}

function parseToolText(response) {
  return JSON.parse(response.result.content[0].text);
}

test("MCP initialize and tools/list expose Pagecast capabilities", async () => {
  const server = createPagecastMcpServer({ version: "test-version" });

  const initialized = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  });

  assert.equal(initialized.result.serverInfo.name, "pagecast");
  assert.equal(initialized.result.serverInfo.version, "test-version");
  assert.ok(initialized.result.capabilities.tools);
  assert.ok(initialized.result.capabilities.resources);

  const tools = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  });
  const names = tools.result.tools.map((tool) => tool.name);
  assert.deepEqual(
    names,
    [
      "status",
      "list_pages",
      "publish_file",
      "publish_content",
      "revoke_publication"
    ]
  );
});

test("MCP publish_content writes content then reuses the publish helper", async () => {
  const dataDir = await makeTempDir();
  const calls = [];
  const server = createPagecastMcpServer({
    dataDir,
    publishFile: async (input) => {
      calls.push(input);
      return {
        url: "https://pagecast.pages.dev/p/test/",
        token: "test-token",
        label: input.label,
        expiresAt: null
      };
    }
  });

  const response = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "publish_content",
      arguments: {
        content: "# Quarterly Update",
        filename: "../quarterly.md",
        label: "Quarterly Update",
        expires: "7d"
      }
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dataDir, dataDir);
  assert.equal(calls[0].label, "Quarterly Update");
  assert.equal(calls[0].expires, "7d");
  assert.equal(path.basename(calls[0].path), "quarterly.md");
  assert.equal(await fs.readFile(calls[0].path, "utf8"), "# Quarterly Update");

  const payload = parseToolText(response);
  assert.equal(payload.url, "https://pagecast.pages.dev/p/test/");
  assert.equal(payload.sourcePath, calls[0].path);
});

test("MCP publish_content preserves the supplied content string", async () => {
  const dataDir = await makeTempDir();
  const calls = [];
  const server = createPagecastMcpServer({
    dataDir,
    publishFile: async (input) => {
      calls.push(input);
      return { url: "https://pagecast.pages.dev/p/exact/", token: "exact-token" };
    }
  });
  const content = "\n  <h1>Keep my whitespace</h1>\n";

  await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "publish_content",
      arguments: { content, filename: "exact.html" }
    }
  });

  assert.equal(await fs.readFile(calls[0].path, "utf8"), content);
});

test("MCP tool failures are returned as tool errors, not protocol failures", async () => {
  const server = createPagecastMcpServer({
    publishFile: async () => {
      throw new Error("publish failed");
    }
  });

  const response = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "publish_content",
      arguments: { content: "<h1>Report</h1>", filename: "report.html" }
    }
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /publish failed/);
});

test("MCP unknown tools are protocol errors", async () => {
  const server = createPagecastMcpServer();

  const response = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "not_a_tool",
      arguments: {}
    }
  });

  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32601);
});

test("MCP file publishing excludes sibling assets unless explicitly confirmed", async () => {
  const dataDir = await makeTempDir();
  const reportDir = path.join(dataDir, "source");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, "<h1>Report</h1>");
  await fs.writeFile(path.join(reportDir, "secret.txt"), "do not publish");

  const calls = [];
  const server = createPagecastMcpServer({
    dataDir,
    publishFile: async (input) => {
      calls.push(input);
      return { url: "https://pagecast.pages.dev/p/file/", token: "file-token" };
    }
  });

  const isolated = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "publish_file",
      arguments: { path: reportPath }
    }
  });
  assert.equal(isolated.result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].path, reportPath);
  assert.equal(await fs.readFile(calls[0].path, "utf8"), "<h1>Report</h1>");
  assert.equal(parseToolText(isolated).includedAssets, false);

  const blocked = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "publish_file",
      arguments: { path: reportPath, includeAssets: true }
    }
  });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /confirmAssets: true/);
});

test("MCP revoke requires explicit confirmation", async () => {
  const server = createPagecastMcpServer({
    revokePublication: async () => ({
      report: {
        id: "report-1",
        name: "Report",
        kind: "path",
        sourcePath: "/Users/example/secret/report.html",
        buildCommand: "npm run build",
        publicUrl: null,
        passwordProtected: false,
        publications: []
      },
      publication: {
        token: "abc123",
        slug: "report",
        label: "Report",
        kind: "snapshot",
        active: false,
        publicUrl: null,
        revokedAt: "2026-07-08T00:00:00.000Z"
      }
    })
  });

  const revoke = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "revoke_publication",
      arguments: { token: "abc123" }
    }
  });
  assert.equal(revoke.result.isError, true);
  assert.match(revoke.result.content[0].text, /confirm: true/);

  const confirmed = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "revoke_publication",
      arguments: { token: "abc123", confirm: true }
    }
  });
  const payload = parseToolText(confirmed);
  assert.equal(payload.report.sourcePath, undefined);
  assert.equal(payload.report.buildCommand, undefined);
  assert.equal(payload.publication.token, "abc123");
});

test("MCP status and list_pages redact local metadata by default", async () => {
  const server = createPagecastMcpServer({
    getStatus: async () => ({
      cloudflare: {
        loggedIn: true,
        tokenConfigured: true,
        accountName: "Example Org",
        accountId: "abcdef0123456789abcdef0123456789",
        accounts: [{ id: "abcdef0123456789abcdef0123456789", name: "Example Org" }],
        projectName: "pagecast",
        baseUrl: "https://pagecast.pages.dev"
      }
    }),
    createStore: () => ({
      init: async () => {},
      list: () => [
        {
          id: "report-1",
          name: "Report",
          kind: "path",
          sourcePath: "/Users/example/secret/report.html",
          buildCommand: "npm run build",
          publicUrl: "https://pagecast.pages.dev/p/report/",
          passwordProtected: false,
          publications: [
            {
              token: "token-1",
              slug: "report",
              label: "Report",
              kind: "snapshot",
              active: true,
              publicUrl: "https://pagecast.pages.dev/p/report/"
            }
          ]
        }
      ]
    })
  });

  const status = parseToolText(
    await server.handleJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "status", arguments: {} }
    })
  );
  assert.equal(status.accountId, undefined);
  assert.equal(status.accounts, undefined);
  assert.equal(status.accountName, undefined);
  assert.equal(status.projectName, "pagecast");

  const pages = parseToolText(
    await server.handleJsonRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_pages", arguments: {} }
    })
  );
  assert.equal(pages.reports[0].sourcePath, undefined);
  assert.equal(pages.reports[0].buildCommand, undefined);
  assert.equal(pages.reports[0].publications[0].token, "token-1");
});

test("MCP resources/read returns Pagecast page state", async () => {
  const dataDir = await makeTempDir();
  const server = createPagecastMcpServer({ dataDir });

  const response = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri: "pagecast://pages" }
  });

  assert.equal(response.result.contents[0].uri, "pagecast://pages");
  const payload = JSON.parse(response.result.contents[0].text);
  assert.deepEqual(payload.reports, []);
});

test("CLI mcp stdio emits only JSON-RPC on stdout", async () => {
  const dataDir = await makeTempDir();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["src/cli.js", "mcp", "--data-dir", dataDir], {
    cwd: repoRoot,
    env: { ...process.env, PAGECAST_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const lines = stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).id, 1);
  assert.equal(JSON.parse(lines[1]).id, 2);
});
