import { auditStatement } from "./audit";
import { timingSafeEqual } from "./auth";
import { isPagecastId } from "./identifiers";
import { findIdempotencyReceipt, idempotencyReceiptStatement, resolveIdempotencyReceipt } from "./idempotency";
import type { Env } from "./types";

export type CollaborationRole = "viewer" | "commenter" | "editor" | "approver" | "owner";
export type CollaborationAction = "publication:view" | "publication:comment" | "publication:review";

export type CollaborationMutation =
  | { kind: "collaboration"; operation: "set-organization"; data: { namespace: unknown; displayName: unknown } }
  | { kind: "collaboration"; operation: "create-actor"; data: { actorId: string; displayName: unknown; email?: unknown; externalSubject?: unknown } }
  | { kind: "collaboration"; operation: "update-actor"; data: { actorId: string; displayName?: unknown; email?: unknown; externalSubject?: unknown } }
  | { kind: "collaboration"; operation: "remove-actor"; data: { actorId: string } }
  | { kind: "collaboration"; operation: "invite-member"; data: { membershipId: string; actorId: string; role: unknown; inviteDigest: string } }
  | { kind: "collaboration"; operation: "accept-member"; data: { membershipId: string; actorId: string; inviteDigest: string } }
  | { kind: "collaboration"; operation: "remove-member"; data: { membershipId: string } }
  | { kind: "collaboration"; operation: "create-grant"; data: { grantId: string; publicationId: string; versionId: string | null; actions: unknown; credentialDigest: string; expiresAt: unknown } }
  | { kind: "collaboration"; operation: "revoke-grant"; data: { grantId: string } }
  | { kind: "collaboration"; operation: "create-comment"; data: { commentId: string; publicationId: string; versionId: string | null; body: unknown } }
  | { kind: "collaboration"; operation: "update-comment"; data: { commentId: string; body: unknown } }
  | { kind: "collaboration"; operation: "resolve-comment"; data: { commentId: string; resolved: boolean } }
  | { kind: "collaboration"; operation: "delete-comment"; data: { commentId: string } }
  | { kind: "collaboration"; operation: "review-decision"; data: { decisionId: string; publicationId: string; versionId: string; decision: unknown } };

export interface CollaborationMutationPacket {
  actorId: string | null;
  isBootstrap: boolean;
  fingerprint: string;
  idempotencyKey: string;
  mutation: CollaborationMutation;
}

type CollaborationPacket<Operation extends CollaborationMutation["operation"]> = Omit<CollaborationMutationPacket, "mutation"> & {
  mutation: Extract<CollaborationMutation, { operation: Operation }>;
};

interface Membership { actor_id: string; role: CollaborationRole; accepted_at: string | null; removed_at: string | null; }

const roles: CollaborationRole[] = ["viewer", "commenter", "editor", "approver", "owner"];
const actions: CollaborationAction[] = ["publication:view", "publication:comment", "publication:review"];

export function isCollaborationMutation(value: { kind: string }): value is CollaborationMutation {
  return value.kind === "collaboration";
}

export function validRole(value: unknown): value is CollaborationRole {
  return typeof value === "string" && roles.includes(value as CollaborationRole);
}

export function validActions(value: unknown): value is CollaborationAction[] {
  return Array.isArray(value) && value.length > 0 && value.length <= actions.length && value.every((action) => typeof action === "string" && actions.includes(action as CollaborationAction)) && new Set(value).size === value.length;
}

export function roleAllows(role: CollaborationRole, action: CollaborationAction): boolean {
  return role === "owner" || action === "publication:view" ||
    (action === "publication:comment" && ["commenter", "editor", "approver"].includes(role)) ||
    (action === "publication:review" && role === "approver");
}

export async function activeMembership(db: D1Database, ownerId: string, actorId: string): Promise<Membership | null> {
  return db.prepare("SELECT actor_id, role, accepted_at, removed_at FROM collaboration_memberships WHERE owner_id = ? AND actor_id = ? AND accepted_at IS NOT NULL AND removed_at IS NULL")
    .bind(ownerId, actorId).first<Membership>();
}

