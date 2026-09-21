import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256 } from "../src/publications";
import type { Env } from "../src/types";

const ownerId = "owner-public-delivery";
const workerEnv = {
  ...env,
  ADMIN_TOKEN: "public-delivery-admin-secret",
  TOKEN_HASH_KEY: "public-delivery-token-key",
  COOKIE_SIGNING_KEY: "public-delivery-cookie-key",
} as Env;

function control(path: string, init: RequestInit = {}) {
  return worker.fetch!(new Request(`https://pagecast.test${path}`, {
    ...init,
    headers: { Authorization: "Bearer public-delivery-admin-secret", ...(init.headers ?? {}) },
  }) as never, workerEnv, {} as ExecutionContext);
}

async function publicRequest(path: string, init: RequestInit = {}) {
  const response = await worker.fetch!(new Request(`https://pagecast.test${path}`, init) as never, workerEnv, {} as ExecutionContext);
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  return response;
}

async function isolatedRequest(publicationId: string, path: string, init: RequestInit = {}) {
  const response = await worker.fetch!(new Request(`https://${publicationId}.content.pagecast.test${path}`, init) as never, {
    ...workerEnv,
    CONTENT_ORIGIN: "https://content.pagecast.test",
  }, {} as ExecutionContext);
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  return response;
}

