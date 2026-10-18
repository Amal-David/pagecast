import { MAX_AI_ARGUMENT_BYTES, strictInputSchema, validateArguments } from "./core.js";
export { createPagecastTools, PagecastAiError, MAX_AI_CONTENT_BYTES, MAX_AI_ARGUMENT_BYTES, MAX_AI_RESULT_BYTES } from "./core.js";

export { createPagecastWorkflow, PagecastWorkflowError } from "./workflow.js";

function validateCall(call, type, idField) {
  if (!call || call.type !== type || typeof call[idField] !== "string" || !call[idField] || call[idField].length > 200 || typeof call.name !== "string") throw new TypeError("Invalid provider tool-call envelope.");
}
const invalid = { ok: false, error: { code: "invalid_arguments", message: "Tool arguments must be bounded JSON." } };

/** OpenAI Responses API function tools (not Chat Completions envelopes). */
export function createOpenAIAdapter(core) {
  return {
    tools: core.listTools().map((t) => ({ type: "function", name: t.name, description: t.description, parameters: strictInputSchema(t.inputSchema), strict: true })),
    async execute(call) {
      validateCall(call, "function_call", "call_id");
      let args, result;
      try {
        if (typeof call.arguments !== "string" || Buffer.byteLength(call.arguments, "utf8") > MAX_AI_ARGUMENT_BYTES) throw new Error();
        args = JSON.parse(call.arguments);
      } catch { result = invalid; }
      result ||= await core.execute(call.name, args);
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
    }
  };
}

/** Anthropic Messages API client tools and matching tool_result blocks. */
export function createAnthropicAdapter(core) {
  return {
    tools: core.listTools().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    async execute(call) {
      validateCall(call, "tool_use", "id");
      const result = await core.execute(call.name, call.input);
      return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result), is_error: !result.ok };
    }
  };
}

/** Inject actual `tool` and `jsonSchema` exports from the installed `ai` package. */
export function createVercelTools(core, { tool, jsonSchema }) {
  if (typeof tool !== "function" || typeof jsonSchema !== "function") throw new TypeError("Pass tool and jsonSchema from the Vercel AI SDK.");
  return Object.fromEntries(core.listTools().map((definition) => [definition.name, tool({
    description: definition.description,
    inputSchema: jsonSchema(definition.inputSchema, {
      validate(value) {
        try { return { success: true, value: validateArguments(definition, value) }; }
        catch (error) { return { success: false, error }; }
      }
    }),
    needsApproval: !definition.annotations.readOnlyHint,
    execute: (args) => core.execute(definition.name, args)
  })]));
}
