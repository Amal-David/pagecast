#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPagecastTools, MAX_AI_ARGUMENT_BYTES } from "./core.js";
import { createPagecastAiMcpServer } from "./mcp.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--data-dir") {
  process.stderr.write("Usage: pagecast-ai-mcp --data-dir /absolute/path/to/pagecast-home\nRead-only connector. Use the application SDK for host-approved mutations.\n");
  process.exitCode = 1;
} else {
  try {
    const server = createPagecastAiMcpServer(createPagecastTools({ dataDir: args[1] }));
    const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_AI_ARGUMENT_BYTES + 4096 });
    await server.connect(transport);
    process.stdin.on("end", () => { void server.close(); });
  } catch {
    process.stderr.write("Pagecast MCP startup failed. Supply an absolute data directory and install the package dependencies.\n");
    process.exitCode = 1;
  }
}
