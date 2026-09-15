import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { activeMembership, roleAllows } from "./collaboration";
import type { AuthActor } from "./auth";
import { isPagecastId } from "./identifiers";
import type { Env } from "./types";

type ControlDispatcher = (request: Request, env: Env, url: URL) => Promise<Response>;
type Authenticator = (request: Request, env: Env) => Promise<AuthActor | null>;

interface McpDependencies {
  authenticate: Authenticator;
  dispatchControl: ControlDispatcher;
}

type CollaborationRole = "owner" | "commenter" | "editor" | "approver";

const MAX_MCP_INLINE_UPLOAD_BYTES = 1024 * 1024;
const MAX_MCP_INLINE_UPLOAD_BASE64_CHARS = 4 * Math.ceil(MAX_MCP_INLINE_UPLOAD_BYTES / 3);

type ToolCapability = {
  action: string;
  tool: string;
  scope: string;
  roles?: readonly CollaborationRole[];
  requirement?: string;
  destructive?: true;
  exception?: never;
};

type ExceptionCapability = {
  action: string;
  exception?: string;
  tool?: never;
  scope?: never;
  roles?: never;
  requirement?: never;
  destructive?: never;
};

/** Every remote dashboard action has one concrete MCP contract or a user-only exception. */
export const MCP_CAPABILITY_MAP: readonly (ToolCapability | ExceptionCapability)[] = [
  { action: "pagecast_status", tool: "pagecast_status", scope: "status:read" },
  { action: "publication_list", tool: "publication_list", scope: "publications:read" },
  { action: "publication_get", tool: "publication_get", scope: "publications:read" },
  { action: "publication_list_versions", tool: "publication_list_versions", scope: "publications:read" },
  { action: "publication_create_upload_session", tool: "publication_create_upload_session", scope: "publications:write" },
  { action: "publication_upload_file", tool: "publication_upload_file", scope: "publications:write" },
  { action: "publication_upload_session_status", tool: "publication_upload_session_status", scope: "publications:read" },
  { action: "publication_complete_upload_session", tool: "publication_complete_upload_session", scope: "publications:write" },
  { action: "publication_activate_version", tool: "publication_activate_version", scope: "publications:write" },
  { action: "publication_delete_version", tool: "publication_delete_version", scope: "publications:write", destructive: true },
  { action: "publication_rename", tool: "publication_rename", scope: "publications:write" },
  { action: "publication_revoke", tool: "publication_revoke", scope: "publications:write", destructive: true },
  { action: "publication_restore", tool: "publication_restore", scope: "publications:write" },
  { action: "access_get_policy", tool: "access_get_policy", scope: "publications:read" },
  { action: "access_set_policy", tool: "access_set_policy", scope: "publications:write" },
  { action: "access_list_grants", tool: "access_list_grants", scope: "publications:read" },
  { action: "access_create_grant", tool: "access_create_grant", scope: "publications:write" },
  { action: "access_revoke_grant", tool: "access_revoke_grant", scope: "publications:write", destructive: true },
  { action: "organization_get", tool: "organization_get", scope: "collaboration:admin", roles: ["owner"] },
  { action: "organization_set", tool: "organization_set", scope: "collaboration:admin", roles: ["owner"] },
  { action: "actor_list", tool: "actor_list", scope: "collaboration:admin", roles: ["owner"] },
  { action: "actor_get", tool: "actor_get", scope: "collaboration:admin", roles: ["owner"] },
  { action: "actor_create", tool: "actor_create", scope: "collaboration:admin", roles: ["owner"] },
  { action: "actor_update", tool: "actor_update", scope: "collaboration:admin", roles: ["owner"] },
  { action: "actor_remove", tool: "actor_remove", scope: "collaboration:admin", roles: ["owner"], destructive: true },
  { action: "membership_list", tool: "membership_list", scope: "collaboration:admin", roles: ["owner"] },
  { action: "membership_invite", tool: "membership_invite", scope: "collaboration:admin", roles: ["owner"] },
  { action: "membership_accept", tool: "membership_accept", scope: "collaboration:write", requirement: "Token-bound invited actor with a pending membership and its invitation credential." },
  { action: "membership_remove", tool: "membership_remove", scope: "collaboration:admin", roles: ["owner"], destructive: true },
  { action: "collaboration_grant_create", tool: "collaboration_grant_create", scope: "collaboration:admin", roles: ["owner"] },
  { action: "collaboration_grant_revoke", tool: "collaboration_grant_revoke", scope: "collaboration:admin", roles: ["owner"], destructive: true },
  { action: "comment_list", tool: "comment_list", scope: "collaboration:read", roles: ["commenter", "editor", "approver", "owner"] },
  { action: "comment_create", tool: "comment_create", scope: "collaboration:write", roles: ["commenter", "editor", "approver", "owner"] },
  { action: "comment_update", tool: "comment_update", scope: "collaboration:write", roles: ["commenter", "editor", "approver", "owner"] },
  { action: "comment_resolve", tool: "comment_resolve", scope: "collaboration:write", roles: ["commenter", "editor", "approver", "owner"] },
  { action: "comment_delete", tool: "comment_delete", scope: "collaboration:write", roles: ["commenter", "editor", "approver", "owner"], destructive: true },
  { action: "review_list", tool: "review_list", scope: "collaboration:read", roles: ["approver", "owner"] },
  { action: "review_decide", tool: "review_decide", scope: "reviews:write", roles: ["approver", "owner"] },
  { action: "analytics_summary", tool: "analytics_summary", scope: "analytics:read" },
  { action: "analytics_timeseries", tool: "analytics_timeseries", scope: "analytics:read" },
  { action: "analytics_events", tool: "analytics_events", scope: "analytics:read" },
  { action: "audit_list", tool: "audit_list", scope: "audit:read" },
  { action: "webhook_list", tool: "webhook_list", scope: "webhooks:read" },
  { action: "webhook_create", tool: "webhook_create", scope: "webhooks:write" },
  { action: "webhook_update", tool: "webhook_update", scope: "webhooks:write" },
  { action: "webhook_delete", tool: "webhook_delete", scope: "webhooks:write", destructive: true },
  { action: "webhook_delivery_list", tool: "webhook_delivery_list", scope: "webhooks:read" },
  { action: "webhook_delivery_retry", tool: "webhook_delivery_retry", scope: "webhooks:write", destructive: true },
  { action: "webhook_rotate_secret", tool: "webhook_rotate_secret", scope: "webhooks:write" },
  { action: "job_list", tool: "job_list", scope: "jobs:read" },
  { action: "job_get", tool: "job_get", scope: "jobs:read" },
  { action: "job_get_artifact", tool: "job_get_artifact", scope: "jobs:read" },
  { action: "job_create", tool: "job_create", scope: "jobs:write" },
  { action: "job_cancel", tool: "job_cancel", scope: "jobs:write", destructive: true },
  { action: "job_retry", tool: "job_retry", scope: "jobs:write", destructive: true },
  { action: "bootstrap_credentials", exception: "User-only: bootstrap and personal-token credential ceremonies are never MCP authentication methods." },
  { action: "idp_ceremonies", exception: "User-only: no standards OAuth or IdP flow is implemented by this endpoint." },
  { action: "local_filesystem_and_build", exception: "User-only: the remote Worker never reads local paths or invokes local commands." },
];

