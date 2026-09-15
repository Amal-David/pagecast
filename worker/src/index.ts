import {
  deriveTokenSecret,
  digestToken,
  parseBearerAuthorization,
  parseScopes,
  requestFingerprint,
  timingSafeEqual,
  type AuthActor,
} from "./auth";
import { auditStatement } from "./audit";
import { verifyAccessIdentity } from "./access";
import { readBoundedTextBody } from "./body";
import { activeMembership, executeCollaborationMutation, isCollaborationMutation, roleAllows, type CollaborationAction, type CollaborationMutation } from "./collaboration";
import { cleanupPublicationStorage, createUnlistedSlug, executePublicationMutation, normalizePath, validOwnerId, type PublicationMutation, type PublicationMutationPacket } from "./publications";
import { handlePublicDelivery, hashPassword } from "./public";
import { cleanupAnalytics, handleAnalyticsControl } from "./analytics";
import { processJobMessage, recoverJobMessage, scheduledJobs, webhookSecret } from "./jobs";
import { handleMcpRequest } from "./mcp";
import { executeOperationsMutation, type OperationsMutation } from "./operations";
import type { Env, JobMessage } from "./types";
import { handleCollaborationRoute } from "./control-collaboration";
import type { ControlRouteContext } from "./control-context";
import { handleOperationsRoute } from "./control-operations";
import { handlePublicationRoute } from "./control-publications";

type OwnerMutation =
  | { kind: "create-token"; id: string; label: string; scopes: string[]; expiresAt: string | null; actorId: string | null; tokenHash: string }
  | { kind: "revoke-token"; tokenId: string }
  | { kind: "coordinate" }
  | OperationsMutation
  | PublicationMutation
  | CollaborationMutation;

interface OwnerMutationPacket {
  actorId: string | null;
  isBootstrap?: boolean;
  fingerprint: string;
  idempotencyKey: string;
  mutation: OwnerMutation;
}

