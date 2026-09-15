import { auditStatement } from "./audit";
import { findIdempotencyReceipt, idempotencyReceiptStatement, resolveIdempotencyReceipt } from "./idempotency";
import { enqueueJobRecord, enqueueWebhookDelivery, parseJsonObject, validateJobInput, validateWebhookDestination, validateWebhookEventTypes } from "./jobs";
import type { Env, JobKind } from "./types";

export type OperationsMutation =
  | { kind: "operations"; operation: "create-webhook"; data: { destination: unknown; eventTypes: unknown } }
  | { kind: "operations"; operation: "rotate-webhook"; data: { webhookId: string } }
  | { kind: "operations"; operation: "update-webhook"; data: { webhookId: string; destination?: unknown; eventTypes?: unknown; disabled?: unknown } }
  | { kind: "operations"; operation: "delete-webhook"; data: { webhookId: string } }
  | { kind: "operations"; operation: "retry-delivery"; data: { deliveryId: string } }
  | { kind: "operations"; operation: "create-job"; data: { kind: unknown; publicationId?: unknown; versionId?: unknown; dedupeKey: unknown; payload?: unknown } }
  | { kind: "operations"; operation: "cancel-job"; data: { jobId: string } }
  | { kind: "operations"; operation: "retry-job"; data: { jobId: string } };

interface Packet { actorId: string | null; fingerprint: string; idempotencyKey: string; mutation: OperationsMutation }

export async function executeOperationsMutation(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const existing = await findIdempotencyReceipt(env.DB, ownerId, packet.idempotencyKey);
  if (existing) return Response.json(resolveIdempotencyReceipt(existing, packet.fingerprint));
  switch (packet.mutation.operation) {
    case "create-webhook": return createWebhook(env, ownerId, packet);
    case "rotate-webhook": return rotateWebhook(env, ownerId, packet);
    case "update-webhook": return updateWebhook(env, ownerId, packet);
    case "delete-webhook": return deleteWebhook(env, ownerId, packet);
    case "retry-delivery": return retryDelivery(env, ownerId, packet);
    case "create-job": return createJob(env, ownerId, packet);
    case "cancel-job": return cancelJob(env, ownerId, packet);
    case "retry-job": return retryJob(env, ownerId, packet);
  }
}

async function createWebhook(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const data = packet.mutation.data as Extract<OperationsMutation, { operation: "create-webhook" }>["data"];
  const destination = validateWebhookDestination(data.destination);
  const eventTypes = validateWebhookEventTypes(data.eventTypes);
  if (!destination || !eventTypes) return terminal(env, ownerId, packet, 400, { error: "invalid_webhook" });
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM webhook_subscriptions WHERE owner_id = ?").bind(ownerId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= 100) return terminal(env, ownerId, packet, 409, { error: "webhook_subscription_limit" });
  const id = crypto.randomUUID();
  const body = { id, destination, eventTypes, secretVersion: 1, credentialVersion: 1 };
  try {
    await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, 201, body),
      env.DB.prepare("INSERT INTO webhook_subscriptions (id, owner_id, destination, event_types_json, secret_version) VALUES (?, ?, ?, ?, 1)").bind(id, ownerId, destination, JSON.stringify(eventTypes)),
      auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "webhook.created", resourceType: "webhook", resourceId: id }),
    ]);
  } catch { return conflictOrFailure(env, ownerId, packet); }
  return Response.json({ status: 201, body });
}

async function rotateWebhook(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const id = (packet.mutation.data as Extract<OperationsMutation, { operation: "rotate-webhook" }>["data"]).webhookId;
  const row = await env.DB.prepare("SELECT secret_version FROM webhook_subscriptions WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<{ secret_version: number }>();
  if (!row) return terminal(env, ownerId, packet, 404, { error: "webhook_not_found" });
  const version = Number(row.secret_version) + 1;
  const body = { id, secretVersion: version, credentialVersion: version };
  try {
    await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, 200, body),
      env.DB.prepare("UPDATE webhook_subscriptions SET secret_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(version, id, ownerId),
      auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "webhook.secret_rotated", resourceType: "webhook", resourceId: id }),
    ]);
  } catch { return conflictOrFailure(env, ownerId, packet); }
  return Response.json({ status: 200, body });
}

