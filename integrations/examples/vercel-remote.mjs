// For Vercel/serverless production, use an already-deployed, authenticated remote
// MCP service, such as the Worker backend after its separate release gates pass.
// Install @ai-sdk/mcp in the consuming app. No service is provisioned by this file.
import { createMCPClient } from "@ai-sdk/mcp";
import { generateText, stepCountIs } from "ai";

export async function askWithPagecastRemote({ model, prompt, url, authorization }) {
  if (new URL(url).protocol !== "https:") throw new TypeError("Remote MCP requires HTTPS.");
  const client = await createMCPClient({ transport: { type: "http", url, headers: { Authorization: authorization } } });
  try {
    const allTools = await client.tools();
    // Explicit allowlist: never expose every newly-added admin tool to a model.
    const tools = Object.fromEntries(["status", "list_pages", "pagecast_status", "pagecast_list_pages"].filter((name) => Object.hasOwn(allTools, name)).map((name) => [name, allTools[name]]));
    if (!Object.keys(tools).length) throw new Error("Remote server does not expose the expected read-only Pagecast tool names. Review its contract.");
    return await generateText({ model, prompt, tools, stopWhen: stepCountIs(4), maxRetries: 0 });
  } finally { await client.close(); }
}