/** Derived from the explicit capability rows; runtime tools/list still proves registration. */
export const MCP_REGISTERED_TOOL_NAMES = new Set(MCP_CAPABILITY_MAP.flatMap((capability) => "tool" in capability && capability.tool ? [capability.tool] : []));

const id = z.string().refine(isPagecastId, "invalid Pagecast ID");
const uuid = z.string().uuid();
const idempotency = z.string().regex(/^[\x21-\x7e]{1,255}$/);
const payload = z.record(z.string(), z.unknown());

function hasScope(actor: AuthActor, scope: string): boolean {
  return actor.kind === "token" && (actor.scopes.includes("*") || actor.scopes.includes(scope));
}

function toolResult(status: number, value: unknown, isError = status >= 400, revealCredential = false) {
  const safe = redact(value, revealCredential);
  const result = {
    ok: !isError,
    status,
    result: safe,
    recovery: recoveryFor(status, safe),
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(isError ? { isError: true } : {}) };
}

function recoveryFor(status: number, value: unknown): string {
  if (status === 401 || status === 403) return "Use a non-expired Pagecast token for this owner with the required scope and membership.";
  if (status === 409) return "Reuse the original idempotency key to retrieve its receipt, or choose a new key only for a new operation.";
  if (status === 429) return "Wait before retrying; do not create a new idempotency key for the same operation.";
  if (status >= 500) return "Retry with the same idempotency key; if it persists, inspect the Pagecast dashboard delivery or job history.";
  if (value && typeof value === "object" && "error" in value) return "Correct the tool input and retry the intended operation with a fresh idempotency key.";
  return "Keep returned IDs and idempotency keys to inspect or safely retry this operation.";
}

