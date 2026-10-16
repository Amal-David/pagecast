# WebMCP publishing (opt-in preview)

Pagecast's local dashboard can register browser-native tools on
`document.modelContext`. This is separate from the existing stdio MCP server;
no new deployment backend or Chrome extension permission is added.

Use a WebMCP-capable Chrome build with the WebMCP testing flag enabled. In the
top-level Pagecast dashboard, check **Enable WebMCP publishing for this tab**.
The control appears only when the browser supports registration. Refreshing or
leaving the page turns it off. It is never enabled from storage or tool input.

| Tool | Purpose | Permission |
| --- | --- | --- |
| `get_publish_capabilities` | Reports formats and size limit; reads no workspace content | Read-only |
| `publish_content` | Publishes supplied HTML or Markdown as a new page | Consequential; fresh source review and confirmation on every call |

The publishing tool accepts exactly `content` and `format` (`html` or
`markdown`), up to 64 KiB in UTF-8. It cannot read paths, enumerate reports,
select folders, change destinations, alter protection, build code, overwrite an
existing report, or enable auto-sync. No cross-origin delegation is configured.

Before uploading anything, Pagecast shows the exact immutable source as inert
text in a modal. Cancel, Escape, timeout (two minutes), execution cancellation,
or opting out prevents publication if it has not started. Synthetic DOM clicks
cannot approve it. This is a deliberate review affordance, not protection
against an extension or browser agent with unrestricted UI automation powers.
The example agent's own permission prompt is additional to this review.

After confirmation, the adapter calls the existing CSRF-protected upload and
`publish-snapshot` APIs. The supplied source becomes a new local upload; the
normal publisher deploys it to the configured Cloudflare Pages project with the
default lifetime. **The new page has no password protection.** Its URL is
externally accessible; unlisted does not mean private. HTML can execute scripts
and load remote resources when opened. Relative local assets are not bundled.
The review dialog never executes the source.

On success, the tool returns only the public URL and refreshes dashboard queries.
Failures return bounded structured errors without server paths or credentials.
The tool never retries publishing automatically. A failed or cancelled request
may leave a local upload. Once a publish request has reached the server,
cancelling the browser fetch cannot roll back deployment: inspect the dashboard
and operations before retrying, since the external outcome may be unknown.
The adapter does not revoke or delete anything automatically.

## Validation

Run after installing root and web dependencies:

```sh
node --test web/tests/*.test.mjs
pnpm -C web exec tsc --noEmit
pnpm -C web run build
npm run check
npm test
```

The new tests exercise native registration callbacks with a mock context and
DOM-contract fixtures: formats, exact immutable confirmation payload, refusal,
invalid inputs and extra path fields, UTF-8 size limits, errors, cancellation,
opt-out, concurrency, registration cleanup, inert source rendering, synthetic
approval refusal, Escape, unsupported browsers and iframe exclusion. The DOM
fixtures are not a real browser or a substitute for the following manual check.

### Google's example extension

Sources reviewed:

- [Example extension](https://github.com/GoogleChromeLabs/webmcp-extension), commit `1a293e884fcc03ca2ea1bcebd3d2364aa954bed4`
- [Type definitions](https://github.com/webmachinelearning/webmcp-types), package `webmcp-types@0.1.10`
- [Development skill](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-skills), commit `79bf8bbebd1a35affd9dffa9634a59d79df6c94b`

The adapter uses native registration outside the React root and the official
types, structured error resolution, same-origin registration and AbortSignal
cleanup. Its consequential annotation matches the example's per-call approval
policy; no session-wide permission can replace Pagecast's own confirmation.

The source-level permission contract check passed against that extension checkout:

```sh
node web/scripts/check-webmcp-extension.mjs /path/to/webmcp-extension
```

It checks alerts on/off, a standing session grant, denial, and read-only discovery
against Google's actual permission functions. It does not run Chrome.

Live validation remains required on a supported Chrome build. No compatible
browser was installed in the implementation VM; downloading Chrome failed.
No live content was published during development.

1. Build/load Google's unpacked example extension as its README describes;
   enable the WebMCP testing flag in the required Chrome version.
2. Open the local Pagecast dashboard. Discover tools in the extension and in
   DevTools **Application > WebMCP**: neither Pagecast tool should appear yet.
3. Enable the checkbox. Discover exactly the two tools above. Execute the
   capability tool; it must expose no local paths or report content.
4. Request publication of harmless sample HTML. Confirm the extension requires
   permission for this consequential tool. Decline in the Pagecast source dialog:
   no upload, deployment, or new report should occur.
5. Repeat with Markdown and confirm **Publish externally**. Verify one new report
   and one public URL, with the expected rendered content. This step creates live
   content and requires the operator's deliberate approval.
6. Repeat with Cloudflare unavailable: expect `PUBLISH_FAILED`, never a success
   URL; inspect local uploads and operations before retrying.
7. Disable WebMCP during a pending review; it should close and prevent upload.
   Both tools should disappear from discovery. Refresh and verify opt-in is off.
8. Inspect schema warnings and run Lighthouse's **Agentic browsing** audit where
   available. No browser, extension, or Lighthouse pass is claimed by unit tests.
