import { getJob, jobArtifact, listJobs, listWebhookDeliveries, listWebhooks } from "./jobs";
import type { ControlRouteContext } from "./control-context";

/** Token coordination, webhook administration, and job control routes. */
export async function handleOperationsRoute(ctx: ControlRouteContext): Promise<Response | null> {
  const { request, env, url } = ctx;
  const tokensPath = /^\/v1\/owners\/([^/]+)\/tokens(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
  if (tokensPath) {
    const [, ownerId, tokenId] = tokensPath;
    if (!ctx.owns(ownerId)) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !tokenId) return ctx.hasScope("tokens:read") ? ctx.listTokens(ownerId) : ctx.error("forbidden", 403);
    if (request.method === "POST" && !tokenId) return ctx.hasScope("tokens:write") ? ctx.createToken(ownerId) : ctx.error("forbidden", 403);
    if (request.method === "DELETE" && tokenId) return ctx.hasScope("tokens:write") ? ctx.revokeToken(ownerId, tokenId) : ctx.error("forbidden", 403);
  }

  const coordinatorPath = /^\/v1\/owners\/([^/]+)\/coordinator$/.exec(url.pathname);
  if (coordinatorPath && request.method === "POST") {
    const ownerId = coordinatorPath[1];
    return ctx.owns(ownerId) && ctx.hasScope("mutations:write") ? ctx.coordinateMutation(ownerId) : ctx.error("forbidden", 403);
  }

  const webhookDeliveryPath = /^\/v1\/owners\/([^/]+)\/webhooks\/([0-9a-f-]{36})\/deliveries(?:\/([0-9a-f-]{36})(?:\/(retry))?)?$/.exec(url.pathname);
  if (webhookDeliveryPath) {
    const [, ownerId, webhookId, deliveryId, retry] = webhookDeliveryPath;
    if (!ctx.owns(ownerId) || !ctx.hasScope(request.method === "GET" ? "webhooks:read" : "webhooks:write")) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !deliveryId) return listWebhookDeliveries(env, ownerId, webhookId);
    if (request.method === "POST" && deliveryId && retry) return ctx.operationsMutation(ownerId, { kind: "operations", operation: "retry-delivery", data: { deliveryId } });
  }

  const webhookRotationPath = /^\/v1\/owners\/([^/]+)\/webhooks\/([0-9a-f-]{36})\/rotate$/.exec(url.pathname);
  if (webhookRotationPath && request.method === "POST") {
    const [, ownerId, webhookId] = webhookRotationPath;
    if (!ctx.owns(ownerId) || !ctx.hasScope("webhooks:write")) return ctx.error("forbidden", 403);
    return ctx.operationsMutation(ownerId, { kind: "operations", operation: "rotate-webhook", data: { webhookId } });
  }

  const webhookPath = /^\/v1\/owners\/([^/]+)\/webhooks(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
  if (webhookPath) {
    const [, ownerId, webhookId] = webhookPath;
    if (!ctx.owns(ownerId) || !ctx.hasScope(request.method === "GET" ? "webhooks:read" : "webhooks:write")) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !webhookId) return listWebhooks(env, ownerId);
    if (request.method === "POST" && !webhookId) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || Object.keys(parsed.payload).some((key) => !["destination", "eventTypes"].includes(key))) return ctx.error("invalid_webhook", 400);
      return ctx.operationsMutation(ownerId, { kind: "operations", operation: "create-webhook", data: { destination: parsed.payload.destination, eventTypes: parsed.payload.eventTypes } });
    }
    if (request.method === "PATCH" && webhookId) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || Object.keys(parsed.payload).some((key) => !["destination", "eventTypes", "disabled"].includes(key))) return ctx.error("invalid_webhook", 400);
      return ctx.operationsMutation(ownerId, { kind: "operations", operation: "update-webhook", data: { webhookId, ...parsed.payload } });
    }
    if (request.method === "DELETE" && webhookId) return ctx.operationsMutation(ownerId, { kind: "operations", operation: "delete-webhook", data: { webhookId } });
  }

  const jobArtifactPath = /^\/v1\/owners\/([^/]+)\/jobs\/([0-9a-f-]{36})\/artifact$/.exec(url.pathname);
  if (jobArtifactPath && request.method === "GET") {
    const [, ownerId, jobId] = jobArtifactPath;
    return ctx.owns(ownerId) && ctx.hasScope("jobs:read") ? jobArtifact(env, ownerId, jobId) : ctx.error("forbidden", 403);
  }

  const jobActionPath = /^\/v1\/owners\/([^/]+)\/jobs\/([0-9a-f-]{36})\/(cancel|retry)$/.exec(url.pathname);
  if (jobActionPath && request.method === "POST") {
    const [, ownerId, jobId, action] = jobActionPath;
    if (!ctx.owns(ownerId) || !ctx.hasScope("jobs:write")) return ctx.error("forbidden", 403);
    return ctx.operationsMutation(ownerId, action === "cancel" ? { kind: "operations", operation: "cancel-job", data: { jobId } } : { kind: "operations", operation: "retry-job", data: { jobId } });
  }

  const jobPath = /^\/v1\/owners\/([^/]+)\/jobs(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
  if (jobPath) {
    const [, ownerId, jobId] = jobPath;
    if (!ctx.owns(ownerId) || !ctx.hasScope(request.method === "GET" ? "jobs:read" : "jobs:write")) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !jobId) return listJobs(env, ownerId);
    if (request.method === "GET" && jobId) return getJob(env, ownerId, jobId);
    if (request.method === "POST" && !jobId) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || Object.keys(parsed.payload).some((key) => !["kind", "publicationId", "versionId", "dedupeKey", "payload"].includes(key))) return ctx.error("invalid_job", 400);
      return ctx.operationsMutation(ownerId, { kind: "operations", operation: "create-job", data: parsed.payload as { kind: unknown; publicationId?: unknown; versionId?: unknown; dedupeKey: unknown; payload?: unknown } });
    }
  }

  return null;
}