async function updateWebhook(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const { webhookId: id, destination: suppliedDestination, eventTypes: suppliedEvents, disabled } = packet.mutation.data as Extract<OperationsMutation, { operation: "update-webhook" }>["data"];
  const existing = await env.DB.prepare("SELECT destination, event_types_json, secret_version FROM webhook_subscriptions WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<{ destination: string; event_types_json: string; secret_version: number }>();
  if (!existing) return terminal(env, ownerId, packet, 404, { error: "webhook_not_found" });
  const destination = suppliedDestination === undefined ? existing.destination : validateWebhookDestination(suppliedDestination);
  const eventTypes = suppliedEvents === undefined ? validateWebhookEventTypes(parseJsonObject(existing.event_types_json)) : validateWebhookEventTypes(suppliedEvents);
  if (!destination || !eventTypes || (disabled !== undefined && typeof disabled !== "boolean")) return terminal(env, ownerId, packet, 400, { error: "invalid_webhook" });
  const body = { id, destination, eventTypes, secretVersion: existing.secret_version, disabled: disabled === true };
  try { await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, 200, body), env.DB.prepare("UPDATE webhook_subscriptions SET destination = ?, event_types_json = ?, disabled_at = CASE WHEN ? THEN COALESCE(disabled_at, CURRENT_TIMESTAMP) ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(destination, JSON.stringify(eventTypes), disabled === true ? 1 : 0, id, ownerId), auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "webhook.updated", resourceType: "webhook", resourceId: id })]); } catch { return conflictOrFailure(env, ownerId, packet); }
  return Response.json({ status: 200, body });
}

async function deleteWebhook(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const id = (packet.mutation.data as Extract<OperationsMutation, { operation: "delete-webhook" }>["data"]).webhookId;
  const existing = await env.DB.prepare("SELECT id FROM webhook_subscriptions WHERE id = ? AND owner_id = ?").bind(id, ownerId).first();
  if (!existing) return terminal(env, ownerId, packet, 404, { error: "webhook_not_found" });
  const body = { id, status: "deleted" };
  try { await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, 200, body), env.DB.prepare("DELETE FROM webhook_subscriptions WHERE id = ? AND owner_id = ?").bind(id, ownerId), auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "webhook.deleted", resourceType: "webhook", resourceId: id })]); } catch { return conflictOrFailure(env, ownerId, packet); }
  return Response.json({ status: 200, body });
}

async function retryDelivery(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const id = (packet.mutation.data as Extract<OperationsMutation, { operation: "retry-delivery" }>["data"]).deliveryId;
  const delivery = await env.DB.prepare("SELECT subscription_id FROM webhook_deliveries WHERE id = ? AND owner_id = ? AND status IN ('retrying', 'dead_lettered')").bind(id, ownerId).first<{ subscription_id: string }>();
  if (!delivery) return terminal(env, ownerId, packet, 409, { error: "delivery_not_retryable" });
  const body = { id, status: "pending" };
  try {
    await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, 200, body),
      env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP, dead_lettered_at = NULL, retention_until = NULL, enqueue_lease_expires_at = NULL, last_enqueued_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(id, ownerId),
      auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "webhook.delivery_retried", resourceType: "webhook_delivery", resourceId: id }),
    ]);
  } catch { return conflictOrFailure(env, ownerId, packet); }
  await enqueueWebhookDelivery(env, ownerId, id);
  return Response.json({ status: 200, body });
}

