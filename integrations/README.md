# Pagecast AI integrations

One validated tool core, several real interfaces. This source change is built on
`main` at `1a5d491`, alongside the existing Claude Code plugin, Codex skill and
five-tool `pagecast mcp` command. No plugin directory submission, credentials,
Cloudflare deployment, or paid model request is part of installation/testing here.

## Supported surfaces

| Surface | Included integration | Verification / boundary |
| --- | --- | --- |
| OpenAI Responses API | `createOpenAIAdapter`, strict function tools, matching function outputs, bounded example loop | Real SDK with mocked HTTP; no paid API call |
| ChatGPT / Codex local plugin | `plugin/plugin.json` portable package + skill + MCP configuration | Manifest schema and stdio protocol; actual client installation/review pending |
| Codex CLI | `clients/codex.toml` | Uses the same stdio server; client UI not exercised |
| Claude Messages API | `createAnthropicAdapter`, tool schemas/results, bounded example loop | Real SDK with mocked HTTP |
| Claude Code | Existing publishing plugin remains; new read-only library plugin and config | New MCP tested with official SDK, client install pending |
| Claude Desktop | `clients/claude-desktop.json` local MCP | Local transport; not a claim about every web/Cowork surface |
| Vercel AI SDK | `createVercelTools` + `examples/vercel.mjs` | Real AI SDK mock model invokes the executor |
| Vercel serverless / Claude web / hosted ChatGPT | Remote-MCP integration path | Requires a separately deployed authenticated HTTPS service; localhost is not remotely reachable |
| Cursor / VS Code Copilot / Gemini CLI | Client-specific JSON configs | Configs validated; their applications were not launched |

Current source references are listed at the end. Platform availability and admin
policies can vary. An API adapter is not a marketplace plugin or a hosted service.

## Install and use the source

Use Node.js 22+ for the provider examples and full developer suite: the tested
OpenAI 7 and AI SDK 7 packages require it. The dependency-light Pagecast/MCP
runtime retains the repository's Node 20.19+ minimum. Compatibility below each
provider SDK's declared engine range is not promised.

```sh
npm ci --ignore-scripts
npm run check:ai
npm run test:ai
node src/ai/stdio.js --data-dir /absolute/path/to/pagecast-home
```

The last command is a read-only stdio MCP process. It waits for protocol input;
it is normally launched by your client. Use an explicit Home so a model cannot
choose the storage profile. For an existing default Home, expand
`~/.pagecast/home` to its absolute path. Listing an absent Home returns an empty
list without creating state.

From a consuming Node.js application with this checkout installed:

```js
import { createPagecastTools, createOpenAIAdapter } from 'pagecast/ai';
const core = createPagecastTools({ dataDir: '/absolute/path/to/pagecast-home' });
const adapter = createOpenAIAdapter(core);
// Pass adapter.tools to client.responses.create; execute returned function calls
// with await adapter.execute(call), then send its function_call_output back.
```

`examples/openai.mjs`, `anthropic.mjs`, and `vercel.mjs` contain bounded execution
loops, not merely schemas. Install the relevant official provider SDK in your
application. Supply your selected model and existing credentials at runtime;
none are bundled. Never import this Node.js/storage code into a browser bundle.

Provider dependencies are dev-only for the mocked compatibility suite. The
published Pagecast runtime depends only on the official MCP SDK plus its existing
rendering dependencies. The feature has not been published to npm yet; using
`npx pagecast@0.7.1` will not load these additions.

## Tools and authorization

- `pagecast_status`: redacted connection summary; never signs in.
- `pagecast_list_pages`: 20 reports by default, maximum 50, offset pagination.
  Publication lists are capped at 50/report with an explicit truncation flag.
- `pagecast_publish_content`: HTML/Markdown supplied in arguments, at most 1 MiB
  UTF-8, simple filename, lifetime 1h–30d (default 7d), existing upsert/new/update
  behavior. No arbitrary path reads, sibling assets, build commands, passwords,
  protection-removal controls, or caller-controlled context IDs.
