// Persistent Node.js host only. A Pagecast Home cannot live on ephemeral Edge storage.
import { generateText, tool, jsonSchema, stepCountIs } from "ai";
import { createVercelTools, createPagecastWorkflow } from "pagecast/ai";

// Keep state on the authenticated server. Send only a copy of approvalRequests
// to your UI, never accept model/client-supplied message history or state.
// This in-memory example is single-process; durable hosts need equivalent
// atomic, single-use state storage. A failed continuation is consumed too.
const states = new WeakMap();
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

async function run(model, core, messages, remainingSteps, workflow) {
  try {
    const result = await generateText({
      model, messages, tools: createVercelTools(workflow.core, { tool, jsonSchema }),
      stopWhen: stepCountIs(remainingSteps), maxRetries: 0
    });
    const approvalRequests = result.steps.flatMap((step) => step.content.filter((part) => part.type === "tool-approval-request" && !part.isAutomatic));
    const state = freeze(structuredClone({
      // responseMessages includes resumed tool results and every generation step;
      // response.messages contains only the final step in AI SDK 7.
      messages: [...messages, ...result.responseMessages],
      approvalRequests,
      receipts: workflow.receipts,
      remainingSteps: remainingSteps - result.steps.length
    }));
    states.set(state, { core, workflow, consumed: false });
    return { result, state, receipts: workflow.receipts };
  } catch (error) { throw workflow.recover(error); }
}

export async function askWithPagecast(model, core, prompt, { maxSteps = 4 } = {}) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 8) throw new TypeError("maxSteps must be 1–8.");
  return run(model, core, [{ role: "user", content: prompt }], maxSteps, createPagecastWorkflow(core));
}

/** Resume only after the authenticated user decides each pending approval.
 * decisions: [{ approvalId, approved: true | false }]
 * The host must separately bind core.authorize to the exact approved action and
 * arguments. SDK approval responses do not grant or bypass that authorization.
 */
export async function continueWithPagecast(model, core, state, decisions) {
  const record = states.get(state);
  if (!record || record.core !== core || record.consumed) throw new Error("Unknown or already consumed Pagecast continuation.");
  if (state.remainingSteps < 1) throw new Error("Pagecast tool loop reached its step limit. Do not automatically repeat publishing.");
  const pending = new Set(state.approvalRequests.map((request) => request.approvalId));
  if (!pending.size || pending.size > 8 || !Array.isArray(decisions) || decisions.length !== pending.size) throw new TypeError("Decide every pending approval once, with at most eight decisions.");
  const content = decisions.map((decision) => {
    if (!decision || typeof decision.approved !== "boolean" || !pending.delete(decision.approvalId)) throw new TypeError("Invalid, duplicate, or unknown approval decision.");
    return { type: "tool-approval-response", approvalId: decision.approvalId, approved: decision.approved };
  });
  // Consume before any awaited work so concurrent requests cannot replay writes.
  record.consumed = true;
  return run(model, core, [...state.messages, { role: "tool", content }], state.remainingSteps, record.workflow);
}
