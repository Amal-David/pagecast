import assert from "node:assert/strict";
import test from "node:test";
import { createPagecastTools, createPagecastWorkflow, PagecastWorkflowError } from "../src/ai/index.js";
import { askWithPagecast as openaiLoop } from "../integrations/examples/openai.mjs";
import { askWithPagecast as anthropicLoop } from "../integrations/examples/anthropic.mjs";

const input = { content: "# Synthetic fixture", filename: "report.md" };
const expected = { action: "created", url: "https://example.invalid/p/completed" };
function fixture() {
  let calls = 0;
  const core = createPagecastTools({ allowMutations: true, authorize: async () => true, server: { callTool: async () => {
    calls++;
    return { content: [{ type: "text", text: JSON.stringify({ ...expected, token: "completed", sourcePath: "/private/fixture", secret: "omit-this" }) }] };
  } } });
  return { core, get calls() { return calls; } };
}
function checkReceipt(error) {
  assert.ok(error instanceof PagecastWorkflowError);
  assert.equal(error.code, "workflow_interrupted");
  assert.equal(error.retrySafe, false);
  assert.equal(error.receipts.length, 1);
  assert.equal(error.receipts[0].outcome, "succeeded");
  assert.deepEqual(error.receipts[0].data, expected);
  assert.equal(error.cause, undefined);
  assert.ok(!JSON.stringify(error).includes("private"));
  assert.ok(!JSON.stringify(error).includes("omit-this"));
  assert.ok(!JSON.stringify(error).includes(input.content));
  assert.ok(Object.isFrozen(error.receipts[0].data));
  return true;
}

for (const provider of ["openai", "anthropic"]) for (const failure of ["model", "turn limit", "malformed subsequent call"]) {
  test(`${provider} preserves successful publication receipt after ${failure}`, async () => {
    const f = fixture(); let turns = 0;
    const make = async () => {
      if (++turns > 1) throw new Error("private provider error: omit-this");
      const calls = provider === "openai"
        ? [{ type: "function_call", call_id: "call-1", name: "pagecast_publish_content", arguments: JSON.stringify(input) }]
        : [{ type: "tool_use", id: "call-1", name: "pagecast_publish_content", input }];
      if (failure === "malformed subsequent call") calls.push({ type: provider === "openai" ? "function_call" : "tool_use" });
      return provider === "openai" ? { output: calls } : { content: calls };
    };
    const options = { model: "synthetic", input: "Publish synthetic fixture", prompt: "Publish synthetic fixture", maxTurns: failure === "turn limit" ? 1 : 2 };
    await assert.rejects(provider === "openai"
      ? openaiLoop({ responses: { create: make } }, f.core, options)
      : anthropicLoop({ messages: { create: make } }, f.core, options), checkReceipt);
    assert.equal(f.calls, 1);
  });
}

test("successful native workflow returns receipts independently of model prose", async () => {
  const f = fixture(); let turn = 0;
  const result = await openaiLoop({ responses: { create: async () => ++turn === 1
    ? { output: [{ type: "function_call", call_id: "once", name: "pagecast_publish_content", arguments: JSON.stringify(input) }] }
    : { output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }
  } }, f.core, { model: "synthetic", input: "publish" });
  assert.deepEqual(result.pagecastReceipts[0].data, expected);
  assert.equal(f.calls, 1);
});

test("uncertain outcomes are not labelled success and block subsequent writes in that workflow", async () => {
  let calls = 0;
  const workflow = createPagecastWorkflow({ listTools: () => [], execute: async () => { calls++; throw new Error("private deployment output"); } });
  await assert.rejects(workflow.core.execute("pagecast_publish_content", input));
  const recovery = workflow.recover(new Error("private model output"));
  assert.equal(recovery.receipts[0].outcome, "unknown");
  assert.equal(recovery.receipts[0].data, undefined);
  assert.equal((await workflow.core.execute("pagecast_publish_content", input)).error.code, "reconciliation_required");
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(recovery).includes("private"));
});

