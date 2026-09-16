import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deliverWebhook,
  enqueueJobRecord,
  getJob,
  listJobs,
  processJobMessage,
  repairOutbox,
  scheduledJobs,
  signWebhookPayload,
  validateJobInput,
  validateWebhookDestination,
  webhookSecret,
} from "../src/jobs";
import type { Env } from "../src/types";
import type { JobBody, WebhookBody } from "../src/jobs";

const ownerId = "jobs-owner";
const publicationId = "jobs-publication";
const workerEnv = { ...env, WEBHOOK_SIGNING_KEY: "webhook-signing-key", JOBS: { send: async () => undefined } } as unknown as Env;

async function insertWebhook(env: Env, ownerId: string, eventTypes = ["publication.published"]): Promise<WebhookBody> {
  const id = crypto.randomUUID();
  const destination = "https://hooks.example.test/pagecast";
  await env.DB.prepare("INSERT INTO webhook_subscriptions (id, owner_id, destination, event_types_json, secret_version) VALUES (?, ?, ?, ?, 1)").bind(id, ownerId, destination, JSON.stringify(eventTypes)).run();
  return { id, destination, eventTypes, secretVersion: 1, secret: `pcwh_${id}.${await webhookSecret(env, id, 1)}` };
}

async function insertJob(env: Env, ownerId: string, input: { kind: JobBody["kind"]; publicationId?: string; versionId?: string; dedupeKey: string; payload?: Record<string, unknown> }): Promise<{ status: number; body: JobBody }> {
  if (!validateJobInput(input)) return { status: 400, body: { id: "", kind: input.kind, publicationId: null, versionId: null, status: "invalid", dedupeKey: input.dedupeKey, hasArtifact: false } };
  const existing = await env.DB.prepare("SELECT id, kind, publication_id, version_id, status, dedupe_key, artifact_key, error_code FROM jobs WHERE owner_id = ? AND dedupe_key = ?").bind(ownerId, input.dedupeKey).first<Record<string, unknown>>();
  if (existing) return { status: 200, body: { id: String(existing.id), kind: existing.kind as JobBody["kind"], publicationId: existing.publication_id as string | null, versionId: existing.version_id as string | null, status: String(existing.status), dedupeKey: String(existing.dedupe_key), hasArtifact: typeof existing.artifact_key === "string" } };
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, owner_id, publication_id, version_id, kind, payload_json, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, ownerId, input.publicationId ?? null, input.versionId ?? null, input.kind, JSON.stringify(input.payload ?? {}), input.dedupeKey).run();
  return { status: 201, body: { id, kind: input.kind, publicationId: input.publicationId ?? null, versionId: input.versionId ?? null, status: "queued", dedupeKey: input.dedupeKey, hasArtifact: false } };
}