function redact(value: unknown, revealCredential = false): unknown {
  if (Array.isArray(value)) return value.map((child) => redact(child, revealCredential));
  if (!value || typeof value !== "object") return typeof value === "string" && (!revealCredential && /^(?:pcv2|pcg2?|pcm2|pcwh)_/.test(value) || /-[a-f0-9]{32}$/i.test(value) || /\/p\/[^/?#]+-[a-f0-9]{32}(?:[/?#]|$)/i.test(value)) ? "[redacted]" : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
    ["token", "secret", "credential", "invitation", "password", "visitor", "address_hmac", "r2_key", "r2key", "artifact_key", "artifactkey", "manifest_key", "manifestkey", "authorization", "cookie"].includes(key.toLowerCase()) && !revealCredential
      ? []
      : [[key, redact(child, revealCredential)]]
  )));
}

function rejected(message: string) {
  return toolResult(400, { error: message }, true);
}

function mcpRequest(request: Request, pathname: string, method: string, body: unknown, idempotencyKey?: string): Request {
  const headers = new Headers({ Accept: "application/json" });
  const authorization = request.headers.get("Authorization");
  const accessIdentity = request.headers.get("Cf-Access-Jwt-Assertion");
  if (authorization) headers.set("Authorization", authorization);
  if (accessIdentity) headers.set("Cf-Access-Jwt-Assertion", accessIdentity);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(new URL(pathname, request.url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function invokeControl(request: Request, env: Env, dispatchControl: ControlDispatcher, pathname: string, method: string, body?: unknown, idempotencyKey?: string, revealCredential = false) {
  const synthetic = mcpRequest(request, pathname, method, body, idempotencyKey);
  const response = await dispatchControl(synthetic, env, new URL(synthetic.url));
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return toolResult(response.status, { artifact: true, contentType: contentType || null }, !response.ok);
  return toolResult(response.status, await response.json<unknown>(), !response.ok, revealCredential);
}

function registerControlTool(
  server: McpServer,
  actor: AuthActor,
  request: Request,
  env: Env,
  dispatchControl: ControlDispatcher,
  spec: {
    name: string;
    description: string;
    scope: string;
    inputSchema?: z.ZodObject<z.ZodRawShape>;
    write?: boolean;
    destructive?: boolean;
    revealCredential?: boolean;
    route: (input: Record<string, unknown>) => { pathname: string; method: string; body?: unknown };
  },
): void {
  if (!hasScope(actor, spec.scope)) return;
  const base = spec.inputSchema ?? z.object({});
  const schema = spec.write
    ? base.extend({ idempotencyKey: idempotency, ...(spec.destructive ? { confirm: z.literal(true) } : {}) })
    : base;
  server.registerTool(spec.name, { description: spec.description, inputSchema: schema }, async (input) => {
    const value = input as Record<string, unknown>;
    if (spec.destructive && value.confirm !== true) return rejected("confirmation_required");
    const route = spec.route(value);
    return invokeControl(request, env, dispatchControl, route.pathname, route.method, route.body, typeof value.idempotencyKey === "string" ? value.idempotencyKey : undefined, spec.revealCredential);
  });
}

function ownerRoute(actor: AuthActor, suffix: string): string {
  return `/v1/owners/${encodeURIComponent(actor.ownerId!)}/${suffix}`;
}

function registerAuditTool(server: McpServer, actor: AuthActor, env: Env): void {
  if (!hasScope(actor, "audit:read")) return;
  server.registerTool("audit_list", {
    description: "List this owner’s redacted audit records. Raw visitor identifiers, credentials, and local paths are never returned.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  }, async ({ limit }) => {
    const rows = await env.DB.prepare("SELECT id, actor_id, action, resource_type, resource_id, metadata_json, occurred_at FROM audit_events WHERE owner_id = ? ORDER BY occurred_at DESC LIMIT ?")
      .bind(actor.ownerId, limit ?? 50).all<Record<string, unknown>>();
    const events = rows.results.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadata: safeMetadata(row.metadata_json),
      occurredAt: row.occurred_at,
    }));
    return toolResult(200, { events });
  });
}

