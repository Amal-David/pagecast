import { deriveTokenSecret, digestToken } from "./auth";
import { listCollaboration, type CollaborationAction } from "./collaboration";
import type { ControlRouteContext } from "./control-context";

/** Routes that govern organizations, memberships, reviews, comments, and presence. */
export async function handleCollaborationRoute(ctx: ControlRouteContext): Promise<Response | null> {
  const { request, env, url, actor, accessIdentity } = ctx;
  const organizationPath = /^\/v1\/owners\/([^/]+)\/organization$/.exec(url.pathname);
  if (organizationPath) {
    const ownerId = organizationPath[1];
    if (!ctx.owns(ownerId) || !(await ctx.collaborationAdmin(ownerId))) return ctx.error("forbidden", 403);
    if (request.method === "GET") {
      const organization = await env.DB.prepare("SELECT namespace, display_name, created_at, updated_at FROM organizations WHERE owner_id = ?").bind(ownerId).first<Record<string, unknown>>();
      return organization ? Response.json({ namespace: organization.namespace, displayName: organization.display_name, createdAt: organization.created_at, updatedAt: organization.updated_at }) : ctx.error("organization_not_found", 404);
    }
    if (request.method === "PUT") {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed) return ctx.error(parsed && "tooLarge" in parsed ? "payload_too_large" : "invalid_organization", parsed && "tooLarge" in parsed ? 413 : 400);
      return ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "set-organization", data: { namespace: parsed.payload.namespace, displayName: parsed.payload.displayName } });
    }
  }

  const actorsPath = /^\/v1\/owners\/([^/]+)\/actors(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(url.pathname);
  if (actorsPath) {
    const [, ownerId, targetActorId] = actorsPath;
    if (!ctx.owns(ownerId) || !(await ctx.collaborationAdmin(ownerId))) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !targetActorId) return listCollaboration(env, ownerId, "actors", url);
    if (request.method === "GET" && targetActorId) {
      const record = await env.DB.prepare("SELECT id, display_name, email, external_subject, created_at, updated_at FROM collaboration_actors WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(targetActorId, ownerId).first<Record<string, unknown>>();
      return record ? Response.json({ id: record.id, displayName: record.display_name, email: record.email, externalSubject: record.external_subject, createdAt: record.created_at, updatedAt: record.updated_at }) : ctx.error("actor_not_found", 404);
    }
    if (request.method === "POST" && !targetActorId) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || typeof parsed.payload.actorId !== "string") return ctx.error("invalid_actor", 400);
      return ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "create-actor", data: { actorId: parsed.payload.actorId, displayName: parsed.payload.displayName, email: parsed.payload.email, externalSubject: parsed.payload.externalSubject } });
    }
    if (targetActorId && request.method === "PATCH") {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed) return ctx.error("invalid_actor", 400);
      return ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "update-actor", data: { actorId: targetActorId, displayName: parsed.payload.displayName, email: parsed.payload.email, externalSubject: parsed.payload.externalSubject } });
    }
    if (targetActorId && request.method === "DELETE") return ctx.invokeCollaborationMutation(ownerId, "", { kind: "collaboration", operation: "remove-actor", data: { actorId: targetActorId } });
  }

  const membershipsPath = /^\/v1\/owners\/([^/]+)\/memberships(?:\/([A-Za-z0-9_-]{1,128})(?:\/(accept))?)?$/.exec(url.pathname);
  if (membershipsPath) {
    const [, ownerId, membershipId, accept] = membershipsPath;
    if (!ctx.owns(ownerId) || (request.method !== "POST" || !membershipId || !accept) && !(await ctx.collaborationAdmin(ownerId))) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !membershipId) return listCollaboration(env, ownerId, "memberships", url);
    if (request.method === "POST" && !membershipId) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || typeof parsed.payload.actorId !== "string" || typeof parsed.payload.role !== "string") return ctx.error("invalid_membership", 400);
      const inviteKey = request.headers.get("Idempotency-Key") ?? "";
      const invitationSecret = await deriveTokenSecret(env.TOKEN_HASH_KEY, `membership:${parsed.payload.actorId}`, inviteKey);
      const response = await ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "invite-member", data: { membershipId: crypto.randomUUID(), actorId: parsed.payload.actorId, role: parsed.payload.role, inviteDigest: await digestToken(env.TOKEN_HASH_KEY, `membership:${parsed.payload.actorId}`, invitationSecret) } });
      if (response.status !== 201) return response;
      const body = await response.json() as Record<string, unknown>;
      return Response.json({ ...body, invitation: `pcm2_${String(body.id)}.${invitationSecret}` }, { status: 201 });
    }
    if (request.method === "POST" && membershipId && accept) {
      if (actor.kind !== "token" || !actor.actorId) return ctx.error("forbidden", 403);
      const match = /^pcm2_([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{32,})$/.exec(request.headers.get("X-Pagecast-Invitation") ?? "");
      if (!match || match[1] !== membershipId) return ctx.error("invalid_invitation", 403);
      const inviteDigest = await digestToken(env.TOKEN_HASH_KEY, `membership:${actor.actorId}`, match[2]);
      return ctx.invokeCollaborationMutation(ownerId, "", { kind: "collaboration", operation: "accept-member", data: { membershipId, actorId: actor.actorId, inviteDigest } });
    }
    if (request.method === "DELETE" && membershipId) return ctx.invokeCollaborationMutation(ownerId, "", { kind: "collaboration", operation: "remove-member", data: { membershipId } });
  }

  const collaborationGrantPath = /^\/v1\/owners\/([^/]+)\/collaboration-grants(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(url.pathname);
  if (collaborationGrantPath) {
    const [, ownerId, grantId] = collaborationGrantPath;
    if (!ctx.owns(ownerId) || !(await ctx.collaborationAdmin(ownerId))) return ctx.error("forbidden", 403);
    if (request.method === "POST" && !grantId) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || typeof parsed.payload.publicationId !== "string") return ctx.error("invalid_collaboration_grant", 400);
      const key = request.headers.get("Idempotency-Key") ?? "";
      const id = (await deriveTokenSecret(env.TOKEN_HASH_KEY, `collaboration-grant:${ownerId}`, key)).slice(0, 64);
      const secret = await deriveTokenSecret(env.TOKEN_HASH_KEY, id, key);
      const response = await ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "create-grant", data: { grantId: id, publicationId: parsed.payload.publicationId, versionId: typeof parsed.payload.versionId === "string" ? parsed.payload.versionId : null, actions: parsed.payload.actions, credentialDigest: await digestToken(env.TOKEN_HASH_KEY, id, secret), expiresAt: parsed.payload.expiresAt ?? null } });
      if (response.status < 200 || response.status >= 300) return response;
      const body = await response.json() as Record<string, unknown>;
      return Response.json({ ...body, credential: `pcg2_${String(body.id)}.${secret}` }, { status: response.status });
    }
    if (request.method === "DELETE" && grantId) return ctx.invokeCollaborationMutation(ownerId, "", { kind: "collaboration", operation: "revoke-grant", data: { grantId } });
  }

  const grantedCommentsPath = /^\/v1\/owners\/([^/]+)\/publications\/([A-Za-z0-9_-]{1,128})\/granted-comments$/.exec(url.pathname);
  if (grantedCommentsPath && request.method === "GET") {
    const [, ownerId, publicationId] = grantedCommentsPath;
    const action: CollaborationAction = "publication:comment";
    if (!ctx.owns(ownerId) || !ctx.hasScope("collaboration:read") || !(await ctx.collaborationAllowed(ownerId, action)) || !(await ctx.collaborationGrantAllows(ownerId, publicationId, null, action, true))) return ctx.error("forbidden", 403);
    return listCollaboration(env, ownerId, "comments", url, publicationId);
  }

  const commentsPath = /^\/v1\/owners\/([^/]+)\/publications\/([A-Za-z0-9_-]{1,128})\/comments(?:\/([A-Za-z0-9_-]{1,128})(?:\/(resolve))?)?$/.exec(url.pathname);
  if (commentsPath) {
    const [, ownerId, publicationId, commentId, resolve] = commentsPath;
    const action: CollaborationAction = "publication:comment";
    if (!ctx.owns(ownerId) || !ctx.hasScope(request.method === "GET" ? "collaboration:read" : "collaboration:write") || !(await ctx.collaborationAllowed(ownerId, action))) return ctx.error("forbidden", 403);
    if (request.method === "GET" && !commentId) return listCollaboration(env, ownerId, "comments", url, publicationId);
    if (request.method === "POST" && !commentId) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed) return ctx.error("invalid_comment", 400);
      const versionId = typeof parsed.payload.versionId === "string" ? parsed.payload.versionId : null;
      if (!(await ctx.collaborationGrantAllows(ownerId, publicationId, versionId, action))) return ctx.error("forbidden", 403);
      return ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "create-comment", data: { commentId: crypto.randomUUID(), publicationId, versionId, body: parsed.payload.body } });
    }
    if (request.method === "PATCH" && commentId && !resolve) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed) return ctx.error("invalid_comment", 400);
      return ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "update-comment", data: { commentId, body: parsed.payload.body } });
    }
    if (request.method === "POST" && commentId && resolve) {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || typeof parsed.payload.resolved !== "boolean") return ctx.error("invalid_comment", 400);
      return ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "resolve-comment", data: { commentId, resolved: parsed.payload.resolved } });
    }
    if (request.method === "DELETE" && commentId) return ctx.invokeCollaborationMutation(ownerId, "", { kind: "collaboration", operation: "delete-comment", data: { commentId } });
  }

  const reviewsPath = /^\/v1\/owners\/([^/]+)\/publications\/([A-Za-z0-9_-]{1,128})\/reviews$/.exec(url.pathname);
  if (reviewsPath) {
    const [, ownerId, publicationId] = reviewsPath;
    const action: CollaborationAction = "publication:review";
    if (!ctx.owns(ownerId) || !ctx.hasScope(request.method === "GET" ? "collaboration:read" : "reviews:write") || !(await ctx.collaborationAllowed(ownerId, action))) return ctx.error("forbidden", 403);
    if (request.method === "GET") return listCollaboration(env, ownerId, "reviews", url, publicationId);
    if (request.method === "POST") {
      const parsed = await ctx.parseJson();
      if (!parsed || "tooLarge" in parsed || typeof parsed.payload.versionId !== "string") return ctx.error("invalid_review_decision", 400);
      if (!(await ctx.collaborationGrantAllows(ownerId, publicationId, parsed.payload.versionId, action))) return ctx.error("forbidden", 403);
      return ctx.invokeCollaborationMutation(ownerId, parsed.raw, { kind: "collaboration", operation: "review-decision", data: { decisionId: crypto.randomUUID(), publicationId, versionId: parsed.payload.versionId, decision: parsed.payload.decision } });
    }
  }

  const presencePath = /^\/v1\/owners\/([^/]+)\/publications\/([A-Za-z0-9_-]{1,128})\/presence$/.exec(url.pathname);
  if (presencePath && request.method === "GET") {
    const [, ownerId, publicationId] = presencePath;
    return ctx.owns(ownerId) ? ctx.handlePresence(ownerId, publicationId) : ctx.error("forbidden", 403);
  }

  return null;
}