beforeEach(async () => {
  await env.DB.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS job_artifacts;
    DROP TABLE IF EXISTS job_dead_letters;
    DROP TABLE IF EXISTS job_attempts;
    DROP TABLE IF EXISTS jobs;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS outbox_events;
    DROP TABLE IF EXISTS webhook_subscriptions;
    DROP TABLE IF EXISTS publication_versions;
    DROP TABLE IF EXISTS version_files;
    DROP TABLE IF EXISTS publications;
    DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;
    CREATE TABLE owners (id TEXT PRIMARY KEY);
    CREATE TABLE publications (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, slug TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'published', active_version_id TEXT, expires_at TEXT, deleted_at TEXT, UNIQUE(owner_id, id));
    CREATE TABLE publication_versions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT NOT NULL, manifest_key TEXT, deleted_at TEXT, retention_until TEXT, storage_purged_at TEXT, UNIQUE(owner_id, id));
    CREATE TABLE version_files (version_id TEXT NOT NULL, normalized_path TEXT NOT NULL, r2_key TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, content_type TEXT NOT NULL, PRIMARY KEY(version_id, normalized_path));
    CREATE TABLE webhook_subscriptions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, destination TEXT NOT NULL, event_types_json TEXT NOT NULL, secret_version INTEGER NOT NULL, disabled_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id, id));
    CREATE TABLE outbox_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processing_started_at TEXT, enqueue_lease_token TEXT, enqueue_lease_expires_at TEXT, last_enqueued_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT, retention_until TEXT, UNIQUE(owner_id, dedupe_key));
    CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, subscription_id TEXT NOT NULL, outbox_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', response_status INTEGER, error_code TEXT, attempted_at TEXT, next_attempt_at TEXT, sending_lease_expires_at TEXT, enqueue_lease_token TEXT, enqueue_lease_expires_at TEXT, last_enqueued_at TEXT, delivered_at TEXT, dead_lettered_at TEXT, retention_until TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(subscription_id, outbox_id));
    CREATE TABLE jobs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, publication_id TEXT, version_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, progress INTEGER NOT NULL DEFAULT 0, error_code TEXT, cancelled_at TEXT, artifact_key TEXT, lease_expires_at TEXT, enqueue_lease_token TEXT, enqueue_lease_expires_at TEXT, last_enqueued_at TEXT, retention_until TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, UNIQUE(owner_id, dedupe_key));
    CREATE TABLE job_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, retention_until TEXT, UNIQUE(job_id, attempt));
    CREATE TABLE job_dead_letters (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, job_id TEXT NOT NULL, message_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, retention_until TEXT, UNIQUE(job_id));
    CREATE TABLE job_artifacts (job_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, r2_key TEXT NOT NULL, content_type TEXT NOT NULL, byte_size INTEGER, retention_until TEXT);
  `);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id) VALUES (?)").bind(ownerId),
    env.DB.prepare("INSERT INTO publications (id, owner_id, slug, active_version_id) VALUES (?, ?, ?, ?)").bind(publicationId, ownerId, "jobs-publication", "jobs-version"),
    env.DB.prepare("INSERT INTO publication_versions (id, owner_id, publication_id) VALUES (?, ?, ?)").bind("jobs-version", ownerId, publicationId),
    env.DB.prepare("INSERT INTO version_files (version_id, normalized_path, r2_key, byte_size, sha256, content_type) VALUES (?, 'index.html', 'jobs/index.html', 55, ?, 'text/html')").bind("jobs-version", "a".repeat(64)),
  ]);
  await env.PUBLICATIONS.put("jobs/index.html", '<a href="assets/app.js"></a><a href="https://external.example"></a><h1>Hello</h1>', { httpMetadata: { contentType: "text/html" } });
  await env.DB.prepare("UPDATE version_files SET byte_size = ? WHERE version_id = ? AND normalized_path = 'index.html'").bind(78, "jobs-version").run();
});

describe("jobs and signed webhooks", () => {
  it("refuses SSRF-shaped endpoints and redirect responses", async () => {
    for (const destination of ["http://example.com/hook", "https://127.0.0.1/hook", "https://[::1]/hook", "https://user@example.com/hook", "https://localhost/hook"]) {
      expect(validateWebhookDestination(destination)).toBeNull();
    }
    const webhook = await insertWebhook(workerEnv, ownerId);
    const delivery = await deliverWebhook(workerEnv, ownerId, webhook.id, "outbox-redirect", { version: "v1", id: "outbox-redirect", type: "publication.published", createdAt: "2026-09-15T00:00:00.000Z", data: {} }, async () => new Response(null, { status: 302 }));
    expect(delivery.status).toBe("dead_lettered");
  });

  it("returns a derived secret only at creation and uses a stable versioned signature fixture", async () => {
    const webhook = await insertWebhook(workerEnv, ownerId);
    expect(webhook.secret).toMatch(/^pcwh_/);
    const signature = await signWebhookPayload(workerEnv, "webhook-fixture", 1, "1700000000", '{"version":"v1"}');
    expect(signature).toBe("v1,t=1700000000,sha256=569d3774dc094ee0a19fe316cb86aa3aaea27680b099992ef968dce5d8fd13b2");
  });

  it("deduplicates queue messages, records terminal provider failure, and retains a D1 dead letter", async () => {
    const created = await insertJob(workerEnv, ownerId, { kind: "screenshot", publicationId, versionId: "jobs-version", dedupeKey: "render-jobs-version" });
    const createdBody = created.body as JobBody;
    await processJobMessage(workerEnv, { id: createdBody.id, kind: "screenshot", ownerId, payload: { jobId: createdBody.id } });
    await processJobMessage(workerEnv, { id: createdBody.id, kind: "screenshot", ownerId, payload: { jobId: createdBody.id } });
    const job = await env.DB.prepare("SELECT status, attempt_count, error_code FROM jobs WHERE id = ?").bind(createdBody.id).first<{ status: string; attempt_count: number; error_code: string }>();
    expect(job).toEqual({ status: "failed", attempt_count: 1, error_code: "unsupported_provider" });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE owner_id = ? AND dedupe_key = ?").bind(ownerId, "render-jobs-version").first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });

  it("reports artifact availability without exposing the R2 object key", async () => {
    const created = await insertJob(workerEnv, ownerId, { kind: "link_check", publicationId, versionId: "jobs-version", dedupeKey: "job-body-artifact" });
    const key = `owners/${ownerId}/jobs/${created.body.id}/private-artifact.json`;
    await env.DB.prepare("UPDATE jobs SET artifact_key = ? WHERE id = ? AND owner_id = ?").bind(key, created.body.id, ownerId).run();

    const job = await (await getJob(workerEnv, ownerId, created.body.id)).json() as Record<string, unknown>;
    const listed = await (await listJobs(workerEnv, ownerId)).json() as { jobs: Array<Record<string, unknown>> };

    expect(job).toMatchObject({ id: created.body.id, hasArtifact: true });
    expect(job).not.toHaveProperty("artifactKey");
    expect(JSON.stringify(job)).not.toContain(key);
    expect(listed.jobs[0]).toMatchObject({ id: created.body.id, hasArtifact: true });
    expect(JSON.stringify(listed.jobs[0])).not.toContain(key);
  });

  it("records a stable inspection error when the selected version was deleted", async () => {
    const created = await insertJob(workerEnv, ownerId, { kind: "link_check", publicationId, versionId: "jobs-version", dedupeKey: "deleted-inspection" });
    await env.DB.prepare("UPDATE publication_versions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind("jobs-version", ownerId).run();

    await processJobMessage(workerEnv, { id: created.body.id, kind: "link_check", ownerId, payload: { jobId: created.body.id } });

    expect(await env.DB.prepare("SELECT status, error_code, attempt_count FROM jobs WHERE id = ? AND owner_id = ?").bind(created.body.id, ownerId).first<{ status: string; error_code: string; attempt_count: number }>()).toEqual({ status: "failed", error_code: "inspection_version_not_found", attempt_count: 1 });
  });

  it("uses an injected provider only with a Pagecast-relative target and stores render or audit artifacts", async () => {
    const calls: string[] = [];
    const browserEnv = {
      ...workerEnv,
      PUBLIC_ORIGIN: "https://pagecast.example",
      BROWSER: {
        async quickAction(action: "screenshot" | "pdf" | "accessibilityTree", options: { url: string }) {
          calls.push(`${action}:${options.url}`);
          return action === "pdf"
            ? new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } })
            : action === "accessibilityTree"
              ? new Response(JSON.stringify({ violations: [] }), { headers: { "content-type": "application/json" } })
              : new Response("png", { headers: { "content-type": "image/png" } });
        },
      },
    } as Env;
    for (const kind of ["screenshot", "pdf", "accessibility_check"] as const) {
      const created = await insertJob(browserEnv, ownerId, { kind, publicationId, versionId: "jobs-version", dedupeKey: `provider-${kind}`, payload: { targetPath: "/p/jobs-publication/index.html" } });
      const body = created.body as JobBody;
      await processJobMessage(browserEnv, { id: body.id, kind, ownerId, payload: { jobId: body.id } });
      expect(await env.DB.prepare("SELECT status, artifact_key FROM jobs WHERE id = ?").bind(body.id).first<{ status: string; artifact_key: string }>()).toMatchObject({ status: "completed", artifact_key: expect.stringContaining(`/jobs/${body.id}/`) });
    }
    expect(calls).toEqual(["screenshot:https://pagecast.example/p/jobs-publication/index.html", "pdf:https://pagecast.example/p/jobs-publication/index.html", "accessibilityTree:https://pagecast.example/p/jobs-publication/index.html"]);
    for (const kind of ["link_check", "index"] as const) {
      const created = await insertJob(workerEnv, ownerId, { kind, publicationId, versionId: "jobs-version", dedupeKey: `local-${kind}`, payload: { targetPath: "/p/jobs-publication/index.html" } });
      const body = created.body as JobBody;
      await processJobMessage(workerEnv, { id: body.id, kind, ownerId, payload: { jobId: body.id } });
      expect(await env.DB.prepare("SELECT status, artifact_key FROM jobs WHERE id = ?").bind(body.id).first<{ status: string; artifact_key: string }>()).toMatchObject({ status: "completed", artifact_key: expect.stringContaining(`/jobs/${body.id}/`) });
    }
    expect((await insertJob(browserEnv, ownerId, { kind: "link_check", publicationId, dedupeKey: "external-link", payload: { url: "https://attacker.example" } })).status).toBe(400);
  });

  it("supports cancellation, retry exhaustion, and retryable webhook delivery history", async () => {
    const created = await insertJob(workerEnv, ownerId, { kind: "link_check", publicationId, versionId: "jobs-version", dedupeKey: "cancelled-link-check" });
    const createdBody = created.body as JobBody;
    expect((await env.DB.prepare("UPDATE jobs SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(createdBody.id, ownerId).run()).meta.changes).toBe(1);
    await processJobMessage(workerEnv, { id: createdBody.id, kind: "link_check", ownerId, payload: { jobId: createdBody.id } });
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(createdBody.id).first<{ status: string }>()).toEqual({ status: "cancelled" });
    const webhook = await insertWebhook(workerEnv, ownerId);
    await deliverWebhook(workerEnv, ownerId, webhook.id, "outbox-retry", { version: "v1", id: "outbox-retry", type: "publication.published", createdAt: "2026-09-15T00:00:00.000Z", data: {} }, async () => new Response(null, { status: 500 }));
    const delivery = await env.DB.prepare("SELECT id, status FROM webhook_deliveries WHERE outbox_id = ?").bind("outbox-retry").first<{ id: string; status: string }>();
    expect(delivery?.status).toBe("retrying");
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP, dead_lettered_at = NULL WHERE id = ? AND owner_id = ?").bind(delivery!.id, ownerId).run();
    expect(await env.DB.prepare("SELECT status FROM webhook_deliveries WHERE id = ?").bind(delivery!.id).first<{ status: string }>()).toEqual({ status: "pending" });
    await deliverWebhook(workerEnv, ownerId, webhook.id, "outbox-retry", { version: "v1", id: "outbox-retry", type: "publication.published", createdAt: "2026-09-15T00:00:00.000Z", data: {} }, async () => new Response(null, { status: 500 }));
    await deliverWebhook(workerEnv, ownerId, webhook.id, "outbox-retry", { version: "v1", id: "outbox-retry", type: "publication.published", createdAt: "2026-09-15T00:00:00.000Z", data: {} }, async () => new Response(null, { status: 500 }));
    expect(await env.DB.prepare("SELECT status, error_code FROM webhook_deliveries WHERE id = ?").bind(delivery!.id).first<{ status: string; error_code: string }>()).toEqual({ status: "dead_lettered", error_code: "http_500" });
  });

  it("repairs failed enqueue, stale job leases, and stale webhook send leases without stranding work", async () => {
    const unavailable = { ...workerEnv, JOBS: { send: async () => { throw new Error("queue down"); } } } as unknown as Env;
    const created = await insertJob(unavailable, ownerId, { kind: "link_check", publicationId, versionId: "jobs-version", dedupeKey: "recover-enqueue", payload: { targetPath: "/p/jobs-publication/index.html" } });
    const createdBody = created.body as JobBody;
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(createdBody.id).first<{ status: string }>()).toEqual({ status: "queued" });
    await scheduledJobs(unavailable);
    expect(await env.DB.prepare("SELECT enqueue_lease_expires_at, last_enqueued_at FROM jobs WHERE id = ?").bind(createdBody.id).first<{ enqueue_lease_expires_at: string | null; last_enqueued_at: string | null }>()).toEqual({ enqueue_lease_expires_at: null, last_enqueued_at: null });
    const sent: string[] = [];
    const recovered = { ...workerEnv, JOBS: { send: async (message: { id: string }) => { sent.push(message.id); } } } as unknown as Env;
    await scheduledJobs(recovered);
    expect(sent).toContain(createdBody.id);
    await scheduledJobs(recovered);
    expect(sent.filter((id) => id === createdBody.id)).toHaveLength(1);
    await env.DB.prepare("UPDATE jobs SET status = 'running', attempt_count = 1, lease_expires_at = datetime('now', '-1 second') WHERE id = ?").bind(createdBody.id).run();
    sent.length = 0;
    await scheduledJobs(recovered);
    expect(await env.DB.prepare("SELECT status, error_code FROM jobs WHERE id = ?").bind(createdBody.id).first<{ status: string; error_code: string }>()).toEqual({ status: "retrying", error_code: "lease_expired" });
    expect(sent).toContain(createdBody.id);

    const webhook = await insertWebhook(recovered, ownerId);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO outbox_events (id, owner_id, event_type, payload_json, dedupe_key, status) VALUES ('lease-outbox', ?, 'publication.published', ?, 'lease-outbox', 'sent')").bind(ownerId, JSON.stringify({ version: "v1", id: "lease-outbox", type: "publication.published", createdAt: "2026-09-15T00:00:00.000Z", data: {} })),
      env.DB.prepare("INSERT INTO webhook_deliveries (id, owner_id, subscription_id, outbox_id, status, sending_lease_expires_at) VALUES ('lease-delivery', ?, ?, 'lease-outbox', 'sending', datetime('now', '-1 second'))").bind(ownerId, webhook.id),
    ]);
    sent.length = 0;
    await repairOutbox(recovered);
    expect(await env.DB.prepare("SELECT status, error_code FROM webhook_deliveries WHERE id = 'lease-delivery'").first<{ status: string; error_code: string }>()).toEqual({ status: "retrying", error_code: "sending_lease_expired" });
    expect(sent).toContain("lease-delivery");

    const exhaustedWebhook = await insertWebhook(recovered, ownerId);
    await env.DB.prepare("INSERT INTO webhook_deliveries (id, owner_id, subscription_id, outbox_id, status, attempt, sending_lease_expires_at) VALUES ('exhausted-delivery', ?, ?, 'lease-outbox', 'sending', 3, datetime('now', '-1 second'))").bind(ownerId, exhaustedWebhook.id).run();
    await repairOutbox(recovered);
    expect(await env.DB.prepare("SELECT status, error_code FROM webhook_deliveries WHERE id = 'exhausted-delivery'").first<{ status: string; error_code: string }>()).toEqual({ status: "dead_lettered", error_code: "sending_lease_expired" });
  });

  it("does not let an old queue claimant clear a newer lease", async () => {
    const created = await insertJob(workerEnv, ownerId, { kind: "link_check", publicationId, versionId: "jobs-version", dedupeKey: "lease-token" });
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const delayed = { ...workerEnv, JOBS: { send: async () => { begin(); await held; } } } as unknown as Env;
    const first = enqueueJobRecord(delayed, ownerId, created.body.id, "link_check");
    await started;
    const claimed = await env.DB.prepare("SELECT enqueue_lease_token FROM jobs WHERE id = ?").bind(created.body.id).first<{ enqueue_lease_token: string }>();
    expect(claimed?.enqueue_lease_token).toBeTruthy();
    await env.DB.prepare("UPDATE jobs SET enqueue_lease_token = 'newer-claim', enqueue_lease_expires_at = datetime('now', '+2 minutes') WHERE id = ?").bind(created.body.id).run();
    finish();
    await first;
    expect(await env.DB.prepare("SELECT enqueue_lease_token, last_enqueued_at FROM jobs WHERE id = ?").bind(created.body.id).first<{ enqueue_lease_token: string; last_enqueued_at: string | null }>()).toEqual({ enqueue_lease_token: "newer-claim", last_enqueued_at: null });
  });

  it("fans out at most one durable delivery per bounded subscription and never fetches inline", async () => {
    for (let index = 0; index < 101; index += 1) {
      await env.DB.prepare("INSERT INTO webhook_subscriptions (id, owner_id, destination, event_types_json, secret_version) VALUES (?, ?, ?, ?, 1)")
        .bind(`fanout-${index}`, ownerId, `https://hooks${index}.example.test/pagecast`, '["publication.published"]').run();
    }
    await env.DB.prepare("INSERT INTO outbox_events (id, owner_id, event_type, payload_json, dedupe_key) VALUES ('fanout-outbox', ?, 'publication.published', ?, 'fanout-outbox')")
      .bind(ownerId, JSON.stringify({ version: "v1", id: "fanout-outbox", type: "publication.published", createdAt: "2026-09-15T00:00:00.000Z", data: {} })).run();
    const sent: string[] = [];
    const queueEnv = { ...workerEnv, JOBS: { send: async (message: { id: string }) => { sent.push(message.id); } } } as unknown as Env;
    await processJobMessage(queueEnv, { id: "fanout-outbox", kind: "webhook", ownerId, payload: { outboxId: "fanout-outbox" } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE outbox_id = 'fanout-outbox'").first<{ count: number }>())?.count).toBe(100);
    expect(sent).toHaveLength(100);
    expect(await env.DB.prepare("SELECT status FROM outbox_events WHERE id = 'fanout-outbox'").first<{ status: string }>()).toEqual({ status: "sent" });
  });

  it("deletes retained R2 artifacts before terminal job metadata", async () => {
    const created = await insertJob(workerEnv, ownerId, { kind: "link_check", publicationId, versionId: "jobs-version", dedupeKey: "retained-artifact" });
    const key = `owners/${ownerId}/jobs/${created.body.id}/artifact.json`;
    await env.PUBLICATIONS.put(key, "artifact");
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET status = 'completed', artifact_key = ?, retention_until = datetime('now', '-1 second') WHERE id = ?").bind(key, created.body.id),
      env.DB.prepare("INSERT INTO job_artifacts (job_id, owner_id, r2_key, content_type, byte_size) VALUES (?, ?, ?, 'application/json', 8)").bind(created.body.id, ownerId, key),
    ]);
    await scheduledJobs(workerEnv);
    expect(await env.PUBLICATIONS.get(key)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(created.body.id).first()).toBeNull();
  });

  it("rejects oversized browser output from Content-Length before reading its body", async () => {
    const browserEnv = {
      ...workerEnv,
      PUBLIC_ORIGIN: "https://pagecast.example",
      BROWSER: { quickAction: async () => new Response("should-not-be-read", { headers: { "content-type": "image/png", "content-length": String(4 * 1024 * 1024 + 1) } }) },
    } as Env;
    const created = await insertJob(browserEnv, ownerId, { kind: "screenshot", publicationId, versionId: "jobs-version", dedupeKey: "oversized-provider" });
    await processJobMessage(browserEnv, { id: created.body.id, kind: "screenshot", ownerId, payload: { jobId: created.body.id } });
    expect(await env.DB.prepare("SELECT status, error_code, artifact_key FROM jobs WHERE id = ?").bind(created.body.id).first<{ status: string; error_code: string; artifact_key: string | null }>()).toEqual({ status: "failed", error_code: "artifact_too_large", artifact_key: null });
  });

  it("removes an artifact when its metadata transaction fails", async () => {
    const created = await insertJob(workerEnv, ownerId, { kind: "screenshot", publicationId, versionId: "jobs-version", dedupeKey: "artifact-rollback" });
    let failMetadata = true;
    const failingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (failMetadata) { failMetadata = false; throw new Error("metadata unavailable"); }
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const browserEnv = {
      ...workerEnv,
      DB: failingDb,
      PUBLIC_ORIGIN: "https://pagecast.example",
      BROWSER: { quickAction: async () => new Response("png", { headers: { "content-type": "image/png" } }) },
    } as Env;
    await processJobMessage(browserEnv, { id: created.body.id, kind: "screenshot", ownerId, payload: { jobId: created.body.id } });
    const key = `owners/${ownerId}/jobs/${created.body.id}/artifact.png`;
    expect(await env.PUBLICATIONS.get(key)).toBeNull();
  });

  it("inspects selected immutable files without external fetches and uses bounded HTTP retry policy", async () => {
    for (const kind of ["link_check", "index"] as const) {
      const created = await insertJob(workerEnv, ownerId, { kind, publicationId, versionId: "jobs-version", dedupeKey: `inspect-${kind}`, payload: { targetPath: "/p/jobs-publication/index.html" } });
      const body = created.body as JobBody;
      await processJobMessage(workerEnv, { id: body.id, kind, ownerId, payload: { jobId: body.id } });
      const artifact = await env.DB.prepare("SELECT r2_key FROM job_artifacts WHERE job_id = ?").bind(body.id).first<{ r2_key: string }>();
      expect(await (await env.PUBLICATIONS.get(artifact!.r2_key))!.text()).toContain(kind === "link_check" ? "externalSkipped" : "Hello");
    }
    const webhook = await insertWebhook(workerEnv, ownerId);
    const id = webhook.id;
    expect((await deliverWebhook(workerEnv, ownerId, id, "retry-429", { version: "v1", id: "retry-429", type: "publication.published", createdAt: "2026-09-15T00:00:00.000Z", data: {} }, async () => new Response(null, { status: 429 }))).status).toBe("retrying");
    expect((await deliverWebhook(workerEnv, ownerId, id, "terminal-400", { version: "v1", id: "terminal-400", type: "publication.published", createdAt: "2026-09-15T00:00:00.000Z", data: {} }, async () => new Response(null, { status: 400 }))).status).toBe("dead_lettered");
  });

  it("does not purge a retention candidate that became active again before cleanup runs", async () => {
    await env.DB.prepare("UPDATE publication_versions SET deleted_at = datetime('now', '-1 day'), retention_until = datetime('now', '-1 second'), storage_purged_at = NULL WHERE id = 'jobs-version'").run();
    await env.DB.prepare("UPDATE publications SET active_version_id = 'jobs-version' WHERE id = ?").bind(publicationId).run();
    const created = await insertJob(workerEnv, ownerId, { kind: "cleanup", publicationId, versionId: "jobs-version", dedupeKey: "reactivated-cleanup" });
    const body = created.body as JobBody;
    await processJobMessage(workerEnv, { id: body.id, kind: "cleanup", ownerId, payload: { jobId: body.id } });
    expect(await env.PUBLICATIONS.get("jobs/index.html")).not.toBeNull();
    expect(await env.DB.prepare("SELECT storage_purged_at FROM publication_versions WHERE id = 'jobs-version'").first<{ storage_purged_at: string | null }>()).toEqual({ storage_purged_at: null });
  });

  it("purges an inactive version's manifest with its retained files", async () => {
    const manifestKey = "jobs/manifest.json";
    await env.PUBLICATIONS.put(manifestKey, "{}");
    await env.DB.prepare("UPDATE publication_versions SET deleted_at = datetime('now', '-1 day'), retention_until = datetime('now', '-1 second'), manifest_key = ? WHERE id = ? AND owner_id = ?").bind(manifestKey, "jobs-version", ownerId).run();
    await env.DB.prepare("UPDATE publications SET active_version_id = NULL WHERE id = ? AND owner_id = ?").bind(publicationId, ownerId).run();
    const created = await insertJob(workerEnv, ownerId, { kind: "cleanup", publicationId, versionId: "jobs-version", dedupeKey: "purge-retained-version" });

    await processJobMessage(workerEnv, { id: created.body.id, kind: "cleanup", ownerId, payload: { jobId: created.body.id } });

    expect(await env.PUBLICATIONS.get("jobs/index.html")).toBeNull();
    expect(await env.PUBLICATIONS.get(manifestKey)).toBeNull();
    expect(await env.DB.prepare("SELECT storage_purged_at FROM publication_versions WHERE id = ? AND owner_id = ?").bind("jobs-version", ownerId).first<{ storage_purged_at: string | null }>()).toMatchObject({ storage_purged_at: expect.any(String) });
  });
});