function safeMetadata(value: unknown): unknown {
  try { return redact(JSON.parse(String(value))); } catch { return {}; }
}

async function buildServer(actor: AuthActor, request: Request, env: Env, dispatchControl: ControlDispatcher): Promise<McpServer> {
  if (actor.kind !== "token") throw new Error("MCP requires a Pagecast token");
  const server = new McpServer({ name: "pagecast", version: "2.0.0" });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "pagecast_status", description: "Read Pagecast Worker status.", scope: "status:read", route: () => ({ pathname: "/v1/status", method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_list", description: "List publications owned by this token.", scope: "publications:read", route: () => ({ pathname: ownerRoute(actor, "publications"), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_get", description: "Read safe publication metadata.", scope: "publications:read", inputSchema: z.object({ publicationId: id }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}?include=publication`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_list_versions", description: "List immutable versions for one publication.", scope: "publications:read", inputSchema: z.object({ publicationId: id, before: z.number().int().positive().optional() }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}${v.before ? `?before=${v.before}` : ""}`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_create_upload_session", description: "Create an upload session from a validated publication manifest. The returned IDs are safe to use in later tools.", scope: "publications:write", write: true, inputSchema: z.object({ mode: z.enum(["create", "context-upsert", "new-link", "explicit-update"]), title: z.string().min(1).max(255), slug: z.string().min(1).max(128).optional(), linkKind: z.enum(["public", "unlisted"]), contextKey: z.string().min(1).max(255).optional(), publicationId: id.optional(), manifest: payload }), route: (v) => ({ pathname: ownerRoute(actor, "upload-sessions"), method: "POST", body: { mode: v.mode, title: v.title, slug: v.slug, linkKind: v.linkKind, contextKey: v.contextKey, publicationId: v.publicationId, manifest: v.manifest } }) });
  if (hasScope(actor, "publications:write")) {
    server.registerTool("publication_upload_file", {
      description: "Upload one manifest-declared file up to 1 MiB from base64 content. It never reads a local path or URL; use the streaming HTTP upload-session file endpoint for larger assets.",
      inputSchema: z.object({ sessionId: uuid, path: z.string().min(1).max(1024), contentType: z.string().min(1).max(255), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentBase64: z.string().min(1).max(MAX_MCP_INLINE_UPLOAD_BASE64_CHARS), idempotencyKey: idempotency }),
    }, async ({ sessionId, path, contentType, sha256, contentBase64, idempotencyKey }) => {
      let bytes: Uint8Array;
      try {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) return rejected("invalid_base64_content");
        const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
        if ((contentBase64.length / 4) * 3 - padding > MAX_MCP_INLINE_UPLOAD_BYTES) return rejected("mcp_inline_upload_too_large_use_streaming_http");
        bytes = Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0));
      } catch { return rejected("invalid_base64_content"); }
      if (bytes.byteLength > MAX_MCP_INLINE_UPLOAD_BYTES) return rejected("mcp_inline_upload_too_large_use_streaming_http");
      const headers = new Headers({ "content-type": contentType, "X-Content-SHA256": sha256, "Idempotency-Key": idempotencyKey, Accept: "application/json" });
      const authorization = request.headers.get("Authorization");
      const accessIdentity = request.headers.get("Cf-Access-Jwt-Assertion");
      if (authorization) headers.set("Authorization", authorization);
      if (accessIdentity) headers.set("Cf-Access-Jwt-Assertion", accessIdentity);
      const synthetic = new Request(new URL(ownerRoute(actor, `upload-sessions/${sessionId}/files/${encodeURIComponent(path)}`), request.url), { method: "PUT", headers, body: bytes });
      const response = await dispatchControl(synthetic, env, new URL(synthetic.url));
      return toolResult(response.status, await response.json<unknown>(), !response.ok);
    });
  }
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_complete_upload_session", description: "Finalize a fully uploaded immutable version.", scope: "publications:write", write: true, inputSchema: z.object({ sessionId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `upload-sessions/${v.sessionId}/complete`), method: "POST" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_upload_session_status", description: "Read upload-session progress and recovery state.", scope: "publications:read", inputSchema: z.object({ sessionId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `upload-sessions/${v.sessionId}`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_activate_version", description: "Activate a completed version, or roll back by activating an earlier version.", scope: "publications:write", write: true, inputSchema: z.object({ publicationId: id, versionId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/versions/${v.versionId}/activate`), method: "POST" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_delete_version", description: "Permanently delete a non-active version after explicit confirmation.", scope: "publications:write", write: true, destructive: true, inputSchema: z.object({ publicationId: id, versionId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/versions/${v.versionId}`), method: "DELETE" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_rename", description: "Rename a publication’s stable slug.", scope: "publications:write", write: true, inputSchema: z.object({ publicationId: id, slug: z.string().min(1).max(128) }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/rename`), method: "POST", body: { slug: v.slug } }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_revoke", description: "Revoke public delivery for a publication after explicit confirmation.", scope: "publications:write", write: true, destructive: true, inputSchema: z.object({ publicationId: id }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/revoke`), method: "POST" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "publication_restore", description: "Restore a previously revoked publication.", scope: "publications:write", write: true, inputSchema: z.object({ publicationId: id }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/restore`), method: "POST" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "access_set_policy", description: "Set public, unlisted, password, or allowlist access policy for a publication.", scope: "publications:write", write: true, inputSchema: z.object({ publicationId: id, policy: payload }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/access-policy`), method: "PUT", body: v.policy }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "access_get_policy", description: "Read access policy without password material.", scope: "publications:read", inputSchema: z.object({ publicationId: id }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/access-policy`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "access_list_grants", description: "List redacted access grants.", scope: "publications:read", inputSchema: z.object({ publicationId: id }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/grants`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "access_revoke_grant", description: "Revoke an access grant after explicit confirmation. The grant secret is never exposed.", scope: "publications:write", write: true, destructive: true, inputSchema: z.object({ publicationId: id, grantId: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/) }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/grants/${v.grantId}`), method: "DELETE" }) });
  registerControlTool(server, actor, request, env, dispatchControl, { name: "access_create_grant", description: "Create a one-time access grant and return its credential exactly once.", scope: "publications:write", write: true, revealCredential: true, inputSchema: z.object({ publicationId: id, grant: payload }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/grants`), method: "POST", body: v.grant }) });

  const membership = actor.actorId ? await activeMembership(env.DB, actor.ownerId, actor.actorId) : null;
  registerCollaborationTools(server, actor, request, env, dispatchControl, {
    admin: membership?.role === "owner",
    comment: membership ? roleAllows(membership.role, "publication:comment") : false,
    review: membership ? roleAllows(membership.role, "publication:review") : false,
  });
  registerAnalyticsTools(server, actor, request, env, dispatchControl);
  registerAuditTool(server, actor, env);
  registerWebhookTools(server, actor, request, env, dispatchControl);
  registerJobTools(server, actor, request, env, dispatchControl);
  return server;
}

function registerCollaborationTools(server: McpServer, actor: AuthActor, request: Request, env: Env, dispatch: ControlDispatcher, permissions: { admin: boolean; comment: boolean; review: boolean }): void {
  if (actor.kind !== "token") return;
  const admin = "collaboration:admin";
  if (actor.actorId && hasScope(actor, "collaboration:write")) {
    server.registerTool("membership_accept", { description: "Accept an invitation credential for the token-bound actor.", inputSchema: z.object({ membershipId: id, invitation: z.string().regex(/^pcm2_[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{32,}$/), idempotencyKey: idempotency }) }, async ({ membershipId, invitation, idempotencyKey }) => {
      const headers = new Headers({ Authorization: request.headers.get("Authorization") ?? "", "X-Pagecast-Invitation": invitation, "Idempotency-Key": idempotencyKey });
      const synthetic = new Request(new URL(ownerRoute(actor, `memberships/${membershipId}/accept`), request.url), { method: "POST", headers });
      const response = await dispatch(synthetic, env, new URL(synthetic.url));
      return toolResult(response.status, await response.json<unknown>(), !response.ok);
    });
  }
  if (permissions.admin) {
  registerControlTool(server, actor, request, env, dispatch, { name: "organization_get", description: "Read the owner organization.", scope: admin, route: () => ({ pathname: ownerRoute(actor, "organization"), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "organization_set", description: "Update organization display data.", scope: admin, write: true, inputSchema: z.object({ organization: payload }), route: (v) => ({ pathname: ownerRoute(actor, "organization"), method: "PUT", body: v.organization }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "actor_list", description: "List collaboration actors.", scope: admin, route: () => ({ pathname: ownerRoute(actor, "actors"), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "actor_get", description: "Read a collaboration actor.", scope: admin, inputSchema: z.object({ actorId: id }), route: (v) => ({ pathname: ownerRoute(actor, `actors/${v.actorId}`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "actor_create", description: "Create a collaboration actor.", scope: admin, write: true, inputSchema: z.object({ actor: payload }), route: (v) => ({ pathname: ownerRoute(actor, "actors"), method: "POST", body: v.actor }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "actor_update", description: "Update a collaboration actor.", scope: admin, write: true, inputSchema: z.object({ actorId: id, actor: payload }), route: (v) => ({ pathname: ownerRoute(actor, `actors/${v.actorId}`), method: "PATCH", body: v.actor }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "actor_remove", description: "Remove a collaboration actor after explicit confirmation.", scope: admin, write: true, destructive: true, inputSchema: z.object({ actorId: id }), route: (v) => ({ pathname: ownerRoute(actor, `actors/${v.actorId}`), method: "DELETE" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "membership_list", description: "List memberships.", scope: admin, route: () => ({ pathname: ownerRoute(actor, "memberships"), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "membership_remove", description: "Remove a membership after explicit confirmation.", scope: admin, write: true, destructive: true, inputSchema: z.object({ membershipId: id }), route: (v) => ({ pathname: ownerRoute(actor, `memberships/${v.membershipId}`), method: "DELETE" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "collaboration_grant_revoke", description: "Revoke a collaboration grant after explicit confirmation.", scope: admin, write: true, destructive: true, inputSchema: z.object({ grantId: id }), route: (v) => ({ pathname: ownerRoute(actor, `collaboration-grants/${v.grantId}`), method: "DELETE" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "membership_invite", description: "Invite an actor and return the invitation credential exactly once.", scope: admin, write: true, revealCredential: true, inputSchema: z.object({ membership: payload }), route: (v) => ({ pathname: ownerRoute(actor, "memberships"), method: "POST", body: v.membership }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "collaboration_grant_create", description: "Create a collaboration grant and return its credential exactly once.", scope: admin, write: true, revealCredential: true, inputSchema: z.object({ grant: payload }), route: (v) => ({ pathname: ownerRoute(actor, "collaboration-grants"), method: "POST", body: v.grant }) });
  }
  if (!permissions.comment) return;
  registerControlTool(server, actor, request, env, dispatch, { name: "comment_list", description: "List comments on a publication.", scope: "collaboration:read", inputSchema: z.object({ publicationId: id }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/comments`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "comment_create", description: "Create a version-bound review comment.", scope: "collaboration:write", write: true, inputSchema: z.object({ publicationId: id, comment: payload }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/comments`), method: "POST", body: v.comment }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "comment_update", description: "Update one of your comments.", scope: "collaboration:write", write: true, inputSchema: z.object({ publicationId: id, commentId: id, comment: payload }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/comments/${v.commentId}`), method: "PATCH", body: v.comment }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "comment_resolve", description: "Resolve or reopen a comment.", scope: "collaboration:write", write: true, inputSchema: z.object({ publicationId: id, commentId: id, resolved: z.boolean() }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/comments/${v.commentId}/resolve`), method: "POST", body: { resolved: v.resolved } }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "comment_delete", description: "Delete an authorized comment after explicit confirmation.", scope: "collaboration:write", write: true, destructive: true, inputSchema: z.object({ publicationId: id, commentId: id }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/comments/${v.commentId}`), method: "DELETE" }) });
  if (!permissions.review) return;
  registerControlTool(server, actor, request, env, dispatch, { name: "review_list", description: "List version review decisions.", scope: "collaboration:read", inputSchema: z.object({ publicationId: id }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/reviews`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "review_decide", description: "Record an approved, rejected, or changes-requested review decision.", scope: "reviews:write", write: true, inputSchema: z.object({ publicationId: id, review: payload }), route: (v) => ({ pathname: ownerRoute(actor, `publications/${v.publicationId}/reviews`), method: "POST", body: v.review }) });
}

function registerAnalyticsTools(server: McpServer, actor: AuthActor, request: Request, env: Env, dispatch: ControlDispatcher): void {
  for (const kind of ["summary", "timeseries", "events"] as const) {
    registerControlTool(server, actor, request, env, dispatch, {
      name: `analytics_${kind}`,
      description: `Read privacy-preserving ${kind} analytics for a publication.`,
      scope: "analytics:read",
      inputSchema: z.object({ publicationId: id, from: z.string().datetime().optional(), to: z.string().datetime().optional() }),
      route: (v) => {
        const query = new URLSearchParams({ publicationId: String(v.publicationId) });
        if (typeof v.from === "string") query.set("from", v.from);
        if (typeof v.to === "string") query.set("to", v.to);
        return { pathname: ownerRoute(actor, `analytics/${kind}?${query}`), method: "GET" };
      },
    });
  }
}

function registerWebhookTools(server: McpServer, actor: AuthActor, request: Request, env: Env, dispatch: ControlDispatcher): void {
  registerControlTool(server, actor, request, env, dispatch, { name: "webhook_list", description: "List webhook subscriptions without their secrets.", scope: "webhooks:read", route: () => ({ pathname: ownerRoute(actor, "webhooks"), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "webhook_create", description: "Create a webhook subscription and return its delivery secret exactly once.", scope: "webhooks:write", write: true, revealCredential: true, inputSchema: z.object({ webhook: payload }), route: (v) => ({ pathname: ownerRoute(actor, "webhooks"), method: "POST", body: v.webhook }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "webhook_update", description: "Update a webhook destination or event types.", scope: "webhooks:write", write: true, inputSchema: z.object({ webhookId: uuid, webhook: payload }), route: (v) => ({ pathname: ownerRoute(actor, `webhooks/${v.webhookId}`), method: "PATCH", body: v.webhook }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "webhook_delete", description: "Delete a webhook after explicit confirmation.", scope: "webhooks:write", write: true, destructive: true, inputSchema: z.object({ webhookId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `webhooks/${v.webhookId}`), method: "DELETE" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "webhook_delivery_list", description: "List delivery status and retry information for one webhook.", scope: "webhooks:read", inputSchema: z.object({ webhookId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `webhooks/${v.webhookId}/deliveries`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "webhook_delivery_retry", description: "Retry a dead-lettered or retrying webhook delivery.", scope: "webhooks:write", write: true, destructive: true, inputSchema: z.object({ webhookId: uuid, deliveryId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `webhooks/${v.webhookId}/deliveries/${v.deliveryId}/retry`), method: "POST" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "webhook_rotate_secret", description: "Rotate a webhook delivery secret and return the new value exactly once.", scope: "webhooks:write", write: true, revealCredential: true, inputSchema: z.object({ webhookId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `webhooks/${v.webhookId}/rotate`), method: "POST" }) });
}

function registerJobTools(server: McpServer, actor: AuthActor, request: Request, env: Env, dispatch: ControlDispatcher): void {
  registerControlTool(server, actor, request, env, dispatch, { name: "job_list", description: "List asynchronous jobs and their recovery state.", scope: "jobs:read", route: () => ({ pathname: ownerRoute(actor, "jobs"), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "job_get", description: "Read one asynchronous job.", scope: "jobs:read", inputSchema: z.object({ jobId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `jobs/${v.jobId}`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "job_get_artifact", description: "Confirm that a job artifact exists. Binary artifact bytes are not placed in MCP context.", scope: "jobs:read", inputSchema: z.object({ jobId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `jobs/${v.jobId}/artifact`), method: "GET" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "job_create", description: "Create an asynchronous render, check, index, or cleanup job. The idempotency key is also used as the job dedupe key.", scope: "jobs:write", write: true, inputSchema: z.object({ job: payload }), route: (v) => ({ pathname: ownerRoute(actor, "jobs"), method: "POST", body: { ...(v.job as Record<string, unknown>), dedupeKey: v.idempotencyKey } }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "job_cancel", description: "Cancel an asynchronous job after explicit confirmation.", scope: "jobs:write", write: true, destructive: true, inputSchema: z.object({ jobId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `jobs/${v.jobId}/cancel`), method: "POST" }) });
  registerControlTool(server, actor, request, env, dispatch, { name: "job_retry", description: "Retry a failed asynchronous job.", scope: "jobs:write", write: true, destructive: true, inputSchema: z.object({ jobId: uuid }), route: (v) => ({ pathname: ownerRoute(actor, `jobs/${v.jobId}/retry`), method: "POST" }) });
}

async function tokenExpiry(env: Env, actor: AuthActor): Promise<number | null> {
  if (actor.kind !== "token") return null;
  const row = await env.DB.prepare("SELECT expires_at FROM api_tokens WHERE id = ? AND owner_id = ? AND revoked_at IS NULL").bind(actor.tokenId, actor.ownerId).first<{ expires_at: string | null }>();
  const milliseconds = row?.expires_at === null || row?.expires_at === undefined ? NaN : Date.parse(row.expires_at);
  return Number.isFinite(milliseconds) && milliseconds > Date.now() ? Math.floor(milliseconds / 1_000) : null;
}

function configuredHostnames(value: string | undefined): string[] {
  return (value ?? "").split(",").map((hostname) => hostname.trim().toLowerCase()).filter((hostname) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname));
}

function strictRequestAllowed(request: Request, env: Env): { rejection: Response | null; hostnames: string[]; origins: string[] } {
  const url = new URL(request.url);
  const configuredHosts = configuredHostnames(env.MCP_ALLOWED_HOSTNAMES);
  const configuredOrigins = configuredHostnames(env.MCP_ALLOWED_ORIGIN_HOSTNAMES);
  const localOrWorkersDev = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".workers.dev");
  const hostnames = configuredHosts.length > 0 ? configuredHosts : localOrWorkersDev ? [url.hostname] : [];
  const origins = configuredOrigins.length > 0 ? configuredOrigins : localOrWorkersDev ? [url.hostname] : [];
  if (!hostnames.includes(url.hostname.toLowerCase())) return { rejection: Response.json({ error: "mcp_host_configuration_required" }, { status: 503 }), hostnames, origins };
  const host = request.headers.get("Host");
  if (host && !hostnames.includes(host.split(":", 1)[0].toLowerCase())) return { rejection: Response.json({ error: "invalid_host" }, { status: 403 }), hostnames, origins };
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol !== "https:" && !(localOrWorkersDev && parsed.protocol === "http:")) || !origins.includes(parsed.hostname.toLowerCase())) return { rejection: Response.json({ error: "invalid_origin" }, { status: 403 }), hostnames, origins };
    } catch { return { rejection: Response.json({ error: "invalid_origin" }, { status: 403 }), hostnames, origins }; }
  }
  if (request.method !== "POST") return { rejection: Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } }), hostnames, origins };
  return { rejection: null, hostnames, origins };
}

async function isBatch(request: Request): Promise<boolean> {
  try { return Array.isArray(await request.clone().json()); } catch { return false; }
}

export async function handleMcpRequest(request: Request, env: Env, _ctx: ExecutionContext, dependencies: McpDependencies): Promise<Response> {
  const requestSafety = strictRequestAllowed(request, env);
  if (requestSafety.rejection) return requestSafety.rejection;
  const actor = await dependencies.authenticate(request, env);
  const expiresAt = actor ? await tokenExpiry(env, actor) : null;
  if (!actor || actor.kind !== "token" || expiresAt === null) {
    return Response.json({ error: "mcp_token_required" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  if (await isBatch(request)) return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "JSON-RPC batches are not supported" }, id: null }, { status: 400 });
  const handler = createMcpHandler(
    () => buildServer(actor, request, env, dependencies.dispatchControl),
    { route: "/mcp", corsOptions: false, allowedHostnames: requestSafety.hostnames, allowedOriginHostnames: requestSafety.origins, legacy: "stateless" },
  );
  return handler.fetch(request, { authInfo: { token: actor.tokenId, clientId: actor.tokenId, scopes: actor.scopes, expiresAt } });
}
