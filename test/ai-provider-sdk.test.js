import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { generateText, tool, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createPagecastTools, createOpenAIAdapter, createAnthropicAdapter, createVercelTools } from "../src/ai/index.js";
import { askWithPagecast as vercelLoop, continueWithPagecast } from "../integrations/examples/vercel.mjs";

const core = () => createPagecastTools({ server: { callTool: async () => ({ content: [{ type: "text", text: '{"configured":true}' }] }) } });
const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("real OpenAI SDK serializes strict tools and accepts adapter function outputs, mocked transport", async () => {
  const bodies = [];
  const sdk = new OpenAI({ apiKey: "synthetic-not-a-key", maxRetries: 0, fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response({ id: "resp_fixture", object: "response", output: [{ type: "function_call", call_id: "call_fixture", name: "pagecast_status", arguments: "{}" }] });
  } });
  const adapter = createOpenAIAdapter(core());
  const result = await sdk.responses.create({ model: "fixture-model", input: "Check Pagecast status", tools: adapter.tools });
  const output = await adapter.execute(result.output[0]);
  await sdk.responses.create({ model: "fixture-model", input: [output], tools: adapter.tools });
  assert.equal(bodies[0].tools[0].strict, true);
  assert.equal(bodies[1].input[0].call_id, "call_fixture");
  assert.equal(JSON.parse(bodies[1].input[0].output).data.configured, true);
});

test("real Anthropic SDK serializes native tools and accepts adapter results, mocked transport", async () => {
  const bodies = [];
  const sdk = new Anthropic({ apiKey: "synthetic-not-a-key", maxRetries: 0, fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response({ id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model", content: [{ type: "tool_use", id: "toolu_fixture", name: "pagecast_status", input: {} }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const adapter = createAnthropicAdapter(core());
  const messages = [{ role: "user", content: "Check Pagecast status" }];
  const result = await sdk.messages.create({ model: "fixture-model", max_tokens: 100, messages, tools: adapter.tools });
  const output = await adapter.execute(result.content[0]);
  await sdk.messages.create({ model: "fixture-model", max_tokens: 100, messages: [...messages, { role: "assistant", content: result.content }, { role: "user", content: [output] }], tools: adapter.tools });
  assert.equal(bodies[0].tools[0].input_schema.additionalProperties, false);
  assert.equal(bodies[1].messages[2].content[0].tool_use_id, "toolu_fixture");
});

test("real Vercel AI SDK invokes the shared executor through a mock model", async () => {
  const tools = createVercelTools(core(), { tool, jsonSchema });
  const model = new MockLanguageModelV3({ doGenerate: {
    content: [{ type: "tool-call", toolCallId: "fixture", toolName: "pagecast_status", input: "{}" }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: []
  } });
  const result = await generateText({ model, tools, prompt: "Check Pagecast status", maxRetries: 0 });
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0].output.data.configured, true);
  assert.equal(model.doGenerateCalls[0].tools[0].type, "function");
});

function vercelApprovalFixture({ allowHost = true, failAfterApproval = false } = {}) {
  const calls = [], authorizations = [];
  const input = { content: "# Synthetic report", filename: "report.md" };
  const tools = createPagecastTools({
    allowMutations: true,
    authorize: async (request) => { authorizations.push(request); return allowHost; },
    server: { callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify({ url: "https://example.invalid/p/fixture", token: "fixture" }) }] };
    } }
  });
  let generations = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    generations++;
    if (generations > 1 && failAfterApproval) throw new Error("Synthetic model failure after tool execution");
    return {
      content: generations === 1
        ? [{ type: "tool-call", toolCallId: "publish-fixture", toolName: "pagecast_publish_content", input: JSON.stringify(input) }]
        : [{ type: "text", text: "Finished." }],
      finishReason: { unified: generations === 1 ? "tool-calls" : "stop", raw: generations === 1 ? "tool_calls" : "stop" },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: []
    };
  } });
  return { model, core: tools, calls, authorizations, input };
}

test("Vercel example pauses for SDK approval and resumes through the real SDK and core authorization", async () => {
  const fixture = vercelApprovalFixture();
  const initial = await vercelLoop(fixture.model, fixture.core, "Publish the synthetic report");
  assert.equal(initial.state.approvalRequests.length, 1);
  assert.equal(initial.state.remainingSteps, 3);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.authorizations.length, 0);
  assert.ok(Object.isFrozen(initial.state.messages));
  const pending = initial.state.approvalRequests[0];
  assert.deepEqual(pending.toolCall.input, fixture.input);
  const resumed = await continueWithPagecast(fixture.model, fixture.core, initial.state, [{ approvalId: pending.approvalId, approved: true }]);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.authorizations.length, 1);
  assert.deepEqual(fixture.authorizations[0].arguments, fixture.input);
  assert.equal(resumed.result.text, "Finished.");
  assert.equal(resumed.receipts[0].data.url, "https://example.invalid/p/fixture");
  assert.deepEqual(resumed.state.receipts, resumed.receipts);
  assert.equal(resumed.state.remainingSteps, 2);
  assert.equal(resumed.state.approvalRequests.length, 0);
  assert.ok(resumed.state.messages.some((message) => message.role === "tool" && message.content.some((part) => part.type === "tool-approval-response" && part.approved)));
  await assert.rejects(continueWithPagecast(fixture.model, fixture.core, initial.state, [{ approvalId: pending.approvalId, approved: true }]), /consumed/);
  assert.equal(fixture.calls.length, 1);
});