export class PublicationOwner {
  private readonly presence = new Map<string, Map<string, PresencePeer>>();
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        durableObject: "publication-owner",
        id: this.state.id.toString(),
        environment: this.env.ENVIRONMENT,
      });
    }
    if (url.pathname === "/presence") return this.handlePresence(request);
    if (request.method !== "POST" || !["/mutate", "/control"].includes(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    const ownerId = request.headers.get("X-Pagecast-Owner");
    if (!ownerId) {
      return Response.json({ error: "owner_required" }, { status: 400 });
    }

    return this.state.blockConcurrencyWhile(async () => {
      if (url.pathname === "/control") {
        const packet = await request.json<OwnerMutationPacket>();
        return executeOwnerMutation(this.state, this.env, ownerId, packet);
      }
      const sequence = ((await this.state.storage.get<number>("mutation-sequence")) ?? 0) + 1;
      await this.state.storage.put("mutation-sequence", sequence);
      return Response.json({ ownerId, sequence });
    });
  }

  private handlePresence(request: Request): Response {
    const ownerId = request.headers.get("X-Pagecast-Owner");
    const publicationId = request.headers.get("X-Pagecast-Publication");
    const actorId = request.headers.get("X-Pagecast-Actor");
    if (!ownerId || !publicationId || !actorId || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "presence_upgrade_required" }, { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const key = `${ownerId}:${publicationId}`;
    const peers = this.presence.get(key) ?? new Map<string, PresencePeer>();
    const existing = peers.get(actorId);
    if (!existing && peers.size >= MAX_PRESENCE_PEERS) {
      return Response.json({ error: "presence_room_full" }, { status: 429 });
    }
    existing?.socket.close(1000, "presence_replaced");
    const peer: PresencePeer = { socket: server, messages: 0, windowStartedAt: Date.now(), idleTimer: undefined };
    peers.set(actorId, peer);
    this.presence.set(key, peers);
    server.accept();
    const remove = () => {
      if (peer.idleTimer !== undefined) clearTimeout(peer.idleTimer);
      if (peers.get(actorId) === peer) peers.delete(actorId);
      if (peers.size === 0) this.presence.delete(key);
    };
    const resetIdleTimer = () => {
      if (peer.idleTimer !== undefined) clearTimeout(peer.idleTimer);
      peer.idleTimer = setTimeout(() => {
        server.close(1000, "presence_idle_timeout");
        remove();
      }, PRESENCE_IDLE_TIMEOUT_MS);
    };
    resetIdleTimer();
    server.addEventListener("close", remove);
    server.addEventListener("error", remove);
    server.addEventListener("message", (event) => {
      const bytes = presenceMessageBytes(event.data);
      const now = Date.now();
      if (now - peer.windowStartedAt >= PRESENCE_MESSAGE_WINDOW_MS) {
        peer.windowStartedAt = now;
        peer.messages = 0;
      }
      if (bytes > MAX_PRESENCE_MESSAGE_BYTES || ++peer.messages > MAX_PRESENCE_MESSAGES_PER_WINDOW) {
        server.close(1008, "presence_message_limit");
        remove();
        return;
      }
      resetIdleTimer();
      const body = JSON.stringify({ type: "presence", actorId, count: peers.size });
      for (const recipient of peers.values()) recipient.socket.send(body);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

const MAX_PRESENCE_PEERS = 32;
const MAX_PRESENCE_MESSAGE_BYTES = 1024;
const MAX_PRESENCE_MESSAGES_PER_WINDOW = 10;
const PRESENCE_MESSAGE_WINDOW_MS = 10_000;
const PRESENCE_IDLE_TIMEOUT_MS = 60_000;

interface PresencePeer {
  socket: WebSocket;
  messages: number;
  windowStartedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

function presenceMessageBytes(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return MAX_PRESENCE_MESSAGE_BYTES + 1;
}

async function expireTransientRows(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM idempotency_keys WHERE id IN (SELECT id FROM idempotency_keys WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 100)")
    .run();
  await db.prepare("DELETE FROM access_grants WHERE id IN (SELECT id FROM access_grants WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 100)").run();
  await db.prepare("DELETE FROM password_attempts WHERE rowid IN (SELECT rowid FROM password_attempts WHERE window_started_at <= datetime('now', '-30 minutes') ORDER BY window_started_at LIMIT 100)").run();
}

interface TokenRow {
  id: string;
  owner_id: string;
  token_hash: string;
  scopes_json: string;
  expires_at: string | null;
  actor_id: string | null;
  revoked_at: string | null;
}

interface TokenQuota {
  max_tokens: number;
}

interface IdempotencyReceipt {
  request_hash: string;
  response_body: string | null;
  response_status: number | null;
}

async function executeOwnerMutation(
  state: DurableObjectState,
  env: Env,
  ownerId: string,
  packet: OwnerMutationPacket,
): Promise<Response> {
  if (isPublicationMutationPacket(packet)) {
    return executePublicationMutation(env, ownerId, packet);
  }
  if (isCollaborationMutation(packet.mutation)) {
    return executeCollaborationMutation(env.DB, ownerId, {
      actorId: packet.actorId,
      isBootstrap: packet.isBootstrap === true,
      fingerprint: packet.fingerprint,
      idempotencyKey: packet.idempotencyKey,
      mutation: packet.mutation,
    });
  }
  if (isOperationsMutation(packet)) {
    return executeOperationsMutation(env, ownerId, packet);
  }
  const existing = await env.DB
    .prepare("SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE owner_id = ? AND idempotency_key = ?")
    .bind(ownerId, packet.idempotencyKey)
    .first<IdempotencyReceipt>();
  if (existing) {
    return ownerReceiptResponse(existing, packet.fingerprint);
  }

  if (packet.mutation.kind === "coordinate") {
    const sequence = ((await state.storage.get<number>("mutation-sequence")) ?? 0) + 1;
    await state.storage.put("mutation-sequence", sequence);
    const body = { ownerId, sequence };
    try {
      await env.DB.batch([
        env.DB
          .prepare("INSERT INTO idempotency_keys (id, owner_id, idempotency_key, request_hash, response_status, response_body, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))")
          .bind(crypto.randomUUID(), ownerId, packet.idempotencyKey, packet.fingerprint, 200, JSON.stringify(body)),
      ]);
    } catch {
      return mutationFailure();
    }
    return Response.json({ status: 200, body });
  }

  if (packet.mutation.kind === "create-token") {
    if (packet.mutation.actorId) {
      const actor = await env.DB.prepare("SELECT id FROM collaboration_actors WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
        .bind(packet.mutation.actorId, ownerId).first();
      if (!actor) return writeTerminalReceipt(env.DB, ownerId, packet, 400, { error: "token_actor_not_found" });
    }
    const quota = await env.DB.prepare("SELECT max_tokens FROM owner_quotas WHERE owner_id = ?").bind(ownerId).first<TokenQuota>();
    const active = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM api_tokens WHERE owner_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)")
      .bind(ownerId)
      .first<{ count: number }>();
    if ((active?.count ?? 0) >= (quota?.max_tokens ?? 10)) {
      return writeTerminalReceipt(env.DB, ownerId, packet, 429, { error: "token_quota_exceeded" });
    }

    const body = {
      id: packet.mutation.id,
      label: packet.mutation.label,
      scopes: packet.mutation.scopes,
      expiresAt: packet.mutation.expiresAt,
      actorId: packet.mutation.actorId,
    };
    try {
      await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO owners (id) VALUES (?)").bind(ownerId),
      env.DB.prepare("INSERT OR IGNORE INTO owner_quotas (owner_id) VALUES (?)").bind(ownerId),
      env.DB
        .prepare("INSERT INTO idempotency_keys (id, owner_id, idempotency_key, request_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+24 hours'))")
        .bind(crypto.randomUUID(), ownerId, packet.idempotencyKey, packet.fingerprint),
      packet.mutation.actorId
        ? env.DB.prepare("INSERT INTO api_tokens (id, owner_id, token_hash, label, scopes_json, expires_at, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(packet.mutation.id, ownerId, packet.mutation.tokenHash, packet.mutation.label, JSON.stringify(packet.mutation.scopes), packet.mutation.expiresAt, packet.mutation.actorId)
        : env.DB.prepare("INSERT INTO api_tokens (id, owner_id, token_hash, label, scopes_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(packet.mutation.id, ownerId, packet.mutation.tokenHash, packet.mutation.label, JSON.stringify(packet.mutation.scopes), packet.mutation.expiresAt),
      auditStatement(env.DB, {
        ownerId,
        actorId: packet.actorId,
        action: "token.created",
        resourceType: "api_token",
        resourceId: packet.mutation.id,
        metadata: { label: packet.mutation.label, scopes: packet.mutation.scopes },
      }),
      env.DB
        .prepare("UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE owner_id = ? AND idempotency_key = ?")
        .bind(201, JSON.stringify(body), ownerId, packet.idempotencyKey),
      ]);
    } catch {
      return mutationFailure();
    }
    return Response.json({ status: 201, body });
  }

  if (packet.mutation.kind !== "revoke-token") {
    return mutationFailure();
  }

  const token = await env.DB
    .prepare("SELECT id FROM api_tokens WHERE id = ? AND owner_id = ? AND revoked_at IS NULL")
    .bind(packet.mutation.tokenId, ownerId)
    .first<{ id: string }>();
  if (!token) {
    return writeTerminalReceipt(env.DB, ownerId, packet, 404, { error: "token_not_found" });
  }
  const body = { id: packet.mutation.tokenId, revoked: true };
  try {
    await env.DB.batch([
    env.DB
      .prepare("INSERT INTO idempotency_keys (id, owner_id, idempotency_key, request_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+24 hours'))")
      .bind(crypto.randomUUID(), ownerId, packet.idempotencyKey, packet.fingerprint),
    env.DB.prepare("UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(packet.mutation.tokenId, ownerId),
    auditStatement(env.DB, {
      ownerId,
      actorId: packet.actorId,
      action: "token.revoked",
      resourceType: "api_token",
      resourceId: packet.mutation.tokenId,
    }),
    env.DB
      .prepare("UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE owner_id = ? AND idempotency_key = ?")
      .bind(200, JSON.stringify(body), ownerId, packet.idempotencyKey),
    ]);
  } catch {
    return mutationFailure();
  }
  return Response.json({ status: 200, body });
}

function isPublicationMutationPacket(packet: OwnerMutationPacket): packet is PublicationMutationPacket {
  return packet.mutation.kind === "publication";
}

function isOperationsMutation(packet: OwnerMutationPacket): packet is OwnerMutationPacket & { mutation: OperationsMutation } {
  return packet.mutation.kind === "operations";
}

async function writeTerminalReceipt(
  db: D1Database,
  ownerId: string,
  packet: OwnerMutationPacket,
  status: number,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO owners (id) VALUES (?)").bind(ownerId),
      db.prepare("INSERT OR IGNORE INTO owner_quotas (owner_id) VALUES (?)").bind(ownerId),
      db
        .prepare("INSERT INTO idempotency_keys (id, owner_id, idempotency_key, request_hash, response_status, response_body, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))")
        .bind(crypto.randomUUID(), ownerId, packet.idempotencyKey, packet.fingerprint, status, JSON.stringify(body)),
    ]);
  } catch {
    return mutationFailure();
  }
  return Response.json({ status, body });
}

function mutationFailure(): Response {
  return Response.json({ status: 502, body: { error: "mutation_failed" } });
}

function ownerReceiptResponse(receipt: IdempotencyReceipt, fingerprint: string): Response {
  if (receipt.request_hash !== fingerprint) {
    return Response.json({ status: 409, body: { error: "idempotency_key_conflict" } });
  }
  if (receipt.response_status === null || receipt.response_body === null) {
    return Response.json({ status: 409, body: { error: "idempotency_operation_in_progress" } });
  }
  return Response.json({ status: receipt.response_status, body: JSON.parse(receipt.response_body) as Record<string, unknown> });
}

function error(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

function controlOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}

async function authenticate(request: Request, env: Env): Promise<AuthActor | null> {
  const credential = parseBearerAuthorization(request.headers.get("Authorization"));
  if (!credential) {
    return null;
  }
  if (timingSafeEqual(credential, env.ADMIN_TOKEN)) {
    return { kind: "bootstrap", ownerId: null, scopes: ["*"] };
  }

  const tokenMatch = /^pcv2_([0-9a-f-]{36})_([A-Za-z0-9_-]{32,})$/.exec(credential);
  if (!tokenMatch) {
    return null;
  }
  const [, tokenId, tokenSecret] = tokenMatch;
  const token = await env.DB
    .prepare(
      "SELECT id, owner_id, token_hash, scopes_json, expires_at, revoked_at, actor_id FROM api_tokens WHERE id = ?",
    )
    .bind(tokenId)
    .first<TokenRow>();
  if (!token || token.revoked_at || (token.expires_at !== null && Date.parse(token.expires_at) <= Date.now())) {
    return null;
  }
  const expectedDigest = await digestToken(env.TOKEN_HASH_KEY, tokenId, tokenSecret);
  if (!timingSafeEqual(expectedDigest, token.token_hash)) {
    return null;
  }

  const scopes = parseScopes(token.scopes_json);
  if (!scopes) {
    return null;
  }
  await env.DB
    .prepare("UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-5 minutes'))")
    .bind(tokenId)
    .run();
  return { kind: "token", ownerId: token.owner_id, tokenId, actorId: token.actor_id ?? null, scopes };
}

function hasScope(actor: AuthActor, scope: string): boolean {
  return actor.kind === "bootstrap" || actor.scopes.includes("*") || actor.scopes.includes(scope);
}

function owns(actor: AuthActor, ownerId: string): boolean {
  return validOwnerId(ownerId) && (actor.kind === "bootstrap" || actor.ownerId === ownerId);
}

const MAX_CONTROL_BODY_BYTES = 16 * 1024;

async function readControlBody(request: Request): Promise<{ body: string } | { tooLarge: true }> {
  return readBoundedTextBody(request, MAX_CONTROL_BODY_BYTES);
}

async function parseJson(request: Request): Promise<{ payload: Record<string, unknown>; raw: string } | { tooLarge: true } | null> {
  const body = await readControlBody(request);
  if ("tooLarge" in body) {
    return body;
  }
  try {
    const value: unknown = JSON.parse(body.body);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? { payload: value as Record<string, unknown>, raw: body.body } : null;
  } catch {
    return null;
  }
}

function validScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((scope) => (
    typeof scope === "string" && /^[a-z][a-z0-9:_-]{0,63}$/.test(scope)
  ));
}

async function invokeOwnerMutation(
  request: Request,
  env: Env,
  ownerId: string,
  rawBody: string,
  mutation: OwnerMutation,
  actor: AuthActor,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey || !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
    return { status: 400, body: { error: "idempotency_key_required" } };
  }
  const fingerprint = await requestFingerprint(request.method, new URL(request.url).pathname, ownerId, rawBody);
  const coordinator = env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName(ownerId));
  const response = await coordinator.fetch(new Request("https://pagecast.internal/control", {
    method: "POST",
    headers: { "X-Pagecast-Owner": ownerId, "content-type": "application/json" },
    body: JSON.stringify({
      actorId: actor.kind === "token" ? actor.tokenId : null,
      isBootstrap: actor.kind === "bootstrap",
      fingerprint,
      idempotencyKey,
      mutation,
    } satisfies OwnerMutationPacket),
  }));
  if (!response.ok) {
    return { status: 502, body: { error: "coordinator_unavailable" } };
  }
  return response.json<{ status: number; body: Record<string, unknown> }>();
}

function actorId(actor: AuthActor): string | null {
  return actor.kind === "token" ? actor.actorId : null;
}

async function collaborationAllowed(env: Env, actor: AuthActor, ownerId: string, action: CollaborationAction, identity: { subject: string } | null): Promise<boolean> {
  if (actor.kind === "bootstrap") return true;
  if (!actor.actorId) return false;
  const membership = await activeMembership(env.DB, ownerId, actor.actorId);
  if (!membership || !roleAllows(membership.role, action)) return false;
  if (!identity) return true;
  const linked = await env.DB.prepare("SELECT id FROM collaboration_actors WHERE id = ? AND owner_id = ? AND external_subject = ? AND deleted_at IS NULL")
    .bind(actor.actorId, ownerId, identity.subject).first();
  return Boolean(linked);
}

async function collaborationAdmin(env: Env, actor: AuthActor, ownerId: string, identity: { subject: string } | null): Promise<boolean> {
  if (actor.kind === "bootstrap") return true;
  if (!actor.actorId || !hasScope(actor, "collaboration:admin")) return false;
  const membership = await activeMembership(env.DB, ownerId, actor.actorId);
  if (!membership || membership.role !== "owner") return false;
  if (!identity) return true;
  return Boolean(await env.DB.prepare("SELECT id FROM collaboration_actors WHERE id = ? AND owner_id = ? AND external_subject = ? AND deleted_at IS NULL")
    .bind(actor.actorId, ownerId, identity.subject).first());
}

async function invokeCollaborationMutation(request: Request, env: Env, actor: AuthActor, ownerId: string, rawBody: string, mutation: CollaborationMutation): Promise<Response> {
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey || !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) return error("idempotency_key_required", 400);
  const fingerprint = await requestFingerprint(request.method, new URL(request.url).pathname, ownerId, rawBody);
  const coordinator = env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName(ownerId));
  const response = await coordinator.fetch(new Request("https://pagecast.internal/control", {
    method: "POST",
    headers: { "X-Pagecast-Owner": ownerId, "content-type": "application/json" },
    body: JSON.stringify({ actorId: actorId(actor), isBootstrap: actor.kind === "bootstrap", fingerprint, idempotencyKey, mutation } satisfies OwnerMutationPacket),
  }));
  if (!response.ok) return error("coordinator_unavailable", 502);
  const result = await response.json<{ status: number; body: Record<string, unknown> }>();
  return Response.json(result.body, { status: result.status });
}