interface CollaborationCursor { createdAt: string; id: string; }

export async function listCollaboration(env: Env, ownerId: string, table: "actors" | "memberships" | "comments" | "reviews", url: URL, publicationId?: string): Promise<Response> {
  const cursor = collaborationCursor(url);
  if (cursor === "invalid") return Response.json({ error: "invalid_cursor" }, { status: 400 });
  const page = cursor ?? { createdAt: "9999-12-31T23:59:59.999Z", id: "~" };
  if (table === "actors") {
    const result = await env.DB.prepare("SELECT id, display_name, email, external_subject, created_at, updated_at FROM collaboration_actors WHERE owner_id = ? AND deleted_at IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 50").bind(ownerId, page.createdAt, page.createdAt, page.id).all<Record<string, unknown>>();
    return Response.json({ actors: result.results.map((row) => ({ id: row.id, displayName: row.display_name, email: row.email, externalSubject: row.external_subject, createdAt: row.created_at, updatedAt: row.updated_at })), nextCursor: nextCollaborationCursor(result.results, "created_at") });
  }
  if (table === "memberships") {
    const result = await env.DB.prepare("SELECT id, actor_id, role, invited_at, accepted_at, removed_at FROM collaboration_memberships WHERE owner_id = ? AND (invited_at < ? OR (invited_at = ? AND id < ?)) ORDER BY invited_at DESC, id DESC LIMIT 50").bind(ownerId, page.createdAt, page.createdAt, page.id).all<Record<string, unknown>>();
    return Response.json({ memberships: result.results.map((row) => ({ id: row.id, actorId: row.actor_id, role: row.role, invitedAt: row.invited_at, acceptedAt: row.accepted_at, removedAt: row.removed_at })), nextCursor: nextCollaborationCursor(result.results.map((row) => ({ ...row, created_at: row.invited_at })), "created_at") });
  }
  if (table === "comments") {
    const result = await env.DB.prepare("SELECT id, publication_id, version_id, author_actor_id, body, resolved_at, resolved_by_actor_id, created_at, updated_at FROM collaboration_comments WHERE owner_id = ? AND publication_id = ? AND deleted_at IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 50").bind(ownerId, publicationId, page.createdAt, page.createdAt, page.id).all<Record<string, unknown>>();
    return Response.json({ comments: result.results.map((row) => ({ id: row.id, publicationId: row.publication_id, versionId: row.version_id, authorActorId: row.author_actor_id, body: row.body, resolvedAt: row.resolved_at, resolvedByActorId: row.resolved_by_actor_id, createdAt: row.created_at, updatedAt: row.updated_at })), nextCursor: nextCollaborationCursor(result.results, "created_at") });
  }
  const result = await env.DB.prepare("SELECT id, publication_id, version_id, actor_id, decision, created_at FROM collaboration_review_decisions WHERE owner_id = ? AND publication_id = ? AND superseded_at IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 50").bind(ownerId, publicationId, page.createdAt, page.createdAt, page.id).all<Record<string, unknown>>();
  return Response.json({ reviews: result.results.map((row) => ({ id: row.id, publicationId: row.publication_id, versionId: row.version_id, actorId: row.actor_id, decision: row.decision, createdAt: row.created_at })), nextCursor: nextCollaborationCursor(result.results, "created_at") });
}

function collaborationCursor(url: URL): CollaborationCursor | null | "invalid" {
  const value = url.searchParams.get("cursor");
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4))) as CollaborationCursor;
    return typeof parsed.createdAt === "string" && parsed.createdAt.length <= 64 && isPagecastId(parsed.id) ? parsed : "invalid";
  } catch { return "invalid"; }
}

