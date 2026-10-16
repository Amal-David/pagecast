/// <reference types="webmcp-types" />

export interface PublishInput { content: string; format: "html" | "markdown" }
interface Dependencies {
  confirm: (input: Readonly<PublishInput>, signal: AbortSignal) => Promise<boolean>;
  publish: (input: Readonly<PublishInput>, signal: AbortSignal) => Promise<string>;
}
const failure = (code: string, error: string) => ({ code, error, retryable: false });

// Framework-independent registration. The owner must abort on opt-out/unload.
export async function registerPublishingTools(
  context: WebMCP.ModelContext, lifetime: AbortSignal, deps: Dependencies
) {
  let busy = false;
  const options = { signal: lifetime }; // Same-origin only; no exposedTo delegation.
  await context.registerTool({
    name: "get_publish_capabilities",
    description: "Checks supported Pagecast publication formats. Use before preparing a new page to share.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: () => lifetime.aborted
      ? failure("DISABLED", "Enable WebMCP in the dashboard first.")
      : { formats: ["html", "markdown"], maxBytes: 65536, confirmationRequired: true, localFilesAccessible: false }
  }, options);
  if (lifetime.aborted) return;
  await context.registerTool({
    name: "publish_content",
    description: "Publishes a new Pagecast page after the user reviews and confirms its source. Use when the user wants to share newly supplied content externally.",
    inputSchema: {
      type: "object", properties: {
        content: { type: "string", minLength: 1, maxLength: 65536, description: "Complete source to publish." },
        format: { type: "string", enum: ["html", "markdown"], description: "Source format." }
      }, required: ["content", "format"], additionalProperties: false
    },
    annotations: { consequentialHint: true, untrustedContentHint: true },
    async execute(args, execution) {
      if (lifetime.aborted) return failure("DISABLED", "Enable WebMCP in the dashboard first.");
      if (busy) return failure("BUSY", "Finish the pending publication before requesting another.");
      if (!args || Object.keys(args).some(key => !["content", "format"].includes(key)) ||
          typeof args.content !== "string" || !args.content.trim() ||
          new TextEncoder().encode(args.content).length > 65536 ||
          !["html", "markdown"].includes(String(args.format))) {
        return failure("INVALID_INPUT", "Supply only nonempty content (up to 64 KiB) and an html or markdown format.");
      }
      const input = Object.freeze({ content: args.content, format: args.format }) as Readonly<PublishInput>;
      const signal = AbortSignal.any([lifetime, execution?.signal ?? new AbortController().signal]);
      busy = true;
      try {
        signal.throwIfAborted();
        const approved = await deps.confirm(input, signal);
        signal.throwIfAborted();
        if (!approved) return failure("DECLINED", "The user declined publication. Do not retry without a new request.");
        const url = await deps.publish(input, signal);
        return { status: "published", url };
      } catch {
        return failure(signal.aborted ? "CANCELLED" : "PUBLISH_FAILED",
          "Publication did not complete or its outcome is unknown. Check the dashboard before trying again.");
      } finally { busy = false; }
    }
  }, options);
}
