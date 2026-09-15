import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const ownerId = "owner-d1-mutations";

async function installSchema(auditConstraint = "") {
  await env.DB.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS api_tokens;
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS owner_quotas;
    DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;
    CREATE TABLE owners (id TEXT PRIMARY KEY);
    CREATE TABLE owner_quotas (owner_id TEXT PRIMARY KEY, max_tokens INTEGER NOT NULL DEFAULT 10, FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE);
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL, label TEXT NOT NULL, scopes_json TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE);
    CREATE TABLE idempotency_keys (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_status INTEGER, response_body TEXT, expires_at TEXT NOT NULL, UNIQUE(owner_id, idempotency_key), FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL ${auditConstraint}, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, metadata_json TEXT NOT NULL, FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE);
  `);
}

function packet(key: string, mutation: Record<string, unknown>) {
  return JSON.stringify({ actorId: null, fingerprint: `fingerprint:${key}`, idempotencyKey: key, mutation });
}

async function call(key: string, mutation: Record<string, unknown>) {
  const stub = env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName(ownerId));
  return stub.fetch("https://pagecast.test/control", {
    method: "POST",
    headers: { "X-Pagecast-Owner": ownerId, "content-type": "application/json" },
    body: packet(key, mutation),
  });
}

async function count(table: string): Promise<number> {
  const result = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return result?.count ?? 0;
}

beforeEach(async () => installSchema());

describe("owner mutation transaction", () => {
  it("records a stable not-found receipt for a new owner", async () => {
    const response = await call("missing-token", {
      kind: "revoke-token", tokenId: "token-missing",
    });

    await expect(response.json()).resolves.toEqual({
      status: 404,
      body: { error: "token_not_found" },
    });
    expect(await count("owners")).toBe(1);
    expect(await count("idempotency_keys")).toBe(1);
  });

  it("commits token, audit event, and terminal receipt together", async () => {
    const response = await call("create-atomic", {
      kind: "create-token", id: "token-atomic", tokenHash: "digest", label: "publisher", scopes: ["status:read"], expiresAt: null,
    });

    expect(response.status).toBe(200);
    expect(await count("api_tokens")).toBe(1);
    expect(await count("audit_events")).toBe(1);
    expect(await count("idempotency_keys")).toBe(1);
  });

  it("rolls back token and receipt when the audit statement fails in the batch", async () => {
    await installSchema("CHECK(action = 'allowed')");
    const response = await call("audit-failure", {
      kind: "create-token", id: "token-failure", tokenHash: "digest", label: "publisher", scopes: ["status:read"], expiresAt: null,
    });

    await expect(response.json()).resolves.toEqual({ status: 502, body: { error: "mutation_failed" } });
    expect(await count("api_tokens")).toBe(0);
    expect(await count("idempotency_keys")).toBe(0);
  });

  it("serializes concurrent create and revoke mutations for one owner", async () => {
    await call("seed", {
      kind: "create-token", id: "token-seed", tokenHash: "digest", label: "seed", scopes: ["status:read"], expiresAt: null,
    });
    const [revoke, create] = await Promise.all([
      call("revoke-seed", { kind: "revoke-token", tokenId: "token-seed" }),
      call("create-next", { kind: "create-token", id: "token-next", tokenHash: "digest-next", label: "next", scopes: ["status:read"], expiresAt: null }),
    ]);

    expect(revoke.status).toBe(200);
    expect(create.status).toBe(200);
    expect(await env.DB.prepare("SELECT revoked_at FROM api_tokens WHERE id = ?").bind("token-seed").first<{ revoked_at: string | null }>()).toMatchObject({ revoked_at: expect.any(String) });
    expect(await env.DB.prepare("SELECT id FROM api_tokens WHERE id = ?").bind("token-next").first()).toMatchObject({ id: "token-next" });
  });
});