test("Vercel example denial does not invoke the host authorizer or publisher", async () => {
  const fixture = vercelApprovalFixture();
  const { state } = await vercelLoop(fixture.model, fixture.core, "Publish the synthetic report");
  const resumed = await continueWithPagecast(fixture.model, fixture.core, state, [{ approvalId: state.approvalRequests[0].approvalId, approved: false }]);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.authorizations.length, 0);
  assert.ok(resumed.state.messages.some((message) => message.role === "tool" && message.content.some((part) => part.type === "tool-result" && part.output.type === "execution-denied")));
});

test("Vercel SDK approval cannot bypass a denied core authorization", async () => {
  const fixture = vercelApprovalFixture({ allowHost: false });
  const { state } = await vercelLoop(fixture.model, fixture.core, "Publish the synthetic report");
  const resumed = await continueWithPagecast(fixture.model, fixture.core, state, [{ approvalId: state.approvalRequests[0].approvalId, approved: true }]);
  assert.equal(fixture.authorizations.length, 1);
  assert.equal(fixture.calls.length, 0);
  assert.ok(JSON.stringify(resumed.state.messages).includes("approval_required"));
});

test("Vercel continuation rejects untrusted state, invalid decisions and exhausted budgets before execution", async () => {
  const fixture = vercelApprovalFixture();
  const { state } = await vercelLoop(fixture.model, fixture.core, "Publish the synthetic report");
  const decision = { approvalId: state.approvalRequests[0].approvalId, approved: true };
  await assert.rejects(continueWithPagecast(fixture.model, fixture.core, structuredClone(state), [decision]), /Unknown/);
  await assert.rejects(continueWithPagecast(fixture.model, core(), state, [decision]), /Unknown/);
  await assert.rejects(continueWithPagecast(fixture.model, fixture.core, state, [{ ...decision, approved: "yes" }]), /Invalid/);
  await assert.rejects(continueWithPagecast(fixture.model, fixture.core, state, [{ ...decision, approvalId: "unknown" }]), /unknown/);
  await assert.rejects(continueWithPagecast(fixture.model, fixture.core, state, []), /every pending/);
  assert.equal(fixture.calls.length, 0);
  const limited = vercelApprovalFixture();
  const last = await vercelLoop(limited.model, limited.core, "Publish the synthetic report", { maxSteps: 1 });
  await assert.rejects(continueWithPagecast(limited.model, limited.core, last.state, [{ approvalId: last.state.approvalRequests[0].approvalId, approved: true }]), /step limit/);
  assert.equal(limited.calls.length, 0);
});

test("Vercel continuation stays consumed after a post-execution model failure", async () => {
  const fixture = vercelApprovalFixture({ failAfterApproval: true });
  const { state } = await vercelLoop(fixture.model, fixture.core, "Publish the synthetic report");
  const decisions = [{ approvalId: state.approvalRequests[0].approvalId, approved: true }];
  await assert.rejects(continueWithPagecast(fixture.model, fixture.core, state, decisions), (error) => {
    assert.equal(error.code, "workflow_interrupted");
    assert.equal(error.retrySafe, false);
    assert.equal(error.receipts[0].outcome, "succeeded");
    assert.equal(error.receipts[0].data.url, "https://example.invalid/p/fixture");
    assert.equal(error.receipts[0].data.token, undefined);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes("Synthetic model failure"));
    return true;
  });
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(continueWithPagecast(fixture.model, fixture.core, state, decisions), /consumed/);
  assert.equal(fixture.calls.length, 1);
});

test("Vercel carries prior receipts across resumptions without replaying the earlier publication", async () => {
  let generations = 0;
  const calls = [];
  const trusted = createPagecastTools({ allowMutations: true, authorize: async () => true, server: { callTool: async (_name, args) => {
    calls.push(args.filename);
    return { content: [{ type: "text", text: JSON.stringify({ action: "created", url: `https://example.invalid/p/${args.filename}`, token: args.filename }) }] };
  } } });
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    if (++generations === 3) throw new Error("private post-publication response failure");
    return { content: [{ type: "tool-call", toolCallId: `call-${generations}`, toolName: "pagecast_publish_content", input: JSON.stringify({ content: "# Synthetic", filename: `report-${generations}.md` }) }],
      finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] };
  } });
  const first = await vercelLoop(model, trusted, "Publish synthetic reports");
  const second = await continueWithPagecast(model, trusted, first.state, [{ approvalId: first.state.approvalRequests[0].approvalId, approved: true }]);
  assert.deepEqual(calls, ["report-1.md"]);
  assert.equal(second.receipts[0].data.url, "https://example.invalid/p/report-1.md");
  const decisions = [{ approvalId: second.state.approvalRequests[0].approvalId, approved: true }];
  await assert.rejects(continueWithPagecast(model, trusted, second.state, decisions), (error) => {
    assert.deepEqual(error.receipts.map((receipt) => receipt.data.url), ["https://example.invalid/p/report-1.md", "https://example.invalid/p/report-2.md"]);
    return error.code === "workflow_interrupted";
  });
  await assert.rejects(continueWithPagecast(model, trusted, second.state, decisions), /consumed/);
  assert.deepEqual(calls, ["report-1.md", "report-2.md"]);
});
