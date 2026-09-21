import { base64Url, encodeHex, hmac } from "./auth";
import { isPagecastId } from "./identifiers";
import type { Env, JobKind, JobMessage } from "./types";

const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_INSPECTION_BYTES = 256 * 1024;
const MAX_INSPECTION_LINKS = 500;
const USER_JOB_KINDS = new Set<JobKind>(["expire", "cleanup", "screenshot", "pdf", "accessibility_check", "link_check", "index"]);
const OPTIONAL_PROVIDER_KINDS = new Set<JobKind>(["screenshot", "pdf", "accessibility_check"]);
const MAX_WEBHOOK_SUBSCRIPTIONS = 100;
const ENQUEUE_LEASE_SECONDS = 120;
const ENQUEUE_RETRY_SECONDS = 300;
const RETENTION_BATCH_SIZE = 100;

export interface WebhookBody { id: string; destination: string; eventTypes: string[]; secret?: string; secretVersion: number; disabledAt?: string | null }
export interface JobBody { id: string; kind: JobKind; publicationId: string | null; versionId: string | null; status: string; dedupeKey: string; hasArtifact: boolean; errorCode?: string | null }
type DeliveryFetcher = (request: Request) => Promise<Response>;

interface WebhookRow { id: string; destination: string; event_types_json: string; secret_version: number; disabled_at: string | null }
interface DeliveryRow { id: string; attempt: number; status: string }
interface OutboxRow { id: string; owner_id: string; event_type: string; payload_json: string }
interface JobRow { id: string; owner_id: string; publication_id: string | null; version_id: string | null; kind: JobKind; payload_json: string; status: string; attempt_count: number; max_attempts: number; cancelled_at: string | null }

export function validateWebhookDestination(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 12 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !validHostname(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}

export async function listWebhooks(env: Env, ownerId: string): Promise<Response> {
  const rows = await env.DB.prepare("SELECT id, destination, event_types_json, secret_version, disabled_at FROM webhook_subscriptions WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100").bind(ownerId).all<WebhookRow>();
  return Response.json({ webhooks: rows.results.flatMap(webhookBody) });
}

export async function listWebhookDeliveries(env: Env, ownerId: string, webhookId: string): Promise<Response> {
  const webhook = await webhookForOwner(env.DB, ownerId, webhookId);
  if (!webhook) return jsonError("webhook_not_found", 404);
  const rows = await env.DB.prepare("SELECT id, outbox_id, attempt, status, response_status, error_code, attempted_at, next_attempt_at, delivered_at, dead_lettered_at FROM webhook_deliveries WHERE owner_id = ? AND subscription_id = ? ORDER BY created_at DESC LIMIT 100").bind(ownerId, webhookId).all<Record<string, unknown>>();
  return Response.json({ deliveries: rows.results.map((row) => ({ id: row.id, outboxId: row.outbox_id, attempt: row.attempt, status: row.status, responseStatus: row.response_status, errorCode: row.error_code, attemptedAt: row.attempted_at, nextAttemptAt: row.next_attempt_at, deliveredAt: row.delivered_at, deadLetteredAt: row.dead_lettered_at })) });
}

export async function createOutboxEvent(env: Env, ownerId: string, eventType: string, data: Record<string, unknown>, dedupeKey: string): Promise<string | null> {
  if (!validEventType(eventType) || !validDedupeKey(dedupeKey) || payloadSize(data) > MAX_PAYLOAD_BYTES) return null;
  const id = crypto.randomUUID();
  const payload = { version: "v1", id, type: eventType, createdAt: new Date().toISOString(), data };
  try {
    await env.DB.prepare("INSERT INTO outbox_events (id, owner_id, event_type, payload_json, dedupe_key) VALUES (?, ?, ?, ?, ?)").bind(id, ownerId, eventType, JSON.stringify(payload), dedupeKey).run();
    return id;
  } catch {
    const existing = await env.DB.prepare("SELECT id FROM outbox_events WHERE owner_id = ? AND dedupe_key = ?").bind(ownerId, dedupeKey).first<{ id: string }>();
    return existing?.id ?? null;
  }
}

export function outboxStatement(db: D1Database, ownerId: string, eventType: string, data: Record<string, unknown>, dedupeKey: string): { id: string; statement: D1PreparedStatement } | null {
  if (!validEventType(eventType) || !validDedupeKey(dedupeKey) || payloadSize(data) > MAX_PAYLOAD_BYTES) return null;
  const id = crypto.randomUUID();
  const payload = { version: "v1", id, type: eventType, createdAt: new Date().toISOString(), data };
  return { id, statement: db.prepare("INSERT OR IGNORE INTO outbox_events (id, owner_id, event_type, payload_json, dedupe_key) VALUES (?, ?, ?, ?, ?)").bind(id, ownerId, eventType, JSON.stringify(payload), dedupeKey) };
}

export async function repairOutbox(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE outbox_events SET status = 'pending', processing_started_at = NULL WHERE status = 'processing' AND processing_started_at <= datetime('now', '-5 minutes')").run();
  await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'dead_lettered', error_code = 'sending_lease_expired', next_attempt_at = NULL, dead_lettered_at = CURRENT_TIMESTAMP, sending_lease_expires_at = NULL, retention_until = datetime('now', '+30 days'), updated_at = CURRENT_TIMESTAMP WHERE status = 'sending' AND sending_lease_expires_at <= CURRENT_TIMESTAMP AND attempt >= ${MAX_ATTEMPTS}`).run();
  await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'retrying', error_code = 'sending_lease_expired', next_attempt_at = CURRENT_TIMESTAMP, sending_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'sending' AND sending_lease_expires_at <= CURRENT_TIMESTAMP AND attempt < ${MAX_ATTEMPTS}`).run();
  const rows = await env.DB.prepare(`SELECT id, owner_id FROM outbox_events WHERE status = 'pending' AND available_at <= CURRENT_TIMESTAMP AND (enqueue_lease_expires_at IS NULL OR enqueue_lease_expires_at <= CURRENT_TIMESTAMP) AND (last_enqueued_at IS NULL OR last_enqueued_at <= datetime('now', '-${ENQUEUE_RETRY_SECONDS} seconds')) ORDER BY created_at LIMIT ${RETENTION_BATCH_SIZE}`).all<{ id: string; owner_id: string }>();
  await forEachBounded(rows.results, (row) => enqueueOutbox(env, row.owner_id, row.id));
  const deliveries = await env.DB.prepare(`SELECT id, owner_id FROM webhook_deliveries WHERE status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP) AND (enqueue_lease_expires_at IS NULL OR enqueue_lease_expires_at <= CURRENT_TIMESTAMP) AND (last_enqueued_at IS NULL OR last_enqueued_at <= datetime('now', '-${ENQUEUE_RETRY_SECONDS} seconds')) ORDER BY next_attempt_at, created_at LIMIT ${RETENTION_BATCH_SIZE}`).all<{ id: string; owner_id: string }>();
  await forEachBounded(deliveries.results, (row) => enqueueWebhookDelivery(env, row.owner_id, row.id));
}

