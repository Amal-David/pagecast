import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const ownerId = "owner-http-collaboration";
const bootstrap = "bootstrap-http-secret";
const workerEnv = { ...env, ADMIN_TOKEN: bootstrap, TOKEN_HASH_KEY: "token-hash-key" } as Env;

async function installSchema() {
  await env.DB.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS collaboration_review_decisions; DROP TABLE IF EXISTS publication_review_policies; DROP TABLE IF EXISTS collaboration_comments; DROP TABLE IF EXISTS collaboration_grants; DROP TABLE IF EXISTS collaboration_memberships; DROP TABLE IF EXISTS collaboration_actors; DROP TABLE IF EXISTS organizations; DROP TABLE IF EXISTS access_policies; DROP TABLE IF EXISTS publication_versions; DROP TABLE IF EXISTS publications; DROP TABLE IF EXISTS api_tokens; DROP TABLE IF EXISTS audit_events; DROP TABLE IF EXISTS idempotency_keys; DROP TABLE IF EXISTS owner_quotas; DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;
    CREATE TABLE owners (id TEXT PRIMARY KEY);
    CREATE TABLE owner_quotas (owner_id TEXT PRIMARY KEY, max_tokens INTEGER NOT NULL DEFAULT 10);
    CREATE TABLE idempotency_keys (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_status INTEGER, response_body TEXT, expires_at TEXT NOT NULL, UNIQUE(owner_id, idempotency_key));
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL, label TEXT NOT NULL, scopes_json TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT, actor_id TEXT);
    CREATE TABLE organizations (owner_id TEXT PRIMARY KEY, namespace TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE collaboration_actors (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, display_name TEXT NOT NULL, email TEXT, external_subject TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, UNIQUE(owner_id, email), UNIQUE(owner_id, external_subject));
    CREATE TABLE collaboration_memberships (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT NOT NULL, role TEXT NOT NULL, invited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, accepted_at TEXT, removed_at TEXT, invite_digest TEXT, UNIQUE(owner_id, actor_id));
    CREATE TABLE publications (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, link_kind TEXT NOT NULL DEFAULT 'unlisted', deleted_at TEXT);
    CREATE TABLE publication_versions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, is_complete INTEGER NOT NULL, deleted_at TEXT);
    CREATE TABLE access_policies (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, password_iterations INTEGER NOT NULL, auth_version INTEGER NOT NULL, approval_state TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE collaboration_grants (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT, actions_json TEXT NOT NULL, credential_digest TEXT NOT NULL UNIQUE, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE collaboration_comments (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT, author_actor_id TEXT NOT NULL, body TEXT NOT NULL, resolved_at TEXT, resolved_by_actor_id TEXT, deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE collaboration_review_decisions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT NOT NULL, actor_id TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, superseded_at TEXT, UNIQUE(owner_id, version_id, actor_id));
    CREATE TABLE publication_review_policies (owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(owner_id, publication_id));
  `);
  await env.DB.prepare("INSERT INTO publications (id, owner_id) VALUES (?, ?)").bind("publication-http", ownerId).run();
  await env.DB.prepare("INSERT INTO publication_versions (id, owner_id, publication_id, is_complete) VALUES (?, ?, ?, 1)").bind("version-http", ownerId, "publication-http").run();
}

function request(path: string, token: string, init: RequestInit = {}) {
  return worker.fetch!(new Request(`https://pagecast.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }) as unknown as never, workerEnv, {} as ExecutionContext);
}

beforeEach(installSchema);

describe("actor-bound collaboration token and invitation flow", () => {
  it("requires an idempotency key for collaboration grants and replays the same credential", async () => {
    const path = `/v1/owners/${ownerId}/collaboration-grants`;
    const body = JSON.stringify({ publicationId: "publication-http", actions: ["publication:view"] });
    const withoutKey = await request(path, bootstrap, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(withoutKey.status).toBe(400);
    expect(await env.DB.prepare("SELECT id FROM collaboration_grants").first()).toBeNull();

    const headers = { "content-type": "application/json", "Idempotency-Key": "collaboration-grant-once" };
    const first = await request(path, bootstrap, { method: "POST", headers, body });
    const second = await request(path, bootstrap, { method: "POST", headers, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json<{ id: string; credential: string }>();
    const secondBody = await second.json<{ id: string; credential: string }>();
    expect(secondBody).toEqual(firstBody);
    expect(firstBody.credential).toMatch(new RegExp(`^pcg2_${firstBody.id}\\.`));
  });

  it("requires the issued invitation exactly once before the actor can comment", async () => {
    const actor = await request(`/v1/owners/${ownerId}/actors`, bootstrap, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "actor" }, body: JSON.stringify({ actorId: "actor-http", displayName: "HTTP actor" }) });
    expect(actor.status).toBe(201);
    const tokenResponse = await request(`/v1/owners/${ownerId}/tokens`, bootstrap, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "token" }, body: JSON.stringify({ label: "commenter", actorId: "actor-http", scopes: ["collaboration:write", "collaboration:read", "collaboration:admin"] }) });
    const { token } = await tokenResponse.json<{ token: string }>();
    const inviteResponse = await request(`/v1/owners/${ownerId}/memberships`, bootstrap, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "invite" }, body: JSON.stringify({ actorId: "actor-http", role: "commenter" }) });
    const invitation = await inviteResponse.json<{ id: string; invitation: string }>();

    const accept = (invitationHeader?: string) => request(`/v1/owners/${ownerId}/memberships/${invitation.id}/accept`, token, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID(), ...(invitationHeader ? { "X-Pagecast-Invitation": invitationHeader } : {}) } });
    expect((await accept()).status).toBe(403);
    expect((await accept(invitation.invitation.replace(/.$/, "x"))).status).toBe(403);
    expect((await accept(invitation.invitation)).status).toBe(200);
    expect((await accept(invitation.invitation)).status).toBe(403);
    expect((await request(`/v1/owners/${ownerId}/actors`, token, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "forbidden-admin" }, body: JSON.stringify({ actorId: "actor-forbidden", displayName: "Forbidden" }) })).status).toBe(403);
    const comment = await request(`/v1/owners/${ownerId}/publications/publication-http/comments`, token, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "comment" }, body: JSON.stringify({ versionId: "version-http", body: "Approved copy" }) });
    expect(comment.status).toBe(201);
  });

  it("uses a stable keyset cursor for collaboration lists", async () => {
    for (let number = 0; number < 51; number += 1) {
      await env.DB.prepare("INSERT INTO collaboration_actors (id, owner_id, display_name) VALUES (?, ?, ?)").bind(`actor-page-${String(number).padStart(2, "0")}`, ownerId, `Actor ${number}`).run();
    }
    const first = await request(`/v1/owners/${ownerId}/actors`, bootstrap);
    const firstBody = await first.json<{ actors: Array<{ id: string }>; nextCursor: string | null }>();
    expect(firstBody.actors).toHaveLength(50);
    expect(firstBody.nextCursor).toBeTypeOf("string");
    const second = await request(`/v1/owners/${ownerId}/actors?cursor=${encodeURIComponent(firstBody.nextCursor!)}`, bootstrap);
    const secondBody = await second.json<{ actors: Array<{ id: string }>; nextCursor: string | null }>();
    expect(secondBody.actors).toHaveLength(1);
    expect(new Set([...firstBody.actors, ...secondBody.actors].map((actor) => actor.id))).toHaveLength(51);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("revokes every removed actor token before it can authenticate again", async () => {
    expect((await request(`/v1/owners/${ownerId}/actors`, bootstrap, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "actor-revoke" }, body: JSON.stringify({ actorId: "actor-revoke", displayName: "Revoked actor" }) })).status).toBe(201);
    const created = await request(`/v1/owners/${ownerId}/tokens`, bootstrap, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "token-revoke" }, body: JSON.stringify({ label: "bound", actorId: "actor-revoke", scopes: ["collaboration:read"] }) });
    const { token, id } = await created.json<{ token: string; id: string }>();

    expect((await request(`/v1/owners/${ownerId}/actors/actor-revoke`, bootstrap, { method: "DELETE", headers: { "Idempotency-Key": "remove-actor" } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT revoked_at FROM api_tokens WHERE id = ?").bind(id).first<{ revoked_at: string | null }>()).toMatchObject({ revoked_at: expect.any(String) });
    expect((await request(`/v1/owners/${ownerId}/actors`, token)).status).toBe(401);
  });

  it("admits presence only for a bound token with an active view membership", async () => {
    const presencePath = `/v1/owners/${ownerId}/publications/publication-http/presence`;
    expect((await request(presencePath, bootstrap, { headers: { Upgrade: "websocket" } })).status).toBe(403);

    const unbound = await request(`/v1/owners/${ownerId}/tokens`, bootstrap, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "presence-unbound" },
      body: JSON.stringify({ label: "unbound presence", scopes: ["presence:connect"] }),
    });
    const { token: unboundToken } = await unbound.json<{ token: string }>();
    expect((await request(presencePath, unboundToken, { headers: { Upgrade: "websocket" } })).status).toBe(403);

    expect((await request(`/v1/owners/${ownerId}/actors`, bootstrap, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "presence-actor" },
      body: JSON.stringify({ actorId: "presence-actor", displayName: "Presence actor" }),
    })).status).toBe(201);
    const bound = await request(`/v1/owners/${ownerId}/tokens`, bootstrap, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "presence-bound" },
      body: JSON.stringify({ label: "bound presence", actorId: "presence-actor", scopes: ["presence:connect"] }),
    });
    const { token: boundToken } = await bound.json<{ token: string }>();
    const invited = await request(`/v1/owners/${ownerId}/memberships`, bootstrap, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "presence-invite" },
      body: JSON.stringify({ actorId: "presence-actor", role: "viewer" }),
    });
    const { id, invitation } = await invited.json<{ id: string; invitation: string }>();
    expect((await request(`/v1/owners/${ownerId}/memberships/${id}/accept`, boundToken, {
      method: "POST",
      headers: { "Idempotency-Key": "presence-accept", "X-Pagecast-Invitation": invitation },
    })).status).toBe(200);

    const connected = await request(presencePath, boundToken, { headers: { Upgrade: "websocket" } });
    expect(connected.status).toBe(101);
    connected.webSocket?.accept();
    connected.webSocket?.close();
  });
});
