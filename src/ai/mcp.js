import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Official MCP SDK adapter; connect a transport chosen by the trusted host. */
export function createPagecastAiMcpServer(core, { version = "0.7.1" } = {}) {
  const server = new Server({ name: "pagecast-ai", version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: core.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await core.execute(request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: !result.ok };
  });
  return server;
}