- `pagecast_revoke_publication`: revokes one exact token through the existing
  Pagecast publication service. Historical deployments are a separate concern.

Only the first two are enabled by default. The latter two require BOTH
`allowMutations: true` and a trusted application callback:

```js
const core = createPagecastTools({
  dataDir: '/absolute/path/to/pagecast-home',
  contextId: 'trusted-application-conversation-id',
  allowMutations: true,
  authorize: async ({ tool, arguments: args }) => {
    // Your application must show the exact action, content/target, and configured
    // Cloudflare destination to the authenticated user, then return their decision.
    // Bind that decision to these exact arguments; consume approvals once.
    return approvalUi.reviewPagecastAction({ tool, args });
  }
});
```

`approvalUi` is your application's UI, not a bundled function or an LLM. Returning
true unconditionally removes this protection. A boolean in model-supplied
arguments cannot approve an action. Vercel's `needsApproval` is an SDK execution
gate: its approval response resumes the SDK, and the core still requires its
separate host callback. The Vercel example demonstrates this continuation. Read-only CLI/plugin/HTTP
connectors cannot enable writes through a tool argument. Mutations are queued
within one core instance and retain Pagecast's underlying writer coordination.

Use a stable `itemKey` and trusted `contextId` for repeatable updates. `mode: new`
intentionally creates a new link. A failure can occur after deployment; never
retry a publication blindly. Check known state first. Publishing requires a
previously configured and adopted Pages account/project, and updates cannot
switch to a publication on a different project. These checks run under the
Pagecast writer lease before report/config changes, with interactive login and
project discovery/provisioning disabled. Stop the Pagecast app/daemon before
using the write adapter: it fails closed when that Home already has a writer,
rather than routing into the legacy daemon's broader provisioning behavior.
Read-only tools can still use an active Home. No automatic credential setup,
payments, sign-in, or cloud provisioning is performed by the adapter.

The Vercel example returns `{result, state}`. Keep `state` on the authenticated
server, show `state.approvalRequests` to the user, then call
`continueWithPagecast(model, core, state, [{approvalId, approved}])`. A positive
SDK response must still pass `core.authorize` for the same exact arguments.
State is single-use, even after failures, and the step budget spans continuations.
The example uses in-memory state; durable hosts need equivalent atomic storage.
Never accept message history or approval state from the model or client.

Outputs use `{ok:true,data}` or `{ok:false,error:{code,message}}`. Responses are
capped at 256 KiB, and unexpected upstream errors are replaced with a generic
message because shell output can contain private paths or credentials. Inputs
and titles are data, not instructions. There is no added telemetry or content
logging in the adapter. The existing Pagecast CLI has its own telemetry policy.

## Mutation receipts and interrupted workflows

Once the shared core has confirmed a mutation, an oversized optional result or
report-projection failure returns `ok: true` with a compact receipt and a
`result_details_unavailable` warning. It never changes that confirmed publication
into a failure merely because extra report details could not be returned.

The examples retain confirmed publication/revocation receipts separately from
later model responses. OpenAI and Anthropic return `pagecastReceipts` alongside
their normal response fields; Vercel returns `receipts` and keeps them across
server-held approval continuations. Display or persist those receipts before
relying on the model's final prose.

If a later model request, tool-envelope processing, or loop limit interrupts a
workflow, catch `PagecastWorkflowError` (`code: "workflow_interrupted"`). Its
`receipts` retain the bounded user-facing publication URL, operation number and
status metadata; `retrySafe` is false. Recovery errors omit all token fields,
credentials, arbitrary labels and admin/capability URLs. URLs with credentials,
queries, fragments, IP-literal/local hostname forms or a non-publication route
are omitted.
Provider exceptions, request content, local paths and arbitrary response fields
are not copied into that error. Custom hosts can use `createPagecastWorkflow`
around the same core to retain receipts around their own orchestration.

