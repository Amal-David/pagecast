// In an application with `openai` installed. No request runs on import.
import { createOpenAIAdapter, createPagecastWorkflow } from "pagecast/ai";

export async function askWithPagecast(client, core, { model, input, maxTurns = 4 }) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 8) throw new TypeError("maxTurns must be 1–8.");
  const workflow = createPagecastWorkflow(core);
  const adapter = createOpenAIAdapter(workflow.core);
  const conversation = typeof input === "string" ? [{ role: "user", content: input }] : [...input];
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await client.responses.create({ model, input: conversation, tools: adapter.tools, parallel_tool_calls: false });
      conversation.push(...response.output);
      const calls = response.output.filter((item) => item.type === "function_call");
      if (!calls.length) return { ...response, pagecastReceipts: workflow.receipts };
      if (calls.length > 8) throw new Error("Too many tool calls in a single response.");
      for (const call of calls) conversation.push(await adapter.execute(call));
    }
    throw new Error("Pagecast tool loop reached its turn limit. Do not automatically repeat publishing.");
  } catch (error) { throw workflow.recover(error); }
}