async function collaborationGrantAllows(env: Env, request: Request, ownerId: string, publicationId: string, versionId: string | null, action: CollaborationAction, required = false): Promise<boolean> {
  const credential = request.headers.get("X-Pagecast-Grant");
  if (!credential) return !required;
  const match = /^pcg2_([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{32,})$/.exec(credential);
  if (!match) return false;
  const [, grantId, secret] = match;
  const digest = await digestToken(env.TOKEN_HASH_KEY, grantId, secret);
  const grant = await env.DB.prepare("SELECT actions_json, version_id FROM collaboration_grants WHERE id = ? AND owner_id = ? AND publication_id = ? AND credential_digest = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)")
    .bind(grantId, ownerId, publicationId, digest).first<{ actions_json: string; version_id: string | null }>();
  if (!grant || (grant.version_id !== null && grant.version_id !== versionId)) return false;
  const grantActions = parseScopes(grant.actions_json);
  return grantActions?.includes(action) ?? false;
}

async function handlePresence(request: Request, env: Env, actor: AuthActor, ownerId: string, publicationId: string, identity: { subject: string } | null): Promise<Response> {
  if (actor.kind !== "token" || !actor.actorId || !hasScope(actor, "presence:connect") || !(await collaborationAllowed(env, actor, ownerId, "publication:view", identity))) return error("forbidden", 403);
  const publication = await env.DB.prepare("SELECT id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first();
  if (!publication) return error("publication_not_found", 404);
  const stub = env.PUBLICATION_OWNER.get(env.PUBLICATION_OWNER.idFromName(ownerId));
  return stub.fetch(new Request("https://pagecast.internal/presence", { headers: { Upgrade: request.headers.get("Upgrade") ?? "", "X-Pagecast-Owner": ownerId, "X-Pagecast-Publication": publicationId, "X-Pagecast-Actor": actor.actorId } }));
}

async function createToken(
  request: Request,
  env: Env,
  actor: AuthActor,
  ownerId: string,
): Promise<Response> {
  const parsed = await parseJson(request);
  if (parsed && "tooLarge" in parsed) {
    return error("payload_too_large", 413);
  }
  const payload = parsed?.payload;
  if (actor.kind === "token" && Array.isArray(payload?.scopes) && (payload.scopes.includes("*") || payload.scopes.some((scope) => !actor.scopes.includes(scope)))) {
    return error("forbidden", 403);
  }
  if (!payload || typeof payload.label !== "string" || payload.label.length < 1 || payload.label.length > 100 || !validScopes(payload.scopes)) {
    return error("invalid_token_request", 400);
  }
  if (Object.keys(payload).some((key) => !["label", "scopes", "expiresAt", "actorId"].includes(key))) {
    return error("invalid_token_request", 400);
  }
  const expiresAt = payload.expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    return error("invalid_token_expiry", 400);
  }
  const assignedActorId = payload.actorId === undefined ? null : payload.actorId;
  if (assignedActorId !== null && (typeof assignedActorId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(assignedActorId))) return error("invalid_token_actor", 400);
  if (actor.kind === "token" && assignedActorId !== null && assignedActorId !== actor.actorId) return error("forbidden", 403);
  const id = crypto.randomUUID();
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
  const secret = await deriveTokenSecret(env.TOKEN_HASH_KEY, id, idempotencyKey);
  const result = await invokeOwnerMutation(request, env, ownerId, parsed!.raw, {
    kind: "create-token",
    id,
    label: payload.label,
    scopes: payload.scopes,
    expiresAt: expiresAt ?? null,
    actorId: assignedActorId,
    tokenHash: await digestToken(env.TOKEN_HASH_KEY, id, secret),
  }, actor);
  if (result.status !== 201 || typeof result.body.id !== "string") {
    return Response.json(result.body, { status: result.status });
  }
  const replaySecret = await deriveTokenSecret(env.TOKEN_HASH_KEY, result.body.id, idempotencyKey);
  return Response.json({ ...result.body, token: `pcv2_${result.body.id}_${replaySecret}` }, { status: result.status });
}

async function listTokens(env: Env, ownerId: string): Promise<Response> {
  const { results } = await env.DB
    .prepare("SELECT id, label, scopes_json, expires_at, revoked_at, last_used_at, created_at FROM api_tokens WHERE owner_id = ? ORDER BY created_at DESC")
    .bind(ownerId)
    .all<Record<string, unknown>>();
  return Response.json({ tokens: results.flatMap((token) => {
    const scopes = parseScopes(String(token.scopes_json));
    return scopes ? [{
      id: token.id,
      label: token.label,
      scopes,
      expiresAt: token.expires_at,
      revokedAt: token.revoked_at,
      lastUsedAt: token.last_used_at,
      createdAt: token.created_at,
    }] : [];
  }) });
}

async function revokeToken(request: Request, env: Env, actor: AuthActor, ownerId: string, tokenId: string): Promise<Response> {
  const result = await invokeOwnerMutation(request, env, ownerId, "", { kind: "revoke-token", tokenId }, actor);
  return Response.json(result.body, { status: result.status });
}

async function coordinateMutation(request: Request, env: Env, ownerId: string): Promise<Response> {
  const body = await readControlBody(request);
  if ("tooLarge" in body) {
    return error("payload_too_large", 413);
  }
  const result = await invokeOwnerMutation(request, env, ownerId, body.body, { kind: "coordinate" }, { kind: "bootstrap", ownerId: null, scopes: ["*"] });
  return Response.json(result.body, { status: result.status });
}

async function createUploadSession(request: Request, env: Env, actor: AuthActor, ownerId: string): Promise<Response> {
  const parsed = await parseJson(request);
  if (!parsed || "tooLarge" in parsed) return error(parsed && "tooLarge" in parsed ? "payload_too_large" : "invalid_upload_manifest", parsed && "tooLarge" in parsed ? 413 : 400);
  const payload = parsed.payload;
  const createsLink = payload.mode === "create" || payload.mode === "context-upsert" || payload.mode === "new-link";
  const slug = createsLink && payload.linkKind === "unlisted" && typeof payload.slug === "string"
    ? createUnlistedSlug(payload.slug)
    : payload.slug;
  if (createsLink && payload.linkKind === "unlisted" && slug === null) {
    return error("invalid_upload_manifest", 400);
  }
  const existingPublicationId = typeof payload.publicationId === "string" ? payload.publicationId : undefined;
  const result = await invokeOwnerMutation(request, env, ownerId, parsed.raw, {
    kind: "publication",
    operation: "create-session",
    data: {
      mode: payload.mode,
      title: payload.title,
      slug,
      linkKind: payload.linkKind,
      manifest: payload.manifest,
      contextKey: payload.contextKey,
      existingPublicationId,
      publicationId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    },
  }, actor);
  return Response.json(result.body, { status: result.status });
}

interface UploadFileRow {
  r2_key: string;
  expected_bytes: number;
  expected_sha256: string;
  content_type: string;
  status: string;
}

async function uploadSessionFile(request: Request, env: Env, actor: AuthActor, ownerId: string, sessionId: string, encodedPath: string): Promise<Response> {
  let path: string;
  try { path = decodeURIComponent(encodedPath); } catch { return error("invalid_upload_path", 400); }
  path = normalizePath(path) ?? "";
  if (!path || !request.body) return error("invalid_upload_path", 400);
  const file = await env.DB.prepare("SELECT f.r2_key, f.expected_bytes, f.expected_sha256, f.content_type, s.status FROM upload_session_files f JOIN upload_sessions s ON s.id = f.session_id WHERE f.session_id = ? AND f.normalized_path = ? AND s.owner_id = ? AND s.expires_at > CURRENT_TIMESTAMP")
    .bind(sessionId, path, ownerId).first<UploadFileRow>();
  if (!file) return error("upload_file_not_found", 404);
  if (file.status !== "open") return error("upload_session_closed", 409);
  if (request.headers.get("content-type") !== file.content_type || request.headers.get("X-Content-SHA256") !== file.expected_sha256) return error("upload_file_mismatch", 409);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== file.expected_bytes) return error("upload_file_mismatch", 409);
  try {
    const stored = await env.PUBLICATIONS.put(file.r2_key, request.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: file.expected_sha256,
      httpMetadata: { contentType: file.content_type },
      customMetadata: { sha256: file.expected_sha256 },
    });
    const object = stored ?? await env.PUBLICATIONS.head(file.r2_key);
    if (!object || object.size !== file.expected_bytes || object.httpMetadata?.contentType !== file.content_type || object.customMetadata?.sha256 !== file.expected_sha256) {
      if (stored) await env.PUBLICATIONS.delete(file.r2_key);
      return error("upload_file_mismatch", 409);
    }
  } catch (cause) {
    return error(/checksum/i.test(String(cause)) ? "upload_file_mismatch" : "upload_write_failed", /checksum/i.test(String(cause)) ? 409 : 502);
  }
  const mutationRequest = new Request(request.url, { method: request.method, headers: { "Idempotency-Key": request.headers.get("Idempotency-Key") ?? `upload:${sessionId}:${path}:${file.expected_sha256}` } });
  const fileData = { sessionId, path, bytes: file.expected_bytes, sha256: file.expected_sha256 };
  const result = await invokeOwnerMutation(mutationRequest, env, ownerId, JSON.stringify(fileData), { kind: "publication", operation: "record-file", data: fileData }, actor);
  return Response.json(result.body, { status: result.status });
}