An upstream exception or unconfirmed mutation result is recorded as `unknown`,
never as success. That workflow refuses further writes until the host reconciles
state. There is no automatic retry or exactly-once guarantee across restarts;
keep a stable `itemKey`, inspect the known link/journal, and obtain fresh approval
before deliberately starting another write. Receipts are in-memory, scoped to
one workflow, capped at 64 mutation attempts, and are not a durable recovery log.
A process crash or a remote success before the underlying publisher returned can
still leave an uncertain outcome without a URL. Vercel continuations remain
single-use even when a later model call fails.

## Local clients and plugin packaging

Copy the relevant file from `clients/` into your client's configuration and replace
both absolute-path placeholders. VS Code uses a `servers` map; Claude, Cursor and
Gemini configurations use `mcpServers`; Codex uses TOML. Do not overwrite existing
configuration wholesale. These are local stdio configurations, not cloud URLs.

The [Pagecast Library plugin](plugin/README.md) is a portable local package with
Claude Code compatibility metadata. It is read-only. The pre-existing
[`plugin/`](../plugin/README.md) remains the publishing plugin and is not replaced.

## MCP HTTP, ChatGPT, and hosted clients

`pagecast/ai/mcp` returns an official SDK server which a trusted application can
connect to an MCP transport. It uses the same catalog, runtime validation and
approval policy as native adapters, including structured tool results.

`pagecast/ai/http` and `examples/local-http.mjs` provide a **loopback-only,
read-only** Streamable HTTP bridge for local interoperability tests. The operator
must supply an existing bearer token and explicit Home. The bridge never issues
credentials. It rejects write-enabled cores, all non-POST requests, invalid Host
headers, unapproved Origin headers, unauthenticated calls, batches, non-JSON
bodies, bodies above 64 KiB, and excessive concurrent requests. Default allowed
browser origins are empty. It does not trust forwarded headers or enable CORS.
Do not expose the Pagecast admin port or this single-account process publicly.

For ChatGPT/Claude hosted connectors and Vercel serverless, an authenticated
HTTPS MCP deployment is a separate release gate. Build on the
[existing Worker backend PR #31](https://github.com/Amal-David/pagecast/pull/31)
when reviewed and merged: it already implements remote authorization, storage,
transport and broader tools. This change does not merge that conflicting branch,
reimplement its backend, or claim compatible write contracts without tests.
`examples/vercel-remote.mjs` demonstrates the official MCP client lifecycle and
an explicit read-tool allowlist; review actual deployed tool names/scopes before
use. Deploying local Pagecast storage inside ephemeral Vercel Functions is not
supported by this adapter.

## Verification

See [the bounded evaluation record](EVALUATION.md) for the synthetic test scope,
reproduction commands, and the distinction between SDK/protocol verification and
live model or hosted-platform testing.

## Release gates

1. Review the changes, resolve integration with Worker PR #31 independently, and
   run the complete release build (including platform-native helpers), then
   release a new npm version before advertising registry install commands.
2. Validate local installation in each claimed client with the built package.
3. For hosted use, approve deployment, configure TLS/OAuth, tenant isolation,
   scopes, consent UX, rate limits and revocation; validate against real services.
4. Run a small explicitly budgeted model evaluation on synthetic content, then
   a staging publication/revoke test in an approved Cloudflare account.
5. Prepare verified branding/privacy/support details and submit only after approval.

No paid calls, live deployment, public app registration, marketplace submission,
or credentials were created by the automated tests. Do not interpret passing
protocol fixtures as a live end-to-end or marketplace-approval result.

## Official references (checked 2026-10-16)

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI MCP integration](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Agent Plugins schemas](https://agent-plugins.org/)
- [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [Claude Code plugin manifest](https://code.claude.com/docs/en/plugins-reference)
- [Claude local versus web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
- [Vercel MCP clients](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [Vercel JSON Schema tools](https://ai-sdk.dev/docs/reference/ai-sdk-core/json-schema)
- [MCP HTTP transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)
- [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/)