function nextCollaborationCursor(rows: Record<string, unknown>[], createdKey: string): string | null {
  const last = rows.at(-1);
  return last && rows.length === 50 ? btoa(JSON.stringify({ createdAt: last[createdKey], id: last.id })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") : null;
}

export async function executeCollaborationMutation(db: D1Database, ownerId: string, packet: CollaborationMutationPacket): Promise<Response> {
  const existing = await findIdempotencyReceipt(db, ownerId, packet.idempotencyKey);
  if (existing) return Response.json(resolveIdempotencyReceipt(existing, packet.fingerprint));
  if (!await canMutateCollaboration(db, ownerId, packet)) return terminal(db, ownerId, packet, 403, { error: "collaboration_membership_required" });
  const envelope = { actorId: packet.actorId, isBootstrap: packet.isBootstrap, fingerprint: packet.fingerprint, idempotencyKey: packet.idempotencyKey };
  switch (packet.mutation.operation) {
    case "set-organization": return setOrganization(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "create-actor": return createActor(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "update-actor": return updateActor(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "remove-actor": return removeActor(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "invite-member": return inviteMember(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "accept-member": return acceptMember(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "remove-member": return removeMember(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "create-grant": return createGrant(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "revoke-grant": return revokeGrant(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "create-comment": return createComment(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "update-comment": return updateComment(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "resolve-comment": return resolveComment(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "delete-comment": return deleteComment(db, ownerId, { ...envelope, mutation: packet.mutation });
    case "review-decision": return reviewDecision(db, ownerId, { ...envelope, mutation: packet.mutation });
  }
}

async function canMutateCollaboration(db: D1Database, ownerId: string, packet: CollaborationMutationPacket): Promise<boolean> {
  const operation = packet.mutation.operation;
  if (operation === "accept-member") return packet.actorId !== null && packet.actorId === packet.mutation.data.actorId;
  if (packet.isBootstrap) return isAdminOperation(operation);
  if (packet.actorId === null) return false;
  const membership = await activeMembership(db, ownerId, packet.actorId);
  if (!membership) return false;
  if (isAdminOperation(operation)) return membership.role === "owner";
  if (operation === "review-decision") return roleAllows(membership.role, "publication:review");
  return roleAllows(membership.role, "publication:comment");
}

function isAdminOperation(operation: CollaborationMutation["operation"]): boolean {
  return ["set-organization", "create-actor", "update-actor", "remove-actor", "invite-member", "remove-member", "create-grant", "revoke-grant"].includes(operation);
}

async function setOrganization(db: D1Database, ownerId: string, packet: CollaborationPacket<"set-organization">) {
  const { namespace, displayName } = packet.mutation.data;
  if (typeof namespace !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace) || typeof displayName !== "string" || displayName.trim().length < 1 || displayName.length > 100) return terminal(db, ownerId, packet, 400, { error: "invalid_organization" });
  return mutate(db, ownerId, packet, 200, { namespace, displayName: displayName.trim() }, [
    db.prepare("INSERT OR IGNORE INTO owners (id) VALUES (?)").bind(ownerId),
    db.prepare("INSERT INTO organizations (owner_id, namespace, display_name) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET namespace = excluded.namespace, display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP").bind(ownerId, namespace, displayName.trim()),
    auditStatement(db, { ownerId, actorId: packet.actorId, action: "organization.updated", resourceType: "organization", resourceId: ownerId, metadata: { namespace } }),
  ]);
}

async function createActor(db: D1Database, ownerId: string, packet: CollaborationPacket<"create-actor">) {
  const { actorId, displayName, email, externalSubject } = packet.mutation.data;
  if (!isPagecastId(actorId) || !validActor(displayName, email, externalSubject)) return terminal(db, ownerId, packet, 400, { error: "invalid_actor" });
  return mutate(db, ownerId, packet, 201, { id: actorId, displayName: String(displayName).trim(), email: email ?? null, externalSubject: externalSubject ?? null }, [
    db.prepare("INSERT OR IGNORE INTO owners (id) VALUES (?)").bind(ownerId),
    db.prepare("INSERT INTO collaboration_actors (id, owner_id, display_name, email, external_subject) VALUES (?, ?, ?, ?, ?)").bind(actorId, ownerId, String(displayName).trim(), email ?? null, externalSubject ?? null),
    auditStatement(db, { ownerId, actorId: packet.actorId, action: "actor.created", resourceType: "actor", resourceId: actorId }),
  ]);
}

async function updateActor(db: D1Database, ownerId: string, packet: CollaborationPacket<"update-actor">) {
  const { actorId, displayName, email, externalSubject } = packet.mutation.data;
  if (!isPagecastId(actorId) || !validActorUpdate(displayName, email, externalSubject)) return terminal(db, ownerId, packet, 400, { error: "invalid_actor" });
  if (!await db.prepare("SELECT id FROM collaboration_actors WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(actorId, ownerId).first()) return terminal(db, ownerId, packet, 404, { error: "actor_not_found" });
  return mutate(db, ownerId, packet, 200, { id: actorId, updated: true }, [db.prepare("UPDATE collaboration_actors SET display_name = COALESCE(?, display_name), email = COALESCE(?, email), external_subject = COALESCE(?, external_subject), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(displayName === undefined ? null : String(displayName).trim(), email ?? null, externalSubject ?? null, actorId, ownerId), auditStatement(db, { ownerId, actorId: packet.actorId, action: "actor.updated", resourceType: "actor", resourceId: actorId })]);
}

async function removeActor(db: D1Database, ownerId: string, packet: CollaborationPacket<"remove-actor">) {
  const { actorId } = packet.mutation.data;
  if (!isPagecastId(actorId)) return terminal(db, ownerId, packet, 400, { error: "invalid_actor" });
  if (!await db.prepare("SELECT id FROM collaboration_actors WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(actorId, ownerId).first()) return terminal(db, ownerId, packet, 404, { error: "actor_not_found" });
  return mutate(db, ownerId, packet, 200, { id: actorId, removed: true }, [
    db.prepare("UPDATE collaboration_actors SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(actorId, ownerId),
    db.prepare("UPDATE collaboration_memberships SET removed_at = CURRENT_TIMESTAMP WHERE owner_id = ? AND actor_id = ? AND removed_at IS NULL").bind(ownerId, actorId),
    db.prepare("UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE owner_id = ? AND actor_id = ? AND revoked_at IS NULL").bind(ownerId, actorId),
    auditStatement(db, { ownerId, actorId: packet.actorId, action: "actor.removed", resourceType: "actor", resourceId: actorId }),
  ]);
}

async function inviteMember(db: D1Database, ownerId: string, packet: CollaborationPacket<"invite-member">) {
  const { membershipId, actorId, role, inviteDigest } = packet.mutation.data;
  if (!isPagecastId(membershipId) || !isPagecastId(actorId) || !validRole(role) || !digest(inviteDigest)) return terminal(db, ownerId, packet, 400, { error: "invalid_membership" });
  const actor = await db.prepare("SELECT id FROM collaboration_actors WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(actorId, ownerId).first();
  if (!actor) return terminal(db, ownerId, packet, 404, { error: "actor_not_found" });
  return mutate(db, ownerId, packet, 201, { id: membershipId, actorId, role, invited: true }, [db.prepare("INSERT INTO collaboration_memberships (id, owner_id, actor_id, role, invite_digest) VALUES (?, ?, ?, ?, ?)").bind(membershipId, ownerId, actorId, role, inviteDigest), auditStatement(db, { ownerId, actorId: packet.actorId, action: "membership.invited", resourceType: "membership", resourceId: membershipId, metadata: { role } })]);
}

async function acceptMember(db: D1Database, ownerId: string, packet: CollaborationPacket<"accept-member">) {
  const { membershipId, actorId, inviteDigest } = packet.mutation.data;
  if (!isPagecastId(membershipId) || !isPagecastId(actorId) || !digest(inviteDigest)) return terminal(db, ownerId, packet, 400, { error: "invalid_membership" });
  const membership = await db.prepare("SELECT invite_digest FROM collaboration_memberships WHERE id = ? AND owner_id = ? AND actor_id = ? AND accepted_at IS NULL AND removed_at IS NULL").bind(membershipId, ownerId, actorId).first<{ invite_digest: string | null }>();
  if (!membership || !membership.invite_digest || !timingSafeEqual(membership.invite_digest, inviteDigest)) return terminal(db, ownerId, packet, 403, { error: "invalid_invitation" });
  return mutate(db, ownerId, packet, 200, { id: membershipId, accepted: true }, [
    db.prepare("UPDATE collaboration_memberships SET accepted_at = CURRENT_TIMESTAMP, invite_digest = NULL WHERE id = ? AND owner_id = ? AND actor_id = ? AND invite_digest = ? AND accepted_at IS NULL AND removed_at IS NULL").bind(membershipId, ownerId, actorId, inviteDigest),
    auditStatement(db, { ownerId, actorId, action: "membership.accepted", resourceType: "membership", resourceId: membershipId }),
  ]);
}

async function removeMember(db: D1Database, ownerId: string, packet: CollaborationPacket<"remove-member">) {
  const { membershipId } = packet.mutation.data;
  if (!isPagecastId(membershipId)) return terminal(db, ownerId, packet, 400, { error: "invalid_membership" });
  if (!await db.prepare("SELECT id FROM collaboration_memberships WHERE id = ? AND owner_id = ? AND removed_at IS NULL").bind(membershipId, ownerId).first()) return terminal(db, ownerId, packet, 404, { error: "membership_not_found" });
  return mutate(db, ownerId, packet, 200, { id: membershipId, removed: true }, [
    db.prepare("UPDATE collaboration_memberships SET removed_at = CURRENT_TIMESTAMP, invite_digest = NULL WHERE id = ? AND owner_id = ? AND removed_at IS NULL").bind(membershipId, ownerId),
    auditStatement(db, { ownerId, actorId: packet.actorId, action: "membership.removed", resourceType: "membership", resourceId: membershipId }),
  ]);
}

async function createGrant(db: D1Database, ownerId: string, packet: CollaborationPacket<"create-grant">) {
  const { grantId, publicationId, versionId, actions: grantActions, credentialDigest, expiresAt } = packet.mutation.data;
  if (!isPagecastId(grantId) || !isPagecastId(publicationId) || (versionId !== null && !isPagecastId(versionId)) || !validActions(grantActions) || !digest(credentialDigest) || !validExpiry(expiresAt)) return terminal(db, ownerId, packet, 400, { error: "invalid_collaboration_grant" });
  if (!await publicationVersionExists(db, ownerId, publicationId, versionId)) return terminal(db, ownerId, packet, 404, { error: "publication_or_version_not_found" });
  return mutate(db, ownerId, packet, 201, { id: grantId, publicationId, versionId, actions: grantActions, expiresAt }, [db.prepare("INSERT INTO collaboration_grants (id, owner_id, publication_id, version_id, actions_json, credential_digest, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(grantId, ownerId, publicationId, versionId, JSON.stringify(grantActions), credentialDigest, expiresAt), auditStatement(db, { ownerId, actorId: packet.actorId, action: "collaboration_grant.created", resourceType: "collaboration_grant", resourceId: grantId, metadata: { publicationId, versionId, actions: grantActions, expiresAt } })]);
}

async function revokeGrant(db: D1Database, ownerId: string, packet: CollaborationPacket<"revoke-grant">) {
  const { grantId } = packet.mutation.data;
  if (!isPagecastId(grantId)) return terminal(db, ownerId, packet, 400, { error: "invalid_collaboration_grant" });
  if (!await db.prepare("SELECT id FROM collaboration_grants WHERE id = ? AND owner_id = ? AND revoked_at IS NULL").bind(grantId, ownerId).first()) return terminal(db, ownerId, packet, 404, { error: "collaboration_grant_not_found" });
  return mutate(db, ownerId, packet, 200, { id: grantId, revoked: true }, [db.prepare("UPDATE collaboration_grants SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND revoked_at IS NULL").bind(grantId, ownerId), auditStatement(db, { ownerId, actorId: packet.actorId, action: "collaboration_grant.revoked", resourceType: "collaboration_grant", resourceId: grantId })]);
}

async function createComment(db: D1Database, ownerId: string, packet: CollaborationPacket<"create-comment">) {
  const { commentId, publicationId, versionId, body } = packet.mutation.data;
  if (!packet.actorId || !isPagecastId(commentId) || !isPagecastId(publicationId) || (versionId !== null && !isPagecastId(versionId)) || !validComment(body)) return terminal(db, ownerId, packet, 400, { error: "invalid_comment" });
  if (!await publicationVersionExists(db, ownerId, publicationId, versionId)) return terminal(db, ownerId, packet, 404, { error: "publication_or_version_not_found" });
  return mutate(db, ownerId, packet, 201, { id: commentId, publicationId, versionId, body: body.trim() }, [db.prepare("INSERT INTO collaboration_comments (id, owner_id, publication_id, version_id, author_actor_id, body) VALUES (?, ?, ?, ?, ?, ?)").bind(commentId, ownerId, publicationId, versionId, packet.actorId, body.trim()), auditStatement(db, { ownerId, actorId: packet.actorId, action: "comment.created", resourceType: "comment", resourceId: commentId, metadata: { publicationId, versionId } })]);
}

async function updateComment(db: D1Database, ownerId: string, packet: CollaborationPacket<"update-comment">) {
  const { commentId, body } = packet.mutation.data;
  if (!packet.actorId || !isPagecastId(commentId) || !validComment(body)) return terminal(db, ownerId, packet, 400, { error: "invalid_comment" });
  const comment = await db.prepare("SELECT author_actor_id FROM collaboration_comments WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(commentId, ownerId).first<{ author_actor_id: string }>();
  if (!comment || !await canModerate(db, ownerId, packet.actorId, comment.author_actor_id)) return terminal(db, ownerId, packet, 404, { error: "comment_not_found" });
  return mutate(db, ownerId, packet, 200, { id: commentId, updated: true }, [db.prepare("UPDATE collaboration_comments SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(body.trim(), commentId, ownerId), auditStatement(db, { ownerId, actorId: packet.actorId, action: "comment.updated", resourceType: "comment", resourceId: commentId })]);
}

async function resolveComment(db: D1Database, ownerId: string, packet: CollaborationPacket<"resolve-comment">) {
  const { commentId, resolved } = packet.mutation.data;
  if (!packet.actorId || !isPagecastId(commentId) || typeof resolved !== "boolean") return terminal(db, ownerId, packet, 400, { error: "invalid_comment" });
  const comment = await db.prepare("SELECT author_actor_id FROM collaboration_comments WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(commentId, ownerId).first<{ author_actor_id: string }>();
  if (!comment || !await canModerate(db, ownerId, packet.actorId, comment.author_actor_id)) return terminal(db, ownerId, packet, 404, { error: "comment_not_found" });
  return mutate(db, ownerId, packet, 200, { id: commentId, resolved }, [db.prepare("UPDATE collaboration_comments SET resolved_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, resolved_by_actor_id = CASE WHEN ? THEN ? ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(resolved ? 1 : 0, resolved ? 1 : 0, packet.actorId, commentId, ownerId), auditStatement(db, { ownerId, actorId: packet.actorId, action: resolved ? "comment.resolved" : "comment.reopened", resourceType: "comment", resourceId: commentId })]);
}

async function deleteComment(db: D1Database, ownerId: string, packet: CollaborationPacket<"delete-comment">) {
  const { commentId } = packet.mutation.data;
  if (!packet.actorId || !isPagecastId(commentId)) return terminal(db, ownerId, packet, 400, { error: "invalid_comment" });
  const comment = await db.prepare("SELECT author_actor_id FROM collaboration_comments WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(commentId, ownerId).first<{ author_actor_id: string }>();
  if (!comment || !await canModerate(db, ownerId, packet.actorId, comment.author_actor_id)) return terminal(db, ownerId, packet, 404, { error: "comment_not_found" });
  return mutate(db, ownerId, packet, 200, { id: commentId, deleted: true }, [db.prepare("UPDATE collaboration_comments SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(commentId, ownerId), auditStatement(db, { ownerId, actorId: packet.actorId, action: "comment.deleted", resourceType: "comment", resourceId: commentId })]);
}

async function reviewDecision(db: D1Database, ownerId: string, packet: CollaborationPacket<"review-decision">) {
  const { decisionId, publicationId, versionId, decision } = packet.mutation.data;
  if (!packet.actorId || !isPagecastId(decisionId) || !isPagecastId(publicationId) || !isPagecastId(versionId) || !["approved", "rejected", "changes_requested"].includes(String(decision))) return terminal(db, ownerId, packet, 400, { error: "invalid_review_decision" });
  const target = await db.prepare("SELECT p.id FROM publications p JOIN publication_versions v ON v.publication_id = p.id AND v.owner_id = p.owner_id WHERE p.id = ? AND p.owner_id = ? AND p.deleted_at IS NULL AND v.id = ? AND v.is_complete = 1 AND v.deleted_at IS NULL")
    .bind(publicationId, ownerId, versionId).first<{ id: string }>();
  if (!target) return terminal(db, ownerId, packet, 404, { error: "publication_or_version_not_found" });
  const membership = await activeMembership(db, ownerId, packet.actorId);
  if (!membership || !roleAllows(membership.role, "publication:review")) return terminal(db, ownerId, packet, 403, { error: "review_role_required" });
  return mutate(db, ownerId, packet, 201, { id: decisionId, publicationId, versionId, decision }, [
    db.prepare("INSERT INTO collaboration_review_decisions (id, owner_id, publication_id, version_id, actor_id, decision) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, version_id, actor_id) DO UPDATE SET id = excluded.id, publication_id = excluded.publication_id, decision = excluded.decision, created_at = CURRENT_TIMESTAMP, superseded_at = NULL").bind(decisionId, ownerId, publicationId, versionId, packet.actorId, decision),
    db.prepare("INSERT INTO publication_review_policies (owner_id, publication_id, requires_approval) VALUES (?, ?, 1) ON CONFLICT(owner_id, publication_id) DO UPDATE SET requires_approval = 1, updated_at = CURRENT_TIMESTAMP").bind(ownerId, publicationId),
    auditStatement(db, { ownerId, actorId: packet.actorId, action: "review.decided", resourceType: "review_decision", resourceId: decisionId, metadata: { publicationId, versionId, decision } }),
  ]);
}

async function mutate(db: D1Database, ownerId: string, packet: CollaborationMutationPacket, status: number, body: Record<string, unknown>, statements: D1PreparedStatement[]) {
  try {
    await db.batch([...statements, idempotencyReceiptStatement(db, ownerId, packet, status, body)]);
    return Response.json({ status, body });
  } catch { return Response.json({ status: 502, body: { error: "mutation_failed" } }); }
}

async function terminal(db: D1Database, ownerId: string, packet: CollaborationMutationPacket, status: number, body: Record<string, unknown>) {
  return mutate(db, ownerId, packet, status, body, [db.prepare("INSERT OR IGNORE INTO owners (id) VALUES (?)").bind(ownerId)]);
}

function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validActor(displayName: unknown, email: unknown, externalSubject: unknown) { return typeof displayName === "string" && displayName.trim().length > 0 && displayName.length <= 100 && validOptionalEmail(email) && validOptionalSubject(externalSubject); }
function validActorUpdate(displayName: unknown, email: unknown, externalSubject: unknown) { return (displayName === undefined || (typeof displayName === "string" && displayName.trim().length > 0 && displayName.length <= 100)) && validOptionalEmail(email) && validOptionalSubject(externalSubject); }
function validOptionalEmail(value: unknown) { return value === undefined || value === null || (typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254); }
function validOptionalSubject(value: unknown) { return value === undefined || value === null || (typeof value === "string" && value.length >= 1 && value.length <= 255); }
function validComment(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 10_000; }
function validExpiry(value: unknown) { return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()); }
async function canModerate(db: D1Database, ownerId: string, actorId: string, authorId: string) { const membership = await activeMembership(db, ownerId, actorId); return Boolean(membership && (actorId === authorId || membership.role === "owner" || membership.role === "editor" || membership.role === "approver")); }
async function publicationVersionExists(db: D1Database, ownerId: string, publicationId: string, versionId: string | null) {
  const publication = await db.prepare("SELECT id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first();
  if (!publication) return false;
  if (!versionId) return true;
  return Boolean(await db.prepare("SELECT id FROM publication_versions WHERE id = ? AND owner_id = ? AND publication_id = ? AND is_complete = 1 AND deleted_at IS NULL").bind(versionId, ownerId, publicationId).first());
}