export async function processOutboxEvent(env: Env, ownerId: string, outboxId: string): Promise<void> {
  const claimed = await env.DB.prepare("UPDATE outbox_events SET status = 'processing', processing_started_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status = 'pending'").bind(outboxId, ownerId).run();
  if (!claimed.meta.changes) return;
  const event = await env.DB.prepare("SELECT id, owner_id, event_type, payload_json FROM outbox_events WHERE id = ? AND owner_id = ?").bind(outboxId, ownerId).first<OutboxRow>();
  if (!event) return;
  const payload = parseJsonObject(event.payload_json);
  if (!payload) { await env.DB.prepare("UPDATE outbox_events SET status = 'dead_lettered', retention_until = datetime('now', '+30 days') WHERE id = ?").bind(outboxId).run(); return; }
  const subscriptions = await env.DB.prepare("SELECT id FROM webhook_subscriptions WHERE owner_id = ? AND disabled_at IS NULL AND event_types_json LIKE ? ORDER BY created_at LIMIT ?")
    .bind(ownerId, `%\"${event.event_type}\"%`, MAX_WEBHOOK_SUBSCRIPTIONS).all<{ id: string }>();
  const deliveryIds = subscriptions.results.map(() => crypto.randomUUID());
  await env.DB.batch([
    ...subscriptions.results.map((subscription, index) => env.DB.prepare("INSERT OR IGNORE INTO webhook_deliveries (id, owner_id, subscription_id, outbox_id) VALUES (?, ?, ?, ?)").bind(deliveryIds[index], ownerId, subscription.id, outboxId)),
    env.DB.prepare("UPDATE outbox_events SET status = 'sent', sent_at = CURRENT_TIMESTAMP, retention_until = datetime('now', '+30 days'), processing_started_at = NULL WHERE id = ? AND owner_id = ?").bind(outboxId, ownerId),
  ]);
  const deliveries = await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE owner_id = ? AND outbox_id = ? AND status = 'pending'").bind(ownerId, outboxId).all<{ id: string }>();
  await forEachBounded(deliveries.results.slice(0, MAX_WEBHOOK_SUBSCRIPTIONS), (delivery) => enqueueWebhookDelivery(env, ownerId, delivery.id));
}

async function processWebhookDelivery(env: Env, ownerId: string, deliveryId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT d.subscription_id, d.outbox_id, o.payload_json FROM webhook_deliveries d JOIN outbox_events o ON o.id = d.outbox_id WHERE d.id = ? AND d.owner_id = ? AND d.status IN ('pending', 'retrying')").bind(deliveryId, ownerId).first<{ subscription_id: string; outbox_id: string; payload_json: string }>();
  if (!row) return;
  const payload = parseJsonObject(row.payload_json);
  if (!payload) return;
  await deliverWebhook(env, ownerId, row.subscription_id, row.outbox_id, payload);
}