async function completeUploadSession(request: Request, env: Env, actor: AuthActor, ownerId: string, sessionId: string): Promise<Response> {
  const result = await invokeOwnerMutation(request, env, ownerId, "", { kind: "publication", operation: "complete-session", data: { sessionId } }, actor);
  return Response.json(result.body, { status: result.status });
}

async function publicationMutation(request: Request, env: Env, actor: AuthActor, ownerId: string, mutation: PublicationMutation): Promise<Response> {
  const raw = JSON.stringify(mutation.data);
  const result = await invokeOwnerMutation(request, env, ownerId, raw, mutation, actor);
  return Response.json(result.body, { status: result.status });
}

async function operationsMutation(request: Request, env: Env, actor: AuthActor, ownerId: string, mutation: OperationsMutation): Promise<Response> {
  const result = await invokeOwnerMutation(request, env, ownerId, JSON.stringify(mutation.data), mutation, actor);
  const body = result.body;
  if ((mutation.operation === "create-webhook" || mutation.operation === "rotate-webhook") && typeof body.id === "string" && typeof body.credentialVersion === "number" && result.status >= 200 && result.status < 300) {
    return Response.json({ ...body, secret: `pcwh_${body.id}.${await webhookSecret(env, body.id, body.credentialVersion)}` }, { status: result.status });
  }
  return Response.json(body, { status: result.status });
}

