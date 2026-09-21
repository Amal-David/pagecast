import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

interface TokenRecord {
  created_at: string;
  expires_at: string | null;
  id: string;
  label: string;
  last_used_at: string | null;
  owner_id: string;
  revoked_at: string | null;
  scopes_json: string;
  token_hash: string;
}

class MemoryDb {
  readonly audits: Array<{ metadata_json: string }> = [];
  readonly idempotency = new Map<string, { request_hash: string; response_body: string | null; response_status: number | null }>();
  readonly quotas = new Map<string, number>();
  readonly tokens = new Map<string, TokenRecord>();

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  prepare(query: string) {
    let values: unknown[] = [];
    const normalized = query.replace(/\s+/g, " ").trim();
    const receiptKey = (ownerId: unknown, key: unknown) => `${ownerId}:${key}`;
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      first: async <T>() => {
        if (normalized.startsWith("SELECT id, owner_id, token_hash")) {
          return (this.tokens.get(String(values[0])) ?? null) as T | null;
        }
        if (normalized.startsWith("SELECT max_tokens")) {
          const max_tokens = this.quotas.get(String(values[0]));
          return (max_tokens === undefined ? null : { max_tokens }) as T | null;
        }
        if (normalized.startsWith("SELECT COUNT(*)")) {
          const now = Date.now();
          const count = [...this.tokens.values()].filter((token) => token.owner_id === values[0]
            && token.revoked_at === null
            && (token.expires_at === null || Date.parse(token.expires_at) > now)).length;
          return { count } as T;
        }
        if (normalized.startsWith("SELECT request_hash")) {
          return (this.idempotency.get(receiptKey(values[0], values[1])) ?? null) as T | null;
        }
        throw new Error(`Unhandled first query: ${normalized}`);
      },
      all: async <T>() => {
        if (normalized.startsWith("SELECT id, label, scopes_json")) {
          return { results: [...this.tokens.values()].filter((token) => token.owner_id === values[0]) as T[] };
        }
        throw new Error(`Unhandled all query: ${normalized}`);
      },
      run: async () => {
        if (normalized.startsWith("INSERT OR IGNORE INTO owners")) {
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("INSERT OR IGNORE INTO owner_quotas")) {
          if (!this.quotas.has(String(values[0]))) this.quotas.set(String(values[0]), 10);
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("INSERT INTO idempotency_keys")) {
          const key = receiptKey(values[1], values[2]);
          if (this.idempotency.has(key)) throw new Error("UNIQUE constraint failed");
          this.idempotency.set(key, { request_hash: String(values[3]), response_status: null, response_body: null });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("UPDATE idempotency_keys SET")) {
          const entry = this.idempotency.get(receiptKey(values[2], values[3]));
          if (entry) {
            entry.response_status = Number(values[0]);
            entry.response_body = String(values[1]);
          }
          return { meta: { changes: entry ? 1 : 0 } };
        }
        if (normalized.startsWith("INSERT INTO api_tokens")) {
          this.tokens.set(String(values[0]), {
            id: String(values[0]), owner_id: String(values[1]), token_hash: String(values[2]), label: String(values[3]),
            scopes_json: String(values[4]), expires_at: values[5] === null ? null : String(values[5]),
            revoked_at: null, last_used_at: null, created_at: "2026-09-15T00:00:00.000Z",
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("UPDATE api_tokens SET last_used_at")) {
          const token = this.tokens.get(String(values[0]));
          if (token) token.last_used_at = "2026-09-15T00:01:00.000Z";
          return { meta: { changes: token ? 1 : 0 } };
        }
        if (normalized.startsWith("UPDATE api_tokens SET revoked_at")) {
          const token = this.tokens.get(String(values[0]));
          if (!token || token.owner_id !== values[1]) return { meta: { changes: 0 } };
          token.revoked_at ??= "2026-09-15T00:01:00.000Z";
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("INSERT INTO audit_events")) {
          this.audits.push({ metadata_json: String(values[6]) });
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unhandled run query: ${normalized}`);
      },
    };
    return statement;
  }
}

function buildEnv(db: MemoryDb) {
  const sequences = new Map<string, number>();
  return {
    ADMIN_TOKEN: "bootstrap-secret",
    ENVIRONMENT: "test",
    TOKEN_HASH_KEY: "digest-key",
    DB: db,
    PUBLICATION_OWNER: {
      idFromName: (ownerId: string) => ownerId,
      get: (ownerId: string) => ({
        fetch: async (input: Request) => {
          if (new URL(input.url).pathname === "/control") {
            const packet = await input.json<{
              fingerprint: string;
              idempotencyKey: string;
              mutation: { kind: string; id?: string; tokenId?: string; label?: string; scopes?: string[]; tokenHash?: string; expiresAt?: string | null };
            }>();
            const receiptKey = `${ownerId}:${packet.idempotencyKey}`;
            const receipt = db.idempotency.get(receiptKey);
            if (receipt) {
              if (receipt.request_hash !== packet.fingerprint) return Response.json({ status: 409, body: { error: "idempotency_key_conflict" } });
              return Response.json({ status: receipt.response_status, body: JSON.parse(receipt.response_body!) });
            }
            if (packet.mutation.kind === "create-token") {
              const active = [...db.tokens.values()].filter((token) => token.owner_id === ownerId && token.revoked_at === null).length;
              if (active >= (db.quotas.get(ownerId) ?? 10)) {
                db.idempotency.set(receiptKey, { request_hash: packet.fingerprint, response_status: 429, response_body: JSON.stringify({ error: "token_quota_exceeded" }) });
                return Response.json({ status: 429, body: { error: "token_quota_exceeded" } });
              }
              db.tokens.set(packet.mutation.id!, {
                id: packet.mutation.id!, owner_id: ownerId, token_hash: packet.mutation.tokenHash!, label: packet.mutation.label!,
                scopes_json: JSON.stringify(packet.mutation.scopes), expires_at: packet.mutation.expiresAt ?? null,
                revoked_at: null, last_used_at: null, created_at: "2026-09-15T00:00:00.000Z",
              });
              const body = { id: packet.mutation.id, label: packet.mutation.label, scopes: packet.mutation.scopes, expiresAt: packet.mutation.expiresAt ?? null };
              db.idempotency.set(receiptKey, { request_hash: packet.fingerprint, response_status: 201, response_body: JSON.stringify(body) });
              return Response.json({ status: 201, body });
            }
            if (packet.mutation.kind === "revoke-token") {
              const token = db.tokens.get(packet.mutation.tokenId!);
              const body = token && token.owner_id === ownerId && token.revoked_at === null
                ? { id: packet.mutation.tokenId, revoked: true }
                : { error: "token_not_found" };
              if (token && "revoked" in body) token.revoked_at = "2026-09-15T00:01:00.000Z";
              const status = "revoked" in body ? 200 : 404;
              db.idempotency.set(receiptKey, { request_hash: packet.fingerprint, response_status: status, response_body: JSON.stringify(body) });
              return Response.json({ status, body });
            }
            const sequence = (sequences.get(ownerId) ?? 0) + 1;
            sequences.set(ownerId, sequence);
            const body = { ownerId, sequence };
            db.idempotency.set(receiptKey, { request_hash: packet.fingerprint, response_status: 200, response_body: JSON.stringify(body) });
            return Response.json({ status: 200, body });
          }
          if (new URL(input.url).pathname === "/token") {
            const payload = await input.json<{ expiresAt: string | null; id: string; label: string; scopes: string[]; tokenHash: string }>();
            const active = [...db.tokens.values()].filter((token) => token.owner_id === ownerId && token.revoked_at === null).length;
            if (active >= (db.quotas.get(ownerId) ?? 10)) {
              return Response.json({ error: "token_quota_exceeded" }, { status: 429 });
            }
            db.tokens.set(payload.id, {
              id: payload.id,
              owner_id: ownerId,
              token_hash: payload.tokenHash,
              label: payload.label,
              scopes_json: JSON.stringify(payload.scopes),
              expires_at: payload.expiresAt,
              revoked_at: null,
              last_used_at: null,
              created_at: "2026-09-15T00:00:00.000Z",
            });
            return Response.json({ id: payload.id });
          }
          const sequence = (sequences.get(ownerId) ?? 0) + 1;
          sequences.set(ownerId, sequence);
          return Response.json({ ownerId, sequence });
        },
      }),
    },
  } as unknown as Env;
}

function request(path: string, token: string, options: RequestInit = {}) {
  return new Request(`https://pagecast.test${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
}

const fetch = (request: Request, env: Env, context: ExecutionContext): Promise<Response> => (
  (worker.fetch! as never as (input: Request, bindings: Env, execution: ExecutionContext) => Promise<Response>)(request, env, context)
);

describe("control-plane token and mutation matrix", () => {
  it("stores only a keyed digest and enforces token scope, owner, expiry, and revocation", async () => {
    const db = new MemoryDb();
    const env = buildEnv(db);
    const create = await fetch(request("/v1/owners/owner-a/tokens", "bootstrap-secret", {
      method: "POST",
      headers: { "Idempotency-Key": "issue-token" },
      body: JSON.stringify({ label: "publisher", scopes: ["status:read", "tokens:read"] }),
    }), env, {} as ExecutionContext);
    const issued = await create.json<{ id: string; token: string }>();
    const stored = db.tokens.get(issued.id)!;

    expect(create.status).toBe(201);
    expect(stored.token_hash).not.toContain(issued.token);
    expect(JSON.stringify([...db.idempotency.values()])).not.toContain(issued.token);
    expect((await fetch(request("/v1/status", issued.token), env, {} as ExecutionContext)).status).toBe(200);
    expect((await fetch(request("/v1/owners/owner-b/tokens", issued.token), env, {} as ExecutionContext)).status).toBe(403);
    expect((await fetch(request("/v1/owners/owner-a/tokens", issued.token, {
      method: "POST", headers: { "Idempotency-Key": "not-allowed" }, body: JSON.stringify({ label: "nope", scopes: ["status:read"] }),
    }), env, {} as ExecutionContext)).status).toBe(403);

    stored.expires_at = "2000-01-01T00:00:00.000Z";
    expect((await fetch(request("/v1/status", issued.token), env, {} as ExecutionContext)).status).toBe(401);
    stored.expires_at = null;
    const revoke = await fetch(request(`/v1/owners/owner-a/tokens/${issued.id}`, "bootstrap-secret", {
      method: "DELETE", headers: { "Idempotency-Key": "revoke-token" },
    }), env, {} as ExecutionContext);
    expect(revoke.status).toBe(200);
    expect((await fetch(request("/v1/status", issued.token), env, {} as ExecutionContext)).status).toBe(401);
    expect(db.audits.map((entry) => entry.metadata_json).join("\n")).not.toContain(issued.token);
  });

  it("enforces a per-owner token quota and does not reflect hostile origins", async () => {
    const db = new MemoryDb();
    db.quotas.set("owner-a", 1);
    const env = buildEnv(db);
    const body = JSON.stringify({ label: "first", scopes: ["status:read"] });
    const first = await fetch(request("/v1/owners/owner-a/tokens", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "first-token" }, body,
    }), env, {} as ExecutionContext);
    const second = await fetch(request("/v1/owners/owner-a/tokens", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "second-token" }, body,
    }), env, {} as ExecutionContext);
    const hostile = await fetch(request("/v1/owners/owner-a/tokens", "bootstrap-secret", {
      method: "POST", headers: { Origin: "https://attacker.example", "Idempotency-Key": "hostile" }, body,
    }), env, {} as ExecutionContext);

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not let a personal token mint a broader scope or wildcard credential", async () => {
    const db = new MemoryDb();
    const env = buildEnv(db);
    const issuer = await fetch(request("/v1/owners/owner-a/tokens", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "limited-issuer" },
      body: JSON.stringify({ label: "limited", scopes: ["tokens:write"] }),
    }), env, {} as ExecutionContext);
    const { token } = await issuer.json<{ token: string }>();
    const escalation = await fetch(request("/v1/owners/owner-a/tokens", token, {
      method: "POST", headers: { "Idempotency-Key": "scope-escalation" },
      body: JSON.stringify({ label: "escalated", scopes: ["tokens:write", "mutations:write"] }),
    }), env, {} as ExecutionContext);
    const wildcard = await fetch(request("/v1/owners/owner-a/tokens", token, {
      method: "POST", headers: { "Idempotency-Key": "wildcard-escalation" },
      body: JSON.stringify({ label: "wildcard", scopes: ["*"] }),
    }), env, {} as ExecutionContext);

    expect(escalation.status).toBe(403);
    expect(wildcard.status).toBe(403);
  });