export async function deliverWebhook(env: Env, ownerId: string, webhookId: string, outboxId: string, payload: Record<string, unknown>, fetcher: DeliveryFetcher = fetch): Promise<{ status: string }> {
  const webhook = await webhookForOwner(env.DB, ownerId, webhookId);
  if (!webhook || webhook.disabled_at) return { status: "dead_lettered" };
  // Normal fanout creates these rows before enqueueing. This idempotent fallback keeps a
  // recovered delivery message from being lost if an older queue message arrives first.
  await env.DB.prepare("INSERT OR IGNORE INTO webhook_deliveries (id, owner_id, subscription_id, outbox_id) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), ownerId, webhookId, outboxId).run();
  const delivery = await env.DB.prepare("SELECT id, attempt, status FROM webhook_deliveries WHERE subscription_id = ? AND outbox_id = ?").bind(webhookId, outboxId).first<DeliveryRow>();
  if (!delivery || delivery.status === "delivered" || delivery.status === "dead_lettered") return { status: delivery?.status ?? "dead_lettered" };
  const claimed = await env.DB.prepare("UPDATE webhook_deliveries SET status = 'sending', attempt = attempt + 1, attempted_at = CURRENT_TIMESTAMP, sending_lease_expires_at = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('pending', 'retrying')").bind(delivery.id).run();
  if (!claimed.meta.changes) return { status: "sending" };
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    const response = await fetcher(new Request(webhook.destination, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", "User-Agent": "Pagecast-Webhook/2", "Pagecast-Event": String(payload.type ?? "unknown"), "Pagecast-Delivery": outboxId, "Pagecast-Timestamp": timestamp, "Pagecast-Signature": await signWebhookPayload(env, webhook.id, webhook.secret_version, timestamp, body) }, body }));
    if (response.status >= 200 && response.status < 300) {
      await env.DB.prepare("UPDATE webhook_deliveries SET status = 'delivered', response_status = ?, delivered_at = CURRENT_TIMESTAMP, retention_until = datetime('now', '+30 days'), error_code = NULL, sending_lease_expires_at = NULL, enqueue_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(response.status, delivery.id).run();
      return { status: "delivered" };
    }
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    return finishDeliveryFailure(env.DB, delivery.id, delivery.attempt + 1, response.status >= 300 && response.status < 400 ? "redirect_refused" : `http_${response.status}`, response.status, !retryable);
  } catch { return finishDeliveryFailure(env.DB, delivery.id, delivery.attempt + 1, "delivery_failed", null); }
}

export async function signWebhookPayload(env: Env, webhookId: string, version: number, timestamp: string, body: string): Promise<string> {
  return `v1,t=${timestamp},sha256=${encodeHex(await hmac(await webhookSecret(env, webhookId, version), `${timestamp}.${body}`))}`;
}

export async function createScheduledJob(env: Env, ownerId: string, input: { kind: "expire" | "cleanup"; publicationId?: string; versionId?: string; dedupeKey: string }): Promise<void> {
  if (!validDedupeKey(input.dedupeKey) || !validOptionalId(input.publicationId) || !validOptionalId(input.versionId)) return;
  await env.DB.prepare("INSERT OR IGNORE INTO jobs (id, owner_id, publication_id, version_id, kind, payload_json, dedupe_key) VALUES (?, ?, ?, ?, ?, '{}', ?)")
    .bind(crypto.randomUUID(), ownerId, input.publicationId ?? null, input.versionId ?? null, input.kind, input.dedupeKey).run();
}

export async function getJob(env: Env, ownerId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id, kind, publication_id, version_id, status, dedupe_key, artifact_key, error_code, progress, attempt_count, cancelled_at, created_at, completed_at FROM jobs WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<Record<string, unknown>>();
  return row ? Response.json(jobBody(row)) : jsonError("job_not_found", 404);
}

export async function listJobs(env: Env, ownerId: string): Promise<Response> {
  const rows = await env.DB.prepare("SELECT id, kind, publication_id, version_id, status, dedupe_key, artifact_key, error_code, progress, attempt_count, cancelled_at, created_at, completed_at FROM jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100").bind(ownerId).all<Record<string, unknown>>();
  return Response.json({ jobs: rows.results.map(jobBody) });
}

export async function jobArtifact(env: Env, ownerId: string, id: string): Promise<Response> {
  const job = await env.DB.prepare("SELECT a.r2_key AS artifact_key, a.content_type FROM jobs j LEFT JOIN job_artifacts a ON a.job_id = j.id AND a.owner_id = j.owner_id WHERE j.id = ? AND j.owner_id = ? AND j.status = 'completed'").bind(id, ownerId).first<{ artifact_key: string | null; content_type: string | null }>();
  if (!job) return jsonError("job_artifact_not_found", 404);
  if (!job.artifact_key) return jsonError("job_has_no_artifact", 409);
  const object = await env.PUBLICATIONS.get(job.artifact_key);
  return object ? new Response(object.body, { headers: { "content-type": job.content_type ?? object.httpMetadata?.contentType ?? "application/octet-stream" } }) : jsonError("job_artifact_not_found", 404);
}

export async function processJobMessage(env: Env, message: JobMessage): Promise<void> {
  if (message.kind === "webhook") {
    const deliveryId = typeof message.payload.deliveryId === "string" ? message.payload.deliveryId : null;
    return deliveryId ? processWebhookDelivery(env, message.ownerId, deliveryId) : processOutboxEvent(env, message.ownerId, String(message.payload.outboxId ?? message.id));
  }
  const jobId = typeof message.payload.jobId === "string" ? message.payload.jobId : message.id;
  const claimed = await env.DB.prepare("UPDATE jobs SET status = 'running', attempt_count = attempt_count + 1, progress = 1, lease_expires_at = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status IN ('queued', 'retrying') AND cancelled_at IS NULL").bind(jobId, message.ownerId).run();
  if (!claimed.meta.changes) return;
  const job = await env.DB.prepare("SELECT id, owner_id, publication_id, version_id, kind, payload_json, status, attempt_count, max_attempts, cancelled_at FROM jobs WHERE id = ? AND owner_id = ?").bind(jobId, message.ownerId).first<JobRow>();
  if (!job) return;
  await env.DB.prepare("INSERT OR IGNORE INTO job_attempts (id, job_id, attempt, status) VALUES (?, ?, ?, 'running')").bind(crypto.randomUUID(), job.id, job.attempt_count).run();
  if (OPTIONAL_PROVIDER_KINDS.has(job.kind) && !env.BROWSER) return finishJob(env.DB, job, "failed", "unsupported_provider");
  if (env.BROWSER && (job.kind === "screenshot" || job.kind === "pdf" || job.kind === "accessibility_check")) {
    try { await runBrowserJob(env, job); } catch (cause) { return finishJob(env.DB, job, "failed", cause instanceof Error && cause.message === "artifact_too_large" ? "artifact_too_large" : "provider_failed"); }
  }
  if (job.kind === "expire") {
    const expired = await env.DB.prepare("UPDATE publications SET state = 'expired', active_version_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP AND state NOT IN ('revoked', 'archived')").bind(job.publication_id, job.owner_id).run();
    if (expired.meta.changes && job.publication_id) await createOutboxEvent(env, job.owner_id, "publication.expired", { publicationId: job.publication_id, versionId: job.version_id }, `publication.expired:${job.publication_id}:${job.version_id ?? "none"}`);
  }
  if (job.kind === "cleanup") await cleanupVersionIfStillInactive(env, job);
  if (job.kind === "link_check" || job.kind === "index") {
    try {
      await runLocalInspection(env, job);
    } catch (cause) {
      const errorCode = inspectionFailureCode(cause);
      if (errorCode === "inspection_failed") throw cause;
      return finishJob(env.DB, job, "failed", errorCode);
    }
  }
  if (job.cancelled_at) return finishJob(env.DB, job, "cancelled", "cancelled");
  await finishJob(env.DB, job, "completed", null);
}

export async function scheduledJobs(env: Env): Promise<void> {
  await repairOutbox(env);
  await recoverJobLeases(env);
  const pending = await env.DB.prepare(`SELECT id, owner_id, kind FROM jobs WHERE status IN ('queued', 'retrying') AND cancelled_at IS NULL AND (enqueue_lease_expires_at IS NULL OR enqueue_lease_expires_at <= CURRENT_TIMESTAMP) AND (last_enqueued_at IS NULL OR last_enqueued_at <= datetime('now', '-${ENQUEUE_RETRY_SECONDS} seconds')) ORDER BY created_at LIMIT ${RETENTION_BATCH_SIZE}`).all<{ id: string; owner_id: string; kind: JobKind }>();
  await forEachBounded(pending.results, (job) => enqueueJobRecord(env, job.owner_id, job.id, job.kind));
  const expired = await env.DB.prepare("SELECT id, owner_id, active_version_id FROM publications WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP AND state NOT IN ('revoked', 'archived', 'expired') ORDER BY expires_at LIMIT 100").all<{ id: string; owner_id: string; active_version_id: string | null }>();
  await forEachBounded(expired.results, (publication) => createScheduledJob(env, publication.owner_id, { kind: "expire", publicationId: publication.id, dedupeKey: `expire:${publication.id}:${publication.active_version_id ?? "none"}` }));
  await cleanupJobRetention(env);
}

export async function recoverJobMessage(env: Env, message: JobMessage, errorCode = "queue_processing_failed"): Promise<void> {
  if (message.kind === "webhook") return;
  const jobId = typeof message.payload.jobId === "string" ? message.payload.jobId : message.id;
  const job = await env.DB.prepare("SELECT id, owner_id, kind, attempt_count, max_attempts FROM jobs WHERE id = ? AND owner_id = ? AND status = 'running'").bind(jobId, message.ownerId).first<Pick<JobRow, "id" | "owner_id" | "kind" | "attempt_count" | "max_attempts">>();
  if (!job) return;
  const terminal = job.attempt_count >= job.max_attempts;
  await env.DB.batch([
    env.DB.prepare("UPDATE jobs SET status = ?, error_code = ?, lease_expires_at = NULL, enqueue_lease_expires_at = NULL, last_enqueued_at = CASE WHEN ? THEN last_enqueued_at ELSE NULL END, completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, retention_until = CASE WHEN ? THEN datetime('now', '+30 days') ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status = 'running'").bind(terminal ? "dead_lettered" : "retrying", errorCode, terminal ? 1 : 0, terminal ? 1 : 0, terminal ? 1 : 0, job.id, job.owner_id),
    env.DB.prepare("UPDATE job_attempts SET status = 'failed', error_code = ?, completed_at = CURRENT_TIMESTAMP, retention_until = CASE WHEN ? THEN datetime('now', '+30 days') ELSE NULL END WHERE job_id = ? AND attempt = ?").bind(errorCode, terminal ? 1 : 0, job.id, job.attempt_count),
    ...(terminal ? [env.DB.prepare("INSERT OR IGNORE INTO job_dead_letters (id, owner_id, job_id, message_json, reason, retention_until) VALUES (?, ?, ?, ?, ?, datetime('now', '+30 days'))").bind(crypto.randomUUID(), job.owner_id, job.id, JSON.stringify(message), errorCode)] : []),
  ]);
}

async function recoverJobLeases(env: Env): Promise<void> {
  const stale = await env.DB.prepare("SELECT id, owner_id, kind, attempt_count, max_attempts FROM jobs WHERE status = 'running' AND lease_expires_at <= CURRENT_TIMESTAMP ORDER BY lease_expires_at LIMIT 100").all<Pick<JobRow, "id" | "owner_id" | "kind" | "attempt_count" | "max_attempts">>();
  for (const job of stale.results) await recoverJobMessage(env, { id: job.id, kind: job.kind, ownerId: job.owner_id, payload: { jobId: job.id } }, "lease_expired");
}

async function cleanupJobRetention(env: Env): Promise<void> {
  const artifacts = await env.DB.prepare(`SELECT a.job_id, a.r2_key FROM job_artifacts a JOIN jobs j ON j.id = a.job_id AND j.owner_id = a.owner_id WHERE j.status IN ('completed', 'failed', 'cancelled', 'dead_lettered') AND j.retention_until <= CURRENT_TIMESTAMP ORDER BY j.retention_until LIMIT ${RETENTION_BATCH_SIZE}`).all<{ job_id: string; r2_key: string }>();
  for (const artifact of artifacts.results) {
    await env.PUBLICATIONS.delete(artifact.r2_key);
    await env.DB.prepare("DELETE FROM job_artifacts WHERE job_id = ? AND r2_key = ?").bind(artifact.job_id, artifact.r2_key).run();
  }
  await env.DB.prepare(`DELETE FROM webhook_deliveries WHERE status IN ('delivered', 'dead_lettered') AND retention_until <= CURRENT_TIMESTAMP LIMIT ${RETENTION_BATCH_SIZE}`).run();
  await env.DB.prepare(`DELETE FROM outbox_events WHERE status IN ('sent', 'dead_lettered') AND retention_until <= CURRENT_TIMESTAMP LIMIT ${RETENTION_BATCH_SIZE}`).run();
  await env.DB.prepare(`DELETE FROM job_attempts WHERE retention_until <= CURRENT_TIMESTAMP LIMIT ${RETENTION_BATCH_SIZE}`).run();
  await env.DB.prepare(`DELETE FROM job_dead_letters WHERE retention_until <= CURRENT_TIMESTAMP LIMIT ${RETENTION_BATCH_SIZE}`).run();
  await env.DB.prepare(`DELETE FROM jobs WHERE status IN ('completed', 'failed', 'cancelled', 'dead_lettered') AND retention_until <= CURRENT_TIMESTAMP AND NOT EXISTS (SELECT 1 FROM job_artifacts WHERE job_artifacts.job_id = jobs.id) LIMIT ${RETENTION_BATCH_SIZE}`).run();
}

async function cleanupVersionIfStillInactive(env: Env, job: JobRow): Promise<void> {
  if (!job.version_id) return;
  const version = await env.DB.prepare("SELECT v.id, v.manifest_key FROM publication_versions v JOIN publications p ON p.id = v.publication_id AND p.owner_id = v.owner_id WHERE v.id = ? AND v.owner_id = ? AND v.deleted_at IS NOT NULL AND v.retention_until <= CURRENT_TIMESTAMP AND v.storage_purged_at IS NULL AND (p.active_version_id IS NULL OR p.active_version_id <> v.id)").bind(job.version_id, job.owner_id).first<{ id: string; manifest_key: string | null }>();
  if (!version) return;
  const files = await env.DB.prepare("SELECT r2_key FROM version_files WHERE version_id = ?").bind(job.version_id).all<{ r2_key: string }>();
  await Promise.all([...files.results.map((file) => env.PUBLICATIONS.delete(file.r2_key)), ...(version.manifest_key ? [env.PUBLICATIONS.delete(version.manifest_key)] : [])]);
  await env.DB.prepare("UPDATE publication_versions SET storage_purged_at = CURRENT_TIMESTAMP WHERE id = ? AND storage_purged_at IS NULL").bind(job.version_id).run();
}

async function runBrowserJob(env: Env, job: JobRow): Promise<void> {
  if (!env.BROWSER) throw new Error("provider_missing");
  const url = await browserUrl(env, job);
  const action = job.kind === "accessibility_check" ? "accessibilityTree" : job.kind;
  if (action !== "screenshot" && action !== "pdf" && action !== "accessibilityTree") throw new Error("unsupported_browser_job");
  const response = await env.BROWSER.quickAction(action, { url });
  if (!response.ok) throw new Error("browser_response_failed");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ARTIFACT_BYTES)) throw new Error("artifact_too_large");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
  const expected = action === "screenshot" ? /^image\/(?:png|jpeg|webp)$/ : action === "pdf" ? /^application\/pdf$/ : /^application\/json$/;
  if (!expected.test(contentType)) throw new Error("invalid_provider_content_type");
  await storeArtifact(env, job, response.body ?? new ArrayBuffer(0), contentType);
}

async function runLocalInspection(env: Env, job: JobRow): Promise<void> {
  if (!job.version_id || !job.publication_id) throw new Error("inspection_version_required");
  const version = await env.DB.prepare("SELECT p.slug FROM publication_versions v JOIN publications p ON p.id = v.publication_id AND p.owner_id = v.owner_id WHERE v.id = ? AND v.owner_id = ? AND v.publication_id = ? AND v.deleted_at IS NULL").bind(job.version_id, job.owner_id, job.publication_id).first<{ slug: string }>();
  if (!version) throw new Error("inspection_version_not_found");
  const files = await env.DB.prepare("SELECT normalized_path, r2_key, content_type, byte_size FROM version_files WHERE version_id = ? ORDER BY normalized_path LIMIT 1000").bind(job.version_id).all<{ normalized_path: string; r2_key: string; content_type: string; byte_size: number }>();
  const manifest = new Map(files.results.map((file) => [file.normalized_path, file]));
  const requested = inspectionPath(parseJsonObject(job.payload_json)?.targetPath, version.slug);
  const html = [...manifest.values()].filter((file) => file.content_type.startsWith("text/html") && file.byte_size <= MAX_INSPECTION_BYTES).slice(0, 25);
  if (job.kind === "link_check") {
    const checks: Array<{ source: string; target: string; status: "ok" | "missing" }> = [];
    let externalSkipped = 0;
    let truncated = false;
    for (const file of html) {
      const source = await readR2Text(env, file);
      for (const link of extractLinks(source)) {
        if (checks.length >= MAX_INSPECTION_LINKS) { truncated = true; break; }
        const target = manifestPath(link, file.normalized_path, version.slug);
        if (target === null) { externalSkipped += 1; continue; }
        if (target) checks.push({ source: file.normalized_path, target, status: manifest.has(target) ? "ok" : "missing" });
      }
      if (truncated) break;
    }
    await storeArtifact(env, job, JSON.stringify({ version: "v1", scope: "selected-immutable-version", requestedPath: requested, checkedFiles: html.length, checks, externalSkipped, truncated }), "application/json");
    return;
  }
  const documents: Array<{ path: string; title: string | null; headings: string[]; excerpt: string }> = [];
  let textBudget = 8_000;
  for (const file of html.slice(0, 10)) {
    if (textBudget <= 0) break;
    const source = await readR2Text(env, file);
    const title = /<title[^>]*>([\s\S]{0,512}?)<\/title>/i.exec(source)?.[1] ?? null;
    const headings = [...source.matchAll(/<h[1-3][^>]*>([\s\S]{0,512}?)<\/h[1-3]>/gi)].slice(0, 12).map((match) => textContent(match[1]));
    const excerpt = textContent(source).slice(0, Math.min(textBudget, 1_200));
    textBudget -= excerpt.length;
    documents.push({ path: file.normalized_path, title: title ? textContent(title) : null, headings, excerpt });
  }
  await storeArtifact(env, job, JSON.stringify({ version: "v1", scope: "selected-immutable-version", requestedPath: requested, fileCount: manifest.size, documents, truncated: html.length > documents.length }), "application/json");
}

function inspectionFailureCode(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  return ["inspection_version_required", "inspection_version_not_found", "artifact_too_large"].includes(message) ? message : "inspection_failed";
}

async function storeArtifact(env: Env, job: JobRow, body: ArrayBuffer | ReadableStream | string, contentType: string): Promise<void> {
  const extension = contentType === "application/pdf" ? "pdf" : contentType === "application/json" ? "json" : "png";
  const key = `owners/${job.owner_id}/jobs/${job.id}/artifact.${extension}`;
  const bytes = await artifactBytes(body);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
  await env.PUBLICATIONS.put(key, bytes, { httpMetadata: { contentType } });
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET artifact_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(key, job.id, job.owner_id),
      env.DB.prepare("INSERT INTO job_artifacts (job_id, owner_id, r2_key, content_type, byte_size) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET r2_key = excluded.r2_key, content_type = excluded.content_type, byte_size = excluded.byte_size").bind(job.id, job.owner_id, key, contentType, bytes.byteLength),
    ]);
  } catch (cause) {
    await env.PUBLICATIONS.delete(key);
    throw cause;
  }
}

