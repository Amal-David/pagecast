// Requires an existing token supplied by the operator. Never prints that token.
import { createPagecastTools } from "pagecast/ai";
import { startPagecastReadOnlyHttp } from "pagecast/ai/http";

const core = createPagecastTools({ dataDir: process.env.PAGECAST_DATA_DIR });
const gateway = await startPagecastReadOnlyHttp({ core, token: process.env.PAGECAST_MCP_TOKEN, port: 4175 });
process.stderr.write(`Read-only Pagecast MCP listening on ${gateway.url}\n`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await gateway.close(); process.exit(0); });
