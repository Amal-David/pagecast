import { createHash, randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicWriteJson } from "./state-coordinator.js";
import { contentTypeFor, listPublicTreeFiles } from "./publication-files.js";

const MAX_FILES = 25;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const PARALLELISM = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 2_000;
export const WORKER_CREDENTIAL_FILE = "worker-credentials.json";
export const REQUIRED_WORKER_CAPABILITIES = Object.freeze([
  "publications.upload", "publications.access", "publications.versions"
]);

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isLoopback(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function normalizeWorkerOrigin(value, { allowLoopbackHttp = false } = {}) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw appError("Worker origin must be a valid HTTPS origin."); }
  if (!url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw appError("Worker origin must be an origin without a path, credentials, or query.");
  }
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && isLoopback(url.hostname))) {
    throw appError("Worker origin must use HTTPS (HTTP is allowed only for an explicit loopback development endpoint).");
  }
  if (url.port && !((url.protocol === "https:" && url.port === "443") || (allowLoopbackHttp && isLoopback(url.hostname)))) {
    throw appError("Worker origin may use a non-default port only for an explicit loopback development endpoint.");
  }
  return url.origin;
}

export function workerCredentialPath({ dataDir = path.join(os.homedir(), ".pagecast", "home") } = {}) {
  return path.join(path.resolve(dataDir), WORKER_CREDENTIAL_FILE);
}

export async function readWorkerCredentials({ dataDir, readFile = fs.readFile } = {}) {
  try {
    const value = JSON.parse(await readFile(workerCredentialPath({ dataDir }), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw appError("Pagecast Worker credentials are corrupt. Reconnect the Worker profile.", 500);
  }
}

export async function writeWorkerCredential({ dataDir, profileId, token, atomicWriteJsonImpl = atomicWriteJson } = {}) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(profileId || "")) || typeof token !== "string" || !token.trim()) {
    throw appError("A Worker profile and bearer token are required.");
  }
  const existing = await readWorkerCredentials({ dataDir });
  const next = { ...existing, [profileId]: token.trim() };
  await atomicWriteJsonImpl(workerCredentialPath({ dataDir }), next, { mode: 0o600, dirMode: 0o700 });
  return { credentialRef: WORKER_CREDENTIAL_FILE, profileId };
}

export async function removeWorkerCredential({ dataDir, profileId, atomicWriteJsonImpl = atomicWriteJson } = {}) {
  const existing = await readWorkerCredentials({ dataDir });
  if (!Object.hasOwn(existing, profileId)) return false;
  delete existing[profileId];
  await atomicWriteJsonImpl(workerCredentialPath({ dataDir }), existing, { mode: 0o600, dirMode: 0o700 });
  return true;
}

function safeRelativePath(value) {
  const normalized = value.split(path.sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw appError("Worker uploads cannot contain hidden or unsafe paths.");
  }
  return normalized;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function mapWithConcurrency(items, mapper, limit = PARALLELISM) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export async function buildWorkerManifest(rootDir, { stat = fs.stat, hashFile = sha256File, concurrency = PARALLELISM } = {}) {
  const root = path.resolve(rootDir);
  let paths;
  try { paths = await listPublicTreeFiles(root, { maxFiles: MAX_FILES }); }
  catch (error) {
    if (error?.message === "public_tree_file_limit") throw appError("Worker publications support at most 25 files.", 413);
    throw error;
  }
  const files = [];
  let totalBytes = 0;
  for (const relativePath of paths) {
    const sourcePath = path.resolve(root, relativePath);
    const details = await stat(sourcePath);
    if (details.size > MAX_FILE_BYTES) throw appError(`Worker upload file is too large: ${relativePath}`, 413);
    totalBytes += details.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw appError("Worker upload exceeds the 256 MiB publication limit.", 413);
    files.push({ path: safeRelativePath(relativePath), sourcePath, bytes: details.size, contentType: contentTypeFor(sourcePath) });
  }
  if (!files.length) throw appError("Worker publication has no public files.");
  const ordered = files.sort((left, right) => left.path.localeCompare(right.path));
  const hashes = await mapWithConcurrency(ordered, (file) => hashFile(file.sourcePath), concurrency);
  return ordered.map((file, index) => ({ ...file, sha256: hashes[index] }));
}

function requestId() { return randomBytes(18).toString("base64url"); }

function retryDelay(response, attempt, random) {
  const retryAfter = response?.headers?.get?.("retry-after");
  const seconds = Number(retryAfter);
  const retryAfterMs = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 0;
  const exponentialMs = 50 * (2 ** attempt);
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(retryAfterMs, exponentialMs + Math.floor(random() * 50)));
}

async function discardResponse(response) {
  try { await response.body?.cancel?.(); } catch { /* A completed response has nothing left to cancel. */ }
}