async function artifactBytes(body: ArrayBuffer | ReadableStream | string): Promise<ArrayBuffer> {
  if (typeof body === "string") {
    const bytes = new TextEncoder().encode(body);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  if (body instanceof ArrayBuffer) return body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function readR2Text(env: Env, file: { r2_key: string; byte_size: number }): Promise<string> {
  if (file.byte_size > MAX_INSPECTION_BYTES) return "";
  const object = await env.PUBLICATIONS.get(file.r2_key);
  if (!object || object.size > MAX_INSPECTION_BYTES) return "";
  return (await object.text()).slice(0, MAX_INSPECTION_BYTES);
}

function extractLinks(html: string): string[] {
  return [...html.matchAll(/(?:href|src)\s*=\s*(["'])(.*?)\1/gi)].slice(0, MAX_INSPECTION_LINKS).map((match) => match[2]);
}

function inspectionPath(value: unknown, slug: string): string | null {
  const path = safeTargetPath(value);
  if (!path) return null;
  const prefix = `/p/${slug}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) || "index.html" : null;
}

function manifestPath(value: string, source: string, slug: string): string | "" | null {
  if (!value || value.startsWith("#")) return "";
  if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(value) || value.startsWith("//")) return null;
  try {
    const base = new URL(`/p/${slug}/${source}`, "https://pagecast.invalid");
    const url = new URL(value, base);
    if (url.origin !== "https://pagecast.invalid") return null;
    const prefix = `/p/${slug}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    return decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
  } catch { return null; }
}

function textContent(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_200);
}

async function finishJob(db: D1Database, job: JobRow, status: "completed" | "failed" | "cancelled", errorCode: string | null): Promise<void> {
  const terminal = status === "failed" && job.attempt_count >= job.max_attempts ? "dead_lettered" : status;
  await db.batch([
    db.prepare("UPDATE jobs SET status = ?, progress = ?, error_code = ?, lease_expires_at = NULL, enqueue_lease_expires_at = NULL, completed_at = CURRENT_TIMESTAMP, retention_until = datetime('now', '+30 days'), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(terminal, terminal === "completed" ? 100 : 0, errorCode, job.id),
    db.prepare("UPDATE job_artifacts SET retention_until = datetime('now', '+30 days') WHERE job_id = ?").bind(job.id),
    db.prepare("UPDATE job_attempts SET status = ?, error_code = ?, completed_at = CURRENT_TIMESTAMP, retention_until = datetime('now', '+30 days') WHERE job_id = ? AND attempt = ?").bind(terminal === "completed" ? "completed" : terminal === "cancelled" ? "cancelled" : "failed", errorCode, job.id, job.attempt_count),
    ...(terminal === "dead_lettered" ? [db.prepare("INSERT OR IGNORE INTO job_dead_letters (id, owner_id, job_id, message_json, reason, retention_until) VALUES (?, ?, ?, ?, ?, datetime('now', '+30 days'))").bind(crypto.randomUUID(), job.owner_id, job.id, JSON.stringify({ id: job.id, kind: job.kind }), errorCode ?? "failed")] : []),
  ]);
}

async function finishDeliveryFailure(db: D1Database, id: string, attempt: number, errorCode: string, responseStatus: number | null, terminal = false): Promise<{ status: string }> {
  const dead = terminal || attempt >= MAX_ATTEMPTS;
  await db.prepare("UPDATE webhook_deliveries SET status = ?, response_status = ?, error_code = ?, next_attempt_at = CASE WHEN ? THEN NULL ELSE datetime('now', '+1 minute') END, dead_lettered_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, sending_lease_expires_at = NULL, retention_until = CASE WHEN ? THEN datetime('now', '+30 days') ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(dead ? "dead_lettered" : "retrying", responseStatus, errorCode, dead ? 1 : 0, dead ? 1 : 0, dead ? 1 : 0, id).run();
  return { status: dead ? "dead_lettered" : "retrying" };
}

export async function webhookSecret(env: Env, id: string, version: number): Promise<string> { return base64Url(await hmac(env.WEBHOOK_SIGNING_KEY, `pagecast-webhook-v1:${id}:${version}`)); }
async function webhookForOwner(db: D1Database, ownerId: string, id: string): Promise<WebhookRow | null> { return db.prepare("SELECT id, destination, event_types_json, secret_version, disabled_at FROM webhook_subscriptions WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<WebhookRow>(); }
export async function enqueueOutbox(env: Pick<Env, "DB" | "JOBS">, ownerId: string, id: string): Promise<void> {
  await enqueueClaimed(env, "outbox_events", `id = ? AND owner_id = ? AND status = 'pending' AND available_at <= CURRENT_TIMESTAMP AND (last_enqueued_at IS NULL OR last_enqueued_at <= datetime('now', '-${ENQUEUE_RETRY_SECONDS} seconds'))`, [id, ownerId], { id, kind: "webhook", ownerId, payload: { outboxId: id } });
}
export async function enqueueWebhookDelivery(env: Pick<Env, "DB" | "JOBS">, ownerId: string, id: string): Promise<void> {
  await enqueueClaimed(env, "webhook_deliveries", `id = ? AND owner_id = ? AND status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP) AND (last_enqueued_at IS NULL OR last_enqueued_at <= datetime('now', '-${ENQUEUE_RETRY_SECONDS} seconds'))`, [id, ownerId], { id, kind: "webhook", ownerId, payload: { deliveryId: id } });
}
export async function enqueueJobRecord(env: Pick<Env, "DB" | "JOBS">, ownerId: string, id: string, kind: JobKind): Promise<void> {
  if (kind === "webhook") return;
  await enqueueClaimed(env, "jobs", `id = ? AND owner_id = ? AND kind = ? AND status IN ('queued', 'retrying') AND cancelled_at IS NULL AND (last_enqueued_at IS NULL OR last_enqueued_at <= datetime('now', '-${ENQUEUE_RETRY_SECONDS} seconds'))`, [id, ownerId, kind], { id, kind, ownerId, payload: { jobId: id } });
}
async function enqueueClaimed(env: Pick<Env, "DB" | "JOBS">, table: "outbox_events" | "webhook_deliveries" | "jobs", predicate: string, values: unknown[], message: JobMessage): Promise<void> {
  const leaseToken = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE ${table} SET enqueue_lease_token = ?, enqueue_lease_expires_at = datetime('now', '+${ENQUEUE_LEASE_SECONDS} seconds') WHERE ${predicate} AND (enqueue_lease_expires_at IS NULL OR enqueue_lease_expires_at <= CURRENT_TIMESTAMP)`).bind(leaseToken, ...values).run();
  if (!claim.meta.changes) return;
  try {
    await env.JOBS.send(message);
    await env.DB.prepare(`UPDATE ${table} SET enqueue_lease_token = NULL, enqueue_lease_expires_at = NULL, last_enqueued_at = CURRENT_TIMESTAMP WHERE ${predicate} AND enqueue_lease_token = ?`).bind(...values, leaseToken).run();
  } catch {
    await env.DB.prepare(`UPDATE ${table} SET enqueue_lease_token = NULL, enqueue_lease_expires_at = NULL WHERE ${predicate} AND enqueue_lease_token = ?`).bind(...values, leaseToken).run();
  }
}
async function forEachBounded<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
}
function validHostname(hostname: string): boolean { const host = hostname.toLowerCase(); return host.length <= 253 && !host.includes(":") && !/^\d+(?:\.\d+){3}$/.test(host) && !["localhost", "local", "internal", "test", "invalid"].includes(host) && !host.endsWith(".localhost") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host); }
function validEventType(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}\.[a-z][a-z0-9_]{0,63}$/.test(value); }
export function validateWebhookEventTypes(value: unknown): string[] | null { return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(validEventType) ? [...new Set(value)].sort() : null; }
const validEventTypes = validateWebhookEventTypes;
function parseEventTypes(value: string): string[] | null { try { return validEventTypes(JSON.parse(value)); } catch { return null; } }
function webhookBody(row: WebhookRow): WebhookBody[] { const eventTypes = parseEventTypes(row.event_types_json); return eventTypes ? [{ id: row.id, destination: row.destination, eventTypes, secretVersion: row.secret_version, disabledAt: row.disabled_at }] : []; }
function isUserJobKind(value: unknown): value is JobKind { return typeof value === "string" && USER_JOB_KINDS.has(value as JobKind); }
function validDedupeKey(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,180}$/.test(value); }
function validOptionalId(value: unknown): value is string | undefined { return value === undefined || isPagecastId(value); }
function validJobPayload(value: unknown): value is Record<string, unknown> | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value) || payloadSize(value) > MAX_PAYLOAD_BYTES) return false;
  const payload = value as Record<string, unknown>;
  return !("url" in payload) && (payload.targetPath === undefined || safeTargetPath(payload.targetPath) !== null);
}
export function validateJobInput(input: { kind: unknown; publicationId?: unknown; versionId?: unknown; dedupeKey: unknown; payload?: unknown }): input is { kind: Exclude<JobKind, "webhook">; publicationId?: string; versionId?: string; dedupeKey: string; payload?: Record<string, unknown> } {
  return isUserJobKind(input.kind) && validDedupeKey(input.dedupeKey) && validOptionalId(input.publicationId) && validOptionalId(input.versionId) && validJobPayload(input.payload);
}
function payloadSize(value: unknown): number { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return Infinity; } }
export function parseJsonObject(value: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
function safeTargetPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value, "https://pagecast.invalid");
    const segments = url.pathname.split("/");
    return url.origin === "https://pagecast.invalid" && segments[1] === "p" && isPagecastId(segments[2]) && !url.search && !url.hash ? url.pathname : null;
  } catch { return null; }
}
async function browserUrl(env: Env, job: JobRow): Promise<string> {
  if (!job.publication_id) throw new Error("browser_publication_required");
  const origin = publicOrigin(env.PUBLIC_ORIGIN);
  if (!origin) throw new Error("browser_origin_required");
  const publication = await env.DB.prepare("SELECT slug FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(job.publication_id, job.owner_id).first<{ slug: string }>();
  if (!publication) throw new Error("browser_publication_not_found");
  const targetPath = safeTargetPath(parseJsonObject(job.payload_json)?.targetPath) ?? `/p/${publication.slug}/`;
  if (!targetPath.startsWith(`/p/${publication.slug}/`)) throw new Error("browser_target_forbidden");
  return new URL(targetPath, origin).toString();
}
function publicOrigin(value: unknown): string | null { try { const url = new URL(typeof value === "string" ? value : ""); return url.protocol === "https:" && !url.username && !url.password && !url.port && validHostname(url.hostname) && url.pathname === "/" && !url.search && !url.hash ? url.toString() : null; } catch { return null; } }
function jobBody(row: Record<string, unknown>): JobBody { return { id: String(row.id), kind: row.kind as JobKind, publicationId: row.publication_id as string | null, versionId: row.version_id as string | null, status: String(row.status), dedupeKey: String(row.dedupe_key), hasArtifact: typeof row.artifact_key === "string", errorCode: row.error_code as string | null }; }
function jsonError(error: string, status: number): Response { return Response.json({ error }, { status }); }
