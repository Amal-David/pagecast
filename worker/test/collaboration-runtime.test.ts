import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const ownerId = "owner-collaboration";

async function installSchema() {
  await env.DB.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS collaboration_review_decisions;
    DROP TABLE IF EXISTS publication_review_policies;
    DROP TABLE IF EXISTS collaboration_comments;
    DROP TABLE IF EXISTS collaboration_grants;
    DROP TABLE IF EXISTS collaboration_memberships;
    DROP TABLE IF EXISTS collaboration_actors;
    DROP TABLE IF EXISTS organizations;
    DROP TABLE IF EXISTS access_policies;
    DROP TABLE IF EXISTS publication_versions;
    DROP TABLE IF EXISTS publications;
    DROP TABLE IF EXISTS api_tokens;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;
    CREATE TABLE owners (id TEXT PRIMARY KEY);
    CREATE TABLE publications (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, link_kind TEXT NOT NULL DEFAULT 'unlisted', deleted_at TEXT);
    CREATE TABLE publication_versions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, is_complete INTEGER NOT NULL, deleted_at TEXT);
    CREATE TABLE access_policies (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, password_iterations INTEGER NOT NULL, auth_version INTEGER NOT NULL, approval_state TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL, label TEXT NOT NULL, scopes_json TEXT NOT NULL, revoked_at TEXT, actor_id TEXT);
    CREATE TABLE idempotency_keys (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_status INTEGER, response_body TEXT, expires_at TEXT NOT NULL, UNIQUE(owner_id, idempotency_key));
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE TABLE organizations (owner_id TEXT PRIMARY KEY, namespace TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE collaboration_actors (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, display_name TEXT NOT NULL, email TEXT, external_subject TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, UNIQUE(owner_id, email), UNIQUE(owner_id, external_subject));
    CREATE TABLE collaboration_memberships (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT NOT NULL, role TEXT NOT NULL, invited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, accepted_at TEXT, removed_at TEXT, invite_digest TEXT, UNIQUE(owner_id, actor_id));
    CREATE TABLE collaboration_grants (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT, actions_json TEXT NOT NULL, credential_digest TEXT NOT NULL UNIQUE, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE collaboration_comments (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT, author_actor_id TEXT NOT NULL, body TEXT NOT NULL, resolved_at TEXT, resolved_by_actor_id TEXT, deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE collaboration_review_decisions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT NOT NULL, actor_id TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, superseded_at TEXT, UNIQUE(owner_id, version_id, actor_id));
    CREATE TABLE publication_review_policies (owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(owner_id, publication_id));
  `);
}

function call(key: string, mutation: Record<string, unknown>, actorId: string | null = "actor-owner", isBootstrap = actorId === null) {
  const stub = env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName(ownerId));
  return stub.fetch("https://pagecast.test/control", {
    method: "POST",
    headers: { "X-Pagecast-Owner": ownerId, "content-type": "application/json" },
    body: JSON.stringify({ actorId, isBootstrap, fingerprint: `fingerprint:${key}`, idempotencyKey: key, mutation }),
  });
}

async function activeActor(actorId: string, role: "commenter" | "approver" | "owner") {
  await call(`actor-${actorId}`, { kind: "collaboration", operation: "create-actor", data: { actorId, displayName: actorId } }, null);
  await call(`invite-${actorId}`, { kind: "collaboration", operation: "invite-member", data: { membershipId: `membership-${actorId}`, actorId, role, inviteDigest: "a".repeat(64) } }, null);
  await call(`accept-${actorId}`, { kind: "collaboration", operation: "accept-member", data: { membershipId: `membership-${actorId}`, actorId, inviteDigest: "a".repeat(64) } }, actorId);
}

async function createPublication() {
  await env.DB.prepare("INSERT INTO publications (id, owner_id, link_kind) VALUES (?, ?, 'public')").bind("publication-1", ownerId).run();
  await env.DB.prepare("INSERT INTO publication_versions (id, owner_id, publication_id, is_complete) VALUES (?, ?, ?, 1)").bind("version-1", ownerId, "publication-1").run();
}

beforeEach(installSchema);

describe("owner collaboration mutations", () => {
  it("does not treat an unbound ordinary token as bootstrap administration", async () => {
    const denied = await call("unbound-admin", { kind: "collaboration", operation: "create-actor", data: { actorId: "actor-denied", displayName: "Denied" } }, null, false);

    await expect(denied.json()).resolves.toMatchObject({ status: 403, body: { error: "collaboration_membership_required" } });
    expect(await env.DB.prepare("SELECT response_status FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?").bind(ownerId, "unbound-admin").first()).toMatchObject({ response_status: 403 });
  });

  it("keeps actor and membership invitations owner-scoped and idempotent", async () => {
    const created = await call("actor", { kind: "collaboration", operation: "create-actor", data: { actorId: "actor-owner", displayName: "Owner", email: "owner@example.test" } }, null);
    expect(await created.json()).toMatchObject({ status: 201, body: { id: "actor-owner" } });
    const invite = await call("invite", { kind: "collaboration", operation: "invite-member", data: { membershipId: "member-1", actorId: "actor-owner", role: "approver", inviteDigest: "a".repeat(64) } }, null);
    expect(await invite.json()).toMatchObject({ status: 201, body: { id: "member-1", role: "approver" } });
    const replay = await call("invite", { kind: "collaboration", operation: "invite-member", data: { membershipId: "other", actorId: "actor-owner", role: "viewer", inviteDigest: "b".repeat(64) } }, null);
    expect(await replay.json()).toMatchObject({ status: 201, body: { id: "member-1", role: "approver" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM collaboration_memberships WHERE owner_id = ?").bind(ownerId).first()).toMatchObject({ count: 1 });
  });

  it("audits comments and keeps approval scoped to its reviewed version", async () => {
    await env.DB.prepare("INSERT INTO publications (id, owner_id, link_kind) VALUES (?, ?, 'public')").bind("publication-1", ownerId).run();
    await env.DB.prepare("INSERT INTO publication_versions (id, owner_id, publication_id, is_complete) VALUES (?, ?, ?, 1)").bind("version-1", ownerId, "publication-1").run();
    await env.DB.prepare("INSERT INTO publication_versions (id, owner_id, publication_id, is_complete) VALUES (?, ?, ?, 1)").bind("version-2", ownerId, "publication-1").run();
    await call("actor", { kind: "collaboration", operation: "create-actor", data: { actorId: "actor-owner", displayName: "Owner" } }, null);
    await call("member", { kind: "collaboration", operation: "invite-member", data: { membershipId: "member", actorId: "actor-owner", role: "approver", inviteDigest: "a".repeat(64) } }, null);
    await call("accept", { kind: "collaboration", operation: "accept-member", data: { membershipId: "member", actorId: "actor-owner", inviteDigest: "a".repeat(64) } });
    const comment = await call("comment", { kind: "collaboration", operation: "create-comment", data: { commentId: "comment-1", publicationId: "publication-1", versionId: "version-1", body: "Ready for review" } });
    expect(await comment.json()).toMatchObject({ status: 201, body: { id: "comment-1" } });
    const decision = await call("approve", { kind: "collaboration", operation: "review-decision", data: { decisionId: "decision-1", publicationId: "publication-1", versionId: "version-1", decision: "approved" } });
    expect(await decision.json()).toMatchObject({ status: 201, body: { decision: "approved" } });
    expect(await env.DB.prepare("SELECT requires_approval FROM publication_review_policies WHERE publication_id = 'publication-1'").first()).toMatchObject({ requires_approval: 1 });
    const revised = await call("request-changes", { kind: "collaboration", operation: "review-decision", data: { decisionId: "decision-2", publicationId: "publication-1", versionId: "version-2", decision: "changes_requested" } });
    expect(await revised.json()).toMatchObject({ status: 201, body: { decision: "changes_requested" } });
    expect(await env.DB.prepare("SELECT decision FROM collaboration_review_decisions WHERE owner_id = ? AND version_id = ?").bind(ownerId, "version-1").first()).toMatchObject({ decision: "approved" });
    expect(await env.DB.prepare("SELECT decision FROM collaboration_review_decisions WHERE owner_id = ? AND version_id = ?").bind(ownerId, "version-2").first()).toMatchObject({ decision: "changes_requested" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE owner_id = ?").bind(ownerId).first()).toMatchObject({ count: 6 });
  });

  it("rolls back member removal when its audit and receipt batch fails", async () => {
    await call("actor", { kind: "collaboration", operation: "create-actor", data: { actorId: "actor-owner", displayName: "Owner" } }, null);
    await call("member", { kind: "collaboration", operation: "invite-member", data: { membershipId: "member", actorId: "actor-owner", role: "owner", inviteDigest: "a".repeat(64) } }, null);
    await env.DB.exec("DROP TABLE audit_events; CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL CHECK(action = 'allowed'), resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, metadata_json TEXT NOT NULL)");

    const response = await call("remove-member", { kind: "collaboration", operation: "remove-member", data: { membershipId: "member" } }, null);
    const membership = await env.DB.prepare("SELECT removed_at FROM collaboration_memberships WHERE id = 'member'").first<{ removed_at: string | null }>();

    await expect(response.json()).resolves.toMatchObject({ status: 502 });
    expect(membership?.removed_at).toBeNull();
  });

  it("rolls back actor token revocation when actor-removal auditing fails", async () => {
    await call("actor", { kind: "collaboration", operation: "create-actor", data: { actorId: "actor-owner", displayName: "Owner" } }, null);
    await env.DB.prepare("INSERT INTO api_tokens (id, owner_id, token_hash, label, scopes_json, actor_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("actor-token", ownerId, "a".repeat(64), "Actor token", "[]", "actor-owner").run();
    await env.DB.exec("DROP TABLE audit_events; CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL CHECK(action = 'allowed'), resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, metadata_json TEXT NOT NULL)");

    const response = await call("remove-actor", { kind: "collaboration", operation: "remove-actor", data: { actorId: "actor-owner" } }, null);

    await expect(response.json()).resolves.toMatchObject({ status: 502 });
    expect(await env.DB.prepare("SELECT revoked_at FROM api_tokens WHERE id = 'actor-token'").first<{ revoked_at: string | null }>()).toMatchObject({ revoked_at: null });
    expect(await env.DB.prepare("SELECT deleted_at FROM collaboration_actors WHERE id = 'actor-owner'").first<{ deleted_at: string | null }>()).toMatchObject({ deleted_at: null });
  });

  it("records a denied comment after its actor has been removed first", async () => {
    await createPublication();
    await activeActor("actor-comment", "commenter");
    expect(await (await call("remove-comment-actor", { kind: "collaboration", operation: "remove-actor", data: { actorId: "actor-comment" } }, null)).json()).toMatchObject({ status: 200 });

    const denied = await call("comment-after-removal", { kind: "collaboration", operation: "create-comment", data: { commentId: "comment-after-removal", publicationId: "publication-1", versionId: "version-1", body: "Too late" } }, "actor-comment");

    await expect(denied.json()).resolves.toMatchObject({ status: 403, body: { error: "collaboration_membership_required" } });
    expect(await env.DB.prepare("SELECT response_status FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?").bind(ownerId, "comment-after-removal").first()).toMatchObject({ response_status: 403 });
    expect(await env.DB.prepare("SELECT id FROM collaboration_comments WHERE id = 'comment-after-removal'").first()).toBeNull();
  });

  it("records a denied admin mutation after the owner membership has been removed first", async () => {
    await activeActor("actor-admin", "owner");
    expect(await (await call("remove-owner-member", { kind: "collaboration", operation: "remove-member", data: { membershipId: "membership-actor-admin" } }, null)).json()).toMatchObject({ status: 200 });

    const denied = await call("admin-after-removal", { kind: "collaboration", operation: "create-actor", data: { actorId: "actor-denied", displayName: "Denied" } }, "actor-admin");

    await expect(denied.json()).resolves.toMatchObject({ status: 403, body: { error: "collaboration_membership_required" } });
    expect(await env.DB.prepare("SELECT response_status FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?").bind(ownerId, "admin-after-removal").first()).toMatchObject({ response_status: 403 });
  });

  it("does not let a removed commenter moderate their own comment or review", async () => {
    await createPublication();
    await activeActor("actor-self", "approver");
    expect(await (await call("create-self-comment", { kind: "collaboration", operation: "create-comment", data: { commentId: "comment-self", publicationId: "publication-1", versionId: "version-1", body: "Before removal" } }, "actor-self")).json()).toMatchObject({ status: 201 });
    expect(await (await call("remove-self-member", { kind: "collaboration", operation: "remove-member", data: { membershipId: "membership-actor-self" } }, null)).json()).toMatchObject({ status: 200 });

    for (const [key, mutation] of [
      ["update-self-after-removal", { kind: "collaboration", operation: "update-comment", data: { commentId: "comment-self", body: "Edited" } }],
      ["resolve-self-after-removal", { kind: "collaboration", operation: "resolve-comment", data: { commentId: "comment-self", resolved: true } }],
      ["delete-self-after-removal", { kind: "collaboration", operation: "delete-comment", data: { commentId: "comment-self" } }],
      ["review-after-removal", { kind: "collaboration", operation: "review-decision", data: { decisionId: "review-self", publicationId: "publication-1", versionId: "version-1", decision: "approved" } }],
    ] as const) {
      await expect((await call(key, mutation, "actor-self")).json()).resolves.toMatchObject({ status: 403, body: { error: "collaboration_membership_required" } });
      expect(await env.DB.prepare("SELECT response_status FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?").bind(ownerId, key).first()).toMatchObject({ response_status: 403 });
    }
  });
});
