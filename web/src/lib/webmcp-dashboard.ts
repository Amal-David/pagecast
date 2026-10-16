import { api } from "./api";
import { registerPublishingTools, type PublishInput } from "./webmcp";

export function confirmPublication(input: Readonly<PublishInput>, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Confirm external publication");
    dialog.style.cssText = "max-width:48rem;width:90%;padding:24px;background:white;color:black;border:2px solid #555;border-radius:12px";
    const heading = document.createElement("h2");
    heading.textContent = "Publish this page externally?";
    const warning = document.createElement("p");
    warning.textContent = "This creates a shareable URL using your configured Pagecast Cloudflare project and default link lifetime. Anyone with an unprotected link can read it. Review the entire source for secrets and personal data. HTML may run scripts and load external resources when opened. This new page has no password protection. No local files or referenced assets will be uploaded.";
    const source = document.createElement("pre");
    source.textContent = input.content; // Never render supplied HTML or Markdown.
    source.style.cssText = "white-space:pre-wrap;overflow:auto;max-height:50vh;border:1px solid #888;padding:12px";
    const format = document.createElement("p");
    format.textContent = `Format: ${input.format}; size: ${new TextEncoder().encode(input.content).length} bytes`;
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const approve = document.createElement("button");
    approve.textContent = "Publish externally";
    approve.style.marginLeft = "24px";
    const finish = (approved: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      dialog.remove();
      resolve(approved);
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, 120_000);
    cancel.addEventListener("click", () => finish(false));
    approve.addEventListener("click", event => { if (event.isTrusted && !signal.aborted) finish(true); });
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    signal.addEventListener("abort", abort, { once: true });
    dialog.append(heading, warning, format, source, cancel, approve);
    document.body.append(dialog);
    if (signal.aborted) finish(false);
    else { dialog.showModal(); cancel.focus(); }
  });
}

// Owns a small DOM control outside the React root; opt-in is tab-local and never persisted.
export function mountWebMcpControl(afterPublish: () => Promise<unknown>) {
  const context = document.modelContext;
  if (window.top !== window || !context || typeof context.registerTool !== "function") return;
  const label = document.createElement("label");
  label.style.cssText = "display:block;padding:12px 24px;background:#eef2ff;color:#111;font:14px system-ui";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const text = document.createTextNode(" Enable WebMCP publishing for this tab (confirmation required each time)");
  label.append(checkbox, text);
  document.body.prepend(label);
  let controller: AbortController | undefined;
  checkbox.addEventListener("change", async event => {
    controller?.abort();
    if (!event.isTrusted || !checkbox.checked) { checkbox.checked = false; return; }
    const active = new AbortController();
    controller = active;
    try {
      await registerPublishingTools(context, active.signal, {
        confirm: confirmPublication,
        async publish(input, signal) {
          const file = new File([input.content], input.format === "html" ? "webmcp.html" : "webmcp.md", {
            type: input.format === "html" ? "text/html" : "text/markdown"
          });
          const { report } = await api.uploadFile(file, signal);
          signal.throwIfAborted();
          const result = await api.publishSnapshot(report.id, undefined, signal);
          await afterPublish();
          if (!result.publication.publicUrl) throw new Error("Missing publication URL");
          return result.publication.publicUrl;
        }
      });
    } catch {
      active.abort();
      if (controller === active) { checkbox.checked = false; text.textContent = " WebMCP unavailable. Reload to try again."; }
    }
  });
  window.addEventListener("pagehide", () => { controller?.abort(); checkbox.checked = false; });
}
