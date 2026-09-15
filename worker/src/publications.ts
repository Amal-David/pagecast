import { auditStatement } from "./audit";
import { encodeHex } from "./auth";
import { isPagecastId } from "./identifiers";
import { findIdempotencyReceipt, idempotencyReceiptStatement, resolveIdempotencyReceipt } from "./idempotency";
import { enqueueOutbox, outboxStatement } from "./jobs";
import type { Env } from "./types";

export { isPagecastId as validOwnerId } from "./identifiers";

export type PublicationMode = "create" | "context-upsert" | "new-link" | "explicit-update";

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export type PublicationMutation =
  | { kind: "publication"; operation: "create-session"; data: { mode: unknown; title: unknown; slug: unknown; linkKind: unknown; manifest: unknown; contextKey?: unknown; existingPublicationId?: string; publicationId: string; versionId: string; sessionId: string } }
  | { kind: "publication"; operation: "record-file"; data: { sessionId: string; path: string; bytes: number; sha256: string } }
  | { kind: "publication"; operation: "complete-session"; data: { sessionId: string } }
  | { kind: "publication"; operation: "activate"; data: { publicationId: string; versionId: string } }
  | { kind: "publication"; operation: "delete-version"; data: { publicationId: string; versionId: string } }
  | { kind: "publication"; operation: "rename"; data: { publicationId: string; slug: unknown } }
  | { kind: "publication"; operation: "revoke"; data: { publicationId: string } }
  | { kind: "publication"; operation: "restore"; data: { publicationId: string } }
  | { kind: "publication"; operation: "set-access-policy"; data: { publicationId: string; mode: unknown; approvalState: unknown; passwordHash: unknown; passwordSalt: unknown; passwordIterations: unknown; expiresAt?: unknown } }
  | { kind: "publication"; operation: "set-expiry"; data: { publicationId: string; expiresAt: unknown } }
  | { kind: "publication"; operation: "create-grant"; data: { publicationId: string; grantId: string; credentialHash: string; permission: unknown; expiresAt: unknown } }
  | { kind: "publication"; operation: "revoke-grant"; data: { publicationId: string; grantId: string } };

export interface PublicationMutationPacket {
  actorId: string | null;
  fingerprint: string;
  idempotencyKey: string;
  mutation: PublicationMutation;
}

type PublicationPacket<Operation extends PublicationMutation["operation"]> = Omit<PublicationMutationPacket, "mutation"> & {
  mutation: Extract<PublicationMutation, { operation: Operation }>;
};

interface PublicationRow {
  id: string;
  slug: string;
  active_version_id: string | null;
  state: string;
  generation: number;
}

interface VersionRow {
  id: string;
  publication_id: string;
  version_number: number;
  is_complete: number;
  status: string;
  deleted_at: string | null;
}

const MAX_MANIFEST_FILES = 25;
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PATH_BYTES = 256;
const UNLISTED_CAPABILITY_BYTES = 16;
const UNLISTED_CAPABILITY_HEX_LENGTH = UNLISTED_CAPABILITY_BYTES * 2;
const MAX_SLUG_LENGTH = 63;
const MAX_SLUG_PREFIX_LENGTH = MAX_SLUG_LENGTH - UNLISTED_CAPABILITY_HEX_LENGTH - 1;
const RESERVED_SLUGS = new Set(["", "404", "admin", "health", "index", "p", "v1"]);
const textEncoder = new TextEncoder();

export async function sha256(value: string): Promise<string> {
  return encodeHex(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
}

export function normalizeManifest(value: unknown): ManifestFile[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MANIFEST_FILES) return null;
  const seen = new Set<string>();
  let total = 0;
  const files: ManifestFile[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== "string" || typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.contentType !== "string" || !/^[^\s/]+\/[^\s;]+(?:;[^\r\n]*)?$/.test(entry.contentType)) return null;
    const path = normalizePath(entry.path);
    if (!path || seen.has(path)) return null;
    seen.add(path);
    total += entry.bytes;
    if (entry.bytes > MAX_FILE_BYTES || total > MAX_MANIFEST_BYTES) return null;
    files.push({ path, bytes: entry.bytes, sha256: entry.sha256, contentType: entry.contentType });
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function normalizePath(value: string): string | null {
  if (!value || value.length > MAX_PATH_BYTES || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith("/")) return null;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) return null;
  const normalized = segments.join("/");
  return textEncoder.encode(normalized).byteLength <= MAX_PATH_BYTES ? normalized : null;
}

export function createUnlistedSlug(value: string): string | null {
  const prefix = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_PREFIX_LENGTH)
    .replace(/-+$/g, "");
  if (!validSlug(prefix)) return null;
  const bytes = new Uint8Array(UNLISTED_CAPABILITY_BYTES);
  crypto.getRandomValues(bytes);
  return `${prefix}-${encodeHex(bytes.buffer)}`;
}

