// In an application with `@anthropic-ai/sdk` installed. No request runs on import.
import { createAnthropicAdapter, createPagecastWorkflow } from "pagecast/ai";

export async function askWithPagecast(client, core, { model, prompt, maxTurns = 4 }) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 8) throw new TypeError("maxTurns must be 1–8.");
  const workflow = createPagecastWorkflow(core);
  const adapter = createAnthropicAdapter(workflow.core);
  const messages = [{ role: "user", content: prompt }];
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await client.messages.create({ model, max_tokens: 2048, messages, tools: adapter.tools });
      const calls = response.content.filter((block) => block.type === "tool_use");
      if (!calls.length) return { ...response, pagecastReceipts: workflow.receipts };
      if (calls.length > 8) throw new Error("Too many tool calls in a single response.");
      messages.push({ role: "assistant", content: response.content });
      const results = [];
      for (const call of calls) results.push(await adapter.execute(call));
      messages.push({ role: "user", content: results });
    }
    throw new Error("Pagecast tool loop reached its turn limit. Do not automatically repeat publishing.");
  } catch (error) { throw workflow.recover(error); }
}