export function createWorkerClient({
  origin, ownerId, token, fetchImpl = fetch, retries = 2,
  timeoutMs = REQUEST_TIMEOUT_MS, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), random = Math.random
} = {}) {
  const baseUrl = normalizeWorkerOrigin(origin, { allowLoopbackHttp: true });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(ownerId || ""))) throw appError("Worker owner ID is invalid.");
  if (typeof token !== "string" || !token.trim()) throw appError("Worker credentials are missing. Run `pagecast workers connect`.", 401);

  async function request(pathname, {
    method = "GET", body, bodyFactory, raw = false, headers = {},
    idempotencyKey = "", retry = true
  } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const requestBody = bodyFactory ? bodyFactory() : raw ? body : body === undefined ? undefined : JSON.stringify(body);
        const response = await fetchImpl(`${baseUrl}${pathname}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(!raw && body !== undefined ? { "Content-Type": "application/json" } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}), ...headers },
          body: requestBody,
          duplex: raw && requestBody !== undefined ? "half" : undefined,
          signal: controller.signal
        });
        const retryable = response.status >= 500 || response.status === 429;
        if (!retryable || !retry || attempt === retries) {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw appError(payload.error || payload.message || `Worker request failed (${response.status}).`, response.status);
          return payload;
        }
        lastError = appError(`Worker request failed (${response.status}).`, response.status);
        await discardResponse(response);
        await sleep(retryDelay(response, attempt, random));
      } catch (error) {
        lastError = error;
        if (!retry || error?.statusCode && error.statusCode < 500 || attempt === retries) throw error;
        await sleep(retryDelay(null, attempt, random));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  function ownerRoute(suffix) { return `/v1/owners/${encodeURIComponent(ownerId)}/${suffix}`; }
  return {
    origin: baseUrl,
    ownerId,
    health: () => request("/health", { retry: false }),
    capabilities: async () => {
      const status = await request("/v1/status", { retry: false });
      const available = Array.isArray(status.capabilities) ? new Set(status.capabilities) : new Set();
      if (status.apiVersion !== 2 || REQUIRED_WORKER_CAPABILITIES.some((item) => !available.has(item))) {
        throw appError("Worker does not support the Pagecast V2 upload, access, and version APIs. Deploy a compatible Worker.", 409);
      }
      return { apiVersion: status.apiVersion, capabilities: [...available].sort() };
    },
    listVersions: (publicationId) => request(ownerRoute(`publications/${encodeURIComponent(publicationId)}`)),
    rollback: (publicationId, versionId, idempotencyKey = requestId()) => request(ownerRoute(`publications/${encodeURIComponent(publicationId)}/versions/${encodeURIComponent(versionId)}/rollback`), { method: "POST", body: {}, idempotencyKey }),
    setAccessPolicy: (publicationId, policy, idempotencyKey = requestId()) => request(ownerRoute(`publications/${encodeURIComponent(publicationId)}/access-policy`), { method: "PUT", body: policy, idempotencyKey }),
    setExpiry: (publicationId, expiresAt, idempotencyKey = requestId()) => request(ownerRoute(`publications/${encodeURIComponent(publicationId)}/access-policy`), { method: "PATCH", body: { expiresAt }, idempotencyKey }),
    async publish({ rootDir, title, mode = "create", publicationId, contextKey, slug, linkKind = "unlisted", operation = {}, checkpoint = async () => {}, beforeActivate = async () => {} } = {}) {
      const files = await buildWorkerManifest(rootDir);
      const key = operation.idempotencyKey || requestId();
      const manifestDigest = createHash("sha256").update(JSON.stringify(files.map(({ sourcePath, ...file }) => file))).digest("hex");
      if (operation.manifestDigest && operation.manifestDigest !== manifestDigest) {
        throw appError("The local files changed while a Worker upload was pending. Start a new publish instead of resuming it.", 409);
      }
      const session = operation.workerSessionId
        ? { sessionId: operation.workerSessionId, publicationId: operation.workerPublicationId, versionId: operation.workerVersionId }
        : await request(ownerRoute("upload-sessions"), { method: "POST", idempotencyKey: key, body: { mode, title, slug, linkKind, contextKey, publicationId, manifest: files.map(({ sourcePath, ...file }) => file) } });
      await checkpoint({ idempotencyKey: key, manifestDigest, workerSessionId: session.sessionId, workerPublicationId: session.publicationId, workerVersionId: session.versionId, uploadedPaths: operation.uploadedPaths || [] });
      const filePaths = new Set(files.map((file) => file.path));
      const uploadedPaths = new Set((operation.uploadedPaths || []).filter((filePath) => filePaths.has(filePath)));
      const pendingFiles = files.filter((file) => !uploadedPaths.has(file.path));
      const saveCheckpoint = async () => checkpoint({
        idempotencyKey: key,
        manifestDigest,
        workerSessionId: session.sessionId,
        workerPublicationId: session.publicationId,
        workerVersionId: session.versionId,
        uploadedPaths: files.filter((file) => uploadedPaths.has(file.path)).map((file) => file.path)
      });
      for (let start = 0; start < pendingFiles.length; start += PARALLELISM) {
        const completed = await Promise.all(pendingFiles.slice(start, start + PARALLELISM).map(async (file) => {
          await request(ownerRoute(`upload-sessions/${encodeURIComponent(session.sessionId)}/files/${encodeURIComponent(file.path)}`), {
            method: "PUT",
            raw: true,
            bodyFactory: () => createReadStream(file.sourcePath),
            headers: {
              "Content-Type": file.contentType,
              "Content-Length": String(file.bytes),
              "X-Content-SHA256": file.sha256
            },
            idempotencyKey: `${key}:${file.path}`
          });
          return file.path;
        }));
        for (const filePath of completed) uploadedPaths.add(filePath);
        await saveCheckpoint();
      }
      await request(ownerRoute(`upload-sessions/${encodeURIComponent(session.sessionId)}/complete`), { method: "POST", body: {}, idempotencyKey: `${key}:complete` });
      await beforeActivate({ publicationId: session.publicationId, versionId: session.versionId, idempotencyKey: key });
      const activation = await request(ownerRoute(`publications/${encodeURIComponent(session.publicationId)}/versions/${encodeURIComponent(session.versionId)}/activate`), { method: "POST", body: {}, idempotencyKey: `${key}:activate` });
      return { ...session, ...activation, idempotencyKey: key, files: files.map(({ sourcePath, ...file }) => file) };
    }
  };
}
