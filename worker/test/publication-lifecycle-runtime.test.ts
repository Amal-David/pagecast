import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { digestToken } from "../src/auth";
import { cleanupPublicationStorage, executePublicationMutation, normalizeManifest, r2Key, sha256 } from "../src/publications";
import type { Env } from "../src/types";

const ownerId = "owner-publication-lifecycle";
const auth = { Authorization: "Bearer bootstrap-secret-that-must-never-appear-in-a-response" };
const workerEnv = { ...env, ADMIN_TOKEN: "bootstrap-secret-that-must-never-appear-in-a-response", TOKEN_HASH_KEY: "token-hash-key" } as Env;

function request(path: string, init: RequestInit = {}, runtime: Env = workerEnv) {
  return worker.fetch!(new Request(`https://pagecast.test${path}`, {
    ...init,
    headers: { ...auth, ...(init.headers ?? {}) },
  }) as unknown as never, runtime, {} as ExecutionContext);
}

async function createSession(overrides: Record<string, unknown> = {}) {
  const html = "<h1>Pagecast</h1>";
  const response = await request(`/v1/owners/${ownerId}/upload-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      mode: "create",
      title: "Lifecycle report",
      slug: "lifecycle-report",
      linkKind: "unlisted",
      manifest: [{ path: "index.html", bytes: html.length, sha256: await sha256(html), contentType: "text/html" }],
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return { ...(await response.json()) as { sessionId: string; publicationId: string; versionId: string; slug: string }, html };
}

beforeEach(async () => {
  await env.DB.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS version_files;
    DROP TABLE IF EXISTS upload_session_files;
    DROP TABLE IF EXISTS upload_sessions;
    DROP TABLE IF EXISTS redirects;
    DROP TABLE IF EXISTS access_grants;
    DROP TABLE IF EXISTS access_policies;
    DROP TABLE IF EXISTS collaboration_review_decisions;
    DROP TABLE IF EXISTS publication_review_policies;
    DROP TABLE IF EXISTS api_tokens;
    DROP TABLE IF EXISTS publication_versions;
    DROP TABLE IF EXISTS publications;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS outbox_events;
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS owner_quotas;
    DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;
  `);
  await env.DB.exec(`
    CREATE TABLE owners (id TEXT PRIMARY KEY);
    CREATE TABLE owner_quotas (owner_id TEXT PRIMARY KEY, max_tokens INTEGER NOT NULL DEFAULT 10);
    CREATE TABLE idempotency_keys (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, operation_type TEXT, response_status INTEGER, response_body TEXT, expires_at TEXT NOT NULL, UNIQUE(owner_id, idempotency_key));
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, metadata_json TEXT NOT NULL, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE outbox_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processing_started_at TEXT, enqueue_lease_token TEXT, enqueue_lease_expires_at TEXT, last_enqueued_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT, retention_until TEXT, UNIQUE(owner_id, dedupe_key));
    CREATE TABLE publications (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', active_version_id TEXT, revoked_version_id TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, link_kind TEXT NOT NULL DEFAULT 'unlisted', context_key TEXT, generation INTEGER NOT NULL DEFAULT 0, retention_until TEXT, deleted_at TEXT, UNIQUE(owner_id, slug), UNIQUE(owner_id, context_key));
    CREATE TABLE publication_versions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_number INTEGER NOT NULL, manifest_key TEXT, content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'staged', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT, is_complete INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, retention_until TEXT, deleted_at TEXT, storage_purged_at TEXT, UNIQUE(publication_id, version_number));
    CREATE TABLE upload_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT NOT NULL, mode TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, operation_id TEXT NOT NULL, UNIQUE(owner_id, operation_id));
    CREATE TABLE upload_session_files (session_id TEXT NOT NULL, normalized_path TEXT NOT NULL, r2_key TEXT NOT NULL, expected_bytes INTEGER NOT NULL, expected_sha256 TEXT NOT NULL, content_type TEXT NOT NULL, received_bytes INTEGER, received_sha256 TEXT, uploaded_at TEXT, PRIMARY KEY(session_id, normalized_path), UNIQUE(r2_key));
    CREATE TABLE version_files (version_id TEXT NOT NULL, normalized_path TEXT NOT NULL, r2_key TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, content_type TEXT NOT NULL, PRIMARY KEY(version_id, normalized_path));
    CREATE TABLE redirects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, source_path TEXT NOT NULL, destination_path TEXT NOT NULL, status_code INTEGER NOT NULL, UNIQUE(publication_id, source_path));
    CREATE TABLE access_policies (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL DEFAULT 'unlisted', password_hash TEXT, password_salt TEXT, password_iterations INTEGER NOT NULL DEFAULT 100000, auth_version INTEGER NOT NULL DEFAULT 1, approval_state TEXT NOT NULL DEFAULT 'approved', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE publication_review_policies (owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(owner_id, publication_id));
    CREATE TABLE collaboration_review_decisions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT NOT NULL, actor_id TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, superseded_at TEXT, UNIQUE(owner_id, version_id, actor_id));
    CREATE TABLE access_grants (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_value TEXT NOT NULL, permission TEXT NOT NULL DEFAULT 'view', expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id, publication_id, principal_type, principal_value));
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL, label TEXT NOT NULL, scopes_json TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT, actor_id TEXT);
  `);
});

