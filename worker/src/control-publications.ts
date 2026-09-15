import type { ControlRouteContext } from "./control-context";

/** Upload, publication, access-policy, and public-link administration routes. */
export async function handlePublicationRoute(ctx: ControlRouteContext): Promise<Response | null> {
  const { request, env, url } = ctx;
  const uploadPath = /^\/v1\/owners\/([^/]+)\/upload-sessions(?:\/([^/]+)(?:\/files\/(.+)|\/(complete))?)?$/.exec(url.pathname);
  if (uploadPath) {
    const [, ownerId, sessionId, encodedPath, complete] = uploadPath;
    if (!ctx.owns(ownerId)) return ctx.error("forbidden", 403);
    if (request.method === "GET" && sessionId && !encodedPath && !complete) {
      if (!ctx.hasScope("publications:read")) return ctx.error("forbidden", 403);
      const session = await env.DB.prepare("SELECT id, publication_id, version_id, mode, status, expires_at, created_at FROM upload_sessions WHERE id = ? AND owner_id = ?").bind(sessionId, ownerId).first<Record<string, unknown>>();
      if (!session) return ctx.error("upload_session_not_found", 404);
      const progress = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN received_bytes = expected_bytes AND received_sha256 = expected_sha256 THEN 1 ELSE 0 END) AS uploaded FROM upload_session_files WHERE session_id = ?").bind(sessionId).first<{ total: number; uploaded: number | null }>();
      return Response.json({ id: session.id, publicationId: session.publication_id, versionId: session.version_id, mode: session.mode, status: session.status, expiresAt: session.expires_at, createdAt: session.created_at, files: { total: Number(progress?.total ?? 0), uploaded: Number(progress?.uploaded ?? 0) } });
    }
    if (!ctx.hasScope("publications:write")) return ctx.error("forbidden", 403);
    if (request.method === "POST" && !sessionId) return ctx.createUploadSession(ownerId);
    if (request.method === "PUT" && sessionId && encodedPath) return ctx.uploadSessionFile(ownerId, sessionId, encodedPath);
    if (request.method === "POST" && sessionId && complete) return ctx.completeUploadSession(ownerId, sessionId);
  }

  const accessPolicyPath = /^\/v1\/owners\/([^/]+)\/publications\/([^/]+)\/access-policy$/.exec(url.pathname);
  if (accessPolicyPath) {
    const [, ownerId, publicationId] = accessPolicyPath;
    if (!ctx.owns(ownerId)) return ctx.error("forbidden", 403);
    if (request.method === "GET") {
      if (!ctx.hasScope("publications:read")) return ctx.error("forbidden", 403);
      const policy = await env.DB.prepare("SELECT policy.mode, policy.approval_state, publication.expires_at, policy.auth_version FROM access_policies policy JOIN publications publication ON publication.id = policy.publication_id AND publication.owner_id = policy.owner_id WHERE policy.owner_id = ? AND policy.publication_id = ? AND publication.deleted_at IS NULL").bind(ownerId, publicationId).first<Record<string, unknown>>();
      return policy ? Response.json({ mode: policy.mode, approvalState: policy.approval_state, expiresAt: policy.expires_at, authVersion: policy.auth_version }) : ctx.error("access_policy_not_found", 404);
    }
    if (!ctx.hasScope("publications:write")) return ctx.error("forbidden", 403);
    if (request.method === "PUT") return ctx.updateAccessPolicy(ownerId, publicationId);
  }

  const grantsPath = /^\/v1\/owners\/([^/]+)\/publications\/([^/]+)\/grants(?:\/([A-Za-z0-9_-]{32,64}))?$/.exec(url.pathname);
  if (grantsPath) {
    const [, ownerId, publicationId, grantId] = grantsPath;
    if (!ctx.owns(ownerId)) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !grantId) {
      if (!ctx.hasScope("publications:read")) return ctx.error("forbidden", 403);
      const grants = await env.DB.prepare("SELECT id, permission, expires_at, revoked_at, created_at FROM access_grants WHERE owner_id = ? AND publication_id = ? ORDER BY created_at DESC LIMIT 100").bind(ownerId, publicationId).all<Record<string, unknown>>();
      return Response.json({ grants: grants.results.map((grant) => ({ id: grant.id, permission: grant.permission, expiresAt: grant.expires_at, revokedAt: grant.revoked_at, createdAt: grant.created_at })) });
    }
    if (!ctx.hasScope("publications:write")) return ctx.error("forbidden", 403);
    if (request.method === "POST" && !grantId) return ctx.createAccessGrant(ownerId, publicationId);
    if (request.method === "DELETE" && grantId) return ctx.revokeAccessGrant(ownerId, publicationId, grantId);
  }

  const publicationsPath = /^\/v1\/owners\/([^/]+)\/publications$/.exec(url.pathname);
  if (publicationsPath && request.method === "GET") {
    const ownerId = publicationsPath[1];
    if (!ctx.owns(ownerId) || !ctx.hasScope("publications:read")) return ctx.error("forbidden", 403);
    const rows = await env.DB.prepare("SELECT id, slug, title, state, active_version_id, link_kind, updated_at, created_at FROM publications WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100").bind(ownerId).all<Record<string, unknown>>();
    return Response.json({ publications: rows.results.map((row) => ({ id: row.id, slug: row.slug, title: row.title, state: row.state, activeVersionId: row.active_version_id, linkKind: row.link_kind, updatedAt: row.updated_at, createdAt: row.created_at })) });
  }

  const publicationPath = /^\/v1\/owners\/([^/]+)\/publications\/([^/]+)(?:\/versions(?:\/([^/]+)(?:\/(activate|rollback))?)?|\/(rename|revoke|restore))?$/.exec(url.pathname);
  if (publicationPath) {
    const [, ownerId, publicationId, versionId, versionAction, action] = publicationPath;
    if (!ctx.owns(ownerId)) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !versionId && !action) {
      if (!ctx.hasScope("publications:read")) return ctx.error("forbidden", 403);
      if (url.searchParams.get("include") === "publication") {
        const publication = await env.DB.prepare("SELECT id, slug, title, state, active_version_id, link_kind, created_at, updated_at FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first<Record<string, unknown>>();
        return publication ? Response.json({ id: publication.id, slug: publication.slug, title: publication.title, state: publication.state, activeVersionId: publication.active_version_id, linkKind: publication.link_kind, createdAt: publication.created_at, updatedAt: publication.updated_at }) : ctx.error("publication_not_found", 404);
      }
      return ctx.listVersions(ownerId, publicationId);
    }
    if (!ctx.hasScope("publications:write")) return ctx.error("forbidden", 403);
    if (request.method === "POST" && versionId && (versionAction === "activate" || versionAction === "rollback")) return ctx.publicationMutation(ownerId, { kind: "publication", operation: "activate", data: { publicationId, versionId } });
    if (request.method === "DELETE" && versionId) return ctx.publicationMutation(ownerId, { kind: "publication", operation: "delete-version", data: { publicationId, versionId } });
    if (request.method === "POST" && action === "rename") {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || typeof parsed.payload.slug !== "string") return ctx.error("invalid_slug", 400);
      return ctx.publicationMutation(ownerId, { kind: "publication", operation: "rename", data: { publicationId, slug: parsed.payload.slug } });
    }
    if (request.method === "POST" && action === "revoke") return ctx.publicationMutation(ownerId, { kind: "publication", operation: "revoke", data: { publicationId } });
    if (request.method === "POST" && action === "restore") return ctx.publicationMutation(ownerId, { kind: "publication", operation: "restore", data: { publicationId } });
  }

  return null;
}