test("known pre-dispatch denial and read errors never invent mutation success", async () => {
  const original = new Error("read-only failure");
  const workflow = createPagecastWorkflow({ listTools: () => [], execute: async () => ({ ok: false, error: { code: "approval_required" } }) });
  await workflow.core.execute("pagecast_publish_content", input);
  await workflow.core.execute("pagecast_status", {});
  assert.deepEqual(workflow.receipts, []);
  assert.equal(workflow.recover(original), original);
});

test("receipt redaction is typed, bounded, and never truncates resource identifiers", async () => {
  const workflow = createPagecastWorkflow({ listTools: () => [], execute: async () => ({ ok: true, data: {
    ...expected, publicUrl: "x".repeat(5000), publicationToken: "x".repeat(201), label: { secret: "omit" },
    content: "omit", sourcePath: "/private/omit", passwordProtected: true
  } }) });
  await workflow.core.execute("pagecast_publish_content", input);
  const data = workflow.receipts[0].data;
  assert.deepEqual(data, { ...expected, passwordProtected: true });
  assert.ok(Buffer.byteLength(JSON.stringify(workflow.receipts)) < 1024);
  assert.ok(!JSON.stringify(workflow.receipts).includes("omit"));
});

test("workflow mutation cap never executes or silently evicts a 65th receipt", async () => {
  let calls = 0;
  const workflow = createPagecastWorkflow({ listTools: () => [], execute: async () => { calls++; return { ok: true, data: expected }; } });
  for (let i = 0; i < 64; i++) await workflow.core.execute("pagecast_publish_content", input);
  await assert.rejects(workflow.core.execute("pagecast_publish_content", input), /mutation limit/);
  assert.equal(calls, 64);
  assert.equal(workflow.receipts.length, 64);
});

test("concurrent writes queue behind uncertain outcomes rather than bypassing reconciliation", async () => {
  let calls = 0;
  const workflow = createPagecastWorkflow({ listTools: () => [], execute: async () => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: false, error: { code: "operation_failed" } };
  } });
  const results = await Promise.all([workflow.core.execute("pagecast_publish_content", input), workflow.core.execute("pagecast_publish_content", input)]);
  assert.equal(results[0].error.code, "operation_failed");
  assert.equal(results[1].error.code, "reconciliation_required");
  assert.equal(calls, 1);
  assert.equal(workflow.receipts.length, 1);
});

test("error-path receipts omit credential fields, token fields and private capability URLs", async () => {
  const secret = "SYNTHETIC_PRIVATE_SECRET";
  const workflow = createPagecastWorkflow({ listTools: () => [], execute: async () => ({ ok: true, data: {
    action: "created", url: expected.url, publicUrl: `https://example.invalid/admin?capability=${secret}`,
    token: secret, publicationToken: secret, apiKey: secret, authorization: `Bearer ${secret}`,
    revocationSecret: secret, adminCapabilityUrl: `https://example.invalid/admin/${secret}`, label: secret
  } }) });
  await workflow.core.execute("pagecast_publish_content", input);
  const error = workflow.recover(new Error(`request failed with ${secret}`));
  assert.deepEqual(error.receipts[0].data, expected);
  assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_PRIVATE_SECRET|Bearer|capability|admin|token/i);
  for (const url of [
    `https://user:${secret}@example.invalid/p/report`,
    `https://example.invalid/p/report?token=${secret}`,
    `https://example.invalid/p/report#${secret}`,
    `https://example.invalid/admin/${secret}`,
    `https://127.0.0.1/p/${secret}`
  ]) {
    const unsafe = createPagecastWorkflow({ listTools: () => [], execute: async () => ({ ok: true, data: { url, token: secret } }) });
    await unsafe.core.execute("pagecast_publish_content", input);
    const recovered = unsafe.recover(new Error(secret));
    assert.equal(recovered.receipts[0].outcome, "succeeded");
    assert.deepEqual(recovered.receipts[0].data, {});
    assert.ok(!JSON.stringify(recovered).includes(secret));
  }
});