export function r2Key(ownerId: string, publicationId: string, versionId: string, path: string): string {
  const key = `owners/${ownerId}/publications/${publicationId}/versions/${versionId}/${path.split("/").map(encodeURIComponent).join("/")}`;
  if (!isPagecastId(ownerId) || textEncoder.encode(key).byteLength > 1_024) throw new RangeError("invalid_r2_key");
  return key;
}

export async function executePublicationMutation(
  env: Pick<Env, "DB" | "PUBLICATIONS" | "JOBS">,
  ownerId: string,
  packet: PublicationMutationPacket,
): Promise<Response> {
  const existing = await findIdempotencyReceipt(env.DB, ownerId, packet.idempotencyKey);
  if (existing) {
    const result = resolveIdempotencyReceipt(existing, packet.fingerprint);
    return success(result.status, result.body);
  }
  const envelope = { actorId: packet.actorId, fingerprint: packet.fingerprint, idempotencyKey: packet.idempotencyKey };
  switch (packet.mutation.operation) {
    case "create-session": return createSession(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
    case "record-file": return recordFile(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
    case "complete-session": return completeSession(env, ownerId, { ...envelope, mutation: packet.mutation });
    case "activate": return activate(env, ownerId, { ...envelope, mutation: packet.mutation });
    case "delete-version": return deleteVersion(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
    case "rename": return renamePublication(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
    case "revoke": return revokePublication(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
    case "restore": return restorePublication(env, ownerId, { ...envelope, mutation: packet.mutation });
    case "set-access-policy": return setAccessPolicy(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
    case "set-expiry": return setExpiry(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
    case "create-grant": return createAccessGrant(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
    case "revoke-grant": return revokeAccessGrant(env.DB, ownerId, { ...envelope, mutation: packet.mutation });
  }
}

async function setExpiry(db: D1Database, ownerId: string, packet: PublicationPacket<"set-expiry">): Promise<Response> {
  const { publicationId, expiresAt } = packet.mutation.data;
  if (typeof publicationId !== "string" || (expiresAt !== null && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()))) return terminal(db, ownerId, packet, 400, { error: "invalid_expiry" });
  const publication = await db.prepare("SELECT id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first<{ id: string }>();
  if (!publication) return terminal(db, ownerId, packet, 404, { error: "publication_not_found" });
  const body = { publicationId, expiresAt, authVersionChanged: true, expiryChanged: true };
  try { await db.batch([
    db.prepare("UPDATE publications SET expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(expiresAt, publicationId, ownerId),
    db.prepare("UPDATE access_policies SET auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP WHERE publication_id = ? AND owner_id = ?").bind(publicationId, ownerId),
    auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.expiry_updated", resourceType: "publication", resourceId: publicationId, metadata: { expiresAt } }),
    receiptStatement(db, ownerId, packet, 200, body),
  ]); } catch { return failure(); }
  return success(200, body);
}

async function setAccessPolicy(db: D1Database, ownerId: string, packet: PublicationPacket<"set-access-policy">): Promise<Response> {
  const { publicationId, mode, approvalState, passwordHash, passwordSalt, passwordIterations, expiresAt } = packet.mutation.data;
  const changesExpiry = Object.prototype.hasOwnProperty.call(packet.mutation.data, "expiresAt");
  if (typeof publicationId !== "string" || !isAccessMode(mode) || !isApprovalState(approvalState) ||
    (mode === "password" && (typeof passwordHash !== "string" || !/^[a-f0-9]{64}$/.test(passwordHash) || typeof passwordSalt !== "string" || passwordSalt.length < 16 || !Number.isInteger(passwordIterations))) ||
    (changesExpiry && expiresAt !== null && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()))) {
    return terminal(db, ownerId, packet, 400, { error: "invalid_access_policy" });
  }
  const publication = await db.prepare("SELECT id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first<{ id: string }>();
  if (!publication) return terminal(db, ownerId, packet, 404, { error: "publication_not_found" });
  const body = { publicationId, mode, approvalState, authVersionChanged: true, expiryChanged: changesExpiry };
  try {
    const statements = [
      db.prepare(`INSERT INTO access_policies (id, owner_id, publication_id, mode, password_hash, password_salt, password_iterations, auth_version, approval_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(publication_id) DO UPDATE SET mode = excluded.mode, password_hash = excluded.password_hash, password_salt = excluded.password_salt,
          password_iterations = excluded.password_iterations, approval_state = excluded.approval_state, auth_version = access_policies.auth_version + 1, updated_at = CURRENT_TIMESTAMP`)
        .bind(crypto.randomUUID(), ownerId, publicationId, mode, mode === "password" ? passwordHash : null, mode === "password" ? passwordSalt : null, mode === "password" ? passwordIterations : 100000, approvalState),
    ];
    if (changesExpiry) {
      statements.push(db.prepare("UPDATE publications SET expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?")
        .bind(expiresAt, publicationId, ownerId));
    }
    statements.push(
      auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.access_policy_updated", resourceType: "publication", resourceId: publicationId, metadata: { mode, approvalState, ...(changesExpiry ? { expiresAt } : {}) } }),
      receiptStatement(db, ownerId, packet, 200, body),
    );
    await db.batch(statements);
  } catch { return failure(); }
  return success(200, body);
}

async function createAccessGrant(db: D1Database, ownerId: string, packet: PublicationPacket<"create-grant">): Promise<Response> {
  const { publicationId, grantId, credentialHash, permission, expiresAt } = packet.mutation.data;
  if (typeof publicationId !== "string" || typeof grantId !== "string" || typeof credentialHash !== "string" || !/^[a-f0-9]{64}$/.test(credentialHash) ||
    !isGrantPermission(permission) || (expiresAt !== null && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()))) {
    return terminal(db, ownerId, packet, 400, { error: "invalid_access_grant" });
  }
  const publication = await db.prepare("SELECT id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first<{ id: string }>();
  if (!publication) return terminal(db, ownerId, packet, 404, { error: "publication_not_found" });
  const body = { id: grantId, publicationId, permission, expiresAt };
  try {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO access_policies (id, owner_id, publication_id, mode, password_iterations, auth_version, approval_state) VALUES (?, ?, ?, 'allowlist', 100000, 1, 'approved')")
        .bind(crypto.randomUUID(), ownerId, publicationId),
      db.prepare("INSERT INTO access_grants (id, owner_id, publication_id, principal_type, principal_value, permission, expires_at) VALUES (?, ?, ?, 'token', ?, ?, ?)")
        .bind(grantId, ownerId, publicationId, credentialHash, permission, expiresAt),
      db.prepare("UPDATE access_policies SET auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP WHERE publication_id = ?").bind(publicationId),
      auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.access_grant_created", resourceType: "access_grant", resourceId: grantId, metadata: { permission, expiresAt } }),
      receiptStatement(db, ownerId, packet, 201, body),
    ]);
  } catch { return failure(); }
  return success(201, body);
}

async function revokeAccessGrant(db: D1Database, ownerId: string, packet: PublicationPacket<"revoke-grant">): Promise<Response> {
  const { publicationId, grantId } = packet.mutation.data;
  if (typeof publicationId !== "string" || typeof grantId !== "string") return terminal(db, ownerId, packet, 400, { error: "invalid_access_grant" });
  const grant = await db.prepare("SELECT id FROM access_grants WHERE id = ? AND publication_id = ? AND owner_id = ? AND revoked_at IS NULL").bind(grantId, publicationId, ownerId).first<{ id: string }>();
  if (!grant) return terminal(db, ownerId, packet, 404, { error: "access_grant_not_found" });
  const body = { id: grantId, revoked: true };
  try {
    await db.batch([
      db.prepare("UPDATE access_grants SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND publication_id = ? AND owner_id = ?").bind(grantId, publicationId, ownerId),
      db.prepare("UPDATE access_policies SET auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP WHERE publication_id = ?").bind(publicationId),
      auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.access_grant_revoked", resourceType: "access_grant", resourceId: grantId }),
      receiptStatement(db, ownerId, packet, 200, body),
    ]);
  } catch { return failure(); }
  return success(200, body);
}

async function recordFile(db: D1Database, ownerId: string, packet: PublicationPacket<"record-file">): Promise<Response> {
  const { sessionId, path, bytes, sha256: digest } = packet.mutation.data;
  if (typeof sessionId !== "string" || typeof path !== "string" || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || typeof digest !== "string") {
    return terminal(db, ownerId, packet, 400, { error: "invalid_upload_file" });
  }
  const file = await db.prepare("SELECT f.expected_bytes, f.expected_sha256, f.received_bytes, f.received_sha256, s.status FROM upload_session_files f JOIN upload_sessions s ON s.id = f.session_id WHERE f.session_id = ? AND f.normalized_path = ? AND s.owner_id = ? AND s.expires_at > CURRENT_TIMESTAMP")
    .bind(sessionId, path, ownerId).first<{ expected_bytes: number; expected_sha256: string; received_bytes: number | null; received_sha256: string | null; status: string }>();
  if (!file) return terminal(db, ownerId, packet, 404, { error: "upload_file_not_found" });
  if (file.status !== "open") return terminal(db, ownerId, packet, 409, { error: "upload_session_closed" });
  if (file.expected_bytes !== bytes || file.expected_sha256 !== digest) return terminal(db, ownerId, packet, 409, { error: "upload_file_mismatch" });
  if (file.received_bytes === bytes && file.received_sha256 === digest) return terminal(db, ownerId, packet, 200, { sessionId, path, uploaded: true });
  try {
    await db.batch([
      db.prepare("UPDATE upload_session_files SET received_bytes = ?, received_sha256 = ?, uploaded_at = CURRENT_TIMESTAMP WHERE session_id = ? AND normalized_path = ? AND received_bytes IS NULL")
        .bind(bytes, digest, sessionId, path),
      receiptStatement(db, ownerId, packet, 200, { sessionId, path, uploaded: true }),
    ]);
  } catch { return failure(); }
  return success(200, { sessionId, path, uploaded: true });
}

async function createSession(db: D1Database, ownerId: string, packet: PublicationPacket<"create-session">): Promise<Response> {
  const data = packet.mutation.data;
  const mode = data.mode as PublicationMode;
  const files = normalizeManifest(data.manifest);
  if (!isMode(mode) || !files || typeof data.title !== "string" || data.title.length < 1 || data.title.length > 300 ||
    typeof data.slug !== "string" || !isLinkKind(data.linkKind) || !validLinkSlug(data.slug, data.linkKind) ||
    typeof data.sessionId !== "string" || typeof data.publicationId !== "string" || typeof data.versionId !== "string") {
    return terminal(db, ownerId, packet, 400, { error: "invalid_upload_manifest" });
  }
  const manifestSha = await sha256(JSON.stringify(files));
  const sessionId = data.sessionId as string;
  const versionId = data.versionId as string;
  const requestedPublication = typeof data.existingPublicationId === "string" ? data.existingPublicationId : null;
  const contextKey = typeof data.contextKey === "string" ? data.contextKey : null;
  if (contextKey !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(contextKey)) {
    return terminal(db, ownerId, packet, 400, { error: "invalid_context_key" });
  }
  let isNew = mode === "create" || mode === "new-link";
  if (mode === "explicit-update" && !requestedPublication) {
    return terminal(db, ownerId, packet, 400, { error: "publication_required" });
  }
  let publicationId = data.publicationId;
  let versionNumber = 1;
  let slug = data.slug;
  let replacedContextPublicationId: string | null = null;
  if (mode === "context-upsert") {
    if (!contextKey) return terminal(db, ownerId, packet, 400, { error: "context_key_required" });
    const publication = await db.prepare("SELECT id, slug FROM publications WHERE owner_id = ? AND context_key = ? AND deleted_at IS NULL")
      .bind(ownerId, contextKey).first<{ id: string; slug: string }>();
    if (publication) {
      isNew = false;
      publicationId = publication.id;
      slug = publication.slug;
      const latest = await db.prepare("SELECT COALESCE(MAX(version_number), 0) AS version_number FROM publication_versions WHERE publication_id = ?").bind(publicationId).first<{ version_number: number }>();
      versionNumber = (latest?.version_number ?? 0) + 1;
    } else {
      isNew = true;
    }
  }
  if (isNew) {
    const collision = await db.prepare("SELECT id FROM publications WHERE slug = ?").bind(data.slug).first<{ id: string }>();
    if (collision) return terminal(db, ownerId, packet, 409, { error: "slug_taken" });
    if (mode === "new-link" && contextKey) {
      const previous = await db.prepare("SELECT id FROM publications WHERE owner_id = ? AND context_key = ? AND deleted_at IS NULL").bind(ownerId, contextKey).first<{ id: string }>();
      replacedContextPublicationId = previous?.id ?? null;
    }
  } else if (mode !== "context-upsert") {
    const publication = await db.prepare("SELECT id, slug FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(requestedPublication, ownerId).first<{ id: string; slug: string }>();
    if (!publication) return terminal(db, ownerId, packet, 404, { error: "publication_not_found" });
    publicationId = publication.id;
    slug = publication.slug;
    const latest = await db.prepare("SELECT COALESCE(MAX(version_number), 0) AS version_number FROM publication_versions WHERE publication_id = ?").bind(publicationId).first<{ version_number: number }>();
    versionNumber = (latest?.version_number ?? 0) + 1;
  }
  const byteSize = files.reduce((sum, file) => sum + file.bytes, 0);
  const response = { sessionId, publicationId, versionId, versionNumber, slug, status: "open" };
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT OR IGNORE INTO owners (id) VALUES (?)").bind(ownerId),
  ];
  if (isNew) {
    if (replacedContextPublicationId) statements.push(db.prepare("UPDATE publications SET context_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(replacedContextPublicationId, ownerId));
    statements.push(db.prepare("INSERT INTO publications (id, owner_id, slug, title, state, link_kind, context_key) VALUES (?, ?, ?, ?, 'draft', ?, ?)")
      .bind(publicationId, ownerId, data.slug, data.title, data.linkKind, contextKey));
  }
  statements.push(
    db.prepare("INSERT INTO publication_versions (id, owner_id, publication_id, version_number, manifest_key, content_sha256, byte_size, status, is_complete) VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', 0)")
      .bind(versionId, ownerId, publicationId, versionNumber, `${r2Key(ownerId, publicationId, versionId, "manifest.json")}`, manifestSha, byteSize),
    db.prepare("INSERT INTO upload_sessions (id, owner_id, publication_id, version_id, mode, manifest_sha256, status, expires_at, operation_id) VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now', '+24 hours'), ?)")
      .bind(sessionId, ownerId, publicationId, versionId, mode, manifestSha, packet.idempotencyKey),
    ...files.map((file) => db.prepare("INSERT INTO upload_session_files (session_id, normalized_path, r2_key, expected_bytes, expected_sha256, content_type) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(sessionId, file.path, r2Key(ownerId, publicationId, versionId, file.path), file.bytes, file.sha256, file.contentType)),
    auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.upload_session_created", resourceType: "publication_version", resourceId: versionId, metadata: { fileCount: files.length, mode } }),
    receiptStatement(db, ownerId, packet, 201, response),
  );
  try {
    await db.batch(statements);
  } catch {
    if (isNew && await db.prepare("SELECT id FROM publications WHERE slug = ?").bind(data.slug).first<{ id: string }>()) {
      return terminal(db, ownerId, packet, 409, { error: "slug_taken" });
    }
    return failure();
  }
  return success(201, response);
}

async function completeSession(env: { DB: D1Database; PUBLICATIONS: R2Bucket }, ownerId: string, packet: PublicationPacket<"complete-session">): Promise<Response> {
  const sessionId = packet.mutation.data.sessionId;
  if (typeof sessionId !== "string") return terminal(env.DB, ownerId, packet, 400, { error: "invalid_upload_session" });
  const session = await env.DB.prepare("SELECT s.id, s.publication_id, s.version_id, s.status, v.manifest_key, v.content_sha256 FROM upload_sessions s JOIN publication_versions v ON v.id = s.version_id WHERE s.id = ? AND s.owner_id = ? AND s.expires_at > CURRENT_TIMESTAMP")
    .bind(sessionId, ownerId).first<{ id: string; publication_id: string; version_id: string; status: string; manifest_key: string; content_sha256: string }>();
  if (!session) return terminal(env.DB, ownerId, packet, 404, { error: "upload_session_not_found" });
  if (session.status === "complete") return terminal(env.DB, ownerId, packet, 200, { sessionId, versionId: session.version_id, status: "complete" });
  const files = await env.DB.prepare("SELECT normalized_path, r2_key, expected_bytes, expected_sha256, content_type, received_bytes, received_sha256 FROM upload_session_files WHERE session_id = ? ORDER BY normalized_path")
    .bind(sessionId).all<{ normalized_path: string; r2_key: string; expected_bytes: number; expected_sha256: string; content_type: string; received_bytes: number | null; received_sha256: string | null }>();
  if (!files.results.length) return terminal(env.DB, ownerId, packet, 409, { error: "upload_manifest_missing" });
  if (files.results.some((file) => file.received_bytes !== file.expected_bytes || file.received_sha256 !== file.expected_sha256)) {
    return terminal(env.DB, ownerId, packet, 409, { error: "upload_incomplete" });
  }
  const objects = await Promise.all(files.results.map((file) => env.PUBLICATIONS.head(file.r2_key)));
  if (objects.some((object, index) => !object || object.size !== files.results[index].expected_bytes || object.httpMetadata?.contentType !== files.results[index].content_type || object.customMetadata?.sha256 !== files.results[index].expected_sha256)) {
    return terminal(env.DB, ownerId, packet, 409, { error: "upload_object_mismatch" });
  }
  const manifest = JSON.stringify(files.results.map((file) => ({ path: file.normalized_path, bytes: file.expected_bytes, sha256: file.expected_sha256, contentType: file.content_type })));
  if (await sha256(manifest) !== session.content_sha256) return terminal(env.DB, ownerId, packet, 409, { error: "upload_manifest_mismatch" });
  const storedManifest = await env.PUBLICATIONS.head(session.manifest_key);
  if (storedManifest) {
    if (storedManifest.size !== textEncoder.encode(manifest).byteLength || storedManifest.httpMetadata?.contentType !== "application/json" || storedManifest.customMetadata?.sha256 !== session.content_sha256) {
      return terminal(env.DB, ownerId, packet, 409, { error: "upload_manifest_mismatch" });
    }
  } else {
    await env.PUBLICATIONS.put(session.manifest_key, manifest, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: session.content_sha256 } });
  }
  const response = { sessionId, versionId: session.version_id, status: "complete" };
  try {
    await env.DB.batch([
      ...files.results.map((file) => env.DB.prepare("INSERT INTO version_files (version_id, normalized_path, r2_key, byte_size, sha256, content_type) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(session.version_id, file.normalized_path, file.r2_key, file.expected_bytes, file.expected_sha256, file.content_type)),
      env.DB.prepare("UPDATE publication_versions SET is_complete = 1 WHERE id = ? AND owner_id = ?").bind(session.version_id, ownerId),
      env.DB.prepare("UPDATE upload_sessions SET status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'").bind(sessionId),
      auditStatement(env.DB, { ownerId, actorId: packet.actorId, action: "publication.upload_completed", resourceType: "publication_version", resourceId: session.version_id, metadata: { fileCount: files.results.length } }),
      receiptStatement(env.DB, ownerId, packet, 200, response),
    ]);
  } catch { return failure(); }
  return success(200, response);
}

async function activate(env: Pick<Env, "DB" | "PUBLICATIONS" | "JOBS">, ownerId: string, packet: PublicationPacket<"activate">): Promise<Response> {
  const db = env.DB;
  const { publicationId, versionId } = packet.mutation.data;
  if (typeof publicationId !== "string" || typeof versionId !== "string") return terminal(db, ownerId, packet, 400, { error: "invalid_version" });
  const [publication, version] = await Promise.all([
    db.prepare("SELECT id, slug, active_version_id, state, generation FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first<PublicationRow>(),
    db.prepare("SELECT id, publication_id, version_number, is_complete, status, deleted_at FROM publication_versions WHERE id = ? AND owner_id = ?").bind(versionId, ownerId).first<VersionRow>(),
  ]);
  if (!publication || !version || version.publication_id !== publicationId || version.deleted_at) return terminal(db, ownerId, packet, 404, { error: "version_not_found" });
  if (!version.is_complete) return terminal(db, ownerId, packet, 409, { error: "version_incomplete" });
  if (publication.active_version_id === versionId) return terminal(db, ownerId, packet, 409, { error: "version_already_active" });
  const reviewPolicy = await db.prepare("SELECT requires_approval FROM publication_review_policies WHERE owner_id = ? AND publication_id = ?")
    .bind(ownerId, publicationId).first<{ requires_approval: number }>();
  if (reviewPolicy?.requires_approval) {
    const review = await db.prepare("SELECT COUNT(*) AS decision_count, SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approved_count FROM collaboration_review_decisions WHERE owner_id = ? AND publication_id = ? AND version_id = ? AND superseded_at IS NULL")
      .bind(ownerId, publicationId, versionId).first<{ decision_count: number; approved_count: number | null }>();
    if (!review || review.decision_count === 0 || review.approved_count !== review.decision_count) return terminal(db, ownerId, packet, 409, { error: "approval_required" });
  }
  const response = { publicationId, versionId, previousVersionId: publication.active_version_id, state: "published" };
  const outbox = outboxStatement(db, ownerId, "publication.published", { publicationId, versionId, previousVersionId: publication.active_version_id }, `publication.published:${publicationId}:${versionId}`);
  try {
    await db.batch([
      db.prepare("UPDATE publication_versions SET status = 'superseded', generation = generation + 1 WHERE id = ? AND owner_id = ? AND status = 'published'").bind(publication.active_version_id, ownerId),
      db.prepare("UPDATE publication_versions SET status = 'published', published_at = CURRENT_TIMESTAMP, generation = generation + 1 WHERE id = ? AND owner_id = ? AND is_complete = 1 AND deleted_at IS NULL").bind(versionId, ownerId),
      db.prepare("UPDATE publications SET active_version_id = ?, revoked_version_id = NULL, state = 'published', generation = generation + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND generation = ?")
        .bind(versionId, publicationId, ownerId, publication.generation),
      auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.version_activated", resourceType: "publication_version", resourceId: versionId }),
      ...(outbox ? [outbox.statement] : []),
      receiptStatement(db, ownerId, packet, 200, response),
    ]);
  } catch { return failure(); }
  if (outbox) await enqueueOutbox(env, ownerId, outbox.id);
  const current = await db.prepare("SELECT active_version_id FROM publications WHERE id = ? AND owner_id = ?").bind(publicationId, ownerId).first<{ active_version_id: string | null }>();
  return current?.active_version_id === versionId ? success(200, response) : terminal(db, ownerId, packet, 409, { error: "activation_conflict" });
}

async function deleteVersion(db: D1Database, ownerId: string, packet: PublicationPacket<"delete-version">): Promise<Response> {
  const { publicationId, versionId } = packet.mutation.data;
  if (typeof publicationId !== "string" || typeof versionId !== "string") return terminal(db, ownerId, packet, 400, { error: "invalid_version" });
  const publication = await db.prepare("SELECT active_version_id FROM publications WHERE id = ? AND owner_id = ?").bind(publicationId, ownerId).first<{ active_version_id: string | null }>();
  if (!publication) return terminal(db, ownerId, packet, 404, { error: "publication_not_found" });
  if (publication.active_version_id === versionId) return terminal(db, ownerId, packet, 409, { error: "active_version_retained" });
  const version = await db.prepare("SELECT id FROM publication_versions WHERE id = ? AND owner_id = ? AND publication_id = ? AND deleted_at IS NULL AND (retention_until IS NULL OR retention_until <= CURRENT_TIMESTAMP)")
    .bind(versionId, ownerId, publicationId).first<{ id: string }>();
  if (!version) return terminal(db, ownerId, packet, 409, { error: "version_retained_or_missing" });
  const response = { publicationId, versionId, deleted: true };
  try {
    await db.batch([
      db.prepare("UPDATE publication_versions SET deleted_at = CURRENT_TIMESTAMP, status = 'deleted', generation = generation + 1 WHERE id = ? AND owner_id = ? AND publication_id = ? AND deleted_at IS NULL")
        .bind(versionId, ownerId, publicationId),
      auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.version_deleted", resourceType: "publication_version", resourceId: versionId }),
      receiptStatement(db, ownerId, packet, 200, response),
    ]);
  } catch { return failure(); }
  return success(200, response);
}

async function renamePublication(db: D1Database, ownerId: string, packet: PublicationPacket<"rename">): Promise<Response> {
  const { publicationId, slug } = packet.mutation.data;
  if (typeof publicationId !== "string" || typeof slug !== "string" || !validSlug(slug)) return terminal(db, ownerId, packet, 400, { error: "invalid_slug" });
  const publication = await db.prepare("SELECT id, slug FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first<{ id: string; slug: string }>();
  if (!publication) return terminal(db, ownerId, packet, 404, { error: "publication_not_found" });
  const collision = await db.prepare("SELECT id FROM publications WHERE slug = ? AND id != ?").bind(slug, publicationId).first<{ id: string }>();
  if (collision) return terminal(db, ownerId, packet, 409, { error: "slug_taken" });
  const response = { publicationId, slug, redirectFrom: publication.slug };
  try {
    await db.batch([
      db.prepare("UPDATE publications SET slug = ?, generation = generation + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(slug, publicationId, ownerId),
      db.prepare("INSERT OR REPLACE INTO redirects (id, owner_id, publication_id, source_path, destination_path, status_code) VALUES (?, ?, ?, ?, ?, 308)").bind(crypto.randomUUID(), ownerId, publicationId, publication.slug, slug),
      auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.renamed", resourceType: "publication", resourceId: publicationId }),
      receiptStatement(db, ownerId, packet, 200, response),
    ]);
  } catch {
    if (await db.prepare("SELECT id FROM publications WHERE slug = ? AND id != ?").bind(slug, publicationId).first<{ id: string }>()) {
      return terminal(db, ownerId, packet, 409, { error: "slug_taken" });
    }
    return failure();
  }
  return success(200, response);
}

async function revokePublication(db: D1Database, ownerId: string, packet: PublicationPacket<"revoke">): Promise<Response> {
  const publicationId = packet.mutation.data.publicationId;
  if (typeof publicationId !== "string") return terminal(db, ownerId, packet, 400, { error: "invalid_publication" });
  const publication = await db.prepare("SELECT active_version_id FROM publications WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").bind(publicationId, ownerId).first<{ active_version_id: string | null }>();
  if (!publication) return terminal(db, ownerId, packet, 404, { error: "publication_not_found" });
  try {
    await db.batch([
      db.prepare("UPDATE publication_versions SET status = 'superseded', generation = generation + 1 WHERE id = ? AND owner_id = ?").bind(publication.active_version_id, ownerId),
      db.prepare("UPDATE publications SET revoked_version_id = active_version_id, active_version_id = NULL, state = 'revoked', generation = generation + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(publicationId, ownerId),
      db.prepare("UPDATE access_policies SET auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP WHERE publication_id = ? AND owner_id = ?").bind(publicationId, ownerId),
      auditStatement(db, { ownerId, actorId: packet.actorId, action: "publication.revoked", resourceType: "publication", resourceId: publicationId }),
      receiptStatement(db, ownerId, packet, 200, { publicationId, revoked: true }),
    ]);
  } catch { return failure(); }
  return success(200, { publicationId, revoked: true });
}

async function restorePublication(env: Pick<Env, "DB" | "PUBLICATIONS" | "JOBS">, ownerId: string, packet: PublicationPacket<"restore">): Promise<Response> {
  const db = env.DB;
  const publicationId = packet.mutation.data.publicationId;
  if (typeof publicationId !== "string") return terminal(db, ownerId, packet, 400, { error: "invalid_publication" });
  const publication = await db.prepare("SELECT id, revoked_version_id FROM publications WHERE id = ? AND owner_id = ? AND state = 'revoked' AND deleted_at IS NULL").bind(publicationId, ownerId).first<{ id: string; revoked_version_id: string | null }>();
  if (!publication) return terminal(db, ownerId, packet, 404, { error: "revoked_publication_not_found" });
  if (!publication.revoked_version_id) return terminal(db, ownerId, packet, 409, { error: "no_retained_version" });
  const version = await db.prepare("SELECT id FROM publication_versions WHERE id = ? AND publication_id = ? AND owner_id = ? AND is_complete = 1 AND deleted_at IS NULL")
    .bind(publication.revoked_version_id, publicationId, ownerId).first<{ id: string }>();
  if (!version) return terminal(db, ownerId, packet, 409, { error: "no_retained_version" });
  return activate(env, ownerId, { ...packet, mutation: { kind: "publication", operation: "activate", data: { publicationId, versionId: version.id } } });
}

export async function cleanupPublicationStorage(env: { DB: D1Database; PUBLICATIONS: R2Bucket }): Promise<void> {
  const sessions = await env.DB.prepare("SELECT id FROM upload_sessions WHERE status = 'open' AND expires_at <= CURRENT_TIMESTAMP LIMIT 25").all<{ id: string }>();
  for (const session of sessions.results) {
    const files = await env.DB.prepare("SELECT r2_key FROM upload_session_files WHERE session_id = ?").bind(session.id).all<{ r2_key: string }>();
    await env.PUBLICATIONS.delete(files.results.map((file) => file.r2_key));
    await env.DB.prepare("UPDATE upload_sessions SET status = 'expired' WHERE id = ? AND status = 'open'").bind(session.id).run();
  }
  const versions = await env.DB.prepare("SELECT v.id FROM publication_versions v JOIN publications p ON p.id = v.publication_id WHERE v.deleted_at IS NOT NULL AND v.storage_purged_at IS NULL AND (v.retention_until IS NULL OR v.retention_until <= CURRENT_TIMESTAMP) AND (p.active_version_id IS NULL OR p.active_version_id != v.id) LIMIT 25").all<{ id: string }>();
  for (const version of versions.results) {
    const files = await env.DB.prepare("SELECT r2_key FROM version_files WHERE version_id = ?").bind(version.id).all<{ r2_key: string }>();
    const keys = files.results.map((file) => file.r2_key);
    if (keys.length) await env.PUBLICATIONS.delete(keys);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM version_files WHERE version_id = ?").bind(version.id),
      env.DB.prepare("UPDATE publication_versions SET storage_purged_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NOT NULL AND storage_purged_at IS NULL").bind(version.id),
    ]);
  }
}

function receiptStatement(db: D1Database, ownerId: string, packet: PublicationMutationPacket, status: number, body: Record<string, unknown>): D1PreparedStatement {
  return idempotencyReceiptStatement(db, ownerId, packet, status, body, packet.mutation.operation);
}

async function terminal(db: D1Database, ownerId: string, packet: PublicationMutationPacket, status: number, body: Record<string, unknown>): Promise<Response> {
  try {
    await db.batch([db.prepare("INSERT OR IGNORE INTO owners (id) VALUES (?)").bind(ownerId), receiptStatement(db, ownerId, packet, status, body)]);
  } catch { return failure(); }
  return success(status, body);
}

function success(status: number, body: Record<string, unknown>): Response { return Response.json({ status, body }, { status: 200 }); }
function failure(): Response { return Response.json({ status: 502, body: { error: "mutation_failed" } }); }
function validSlug(value: string): boolean {
  return value.length <= MAX_SLUG_LENGTH && !RESERVED_SLUGS.has(value) && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}
function validLinkSlug(value: string, kind: unknown): boolean {
  if (!validSlug(value)) return false;
  return kind !== "unlisted" || new RegExp(`-[0-9a-f]{${UNLISTED_CAPABILITY_HEX_LENGTH}}$`).test(value);
}
function isMode(value: unknown): value is PublicationMode { return value === "create" || value === "context-upsert" || value === "new-link" || value === "explicit-update"; }
function isLinkKind(value: unknown): value is "public" | "unlisted" { return value === "public" || value === "unlisted"; }
function isAccessMode(value: unknown): value is "public" | "unlisted" | "password" | "allowlist" { return value === "public" || value === "unlisted" || value === "password" || value === "allowlist"; }
function isApprovalState(value: unknown): value is "approved" | "pending" | "rejected" { return value === "approved" || value === "pending" || value === "rejected"; }
function isGrantPermission(value: unknown): value is "view" | "comment" | "edit" { return value === "view" || value === "comment" || value === "edit"; }