async function createJob(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const input = packet.mutation.data as Extract<OperationsMutation, { operation: "create-job" }>["data"];
  if (!validateJobInput(input)) return terminal(env, ownerId, packet, 400, { error: "invalid_job" });
  if (input.publicationId && !await env.DB.prepare("SELECT id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(input.publicationId, ownerId).first()) return terminal(env, ownerId, packet, 404, { error: "publication_not_found" });
  if (input.versionId && !await env.DB.prepare("SELECT id FROM publication_versions WHERE id = ? AND owner_id = ? AND (? IS NULL OR publication_id = ?)").bind(input.versionId, ownerId, input.publicationId ?? null, input.publicationId ?? null).first()) return terminal(env, ownerId, packet, 404, { error: "version_not_found" });
  const id = crypto.randomUUID();
  const body = { id, kind: input.kind, publicationId: input.publicationId ?? null, versionId: input.versionId ?? null, status: "queued", dedupeKey: input.dedupeKey };
  try {
    await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, 201, body),
      env.DB.prepare("INSERT INTO jobs (id, owner_id, publication_id, version_id, kind, payload_json, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, ownerId, input.publicationId ?? null, input.versionId ?? null, input.kind, JSON.stringify(input.payload ?? {}), input.dedupeKey),
      auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "job.created", resourceType: "job", resourceId: id }),
    ]);
  } catch { return conflictOrFailure(env, ownerId, packet); }
  await enqueueJobRecord(env, ownerId, id, input.kind);
  return Response.json({ status: 201, body });
}

async function cancelJob(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const id = (packet.mutation.data as Extract<OperationsMutation, { operation: "cancel-job" }>["data"]).jobId;
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ? AND owner_id = ? AND status IN ('queued', 'retrying')").bind(id, ownerId).first();
  if (!job) return terminal(env, ownerId, packet, 409, { error: "job_not_cancellable" });
  const body = { id, status: "cancelled" };
  try { await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, 200, body), env.DB.prepare("UPDATE jobs SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(id, ownerId), auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "job.cancelled", resourceType: "job", resourceId: id })]); } catch { return conflictOrFailure(env, ownerId, packet); }
  return Response.json({ status: 200, body });
}

async function retryJob(env: Env, ownerId: string, packet: Packet): Promise<Response> {
  const id = (packet.mutation.data as Extract<OperationsMutation, { operation: "retry-job" }>["data"]).jobId;
  const job = await env.DB.prepare("SELECT kind FROM jobs WHERE id = ? AND owner_id = ? AND status IN ('failed', 'dead_lettered', 'cancelled')").bind(id, ownerId).first<{ kind: JobKind }>();
  if (!job) return terminal(env, ownerId, packet, 409, { error: "job_not_retryable" });
  const body = { id, status: "queued" };
  try { await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, 200, body), env.DB.prepare("UPDATE jobs SET status = 'queued', error_code = NULL, cancelled_at = NULL, retention_until = NULL, enqueue_lease_expires_at = NULL, last_enqueued_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(id, ownerId), auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "job.retried", resourceType: "job", resourceId: id })]); } catch { return conflictOrFailure(env, ownerId, packet); }
  await enqueueJobRecord(env, ownerId, id, job.kind);
  return Response.json({ status: 200, body });
}

async function terminal(env: Env, ownerId: string, packet: Packet, status: number, body: Record<string, unknown>): Promise<Response> { try { await env.DB.batch([idempotencyReceiptStatement(env.DB, ownerId, packet, status, body)]); return Response.json({ status, body }); } catch { return conflictOrFailure(env, ownerId, packet); } }
async function conflictOrFailure(env: Env, ownerId: string, packet: Packet): Promise<Response> { const existing = await findIdempotencyReceipt(env.DB, ownerId, packet.idempotencyKey); return existing ? Response.json(resolveIdempotencyReceipt(existing, packet.fingerprint)) : Response.json({ status: 502, body: { error: "mutation_failed" } }); }