describe("manifest-driven publication lifecycle", () => {
  it("bounds owner and encoded object keys while preserving canonical Unicode manifests", () => {
    const unicodePath = `${"é".repeat(80)}.html`;
    const manifest = normalizeManifest([{ path: "z.html", bytes: 1, sha256: "a".repeat(64), contentType: "text/html" }, { path: unicodePath, bytes: 1, sha256: "b".repeat(64), contentType: "text/html" }]);
    expect(manifest?.map((file) => file.path)).toEqual(["z.html", unicodePath]);
    expect(new TextEncoder().encode(r2Key("owner-safe", crypto.randomUUID(), crypto.randomUUID(), unicodePath)).byteLength).toBeLessThanOrEqual(1024);
    expect(normalizeManifest([{ path: "é".repeat(129), bytes: 1, sha256: "a".repeat(64), contentType: "text/html" }])).toBeNull();
  });

  it("generates a 128-bit capability suffix for every new unlisted link", async () => {
    const created = await createSession();
    const another = await createSession({ slug: "lifecycle-report" });
    const contextCreated = await createSession({
      mode: "context-upsert",
      contextKey: "unlisted-context",
      slug: "context-report",
    });
    const stored = await env.DB.prepare("SELECT slug FROM publications WHERE id = ?")
      .bind(created.publicationId)
      .first<{ slug: string }>();

    expect(created.slug).toMatch(/^lifecycle-report-[0-9a-f]{32}$/);
    expect(stored?.slug).toBe(created.slug);
    expect(another.slug).not.toBe(created.slug);
    expect(contextCreated.slug).toMatch(/^context-report-[0-9a-f]{32}$/);
  });

  it("enqueues the committed publication outbox event without waiting for Cron", async () => {
    const created = await createSession();
    const bytes = new TextEncoder().encode(created.html);
    await env.PUBLICATIONS.put(r2Key(ownerId, created.publicationId, created.versionId, "index.html"), bytes, { httpMetadata: { contentType: "text/html" }, customMetadata: { sha256: await sha256(created.html) } });
    await request(`/v1/owners/${ownerId}/upload-sessions/${created.sessionId}/files/index.html`, { method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(created.html), "Idempotency-Key": crypto.randomUUID() }, body: created.html });
    await request(`/v1/owners/${ownerId}/upload-sessions/${created.sessionId}/complete`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
    const activated = await request(`/v1/owners/${ownerId}/publications/${created.publicationId}/versions/${created.versionId}/activate`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
    expect(activated.status).toBe(200);
    const outbox = await env.DB.prepare("SELECT id, last_enqueued_at FROM outbox_events WHERE owner_id = ? AND dedupe_key = ?").bind(ownerId, `publication.published:${created.publicationId}:${created.versionId}`).first<{ id: string; last_enqueued_at: string | null }>();
    expect(outbox?.last_enqueued_at).toBeTruthy();
  });

  it("context-upserts without a publication id and new-link reassigns that context", async () => {
    const first = await createSession({ mode: "context-upsert", contextKey: "daily-report", slug: "daily-report", linkKind: "public" });
    const update = await createSession({ mode: "context-upsert", contextKey: "daily-report", slug: "ignored-for-upsert", linkKind: "public" });
    expect(update.publicationId).toBe(first.publicationId);
    const replacement = await createSession({ mode: "new-link", contextKey: "daily-report", slug: "daily-report-copy" });
    expect(replacement.publicationId).not.toBe(first.publicationId);
    expect(await env.DB.prepare("SELECT context_key FROM publications WHERE id = ?").bind(first.publicationId).first()).toMatchObject({ context_key: null });
    expect(await env.DB.prepare("SELECT context_key FROM publications WHERE id = ?").bind(replacement.publicationId).first()).toMatchObject({ context_key: "daily-report" });
  });

  it("persists a 409 receipt when simultaneous owners claim one global slug", async () => {
    const html = "race";
    const slug = "global-race";
    const claims = ["owner-race-a", "owner-race-b"].map(async (owner) => {
      const key = crypto.randomUUID();
      const response = await request(`/v1/owners/${owner}/upload-sessions`, {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ mode: "create", title: "Race", slug, linkKind: "public", manifest: [{ path: "index.html", bytes: html.length, sha256: await sha256(html), contentType: "text/html" }] }),
      });
      return { owner, key, response };
    });
    const results = await Promise.all(claims);
    expect(results.map(({ response }) => response.status).sort()).toEqual([201, 409]);
    const loser = results.find(({ response }) => response.status === 409)!;
    expect(await env.DB.prepare("SELECT response_status FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?").bind(loser.owner, loser.key).first()).toMatchObject({ response_status: 409 });
  });

  it("rejects unsafe, hidden, and duplicate-normalized manifest paths before allocating storage", async () => {
    for (const path of ["../secret.html", ".env", "docs/../index.html", "bad\nname.txt"]) {
      const response = await request(`/v1/owners/${ownerId}/upload-sessions`, {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ mode: "create", title: "No", slug: `no-${crypto.randomUUID()}`, linkKind: "public", manifest: [{ path, bytes: 1, sha256: "a".repeat(64), contentType: "text/plain" }] }),
      });
      expect(response.status).toBe(400);
    }
    const duplicate = await request(`/v1/owners/${ownerId}/upload-sessions`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ mode: "create", title: "No", slug: "duplicate-paths", linkKind: "public", manifest: [
        { path: "index.html", bytes: 1, sha256: "a".repeat(64), contentType: "text/plain" },
        { path: "index.html", bytes: 1, sha256: "b".repeat(64), contentType: "text/plain" },
      ] }),
    });
    expect(duplicate.status).toBe(400);
  });

  it("streams one declared file to an owner-bound, server-generated R2 key and retries exactly", async () => {
    const { sessionId, html } = await createSession();
    const path = encodeURIComponent("index.html");
    const checksum = await sha256(html);
    const put = () => request(`/v1/owners/${ownerId}/upload-sessions/${sessionId}/files/${path}`, {
      method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": checksum }, body: html,
    });
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(200);
    const file = await env.DB.prepare("SELECT r2_key, received_bytes FROM upload_session_files WHERE session_id = ?").bind(sessionId).first<{ r2_key: string; received_bytes: number }>();
    expect(file?.r2_key).toMatch(new RegExp(`^owners/${ownerId}/publications/[^/]+/versions/[^/]+/index\\.html$`));
    expect(file?.received_bytes).toBe(html.length);
    expect(await env.PUBLICATIONS.get(file!.r2_key)).not.toBeNull();
  });

  it("lets R2 reject a streamed body whose checksum does not match the manifest", async () => {
    const { sessionId, html } = await createSession();
    const file = await env.DB.prepare("SELECT r2_key, expected_sha256 FROM upload_session_files WHERE session_id = ?")
      .bind(sessionId)
      .first<{ r2_key: string; expected_sha256: string }>();
    const tampered = html.replace("Pagecast", "Pagecasu");
    const response = await request(`/v1/owners/${ownerId}/upload-sessions/${sessionId}/files/index.html`, {
      method: "PUT",
      headers: { "content-type": "text/html", "X-Content-SHA256": file!.expected_sha256 },
      body: tampered,
    });

    expect(response.status).toBe(409);
    expect(await env.PUBLICATIONS.head(file!.r2_key)).toBeNull();
  });

  it("never activates an incomplete manifest and keeps it unreachable", async () => {
    const { sessionId, publicationId, versionId } = await createSession();
    const completion = await request(`/v1/owners/${ownerId}/upload-sessions/${sessionId}/complete`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(completion.status).toBe(409);
    const version = await env.DB.prepare("SELECT is_complete FROM publication_versions WHERE id = ?").bind(versionId).first<{ is_complete: number }>();
    expect(version?.is_complete).toBe(0);
    const publication = await env.DB.prepare("SELECT active_version_id FROM publications WHERE id = ?").bind(publicationId).first<{ active_version_id: string | null }>();
    expect(publication?.active_version_id).toBeNull();
  });

  it("does not let a scoped token resume another owner's session or complete a missing object", async () => {
    const { sessionId } = await createSession();
    const tokenId = crypto.randomUUID();
    const secret = "s".repeat(32);
    await env.DB.prepare("INSERT INTO api_tokens (id, owner_id, token_hash, label, scopes_json) VALUES (?, ?, ?, 'publisher', ?)")
      .bind(tokenId, ownerId, await digestToken("token-hash-key", tokenId, secret), JSON.stringify(["publications:write"])).run();
    const tokenRequest = (path: string, init: RequestInit) => worker.fetch!(new Request(`https://pagecast.test${path}`, {
      ...init,
      headers: { Authorization: `Bearer pcv2_${tokenId}_${secret}`, ...(init.headers ?? {}) },
    }) as unknown as never, workerEnv, {} as ExecutionContext);
    expect((await tokenRequest(`/v1/owners/not-${ownerId}/upload-sessions/${sessionId}/complete`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(403);
    await env.DB.prepare("UPDATE upload_session_files SET received_bytes = expected_bytes, received_sha256 = expected_sha256 WHERE session_id = ?").bind(sessionId).run();
    expect((await tokenRequest(`/v1/owners/${ownerId}/upload-sessions/${sessionId}/complete`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(409);
  });

  it("completes, activates one version at a time, rolls back, and protects active data from deletion", async () => {
    const first = await createSession();
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/files/${encodeURIComponent("index.html")}`, { method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(first.html) }, body: first.html });
    expect((await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/complete`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
    const manifest = await env.DB.prepare("SELECT manifest_key, content_sha256 FROM publication_versions WHERE id = ?").bind(first.versionId).first<{ manifest_key: string; content_sha256: string }>();
    const manifestObject = await env.PUBLICATIONS.get(manifest!.manifest_key);
    expect(manifestObject?.httpMetadata?.contentType).toBe("application/json");
    expect(manifestObject?.customMetadata?.sha256).toBe(manifest!.content_sha256);
    const [left, right] = await Promise.all(["a", "b"].map((key) => request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}/activate`, { method: "POST", headers: { "Idempotency-Key": key } })));
    expect([left.status, right.status].filter((status) => status === 200)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT event_type, status FROM outbox_events WHERE owner_id = ? AND dedupe_key = ?")
      .bind(ownerId, `publication.published:${first.publicationId}:${first.versionId}`)
      .first<{ event_type: string; status: string }>()).toEqual({ event_type: "publication.published", status: "pending" });
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(409);
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/revoke`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/restore`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
  });

  it("keeps the retained version when a revoked publication is revoked again", async () => {
    const first = await createSession();
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/files/index.html`, {
      method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(first.html) }, body: first.html,
    });
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/complete`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}/activate`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    for (const key of [crypto.randomUUID(), crypto.randomUUID()]) {
      expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/revoke`, {
        method: "POST", headers: { "Idempotency-Key": key },
      })).status).toBe(200);
    }
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/restore`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    })).status).toBe(200);
    expect(await env.DB.prepare("SELECT active_version_id FROM publications WHERE id = ?").bind(first.publicationId).first<{ active_version_id: string | null }>())
      .toEqual({ active_version_id: first.versionId });
  });

  it("rejects password policies outside the bounded PBKDF2 work factor range", async () => {
    const first = await createSession();
    const packet = (passwordIterations: number, idempotencyKey: string) => ({
      actorId: null,
      fingerprint: `password-iterations:${passwordIterations}`,
      idempotencyKey,
      mutation: {
        kind: "publication" as const,
        operation: "set-access-policy" as const,
        data: {
          publicationId: first.publicationId,
          mode: "password",
          approvalState: "approved",
          passwordHash: "a".repeat(64),
          passwordSalt: "password-salt-that-is-long-enough",
          passwordIterations,
        },
      },
    });
    for (const iterations of [99_999, 1_000_001]) {
      const response = await executePublicationMutation(workerEnv, ownerId, packet(iterations, crypto.randomUUID()));
      expect(await response.json()).toMatchObject({ status: 400, body: { error: "invalid_access_policy" } });
    }
    const accepted = await executePublicationMutation(workerEnv, ownerId, packet(100_000, crypto.randomUUID()));
    expect(await accepted.json()).toMatchObject({ status: 200, body: { publicationId: first.publicationId } });
  });

  it("purges an expired deleted version's immutable manifest with its files", async () => {
    const first = await createSession();
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/files/index.html`, {
      method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(first.html) }, body: first.html,
    });
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/complete`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    const manifest = await env.DB.prepare("SELECT manifest_key FROM publication_versions WHERE id = ?").bind(first.versionId).first<{ manifest_key: string }>();
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}`, {
      method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() },
    })).status).toBe(200);
    await env.DB.prepare("UPDATE publication_versions SET retention_until = datetime('now', '-1 second') WHERE id = ?").bind(first.versionId).run();

    await cleanupPublicationStorage(workerEnv);

    expect(await env.PUBLICATIONS.get(manifest!.manifest_key)).toBeNull();
    expect(await env.PUBLICATIONS.get(r2Key(ownerId, first.publicationId, first.versionId, "index.html"))).toBeNull();
    expect(await env.DB.prepare("SELECT storage_purged_at FROM publication_versions WHERE id = ?").bind(first.versionId).first<{ storage_purged_at: string | null }>())
      .toMatchObject({ storage_purged_at: expect.any(String) });
  });

  it("continues purging a legacy deleted version that has no manifest key", async () => {
    const first = await createSession();
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/files/index.html`, {
      method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(first.html) }, body: first.html,
    });
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/complete`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}`, {
      method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() },
    })).status).toBe(200);
    await env.DB.prepare("UPDATE publication_versions SET manifest_key = NULL, retention_until = datetime('now', '-1 second') WHERE id = ?").bind(first.versionId).run();

    await cleanupPublicationStorage(workerEnv);

    expect(await env.PUBLICATIONS.get(r2Key(ownerId, first.publicationId, first.versionId, "index.html"))).toBeNull();
    expect(await env.DB.prepare("SELECT storage_purged_at FROM publication_versions WHERE id = ?").bind(first.versionId).first<{ storage_purged_at: string | null }>())
      .toMatchObject({ storage_purged_at: expect.any(String) });
  });

  it("restores the version that was active at revoke time, not a newer staged version", async () => {
    const first = await createSession();
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/files/index.html`, {
      method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(first.html) }, body: first.html,
    });
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/complete`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}/activate`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });

    const staged = await createSession({
      mode: "explicit-update",
      publicationId: first.publicationId,
      slug: first.slug,
    });
    await request(`/v1/owners/${ownerId}/upload-sessions/${staged.sessionId}/files/index.html`, {
      method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(staged.html) }, body: staged.html,
    });
    await request(`/v1/owners/${ownerId}/upload-sessions/${staged.sessionId}/complete`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/revoke`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/restore`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    });

    const publication = await env.DB.prepare("SELECT active_version_id FROM publications WHERE id = ?")
      .bind(first.publicationId)
      .first<{ active_version_id: string }>();
    expect(publication?.active_version_id).toBe(first.versionId);
    expect(publication?.active_version_id).not.toBe(staged.versionId);
  });

  it("renames with a redirect and retains versions until their retention period has elapsed", async () => {
    const first = await createSession();
    const mutation = request(`/v1/owners/${ownerId}/publications/${first.publicationId}/rename`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ slug: "renamed-report" }),
    });
    expect((await mutation).status).toBe(200);
    expect(await env.DB.prepare("SELECT destination_path FROM redirects WHERE publication_id = ?").bind(first.publicationId).first()).toMatchObject({ destination_path: "renamed-report" });
    await env.DB.prepare("UPDATE publication_versions SET retention_until = datetime('now', '+1 day') WHERE id = ?").bind(first.versionId).run();
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(409);
  });

  it("records version deletion, its audit event, and its receipt together", async () => {
    const first = await createSession();
    const idempotencyKey = crypto.randomUUID();
    const response = await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey },
    });
    const version = await env.DB.prepare("SELECT deleted_at FROM publication_versions WHERE id = ?")
      .bind(first.versionId)
      .first<{ deleted_at: string | null }>();
    const audit = await env.DB.prepare("SELECT action FROM audit_events WHERE resource_id = ? AND action = 'publication.version_deleted'")
      .bind(first.versionId)
      .first<{ action: string }>();
    const receipt = await env.DB.prepare("SELECT response_status FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?")
      .bind(ownerId, idempotencyKey)
      .first<{ response_status: number }>();

    expect(response.status).toBe(200);
    expect(version?.deleted_at).toEqual(expect.any(String));
    expect(audit?.action).toBe("publication.version_deleted");
    expect(receipt?.response_status).toBe(200);
  });

  it("keeps the active approved version live while requiring approval for each candidate", async () => {
    const first = await createSession({ linkKind: "public" });
    await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/files/index.html`, { method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(first.html) }, body: first.html });
    expect((await request(`/v1/owners/${ownerId}/upload-sessions/${first.sessionId}/complete`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${first.versionId}/activate`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);

    const candidate = await createSession({ mode: "explicit-update", publicationId: first.publicationId, linkKind: "public" });
    await request(`/v1/owners/${ownerId}/upload-sessions/${candidate.sessionId}/files/index.html`, { method: "PUT", headers: { "content-type": "text/html", "X-Content-SHA256": await sha256(candidate.html) }, body: candidate.html });
    expect((await request(`/v1/owners/${ownerId}/upload-sessions/${candidate.sessionId}/complete`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
    await env.DB.prepare("INSERT INTO publication_review_policies (owner_id, publication_id, requires_approval) VALUES (?, ?, 1)").bind(ownerId, first.publicationId).run();
    await env.DB.prepare("INSERT INTO collaboration_review_decisions (id, owner_id, publication_id, version_id, actor_id, decision) VALUES (?, ?, ?, ?, ?, 'approved')")
      .bind("review-first", ownerId, first.publicationId, first.versionId, "approver-a").run();

    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${candidate.versionId}/activate`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(409);
    expect(await env.DB.prepare("SELECT active_version_id FROM publications WHERE id = ?").bind(first.publicationId).first()).toMatchObject({ active_version_id: first.versionId });

    await env.DB.prepare("INSERT INTO collaboration_review_decisions (id, owner_id, publication_id, version_id, actor_id, decision) VALUES (?, ?, ?, ?, ?, 'approved')")
      .bind("review-candidate", ownerId, first.publicationId, candidate.versionId, "approver-a").run();
    expect((await request(`/v1/owners/${ownerId}/publications/${first.publicationId}/versions/${candidate.versionId}/activate`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT active_version_id FROM publications WHERE id = ?").bind(first.publicationId).first()).toMatchObject({ active_version_id: candidate.versionId });
  });
});
