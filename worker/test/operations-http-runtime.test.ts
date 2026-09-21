import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import worker from "../src/index";

const testEnv = { ...env, ADMIN_TOKEN: "operations-bootstrap", WEBHOOK_SIGNING_KEY: "operations-webhook-key", JOBS: { send: async () => undefined } } as unknown as Env;
const fetchWorker = worker.fetch! as unknown as (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

function request(ownerId: string, path: string, idempotencyKey: string, body: Record<string, unknown>, method = "POST") {
  return new Request(`https://pagecast.test/v1/owners/${ownerId}/${path}`, {
    method,
    headers: { Authorization: "Bearer operations-bootstrap", "Idempotency-Key": idempotencyKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("owner-coordinated job and webhook operations", () => {
  beforeAll(async () => {
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS idempotency_keys (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_status INTEGER, response_body TEXT, expires_at TEXT NOT NULL, UNIQUE(owner_id, idempotency_key));
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, metadata_json TEXT NOT NULL, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, destination TEXT NOT NULL, event_types_json TEXT NOT NULL, secret_version INTEGER NOT NULL, disabled_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT, version_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, progress INTEGER NOT NULL DEFAULT 0, error_code TEXT, cancelled_at TEXT, artifact_key TEXT, lease_expires_at TEXT, enqueue_lease_token TEXT, enqueue_lease_expires_at TEXT, last_enqueued_at TEXT, retention_until TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, UNIQUE(owner_id, dedupe_key));
    `);
  });
  it("replays a webhook credential without persisting it and rejects same-key body conflicts", async () => {
    const ownerId = `operations-owner-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO owners (id) VALUES (?)").bind(ownerId).run();
    const key = `webhook-${crypto.randomUUID()}`;
    const first = await fetchWorker(request(ownerId, "webhooks", key, { destination: "https://hooks.example.test/pagecast", eventTypes: ["publication.published"] }), testEnv, {} as ExecutionContext);
    expect(first.status).toBe(201);
    const created = await first.json() as { id: string; secret: string; secretVersion: number };
    expect(created.secret).toMatch(/^pcwh_/);
    const replay = await fetchWorker(request(ownerId, "webhooks", key, { destination: "https://hooks.example.test/pagecast", eventTypes: ["publication.published"] }), testEnv, {} as ExecutionContext);
    expect(await replay.json()).toMatchObject({ id: created.id, secret: created.secret, secretVersion: 1 });
    expect((await env.DB.prepare("SELECT response_body FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?").bind(ownerId, key).first<{ response_body: string }>())?.response_body).not.toContain(created.secret);
    const conflict = await fetchWorker(request(ownerId, "webhooks", key, { destination: "https://hooks.example.test/other", eventTypes: ["publication.published"] }), testEnv, {} as ExecutionContext);
    expect(conflict.status).toBe(409);
  });

  it("preserves a disabled webhook when a PATCH changes only its destination", async () => {
    const ownerId = `operations-owner-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO owners (id) VALUES (?)").bind(ownerId).run();
    const created = await fetchWorker(request(ownerId, "webhooks", `create-${crypto.randomUUID()}`, { destination: "https://hooks.example.test/pagecast", eventTypes: ["publication.published"] }), testEnv, {} as ExecutionContext);
    const webhook = await created.json() as { id: string };
    await env.DB.prepare("UPDATE webhook_subscriptions SET disabled_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(webhook.id, ownerId).run();

    const updated = await fetchWorker(request(ownerId, `webhooks/${webhook.id}`, `update-${crypto.randomUUID()}`, { destination: "https://hooks.example.test/updated" }, "PATCH"), testEnv, {} as ExecutionContext);

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: webhook.id, disabled: true });
    expect(await env.DB.prepare("SELECT destination, disabled_at FROM webhook_subscriptions WHERE id = ? AND owner_id = ?").bind(webhook.id, ownerId).first<{ destination: string; disabled_at: string | null }>()).toMatchObject({ destination: "https://hooks.example.test/updated", disabled_at: expect.any(String) });
  });

  it("serializes job creation through the owner receipt and returns the original job on replay", async () => {
    const ownerId = `operations-owner-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO owners (id) VALUES (?)").bind(ownerId).run();
    const key = `job-${crypto.randomUUID()}`;
    const body = { kind: "link_check", dedupeKey: `job-dedupe-${crypto.randomUUID()}`, payload: { targetPath: "/p/example/" } };
    const first = await fetchWorker(request(ownerId, "jobs", key, body), testEnv, {} as ExecutionContext);
    expect(first.status).toBe(201);
    const created = await first.json() as { id: string; status: string };
    const replay = await fetchWorker(request(ownerId, "jobs", key, body), testEnv, {} as ExecutionContext);
    expect(await replay.json()).toMatchObject({ id: created.id, status: "queued" });
    const conflict = await fetchWorker(request(ownerId, "jobs", key, { ...body, dedupeKey: `other-${crypto.randomUUID()}` }), testEnv, {} as ExecutionContext);
    expect(conflict.status).toBe(409);
  });

  it("reserves webhook queue messages for internal delivery work", async () => {
    const ownerId = `operations-owner-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO owners (id) VALUES (?)").bind(ownerId).run();
    const response = await fetchWorker(request(ownerId, "jobs", `webhook-${crypto.randomUUID()}`, { kind: "webhook", dedupeKey: `webhook-${crypto.randomUUID()}` }), testEnv, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_job" });
  });
});
