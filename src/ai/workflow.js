// Host-side receipts survive failures in a later model request or UI refresh.
// They are deliberately separate from model-generated prose and conversation data.
const MUTATIONS = new Set(["pagecast_publish_content", "pagecast_revoke_publication"]);
const MAX_OPERATIONS = 64;
const STRING_LIMITS = { action: 32, linkKind: 64, expiresAt: 64, revokedAt: 64 };
function publicReceiptUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2048) return false;
  try {
    const url = new URL(value);
    // Pagecast's user-facing publication route, not an arbitrary admin/capability
    // link. Do not copy URL credentials, query signatures or fragment secrets.
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
      /^\/p\/[A-Za-z0-9._~-]+\/?$/.test(url.pathname) &&
      url.hostname !== "localhost" && !url.hostname.endsWith(".localhost") &&
      !url.hostname.endsWith(".local") && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(":");
  } catch { return false; }
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function receiptData(value) {
  const result = {};
  const publishedUrl = value?.url ?? value?.publicUrl;
  if (publicReceiptUrl(publishedUrl)) result.url = publishedUrl;
  // Publication identifiers remain in the original tool result contract, but
  // recovery errors deliberately omit all token fields and arbitrary labels.
  for (const [key, max] of Object.entries(STRING_LIMITS)) {
    // Never truncate an identifier or URL into a different apparent resource.
    if (typeof value?.[key] === "string" && Buffer.byteLength(value[key], "utf8") <= max) result[key] = value[key];
  }
  for (const key of ["passwordProtected", "active", "expired"]) if (typeof value?.[key] === "boolean") result[key] = value[key];
  return result;
}

export class PagecastWorkflowError extends Error {
  constructor(receipts) {
    super("Pagecast workflow interrupted after a mutation. Inspect receipts; do not retry completed or uncertain operations.");
    this.name = "PagecastWorkflowError";
    this.code = "workflow_interrupted";
    this.retrySafe = false;
    this.receipts = freeze(structuredClone(receipts));
    // Do not attach the provider's exception/cause: it can contain request text,
    // private conversation history, credentials or upstream response bodies.
  }
}

/** One bounded, in-memory workflow owned by the trusted application. */
export function createPagecastWorkflow(core) {
  const records = [];
  let attempts = 0;
  let uncertain = false;
  let mutationQueue = Promise.resolve();
  const wrapped = Object.freeze({
    listTools: () => core.listTools(),
    async execute(name, args) {
      if (!MUTATIONS.has(name)) return core.execute(name, args);
      const pending = mutationQueue.then(async () => {
        if (uncertain) return { ok: false, error: { code: "reconciliation_required", message: "A prior mutation has an uncertain outcome. Inspect receipts before another write." } };
        if (++attempts > MAX_OPERATIONS) throw new Error("Pagecast workflow mutation limit reached.");
        const receipt = { operation: attempts, tool: name, outcome: "unknown", retrySafe: false };
        // Record before awaiting the host. A thrown host/provider exception must
        // not be misreported as proof that a remote mutation never happened.
        records.push(receipt);
        let result;
        try { result = await core.execute(name, args); }
        catch (error) { uncertain = true; throw error; }
        if (result?.ok === true) {
          receipt.outcome = "succeeded";
          receipt.data = receiptData(name === "pagecast_revoke_publication" ? result.data?.publication : result.data);
        } else if (["unknown_tool", "invalid_arguments", "approval_required"].includes(result?.error?.code)) {
          records.splice(records.indexOf(receipt), 1); // proven not dispatched
        } else { uncertain = true; }
        return result;
      });
      mutationQueue = pending.catch(() => {});
      return pending;
    }
  });
  return Object.freeze({
    core: wrapped,
    get receipts() { return freeze(structuredClone(records)); },
    recover(error) { return records.length ? new PagecastWorkflowError(records) : error; }
  });
}