async function listVersions(env: Env, ownerId: string, publicationId: string, url: URL): Promise<Response> {
  const publication = await env.DB.prepare("SELECT id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first<{ id: string }>();
  if (!publication) return error("publication_not_found", 404);
  const beforeValue = url.searchParams.get("before");
  const before = beforeValue === null ? null : Number(beforeValue);
  if (beforeValue !== null && (!Number.isSafeInteger(before) || Number(before) < 1)) return error("invalid_cursor", 400);
  const versions = await env.DB.prepare("SELECT id, version_number, status, is_complete, created_at, published_at FROM publication_versions WHERE publication_id = ? AND owner_id = ? AND deleted_at IS NULL AND (? IS NULL OR version_number < ?) ORDER BY version_number DESC LIMIT 100")
    .bind(publicationId, ownerId, before, before).all<Record<string, unknown>>();
  const items = versions.results.map((version) => ({ id: version.id, versionNumber: version.version_number, status: version.status, complete: Boolean(version.is_complete), createdAt: version.created_at, publishedAt: version.published_at }));
  return Response.json({ versions: items, nextCursor: items.length === 100 ? items.at(-1)!.versionNumber : null });
}

async function updateAccessPolicy(request: Request, env: Env, actor: AuthActor, ownerId: string, publicationId: string): Promise<Response> {
  const parsed = await parseJson(request);
  if (!parsed || "tooLarge" in parsed) return error(parsed && "tooLarge" in parsed ? "payload_too_large" : "invalid_access_policy", parsed && "tooLarge" in parsed ? 413 : 400);
  const { mode, approvalState = "approved", password, expiresAt } = parsed.payload;
  const changesExpiry = Object.prototype.hasOwnProperty.call(parsed.payload, "expiresAt");
  if (!(mode === "public" || mode === "unlisted" || mode === "password" || mode === "allowlist") || !(approvalState === "approved" || approvalState === "pending" || approvalState === "rejected") ||
    (mode === "password" && (typeof password !== "string" || password.length < 12 || password.length > 1024)) ||
    (changesExpiry && expiresAt !== null && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) ||
    Object.keys(parsed.payload).some((key) => !["mode", "approvalState", "password", "expiresAt"].includes(key))) {
    return error("invalid_access_policy", 400);
  }
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
  const salt = mode === "password" ? await deriveTokenSecret(env.TOKEN_HASH_KEY, `access-policy:${publicationId}`, idempotencyKey) : null;
  const iterations = mode === "password" ? 100_000 : null;
  const result = await publicationMutation(request, env, actor, ownerId, {
    kind: "publication",
    operation: "set-access-policy",
    data: {
      publicationId,
      mode,
      approvalState,
      passwordHash: mode === "password" ? await hashPassword(password as string, salt!, iterations!) : null,
      passwordSalt: salt,
      passwordIterations: iterations,
      ...(changesExpiry ? { expiresAt } : {}),
    },
  });
  return result;
}

async function createAccessGrant(request: Request, env: Env, actor: AuthActor, ownerId: string, publicationId: string): Promise<Response> {
  const parsed = await parseJson(request);
  if (!parsed || "tooLarge" in parsed) return error(parsed && "tooLarge" in parsed ? "payload_too_large" : "invalid_access_grant", parsed && "tooLarge" in parsed ? 413 : 400);
  const { permission, expiresAt = null } = parsed.payload;
  if (!(permission === "view" || permission === "comment" || permission === "edit") || (expiresAt !== null && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) || Object.keys(parsed.payload).some((key) => !["permission", "expiresAt"].includes(key))) return error("invalid_access_grant", 400);
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
  const grantId = await deriveTokenSecret(env.TOKEN_HASH_KEY, `access-grant:${publicationId}`, idempotencyKey);
  const secret = await deriveTokenSecret(env.TOKEN_HASH_KEY, grantId, idempotencyKey);
  const response = await publicationMutation(request, env, actor, ownerId, {
    kind: "publication",
    operation: "create-grant",
    data: {
      publicationId,
      grantId,
      credentialHash: await digestToken(env.TOKEN_HASH_KEY, grantId, secret),
      permission,
      expiresAt,
    },
  });
  if (response.status !== 201) return response;
  const body = await response.json() as { id?: string };
  if (!body.id) return error("mutation_failed", 502);
  const replaySecret = await deriveTokenSecret(env.TOKEN_HASH_KEY, body.id, idempotencyKey);
  return Response.json({ ...body, credential: `pcg_${body.id}.${replaySecret}` }, { status: 201 });
}

async function revokeAccessGrant(request: Request, env: Env, actor: AuthActor, ownerId: string, publicationId: string, grantId: string): Promise<Response> {
  return publicationMutation(request, env, actor, ownerId, { kind: "publication", operation: "revoke-grant", data: { publicationId, grantId } });
}

async function handleControl(request: Request, env: Env, url: URL): Promise<Response> {
  if (!controlOriginAllowed(request)) {
    return error("cross_origin_control_request", 403);
  }
  const actor = await authenticate(request, env);
  if (!actor) {
    return error("unauthorized", 401);
  }
  const accessIdentity = request.headers.has("Cf-Access-Jwt-Assertion") ? await verifyAccessIdentity(request, env) : null;
  if (request.headers.has("Cf-Access-Jwt-Assertion") && !accessIdentity) return error("invalid_access_identity", 401);
  const analyticsResponse = await handleAnalyticsControl(request, env, url, actor);
  if (analyticsResponse) return analyticsResponse;
  if (url.pathname === "/v1/status" && request.method === "GET") {
    if (!hasScope(actor, "status:read")) {
      return error("forbidden", 403);
    }
    return Response.json({ service: "pagecast", status: "ok", apiVersion: 2, capabilities: ["publications.upload", "publications.access", "publications.versions"], actor: actor.kind, ownerId: actor.ownerId });
  }

  const routeContext: ControlRouteContext = {
    request,
    env,
    url,
    actor,
    accessIdentity,
    error,
    owns: (ownerId) => owns(actor, ownerId),
    hasScope: (scope) => hasScope(actor, scope),
    parseJson: () => parseJson(request),
    collaborationAdmin: (ownerId) => collaborationAdmin(env, actor, ownerId, accessIdentity),
    collaborationAllowed: (ownerId, action) => collaborationAllowed(env, actor, ownerId, action, accessIdentity),
    collaborationGrantAllows: (ownerId, publicationId, versionId, action, required) => collaborationGrantAllows(env, request, ownerId, publicationId, versionId, action, required),
    invokeCollaborationMutation: (ownerId, rawBody, mutation) => invokeCollaborationMutation(request, env, actor, ownerId, rawBody, mutation),
    handlePresence: (ownerId, publicationId) => handlePresence(request, env, actor, ownerId, publicationId, accessIdentity),
    listTokens: (ownerId) => listTokens(env, ownerId),
    createToken: (ownerId) => createToken(request, env, actor, ownerId),
    revokeToken: (ownerId, tokenId) => revokeToken(request, env, actor, ownerId, tokenId),
    coordinateMutation: (ownerId) => coordinateMutation(request, env, ownerId),
    operationsMutation: (ownerId, mutation) => operationsMutation(request, env, actor, ownerId, mutation),
    createUploadSession: (ownerId) => createUploadSession(request, env, actor, ownerId),
    uploadSessionFile: (ownerId, sessionId, encodedPath) => uploadSessionFile(request, env, actor, ownerId, sessionId, encodedPath),
    completeUploadSession: (ownerId, sessionId) => completeUploadSession(request, env, actor, ownerId, sessionId),
    updateAccessPolicy: (ownerId, publicationId) => updateAccessPolicy(request, env, actor, ownerId, publicationId),
    createAccessGrant: (ownerId, publicationId) => createAccessGrant(request, env, actor, ownerId, publicationId),
    revokeAccessGrant: (ownerId, publicationId, grantId) => revokeAccessGrant(request, env, actor, ownerId, publicationId, grantId),
    publicationMutation: (ownerId, mutation) => publicationMutation(request, env, actor, ownerId, mutation),
    listVersions: (ownerId, publicationId) => listVersions(env, ownerId, publicationId, url),
  };
  for (const handler of [handleCollaborationRoute, handleOperationsRoute, handlePublicationRoute]) {
    const response = await handler(routeContext);
    if (response) return response;
  }
  return error("not_found", 404);
}

interface QueueMessageLike {
  body: JobMessage;
  retry(): void;
}

export async function processQueueBatch<T extends QueueMessageLike>(
  messages: readonly T[],
  process: (message: JobMessage) => Promise<void>,
  recover: (message: JobMessage) => Promise<void>,
  onFailure: (message: JobMessage, cause: unknown) => void,
  concurrency = 4,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), messages.length) }, async () => {
    while (next < messages.length) {
      const message = messages[next++];
      try {
        await process(message.body);
      } catch (cause) {
        try { await recover(message.body); } catch { /* A later retry or Cron lease recovery owns this failure. */ }
        message.retry();
        onFailure(message.body, cause);
      }
    }
  });
  await Promise.all(workers);
}

const worker: ExportedHandler<Env, JobMessage> = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ service: "pagecast", status: "ok" });
    }

    if (url.pathname.startsWith("/v1/")) {
      return handleControl(request, env, url);
    }

    if (url.pathname === "/mcp") {
      return handleMcpRequest(request, env, ctx, { authenticate, dispatchControl: handleControl });
    }

    const publicResponse = await handlePublicDelivery(request, env, url, ctx);
    if (publicResponse) return publicResponse;

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    await processQueueBatch(
      batch.messages,
      (message) => processJobMessage(env, message),
      (message) => recoverJobMessage(env, message),
      (message, cause) => console.error("Pagecast job processing failed", message.id, String(cause)),
    );
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(expireTransientRows(env.DB));
    ctx.waitUntil(cleanupPublicationStorage(env));
    ctx.waitUntil(cleanupAnalytics(env.DB));
    ctx.waitUntil(scheduledJobs(env));
  },
};

export default worker;