  it("rejects unrecognized token-create fields before they can change an idempotent request", async () => {
    const db = new MemoryDb();
    const env = buildEnv(db);
    const response = await fetch(request("/v1/owners/owner-a/tokens", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "unknown-field" },
      body: JSON.stringify({ label: "publisher", scopes: ["status:read"], accidental: true }),
    }), env, {} as ExecutionContext);

    expect(response.status).toBe(400);
    expect(db.tokens.size).toBe(0);
  });

  it("replays exact mutation receipts, rejects changed fingerprints, and serializes each owner independently", async () => {
    const db = new MemoryDb();
    const env = buildEnv(db);
    const first = await fetch(request("/v1/owners/owner-a/coordinator", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "same-operation" }, body: '{"value":1}',
    }), env, {} as ExecutionContext);
    const replay = await fetch(request("/v1/owners/owner-a/coordinator", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "same-operation" }, body: '{"value":1}',
    }), env, {} as ExecutionContext);
    const conflict = await fetch(request("/v1/owners/owner-a/coordinator", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "same-operation" }, body: '{"value":2}',
    }), env, {} as ExecutionContext);
    const next = await fetch(request("/v1/owners/owner-a/coordinator", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "next-operation" }, body: '{"value":3}',
    }), env, {} as ExecutionContext);

    expect(await first.json()).toEqual({ ownerId: "owner-a", sequence: 1 });
    expect(await replay.json()).toEqual({ ownerId: "owner-a", sequence: 1 });
    expect(conflict.status).toBe(409);
    expect(await next.json()).toEqual({ ownerId: "owner-a", sequence: 2 });
  });

  it("leaves a failed owner operation retryable without a partial receipt", async () => {
    const db = new MemoryDb();
    const env = buildEnv(db);
    env.PUBLICATION_OWNER = {
      idFromName: (ownerId: string) => ownerId,
      get: () => ({ fetch: async () => { throw new Error("coordinator outage"); } }),
    } as unknown as DurableObjectNamespace;
    const input = () => request("/v1/owners/owner-a/coordinator", "bootstrap-secret", {
      method: "POST", headers: { "Idempotency-Key": "recoverable-failure" }, body: '{"value":1}',
    });

    await expect(fetch(input(), env, {} as ExecutionContext)).rejects.toThrow("coordinator outage");
    const recovered = buildEnv(db);
    expect((await fetch(input(), recovered, {} as ExecutionContext)).status).toBe(200);
  });
});
