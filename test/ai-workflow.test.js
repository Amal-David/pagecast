import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageAiContent } from "../src/ai/core.js";
import { createPagecastMcpServer } from "../src/mcp.js";
import { createPagecastTools, createOpenAIAdapter } from "../src/ai/index.js";
import { askWithPagecast as openaiLoop } from "../integrations/examples/openai.mjs";
import { askWithPagecast as anthropicLoop } from "../integrations/examples/anthropic.mjs";

test("approved synthetic content traverses the actual MCP publication service boundary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-ai-workflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = [];
  const engine = createPagecastMcpServer({ dataDir: root, workspaceId: "fixture-workspace", writeContentFile: stageAiContent, publishFile: async (input) => {
    captured.push(input);
    assert.equal(await fs.readFile(input.path, "utf8"), "# Synthetic only\n");
    return { url: "https://example.invalid/p/report", token: "fixture-token", sourcePath: input.path };
  } });
  let approved = false;
  const core = createPagecastTools({ server: engine, contextId: "fixture-conversation", allowMutations: true, authorize: async () => approved });
  const adapter = createOpenAIAdapter(core);
  const call = { type: "function_call", call_id: "call-fixture", name: "pagecast_publish_content", arguments: JSON.stringify({ content: "# Synthetic only\n", filename: "report.md", itemKey: "stable-report" }) };
  assert.equal(JSON.parse((await adapter.execute(call)).output).error.code, "approval_required");
  assert.deepEqual(await fs.readdir(root), []);
  approved = true;
  assert.equal(JSON.parse((await adapter.execute(call)).output).ok, true);
  assert.equal(captured[0].contextId, "fixture-conversation");
  assert.equal(captured[0].mode, "upsert");
  assert.equal(captured[0].expires, "7d");
  assert.equal(captured[0].disableProtection, false);
  assert.equal(captured[0].password, "");
});

test("bounded OpenAI example round-trips calls without making a network request", async () => {
  let count = 0;
  const core = createPagecastTools({ server: { callTool: async () => ({ content: [{ type: "text", text: '{"configured":true}' }] }) } });
  const client = { responses: { create: async ({ input }) => {
    count++;
    if (count === 1) return { output: [{ type: "function_call", name: "pagecast_status", arguments: "{}", call_id: "call-1" }] };
    assert.equal(input.at(-1).call_id, "call-1");
    return { output: [{ type: "message", content: [] }] };
  } } };
  assert.equal((await openaiLoop(client, core, { model: "fixture", input: "status" })).output[0].type, "message");
  assert.equal(count, 2);
});

test("Anthropic loop is bounded even when the model keeps asking", async () => {
  let count = 0;
  const core = createPagecastTools({ server: { callTool: async () => ({ content: [{ type: "text", text: '{"configured":true}' }] }) } });
  const client = { messages: { create: async () => { count++; return { content: [{ type: "tool_use", id: `call-${count}`, name: "pagecast_status", input: {} }] }; } } };
  await assert.rejects(anthropicLoop(client, core, { model: "fixture", prompt: "status", maxTurns: 2 }), /turn limit/);
  assert.equal(count, 2);
});

test("portable plugin and per-client configs agree on the read-only entrypoint", async () => {
  const read = async (p) => JSON.parse(await fs.readFile(new URL(p, import.meta.url), "utf8"));
  const manifest = await read("../integrations/plugin/plugin.json");
  const mcp = await read("../integrations/plugin/mcp.json");
  const claude = await read("../integrations/plugin/.mcp.json");
  assert.equal(manifest.name, "pagecast-library");
  assert.deepEqual(manifest.extensions["com.openai"].interface.capabilities, ["Read"]);
  assert.equal(mcp.mcpServers.pagecast.command, "pagecast-ai-mcp");
  assert.equal(mcp.mcpServers.pagecast.type, "stdio");
  assert.deepEqual(claude.mcpServers, mcp.mcpServers);
  for (const client of ["claude-desktop", "claude-code", "cursor", "gemini-cli", "vscode"]) {
    const config = await read(`../integrations/clients/${client}.json`);
    const server = (config.mcpServers || config.servers).pagecast;
    assert.equal(server.args[0], "/ABSOLUTE/PATH/pagecast/src/ai/stdio.js");
    assert.equal(server.args[1], "--data-dir");
  }
});


test("content-only staging never carries old filenames or concurrent content into a snapshot", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-ai-isolation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputs = [
    { dataDir: root, content: "old", filename: "old.md", itemKey: "same" },
    { dataDir: root, content: "new", filename: "new.md", itemKey: "same" },
    { dataDir: root, content: "concurrent", filename: "new.md", itemKey: "same" }
  ];
  const paths = await Promise.all(inputs.map(stageAiContent));
  assert.equal(new Set(paths.map((p) => path.dirname(p))).size, 3);
  for (let i = 0; i < paths.length; i++) {
    assert.deepEqual(await fs.readdir(path.dirname(paths[i])), [inputs[i].filename]);
    assert.equal(await fs.readFile(paths[i], "utf8"), inputs[i].content);
  }
});