async function publishedFixture(options: { mode?: string; expiresAt?: string | null; approval?: string } = {}) {
  const files = [
    ["index.html", "<h1>Protected report</h1>", "text/html"],
    ["assets/app.js", "console.log('protected')", "application/javascript"],
    ["assets/module.mjs", "export const ready = true;", "text/javascript"],
    ["assets/Q3 chart.png", "chart", "image/png"],
    ["assets/app.js.map", "{\"sources\":[\"private.ts\"]}", "application/json"],
    ["index.md", "# Protected report", "text/markdown"],
  ] as const;
  const created = await control(`/v1/owners/${ownerId}/upload-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      mode: "create",
      title: "Protected report",
      slug: `protected-${crypto.randomUUID()}`,
      linkKind: "public",
      manifest: await Promise.all(files.map(async ([path, body, contentType]) => ({ path, bytes: body.length, sha256: await sha256(body), contentType }))),
    }),
  });
  expect(created.status).toBe(201);
  const publication = await created.json() as { sessionId: string; publicationId: string; versionId: string; slug: string };
  for (const [path, body, contentType] of files) {
    const put = await control(`/v1/owners/${ownerId}/upload-sessions/${publication.sessionId}/files/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "content-type": contentType, "X-Content-SHA256": await sha256(body) },
      body,
    });
    expect(put.status, `${path}: ${await put.text()}`).toBe(200);
  }
  expect((await control(`/v1/owners/${ownerId}/upload-sessions/${publication.sessionId}/complete`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
  expect((await control(`/v1/owners/${ownerId}/publications/${publication.publicationId}/versions/${publication.versionId}/activate`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
  if (options.expiresAt !== undefined) {
    await env.DB.prepare("UPDATE publications SET expires_at = ? WHERE id = ?").bind(options.expiresAt, publication.publicationId).run();
  }
  if (options.mode || options.approval) {
    expect((await control(`/v1/owners/${ownerId}/publications/${publication.publicationId}/access-policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ mode: options.mode ?? "public", approvalState: options.approval ?? "approved", password: options.mode === "password" ? "correct horse battery staple" : undefined }),
    })).status).toBe(200);
  }
  return publication;
}

beforeEach(async () => {
  await env.DB.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS password_attempts;
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
    CREATE TABLE owners (id TEXT PRIMARY KEY);
    CREATE TABLE owner_quotas (owner_id TEXT PRIMARY KEY, max_tokens INTEGER NOT NULL DEFAULT 10);
    CREATE TABLE idempotency_keys (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, operation_type TEXT, response_status INTEGER, response_body TEXT, expires_at TEXT NOT NULL, UNIQUE(owner_id, idempotency_key));
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, metadata_json TEXT NOT NULL, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE outbox_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processing_started_at TEXT, enqueue_lease_token TEXT, enqueue_lease_expires_at TEXT, last_enqueued_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT, retention_until TEXT, UNIQUE(owner_id, dedupe_key));
    CREATE TABLE publications (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', active_version_id TEXT, revoked_version_id TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, link_kind TEXT NOT NULL DEFAULT 'unlisted', context_key TEXT, generation INTEGER NOT NULL DEFAULT 0, retention_until TEXT, deleted_at TEXT, UNIQUE(owner_id, slug), UNIQUE(owner_id, context_key));
    CREATE TABLE publication_versions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_number INTEGER NOT NULL, manifest_key TEXT NOT NULL, content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'staged', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT, is_complete INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, retention_until TEXT, deleted_at TEXT, storage_purged_at TEXT, UNIQUE(publication_id, version_number));
    CREATE TABLE upload_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT NOT NULL, mode TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, operation_id TEXT NOT NULL, UNIQUE(owner_id, operation_id));
    CREATE TABLE upload_session_files (session_id TEXT NOT NULL, normalized_path TEXT NOT NULL, r2_key TEXT NOT NULL, expected_bytes INTEGER NOT NULL, expected_sha256 TEXT NOT NULL, content_type TEXT NOT NULL, received_bytes INTEGER, received_sha256 TEXT, uploaded_at TEXT, PRIMARY KEY(session_id, normalized_path), UNIQUE(r2_key));
    CREATE TABLE version_files (version_id TEXT NOT NULL, normalized_path TEXT NOT NULL, r2_key TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, content_type TEXT NOT NULL, PRIMARY KEY(version_id, normalized_path));
    CREATE TABLE redirects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, source_path TEXT NOT NULL, destination_path TEXT NOT NULL, status_code INTEGER NOT NULL, UNIQUE(publication_id, source_path));
    CREATE TABLE access_policies (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, password_hash TEXT, password_salt TEXT, password_iterations INTEGER NOT NULL DEFAULT 210000, auth_version INTEGER NOT NULL DEFAULT 1, approval_state TEXT NOT NULL DEFAULT 'approved', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE publication_review_policies (owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(owner_id, publication_id));
    CREATE TABLE collaboration_review_decisions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, version_id TEXT NOT NULL, actor_id TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, superseded_at TEXT, UNIQUE(owner_id, version_id, actor_id));
    CREATE TABLE access_grants (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_value TEXT NOT NULL, permission TEXT NOT NULL DEFAULT 'view', expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id, publication_id, principal_type, principal_value));
    CREATE TABLE password_attempts (publication_id TEXT NOT NULL, fingerprint TEXT NOT NULL, failed_count INTEGER NOT NULL DEFAULT 0, window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, blocked_until TEXT, PRIMARY KEY(publication_id, fingerprint));
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL, label TEXT NOT NULL, scopes_json TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT);
  `);
});

describe("policy-enforced public delivery", () => {
  it("serves only the active manifest with validators, ranges, HEAD, and safe headers", async () => {
    const publication = await publishedFixture();
    const first = await publicRequest(`/p/${publication.slug}/assets/app.js`);
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toContain("application/javascript");
    expect(first.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(first.headers.get("ETag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(await first.text()).toContain("protected");
    expect((await publicRequest(`/p/${publication.slug}/assets/app.js`, { method: "HEAD" })).status).toBe(200);
    expect((await publicRequest(`/p/${publication.slug}/assets/app.js`, { headers: { Range: "bytes=0-6" } })).status).toBe(206);
    expect((await publicRequest(`/p/${publication.slug}/assets/app.js`, { headers: { Range: "bytes=999-1000" } })).status).toBe(416);
    expect((await publicRequest(`/p/${publication.slug}/assets/app.js`, { headers: { "If-None-Match": first.headers.get("ETag")! } })).status).toBe(304);
    expect((await publicRequest(`/p/${publication.slug}/versions/${publication.versionId}/index.html`)).status).toBe(404);
    expect((await publicRequest(`/p/${publication.slug}/assets/app.js.map`)).status).toBe(404);
    expect((await publicRequest(`/p/${publication.slug}/assets/Q3%20chart.png`)).status).toBe(200);
    expect((await publicRequest(`/p/${publication.slug}/assets/%252e%252e%252findex.html`)).status).toBe(404);
    expect((await publicRequest(`/p/${publication.slug}/assets/module.mjs`)).headers.get("Content-Type")).toBe("text/javascript");
    const html = await publicRequest(`/p/${publication.slug}/`);
    expect(html.headers.get("Content-Security-Policy")).toContain("'unsafe-inline'");
    expect(await html.text()).toBe("<h1>Protected report</h1>");
    const socialPreview = await publicRequest(`/p/${publication.slug}/`, { headers: { "User-Agent": "Twitterbot/1.0" } });
    expect(await socialPreview.text()).toContain(`property="og:image" content="https://pagecast.test/p/${publication.slug}/_social/card.svg"`);
    expect((await publicRequest(`/p/${publication.slug}/`, { headers: { Accept: "application/json;q=0, text/html;q=1" } })).headers.get("Content-Type")).toBe("text/html");
    expect((await publicRequest(`/p/${publication.slug}/`, { headers: { Accept: "text/html;q=0" } })).status).toBe(406);
  });

  it("checks policy before every asset read and invalidates old password sessions", async () => {
    const publication = await publishedFixture({ mode: "password" });
    const asset = `/p/${publication.slug}/assets/app.js`;
    expect((await publicRequest(asset)).status).toBe(503);
    expect((await isolatedRequest(publication.publicationId, asset)).status).toBe(401);
    const entry = await isolatedRequest(publication.publicationId, `/p/${publication.slug}/`);
    expect(entry.status).toBe(302);
    expect(entry.headers.get("Location")).toBe(`https://${publication.publicationId}.content.pagecast.test/p/${publication.slug}/_auth/password`);
    const form = await isolatedRequest(publication.publicationId, `/p/${publication.slug}/_auth/password`);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('type="password"');
    const login = await isolatedRequest(publication.publicationId, `/p/${publication.slug}/_auth/password`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=correct+horse+battery+staple" });
    expect(login.status).toBe(303);
    expect(login.headers.get("Set-Cookie")).toContain("__Host-pc_session=");
    expect(login.headers.get("Set-Cookie")).toContain("Path=/; HttpOnly; Secure");
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    expect((await isolatedRequest(publication.publicationId, asset, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await control(`/v1/owners/${ownerId}/publications/${publication.publicationId}/access-policy`, { method: "PUT", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ mode: "password", password: "new password" }) })).status).toBe(200);
    expect((await isolatedRequest(publication.publicationId, asset, { headers: { Cookie: cookie } })).status).toBe(401);
    const currentLogin = await isolatedRequest(publication.publicationId, `/p/${publication.slug}/_auth/password`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=new+password" });
    const currentCookie = currentLogin.headers.get("Set-Cookie")!.split(";")[0];
    const failures = await Promise.all(Array.from({ length: 5 }, () => isolatedRequest(publication.publicationId, `/p/${publication.slug}/_auth/password`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.10" }, body: "password=incorrect-password" })));
    expect(failures.every((response) => response.status === 401)).toBe(true);
    expect((await isolatedRequest(publication.publicationId, `/p/${publication.slug}/_auth/password`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.10" }, body: "password=incorrect-password" })).status).toBe(429);
    expect((await control(`/v1/owners/${ownerId}/publications/${publication.publicationId}/revoke`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
    expect((await isolatedRequest(publication.publicationId, asset, { headers: { Cookie: currentCookie } })).status).toBe(404);
    expect((await control(`/v1/owners/${ownerId}/publications/${publication.publicationId}/restore`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
    expect((await isolatedRequest(publication.publicationId, asset, { headers: { Cookie: currentCookie } })).status).toBe(401);
  });

  it("keeps expiry, grants, negotiation, and edge social routes under the same policy", async () => {
    const publication = await publishedFixture({ mode: "allowlist", approval: "pending" });
    const path = `/p/${publication.slug}/`;
    expect((await publicRequest(path)).status).toBe(503);
    const entry = await isolatedRequest(publication.publicationId, path);
    expect(entry.status).toBe(302);
    expect(entry.headers.get("Location")).toBe(`https://${publication.publicationId}.content.pagecast.test/p/${publication.slug}/_auth/grant`);
    const policyKey = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const policyRequest = () => control(`/v1/owners/${ownerId}/publications/${publication.publicationId}/access-policy`, { method: "PUT", headers: { "content-type": "application/json", "Idempotency-Key": policyKey }, body: JSON.stringify({ mode: "allowlist", approvalState: "approved", expiresAt }) });
    expect((await policyRequest()).status).toBe(200);
    expect(await env.DB.prepare("SELECT expires_at FROM publications WHERE id = ?").bind(publication.publicationId).first()).toMatchObject({ expires_at: expiresAt });
    expect((await policyRequest()).status).toBe(200);
    const grantKey = crypto.randomUUID();
    const grantRequest = () => control(`/v1/owners/${ownerId}/publications/${publication.publicationId}/grants`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": grantKey }, body: JSON.stringify({ permission: "view", expiresAt: null }) });
    const grant = await grantRequest();
    expect(grant.status).toBe(201);
    const grantBody = await grant.json() as { id: string; credential: string };
    expect(await (await grantRequest()).json()).toEqual(grantBody);
    const credential = grantBody.credential;
    expect((await isolatedRequest(publication.publicationId, path, { headers: { Authorization: `Bearer ${credential}`, Accept: "text/markdown" } })).status).toBe(200);
    expect((await isolatedRequest(publication.publicationId, path, { headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" } })).status).toBe(200);
    expect((await isolatedRequest(publication.publicationId, `/p/${publication.slug}/_social/card.svg`, { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(200);
    const redemption = await isolatedRequest(publication.publicationId, `/p/${publication.slug}/_auth/grant`);
    const redemptionForm = await redemption.text();
    expect(redemptionForm).toContain("location.hash.slice(1)");
    expect(redemptionForm).toContain("pagecast-auth");
    const redeemed = await isolatedRequest(publication.publicationId, `/p/${publication.slug}/_auth/grant`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `credential=${encodeURIComponent(credential)}` });
    expect(redeemed.status).toBe(303);
    const grantCookie = redeemed.headers.get("Set-Cookie")!.split(";")[0];
    expect((await isolatedRequest(publication.publicationId, path, { headers: { Cookie: grantCookie } })).status).toBe(200);
    expect((await control(`/v1/owners/${ownerId}/publications/${publication.publicationId}/grants/${grantBody.id}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } })).status).toBe(200);
    expect((await isolatedRequest(publication.publicationId, `/p/${publication.slug}/assets/app.js`, { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(401);
    await env.DB.prepare("UPDATE publications SET expires_at = datetime('now', '-1 second') WHERE id = ?").bind(publication.publicationId).run();
    expect((await isolatedRequest(publication.publicationId, path, { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(404);
  });

  it("uses a stable per-publication host and rejects expired grants by instant", async () => {
    const first = await publishedFixture({ mode: "allowlist" });
    const second = await publishedFixture();
    const firstPath = `/p/${first.slug}/`;
    const secondPath = `/p/${second.slug}/`;
    const wrongHost = await isolatedRequest(first.publicationId, `${secondPath}?view=chart`);
    expect(wrongHost.status).toBe(308);
    expect(wrongHost.headers.get("Location")).toBe(`https://${second.publicationId}.content.pagecast.test${secondPath}?view=chart`);
    const sharedHost = await worker.fetch!(new Request(`https://pagecast.test${firstPath}`) as never, {
      ...workerEnv,
      CONTENT_ORIGIN: "https://content.pagecast.test",
    }, {} as ExecutionContext);
    expect(sharedHost.status).toBe(308);
    expect(sharedHost.headers.get("Location")).toBe(`https://${first.publicationId}.content.pagecast.test${firstPath}`);
    const insecureHost = await worker.fetch!(new Request(`http://${first.publicationId}.content.pagecast.test${firstPath}`) as never, {
      ...workerEnv,
      CONTENT_ORIGIN: "https://content.pagecast.test",
    }, {} as ExecutionContext);
    expect(insecureHost.status).toBe(308);
    expect(insecureHost.headers.get("Location")).toBe(`https://${first.publicationId}.content.pagecast.test${firstPath}`);

    const grant = await control(`/v1/owners/${ownerId}/publications/${first.publicationId}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ permission: "view", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    });
    const { id, credential } = await grant.json() as { id: string; credential: string };
    await env.DB.prepare("UPDATE access_grants SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1_000).toISOString(), id).run();
    expect((await isolatedRequest(first.publicationId, `/p/${first.slug}/assets/app.js`, { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(401);
  });
});
