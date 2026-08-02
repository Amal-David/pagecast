import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, watch as fsWatch } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ADMIN_MUTATION_METHODS,
  DEFAULT_HOST,
  DEFAULT_LOCAL_HOSTNAME,
  EXTENSION_API_ROUTES,
  assertSafeAdminBind,
  extensionCorsOrigin,
  isLoopbackBindHost,
  isLoopbackHostHeader,
  requestOrigin,
  tokensMatch
} from "./admin-security.js";
export {
  DEFAULT_HOST,
  DEFAULT_LOCAL_HOSTNAME,
  assertSafeAdminBind,
  extensionCorsOrigin,
  isLoopbackBindHost,
  isLoopbackHostHeader,
  isWildcardBindHost
} from "./admin-security.js";
import { markdownToHtml } from "./markdown.js";
import { generateName } from "./nameGenerator.js";
import {
  LINK_KINDS,
  classifyLinkKind,
  createLinkSlug,
  inspectCapabilitySlug
} from "./link-policy.js";
import { createWranglerInvocation, selectBuildShell } from "./platform.js";
import { appError } from "./app-error.js";
export { appError } from "./app-error.js";
import {
  CLOUDFLARE_OAUTH_SCOPES,
  DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS,
  DEFAULT_PAGES_BRANCH,
  DEFAULT_PAGES_PROJECT_NAME,
  FEEDBACK_OAUTH_SCOPES,
  chooseWranglerPagesProject,
  cleanCommandOutput,
  cloudflareCredentialStatus,
  createCloudflareAuthManager,
  findKvNamespaceId,
  flagLiveDeployment,
  normalizeAccountId,
  normalizeAccountIdSafe,
  normalizeAccountName,
  normalizePagesBaseUrl,
  normalizePagesBranch,
  normalizePagesProjectName,
  normalizePagesProjectNameSafe,
  pagesBaseUrl,
  parseKvNamespaceId,
  parseWorkerDevUrl,
  parseWranglerPagesDeployments,
  parseWranglerPagesProjects,
  parseWranglerWhoamiAccounts,
  runSpawnCommand,
  selectDeploymentsToPrune,
  stripAnsi
} from "./wrangler-gateway.js";
export {
  CLOUDFLARE_OAUTH_SCOPES,
  DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS,
  DEFAULT_PAGES_BRANCH,
  DEFAULT_PAGES_PROJECT_NAME,
  FEEDBACK_OAUTH_SCOPES,
  chooseWranglerPagesProject,
  cloudflareCredentialStatus,
  createCloudflareAuthManager,
  findKvNamespaceId,
  flagLiveDeployment,
  parseKvNamespaceId,
  parseWorkerDevUrl,
  parseWranglerPagesDeployments,
  parseWranglerPagesProjects,
  parseWranglerWhoamiAccounts,
  selectDeploymentsToPrune
} from "./wrangler-gateway.js";
import { TunnelManager } from "./tunnel.js";
import { createPublicationService } from "./publication-service.js";
import { OG_CARD_FILENAME, OG_CARD_HEIGHT, OG_CARD_WIDTH, renderOgCard } from "./og-card.js";
export { TunnelManager, extractPublicUrl } from "./tunnel.js";
import {
  WorkspaceLease,
  atomicWriteJson,
  tryInvokeLiveCommand
} from "./state-coordinator.js";
import {
  PAGECAST_PROJECT_MARKER_FILE,
  encodeProjectOwnershipMarker,
  normalizeCustomDomain,
  normalizeProjectRef,
  normalizeStoredProjectRef,
  projectRefEquals,
  projectRefFilesystemKey,
  publicBaseUrl,
  validateOwnershipMarker
} from "./project-ref.js";
import {
  PAGECAST_SYNC_MANIFEST_PATH,
  isValidPasswordHash,
  makePasswordHash,
  renderAuthMiddleware,
  renderRoutesJson
} from "./crypto.js";
import {
  findPublicationForPublish,
  normalizePublishMode,
  resolvePublicationContext
} from "./publication-context.js";
import { registerPagecastWorkspace } from "./pagecast-home.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_ADMIN_PORT = 4173;
export const DEFAULT_PUBLIC_PORT = 4174;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_FOLDER_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_FOLDER_UPLOAD_FILES = 1000;
export const MAX_FOLDER_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const PAGECAST_MARKETING_PROJECT_NAME = "pagecasthq";
const PAGECAST_MARKETING_REQUIRED_FILES = ["index.html", "og-image.png"];
const MAX_SYNC_IMPORT_FILES = MAX_FOLDER_UPLOAD_FILES;
const MAX_SYNC_IMPORT_BYTES = MAX_FOLDER_UPLOAD_BYTES;
const MAX_SYNC_IMPORT_FILE_BYTES = MAX_FOLDER_UPLOAD_FILE_BYTES;
const MAX_PUBLIC_URL_IMPORT_FILES = 80;
const SYNC_MANIFEST_FETCH_TIMEOUT_MS = 5000;
const PUBLIC_URL_SKIPPED_ASSET_EXTENSIONS = new Set([
  ".mp3",
  ".mp4",
  ".m4a",
  ".mov",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".flac"
]);
const PREVIEW_SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Resource-Policy": "same-origin"
};

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".map", "application/json; charset=utf-8"]
]);

function isProvisionablePagesError(error) {
  const message = stripAnsi(error?.message || "");
  return /project.*not.*found|could not find.*project|does not exist|no such project|account|select an account/i.test(
    message
  );
}

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function nowIso() {
  return new Date().toISOString();
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function joinUrl(baseUrl, suffix) {
  return `${stripTrailingSlash(baseUrl)}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isHtmlFileName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

function isMarkdownFileName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

// Any file type pagecast can turn into a published page: HTML as-is, or Markdown
// rendered to HTML at publish/preview time.
function isPublishableFileName(fileName) {
  return isHtmlFileName(fileName) || isMarkdownFileName(fileName);
}

function isIndexFileName(fileName) {
  const base = path.basename(fileName).toLowerCase();
  return base === "index.html" || base === "index.htm" || base === "index.md" || base === "index.markdown";
}

// Display name for a report. A bare `index.html` is meaningless when many
// reports share it, so for generic entry files fall back to the parent folder
// name (e.g. /path/lissin-wall-of-love/index.html -> "lissin-wall-of-love").
export function deriveReportName(filePath) {
  const base = path.basename(filePath);
  if (isIndexFileName(base)) {
    const parent = path.basename(path.dirname(filePath));
    if (parent && parent !== "." && parent !== path.sep) {
      return parent;
    }
  }
  return base;
}

function slugifyReportName(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const slug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "report";
}

const RESERVED_SLUGS = new Set(["p", "index", "404", ""]);

// Validate a user-supplied vanity slug for the /p/<slug>/ URL path. Enforces a
// DNS-label-like shape (lowercase, hyphen-separated, 1-63 chars) and rejects the
// reserved path segments that would collide with the staged site structure.
function normalizeCustomSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw appError("Custom URL must be 1-63 lowercase letters, numbers, or hyphens.", 400);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw appError("That custom URL is reserved. Choose another.", 400);
  }
  return slug;
}

function normalizePublicationToken(value) {
  const token = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(token)) {
    throw appError("Publication token must be a non-empty URL-safe identifier.", 400);
  }
  return token;
}

function publicationTokenFilesystemKey(value) {
  const token = String(value || "");
  if (!token) {
    throw appError("Publication token is required.", 400);
  }
  return `token-${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function createReportId(fileName) {
  return `${slugifyReportName(fileName)}-${randomBytes(4).toString("hex")}`;
}

// Recover the memorable prefix from capability-bearing tokens while leaving
// existing word-only slugs unchanged.
export function publicTokenNamePrefix(token) {
  return String(token || "").replace(/-[0-9a-f]{32}$/i, "");
}

// New unlisted links combine a memorable prefix with 128 random capability bits.
// Existing word-only links remain valid and are never rotated automatically.
export function createPublicToken(isNameTaken = () => false, { drop = false } = {}) {
  return createLinkSlug({
    kind: drop ? LINK_KINDS.DROP : LINK_KINDS.UNLISTED,
    isTaken: isNameTaken,
    generateMemorableName: () => generateName()
  });
}

function isPathInside(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectRootImportSlug(projectName) {
  const normalized = normalizePagesProjectName(projectName);
  const rootSuffix = "-root";
  return normalizeCustomSlug(
    `${normalized.slice(0, 63 - rootSuffix.length).replace(/-+$/g, "")}${rootSuffix}`
  );
}

async function assertSafePagesDeployRoot(rootDir, projectName) {
  if (projectName !== PAGECAST_MARKETING_PROJECT_NAME) {
    return;
  }

  const missing = [];
  for (const fileName of PAGECAST_MARKETING_REQUIRED_FILES) {
    try {
      const stat = await fs.stat(path.join(rootDir, fileName));
      if (!stat.isFile()) {
        missing.push(fileName);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        missing.push(fileName);
        continue;
      }
      throw error;
    }
  }

  if (missing.length > 0) {
    throw appError(
      `Refusing to deploy ${PAGECAST_MARKETING_PROJECT_NAME}.pages.dev without ${missing.join(", ")}. ` +
        "That project hosts Pagecast's public landing page; use a dedicated Pages project for published reports or deploy the full landing bundle.",
      400
    );
  }
}

function pagesProjectNameFromPublicUrl(publicUrl) {
  try {
    const hostname = new URL(publicUrl).hostname.toLowerCase();
    if (!hostname.endsWith(".pages.dev")) {
      return "";
    }
    return normalizePagesProjectNameSafe(hostname.slice(0, -".pages.dev".length));
  } catch {
    return "";
  }
}

function publicUrlOrigin(publicUrl) {
  try {
    return stripTrailingSlash(new URL(publicUrl).origin);
  } catch {
    return "";
  }
}

function redirectTargetSlug(value) {
  try {
    const pathname = new URL(String(value || ""), "https://pagecast.invalid").pathname;
    const match = /^\/p\/([^/]+)\/?$/.exec(pathname);
    return match ? normalizeCustomSlug(decodeURIComponent(match[1])) : "";
  } catch {
    return "";
  }
}

function inferLegacyRedirectProjectRef(redirect, publications) {
  const targetSlug = redirectTargetSlug(redirect?.to);
  if (!targetSlug) {
    return null;
  }

  const candidates = new Map();
  for (const publication of publications || []) {
    if (
      publication?.revokedAt ||
      (publication?.kind && publication.kind !== "snapshot") ||
      (publication?.slug || publication?.token) !== targetSlug
    ) {
      continue;
    }
    try {
      const projectRef = normalizeStoredProjectRef(publication, { allowLegacy: true });
      if (projectRef) {
        candidates.set(projectRefFilesystemKey(projectRef), projectRef);
      }
    } catch {
      // Invalid or partial legacy identity is not sufficient attribution.
    }
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

function pagesConfigForPublication(publication, currentPages) {
  const currentProjectName = normalizePagesProjectNameSafe(currentPages?.projectName) || DEFAULT_PAGES_PROJECT_NAME;
  const currentBaseUrl = stripTrailingSlash(currentPages?.baseUrl || pagesBaseUrl(currentProjectName));
  const publicOrigin = publicUrlOrigin(publication.publicUrl);
  let storedProjectRef = null;
  try {
    storedProjectRef = normalizeStoredProjectRef(publication, { allowLegacy: true });
  } catch {
    storedProjectRef = null;
  }

  if (!storedProjectRef) {
    throw appError(
      `This legacy published link${publicOrigin ? ` belongs to ${publicOrigin}` : ""}, but its Cloudflare account/project identity was not recorded. Select and adopt the original project before syncing it.`,
      409
    );
  }

  const projectRef = storedProjectRef;
  const storedBaseUrl = publication.pagesBaseUrl ? stripTrailingSlash(publication.pagesBaseUrl) : "";

  return {
    ...currentPages,
    projectName: projectRef.projectName,
    accountId: projectRef.accountId,
    accountName: publication.pagesAccountName || currentPages?.accountName || "",
    branch: DEFAULT_PAGES_BRANCH,
    baseUrl:
      storedBaseUrl ||
      projectRef.baseUrl ||
      (projectRefEquals(projectRef, currentPages) ? currentBaseUrl : pagesBaseUrl(projectRef.projectName))
  };
}

function rememberPublicationPagesTarget(publication, pagesConfig) {
  publication.pagesProjectName = pagesConfig.projectName;
  publication.pagesAccountId = normalizeAccountIdSafe(pagesConfig.accountId);
  publication.pagesAccountName = normalizeAccountName(pagesConfig.accountName || "");
  publication.pagesBaseUrl = stripTrailingSlash(pagesConfig.baseUrl || pagesBaseUrl(pagesConfig.projectName));
  if (publication.pagesAccountId) {
    publication.projectRef = {
      accountId: publication.pagesAccountId,
      projectName: publication.pagesProjectName,
      baseUrl: publication.pagesBaseUrl
    };
  }
}

async function persistActualPublicationOrigin(publication, configStore) {
  const baseUrl = publicUrlOrigin(publication?.publicUrl);
  if (!baseUrl) {
    return;
  }
  publication.pagesBaseUrl = baseUrl;
  if (publication.projectRef) {
    publication.projectRef = { ...publication.projectRef, baseUrl };
  }
  const current = configStore.get().pages;
  if (
    publication.projectRef &&
    projectRefEquals(publication.projectRef, current) &&
    stripTrailingSlash(current.baseUrl) !== baseUrl
  ) {
    await configStore.updatePages({ baseUrl });
  }
}

const OPERATION_RECOVERY_COPY = Object.freeze({
  publish: {
    title: "Publish needs attention",
    summary: "Pagecast did not finish making this link available.",
    action: "Retry publish"
  },
  sync: {
    title: "Link sync needs attention",
    summary: "The saved page and its published link are out of sync.",
    action: "Retry sync"
  },
  auto_sync: {
    title: "Automatic sync needs attention",
    summary: "A watched source changed, but its published link was not updated.",
    action: "Retry sync"
  },
  content_sync: {
    title: "Saved content needs attention",
    summary: "The edit is saved locally, but its published link was not updated.",
    action: "Retry sync"
  },
  password_sync: {
    title: "Password state needs attention",
    summary: "The published link may not match Pagecast's current protection state.",
    action: "Reconcile protection"
  },
  password_compensate: {
    title: "Password rollback needs attention",
    summary: "Pagecast could not restore one published target after a partial password change.",
    action: "Reconcile protection"
  },
  rename: {
    title: "Link rename needs attention",
    summary: "Pagecast did not finish moving this link to its requested path.",
    action: "Retry rename"
  },
  goal_sync: {
    title: "Goal page sync needs attention",
    summary: "The latest goal page is staged locally but was not fully published.",
    action: "Retry goal sync"
  },
  revoke: {
    title: "Link cleanup needs attention",
    summary: "Pagecast could not finish taking this link offline.",
    action: "Retry revoke"
  }
});

function operationRecoveryMissingMetadata(operation) {
  if (!operation || !OPERATION_RECOVERY_COPY[operation.type]) {
    return "This operation type is not supported by this version of Pagecast.";
  }
  if (operation.type === "publish") {
    if (
      typeof operation.reportId !== "string" ||
      !operation.publication ||
      operation.publication.token !== operation.token
    ) {
      return "This older publish record does not contain enough state for an automatic retry.";
    }
    if (
      operation.remoteSucceeded === true &&
      !operation.publicUrl &&
      !operation.publication.publicUrl
    ) {
      return "The remote publish checkpoint is missing its resulting URL.";
    }
  }
  if (
    ["sync", "auto_sync", "content_sync", "password_sync", "password_compensate"].includes(
      operation.type
    ) &&
    typeof operation.reportId !== "string"
  ) {
    return "This older sync record does not identify its source page.";
  }
  if (
    operation.type === "rename" &&
    (typeof operation.previousSlug !== "string" || !operation.previousSlug)
  ) {
    return "This older rename record does not contain the previous link path.";
  }
  if (
    operation.type === "goal_sync" &&
    (typeof operation.reportId !== "string" ||
      typeof operation.goalFile !== "string" ||
      !operation.goalFile)
  ) {
    return "This older goal-sync record does not contain the source-file intent.";
  }
  return null;
}

function formatOperationForApi(operation) {
  const copy = OPERATION_RECOVERY_COPY[operation?.type] || {
    title: "Operation needs attention",
    summary: "Pagecast could not determine how to finish this operation safely.",
    action: null
  };
  const manualReason = operationRecoveryMissingMetadata(operation);
  return {
    id: operation.id,
    type: operation.type,
    token: operation.token,
    slug: operation.slug || operation.token,
    projectRef: operation.projectRef || null,
    status: operation.status === "failed" ? "failed" : "pending",
    error: typeof operation.error === "string" ? operation.error : "",
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    attempts: Number.isInteger(operation.attempts) ? operation.attempts : 0,
    recovery: {
      mode: manualReason ? "manual" : "automatic",
      title: copy.title,
      summary: copy.summary,
      action: manualReason ? null : copy.action,
      manualReason
    }
  };
}

function formatOperationsForApi(store) {
  return store.listOperations().map(formatOperationForApi);
}

// Derive the REAL production base URL from a `wrangler pages deploy` output.
// Cloudflare Pages subdomains are globally unique, so a project named "pagecast"
// whose subdomain is taken gets e.g. "pagecast-6cv.pages.dev" — the subdomain is
// NOT always the project name. Wrangler prints the deployment URL as
// `https://<deploy-hash>.<project-subdomain>.pages.dev`; strip the leading hash
// label to get the production host. Falls back to `<projectName>.pages.dev`.
function pagesBaseUrlFromDeployOutput(output, projectName) {
  const text = stripAnsi(output || "");
  const match = text.match(/https:\/\/[0-9a-f]{6,12}\.([a-z0-9-]+\.pages\.dev)/i);
  if (match) {
    return `https://${match[1].toLowerCase()}`;
  }
  return pagesBaseUrl(projectName);
}

function pagesDeploymentUrlFromDeployOutput(output, fallbackUrl = "") {
  const text = stripAnsi(output || "");
  const match = text.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pages\.dev(?:\/[^\s"'<>)]*)?/i);
  if (match) {
    return match[0].replace(/[),.;]+$/g, "");
  }
  return fallbackUrl;
}

// Normalize the persisted feedback (reactions + analytics) settings. Returns
// null until the feedback Worker has been provisioned, so callers can treat the
// whole feature as off by checking for a truthy `feedback`.
function normalizeFeedback(feedback) {
  if (!feedback || typeof feedback !== "object") {
    return null;
  }
  const url = String(feedback.url || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+/i.test(url)) {
    return null;
  }
  return {
    url,
    statsToken: String(feedback.statsToken || ""),
    visitorSecret: String(feedback.visitorSecret || ""),
    workerName: String(feedback.workerName || ""),
    kvId: String(feedback.kvId || ""),
    d1Id: String(feedback.d1Id || ""),
    analyticsEnabled: feedback.analyticsEnabled !== false,
    reactionsEnabled: feedback.reactionsEnabled === true
  };
}

// The live goal-progress page currently published, or null. Tracks the
// publication (token/slug) so updates re-sync the SAME URL in place rather than
// minting a new link.
function normalizeGoal(goal) {
  if (!goal || typeof goal !== "object") {
    return null;
  }
  const token = String(goal.token || "");
  const url = String(goal.url || "").trim();
  if (!token || !/^https:\/\/[^\s/]+/i.test(url)) {
    return null;
  }
  return {
    token,
    slug: String(goal.slug || token),
    url,
    file: String(goal.file || ""),
    expiresAt:
      typeof goal.expiresAt === "number" && goal.expiresAt > 0
        ? goal.expiresAt
        : null,
    startedAt: String(goal.startedAt || ""),
    updatedAt: String(goal.updatedAt || "")
  };
}

// Parse a human duration ("12h", "7d", "30d", "never") into milliseconds, or
// null for never / permanent. Throws appError(400) on malformed input.
export function parseDuration(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "never" || raw === "none" || raw === "permanent") {
    return null;
  }
  const match = /^(\d+)\s*(h|d|m)$/.exec(raw);
  const n = match ? Number(match[1]) : NaN;
  if (!match || !Number.isFinite(n) || n <= 0) {
    throw appError(`Invalid duration "${value}". Use e.g. 12h, 2d, 30d, or never.`, 400);
  }
  const unitMs = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 86_400_000;
  return n * unitMs;
}

// Resolve the absolute expiry (epoch ms, or null = never) for a publish, given
// an optional explicit duration and the configured default.
export function resolveExpiresAt({ expires, defaultExpiry } = {}) {
  const hasExplicit = expires !== undefined && expires !== null && String(expires).trim() !== "";
  const ms = parseDuration(hasExplicit ? expires : defaultExpiry);
  return ms === null ? null : Date.now() + ms;
}

// Validate a configured default-expiry string; fall back to "30d" on garbage.
function normalizeDefaultExpiry(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return "30d";
  }
  if (raw === "never" || raw === "none" || raw === "permanent") {
    return "never";
  }
  try {
    parseDuration(raw);
    return raw;
  } catch {
    return "30d";
  }
}

function normalizeLocalPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeRuntimePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

function normalizeLocalHostname(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return isLoopbackBindHost(hostname) ? hostname : DEFAULT_LOCAL_HOSTNAME;
}

function normalizeLocalConfig(local = {}) {
  return {
    hostname: normalizeLocalHostname(local.hostname || DEFAULT_LOCAL_HOSTNAME),
    adminPort: normalizeLocalPort(local.adminPort, DEFAULT_ADMIN_PORT),
    publicPort: normalizeLocalPort(local.publicPort, DEFAULT_PUBLIC_PORT)
  };
}

function normalizeManagedTargets(value) {
  const targets = [];
  const seen = new Set();
  for (const candidate of Array.isArray(value) ? value : []) {
    try {
      const projectRef = normalizeProjectRef(candidate);
      const key = projectRefFilesystemKey(projectRef);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(projectRef);
      }
    } catch {
      // Invalid legacy ownership records are ignored rather than trusted.
    }
  }
  return targets;
}

function normalizeConfig(config = {}) {
  const projectName = normalizePagesProjectName(
    config.pages?.projectName || DEFAULT_PAGES_PROJECT_NAME
  );
  const accountId = normalizeAccountId(config.pages?.accountId || "");
  const accountName = accountId ? normalizeAccountName(config.pages?.accountName || "") : "";

  return {
    pages: {
      projectName,
      accountId,
      accountName,
      branch: DEFAULT_PAGES_BRANCH,
      baseUrl: normalizePagesBaseUrl(config.pages?.baseUrl, projectName)
    },
    feedback: normalizeFeedback(config.feedback),
    // A subtle "Published with Pagecast" badge on shared pages (the word-of-mouth
    // loop). On by default; can be turned off (the white-label/monetization lever).
    badge: config.badge !== false,
    // The currently-published live goal-progress page (or null).
    goal: normalizeGoal(config.goal),
    // Default link lifetime for new publishes ("30d" out of the box, "never" =
    // permanent). Configurable; a per-publish --expires overrides it.
    defaultExpiry: normalizeDefaultExpiry(config.defaultExpiry),
    // Keep the local dashboard reconciled with Pagecast's Cloudflare Pages
    // manifest by default. The UI can turn this off for workspaces where the
    // operator wants manual-only imports.
    cloudflareSyncEnabled: config.cloudflareSyncEnabled !== false,
    // Friendly local dashboard identity. These are advisory runtime defaults:
    // explicit CLI args / env vars still win, and fallback ports are persisted.
    local: normalizeLocalConfig(config.local),
    // HMAC secret for signing edge password-gate session cookies. Generated once
    // (see createConfigStore.init) and kept stable so cookies survive redeploys;
    // preserved here so partial config rebuilds don't drop it.
    authCookieSecret:
      typeof config.authCookieSecret === "string" && config.authCookieSecret
        ? config.authCookieSecret
        : null,
    // Independent token for the public sync-manifest endpoint. It must not reuse
    // the cookie-signing secret because it travels as a query parameter.
    syncSecret:
      typeof config.syncSecret === "string" && config.syncSecret
        ? config.syncSecret
        : null,
    // Telemetry is enabled by default. An explicit persisted false remains the
    // durable opt-out; environment overrides are resolved at command time.
    telemetry: config.telemetry !== false,
    // Opaque random install id (no PII). Generated lazily only when telemetry is
    // enabled and about to send; stripped from any client-/CLI-facing config.
    telemetryId:
      typeof config.telemetryId === "string" && config.telemetryId
        ? config.telemetryId
        : null,
    // Whether the one-time first-run telemetry notice has been shown.
    telemetryNotified: config.telemetryNotified === true,
    installationId:
      typeof config.installationId === "string" && /^[a-f0-9]{32}$/.test(config.installationId)
        ? config.installationId
        : null,
    managedTargets: normalizeManagedTargets(config.managedTargets)
  };
}

async function copyPublicTree(sourceRoot, destinationRoot, { excludedRoots = [] } = {}) {
  const blockedRoots = [destinationRoot, ...excludedRoots].map((entry) => path.resolve(entry));
  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.mkdir(destinationRoot, { recursive: true });

  async function copyDirectory(currentSource, currentRelative = "") {
    const entries = await fs.readdir(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const sourcePath = path.join(currentSource, entry.name);
      if (blockedRoots.some((blockedRoot) => isPathInside(blockedRoot, sourcePath))) {
        continue;
      }
      const relativePath = path.join(currentRelative, entry.name);
      const destinationPath = path.join(destinationRoot, relativePath);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await copyDirectory(sourcePath, relativePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(sourcePath, destinationPath);
    }
  }

  await copyDirectory(sourceRoot);
}

async function listPublicTreeFiles(rootDir) {
  const files = [];

  async function walk(currentSource, currentRelative = "") {
    const entries = await fs.readdir(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const sourcePath = path.join(currentSource, entry.name);
      const relativePath = path.join(currentRelative, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(sourcePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push(relativePath.split(path.sep).join("/"));
    }
  }

  try {
    await walk(rootDir);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function firstUsableIso(...values) {
  for (const value of values) {
    const text = String(value || "");
    if (text && !Number.isNaN(Date.parse(text))) {
      return new Date(text).toISOString();
    }
  }
  return nowIso();
}

function normalizeSyncRecord(record, { baseUrl = "", source = "" } = {}) {
  let slug;
  try {
    slug = normalizeCustomSlug(record?.slug);
  } catch {
    return null;
  }
  const files = Array.isArray(record?.files)
    ? record.files
        .map((file) => (typeof file === "string" ? file : file?.path))
        .filter((file) => typeof file === "string" && file.trim())
    : [];
  let token;
  try {
    token = normalizePublicationToken(record?.token || slug);
  } catch {
    token = slug;
  }
  return {
    slug,
    source,
    files,
    title: String(record?.title || record?.name || "").trim(),
    label: String(record?.label || "imported").trim(),
    token,
    publicUrl: String(record?.publicUrl || record?.url || "").trim(),
    baseUrl: String(record?.baseUrl || baseUrl || "").trim(),
    createdAt: firstUsableIso(record?.createdAt, record?.created_on),
    updatedAt: firstUsableIso(record?.updatedAt, record?.modified_on, record?.createdAt, record?.created_on)
  };
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = SYNC_MANIFEST_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safePublicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function relativePublicRootPath(publicUrl) {
  if (publicUrl.pathname.endsWith("/")) {
    return publicUrl.pathname;
  }
  return `${path.posix.dirname(publicUrl.pathname)}/`;
}

function localPathForPublicAsset(assetUrl, publicUrl) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(assetUrl.pathname);
  } catch {
    return null;
  }

  const rootPath = relativePublicRootPath(publicUrl);
  const withoutRoot = decodedPath.startsWith(rootPath)
    ? decodedPath.slice(rootPath.length)
    : decodedPath.replace(/^\/+/, "");
  const localPath = withoutRoot.replace(/^\/+/, "");
  if (!localPath || localPath.endsWith("/")) {
    return null;
  }

  const normalized = normalizeAssetRequestPath(localPath);
  return normalized ? normalized.split(path.sep).join("/") : null;
}

function shouldSkipPublicUrlAsset(localPath) {
  return PUBLIC_URL_SKIPPED_ASSET_EXTENSIONS.has(path.posix.extname(localPath).toLowerCase());
}

function publicAssetUrl(rawValue, baseUrl, rootUrl) {
  const value = String(rawValue || "").trim();
  if (
    !value ||
    value.startsWith("#") ||
    /^(?:data|blob|mailto|tel|javascript):/i.test(value)
  ) {
    return null;
  }

  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }

  if (url.origin !== rootUrl.origin || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return null;
  }

  const localPath = localPathForPublicAsset(url, rootUrl);
  if (!localPath || localPath === "index.html") {
    return null;
  }
  if (shouldSkipPublicUrlAsset(localPath)) {
    return null;
  }

  return { url, localPath, rawValue: value };
}

function isLikelyHrefAsset(value) {
  const href = String(value || "").trim();
  if (!href || href.startsWith("#")) {
    return false;
  }
  try {
    const pathname = new URL(href, "https://pagecast.local").pathname;
    return /\.[a-z0-9]{2,8}$/i.test(pathname);
  } catch {
    return false;
  }
}

function extractHtmlAssetReferences(html, baseUrl, rootUrl) {
  const references = [];
  const attrPattern = /\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi;
  let match;
  while ((match = attrPattern.exec(html))) {
    const attr = match[1].toLowerCase();
    const rawValue = match[3];
    if (attr === "href" && !isLikelyHrefAsset(rawValue)) {
      continue;
    }
    const asset = publicAssetUrl(rawValue, baseUrl, rootUrl);
    if (asset) {
      references.push(asset);
    }
  }
  return references;
}

function extractCssAssetReferences(css, baseUrl, rootUrl) {
  const references = [];
  const urlPattern = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  let match;
  while ((match = urlPattern.exec(css))) {
    const asset = publicAssetUrl(match[2], baseUrl, rootUrl);
    if (asset) {
      references.push(asset);
    }
  }
  return references;
}

function rewriteReferences(content, replacements) {
  let rewritten = content;
  for (const [from, to] of replacements) {
    rewritten = rewritten.split(from).join(to);
  }
  return rewritten;
}

function relativeReference(fromFile, toFile) {
  const fromDir = path.posix.dirname(fromFile);
  const relative = path.posix.relative(fromDir, toFile);
  return relative || path.posix.basename(toFile);
}

async function readSyncImportResponse(response, totalBytes) {
  const lengthHeader = response.headers.get("content-length");
  const contentLength = /^\d+$/.test(lengthHeader || "") ? Number(lengthHeader) : null;
  if (contentLength !== null && contentLength > MAX_SYNC_IMPORT_FILE_BYTES) {
    throw appError("Synced page includes a file that is too large.", 413);
  }
  if (contentLength !== null && totalBytes + contentLength > MAX_SYNC_IMPORT_BYTES) {
    throw appError("Synced page is too large.", 413);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw appError("Could not read synced page response.", 502);
  }

  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_SYNC_IMPORT_FILE_BYTES) {
        throw appError("Synced page includes a file that is too large.", 413);
      }
      if (totalBytes + received > MAX_SYNC_IMPORT_BYTES) {
        throw appError("Synced page is too large.", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }

  const content = Buffer.concat(chunks, received);
  return { content, totalBytes: totalBytes + content.length };
}

async function copyPublicUrlFiles({ publicUrl, destinationRoot, fetchImpl = fetch } = {}) {
  const rootUrl = safePublicUrl(publicUrl);
  if (!rootUrl) {
    throw appError("A public URL is required to recover this page.", 400);
  }

  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.mkdir(destinationRoot, { recursive: true });

  const rootResponse = await fetchWithTimeout(fetchImpl, rootUrl.href, {
    headers: { Accept: "text/html,application/xhtml+xml" }
  });
  if (!rootResponse.ok) {
    throw appError(`Could not recover the published page (${rootResponse.status}).`, 502);
  }

  let totalBytes = 0;
  const rootBody = await readSyncImportResponse(rootResponse, totalBytes);
  totalBytes = rootBody.totalBytes;
  let html = rootBody.content.toString("utf8");
  const queued = [];
  const seen = new Set(["index.html"]);
  let fileCount = 1;

  function enqueue(asset) {
    if (!asset || seen.has(asset.localPath)) {
      return;
    }
    if (fileCount >= MAX_PUBLIC_URL_IMPORT_FILES) {
      return;
    }
    seen.add(asset.localPath);
    fileCount += 1;
    queued.push(asset);
  }

  const htmlReplacements = new Map();
  for (const asset of extractHtmlAssetReferences(html, rootUrl.href, rootUrl)) {
    enqueue(asset);
    htmlReplacements.set(asset.rawValue, asset.localPath);
  }
  html = rewriteReferences(html, htmlReplacements);
  await fs.writeFile(path.join(destinationRoot, "index.html"), html, "utf8");

  for (let index = 0; index < queued.length; index += 1) {
    const asset = queued[index];
    const response = await fetchWithTimeout(fetchImpl, asset.url.href);
    if (!response.ok) {
      continue;
    }
    let body;
    try {
      body = await readSyncImportResponse(response, totalBytes);
    } catch (error) {
      if (error.statusCode === 413) {
        continue;
      }
      throw error;
    }
    totalBytes = body.totalBytes;
    const destinationPath = path.resolve(destinationRoot, asset.localPath);
    if (!isPathInside(destinationRoot, destinationPath)) {
      throw appError("Synced page includes an unsafe file path.", 400);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/css") || asset.localPath.endsWith(".css")) {
      let css = body.content.toString("utf8");
      const cssReplacements = new Map();
      for (const nestedAsset of extractCssAssetReferences(css, asset.url.href, rootUrl)) {
        enqueue(nestedAsset);
        cssReplacements.set(
          nestedAsset.rawValue,
          relativeReference(asset.localPath, nestedAsset.localPath)
        );
      }
      css = rewriteReferences(css, cssReplacements);
      body = { ...body, content: Buffer.from(css, "utf8") };
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, body.content);
  }

  return { entryFile: "index.html", files: await listPublicTreeFiles(destinationRoot) };
}

export function trimPastedLocalPathInput(inputPath) {
  if (typeof inputPath !== "string") {
    return "";
  }

  let value = inputPath.trim();
  const wrappers = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["<", ">"]
  ];

  let changed = true;
  while (changed && value.length >= 2) {
    changed = false;
    for (const [open, close] of wrappers) {
      if (value.startsWith(open) && value.endsWith(close)) {
        value = value.slice(1, -1).trim();
        changed = true;
      }
    }
  }

  return value;
}

function coercePastedValueToLocalPath(value) {
  const schemeMatch = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(value);
  // A single-letter "scheme" is a Windows drive letter (e.g. `C:\...`), not a URL
  // scheme — treat it as a local path. (Real URL schemes are always 2+ chars.)
  if (!schemeMatch || schemeMatch[1].length === 1) {
    return value.replace(/^~(?=$|\/)/, os.homedir());
  }

  if (schemeMatch[1].toLowerCase() !== "file") {
    throw appError("Only local file paths or file:// URLs can be shared.", 400);
  }

  try {
    return fileURLToPath(value);
  } catch {
    throw appError("File URL could not be converted to a local path.", 400);
  }
}

export function localHtmlPathCandidates(inputPath) {
  const trimmedValue = trimPastedLocalPathInput(inputPath);
  const trailingTrimmedValue = trimmedValue.replace(/[),.;]+$/g, "");
  const values = [trimmedValue, trailingTrimmedValue].filter(
    (value, index, allValues) => value && allValues.indexOf(value) === index
  );

  return values.map(coercePastedValueToLocalPath);
}

export function normalizeAssetRequestPath(rawPath) {
  const trimmed = rawPath.replace(/^\/+/, "");
  if (trimmed === "") {
    return "";
  }

  let decoded;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) {
    return null;
  }

  const segments = decoded.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith(".")
    )
  ) {
    return null;
  }

  return segments.join(path.sep);
}

export async function normalizeLocalHtmlPath(inputPath) {
  if (typeof inputPath !== "string" || trimPastedLocalPathInput(inputPath) === "") {
    throw appError("Provide an absolute path to an HTML file.", 400);
  }

  const candidates = localHtmlPathCandidates(inputPath);
  let missingError = null;

  for (const [index, candidate] of candidates.entries()) {
    try {
      return await normalizeLocalHtmlPathCandidate(candidate);
    } catch (error) {
      const hasFallbackCandidate = index < candidates.length - 1;
      if (
        error.statusCode === 404 ||
        (hasFallbackCandidate && error.statusCode === 400 && /Only \.html/.test(error.message))
      ) {
        missingError = error;
        continue;
      }
      throw error;
    }
  }

  throw missingError || appError("HTML file was not found.", 404);
}

export async function normalizeLocalFolderPath(inputPath) {
  if (typeof inputPath !== "string" || trimPastedLocalPathInput(inputPath) === "") {
    throw appError("Provide an absolute path to a folder.", 400);
  }

  const candidates = localHtmlPathCandidates(inputPath);
  let missingError = null;

  for (const candidate of candidates) {
    const resolvedPath = path.resolve(candidate);
    if (!path.isAbsolute(candidate)) {
      throw appError("Folder path must be absolute.", 400);
    }
    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        missingError = appError("Folder was not found.", 404);
        continue;
      }
      throw error;
    }
    if (!stat.isDirectory()) {
      throw appError("Folder path must point to a directory.", 400);
    }
    if (path.basename(resolvedPath).startsWith(".")) {
      throw appError("Hidden folders are not served.", 400);
    }
    return resolvedPath;
  }

  throw missingError || appError("Folder was not found.", 404);
}

async function findFolderEntry(rootDir, preferredEntry = "") {
  const candidates = [
    preferredEntry,
    "index.html",
    "index.htm",
    "index.md",
    "index.markdown"
  ].filter(Boolean);

  for (const candidate of candidates) {
    const normalized = normalizeAssetRequestPath(candidate);
    if (!normalized || normalized !== candidate.split("/").join(path.sep)) {
      continue;
    }
    const candidatePath = path.resolve(rootDir, normalized);
    if (!isPathInside(rootDir, candidatePath) || !isIndexFileName(candidatePath)) {
      continue;
    }
    try {
      const stat = await fs.stat(candidatePath);
      if (stat.isFile()) {
        return normalized;
      }
    } catch {
      // Try the next conventional entry candidate.
    }
  }

  throw appError("Folder must contain index.html, index.htm, index.md, or index.markdown.", 400);
}

async function detectBuildOutputDir(sourceRoot, preferredOutput = "") {
  const candidates = [preferredOutput, "dist", "build", "out", "site", "public"]
    .filter(Boolean)
    .map((candidate) => normalizeAssetRequestPath(candidate))
    .filter(Boolean);

  for (const candidate of candidates) {
    const outputRoot = path.resolve(sourceRoot, candidate);
    if (!isPathInside(sourceRoot, outputRoot)) {
      continue;
    }
    try {
      const stat = await fs.stat(outputRoot);
      if (stat.isDirectory()) {
        const entryFile = await findFolderEntry(outputRoot);
        return { outputRoot, outputDir: candidate, entryFile };
      }
    } catch {
      // Try the next conventional output candidate.
    }
  }

  throw appError("Build finished, but no deployable output folder was found. Set an output directory such as dist, build, out, site, or public.", 400);
}

async function normalizeLocalHtmlPathCandidate(candidatePath) {
  const expandedPath = candidatePath;
  if (!path.isAbsolute(expandedPath)) {
    throw appError("Report path must be absolute.", 400);
  }

  const resolvedPath = path.resolve(expandedPath);
  if (!isPublishableFileName(resolvedPath)) {
    throw appError("Only .html, .htm, .md, and .markdown files can be shared.", 400);
  }

  if (path.basename(resolvedPath).startsWith(".")) {
    throw appError("Hidden files are not served.", 400);
  }

  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw appError("HTML file was not found.", 404);
    }
    throw error;
  }

  if (!stat.isFile()) {
    throw appError("Report path must point to a file.", 400);
  }

  return resolvedPath;
}

export function createConfigStore({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  atomicWriteJsonImpl = atomicWriteJson
} = {}) {
  const configPath = path.join(dataDir, "config.json");
  let config = normalizeConfig();
  let mutationChain = Promise.resolve();

  async function persistConfig(nextConfig) {
    const snapshot = structuredClone(nextConfig);
    await atomicWriteJsonImpl(configPath, snapshot);
  }

  function enqueueConfigMutation(buildNext) {
    const operation = mutationChain.then(async () => {
      const nextConfig = buildNext(config);
      // Install the next in-memory state only after its atomic file replacement
      // succeeds. A rejected write can therefore never leak into a later save.
      await persistConfig(nextConfig);
      config = nextConfig;
      return get();
    });
    mutationChain = operation.catch(() => {});
    return operation;
  }

  // Generate local secrets once and keep them stable across redeploys.
  function ensureSecrets() {
    if (!config.authCookieSecret) {
      config = { ...config, authCookieSecret: randomBytes(32).toString("hex") };
    }
    if (!config.syncSecret) {
      config = { ...config, syncSecret: randomBytes(32).toString("hex") };
    }
    if (!config.installationId) {
      config = { ...config, installationId: randomBytes(16).toString("hex") };
    }
  }

  async function init({ persist = true } = {}) {
    if (!(await pathExists(configPath))) {
      ensureSecrets();
      if (persist) {
        await persistConfig(config);
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch (error) {
      throw appError(
        `Pagecast config is corrupt at ${configPath}; restore or remove it before continuing (${error.message}).`,
        500
      );
    }
    const persisted = JSON.stringify(parsed);
    config = normalizeConfig(parsed);
    ensureSecrets();
    // Read-only callers can load defaults/migrations without becoming a second
    // writer. Normal initialization persists only when canonicalization, a
    // migration, or secret generation actually changed the stored document.
    if (persist && JSON.stringify(config) !== persisted) {
      await persistConfig(config);
    }
  }

  function get() {
    return structuredClone(config);
  }

  // Client-safe view of the config. Secrets must never reach the browser
  // (it's served by /api/status and /api/config), or auth/sync tokens leak.
  function getPublicConfig() {
    // This is an allowlist rather than a denylist: adding a new private config
    // field cannot accidentally expose it through HTTP, CLI JSON, or MCP.
    return structuredClone({
      pages: config.pages,
      feedback: config.feedback
        ? {
            url: config.feedback.url,
            workerName: config.feedback.workerName,
            analyticsEnabled: config.feedback.analyticsEnabled !== false,
            reactionsEnabled: config.feedback.reactionsEnabled === true
          }
        : null,
      badge: config.badge,
      defaultExpiry: config.defaultExpiry,
      cloudflareSyncEnabled: config.cloudflareSyncEnabled,
      telemetryConsent: config.telemetry,
      local: config.local
    });
  }

  async function updatePages({
    projectName,
    accountId,
    accountName,
    baseUrl,
    adoptExisting = false
  } = {}) {
    return enqueueConfigMutation((current) => {
      const nextProjectName = projectName === undefined ? current.pages.projectName : projectName;
      const nextAccountId = accountId === undefined ? current.pages.accountId : accountId;
      const nextAccountName =
        accountName === undefined && nextAccountId === current.pages.accountId
          ? current.pages.accountName
          : accountName;
      const sameTarget =
        nextProjectName === current.pages.projectName && nextAccountId === current.pages.accountId;
      const nextBaseUrl = baseUrl === undefined && sameTarget ? current.pages.baseUrl : baseUrl;
      const nextConfig = normalizeConfig({
        ...current,
        pages: {
          projectName: nextProjectName,
          accountId: nextAccountId,
          accountName: nextAccountName,
          baseUrl: nextBaseUrl
        }
      });
      return adoptExisting && nextConfig.pages.accountId
        ? normalizeConfig({
            ...nextConfig,
            managedTargets: [...nextConfig.managedTargets, nextConfig.pages]
          })
        : nextConfig;
    });
  }

  function getOwnerId() {
    return config.installationId || "";
  }

  function isTargetManaged(projectRef) {
    return config.managedTargets.some((target) => projectRefEquals(target, projectRef));
  }

  async function claimManagedTarget(projectRef) {
    const normalized = normalizeProjectRef(projectRef);
    if (isTargetManaged(normalized)) return normalized;
    await enqueueConfigMutation((current) =>
      current.managedTargets.some((target) => projectRefEquals(target, normalized))
        ? current
        : normalizeConfig({
            ...current,
            managedTargets: [...current.managedTargets, normalized]
          })
    );
    return normalized;
  }

  async function setBadge(enabled) {
    return enqueueConfigMutation((current) =>
      normalizeConfig({ ...current, badge: enabled !== false })
    );
  }

  async function setDefaultExpiry(value) {
    return enqueueConfigMutation((current) => normalizeConfig({ ...current, defaultExpiry: value }));
  }

  async function setCloudflareSyncEnabled(enabled) {
    return enqueueConfigMutation((current) =>
      normalizeConfig({ ...current, cloudflareSyncEnabled: enabled !== false })
    );
  }

  async function setLocalRuntime(local) {
    return enqueueConfigMutation((current) =>
      normalizeConfig({ ...current, local: { ...current.local, ...local } })
    );
  }

  async function setGoal(goal) {
    return enqueueConfigMutation((current) => normalizeConfig({ ...current, goal }));
  }

  async function setTelemetry(enabled, { notified = false } = {}) {
    return enqueueConfigMutation((current) =>
      normalizeConfig({
        ...current,
        telemetry: enabled !== false,
        telemetryNotified: notified ? true : current.telemetryNotified
      })
    );
  }

  // Generate the opaque anonymous install id once, on demand. Random and PII-free;
  // only created when telemetry is enabled and about to send its first event.
  async function ensureTelemetryId() {
    if (config.telemetryId) return config.telemetryId;
    const generated = randomBytes(16).toString("hex");
    const next = await enqueueConfigMutation((current) =>
      current.telemetryId ? current : { ...current, telemetryId: generated }
    );
    return next.telemetryId;
  }

  async function markTelemetryNotified() {
    if (config.telemetryNotified) return get();
    return enqueueConfigMutation((current) =>
      current.telemetryNotified ? current : { ...current, telemetryNotified: true }
    );
  }

  async function updateFeedback(feedback) {
    await enqueueConfigMutation((current) =>
      normalizeConfig({
        ...current,
        feedback: feedback === null ? null : { ...(current.feedback || {}), ...feedback }
      })
    );
    return getPublicConfig();
  }

  return {
    init,
    setBadge,
    setGoal,
    setDefaultExpiry,
    setCloudflareSyncEnabled,
    setLocalRuntime,
    setTelemetry,
    ensureTelemetryId,
    markTelemetryNotified,
    get,
    getPublicConfig,
    updatePages,
    updateFeedback,
    getOwnerId,
    isTargetManaged,
    claimManagedTarget,
    configPath
  };
}

// Serializes wrangler deploys so only one runs at a time. Each task is appended
// to a single promise chain; a failing task rejects to its own caller but does
// NOT wedge the chain (the internal chain always recovers to a resolved state so
// later tasks still run).
export function createDeployQueue() {
  let chain = Promise.resolve();

  function enqueue(taskFn) {
    const result = chain.then(() => taskFn());
    // Keep the internal chain alive regardless of this task's outcome.
    chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function drain() {
    return chain;
  }

  return { enqueue, drain };
}

// Insert the feedback widget into a published HTML document. The widget (served
// by the user's feedback Worker) beacons a view and renders the reactions bar.
// Injected just before </body> so it loads after page content. `url` is the
// Worker origin and `slug` keys this page's stats. Returns the HTML unchanged
// when feedback is not configured. Pure + exported for testing.
export function injectFeedbackWidget(
  html,
  { url, slug, publicationId, reactionsEnabled = false } = {}
) {
  const baseUrl = String(url || "").trim().replace(/\/+$/, "");
  const pageSlug = String(slug || "").trim();
  const immutablePublicationId = String(publicationId || pageSlug).trim();
  if (!baseUrl || !pageSlug || !immutablePublicationId) {
    return html;
  }
  const esc = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const tag =
    `<script src="${esc(`${baseUrl}/widget.js`)}" data-slug="${esc(pageSlug)}" data-publication="${esc(immutablePublicationId)}" data-reactions="${reactionsEnabled === true ? "true" : "false"}" defer></script>`;
  // Avoid double-injecting if the document already carries the widget.
  if (html.includes(`data-slug="${esc(pageSlug)}"`) && html.includes("/widget.js")) {
    return html;
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${tag}\n</body>`);
  }
  return `${html}\n${tag}\n`;
}

// Inject a subtle "Published with Pagecast" badge into a shared page. This is the
// word-of-mouth loop — a recipient of the link sees it and can publish their own.
// Idempotent; pure + exported for testing. Toggled off for white-label.
export function injectBadge(html) {
  if (/data-pagecast-badge/i.test(html)) {
    return html;
  }
  const tag =
    '<a data-pagecast-badge href="https://pagecasthq.pages.dev/?ref=badge" target="_blank" rel="noopener"' +
    ' style="position:fixed;left:14px;bottom:14px;z-index:2147483646;display:inline-flex;align-items:center;' +
    "padding:6px 11px;font:500 12px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#52525b;" +
    "text-decoration:none;background:#fff;border:1px solid #e4e4e7;border-radius:999px;" +
    'box-shadow:0 2px 10px rgba(0,0,0,.06)">Published with&nbsp;' +
    '<strong style="font-weight:600;color:#c9530a">Pagecast</strong></a>';
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${tag}\n</body>`);
  }
  return `${html}\n${tag}\n`;
}

// Fallback Open Graph card image — a Pagecast-branded card already hosted on
// the landing site. Publishes normally render a per-page card locally (see
// og-card.js) and deploy it with the snapshot; this static card covers pages
// with no usable title and render failures.
export const DEFAULT_OG_IMAGE = "https://pagecasthq.pages.dev/og-image.png";

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Decode the handful of entities a source document might already carry, so we
// don't double-escape when re-emitting the text into a meta attribute.
function decodeBasicEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
}

// Pull a human title from a document: prefer a meaningful <title>, else fall
// back to the report's display name.
export function extractTitle(html, fallback = "") {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  const title = match ? decodeBasicEntities(match[1].replace(/\s+/g, " ").trim()) : "";
  const generic = /^(index|untitled|document|report)$/i;
  if (title && !generic.test(title)) {
    return title;
  }
  return String(fallback || title || "").trim();
}

// Pull a short description: prefer an existing meta description, else the first
// paragraph's text, truncated. Returns "" when nothing usable is found.
export function extractDescription(html) {
  const doc = String(html || "");
  const meta = /<meta[^>]+name=["']description["'][^>]*>/i.exec(doc);
  if (meta) {
    // Backreference the opening quote (\1) so a value containing the other
    // quote char — e.g. an apostrophe in "We're …" — isn't truncated early.
    const content = /content=(["'])([\s\S]*?)\1/i.exec(meta[0]);
    if (content && content[2].trim()) {
      return decodeBasicEntities(content[2].replace(/\s+/g, " ").trim()).slice(0, 200);
    }
  }
  const para = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(doc);
  if (para) {
    const text = decodeBasicEntities(para[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (text) {
      return text.slice(0, 200);
    }
  }
  return "";
}

// True when a document already declares its own Open Graph metadata: a <meta>
// tag with a whitespace-delimited og:-prefixed property/name — quoted,
// unquoted, or spaced around "=". Scoped to <meta> so RDFa (<div
// property="og:…">) or data-* attributes elsewhere don't suppress injection.
// Shared by injectSocialMeta and the publish pipeline so the "don't clobber
// custom OG" decision can never drift between the two.
export function hasCustomOgMeta(html) {
  // (?=\s) pins the tag name: <meta-card …> is a custom element, not <meta>.
  return /<meta(?=\s)[^>]*\s(?:property|name)\s*=\s*["']?og:/i.test(String(html || ""));
}

// Inject Open Graph + Twitter card meta so shared links unfurl richly instead of
// as bare URLs. Idempotent and non-clobbering: if the document already declares
// its own og: meta, it's returned unchanged. `image`/`siteName` are only emitted
// when provided (the caller gates Pagecast branding on the badge/white-label
// setting). Pure + exported for testing.
export function injectSocialMeta(
  html,
  { title, description, url, image, imageWidth, imageHeight, siteName } = {}
) {
  const doc = String(html || "");
  if (hasCustomOgMeta(doc)) {
    return doc;
  }
  if (!title && !description && !url) {
    return doc;
  }
  const tags = [];
  const meta = (prop, content, attr = "property") => {
    if (content) {
      tags.push(`<meta ${attr}="${prop}" content="${escapeAttr(content)}">`);
    }
  };
  meta("og:type", "article");
  meta("og:title", title);
  meta("og:description", description);
  meta("og:url", url);
  meta("og:image", image);
  if (image) {
    meta("og:image:width", imageWidth);
    meta("og:image:height", imageHeight);
  }
  meta("og:site_name", siteName);
  meta("twitter:card", "summary_large_image", "name");
  meta("twitter:title", title, "name");
  meta("twitter:description", description, "name");
  meta("twitter:image", image, "name");
  const block = tags.join("\n");
  if (/<\/head>/i.test(doc)) {
    return doc.replace(/<\/head>/i, `${block}\n</head>`);
  }
  if (/<body[^>]*>/i.test(doc)) {
    return doc.replace(/<body[^>]*>/i, (bodyTag) => `${block}\n${bodyTag}`);
  }
  return `${block}\n${doc}`;
}

export function createCloudflarePagesPublisher(options = {}) {
  return createPublicationService(options, {
    DEFAULT_OG_IMAGE,
    DEFAULT_PAGES_BRANCH,
    DEFAULT_PAGES_PROJECT_NAME,
    OG_CARD_FILENAME,
    OG_CARD_HEIGHT,
    OG_CARD_WIDTH,
    PAGECAST_PROJECT_MARKER_FILE,
    PAGECAST_SYNC_MANIFEST_PATH,
    PROJECT_ROOT,
    appError,
    assertSafePagesDeployRoot,
    atomicWriteJson,
    cleanCommandOutput,
    copyPublicTree,
    createWranglerInvocation,
    encodeProjectOwnershipMarker,
    extractDescription,
    extractTitle,
    fetchWithTimeout,
    findFolderEntry,
    fs,
    hasCustomOgMeta,
    inferLegacyRedirectProjectRef,
    injectBadge,
    injectFeedbackWidget,
    injectSocialMeta,
    isMarkdownFileName,
    isPathInside,
    isValidPasswordHash,
    joinUrl,
    listPublicTreeFiles,
    markdownToHtml,
    normalizeAccountId,
    normalizeCustomSlug,
    normalizeLocalFolderPath,
    normalizePagesBranch,
    normalizePagesProjectName,
    normalizePagesProjectNameSafe,
    normalizeProjectRef,
    normalizePublicationToken,
    normalizeStoredProjectRef,
    normalizeSyncRecord,
    nowIso,
    pagesBaseUrl,
    pagesBaseUrlFromDeployOutput,
    pagesDeploymentUrlFromDeployOutput,
    path,
    pathExists,
    projectRefEquals,
    projectRefFilesystemKey,
    projectRootImportSlug,
    publicBaseUrl,
    publicationTokenFilesystemKey,
    randomBytes,
    renderAuthMiddleware,
    renderOgCard,
    renderRoutesJson,
    runSpawnCommand,
    spawn,
    stripTrailingSlash,
    validateOwnershipMarker
  });
}
// Watches the source directories of auto-sync path reports and re-publishes
// (same URL, in place) each active snapshot when the entry file changes. All
// deploys go through the shared deploy queue so they never overlap. Failures are
// swallowed (last-good content stays live) and the queue is never wedged.
export function createWatchManager({
  store,
  pagesPublisher,
  configStore,
  deployQueue,
  mutationQueue = null,
  debounceMs = 1000,
  onError = () => {}
} = {}) {
  const watchers = new Map();
  const timers = new Map();

  function clearTimer(reportId) {
    const timer = timers.get(reportId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(reportId);
    }
  }

  async function syncReportSnapshots(reportId) {
    const report = store.get(reportId);
    if (!report) {
      return;
    }
    const targets = reportDeploymentTargets(store, report, configStore.get().pages);
    if (targets.length === 0) {
      return;
    }
    const entries = targets.map(({ publication, pagesConfig }) => ({
      type: "auto_sync",
      token: publication.token,
      slug: publication.slug || publication.token,
      projectRef: pagesConfig,
      reportId
    }));
    await store.beginOperations(entries);
    for (const target of targets) {
      try {
        await deployReportTargetState({
          store,
          configStore,
          pagesPublisher,
          deployQueue: null,
          report: store.get(reportId),
          ...target
        });
        await store.clearOperation("auto_sync", target.publication.token);
      } catch (error) {
        await store
          .recordOperationFailure({
            type: "auto_sync",
            token: target.publication.token,
            slug: target.publication.slug || target.publication.token,
            projectRef: target.pagesConfig,
            error
          })
          .catch(() => {});
        onError(error);
      }
    }
  }

  function schedule(reportId) {
    clearTimer(reportId);
    const timer = setTimeout(() => {
      timers.delete(reportId);
      // Run the actual deploy work inside the shared queue so concurrent
      // watchers never deploy at the same time. Recover so the chain survives.
      const sync = () => deployQueue.enqueue(() => syncReportSnapshots(reportId));
      (mutationQueue ? mutationQueue.enqueue(sync) : sync()).catch((error) => onError(error));
    }, debounceMs);
    timer.unref?.();
    timers.set(reportId, timer);
  }

  function register(reportId) {
    const report = store.get(reportId);
    if (!report || report.kind !== "path" || !report.autoSync || report.workingDir) {
      return;
    }
    if (watchers.has(reportId)) {
      return;
    }

    try {
      const watcher = fsWatch(
        report.rootDir,
        { persistent: false },
        (eventType, filename) => {
          // macOS often reports a null filename; treat that as "something
          // changed" and let the per-report debounce coalesce the burst.
          if (filename === null || filename === report.entryFile) {
            schedule(reportId);
          }
        }
      );
      watcher.on("error", (error) => {
        // A deleted-then-recreated source dir surfaces here; never crash.
        onError(error);
      });
      watchers.set(reportId, watcher);
    } catch (error) {
      onError(error);
    }
  }

  function unregister(reportId) {
    clearTimer(reportId);
    const watcher = watchers.get(reportId);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      watchers.delete(reportId);
    }
  }

  function closeAll() {
    for (const reportId of Array.from(watchers.keys())) {
      unregister(reportId);
    }
    for (const reportId of Array.from(timers.keys())) {
      clearTimer(reportId);
    }
  }

  function isRegistered(reportId) {
    return watchers.has(reportId);
  }

  return { register, unregister, closeAll, isRegistered };
}


export function createReportStore({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  buildSpawnImpl = spawn,
  buildTimeoutMs = 5 * 60 * 1000,
  recoverFetchImpl = fetch,
  removePathImpl = (targetPath) => fs.rm(targetPath, { recursive: true, force: true }),
  atomicWriteJsonImpl = atomicWriteJson
} = {}) {
  const statePath = path.join(dataDir, "reports.json");
  const uploadRoot = path.join(dataDir, "uploads");
  const importRoot = path.join(dataDir, "imports");
  const workingRoot = path.join(dataDir, "working");
  const reports = new Map();
  let redirects = [];
  let operations = [];
  let pendingDeletions = [];
  let saveChain = Promise.resolve();
  let storeMutationChain = Promise.resolve();
  let committedState = null;

  function storedProjectRef(value) {
    try {
      return normalizeStoredProjectRef(value, { allowLegacy: true });
    } catch {
      return null;
    }
  }

  function normalizePublication(publication) {
    const kind = publication.kind || "snapshot";
    // Legacy (version-2) publications had no slug; the token doubled as the
    // staged-folder/URL-path key, so backfill slug from token.
    const slug = publication.slug || publication.token;
    const projectRef = storedProjectRef(publication);
    return {
      ...publication,
      kind,
      slug,
      // Whether this link was published as a public "drop" (short, guessable
      // slug). Legacy publications default to the unlisted classification.
      drop: publication.drop === true,
      targetAttributed: Boolean(projectRef),
      publicUrl: kind === "snapshot" ? publication.publicUrl || null : null,
      pagesProjectName: normalizePagesProjectNameSafe(publication.pagesProjectName),
      pagesAccountId: normalizeAccountIdSafe(publication.pagesAccountId),
      pagesAccountName: normalizeAccountName(publication.pagesAccountName || ""),
      pagesBaseUrl: publication.pagesBaseUrl ? stripTrailingSlash(publication.pagesBaseUrl) : "",
      projectRef,
      revokedAt: publication.revokedAt || null,
      pending: publication.pending === true,
      updatedAt: publication.updatedAt || publication.createdAt
    };
  }

  function normalizeReport(report) {
    const kind = report.kind;
    const defaultSourceMode = kind === "upload" ? "edited-in-pagecast" : "source-tracked";
    // Migrate legacy names: reports were named by their bare filename, so many
    // path reports all read "index.html". Re-derive from the parent folder.
    let name = report.name;
    if (typeof report.sourcePath === "string" && isIndexFileName(String(name || ""))) {
      name = deriveReportName(report.sourcePath);
    }
    return {
      ...report,
      name,
      order: typeof report.order === "number" ? report.order : Number.MAX_SAFE_INTEGER,
      autoSync: report.autoSync === true,
      workingDir: typeof report.workingDir === "string" ? report.workingDir : null,
      buildCommand: typeof report.buildCommand === "string" ? report.buildCommand : "",
      buildOutputDir: typeof report.buildOutputDir === "string" ? report.buildOutputDir : "",
      buildOutputRoot: typeof report.buildOutputRoot === "string" ? report.buildOutputRoot : null,
      buildStatus: report.buildStatus || "idle",
      buildError: report.buildError || "",
      lastBuildAt: report.lastBuildAt || null,
      sourceMode: report.sourceMode || defaultSourceMode,
      // Edge password protection. The salted hash is the actual lock (baked into
      // the deployed Pages Function); it is persisted in state.json but NEVER
      // returned by the API (see formatReport). Corrupt/legacy shapes degrade to
      // unprotected rather than deploying a broken gate.
      passwordProtected: report.passwordProtected === true && isValidPasswordHash(report.passwordHash),
      passwordHash: isValidPasswordHash(report.passwordHash) ? report.passwordHash : null,
      importedFromCloudflare: report.importedFromCloudflare === true,
      publications: Array.isArray(report.publications)
        ? report.publications.map(normalizePublication)
        : []
    };
  }

  function reportSourceRoot(report) {
    return path.resolve(report.workingDir || report.buildOutputRoot || report.rootDir);
  }

  function reportSourceMissing(report) {
    if (!report || report.workingDir || report.kind === "upload") {
      return false;
    }
    if (report.kind === "folder" && report.buildCommand && !report.buildOutputRoot) {
      return false;
    }
    const rootDir = reportSourceRoot(report);
    const entryPath = path.resolve(rootDir, report.entryFile || "index.html");
    if (!isPathInside(rootDir, entryPath)) {
      return true;
    }
    return !existsSync(entryPath);
  }

  function captureState() {
    return structuredClone({
      version: 4,
      reports: Array.from(reports.values()),
      redirects,
      operations,
      pendingDeletions
    });
  }

  function installState(state) {
    reports.clear();
    for (const report of state?.reports || []) {
      reports.set(report.id, report);
    }
    redirects = state?.redirects || [];
    operations = state?.operations || [];
    pendingDeletions = state?.pendingDeletions || [];
  }

  function save() {
    const snapshot = captureState();
    const write = saveChain.then(() => atomicWriteJsonImpl(statePath, snapshot));
    const committed = write.then(
      () => {
        committedState = structuredClone(snapshot);
      },
      (error) => {
        if (committedState) {
          installState(structuredClone(committedState));
        }
        throw error;
      }
    );
    saveChain = committed.catch(() => {});
    return committed;
  }

  function serializeStoreMutation(operation) {
    return (...args) => {
      const run = storeMutationChain.then(() => operation(...args));
      storeMutationChain = run.catch(() => {});
      return run;
    };
  }

  function isOwnedCleanupPath(candidatePath) {
    const candidate = path.resolve(candidatePath);
    return [uploadRoot, importRoot, workingRoot].some((root) => {
      const normalizedRoot = path.resolve(root);
      return candidate !== normalizedRoot && isPathInside(normalizedRoot, candidate);
    });
  }

  function normalizePendingDeletion(entry) {
    if (!entry || typeof entry !== "object" || typeof entry.reportId !== "string") {
      return null;
    }
    const paths = Array.isArray(entry.paths)
      ? [...new Set(entry.paths.map((value) => path.resolve(String(value || ""))))].filter(
          isOwnedCleanupPath
        )
      : [];
    return {
      id:
        typeof entry.id === "string" && entry.id
          ? entry.id
          : `delete:${entry.reportId}`,
      reportId: entry.reportId,
      paths,
      createdAt: entry.createdAt || nowIso(),
      updatedAt: entry.updatedAt || entry.createdAt || nowIso(),
      attempts: Number.isInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0,
      error: typeof entry.error === "string" ? entry.error : ""
    };
  }

  async function cleanupPendingDeletion(entry) {
    try {
      for (const cleanupPath of entry.paths) {
        await removePathImpl(cleanupPath);
      }
      return null;
    } catch (error) {
      entry.updatedAt = nowIso();
      entry.attempts += 1;
      entry.error = String(error?.message || error || "Report source cleanup failed.");
      return error;
    }
  }

  async function init({ persist = true } = {}) {
    if (persist) {
      await fs.mkdir(uploadRoot, { recursive: true });
      await fs.mkdir(importRoot, { recursive: true });
      await fs.mkdir(workingRoot, { recursive: true });
    }
    if (!(await pathExists(statePath))) {
      committedState = captureState();
      if (persist) {
        await save();
      }
      return;
    }

    const rawState = await fs.readFile(statePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(rawState);
    } catch (error) {
      throw appError(
        `Pagecast report state is corrupt at ${statePath}; restore it before continuing (${error.message}).`,
        500
      );
    }
    redirects = Array.isArray(parsed.redirects)
      ? parsed.redirects
          .filter((entry) => entry && typeof entry.from === "string" && typeof entry.to === "string")
          .map((entry) => ({
            from: entry.from,
            to: entry.to,
            projectRef: storedProjectRef(entry)
          }))
      : [];
    operations = Array.isArray(parsed.operations)
      ? parsed.operations.filter(
          (entry) =>
            entry &&
            typeof entry.id === "string" &&
            typeof entry.type === "string" &&
            typeof entry.token === "string"
        )
      : [];
    pendingDeletions = Array.isArray(parsed.pendingDeletions)
      ? parsed.pendingDeletions.map(normalizePendingDeletion).filter(Boolean)
      : [];
    for (const report of parsed.reports || []) {
      if (typeof report?.id === "string" && typeof report?.kind === "string") {
        reports.set(report.id, normalizeReport(report));
      }
    }
    // This is the last state known to have come from disk. Any migration or
    // cleanup below is installed as committed only after its replacement write.
    committedState = captureState();

    const publications = Array.from(reports.values()).flatMap(
      (report) => report.publications || []
    );
    let redirectsAttributed = false;
    for (const redirect of redirects) {
      if (redirect.projectRef !== null) {
        continue;
      }
      const inferred = inferLegacyRedirectProjectRef(redirect, publications);
      if (inferred) {
        redirect.projectRef = inferred;
        redirectsAttributed = true;
      }
    }

    // Group legacy duplicates: before re-publishing reused a report, each publish
    // of the same file created a separate row. Merge same-source path reports
    // into one whose Published links hold every version. Idempotent.
    let stateChanged = mergeDuplicatePathReports() || redirectsAttributed;
    if (persist && pendingDeletions.length > 0) {
      stateChanged = true;
      const retained = [];
      for (const deletion of pendingDeletions) {
        if (await cleanupPendingDeletion(deletion)) {
          retained.push(deletion);
        } else {
          stateChanged = true;
        }
      }
      if (retained.length !== pendingDeletions.length) {
        pendingDeletions = retained;
      }
    }
    if (persist && stateChanged) {
      await save();
    } else {
      committedState = captureState();
    }
  }

  // Collapse path reports that share a sourcePath into the earliest one,
  // appending the duplicates' publications (the "versions"). Returns true if any
  // merge happened so the caller can persist.
  function mergeDuplicatePathReports() {
    const canonicalBySource = new Map();
    let merged = false;
    for (const report of Array.from(reports.values())) {
      if (report.kind !== "path" || typeof report.sourcePath !== "string") {
        continue;
      }
      const canonical = canonicalBySource.get(report.sourcePath);
      if (!canonical) {
        canonicalBySource.set(report.sourcePath, report);
        continue;
      }
      const seen = new Set(canonical.publications.map((p) => p.token));
      for (const publication of report.publications) {
        if (!seen.has(publication.token)) {
          canonical.publications.push(publication);
          seen.add(publication.token);
        }
      }
      canonical.updatedAt = nowIso();
      reports.delete(report.id);
      merged = true;
    }
    return merged;
  }

  function listRedirects(pagesConfig = null) {
    return redirects
      .filter(
        (entry) =>
          pagesConfig === null ||
          (entry.projectRef !== null && projectRefEquals(entry.projectRef, pagesConfig))
      )
      .map((entry) => ({ ...entry }));
  }

  // Add a 301 redirect, collapsing chains: if an existing entry pointed at the
  // slug we are now renaming away from, rewrite its target to the new
  // destination so we never need a multi-hop redirect. Dedupes on `from`.
  function addRedirect(from, to, projectRef = null) {
    if (!from || !to || from === to) {
      return;
    }
    const normalizedProjectRef = storedProjectRef({ projectRef });
    for (const entry of redirects) {
      if (
        entry.to === from &&
        ((entry.projectRef === null && normalizedProjectRef === null) ||
          projectRefEquals(entry.projectRef, normalizedProjectRef))
      ) {
        entry.to = to;
      }
    }
    const existing = redirects.find(
      (entry) =>
        entry.from === from &&
        ((entry.projectRef === null && normalizedProjectRef === null) ||
          projectRefEquals(entry.projectRef, normalizedProjectRef))
    );
    if (existing) {
      existing.to = to;
    } else {
      redirects.push({ from, to, projectRef: normalizedProjectRef });
    }
    // Drop any self-referential entries produced by collapsing.
    redirects = redirects.filter((entry) => entry.from !== entry.to);
  }

  function formatPublication(
    publication,
    { localPublicBaseUrl, passwordProtected = false } = {}
  ) {
    const slug = publication.slug || publication.token;
    const suffix = `/p/${encodeURIComponent(slug)}/`;
    const expiresAt = typeof publication.expiresAt === "number" && publication.expiresAt > 0 ? publication.expiresAt : null;
    const expired = expiresAt !== null && Date.now() > expiresAt;
    // Expired links read as inactive (the edge serves a 410), like revoked ones.
    const active = !publication.revokedAt && !expired && publication.pending !== true;
    const kind = publication.kind || "snapshot";
    return {
      token: publication.token,
      slug,
      label: publication.label,
      kind,
      // Retain the historical boolean while exposing the complete product state:
      // protected, public drop, capability-bearing unlisted, or legacy word-only.
      drop: publication.drop === true,
      linkKind: classifyLinkKind({
        slug,
        drop: publication.drop === true,
        passwordProtected
      }),
      targetAttributed:
        publication.targetAttributed === true || Boolean(storedProjectRef(publication)),
      active,
      createdAt: publication.createdAt,
      updatedAt: publication.updatedAt || publication.createdAt,
      revokedAt: publication.revokedAt || null,
      pending: publication.pending === true,
      expiresAt,
      expired,
      localUrl: active && localPublicBaseUrl ? joinUrl(localPublicBaseUrl, suffix) : null,
      publicUrl: active && kind === "snapshot" ? publication.publicUrl : null
    };
  }

  function formatReport(report, { adminBaseUrl, localPublicBaseUrl } = {}) {
    const previewSuffix = `/preview/${encodeURIComponent(report.id)}/`;
    const publications = (report.publications || [])
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((publication) =>
        formatPublication(publication, {
          localPublicBaseUrl,
          passwordProtected: report.passwordProtected === true
        })
      );
    const latestActivePublication = publications.find((publication) => publication.active) || null;
    return {
      id: report.id,
      name: report.name,
      kind: report.kind,
      sourcePath: report.kind === "path" || report.kind === "folder" ? report.sourcePath : null,
      order: typeof report.order === "number" ? report.order : Number.MAX_SAFE_INTEGER,
      autoSync: report.autoSync === true,
      sourceMode: report.sourceMode || (report.kind === "upload" ? "edited-in-pagecast" : "source-tracked"),
      buildCommand: report.buildCommand || "",
      buildOutputDir: report.buildOutputDir || "",
      buildStatus: report.buildStatus || "idle",
      buildError: report.buildError || "",
      lastBuildAt: report.lastBuildAt || null,
      // Only the boolean is exposed; report.passwordHash (salt + hash) is a
      // server-side secret and is intentionally never serialized to the API.
      passwordProtected: report.passwordProtected === true,
      importedFromCloudflare: report.importedFromCloudflare === true,
      sourceMissing: reportSourceMissing(report),
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      // Report-controlled HTML must never share the admin origin. The public
      // preview server is a separate origin (normally port 4174) and exposes no
      // mutation API.
      localUrl: localPublicBaseUrl ? joinUrl(localPublicBaseUrl, previewSuffix) : null,
      publicUrl: latestActivePublication?.publicUrl || null,
      publications
    };
  }

  function list(options = {}) {
    return Array.from(reports.values())
      .sort((a, b) => {
        const orderA = typeof a.order === "number" ? a.order : Number.MAX_SAFE_INTEGER;
        const orderB = typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map((report) => formatReport(report, options));
  }

  async function addPath(sourcePath) {
    const normalizedPath = await normalizeLocalHtmlPath(sourcePath);

    // Reuse an existing path report for the same source file instead of adding a
    // duplicate row each time it's published. Re-publishing then adds another
    // snapshot/link to the same report rather than cloning it.
    for (const existing of reports.values()) {
      if (existing.kind === "path" && existing.sourcePath === normalizedPath) {
        return existing;
      }
    }

    const createdAt = nowIso();
    const report = {
      id: createReportId(normalizedPath),
      kind: "path",
      name: deriveReportName(normalizedPath),
      sourcePath: normalizedPath,
      rootDir: path.dirname(normalizedPath),
      entryFile: path.basename(normalizedPath),
      order: reports.size,
      autoSync: false,
      workingDir: null,
      sourceMode: "source-tracked",
      createdAt,
      updatedAt: createdAt,
      publications: []
    };

    reports.set(report.id, report);
    await save();
    return report;
  }

  async function replaceSourceWithPath(id, sourcePath) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }
    const normalizedPath = await normalizeLocalHtmlPath(sourcePath);
    report.kind = "path";
    report.name = deriveReportName(normalizedPath);
    report.sourcePath = normalizedPath;
    report.rootDir = path.dirname(normalizedPath);
    report.entryFile = path.basename(normalizedPath);
    report.workingDir = null;
    report.buildCommand = "";
    report.buildOutputDir = "";
    report.buildOutputRoot = null;
    report.buildStatus = "ready";
    report.buildError = "";
    report.sourceMode = "source-tracked";
    report.updatedAt = nowIso();
    await save();
    return report;
  }

  function findPublishMatch(options = {}) {
    return findPublicationForPublish(Array.from(reports.values()), options);
  }

  async function addFolder({
    folderPath,
    entryFile = "",
    buildCommand = "",
    buildOutputDir = "",
    name = ""
  } = {}) {
    const normalizedPath = await normalizeLocalFolderPath(folderPath);
    const normalizedBuildOutput = buildOutputDir
      ? normalizeAssetRequestPath(buildOutputDir)
      : "";
    if (buildOutputDir && !normalizedBuildOutput) {
      throw appError("Build output directory is not allowed.", 400);
    }
    const normalizedEntry = buildCommand
      ? ""
      : await findFolderEntry(normalizedPath, entryFile);
    const createdAt = nowIso();
    const report = {
      id: createReportId(name || normalizedPath),
      kind: "folder",
      name: name || path.basename(normalizedPath),
      sourcePath: normalizedPath,
      rootDir: normalizedPath,
      entryFile: normalizedEntry || "index.html",
      order: reports.size,
      autoSync: false,
      workingDir: null,
      sourceMode: "source-tracked",
      buildCommand: String(buildCommand || "").trim(),
      buildOutputDir: normalizedBuildOutput || "",
      buildOutputRoot: null,
      buildStatus: buildCommand ? "idle" : "ready",
      buildError: "",
      lastBuildAt: null,
      createdAt,
      updatedAt: createdAt,
      publications: []
    };

    reports.set(report.id, report);
    await save();
    return report;
  }

  async function addUpload({ filename, content }) {
    const safeName = path.basename(filename || "report.html");
    if (!isPublishableFileName(safeName)) {
      throw appError("Uploaded file must be .html, .htm, .md, or .markdown.", 400);
    }

    if (safeName.startsWith(".")) {
      throw appError("Hidden files are not served.", 400);
    }

    const createdAt = nowIso();
    const id = createReportId(safeName);
    const reportDir = path.join(uploadRoot, id);
    // Markdown uploads keep their raw .md source so the entry extension drives
    // rendering at preview/publish time; HTML uploads are stored as index.html.
    const entryFile = isMarkdownFileName(safeName) ? "index.md" : "index.html";

    try {
      await fs.mkdir(reportDir, { recursive: true });
      await fs.writeFile(path.join(reportDir, entryFile), content);

      const report = {
        id,
        kind: "upload",
        name: safeName,
        rootDir: reportDir,
        entryFile,
        order: reports.size,
        autoSync: false,
        workingDir: null,
        sourceMode: "edited-in-pagecast",
        createdAt,
        updatedAt: createdAt,
        publications: []
      };

      reports.set(report.id, report);
      await save();
      return reports.get(report.id);
    } catch (error) {
      await fs.rm(reportDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function addFolderUpload({ files, name = "" }) {
    if (!Array.isArray(files) || files.length === 0) {
      throw appError("Folder upload did not include any files.", 400);
    }
    if (files.length > MAX_FOLDER_UPLOAD_FILES) {
      throw appError(`Folder upload can include at most ${MAX_FOLDER_UPLOAD_FILES} files.`, 413);
    }

    const normalizedFiles = [];
    let totalBytes = 0;
    for (const file of files) {
      const relativePath = normalizeAssetRequestPath(file.filename || "");
      if (!relativePath) {
        throw appError("Folder upload includes an unsafe file path.", 400);
      }
      if (file.content.length > MAX_FOLDER_UPLOAD_FILE_BYTES) {
        throw appError("Folder upload includes a file that is too large.", 413);
      }
      totalBytes += file.content.length;
      if (totalBytes > MAX_FOLDER_UPLOAD_BYTES) {
        throw appError("Folder upload is too large.", 413);
      }
      normalizedFiles.push({ relativePath, content: file.content });
    }

    const createdAt = nowIso();
    const id = createReportId(name || files[0].filename || "folder");
    const reportDir = path.join(uploadRoot, id);
    try {
      await fs.mkdir(reportDir, { recursive: true });
      for (const file of normalizedFiles) {
        const destinationPath = path.resolve(reportDir, file.relativePath);
        if (!isPathInside(reportDir, destinationPath)) {
          throw appError("Folder upload includes an unsafe file path.", 400);
        }
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.writeFile(destinationPath, file.content);
      }

      let publishRoot = reportDir;
      let entryFile;
      try {
        entryFile = await findFolderEntry(publishRoot);
      } catch (error) {
        const roots = new Set(
          normalizedFiles.map((file) => file.relativePath.split(path.sep)[0])
        );
        if (roots.size !== 1) {
          throw error;
        }
        publishRoot = path.join(reportDir, Array.from(roots)[0]);
        entryFile = await findFolderEntry(publishRoot);
      }
      const report = {
        id,
        kind: "folder",
        name: name || path.basename(id),
        sourcePath: null,
        rootDir: publishRoot,
        entryFile,
        order: reports.size,
        autoSync: false,
        workingDir: null,
        sourceMode: "edited-in-pagecast",
        buildCommand: "",
        buildOutputDir: "",
        buildOutputRoot: null,
        buildStatus: "ready",
        buildError: "",
        lastBuildAt: null,
        createdAt,
        updatedAt: createdAt,
        publications: []
      };

      reports.set(report.id, report);
      await save();
      return reports.get(report.id);
    } catch (error) {
      await fs.rm(reportDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function buildReport(id) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }
    if (report.kind !== "folder") {
      throw appError("Only folder reports can be built.", 400);
    }
    if (!report.buildCommand) {
      const entryFile = await findFolderEntry(path.resolve(report.rootDir), report.entryFile);
      report.entryFile = entryFile;
      report.buildOutputRoot = null;
      report.buildStatus = "ready";
      report.buildError = "";
      report.lastBuildAt = nowIso();
      report.updatedAt = report.lastBuildAt;
      await save();
      return report;
    }

    report.buildStatus = "building";
    report.buildError = "";
    report.updatedAt = nowIso();
    await save();

    const shell = selectBuildShell(report.buildCommand);
    const result = await runSpawnCommand({
      spawnImpl: buildSpawnImpl,
      command: shell.command,
      args: shell.args,
      cwd: report.rootDir,
      timeoutMs: buildTimeoutMs
    });

    if (result.code !== 0) {
      report.buildStatus = "failed";
      report.buildError = cleanCommandOutput(result.output) || `Build failed (${result.signal || result.code}).`;
      report.lastBuildAt = nowIso();
      report.updatedAt = report.lastBuildAt;
      await save();
      throw appError(`Build failed.\n${report.buildError}`, 502);
    }

    const output = await detectBuildOutputDir(report.rootDir, report.buildOutputDir);
    report.buildOutputDir = output.outputDir;
    report.buildOutputRoot = output.outputRoot;
    report.entryFile = output.entryFile;
    report.buildStatus = "ready";
    report.buildError = "";
    report.lastBuildAt = nowIso();
    report.updatedAt = report.lastBuildAt;
    await save();
    return report;
  }

  async function remove(id) {
    const report = reports.get(id);
    if (!report) {
      return false;
    }

    const cleanupPaths = [];
    if (
      report.kind === "upload" ||
      (report.kind === "folder" &&
        (isPathInside(uploadRoot, report.rootDir) || isPathInside(importRoot, report.rootDir)))
    ) {
      cleanupPaths.push(path.resolve(report.rootDir));
    }
    if (report.workingDir && isPathInside(workingRoot, report.workingDir)) {
      cleanupPaths.push(path.resolve(report.workingDir));
    }
    const deletion =
      cleanupPaths.length > 0
        ? normalizePendingDeletion({
            id: `delete:${id}:${randomBytes(8).toString("hex")}`,
            reportId: id,
            paths: cleanupPaths,
            createdAt: nowIso()
          })
        : null;
    const previousPendingDeletions = pendingDeletions;
    reports.delete(id);
    if (deletion) {
      pendingDeletions = [...pendingDeletions, deletion];
    }
    try {
      // Removing the report and recording every owned source path is one atomic
      // state transition. Cleanup happens only after this journal is durable.
      await save();
    } catch (error) {
      reports.set(id, report);
      pendingDeletions = previousPendingDeletions;
      throw error;
    }

    if (!deletion) {
      return true;
    }

    const cleanupError = await cleanupPendingDeletion(deletion);
    if (cleanupError) {
      // The report is durably deleted and its remaining source is still durably
      // owned by the pending-deletion journal. Persist the diagnostic when
      // possible; the original journal entry is already safe if this write fails.
      await save().catch(() => {});
      return true;
    }

    const withDeletion = pendingDeletions;
    pendingDeletions = pendingDeletions.filter((entry) => entry.id !== deletion.id);
    try {
      await save();
    } catch (error) {
      // The on-disk journal remains a safe, idempotent cleanup instruction. Keep
      // the in-memory view aligned so a caller can surface cleanupPending.
      pendingDeletions = withDeletion;
      deletion.updatedAt = nowIso();
      deletion.error = `Source cleanup completed, but its journal could not be finalized: ${
        error?.message || error
      }`;
    }
    return true;
  }

  function nextPublicationLabel(report) {
    return `v${(report.publications || []).length + 1}`;
  }

  function draftPublication(id, { label, kind = "snapshot", publicUrl = null, expiresAt = null, drop = false } = {}) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }

    const isDrop = drop === true;
    const createdAt = nowIso();
    const cleanLabel = slugifyReportName(label || nextPublicationLabel(report));
    // Reserve every existing identity, slug, legacy name, and redirect source.
    // Drops use a short memorable name; unlisted links add a 128-bit capability
    // suffix, but still must never collide with an existing complete slug.
    const takenNames = new Set();
    for (const existing of reports.values()) {
      for (const publication of existing.publications || []) {
        // Reserve the token AND the slug (and their name prefixes). A renamed
        // publication keeps its original `token` as its identity even though the
        // `slug` changed, so reserving only the slug would let the old token be
        // reissued and break findPublication/revoke/sync.
        const tokenName = publication.token;
        const slugName = publication.slug || tokenName;
        for (const name of [tokenName, slugName, publicTokenNamePrefix(tokenName), publicTokenNamePrefix(slugName)]) {
          if (name) takenNames.add(name);
        }
      }
    }
    // Renamed slugs leave a /p/<old>/ redirect; reserve those too, since a new
    // slug equal to an old redirect source would silently steal that route.
    for (const entry of redirects) {
      const fromMatch = /^\/p\/([^/]+)\/?$/.exec(entry.from);
      if (fromMatch) {
        takenNames.add(decodeURIComponent(fromMatch[1]));
      }
    }
    const token = createPublicToken((name) => takenNames.has(name), { drop: isDrop });
    const publication = {
      token,
      slug: token,
      label: cleanLabel,
      kind,
      // Whether this is a public "drop" (short, guessable slug) rather than the
      // default unlisted capability link.
      drop: isDrop,
      publicUrl: kind === "snapshot" ? publicUrl : null,
      createdAt,
      updatedAt: createdAt,
      revokedAt: null,
      pending: true,
      // Absolute expiry (epoch ms) or null = never. Enforced at the edge.
      expiresAt: typeof expiresAt === "number" && expiresAt > 0 ? expiresAt : null
    };

    return { report, publication };
  }

  async function commitPublication(id, publication) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }

    report.publications = [...(report.publications || []), publication];
    report.updatedAt = publication.createdAt;
    await save();
    return { report, publication };
  }

  async function publish(id, { label, drop = false } = {}) {
    const { publication } = draftPublication(id, { label, kind: "snapshot", drop });
    return commitPublication(id, publication);
  }

  function get(id) {
    return reports.get(id) || null;
  }

  async function copyRemotePublicationFiles({ slug, files, destinationRoot, baseUrl, fetchImpl = fetch } = {}) {
    if (!baseUrl) {
      throw appError("Cloudflare Pages base URL is required to import this link.", 400);
    }
    const fileList = Array.isArray(files) && files.length > 0 ? files : ["index.html"];
    if (fileList.length > MAX_SYNC_IMPORT_FILES) {
      throw appError(`Synced page includes more than ${MAX_SYNC_IMPORT_FILES} files.`, 413);
    }

    await fs.rm(destinationRoot, { recursive: true, force: true });
    await fs.mkdir(destinationRoot, { recursive: true });
    let totalBytes = 0;
    for (const file of fileList) {
      const relativePath = normalizeAssetRequestPath(file);
      if (!relativePath) {
        throw appError("Synced page includes an unsafe file path.", 400);
      }
      const urlPath = relativePath
        .split(path.sep)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const assetUrl = joinUrl(baseUrl, `/p/${encodeURIComponent(slug)}/${urlPath}`);
      const response = await fetchWithTimeout(fetchImpl, assetUrl);
      if (!response.ok) {
        throw appError(`Could not import ${relativePath} from Cloudflare (${response.status}).`, 502);
      }
      const body = await readSyncImportResponse(response, totalBytes);
      totalBytes = body.totalBytes;
      const destinationPath = path.resolve(destinationRoot, relativePath);
      if (!isPathInside(destinationRoot, destinationPath)) {
        throw appError("Synced page includes an unsafe file path.", 400);
      }
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.writeFile(destinationPath, body.content);
    }
  }

  async function importPublishedPage(
    record,
    { pagesBaseUrl = "", pagesConfig = null, fetchImpl = fetch } = {}
  ) {
    const normalized = normalizeSyncRecord(record, {
      baseUrl: pagesBaseUrl,
      source: record?.source || "cloudflare"
    });
    if (!normalized) {
      throw appError("Synced page record is invalid.", 400);
    }
    if (findActivePublicationBySlug(normalized.slug)) {
      return { imported: false, slug: normalized.slug, reason: "already-present" };
    }

    const reportDir = path.join(importRoot, normalized.slug);
    if (record?.sourceRoot) {
      await copyPublicTree(record.sourceRoot, reportDir);
    } else if (
      normalized.publicUrl &&
      (record?.source === "cloudflare-public-root" ||
        record?.source === "cloudflare-public-url" ||
        normalized.files.length === 0)
    ) {
      await copyPublicUrlFiles({
        publicUrl: normalized.publicUrl,
        destinationRoot: reportDir,
        fetchImpl
      });
    } else {
      await copyRemotePublicationFiles({
        slug: normalized.slug,
        files: normalized.files,
        destinationRoot: reportDir,
        baseUrl: normalized.baseUrl || pagesBaseUrl,
        fetchImpl
      });
    }

    const entryFile = await findFolderEntry(reportDir);
    const createdAt = normalized.createdAt;
    const updatedAt = normalized.updatedAt || createdAt;
    let title = normalized.title || normalized.slug;
    try {
      const html = await fs.readFile(path.join(reportDir, entryFile), "utf8");
      title = extractTitle(html, title) || title;
    } catch {
      // Keep the manifest title if the entry is not readable as text.
    }

    const id = createReportId(`cloudflare-${normalized.slug}`);
    let token = normalized.token || normalized.slug;
    if (findPublication(token)) {
      token = `import-${normalized.slug}-${randomBytes(4).toString("hex")}`;
    }
    const publicUrl =
      normalized.publicUrl ||
      joinUrl(normalized.baseUrl || pagesBaseUrl, `/p/${encodeURIComponent(normalized.slug)}/`);
    let projectRef = null;
    try {
      projectRef = pagesConfig ? normalizeProjectRef(pagesConfig) : null;
    } catch {
      projectRef = null;
    }
    const publication = {
      token,
      slug: normalized.slug,
      label: normalized.label || "imported",
      kind: "snapshot",
      drop: false,
      publicUrl,
      pagesProjectName: projectRef?.projectName || "",
      pagesAccountId: projectRef?.accountId || "",
      pagesAccountName: "",
      pagesBaseUrl: projectRef?.baseUrl || publicUrlOrigin(publicUrl),
      projectRef,
      createdAt,
      updatedAt,
      revokedAt: null,
      expiresAt: null
    };
    const report = {
      id,
      kind: "folder",
      name: title,
      sourcePath: null,
      rootDir: reportDir,
      entryFile,
      order: reports.size,
      autoSync: false,
      workingDir: null,
      sourceMode: "edited-in-pagecast",
      importedFromCloudflare: true,
      buildCommand: "",
      buildOutputDir: "",
      buildOutputRoot: null,
      buildStatus: "ready",
      buildError: "",
      lastBuildAt: null,
      passwordProtected: false,
      passwordHash: null,
      createdAt,
      updatedAt,
      publications: [publication]
    };

    reports.set(report.id, report);
    await save();
    return { imported: true, slug: normalized.slug, reason: "imported", report };
  }

  async function importPublishedPages(records, options = {}) {
    const imported = [];
    const skipped = [];
    const failed = [];
    for (const record of records || []) {
      try {
        const result = await importPublishedPage(record, options);
        if (result.imported) {
          imported.push(formatReport(result.report, options));
        } else {
          skipped.push({ slug: result.slug, reason: result.reason });
        }
      } catch (error) {
        failed.push({
          slug: String(record?.slug || ""),
          error: error.message || String(error)
        });
      }
    }
    return { imported, skipped, failed };
  }

  function findPublication(token) {
    for (const report of reports.values()) {
      const publication = (report.publications || []).find((item) => item.token === token);
      if (publication) {
        return { report, publication };
      }
    }

    return null;
  }

  async function revokePublication(token) {
    const revokedAt = nowIso();
    const match = findPublication(token);
    if (!match) {
      throw appError("Published link was not found.", 404);
    }

    if (!match.publication.revokedAt) {
      const previousReportUpdatedAt = match.report.updatedAt;
      match.publication.revokedAt = revokedAt;
      match.report.updatedAt = revokedAt;
      try {
        await save();
      } catch (error) {
        match.publication.revokedAt = null;
        match.report.updatedAt = previousReportUpdatedAt;
        throw error;
      }
    }
    return match;
  }

  async function revokeAll(id) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }

    const revokedAt = nowIso();
    const previousReportUpdatedAt = report.updatedAt;
    const previousRevokedAt = new Map();
    let revokedCount = 0;
    for (const publication of report.publications || []) {
      if (!publication.revokedAt) {
        previousRevokedAt.set(publication, publication.revokedAt || null);
        publication.revokedAt = revokedAt;
        revokedCount += 1;
      }
    }

    if (revokedCount > 0) {
      report.updatedAt = revokedAt;
      try {
        await save();
      } catch (error) {
        for (const [publication, previous] of previousRevokedAt) {
          publication.revokedAt = previous;
        }
        report.updatedAt = previousReportUpdatedAt;
        throw error;
      }
    }

    return { report, revokedCount };
  }

  function findActivePublication(token) {
    for (const report of reports.values()) {
      const publication = (report.publications || []).find((item) => item.token === token);
      if (publication && !publication.revokedAt) {
        return { report, publication };
      }
    }

    return null;
  }

  function findActivePublicationBySlug(slug) {
    for (const report of reports.values()) {
      const publication = (report.publications || []).find(
        (item) => (item.slug || item.token) === slug && !item.revokedAt
      );
      if (publication) {
        return { report, publication };
      }
    }

    return null;
  }

  function activeSnapshotPublications(report) {
    return (report.publications || []).filter(
      (publication) => !publication.revokedAt && publication.kind === "snapshot"
    );
  }

  function listPublications(pagesConfig = null) {
    const publications = [];
    for (const report of reports.values()) {
      for (const publication of report.publications || []) {
        const projectRef = storedProjectRef(publication);
        if (
          pagesConfig === null ||
          (projectRef !== null && projectRefEquals(projectRef, pagesConfig))
        ) {
          publications.push(publication);
        }
      }
    }
    return publications;
  }

  function listProjectRefs() {
    const refs = new Map();
    for (const publication of listPublications()) {
      const projectRef = storedProjectRef(publication);
      if (projectRef) {
        refs.set(projectRefFilesystemKey(projectRef), projectRef);
      }
    }
    for (const redirect of redirects) {
      if (redirect.projectRef) {
        refs.set(projectRefFilesystemKey(redirect.projectRef), redirect.projectRef);
      }
    }
    return [...refs.values()];
  }

  function listOperations() {
    return operations.map((entry) => structuredClone(entry));
  }

  function getOperation(id) {
    const operation = operations.find((entry) => entry.id === id);
    return operation ? structuredClone(operation) : null;
  }

  function listPendingDeletions() {
    return pendingDeletions.map((entry) => structuredClone(entry));
  }

  async function beginOperations(entries = []) {
    const timestamp = nowIso();
    const incoming = (Array.isArray(entries) ? entries : [entries]).map((entry) => {
      const token = String(entry?.token || "").trim();
      const type = String(entry?.type || "").trim();
      if (!token || !type) {
        throw appError("An operation type and publication token are required.", 400);
      }
      const id = `${type}:${token}`;
      const existing = operations.find((item) => item.id === id);
      return {
        ...(existing || {}),
        ...structuredClone(entry),
        id,
        type,
        token,
        slug: entry.slug || token,
        projectRef: storedProjectRef({ projectRef: entry.projectRef }),
        status: "pending",
        error: "",
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
        attempts: existing?.attempts || 0
      };
    });
    const ids = new Set(incoming.map((entry) => entry.id));
    operations = [...operations.filter((entry) => !ids.has(entry.id)), ...incoming];
    await save();
    return incoming.map((entry) => structuredClone(entry));
  }

  async function recordOperationFailure(entry = {}) {
    const { error, ...metadata } = entry;
    const type = String(metadata.type || "").trim();
    const token = String(metadata.token || "").trim();
    if (!type || !token) {
      throw appError("An operation type and publication token are required.", 400);
    }
    const id = `${type}:${token}`;
    const timestamp = nowIso();
    const existing = operations.find((entry) => entry.id === id);
    const next = {
      ...(existing || {}),
      ...structuredClone(metadata),
      id,
      type,
      token,
      slug: metadata.slug || existing?.slug || token,
      projectRef: storedProjectRef({
        projectRef:
          metadata.projectRef === undefined ? existing?.projectRef : metadata.projectRef
      }),
      status: "failed",
      error: String(error?.message || error || "Operation failed."),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      attempts: (existing?.attempts || 0) + 1
    };
    const previousOperations = operations;
    operations = [...operations.filter((entry) => entry.id !== id), next];
    try {
      await save();
    } catch (saveError) {
      operations = previousOperations;
      throw saveError;
    }
    return structuredClone(next);
  }

  async function clearOperation(type, token) {
    const id = `${type}:${token}`;
    const next = operations.filter((entry) => entry.id !== id);
    if (next.length !== operations.length) {
      const previousOperations = operations;
      operations = next;
      try {
        await save();
      } catch (error) {
        operations = previousOperations;
        throw error;
      }
    }
  }

  async function clearOperations(entries = []) {
    const ids = new Set(
      (Array.isArray(entries) ? entries : [entries]).map(
        (entry) => `${String(entry?.type || "")}:${String(entry?.token || "")}`
      )
    );
    const next = operations.filter((entry) => !ids.has(entry.id));
    if (next.length !== operations.length) {
      const previousOperations = operations;
      operations = next;
      try {
        await save();
      } catch (error) {
        operations = previousOperations;
        throw error;
      }
    }
  }

  async function commitSuccessfulRevoke(token) {
    const match = findPublication(token);
    if (!match) {
      throw appError("Published link was not found.", 404);
    }

    const operationId = `revoke:${token}`;
    const previousOperations = operations;
    const previousRevokedAt = match.publication.revokedAt || null;
    const previousReportUpdatedAt = match.report.updatedAt;
    const nextOperations = operations.filter((entry) => entry.id !== operationId);
    const revokedAt = previousRevokedAt || nowIso();
    const revoked = !previousRevokedAt;
    const operationCleared = nextOperations.length !== operations.length;
    if (!revoked && !operationCleared) {
      return { ...match, revoked: false, operationCleared: false };
    }

    if (revoked) {
      match.publication.revokedAt = revokedAt;
      match.report.updatedAt = revokedAt;
    }
    operations = nextOperations;
    try {
      // Remote success has exactly one local commit: the link becomes revoked
      // and any retry journal entry disappears in the same reports.json write.
      await save();
    } catch (error) {
      match.publication.revokedAt = previousRevokedAt;
      match.report.updatedAt = previousReportUpdatedAt;
      operations = previousOperations;
      throw error;
    }
    return { ...match, revoked, operationCleared };
  }

  async function commitRecoveredPublish(reportId, publication) {
    const report = reports.get(reportId);
    if (!report) {
      throw appError("The page for this publish operation no longer exists.", 409);
    }
    if (!publication || typeof publication.token !== "string" || !publication.token) {
      throw appError("The publish operation is missing its publication state.", 409);
    }

    const token = publication.token;
    const existing = findPublication(token);
    if (existing && existing.report.id !== reportId) {
      throw appError("The publication token now belongs to a different page.", 409);
    }
    if (existing?.publication.revokedAt) {
      throw appError("A revoked publication cannot be recovered as a publish.", 409);
    }

    let committedPublication;
    if (existing && existing.publication.pending !== true) {
      const existingSlug = existing.publication.slug || existing.publication.token;
      const recoveredSlug = publication.slug || publication.token;
      if (existingSlug !== recoveredSlug) {
        throw appError("The published link changed after this operation was recorded.", 409);
      }
      committedPublication = existing.publication;
    } else {
      committedPublication = normalizePublication({
        ...structuredClone(publication),
        pending: false,
        revokedAt: null
      });
      const publications = report.publications || [];
      const index = publications.findIndex((item) => item.token === token);
      report.publications =
        index === -1
          ? [...publications, committedPublication]
          : publications.map((item, itemIndex) =>
              itemIndex === index ? committedPublication : item
            );
      report.updatedAt = committedPublication.updatedAt || nowIso();
    }

    operations = operations.filter((entry) => entry.id !== `publish:${token}`);
    // The remote-success checkpoint and local publication become one durable
    // outcome: callers never observe an active publication with a stale retry.
    await save();
    return { report, publication: committedPublication };
  }

  async function recoverMissingReportSource(report) {
    if (!report || !reportSourceMissing(report)) {
      return false;
    }
    const publication = activeSnapshotPublications(report)
      .filter((item) => item.publicUrl)
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))[0];
    if (!publication?.publicUrl) {
      return false;
    }

    const recoveryRoot = path.join(workingRoot, `${report.id}-recovered`);
    let recovered = null;
    const slug = publication.slug || publication.token;
    const projectRef = storedProjectRef(publication);
    const localCandidates = [
      projectRef
        ? path.join(
            dataDir,
            "targets",
            projectRefFilesystemKey(projectRef),
            "snapshots",
            publicationTokenFilesystemKey(publication.token),
            "content"
          )
        : "",
      projectRef
        ? path.join(
            dataDir,
            "targets",
            projectRefFilesystemKey(projectRef),
            "last-deployed",
            "p",
            slug
          )
        : "",
      slug ? path.join(dataDir, "pages-site", "p", slug) : "",
      projectRef && slug
        ? path.join(
            dataDir,
            "pages-deploy",
            "direct",
            projectRefFilesystemKey(projectRef),
            encodeURIComponent(DEFAULT_PAGES_BRANCH),
            "p",
            slug
          )
        : "",
      projectRef && publication.publicUrl === projectRef.baseUrl
        ? path.join(
            dataDir,
            "pages-deploy",
            "direct",
            projectRefFilesystemKey(projectRef),
            encodeURIComponent(DEFAULT_PAGES_BRANCH)
          )
        : ""
    ].filter(Boolean);

    for (const candidate of localCandidates) {
      try {
        const entryFile = await findFolderEntry(candidate);
        await copyPublicTree(candidate, recoveryRoot);
        recovered = { entryFile };
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && error.statusCode !== 400) {
          throw error;
        }
      }
    }

    if (!recovered) {
      recovered = await copyPublicUrlFiles({
        publicUrl: publication.publicUrl,
        destinationRoot: recoveryRoot,
        fetchImpl: recoverFetchImpl
      });
    }
    report.workingDir = recoveryRoot;
    report.entryFile = recovered.entryFile;
    report.sourceMode = "edited-in-pagecast";
    report.autoSync = false;
    report.importedFromCloudflare = true;
    report.buildOutputRoot = null;
    report.buildStatus = "ready";
    report.buildError = "";
    report.updatedAt = nowIso();
    await save();
    return true;
  }

  // The set of currently-live protected slugs and their password hashes, used to
  // regenerate the edge auth middleware on every deploy. One report's hash maps
  // to every active snapshot slug of that report.
  // Slugs that need an edge Function — password-protected and/or expiring. Note:
  // expired (but not revoked) publications stay in the manifest so the middleware
  // keeps returning 410 rather than silently serving the still-deployed content.
  function protectedPublicationManifest(pagesConfig = null) {
    const manifest = [];
    for (const report of reports.values()) {
      const protectedReport = report.passwordProtected && isValidPasswordHash(report.passwordHash);
      for (const publication of activeSnapshotPublications(report)) {
        const projectRef = storedProjectRef(publication);
        if (pagesConfig !== null && (!projectRef || !projectRefEquals(projectRef, pagesConfig))) {
          continue;
        }
        const hasExpiry = typeof publication.expiresAt === "number" && publication.expiresAt > 0;
        if (!protectedReport && !hasExpiry) {
          continue;
        }
        const entry = { slug: publication.slug || publication.token, projectRef };
        if (protectedReport) {
          Object.assign(entry, report.passwordHash);
        }
        if (hasExpiry) {
          entry.expiresAt = publication.expiresAt;
        }
        manifest.push(entry);
      }
    }
    return manifest;
  }

  // Set (or clear, with null) the expiry of an existing publication. Caller
  // redeploys active snapshots afterwards so the edge manifest refreshes.
  async function setPublicationExpiry(token, expiresAt) {
    const match = findPublication(token);
    if (!match) {
      throw appError("Published link was not found.", 404);
    }
    match.publication.expiresAt = typeof expiresAt === "number" && expiresAt > 0 ? expiresAt : null;
    match.publication.updatedAt = nowIso();
    match.report.updatedAt = match.publication.updatedAt;
    await save();
    return match;
  }

  // Bump a snapshot's updatedAt (and its report's) after a successful same-URL
  // sync. Token is the stable identity; the slug/URL is unchanged.
  async function syncSnapshot(token) {
    const match = findActivePublication(token);
    if (!match) {
      throw appError("Published link was not found.", 404);
    }
    if (match.publication.kind !== "snapshot") {
      throw appError("Only snapshot publications can be synced.", 400);
    }
    const updatedAt = nowIso();
    match.publication.updatedAt = updatedAt;
    match.report.updatedAt = updatedAt;
    await save();
    return match;
  }

  async function adoptPublicationTarget(token, pagesConfig) {
    const match = findPublication(token);
    if (!match) {
      throw appError("Published link was not found.", 404);
    }
    const projectRef = normalizeProjectRef(pagesConfig);
    rememberPublicationPagesTarget(match.publication, {
      ...pagesConfig,
      ...projectRef
    });
    match.publication.updatedAt = nowIso();
    match.report.updatedAt = match.publication.updatedAt;
    await save();
    return match;
  }

  // Returns the set of slugs currently in use (non-revoked publications) plus
  // existing redirect sources, so callers can enforce slug uniqueness.
  function usedSlugs() {
    const used = new Set();
    for (const report of reports.values()) {
      for (const publication of report.publications || []) {
        if (!publication.revokedAt) {
          used.add(publication.slug || publication.token);
        }
      }
    }
    for (const entry of redirects) {
      const fromMatch = /^\/p\/([^/]+)\/?$/.exec(entry.from);
      if (fromMatch) {
        used.add(decodeURIComponent(fromMatch[1]));
      }
    }
    return used;
  }

  // Rename a publication's slug: validates and enforces uniqueness, rewrites the
  // publicUrl to the new /p/<slug>/ path, records a 301 redirect from the old
  // slug, and bumps updatedAt. Token stays the stable identity.
  async function renameSlug(token, rawSlug) {
    const match = findActivePublication(token);
    if (!match) {
      throw appError("Published link was not found.", 404);
    }
    const newSlug = normalizeCustomSlug(rawSlug);
    const oldSlug = match.publication.slug || match.publication.token;
    if (newSlug === oldSlug) {
      return { ...match, oldSlug, newSlug };
    }
    if (usedSlugs().has(newSlug)) {
      throw appError("That custom URL is already in use.", 409);
    }

    const updatedAt = nowIso();
    match.publication.slug = newSlug;
    // A user-selected vanity path without a full 128-bit capability is
    // intentionally discoverable and must not keep claiming the `unlisted`
    // classification. Persist the decision as metadata so old slugs loaded
    // from disk remain legacy links unless a user explicitly renames them.
    match.publication.drop = inspectCapabilitySlug(newSlug) === null;
    if (match.publication.kind === "snapshot" && match.publication.publicUrl) {
      const base = match.publication.publicUrl.replace(/\/p\/[^/]+\/?$/, "");
      match.publication.publicUrl = joinUrl(base, `/p/${encodeURIComponent(newSlug)}/`);
    }
    match.publication.updatedAt = updatedAt;
    match.report.updatedAt = updatedAt;
    addRedirect(`/p/${oldSlug}/`, `/p/${newSlug}/`, storedProjectRef(match.publication));
    await save();
    return { ...match, oldSlug, newSlug };
  }

  async function restorePublicationSlug(token, previous) {
    const match = findPublication(token);
    if (!match) {
      return null;
    }
    const oldSlug = previous?.slug || match.publication.token;
    const failedSlug = match.publication.slug || match.publication.token;
    match.publication.slug = oldSlug;
    if (previous && Object.hasOwn(previous, "drop")) {
      match.publication.drop = previous.drop === true;
    }
    match.publication.publicUrl =
      previous && Object.hasOwn(previous, "publicUrl") ? previous.publicUrl : match.publication.publicUrl;
    match.publication.updatedAt = previous?.publicationUpdatedAt || match.publication.updatedAt;
    match.report.updatedAt = previous?.reportUpdatedAt || match.report.updatedAt;
    redirects = redirects.filter((entry) => {
      const from = `/p/${oldSlug}/`;
      const to = `/p/${failedSlug}/`;
      return !(entry.from === from && entry.to === to);
    });
    if (Array.isArray(previous?.redirects)) {
      redirects = previous.redirects.map((entry) => ({
        from: entry.from,
        to: entry.to,
        projectRef: storedProjectRef(entry)
      }));
    }
    await save();
    return match;
  }

  async function resolveAsset(id, rawAssetPath = "") {
    const report = reports.get(id);
    if (!report) {
      return { statusCode: 404, message: "Report was not found." };
    }

    const relativeAssetPath = normalizeAssetRequestPath(rawAssetPath);
    if (relativeAssetPath === null) {
      return { statusCode: 403, message: "Asset path is not allowed." };
    }

    const rootDir = reportSourceRoot(report);
    const targetPath =
      relativeAssetPath === ""
        ? path.resolve(rootDir, report.entryFile)
        : path.resolve(rootDir, relativeAssetPath);

    if (!isPathInside(rootDir, targetPath)) {
      return { statusCode: 403, message: "Asset path is not allowed." };
    }

    let stat;
    try {
      stat = await fs.stat(targetPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        if (relativeAssetPath === "" && (await recoverMissingReportSource(report))) {
          return resolveAsset(id, rawAssetPath);
        }
        if (relativeAssetPath === "" && reportSourceMissing(report)) {
          return {
            statusCode: 410,
            message: "Source file is missing, and Pagecast could not recover it from a public URL."
          };
        }
        return {
          statusCode: report.kind === "path" && relativeAssetPath === "" ? 410 : 404,
          message: "Report asset was not found."
        };
      }
      throw error;
    }

    if (!stat.isFile()) {
      return { statusCode: 404, message: "Report asset was not found." };
    }

    // Symlink-escape guard for sibling assets. A symlink inside the report folder
    // (e.g. leak.txt -> /etc/passwd) passes the lexical isPathInside check above,
    // but fs.stat follows it, so without this a crafted symlink could serve files
    // outside the report root. Resolve the real path and re-verify containment.
    // (This mirrors the symlink rejection already enforced when staging snapshots
    // for Cloudflare.) The entry file itself is exempt: a `path` report can point
    // at a file the user deliberately chose, including a symlink.
    if (relativeAssetPath !== "") {
      try {
        const realRoot = await fs.realpath(rootDir);
        const realTarget = await fs.realpath(targetPath);
        if (!isPathInside(realRoot, realTarget)) {
          return { statusCode: 403, message: "Asset path is not allowed." };
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          return { statusCode: 404, message: "Report asset was not found." };
        }
        throw error;
      }
    }

    // When the requested asset IS a markdown entry, render it to HTML in memory
    // so the local preview serves a real document. Sibling assets (images, css)
    // continue to resolve as files. Published snapshots are rendered on disk by
    // staging, so only this preview path needs the in-memory render.
    if (relativeAssetPath === "" && isMarkdownFileName(report.entryFile)) {
      const markdown = await fs.readFile(targetPath, "utf8");
      const body = markdownToHtml(markdown, { title: report.name });
      return {
        statusCode: 200,
        filePath: targetPath,
        contentType: "text/html; charset=utf-8",
        body,
        size: Buffer.byteLength(body, "utf8"),
        mtime: stat.mtime
      };
    }

    return {
      statusCode: 200,
      filePath: targetPath,
      contentType: contentTypeFor(targetPath),
      size: stat.size,
      mtime: stat.mtime
    };
  }

  async function resolvePublishedAsset(slug, rawAssetPath = "") {
    const match = findActivePublicationBySlug(slug);
    if (!match) {
      // No active publication at this slug: if a redirect points away from it,
      // surface a local 301 so the legacy/old URL still lands on the new one.
      const redirect = redirects.find((entry) => {
        const fromMatch = /^\/p\/([^/]+)\/?$/.exec(entry.from);
        return fromMatch && decodeURIComponent(fromMatch[1]) === slug;
      });
      if (redirect) {
        return { statusCode: 301, location: redirect.to };
      }
      return { statusCode: 404, message: "Published link was not found." };
    }

    return resolveAsset(match.report.id, rawAssetPath);
  }

  // Ensure a report has an editable working copy. Uploads are already private
  // copies; path reports are copied from their source dir into working/<id>/ the
  // first time they are edited, after which they are "edited-in-pagecast" and no
  // longer track their original source file.
  async function detachToWorkingCopy(id) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }

    if (report.kind === "upload") {
      let changed = false;
      if (report.sourceMode !== "edited-in-pagecast") {
        report.sourceMode = "edited-in-pagecast";
        changed = true;
      }
      if (report.autoSync !== false) {
        report.autoSync = false;
        changed = true;
      }
      if (changed) {
        await save();
      }
      return report;
    }

    if (report.workingDir) {
      return report;
    }

    const workingDir = path.join(workingRoot, report.id);
    // Markdown reports keep editing their raw .md working copy (republish
    // re-renders via staging); HTML reports normalize their entry to index.html.
    const workingEntry = isMarkdownFileName(report.entryFile) ? "index.md" : "index.html";
    const sourceRoot = reportSourceRoot(report);
    await fs.rm(workingDir, { recursive: true, force: true });
    try {
      await copyPublicTree(sourceRoot, workingDir);
      await fs.copyFile(
        path.join(sourceRoot, report.entryFile),
        path.join(workingDir, workingEntry)
      );
      report.workingDir = workingDir;
      report.entryFile = workingEntry;
      report.sourceMode = "edited-in-pagecast";
      report.autoSync = false;
      report.updatedAt = nowIso();
      await save();
      return reports.get(id);
    } catch (error) {
      await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // Read the current HTML content of a report's entry document, from the working
  // copy when detached, otherwise from the original source file.
  async function readContent(id) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }
    let rootDir = reportSourceRoot(report);
    let targetPath = path.resolve(rootDir, report.entryFile);
    if (!isPathInside(rootDir, targetPath)) {
      throw appError("Report content path is not allowed.", 403);
    }
    let html;
    try {
      html = await fs.readFile(targetPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      if (await recoverMissingReportSource(report)) {
        rootDir = reportSourceRoot(report);
        targetPath = path.resolve(rootDir, report.entryFile);
        if (!isPathInside(rootDir, targetPath)) {
          throw appError("Report content path is not allowed.", 403);
        }
        html = await fs.readFile(targetPath, "utf8");
      } else {
        throw appError(
          "Source file is missing, and Pagecast could not recover it from a public URL.",
          410
        );
      }
    }
    return { html };
  }

  // Persist edited HTML to a report's working copy (creating it if needed). The
  // original source file is never touched for path reports.
  async function writeContent(id, html) {
    if (typeof html !== "string" || html.length === 0) {
      throw appError("Report content must be a non-empty string.", 400);
    }
    if (Buffer.byteLength(html, "utf8") > MAX_UPLOAD_BYTES) {
      throw appError("Report content is too large.", 413);
    }

    const report = await detachToWorkingCopy(id);
    // Write back to the report's entry file. For markdown reports this stays the
    // raw .md working copy (republish re-renders via staging); HTML reports keep
    // their index.html entry.
    const editRoot = reportSourceRoot(report);
    const targetPath = path.resolve(editRoot, report.entryFile);
    if (!isPathInside(editRoot, targetPath)) {
      throw appError("Report content path is not allowed.", 403);
    }
    const previousContent = await fs.readFile(targetPath);
    const temporaryPath = `${targetPath}.next-${randomBytes(6).toString("hex")}`;
    await fs.writeFile(temporaryPath, html, "utf8");
    await fs.rename(temporaryPath, targetPath);
    report.updatedAt = nowIso();
    try {
      await save();
      return reports.get(id);
    } catch (error) {
      const restorePath = `${targetPath}.restore-${randomBytes(6).toString("hex")}`;
      try {
        await fs.writeFile(restorePath, previousContent);
        await fs.rename(restorePath, targetPath);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Report state failed to save and its previous content could not be restored."
        );
      } finally {
        await fs.rm(restorePath, { force: true }).catch(() => {});
      }
      throw error;
    }
  }

  // Toggle auto-sync for a source-tracked path report (only valid before it has
  // been detached into a working copy).
  async function setAutoSync(id, enabled) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }
    if (report.kind !== "path" || report.workingDir) {
      throw appError("Auto-sync is only available for source-tracked path reports.", 400);
    }
    report.autoSync = enabled === true;
    report.sourceMode = "source-tracked";
    report.updatedAt = nowIso();
    await save();
    return report;
  }

  // Enable/disable edge password protection for a report. Enabling stores a
  // salted PBKDF2 hash of the password (the plaintext is never persisted) which
  // is later baked into the deployed Pages Function. Disabling clears it. The
  // caller is responsible for redeploying active snapshots so the gate flips.
  // `hash` is an internal escape hatch: callers (rollback after a failed deploy)
  // can restore a previously-computed { salt, hash, iterations } without the
  // plaintext. Normal callers pass `password` and the hash is derived.
  async function setPasswordProtection(id, { enabled, password, hash } = {}) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }
    if (enabled) {
      let nextHash = hash;
      if (!nextHash) {
        const normalized = String(password ?? "").trim();
        if (!normalized) {
          throw appError("A password is required to protect this page.", 400);
        }
        nextHash = makePasswordHash(normalized);
      }
      report.passwordProtected = true;
      report.passwordHash = nextHash;
    } else {
      report.passwordProtected = false;
      report.passwordHash = null;
    }
    report.updatedAt = nowIso();
    await save();
    return report;
  }

  // Reassign explicit order indices to the listed ids (in the given order). Ids
  // not listed keep their relative order after the listed ones. Unknown ids are
  // rejected so the caller can surface a 400.
  async function reorder(orderedIds) {
    if (!Array.isArray(orderedIds)) {
      throw appError("Reorder requires an array of report ids.", 400);
    }
    for (const id of orderedIds) {
      if (!reports.has(id)) {
        throw appError(`Unknown report id: ${id}`, 400);
      }
    }
    const seen = new Set(orderedIds);
    const remaining = Array.from(reports.values())
      .filter((report) => !seen.has(report.id))
      .sort((a, b) => {
        const orderA = typeof a.order === "number" ? a.order : Number.MAX_SAFE_INTEGER;
        const orderB = typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map((report) => report.id);

    const finalOrder = [...orderedIds, ...remaining];
    finalOrder.forEach((id, index) => {
      const report = reports.get(id);
      if (report) {
        report.order = index;
      }
    });
    await save();
    return list();
  }

  function listAutoSyncReports() {
    return Array.from(reports.values()).filter(
      (report) => report.kind === "path" && report.autoSync && !report.workingDir
    );
  }

  return {
    init,
    list,
    get,
    addPath: serializeStoreMutation(addPath),
    replaceSourceWithPath: serializeStoreMutation(replaceSourceWithPath),
    addFolder: serializeStoreMutation(addFolder),
    addUpload: serializeStoreMutation(addUpload),
    addFolderUpload: serializeStoreMutation(addFolderUpload),
    buildReport: serializeStoreMutation(buildReport),
    remove: serializeStoreMutation(remove),
    draftPublication,
    commitPublication: serializeStoreMutation(commitPublication),
    publish: serializeStoreMutation(publish),
    importPublishedPage: serializeStoreMutation(importPublishedPage),
    importPublishedPages: serializeStoreMutation(importPublishedPages),
    findPublication,
    findPublishMatch,
    findActivePublication,
    findActivePublicationBySlug,
    activeSnapshotPublications,
    listPublications,
    listProjectRefs,
    listOperations,
    getOperation,
    listPendingDeletions,
    beginOperations: serializeStoreMutation(beginOperations),
    recordOperationFailure: serializeStoreMutation(recordOperationFailure),
    clearOperation: serializeStoreMutation(clearOperation),
    clearOperations: serializeStoreMutation(clearOperations),
    commitSuccessfulRevoke: serializeStoreMutation(commitSuccessfulRevoke),
    commitRecoveredPublish: serializeStoreMutation(commitRecoveredPublish),
    protectedPublicationManifest,
    setPublicationExpiry: serializeStoreMutation(setPublicationExpiry),
    revokePublication: serializeStoreMutation(revokePublication),
    revokeAll: serializeStoreMutation(revokeAll),
    syncSnapshot: serializeStoreMutation(syncSnapshot),
    adoptPublicationTarget: serializeStoreMutation(adoptPublicationTarget),
    renameSlug: serializeStoreMutation(renameSlug),
    restorePublicationSlug: serializeStoreMutation(restorePublicationSlug),
    detachToWorkingCopy: serializeStoreMutation(detachToWorkingCopy),
    readContent,
    writeContent: serializeStoreMutation(writeContent),
    setAutoSync: serializeStoreMutation(setAutoSync),
    setPasswordProtection: serializeStoreMutation(setPasswordProtection),
    reorder: serializeStoreMutation(reorder),
    listAutoSyncReports,
    listRedirects,
    addRedirect,
    resolveAsset,
    resolvePublishedAsset,
    formatReport,
    formatPublication,
    workingRoot,
    dataDir
  };
}

async function readRequestBody(req, maxBytes = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      tooLarge = true;
    } else {
      chunks.push(chunk);
    }
  }

  if (tooLarge) {
    throw appError("Request body is too large.", 413);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const body = await readRequestBody(req, 1024 * 1024);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw appError("Request body must be valid JSON.", 400);
  }
}

export function parseMultipartUpload(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundaryValue = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundaryValue) {
    throw appError("Upload request is missing a multipart boundary.", 400);
  }

  const boundary = `--${boundaryValue}`;
  const rawBody = body.toString("latin1");
  const parts = rawBody.split(boundary).slice(1, -1);

  for (const rawPart of parts) {
    const part = rawPart.startsWith("\r\n") ? rawPart.slice(2) : rawPart;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }

    const headerText = part.slice(0, headerEnd);
    let contentText = part.slice(headerEnd + 4);
    if (contentText.endsWith("\r\n")) {
      contentText = contentText.slice(0, -2);
    }

    const disposition = headerText
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-disposition:"));
    if (!disposition) {
      continue;
    }

    const name = /name="([^"]+)"/i.exec(disposition)?.[1] || "";
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] || "";
    if (filename) {
      return {
        fieldName: name,
        filename,
        content: Buffer.from(contentText, "latin1")
      };
    }
  }

  throw appError("Upload request did not include an HTML file.", 400);
}

export function parseMultipartFiles(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundaryValue = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundaryValue) {
    throw appError("Upload request is missing a multipart boundary.", 400);
  }

  const boundary = `--${boundaryValue}`;
  const rawBody = body.toString("latin1");
  const parts = rawBody.split(boundary).slice(1, -1);
  const files = [];

  for (const rawPart of parts) {
    const part = rawPart.startsWith("\r\n") ? rawPart.slice(2) : rawPart;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }

    const headerText = part.slice(0, headerEnd);
    let contentText = part.slice(headerEnd + 4);
    if (contentText.endsWith("\r\n")) {
      contentText = contentText.slice(0, -2);
    }

    const disposition = headerText
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-disposition:"));
    if (!disposition) {
      continue;
    }

    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] || "";
    if (filename) {
      files.push({
        filename,
        content: Buffer.from(contentText, "latin1")
      });
    }
  }

  if (files.length === 0) {
    throw appError("Upload request did not include any files.", 400);
  }
  return files;
}

// When the request came from a Chrome extension (adminHandler stashed the
// reflected origin on res.__corsOrigin), echo it so the extension can read the
// response. Scoped to chrome-extension:// only — never a wildcard.
function corsHeadersFor(res) {
  return res.__corsOrigin
    ? { "Access-Control-Allow-Origin": res.__corsOrigin, Vary: "Origin" }
    : {};
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...corsHeadersFor(res),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    ...corsHeadersFor(res),
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${message}\n`);
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  sendJson(res, statusCode, {
    error: {
      message: error.expose ? error.message : "Internal server error.",
      statusCode
    }
  });
}

// Send an in-memory HTML body (used for the markdown preview render, where
// there is no file on disk to stream).
function sendHtmlBody(req, res, file, extraHeaders = {}) {
  const buffer = Buffer.isBuffer(file.body) ? file.body : Buffer.from(String(file.body), "utf8");
  res.writeHead(200, {
    "Content-Type": file.contentType || "text/html; charset=utf-8",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(buffer);
}

async function sendFile(req, res, file, extraHeaders = {}) {
  res.writeHead(200, {
    "Content-Type": file.contentType || contentTypeFor(file.filePath),
    "Content-Length": file.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  await new Promise((resolve, reject) => {
    const stream = createReadStream(file.filePath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

async function serveStatic(req, res, staticDir, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalizedPath = normalizeAssetRequestPath(relativePath);
  if (normalizedPath === null) {
    sendText(res, 403, "Static path is not allowed.");
    return;
  }

  const filePath = path.resolve(staticDir, normalizedPath);
  if (!isPathInside(staticDir, filePath)) {
    sendText(res, 403, "Static path is not allowed.");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, "Not found.");
      return;
    }
    await sendFile(req, res, {
      filePath,
      contentType: contentTypeFor(filePath),
      size: stat.size
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not found.");
      return;
    }
    throw error;
  }
}

function reportOptions({ getAdminBaseUrl, getLocalPublicBaseUrl }) {
  return {
    adminBaseUrl: getAdminBaseUrl(),
    localPublicBaseUrl: getLocalPublicBaseUrl()
  };
}

function targetManagementState(configStore, pages = configStore.get().pages) {
  const configured = Boolean(
    normalizeAccountIdSafe(pages?.accountId) &&
      normalizePagesProjectNameSafe(pages?.projectName)
  );
  const managed = configured && configStore.isTargetManaged(pages);
  return { managed, requiresAdoption: configured && !managed };
}

function suggestedPagecastHomeProjectName(configStore) {
  const config = configStore.get();
  if (config.pages.projectName && config.pages.projectName !== DEFAULT_PAGES_PROJECT_NAME) {
    return config.pages.projectName;
  }
  const suffix = String(config.installationId || "").slice(0, 8) || "home";
  return normalizePagesProjectName(`pagecast-${suffix}`);
}

function cloudflareAuthorizationUrl(value) {
  const match = cleanCommandOutput(value).match(/https:\/\/dash\.cloudflare\.com\/[^\s]+/i);
  if (!match) return "";
  const candidate = match[0].replace(/[),.;]+$/, "");
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname === "dash.cloudflare.com"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function publicConnectionJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    authorizationUrl: job.authorizationUrl || "",
    requestedScopes: [...CLOUDFLARE_OAUTH_SCOPES],
    projectName: job.projectName || "",
    baseUrl: job.baseUrl || "",
    needsAccountChoice: job.needsAccountChoice === true,
    accounts: Array.isArray(job.accounts) ? job.accounts : [],
    error: job.error || ""
  };
}

async function detectAndPersistCloudflareProjects({ cloudflareAuth, configStore }) {
  const currentConfig = configStore.getPublicConfig();
  const projects = await cloudflareAuth.listProjects({
    accountId: currentConfig.pages.accountId
  });
  const selectedProject = chooseWranglerPagesProject(projects, currentConfig.pages);
  if (selectedProject) {
    await configStore.updatePages({
      projectName: selectedProject.name,
      accountId: selectedProject.accountId || currentConfig.pages.accountId,
      accountName: selectedProject.accountName || currentConfig.pages.accountName,
      baseUrl: selectedProject.baseUrl
    });
  }

  return {
    config: configStore.getPublicConfig(),
    cloudflare: {
      authenticated: true,
      projects,
      selectedProject,
      projectCount: projects.length,
      ...targetManagementState(configStore)
    }
  };
}

// Resolve the Cloudflare account automatically (no manual account ID for the
// single-account case) and ensure a publishable Pages project exists, creating
// the default one when none is found. This is the seamless one-shot target used
// by /api/cloudflare/connect and by snapshot self-provisioning.
async function ensureCloudflarePagesTarget({
  cloudflareAuth,
  configStore,
  autoCreate = true,
  adoptExisting = false,
  branch = DEFAULT_PAGES_BRANCH
}) {
  const currentConfig = configStore.getPublicConfig();
  const session = await cloudflareAuth.refreshSession();
  const accounts = session.accounts;
  const productionBranch = normalizePagesBranch(branch);

  if (!session.loggedIn) {
    return {
      config: currentConfig,
      cloudflare: {
        authenticated: false,
        needsAccountChoice: false,
        accounts: [],
        account: null,
        projects: [],
        selectedProject: null,
        projectCount: 0,
        autoCreated: false,
        ...targetManagementState(configStore, currentConfig.pages)
      }
    };
  }

  const envAccountId = normalizeAccountIdSafe(process.env.CLOUDFLARE_ACCOUNT_ID);
  let account = null;
  if (envAccountId) {
    account = accounts.find((item) => item.id === envAccountId) || { id: envAccountId, name: "" };
  } else if (currentConfig.pages.accountId) {
    account = accounts.find((item) => item.id === currentConfig.pages.accountId) || null;
  }
  if (!account && accounts.length === 1) {
    account = accounts[0];
  }

  const needsAccountChoice = !account && accounts.length > 1;
  const accountId = account?.id || "";
  const accountName = normalizeAccountName(account?.name || currentConfig.pages.accountName || "");

  if (needsAccountChoice) {
    return {
      config: currentConfig,
      cloudflare: {
        authenticated: true,
        needsAccountChoice: true,
        accounts,
        account: null,
        projects: [],
        selectedProject: null,
        projectCount: 0,
        autoCreated: false,
        ...targetManagementState(configStore, currentConfig.pages)
      }
    };
  }

  let projects = await cloudflareAuth.listProjects({ accountId });
  let selectedProject = chooseWranglerPagesProject(projects, currentConfig.pages);
  let autoCreated = false;

  if (!selectedProject && autoCreate) {
    const projectName = currentConfig.pages.projectName || DEFAULT_PAGES_PROJECT_NAME;
    await cloudflareAuth.ensureProject({
      projectName,
      accountId,
      branch: productionBranch
    });
    autoCreated = true;
    projects = await cloudflareAuth.listProjects({ accountId });
    selectedProject =
      chooseWranglerPagesProject(projects, { projectName }) || {
        name: normalizePagesProjectName(projectName),
        accountId,
        accountName,
        productionBranch,
        baseUrl: pagesBaseUrl(projectName)
      };
  }

  if (selectedProject) {
    const selectedDefaultBaseUrl = pagesBaseUrl(selectedProject.name);
    const sameConfiguredProject =
      currentConfig.pages.projectName === selectedProject.name &&
      (!currentConfig.pages.accountId ||
        !selectedProject.accountId ||
        currentConfig.pages.accountId === selectedProject.accountId);
    const configuredBaseUrl = sameConfiguredProject ? currentConfig.pages.baseUrl : "";
    const baseUrl =
      configuredBaseUrl && selectedProject.baseUrl === selectedDefaultBaseUrl
        ? configuredBaseUrl
        : selectedProject.baseUrl;
    await configStore.updatePages({
      projectName: selectedProject.name,
      accountId: selectedProject.accountId || accountId,
      accountName: accountName || selectedProject.accountName,
      baseUrl,
      adoptExisting: autoCreated || adoptExisting
    });
  } else if (accountId) {
    await configStore.updatePages({
      projectName: currentConfig.pages.projectName,
      accountId,
      accountName
    });
  }

  return {
    config: configStore.getPublicConfig(),
    cloudflare: {
      authenticated: true,
      needsAccountChoice: false,
      accounts,
      account: account
        ? {
            id: accountId,
            name: accountName || normalizeAccountName(selectedProject?.accountName || "")
          }
        : null,
      projects,
      selectedProject,
      projectCount: projects.length,
      autoCreated,
      ...targetManagementState(configStore)
    }
  };
}

export function createPublicHandler({ store }) {
  return async function publicHandler(req, res) {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method not allowed.");
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || DEFAULT_HOST}`);
      if (url.pathname === "/healthz") {
        sendText(res, 200, "ok");
        return;
      }

      const previewMatch = /^\/preview\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (previewMatch) {
        const id = decodeURIComponent(previewMatch[1]);
        const tail = previewMatch[2] || "";
        if (tail === "") {
          res.writeHead(302, {
            Location: `/preview/${encodeURIComponent(id)}/`,
            ...PREVIEW_SECURITY_HEADERS,
            "Cache-Control": "no-store"
          });
          res.end();
          return;
        }

        const rawAssetPath = tail === "/" ? "" : tail.slice(1);
        const resolvedAsset = await store.resolveAsset(id, rawAssetPath);
        if (resolvedAsset.statusCode !== 200) {
          sendText(res, resolvedAsset.statusCode, resolvedAsset.message);
          return;
        }

        if (resolvedAsset.body !== undefined) {
          sendHtmlBody(req, res, resolvedAsset, PREVIEW_SECURITY_HEADERS);
          return;
        }

        await sendFile(req, res, resolvedAsset, PREVIEW_SECURITY_HEADERS);
        return;
      }

      const match = /^\/p\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!match) {
        sendText(res, 404, "Not found.");
        return;
      }

      const slug = decodeURIComponent(match[1]);
      const tail = match[2] || "";
      if (tail === "") {
        res.writeHead(302, { Location: `/p/${encodeURIComponent(slug)}/` });
        res.end();
        return;
      }

      const rawAssetPath = tail === "/" ? "" : tail.slice(1);
      const resolvedAsset = await store.resolvePublishedAsset(slug, rawAssetPath);
      if (resolvedAsset.statusCode === 301) {
        res.writeHead(301, { Location: resolvedAsset.location });
        res.end();
        return;
      }
      if (resolvedAsset.statusCode !== 200) {
        sendText(res, resolvedAsset.statusCode, resolvedAsset.message);
        return;
      }

      // A markdown entry resolves with an in-memory rendered HTML body; serve it
      // directly rather than streaming the raw .md source.
      if (resolvedAsset.body !== undefined) {
        sendHtmlBody(req, res, resolvedAsset);
        return;
      }

      await sendFile(req, res, resolvedAsset);
    } catch (error) {
      sendError(res, error);
    }
  };
}

export function createAdminHandler({
  store,
  configStore,
  cloudflareAuth,
  pagesPublisher,
  staticDir,
  getAdminBaseUrl,
  getCommandBaseUrl = getAdminBaseUrl,
  getLocalPublicBaseUrl,
  tunnelManager,
  deployQueue,
  mutationQueue = null,
  watchManager,
  connectionJobs = new Map(),
  serviceFetch = fetch,
  commandCapability = "",
  bindHost = DEFAULT_HOST,
  allowedHosts = []
}) {
  const csrfToken = randomBytes(32).toString("base64url");

  return async function adminHandler(req, res) {
    try {
      if (!isLoopbackHostHeader(req.headers.host, bindHost, allowedHosts)) {
        sendText(
          res,
          403,
          "Forbidden: the Pagecast admin server only accepts loopback (localhost) requests."
        );
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
      const extensionOrigin = extensionCorsOrigin(origin);
      const extensionMarked = req.headers["x-pagecast-extension"] === "1";
      const extensionPreflight = Boolean(
        extensionOrigin && req.method === "OPTIONS" && EXTENSION_API_ROUTES.has(url.pathname)
      );
      const isExtensionRequest = Boolean(
        extensionOrigin && (extensionMarked || extensionPreflight)
      );
      const sameAdminOrigin = Boolean(origin && origin === requestOrigin(req));
      const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();

      if (origin && !sameAdminOrigin && !isExtensionRequest) {
        sendText(res, 403, "Forbidden: this browser origin cannot access the Pagecast admin API.");
        return;
      }
      if (!isExtensionRequest && fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
        sendText(res, 403, "Forbidden: cross-site admin requests are not allowed.");
        return;
      }
      if (isExtensionRequest && !EXTENSION_API_ROUTES.has(url.pathname)) {
        sendText(res, 403, "Forbidden: this Pagecast extension route is not allowed.");
        return;
      }

      // Chrome-extension CORS is constrained to the three extension adapter
      // routes; no extension origin can access general admin configuration.
      const corsOrigin = isExtensionRequest ? extensionOrigin : null;
      if (corsOrigin) {
        res.__corsOrigin = corsOrigin;
      }
      if (req.method === "OPTIONS") {
        const headers = { "Cache-Control": "no-store" };
        if (extensionOrigin && EXTENSION_API_ROUTES.has(url.pathname)) {
          headers["Access-Control-Allow-Origin"] = extensionOrigin;
          headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
          headers["Access-Control-Allow-Headers"] =
            "Content-Type, X-Pagecast-CSRF, X-Pagecast-Extension";
          headers.Vary = "Origin";
        }
        res.writeHead(204, headers);
        res.end();
        return;
      }

      if (url.pathname === "/api/session" && req.method === "GET") {
        sendJson(res, 200, { csrfToken });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (ADMIN_MUTATION_METHODS.has(req.method)) {
          if (origin) {
            const suppliedToken = req.headers["x-pagecast-csrf"];
            if (!tokensMatch(suppliedToken, csrfToken)) {
              sendText(res, 403, "Forbidden: the Pagecast admin session token is missing or stale.");
              return;
            }
          } else if (!tokensMatch(req.headers["x-pagecast-capability"], commandCapability)) {
            sendText(
              res,
              403,
              "Forbidden: the local Pagecast command capability is missing or stale."
            );
            return;
          }
        }
        const execute = () => handleApi(req, res, url, {
          store,
          configStore,
          cloudflareAuth,
          pagesPublisher,
          getAdminBaseUrl,
          getCommandBaseUrl,
          getLocalPublicBaseUrl,
          tunnelManager,
          deployQueue,
          mutationQueue,
          watchManager,
          connectionJobs,
          serviceFetch,
          commandCapability
        });
        if (
          mutationQueue &&
          ADMIN_MUTATION_METHODS.has(req.method) &&
          url.pathname !== "/api/command"
        ) {
          await mutationQueue.enqueue(execute);
        } else {
          await execute();
        }
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method not allowed.");
        return;
      }

      const previewMatch = /^\/preview\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (previewMatch) {
        const destination = new URL(
          `${url.pathname}${url.search}`,
          `${getLocalPublicBaseUrl()}/`
        ).toString();
        res.writeHead(302, { Location: destination, "Cache-Control": "no-store" });
        res.end();
        return;
      }

      await serveStatic(req, res, staticDir, url.pathname);
    } catch (error) {
      sendError(res, error);
    }
  };
}

export async function executeDaemonCommand({
  adminBaseUrl,
  capability,
  command,
  payload = {},
  fetchImpl = fetch
} = {}) {
  const baseUrl = stripTrailingSlash(String(adminBaseUrl || ""));
  if (!baseUrl) {
    throw appError("The Pagecast daemon command endpoint is not ready.", 503);
  }
  const sessionResponse = await fetchImpl(`${baseUrl}/api/session`, {
    headers: { "X-Pagecast-Capability": capability }
  });
  if (!sessionResponse.ok) {
    throw appError("Could not establish a Pagecast daemon session.", 503);
  }
  const session = await sessionResponse.json();
  const csrfToken = String(session?.csrfToken || "");

  async function request(pathname, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: baseUrl,
        "X-Pagecast-CSRF": csrfToken,
        "X-Pagecast-Capability": capability
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (!response.ok) {
      throw appError(
        result?.error?.message || result?.message || `Pagecast daemon command failed (${response.status}).`,
        result?.error?.statusCode || response.status
      );
    }
    return result;
  }

  if (command === "publish_report") {
    // The daemon owns one transaction boundary for add/protect/publish. Sending
    // three independent API mutations here lets unrelated writes interleave and
    // gives callers a different result shape from the one-shot publisher.
    return request("/api/command", {
      method: "POST",
      body: { command, payload }
    });
  }

  if (command === "revoke_publication") {
    return request(
      `/api/publications/${encodeURIComponent(String(payload.token || ""))}/revoke`,
      { method: "POST", body: {} }
    );
  }

  if (command === "pages_status") {
    const status = await request("/api/status");
    return { config: status.config, cloudflare: status.cloudflare };
  }

  if (command === "feedback_setup") {
    return request("/api/feedback/setup", {
      method: "POST",
      body: { accountId: payload.accountId }
    });
  }

  if (command === "deployments_list") {
    const result = await request("/api/deployments");
    return {
      deployments: result.deployments,
      projectName: result.projectName,
      baseUrl: result.baseUrl
    };
  }

  if (command === "deployment_delete") {
    const id = String(payload.id || "").trim();
    if (!id) {
      throw appError("A deployment id is required.", 400);
    }
    const force = payload.force === true ? "?force=1" : "";
    return request(
      `/api/deployments/${encodeURIComponent(id)}${force}`,
      { method: "DELETE" }
    );
  }

  if (command === "deployments_prune") {
    const keep = Number(payload.keep);
    if (!Number.isInteger(keep) || keep < 1) {
      throw appError("`keep` must be an integer of at least 1.", 400);
    }
    return request("/api/deployments/prune", {
      method: "POST",
      body: { keep }
    });
  }

  throw appError(`Unknown Pagecast daemon command: ${command || ""}`, 400);
}

function reportDeploymentTargets(store, report, currentPages) {
  const targets = new Map();
  for (const publication of store.activeSnapshotPublications(report)) {
    const pagesConfig = pagesConfigForPublication(publication, currentPages);
    const key = projectRefFilesystemKey(pagesConfig);
    if (!targets.has(key)) {
      targets.set(key, { publication, publications: [publication], pagesConfig });
    } else {
      targets.get(key).publications.push(publication);
    }
  }
  return [...targets.values()];
}

export async function instrumentActiveHomePublications({
  store,
  configStore,
  pagesPublisher,
  deployQueue,
  currentPages,
  targetsForReport = reportDeploymentTargets,
  deployTarget = deployReportTargetState
}) {
  const instrumentation = { attempted: 0, completed: 0, failed: [] };
  for (const formatted of store.list()) {
    const report = store.get(formatted.id);
    for (const target of targetsForReport(store, report, currentPages)) {
      if (!projectRefEquals(target.pagesConfig, currentPages)) continue;
      const operations = target.publications.map((publication) => ({
        type: "analytics_setup",
        token: publication.token,
        slug: publication.slug || publication.token,
        projectRef: target.pagesConfig,
        reportId: report.id
      }));
      instrumentation.attempted += target.publications.length;
      await store.beginOperations(operations);
      try {
        await deployTarget({
          store,
          configStore,
          pagesPublisher,
          deployQueue,
          report,
          ...target
        });
        instrumentation.completed += target.publications.length;
        await store.clearOperations(operations);
      } catch (error) {
        for (const operation of operations) {
          await store.recordOperationFailure({ ...operation, error }).catch(() => {});
          instrumentation.failed.push({
            publicationToken: operation.token,
            error: error.message || String(error)
          });
        }
      }
    }
  }
  return instrumentation;
}

async function deployReportTargetState({
  store,
  configStore,
  pagesPublisher,
  deployQueue,
  report,
  publication,
  publications = [publication],
  pagesConfig
}) {
  const currentPublications = [];
  for (const candidate of publications) {
    const current = store.findPublication(candidate.token);
    if (!current) {
      throw appError("Published link was not found.", 404);
    }
    report = current.report;
    currentPublications.push(current.publication);
  }
  publication =
    currentPublications.find((candidate) => candidate.token === publication.token) ||
    currentPublications[0];
  for (const candidate of currentPublications) {
    rememberPublicationPagesTarget(candidate, pagesConfig);
  }

  let remoteSucceeded = false;
  try {
    const deployedUrl = await runPublicationMutation(deployQueue, () =>
      pagesPublisher.syncPublication({
        report,
        publication,
        publications: currentPublications,
        pagesConfig
      })
    );
    remoteSucceeded = true;
    const deployedBaseUrl =
      publicUrlOrigin(deployedUrl) ||
      publicUrlOrigin(publication.publicUrl) ||
      stripTrailingSlash(pagesConfig.baseUrl || "");
    for (const candidate of currentPublications) {
      if (deployedBaseUrl) {
        candidate.publicUrl = joinUrl(
          deployedBaseUrl,
          `/p/${encodeURIComponent(candidate.slug || candidate.token)}/`
        );
      } else if (candidate.token === publication.token) {
        candidate.publicUrl = deployedUrl;
      }
      await persistActualPublicationOrigin(candidate, configStore);
      await store.syncSnapshot(candidate.token);
    }
    return publication;
  } catch (error) {
    if ((remoteSucceeded || error?.remoteSucceeded) && error && typeof error === "object") {
      error.remoteSucceeded = true;
    }
    throw error;
  }
}

async function updateReportPasswordProtection({
  store,
  configStore,
  pagesPublisher,
  deployQueue,
  reportId,
  enabled,
  password,
  hash
}) {
  const before = store.get(reportId);
  if (!before) {
    throw appError("Report was not found.", 404);
  }
  const previous = {
    enabled: before.passwordProtected === true,
    hash: before.passwordHash || null
  };
  const targets = reportDeploymentTargets(store, before, configStore.get().pages);
  const operationEntries = targets.map(({ publication, pagesConfig }) => ({
    type: "password_sync",
    token: publication.token,
    slug: publication.slug || publication.token,
    projectRef: pagesConfig,
    reportId,
    desiredProtected: enabled === true
  }));

  if (operationEntries.length > 0) {
    await store.beginOperations(operationEntries);
  }
  try {
    await store.setPasswordProtection(reportId, { enabled, password, hash });
  } catch (error) {
    await store.clearOperations(operationEntries).catch(() => {});
    throw error;
  }

  const remotelyChanged = [];
  let currentTarget = null;
  try {
    for (const target of targets) {
      currentTarget = target;
      const report = store.get(reportId);
      await deployReportTargetState({
        store,
        configStore,
        pagesPublisher,
        deployQueue,
        report,
        ...target
      });
      remotelyChanged.push(target);
      await store.clearOperation("password_sync", target.publication.token);
      currentTarget = null;
    }
    return store.get(reportId);
  } catch (error) {
    if (
      currentTarget &&
      error?.remoteSucceeded &&
      !remotelyChanged.includes(currentTarget)
    ) {
      // The target changed remotely but local finalization failed. It belongs
      // in the compensation set just like a fully returned target; otherwise a
      // password disable could be reported as rolled back while remaining live.
      remotelyChanged.push(currentTarget);
    }
    if (currentTarget) {
      await store
        .recordOperationFailure({
          type: "password_sync",
          token: currentTarget.publication.token,
          slug: currentTarget.publication.slug || currentTarget.publication.token,
          projectRef: currentTarget.pagesConfig,
          remoteSucceeded:
            error?.remoteSucceeded === true || remotelyChanged.includes(currentTarget),
          error
        })
        .catch(() => {});
    }

    try {
      await store.setPasswordProtection(reportId, {
        enabled: previous.enabled,
        hash: previous.hash
      });
    } catch (rollbackError) {
      // The store rolls a rejected save back in memory, so the requested state
      // remains authoritative. Do not run compensation from state that failed
      // to persist; leave the existing forward-sync journal visible instead.
      throw appError(
        `Password protection could not be rolled back locally after a deployment error. Pagecast kept the requested state and its unfinished sync operations for recovery. (${rollbackError.message || rollbackError}; original error: ${error.message || error})`,
        500
      );
    }

    const compensationFailures = [];
    for (const target of [...remotelyChanged].reverse()) {
      const compensation = {
        type: "password_compensate",
        token: target.publication.token,
        slug: target.publication.slug || target.publication.token,
        projectRef: target.pagesConfig,
        reportId,
        desiredProtected: previous.enabled
      };
      try {
        // Compensation is itself a remote side effect, so its durable intent
        // must exist before the deploy begins.
        await store.beginOperations([compensation]);
      } catch (compensationJournalError) {
        compensationFailures.push({
          target,
          error: compensationJournalError,
          remoteSucceeded: false
        });
        continue;
      }
      try {
        await deployReportTargetState({
          store,
          configStore,
          pagesPublisher,
          deployQueue,
          report: store.get(reportId),
          ...target
        });
        try {
          await store.clearOperations([
            compensation,
            { type: "password_sync", token: target.publication.token }
          ]);
        } catch (cleanupError) {
          // The previous password state is already restored remotely. Preserve
          // that checkpoint so recovery repeats the safe state instead of
          // downgrading a successfully re-protected target.
          if (cleanupError && typeof cleanupError === "object") {
            cleanupError.remoteSucceeded = true;
          }
          throw cleanupError;
        }
      } catch (compensationError) {
        const remoteSucceeded = compensationError?.remoteSucceeded === true;
        compensationFailures.push({
          target,
          error: compensationError,
          remoteSucceeded
        });
        await store
          .recordOperationFailure({
            ...compensation,
            remoteSucceeded,
            error: compensationError
          })
          .catch(() => {});
        if (remoteSucceeded) {
          // The compensating remote state supersedes the original forward-sync
          // intent. Keep only the local-finalization checkpoint when possible.
          await store
            .clearOperation("password_sync", target.publication.token)
            .catch(() => {});
        }
      }
    }

    if (compensationFailures.length === 0) {
      await store.clearOperations(operationEntries);
      throw error;
    }

    if (compensationFailures.every((failure) => failure.remoteSucceeded)) {
      // Every compensating deploy reached Cloudflare, so the persisted previous
      // password state is still truthful. Keep the journal for the unfinished
      // local finalization and retry the same safe state idempotently.
      throw appError(
        `Password protection was restored remotely, but Pagecast could not finish local recovery bookkeeping. The previous protection state remains active; retry the operation journal. (${error.message || error})`,
        502
      );
    }

    // Never claim a report is protected while any target may have lost its
    // gate. Mixed remote state is represented conservatively as unprotected and
    // the durable operation journal names every unfinished reconciliation.
    try {
      await store.setPasswordProtection(reportId, { enabled: false });
    } catch (safetyStateError) {
      throw appError(
        `Password protection is mixed across remote targets, and Pagecast could not persist the conservative unprotected state. Treat the page as potentially unprotected and repair storage before retrying the operation journal. (${safetyStateError.message || safetyStateError}; original error: ${error.message || error})`,
        500
      );
    }
    throw appError(
      `Password protection changed only on some targets and automatic compensation was incomplete. Pagecast now reports the page as unprotected; retry after resolving the operation journal. (${error.message || error})`,
      502
    );
  }
}

async function handleApi(
  req,
  res,
  url,
  {
    store,
    configStore,
    cloudflareAuth,
    pagesPublisher,
    getAdminBaseUrl,
    getCommandBaseUrl,
    getLocalPublicBaseUrl,
    tunnelManager,
    deployQueue,
    mutationQueue,
    watchManager,
    connectionJobs,
    serviceFetch,
    commandCapability
  }
) {
  const options = reportOptions({ getAdminBaseUrl, getLocalPublicBaseUrl });

  function updateConnectionJob(job, status, patch = {}) {
    Object.assign(job, patch, { status, updatedAt: nowIso() });
    connectionJobs.set(job.jobId, job);
  }

  function publicAnalyticsPayload(endpoint, data) {
    if (endpoint === "summary") {
      return {
        ok: data?.ok !== false,
        summaries: (Array.isArray(data?.summaries) ? data.summaries : []).map((item) => ({
          publicationId: String(item?.publicationId || ""),
          views: Math.max(0, Number(item?.views) || 0),
          uniqueVisitors: Math.max(0, Number(item?.uniqueVisitors) || 0),
          lastAccessAt: item?.lastAccessAt ? String(item.lastAccessAt) : null
        }))
      };
    }
    return {
      ok: data?.ok !== false,
      events: (Array.isArray(data?.events) ? data.events : []).map((item) => ({
        eventId: String(item?.eventId || ""),
        publicationId: String(item?.publicationId || ""),
        occurredAt: String(item?.occurredAt || ""),
        visitorId: String(item?.visitorId || ""),
        country: String(item?.country || "XX"),
        region: String(item?.region || ""),
        city: String(item?.city || ""),
        asn: Number.isFinite(Number(item?.asn)) ? Number(item.asn) : null,
        organization: String(item?.organization || ""),
        device: String(item?.device || "desktop"),
        referrerHostname: String(item?.referrerHostname || "direct")
      })),
      nextCursor: String(data?.nextCursor || "")
    };
  }

  async function runConnectionJob(job) {
    try {
      const credential = cloudflareCredentialStatus();
      if (!credential.tokenConfigured) {
        let session = await cloudflareAuth.refreshSession();
        if (!session.loggedIn) {
          updateConnectionJob(job, "awaiting_consent");
          await cloudflareAuth.login(CLOUDFLARE_OAUTH_SCOPES, {
            onProgress: (chunk) => {
              const authorizationUrl = cloudflareAuthorizationUrl(chunk);
              if (authorizationUrl) {
                updateConnectionJob(job, "awaiting_consent", { authorizationUrl });
              }
            }
          });
          session = await cloudflareAuth.refreshSession();
          if (!session.loggedIn) {
            throw appError("Cloudflare sign-in did not complete.", 401);
          }
        }
      }

      updateConnectionJob(job, "discovering_accounts");
      if (job.accountId) {
        await configStore.updatePages({
          projectName: job.projectName,
          accountId: job.accountId
        });
      } else {
        await configStore.updatePages({ projectName: job.projectName });
      }
      updateConnectionJob(job, "creating_home");
      const result = await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
      if (result.cloudflare.needsAccountChoice) {
        updateConnectionJob(job, "discovering_accounts", {
          needsAccountChoice: true,
          accounts: result.cloudflare.accounts || []
        });
        return;
      }
      if (!result.cloudflare.authenticated || !result.cloudflare.selectedProject) {
        throw appError("Cloudflare did not return a publishable Pages project.", 502);
      }
      updateConnectionJob(job, "connected", {
        projectName: result.config.pages.projectName,
        baseUrl: result.config.pages.baseUrl,
        needsAccountChoice: false,
        accounts: []
      });
    } catch (error) {
      updateConnectionJob(job, "failed", {
        error:
          error?.statusCode === 504
            ? "Cloudflare sign-in timed out. Retry when the consent window is ready."
            : "Cloudflare connection did not complete. Review the consent window and try again."
      });
    }
  }

  async function updatePasswordProtection(id, { enabled, password } = {}) {
    return updateReportPasswordProtection({
      store,
      configStore,
      pagesPublisher,
      deployQueue,
      reportId: id,
      enabled: enabled === true,
      password: typeof password === "string" ? password : ""
    });
  }

  async function publishSnapshot(id, body = {}) {
    const sourceReport = store.get(id);
    if (sourceReport?.kind === "folder" && sourceReport.buildCommand) {
      await store.buildReport(id);
    }
    const expiresAt = resolveExpiresAt({
      expires: body.expires,
      defaultExpiry: configStore.get().defaultExpiry
    });
    const draft = store.draftPublication(id, {
      label: body.label,
      kind: "snapshot",
      expiresAt,
      drop: body.drop === true
    });
    if (body.publicationContext && typeof body.publicationContext === "object") {
      Object.assign(draft.publication, {
        contextKey: String(body.publicationContext.contextKey || ""),
        contextHash: String(body.publicationContext.contextHash || ""),
        itemHash: String(body.publicationContext.itemHash || ""),
        workspaceHash: String(body.publicationContext.workspaceHash || "")
      });
    }
    // An expiring or password-protected snapshot needs an edge gate built from
    // committed snapshots. Its `pending` flag keeps it inactive until both the
    // remote deploy and local finalization finish.
    const gated = Boolean(expiresAt) || store.get(id).passwordProtected === true;
    if (gated) {
      await store.commitPublication(id, draft.publication);
    }
    const deployOnce = () => {
      const pagesConfig = configStore.get().pages;
      rememberPublicationPagesTarget(draft.publication, pagesConfig);
      return (gated ? pagesPublisher.syncPublication : pagesPublisher.publish)({
        report: store.get(id),
        publication: draft.publication,
        pagesConfig
      });
    };
    const operation = {
      type: "publish",
      token: draft.publication.token,
      slug: draft.publication.slug || draft.publication.token,
      projectRef: configStore.get().pages,
      reportId: id,
      publication: structuredClone(draft.publication),
      remoteSucceeded: false
    };
    await store.beginOperations([operation]);
    try {
      await deployQueue.enqueue(async () => {
        try {
          draft.publication.publicUrl = await deployOnce();
        } catch (error) {
          if (!isProvisionablePagesError(error)) {
            throw error;
          }
          await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
          draft.publication.publicUrl = await deployOnce();
        }
      });
      await store.beginOperations([
        {
          ...operation,
          projectRef: draft.publication.projectRef || configStore.get().pages,
          publication: structuredClone(draft.publication),
          publicUrl: draft.publication.publicUrl,
          remoteSucceeded: true
        }
      ]);
      await persistActualPublicationOrigin(draft.publication, configStore);
      draft.publication.pending = false;
      if (gated) {
        await store.syncSnapshot(draft.publication.token);
      } else {
        await store.commitPublication(id, draft.publication);
      }
      await store.clearOperation("publish", draft.publication.token);
    } catch (error) {
      await store
        .recordOperationFailure({
          type: "publish",
          token: operation.token,
          slug: operation.slug,
          projectRef: draft.publication.projectRef || configStore.get().pages,
          error
        })
        .catch(() => {});
      throw error;
    }
    return store.findPublication(draft.publication.token);
  }

  if (url.pathname === "/api/command" && req.method === "POST") {
    const body = await readJsonBody(req);
    const payload = body.payload || {};
    const runOwnedMutation = (operation) =>
      mutationQueue ? mutationQueue.enqueue(operation) : operation();
    if (body.command === "goal_status") {
      const readGoal = () => ({ goal: configStore.get().goal });
      const result = mutationQueue
        ? await mutationQueue.enqueue(readGoal)
        : readGoal();
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "telemetry_status") {
      sendJson(res, 200, { configEnabled: configStore.get().telemetry });
      return;
    }
    if (body.command === "register_workspace") {
      const result = await runOwnedMutation(() =>
        registerPagecastWorkspace({
          dataDir: store.dataDir,
          workspaceDataDir: String(payload.workspaceDataDir || ""),
          cwd: String(payload.cwd || "")
        })
      );
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "telemetry_set") {
      if (typeof payload.enabled !== "boolean") {
        throw appError("Telemetry enabled must be a boolean.", 400);
      }
      await runOwnedMutation(() =>
        configStore.setTelemetry(payload.enabled, { notified: true })
      );
      sendJson(res, 200, { configEnabled: configStore.get().telemetry });
      return;
    }
    if (body.command === "pages_setup") {
      const result = await runOwnedMutation(() =>
        setupCloudflarePagesWithContext({
          ...payload,
          configStore,
          cloudflareAuth
        })
      );
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "pages_projects_list") {
      const result = await runOwnedMutation(() =>
        listCloudflarePagesProjectsWithContext({
          accountId: payload.accountId,
          configStore,
          cloudflareAuth
        })
      );
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "pages_deploy_site") {
      const result = await deployQueue.enqueue(() =>
        deployCloudflarePagesSiteWithContext({
          ...payload,
          cloudflareAuth,
          pagesPublisher
        })
      );
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "deployments_list") {
      const result = await deployQueue.enqueue(() =>
        listCloudflarePagesDeploymentsWithContext({
          accountId: payload.accountId,
          configStore,
          cloudflareAuth
        })
      );
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "deployment_delete") {
      const result = await deployQueue.enqueue(() =>
        deleteCloudflarePagesDeploymentWithContext({
          id: payload.id,
          force: payload.force === true,
          accountId: payload.accountId,
          configStore,
          cloudflareAuth
        })
      );
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "deployments_prune") {
      const result = await deployQueue.enqueue(() =>
        pruneCloudflarePagesDeploymentsWithContext({
          keep: payload.keep,
          accountId: payload.accountId,
          configStore,
          cloudflareAuth
        })
      );
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "publish_report") {
      const publishReport = async () => {
        const publishMode = normalizePublishMode({
          mode: payload.mode,
          newLink: payload.newLink === true,
          update: payload.update
        });
        const publicationContext = resolvePublicationContext({
          contextId: payload.contextId,
          workspaceId: payload.workspaceId,
          itemKey: payload.itemKey,
          sourcePath: String(payload.path || ""),
          env: {}
        });
        const existing = store.findPublishMatch({
          ...publishMode,
          contextKey: publicationContext.contextKey
        });
        const report = existing
          ? await store.replaceSourceWithPath(existing.report.id, String(payload.path || ""))
          : await store.addPath(String(payload.path || ""));
        if (typeof payload.password === "string" && payload.password.trim()) {
          await updatePasswordProtection(report.id, {
            enabled: true,
            password: payload.password
          });
        } else if (payload.disableProtection === true) {
          await updatePasswordProtection(report.id, { enabled: false });
        }
        let published;
        if (existing) {
          const publication = existing.publication;
          Object.assign(publication, {
            contextKey: publicationContext.contextKey,
            contextHash: publicationContext.contextHash,
            itemHash: publicationContext.itemHash,
            workspaceHash: publicationContext.workspaceHash
          });
          if (typeof payload.label === "string" && payload.label.trim()) {
            publication.label = payload.label.trim();
          }
          if (payload.expires !== undefined && payload.expires !== "") {
            publication.expiresAt = resolveExpiresAt({
              expires: payload.expires,
              defaultExpiry: configStore.get().defaultExpiry
            });
          }
          published = await syncSnapshotPublication({ report, publication });
        } else {
          published = await publishSnapshot(report.id, {
            label: payload.label,
            expires: payload.expires,
            publicationContext
          });
        }
        return {
          action: existing ? "updated" : "created",
          contextMatched: Boolean(existing && publishMode.mode === "upsert"),
          url: published.publication.publicUrl,
          token: published.publication.token,
          publicationToken: published.publication.token,
          label: published.publication.label,
          projectName: configStore.get().pages.projectName,
          reportId: report.id,
          passwordProtected: published.report.passwordProtected === true,
          linkKind: classifyLinkKind({
            slug: published.publication.slug || published.publication.token,
            drop: published.publication.drop === true,
            passwordProtected: published.report.passwordProtected === true
          }),
          expiresAt: published.publication.expiresAt || null
        };
      };
      const result = mutationQueue
        ? await mutationQueue.enqueue(publishReport)
        : await publishReport();
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "goal_publish") {
      const file = String(body.payload?.file || "").trim();
      if (!file) {
        throw appError("Provide a path to the goal-progress file.", 400);
      }
      const publishGoal = async () => {
        const credential = cloudflareCredentialStatus();
        if (!credential.tokenConfigured && !(await cloudflareAuth.refreshSession()).loggedIn) {
          throw appError(cloudflareAuthRequiredMessage(), 401);
        }
        const target = await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
        if (target.cloudflare.needsAccountChoice) {
          throw appError("Multiple Cloudflare accounts found. Choose one before publishing.", 409);
        }
        return publishGoalWithContext({
          file,
          requestedSlug: body.payload?.slug || "goal",
          dataDir: store.dataDir,
          store,
          configStore,
          pagesPublisher,
          deployQueue
        });
      };
      const result = mutationQueue
        ? await mutationQueue.enqueue(publishGoal)
        : await publishGoal();
      sendJson(res, 200, result);
      return;
    }
    if (body.command === "goal_stop") {
      const stopGoal = async () => {
        const goal = configStore.get().goal;
        const match = goal?.token ? store.findActivePublication(goal.token) : null;
        if (match) {
          const credential = cloudflareCredentialStatus();
          if (!credential.tokenConfigured && !(await cloudflareAuth.refreshSession()).loggedIn) {
            throw appError(cloudflareAuthRequiredMessage(), 401);
          }
        }
        return stopGoalWithContext({
          store,
          configStore,
          pagesPublisher,
          deployQueue
        });
      };
      const result = mutationQueue
        ? await mutationQueue.enqueue(stopGoal)
        : await stopGoal();
      sendJson(res, 200, result);
      return;
    }
    const result = await executeDaemonCommand({
      adminBaseUrl: getCommandBaseUrl(),
      capability: commandCapability,
      command: body.command,
      payload: body.payload
    });
    sendJson(res, 200, result);
    return;
  }

  async function syncSnapshotPublication({ report, publication }) {
    const currentPages = configStore.get().pages;
    let pagesConfig = pagesConfigForPublication(publication, currentPages);
    await store.beginOperations([
      {
        type: "sync",
        token: publication.token,
        slug: publication.slug || publication.token,
        projectRef: pagesConfig,
        reportId: report.id
      }
    ]);
    let remoteSucceeded = false;
    try {
      await deployQueue.enqueue(async () => {
      rememberPublicationPagesTarget(publication, pagesConfig);
      try {
        publication.publicUrl = await pagesPublisher.syncPublication({
          report,
          publication,
          pagesConfig
        });
        remoteSucceeded = true;
        await persistActualPublicationOrigin(publication, configStore);
      } catch (error) {
        const stillCurrentProject =
          pagesConfig.projectName === currentPages.projectName &&
          stripTrailingSlash(pagesConfig.baseUrl) === stripTrailingSlash(currentPages.baseUrl);
        if (!stillCurrentProject || !isProvisionablePagesError(error)) {
          throw error;
        }
        await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
        pagesConfig = pagesConfigForPublication(publication, configStore.get().pages);
        rememberPublicationPagesTarget(publication, pagesConfig);
        publication.publicUrl = await pagesPublisher.syncPublication({
          report,
          publication,
          pagesConfig
        });
        remoteSucceeded = true;
        await persistActualPublicationOrigin(publication, configStore);
      }
      });
      const synced = await store.syncSnapshot(publication.token);
      await store.clearOperation("sync", publication.token);
      return synced;
    } catch (error) {
      if (remoteSucceeded && error && typeof error === "object") {
        error.remoteSucceeded = true;
      }
      await store
        .recordOperationFailure({
          type: "sync",
          token: publication.token,
          slug: publication.slug || publication.token,
          projectRef: pagesConfig,
          error
        })
        .catch(() => {});
      throw error;
    }
  }

  async function revokeSnapshotPublications(publications) {
    let revokedCount = 0;
    for (const publication of publications) {
      if (publication.revokedAt || publication.kind !== "snapshot") {
        continue;
      }
      const slug = publication.slug || publication.token;
      const pagesConfig = pagesConfigForPublication(publication, configStore.get().pages);
      await store.beginOperations([
        {
          type: "revoke",
          token: publication.token,
          slug,
          projectRef: pagesConfig
        }
      ]);
      try {
        await deployQueue.enqueue(() => pagesPublisher.revoke([slug], pagesConfig));
        const committed = await store.commitSuccessfulRevoke(publication.token);
        if (committed.revoked) {
          revokedCount += 1;
        }
      } catch (error) {
        await store.recordOperationFailure({
          type: "revoke",
          token: publication.token,
          slug,
          projectRef: pagesConfig,
          error
        });
        throw error;
      }
    }
    return revokedCount;
  }

  function operationPagesConfig(operation, publication = null) {
    let publicationConfig = null;
    if (publication) {
      publicationConfig = pagesConfigForPublication(
        publication,
        configStore.get().pages
      );
    }
    if (!operation.projectRef) {
      if (publicationConfig) {
        return publicationConfig;
      }
      throw appError("The operation does not identify its Cloudflare Pages target.", 409);
    }

    let operationRef;
    try {
      operationRef = normalizeProjectRef(operation.projectRef);
    } catch (error) {
      throw appError(
        `The operation's Cloudflare Pages target is invalid. (${error.message || error})`,
        409
      );
    }
    if (publicationConfig && !projectRefEquals(operationRef, publicationConfig)) {
      throw appError(
        "The publication target changed after this operation was recorded. Retry the original action manually.",
        409
      );
    }
    return {
      ...(publicationConfig || configStore.get().pages),
      ...operationRef,
      baseUrl: operationRef.baseUrl || publicationConfig?.baseUrl || ""
    };
  }

  function operationPublication(operation, { allowRevoked = false } = {}) {
    const match = allowRevoked
      ? store.findPublication(operation.token)
      : store.findActivePublication(operation.token);
    if (!match) {
      throw appError("The publication for this operation no longer exists.", 409);
    }
    if (match.publication.kind !== "snapshot") {
      throw appError("Only snapshot publications can be recovered automatically.", 409);
    }
    if (operation.reportId && match.report.id !== operation.reportId) {
      throw appError("The operation's publication now belongs to a different page.", 409);
    }
    return match;
  }

  async function retryTargetStateOperation(operation, { clearTypes = [operation.type] } = {}) {
    const match = operationPublication(operation);
    const pagesConfig = operationPagesConfig(operation, match.publication);
    const target = reportDeploymentTargets(
      store,
      match.report,
      configStore.get().pages
    ).find(({ publications }) =>
      publications.some((publication) => publication.token === operation.token)
    );
    await deployReportTargetState({
      store,
      configStore,
      pagesPublisher,
      deployQueue,
      report: match.report,
      publication: match.publication,
      publications: target?.publications || [match.publication],
      pagesConfig
    });
    await store.clearOperations(
      clearTypes.map((type) => ({ type, token: operation.token }))
    );
    return store.findPublication(operation.token);
  }

  async function retryPublishOperation(operation) {
    const report = store.get(operation.reportId);
    if (!report) {
      throw appError("The page for this publish operation no longer exists.", 409);
    }
    const existing = store.findPublication(operation.token);
    if (existing && existing.report.id !== operation.reportId) {
      throw appError("The publication token now belongs to a different page.", 409);
    }
    if (existing?.publication.revokedAt) {
      throw appError("A revoked publication cannot be recovered as a publish.", 409);
    }
    // A crash may happen after the publication commit but before its journal
    // clear. In that case the committed publication is already the source of
    // truth and recovery only needs the atomic journal cleanup.
    if (existing && existing.publication.pending !== true) {
      return store.commitRecoveredPublish(operation.reportId, existing.publication);
    }

    const publication = structuredClone(operation.publication);
    const pagesConfig = operationPagesConfig(operation, existing?.publication || null);
    rememberPublicationPagesTarget(publication, pagesConfig);
    publication.publicUrl = operation.publicUrl || publication.publicUrl || null;

    if (operation.remoteSucceeded !== true) {
      const gated =
        existing?.publication.pending === true ||
        report.passwordProtected === true ||
        (typeof publication.expiresAt === "number" && publication.expiresAt > 0);
      publication.publicUrl = await deployQueue.enqueue(() =>
        (gated ? pagesPublisher.syncPublication : pagesPublisher.publish)({
          report,
          publication,
          pagesConfig
        })
      );
      // Persist the remote-success checkpoint before any local finalization.
      // Retrying after this write must never publish a second link.
      await store.beginOperations([
        {
          ...operation,
          projectRef: publication.projectRef || pagesConfig,
          publication: structuredClone(publication),
          publicUrl: publication.publicUrl,
          remoteSucceeded: true
        }
      ]);
    } else if (!publication.publicUrl) {
      throw appError("The remote publish checkpoint is missing its resulting URL.", 409);
    }

    await persistActualPublicationOrigin(publication, configStore);
    publication.pending = false;
    return store.commitRecoveredPublish(operation.reportId, publication);
  }

  async function retryRenameOperation(operation) {
    const desiredSlug = normalizeCustomSlug(operation.slug);
    const previousSlug = normalizeCustomSlug(operation.previousSlug);
    let match = operationPublication(operation);
    const currentSlug = match.publication.slug || match.publication.token;
    if (currentSlug === previousSlug) {
      await store.renameSlug(operation.token, desiredSlug);
      match = operationPublication(operation);
    } else if (currentSlug !== desiredSlug) {
      throw appError(
        "The publication path changed after this rename was recorded. Retry the rename manually.",
        409
      );
    }

    const pagesConfig = operationPagesConfig(operation, match.publication);
    const canonicalUrl = await deployQueue.enqueue(() =>
      pagesPublisher.renamePublication({
        oldSlug: previousSlug,
        newSlug: desiredSlug,
        report: match.report,
        publication: match.publication,
        pagesConfig
      })
    );
    match.publication.publicUrl = canonicalUrl;
    await persistActualPublicationOrigin(match.publication, configStore);
    await store.syncSnapshot(operation.token);
    await store.clearOperation("rename", operation.token);
    return store.findPublication(operation.token);
  }

  async function retryGoalSyncOperation(operation) {
    const goal = configStore.get().goal;
    if (!goal || goal.token !== operation.token) {
      throw appError("This goal operation is no longer the active goal page.", 409);
    }
    const match = await retryTargetStateOperation(operation, { clearTypes: [] });
    await configStore.setGoal({
      ...goal,
      url: match.publication.publicUrl,
      file: operation.goalFile,
      expiresAt: null,
      updatedAt: nowIso()
    });
    await store.clearOperation("goal_sync", operation.token);
    return match;
  }

  async function retryRevokeOperation(operation) {
    const match = operationPublication(operation, { allowRevoked: true });
    if (match.publication.revokedAt) {
      return store.commitSuccessfulRevoke(operation.token);
    }
    const currentSlug = match.publication.slug || match.publication.token;
    if (currentSlug !== operation.slug) {
      throw appError(
        "The publication path changed after this revoke was recorded. Revoke it from the page menu instead.",
        409
      );
    }
    const pagesConfig = operationPagesConfig(operation, match.publication);
    await deployQueue.enqueue(() => pagesPublisher.revoke([operation.slug], pagesConfig));
    return store.commitSuccessfulRevoke(operation.token);
  }

  async function retryJournalOperation(operation) {
    switch (operation.type) {
      case "publish":
        return retryPublishOperation(operation);
      case "sync":
      case "auto_sync":
      case "content_sync":
        return retryTargetStateOperation(operation);
      case "password_sync":
      case "password_compensate":
        // A partial password transaction deliberately leaves local state at its
        // conservative fallback (currently unprotected). Recovery converges the
        // unfinished target to that current state; it never resumes a stale
        // plaintext password intent and never calls revoke.
        return retryTargetStateOperation(operation, {
          clearTypes: ["password_sync", "password_compensate"]
        });
      case "rename":
        return retryRenameOperation(operation);
      case "goal_sync":
        return retryGoalSyncOperation(operation);
      case "revoke":
        return retryRevokeOperation(operation);
      default:
        throw appError("This operation cannot be retried automatically.", 409);
    }
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    const credential = cloudflareCredentialStatus();
    let session;
    if (credential.tokenConfigured) {
      session = { loggedIn: credential.accountIdConfigured, accounts: [] };
    } else if (!cloudflareAuth.isSessionInitialized()) {
      // First status call after boot: probe Wrangler once so an existing login
      // is detected and the UI shows "connected" without a manual reconnect.
      session = await cloudflareAuth.refreshSession();
    } else {
      session = cloudflareAuth.cachedSession();
    }
    const pages = configStore.get().pages;
    const activeAccount =
      session.accounts.find((account) => account.id === pages.accountId) ||
      session.accounts[0] ||
      null;
    const accountName =
      normalizeAccountName(activeAccount?.name || "") || normalizeAccountName(pages.accountName || "");
    sendJson(res, 200, {
      admin: { ok: true, product: "pagecast", protocolVersion: 1 },
      public: { localBaseUrl: getLocalPublicBaseUrl() },
      home: {
        suggestedProjectName: suggestedPagecastHomeProjectName(configStore),
        projectName: pages.accountId ? pages.projectName : "",
        baseUrl: pages.accountId ? pages.baseUrl : ""
      },
      operations: formatOperationsForApi(store),
      cloudflare: {
        ...credential,
        loggedIn: session.loggedIn,
        accounts: session.accounts,
        accountName,
        accountId: pages.accountId || activeAccount?.id || "",
        projectName: pages.projectName,
        baseUrl: pages.baseUrl,
        ...targetManagementState(configStore, pages)
      },
      config: configStore.getPublicConfig()
    });
    return;
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    sendJson(res, 200, { config: configStore.getPublicConfig() });
    return;
  }

  if (url.pathname === "/api/operations" && req.method === "GET") {
    sendJson(res, 200, { operations: formatOperationsForApi(store) });
    return;
  }

  const operationRetryMatch = /^\/api\/operations\/([^/]+)\/retry$/.exec(url.pathname);
  if (operationRetryMatch && req.method === "POST") {
    await readJsonBody(req);
    const operationId = decodeURIComponent(operationRetryMatch[1]);
    const operation = store.getOperation(operationId);
    if (!operation) {
      throw appError("Operation was not found.", 404);
    }
    const formatted = formatOperationForApi(operation);
    if (formatted.recovery.mode !== "automatic") {
      throw appError(formatted.recovery.manualReason, 409);
    }
    try {
      await retryJournalOperation(operation);
    } catch (error) {
      // Publish can advance its durable remote-success checkpoint during this
      // attempt. Record failure from the latest entry so that checkpoint is not
      // accidentally overwritten with the stale request-time snapshot.
      const latest = store.getOperation(operationId) || operation;
      await store.recordOperationFailure({ ...latest, error }).catch(() => {});
      throw error;
    }
    sendJson(res, 200, {
      recovered: true,
      operationId,
      operations: formatOperationsForApi(store)
    });
    return;
  }

  if (url.pathname === "/api/config/pages" && req.method === "POST") {
    const body = await readJsonBody(req);
    await configStore.updatePages({
      projectName: body.projectName,
      accountId: body.accountId,
      accountName: body.accountName,
      baseUrl: body.baseUrl,
      // Selecting identity and claiming management are separate decisions. Only
      // an explicit true is an adoption signal; omission remains read/configure-only.
      adoptExisting: body.adoptExisting === true
    });
    sendJson(res, 200, { config: configStore.getPublicConfig() });
    return;
  }

  // Toggle the "Published with Pagecast" badge on shared pages (white-label off).
  if (url.pathname === "/api/config/badge" && req.method === "POST") {
    const body = await readJsonBody(req);
    await configStore.setBadge(body.enabled !== false);
    // getPublicConfig (not the setter's full return) so authCookieSecret never
    // reaches the client.
    sendJson(res, 200, { config: configStore.getPublicConfig() });
    return;
  }

  if (url.pathname === "/api/config/expiry" && req.method === "POST") {
    const body = await readJsonBody(req);
    const value = String(body.default ?? body.defaultExpiry ?? "").trim();
    // Fail loud on malformed input (never/empty are allowed = permanent).
    if (value && !/^(never|none|permanent)$/i.test(value)) {
      parseDuration(value);
    }
    await configStore.setDefaultExpiry(value);
    sendJson(res, 200, { config: configStore.getPublicConfig() });
    return;
  }

  if (url.pathname === "/api/config/cloudflare-sync" && req.method === "POST") {
    const body = await readJsonBody(req);
    await configStore.setCloudflareSyncEnabled(body.enabled !== false);
    sendJson(res, 200, { config: configStore.getPublicConfig() });
    return;
  }

  // Provision (or re-provision) the feedback Worker + KV on the user's account.
  // Creates real Cloudflare resources, so it only runs on this explicit action.
  if (url.pathname === "/api/feedback/setup" && req.method === "POST") {
    const body = await readJsonBody(req);
    const pages = configStore.get().pages;
    const accountId = normalizeAccountId(body.accountId || pages.accountId || "");
    const workerPath = path.join(PROJECT_ROOT, "feedback", "worker.js");
    let workerSource;
    let schemaSource;
    try {
      workerSource = await fs.readFile(workerPath, "utf8");
      schemaSource = await fs.readFile(path.join(PROJECT_ROOT, "feedback", "schema.sql"), "utf8");
    } catch {
      sendError(res, appError("Feedback Worker source not found in the package.", 500));
      return;
    }
    const existing = configStore.get().feedback;
    const statsToken = existing?.statsToken || randomBytes(24).toString("hex");
    const visitorSecret = existing?.visitorSecret || randomBytes(32).toString("hex");
    const reactionsEnabled = body.reactions === true;
    const dataDir = path.dirname(configStore.configPath);
    try {
      const result = await cloudflareAuth.setupFeedback({
        accountId,
        workerSource,
        schemaSource,
        statsToken,
        visitorSecret,
        reactionsEnabled,
        deployDir: path.join(dataDir, "feedback-deploy")
      });
      const config = await configStore.updateFeedback({
        ...result,
        analyticsEnabled: true,
        reactionsEnabled
      });
      const migrationPublications = store.list().flatMap((formatted) => {
        const report = store.get(formatted.id);
        return store.activeSnapshotPublications(report).map((publication) => ({
          publicationId: publication.token,
          slug: publication.slug || publication.token
        }));
      });
      let migration = { migrated: 0 };
      try {
        const migrationResponse = await serviceFetch(`${result.url}/api/v1/analytics/migrate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: statsToken, publications: migrationPublications })
        });
        if (migrationResponse.ok) {
          migration = await migrationResponse.json();
        }
      } catch {
        // KV history stays intact and the compatibility stats endpoint remains
        // available; migration can be retried by running setup again.
      }
      const currentPages = configStore.get().pages;
      const instrumentation = await instrumentActiveHomePublications({
        store,
        configStore,
        pagesPublisher,
        deployQueue,
        currentPages
      });
      sendJson(res, 200, { config, feedback: config.feedback, instrumentation, migration });
    } catch (error) {
      sendError(res, error);
    }
    return;
  }

  // Read aggregate stats for a published page back from the feedback Worker.
  // Proxied through the local server so the stats token never reaches the UI.
  if (url.pathname === "/api/feedback/stats" && req.method === "GET") {
    const feedback = configStore.get().feedback;
    if (!feedback?.url) {
      sendJson(res, 200, { ok: true, configured: false, stats: null });
      return;
    }
    const slug = url.searchParams.get("slug") || "";
    const publicationId = url.searchParams.get("publicationId") || "";
    const statsUrl =
      `${feedback.url}/api/v1/stats?slug=${encodeURIComponent(slug)}` +
      `&publicationId=${encodeURIComponent(publicationId || slug)}` +
      `&token=${encodeURIComponent(feedback.statsToken)}`;
    try {
      const response = await serviceFetch(statsUrl);
      const data = await response.json().catch(() => ({}));
      sendJson(res, 200, { ok: response.ok, configured: true, ...data });
    } catch {
      sendError(res, appError("Could not reach the feedback service.", 502));
    }
    return;
  }

  if (
    (url.pathname === "/api/analytics/summary" || url.pathname === "/api/analytics/events") &&
    req.method === "GET"
  ) {
    const feedback = configStore.get().feedback;
    if (!feedback?.url || feedback.analyticsEnabled === false) {
      sendJson(res, 200, url.pathname.endsWith("summary")
        ? { ok: true, configured: false, summaries: [] }
        : { ok: true, configured: false, events: [], nextCursor: "" });
      return;
    }
    const endpoint = url.pathname.endsWith("summary") ? "summary" : "events";
    const params = new URLSearchParams({ token: feedback.statsToken });
    for (const name of ["publicationId", "cursor", "limit"]) {
      if (url.searchParams.has(name)) params.set(name, url.searchParams.get(name) || "");
    }
    try {
      const response = await serviceFetch(`${feedback.url}/api/v1/analytics/${endpoint}?${params}`);
      const data = await response.json().catch(() => ({}));
      sendJson(res, response.ok ? 200 : 502, {
        configured: true,
        ...publicAnalyticsPayload(endpoint, data)
      });
    } catch {
      sendError(res, appError("Could not reach the analytics service.", 502));
    }
    return;
  }

  if (url.pathname === "/api/cloudflare/login" && req.method === "POST") {
    await readJsonBody(req);
    await cloudflareAuth.login();
    sendJson(res, 200, await detectAndPersistCloudflareProjects({ cloudflareAuth, configStore }));
    return;
  }

  if (url.pathname === "/api/cloudflare/connect-jobs" && req.method === "POST") {
    const body = await readJsonBody(req);
    const projectName = normalizePagesProjectName(
      body.projectName || suggestedPagecastHomeProjectName(configStore)
    );
    const accountId = body.accountId ? normalizeAccountId(body.accountId) : "";
    const timestamp = nowIso();
    const job = {
      jobId: randomBytes(16).toString("hex"),
      status: "preparing_wrangler",
      createdAt: timestamp,
      updatedAt: timestamp,
      projectName,
      baseUrl: pagesBaseUrl(projectName),
      accountId,
      authorizationUrl: "",
      needsAccountChoice: false,
      accounts: [],
      error: ""
    };
    connectionJobs.set(job.jobId, job);
    while (connectionJobs.size > 20) {
      connectionJobs.delete(connectionJobs.keys().next().value);
    }
    sendJson(res, 202, publicConnectionJob(job));
    setImmediate(() => {
      const execute = () => runConnectionJob(job);
      const running = mutationQueue ? mutationQueue.enqueue(execute) : execute();
      void running.catch(() => {});
    });
    return;
  }

  const connectJobMatch = /^\/api\/cloudflare\/connect-jobs\/([a-f0-9]{32})$/.exec(
    url.pathname
  );
  if (connectJobMatch && req.method === "GET") {
    const job = connectionJobs.get(connectJobMatch[1]);
    if (!job) {
      throw appError("Cloudflare connection job was not found.", 404);
    }
    sendJson(res, 200, publicConnectionJob(job));
    return;
  }

  if (url.pathname === "/api/cloudflare/projects" && req.method === "POST") {
    await readJsonBody(req);
    sendJson(res, 200, await detectAndPersistCloudflareProjects({ cloudflareAuth, configStore }));
    return;
  }

  // Seamless one-shot: log in only if needed (reusing an existing OAuth session
  // on disk when present), auto-detect the account, auto-create the Pages project
  // when none exists, and return the connected state.
  if (url.pathname === "/api/cloudflare/connect" && req.method === "POST") {
    await readJsonBody(req);
    const credential = cloudflareCredentialStatus();
    if (!credential.tokenConfigured) {
      const session = await cloudflareAuth.refreshSession();
      if (!session.loggedIn) {
        await cloudflareAuth.login();
      }
    }
    sendJson(res, 200, await ensureCloudflarePagesTarget({ cloudflareAuth, configStore }));
    return;
  }

  // Used only when whoami reports multiple accounts: persist the chosen account
  // and finish provisioning. Single-account users never reach this route.
  if (url.pathname === "/api/cloudflare/account" && req.method === "POST") {
    const body = await readJsonBody(req);
    const accountId = normalizeAccountId(body.accountId || "");
    const current = configStore.get();
    const session = cloudflareAuth.cachedSession();
    const account = session.accounts.find((item) => item.id === accountId) || null;
    await configStore.updatePages({
      projectName: current.pages.projectName,
      accountId,
      accountName: normalizeAccountName(account?.name || "")
    });
    sendJson(res, 200, await ensureCloudflarePagesTarget({ cloudflareAuth, configStore }));
    return;
  }

  if (url.pathname === "/api/cloudflare/logout" && req.method === "POST") {
    await readJsonBody(req);
    const credential = cloudflareCredentialStatus();
    if (credential.tokenConfigured) {
      throw appError("Token-based Cloudflare auth is configured through environment variables.", 400);
    }
    await cloudflareAuth.logout();
    const current = configStore.get();
    await configStore.updatePages({
      projectName: current.pages.projectName,
      accountId: "",
      accountName: ""
    });
    sendJson(res, 200, {
      cloudflare: { loggedOut: true },
      config: configStore.getPublicConfig()
    });
    return;
  }

  // List the Cloudflare Pages deployment snapshots for the configured project.
  // Each is a whole-site immutable deploy; the live one is flagged so the client
  // can protect it from deletion.
  if (url.pathname === "/api/deployments" && req.method === "GET") {
    const pages = configStore.get().pages;
    if (!pages.projectName) {
      sendJson(res, 200, { deployments: [], projectName: "", baseUrl: "", configured: false });
      return;
    }
    const credential = cloudflareCredentialStatus();
    if (!credential.tokenConfigured) {
      const session = cloudflareAuth.isSessionInitialized()
        ? cloudflareAuth.cachedSession()
        : await cloudflareAuth.refreshSession();
      if (!session.loggedIn) {
        throw appError(cloudflareAuthRequiredMessage(), 401);
      }
    }
    const deployments = await deployQueue.enqueue(() =>
      cloudflareAuth.listDeployments({ projectName: pages.projectName, accountId: pages.accountId })
    );
    sendJson(res, 200, {
      deployments: flagLiveDeployment(deployments, { baseUrl: pages.baseUrl }),
      projectName: pages.projectName,
      baseUrl: pages.baseUrl,
      configured: true
    });
    return;
  }

  // Delete one deployment snapshot. Refuses the live deployment up front (409)
  // so the user never hits Cloudflare's guaranteed rejection.
  const deploymentMatch = /^\/api\/deployments\/([^/]+)$/.exec(url.pathname);
  if (deploymentMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deploymentMatch[1]);
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
    const pages = configStore.get().pages;
    if (!pages.projectName) {
      throw appError("No Cloudflare Pages project is configured.", 400);
    }
    await deployQueue.enqueue(async () => {
      const current = flagLiveDeployment(
        await cloudflareAuth.listDeployments({ projectName: pages.projectName, accountId: pages.accountId }),
        { baseUrl: pages.baseUrl }
      );
      const target = current.find((deployment) => deployment.id === id);
      if (target?.isLive) {
        throw appError("This is the live deployment and can't be deleted. Publish a newer one first.", 409);
      }
      await cloudflareAuth.deleteDeployment({
        id,
        projectName: pages.projectName,
        accountId: pages.accountId,
        force,
        environment: target?.environment || ""
      });
    });
    sendJson(res, 200, { deleted: true, id });
    return;
  }

  // Prune old snapshots: keep the N newest (incl. live), delete the rest
  // oldest-first, serially. Reports partial success rather than failing the batch.
  if (url.pathname === "/api/deployments/prune" && req.method === "POST") {
    const body = await readJsonBody(req);
    const keep = Number(body.keep);
    if (!Number.isInteger(keep) || keep < 1) {
      throw appError("`keep` must be an integer of at least 1.", 400);
    }
    const pages = configStore.get().pages;
    if (!pages.projectName) {
      throw appError("No Cloudflare Pages project is configured.", 400);
    }
    const summary = await deployQueue.enqueue(async () => {
      const flagged = flagLiveDeployment(
        await cloudflareAuth.listDeployments({ projectName: pages.projectName, accountId: pages.accountId }),
        { baseUrl: pages.baseUrl }
      );
      const toDelete = selectDeploymentsToPrune(flagged, keep);
      const deleted = [];
      const failed = [];
      for (const deployment of toDelete) {
        try {
          await cloudflareAuth.deleteDeployment({
            id: deployment.id,
            projectName: pages.projectName,
            accountId: pages.accountId,
            force: deployment.environment !== "production",
            environment: deployment.environment
          });
          deleted.push(deployment.id);
        } catch (error) {
          failed.push({ id: deployment.id, error: error.message });
        }
      }
      return { deleted, failed };
    });
    sendJson(res, 200, {
      pruned: summary.deleted.length,
      kept: keep,
      deleted: summary.deleted,
      failed: summary.failed
    });
    return;
  }

  if (url.pathname === "/api/cloudflare/sync" && req.method === "POST") {
    await readJsonBody(req);
    const pages = configStore.get().pages;
    if (!pages.projectName || !pages.baseUrl) {
      throw appError("No Cloudflare Pages project is configured.", 400);
    }
    const { discovery, result } = await deployQueue.enqueue(async () => {
      const currentConfig = configStore.get();
      const discovery = await pagesPublisher.discoverPublishedPages({
        pagesConfig: pages,
        syncToken: currentConfig.syncSecret || ""
      });
      const result = await store.importPublishedPages(discovery.publications, {
        ...options,
        pagesBaseUrl: pages.baseUrl,
        pagesConfig: pages,
        fetchImpl: pagesPublisher.fetchImpl
      });
      return { discovery, result };
    });
    sendJson(res, 200, {
      imported: result.imported,
      importedCount: result.imported.length,
      skipped: result.skipped,
      skippedCount: result.skipped.length,
      failed: result.failed,
      warnings: discovery.warnings,
      remoteManifestFound: discovery.remoteManifestFound,
      reports: store.list(options)
    });
    return;
  }

  if (url.pathname === "/api/reports" && req.method === "GET") {
    sendJson(res, 200, { reports: store.list(options) });
    return;
  }

  if (url.pathname === "/api/reports/path" && req.method === "POST") {
    const body = await readJsonBody(req);
    const report = await store.addPath(body.path);
    sendJson(res, 201, { report: store.formatReport(report, options) });
    return;
  }

  if (url.pathname === "/api/reports/folder" && req.method === "POST") {
    const body = await readJsonBody(req);
    const report = await store.addFolder({
      folderPath: body.path,
      entryFile: body.entryFile,
      buildCommand: body.buildCommand,
      buildOutputDir: body.buildOutputDir,
      name: body.name
    });
    sendJson(res, 201, { report: store.formatReport(report, options) });
    return;
  }

  if (url.pathname === "/api/reports/upload" && req.method === "POST") {
    const body = await readRequestBody(req);
    const upload = parseMultipartUpload(body, req.headers["content-type"]);
    const report = await store.addUpload(upload);
    sendJson(res, 201, { report: store.formatReport(report, options) });
    return;
  }

  if (url.pathname === "/api/reports/folder-upload" && req.method === "POST") {
    const body = await readRequestBody(req, MAX_FOLDER_UPLOAD_BYTES);
    const files = parseMultipartFiles(body, req.headers["content-type"]);
    const report = await store.addFolderUpload({ files });
    sendJson(res, 201, { report: store.formatReport(report, options) });
    return;
  }

  const buildMatch = /^\/api\/reports\/([^/]+)\/build$/.exec(url.pathname);
  if (buildMatch && req.method === "POST") {
    await readJsonBody(req);
    const report = await store.buildReport(decodeURIComponent(buildMatch[1]));
    sendJson(res, 200, { report: store.formatReport(report, options) });
    return;
  }

  const publishMatch = /^\/api\/reports\/([^/]+)\/publish$/.exec(url.pathname);
  if (publishMatch && req.method === "POST") {
    await readJsonBody(req);
    sendJson(res, 410, {
      error: {
        message: "Local live publishing has been removed. Use Cloudflare Pages snapshots.",
        statusCode: 410
      }
    });
    return;
  }

  const snapshotPublishMatch = /^\/api\/reports\/([^/]+)\/publish-snapshot$/.exec(url.pathname);
  if (snapshotPublishMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const id = decodeURIComponent(snapshotPublishMatch[1]);
    const fresh = await publishSnapshot(id, body);
    sendJson(res, 201, {
      report: store.formatReport(fresh.report, options),
      publication: store.formatPublication(fresh.publication, {
        ...options,
        passwordProtected: fresh.report.passwordProtected === true
      })
    });
    return;
  }

  // One-shot "publish this local file and return the URL" for the Chrome
  // extension. Re-publishing the same file UPDATES the same link in place.
  if (url.pathname === "/api/publish-local" && req.method === "POST") {
    const body = await readJsonBody(req);
    const report = await store.addPath(typeof body.path === "string" ? body.path : "");

    // Reuse the latest active snapshot link if one exists (same URL), else publish
    // new. The stored publication is "active" when it has no revokedAt.
    const fresh = store.get(report.id);
    const latest = [...(fresh?.publications || [])]
      .reverse()
      .find((p) => !p.revokedAt && p.kind === "snapshot");

    let publication;
    if (latest) {
      const match = store.findActivePublication(latest.token);
      publication = (await syncSnapshotPublication(match)).publication;
    } else {
      publication = (await publishSnapshot(report.id, { expires: body.expires })).publication;
    }

    const formatted = store.formatPublication(publication, {
      ...options,
      passwordProtected: store.get(report.id)?.passwordProtected === true
    });
    sendJson(res, 201, {
      ok: true,
      url: formatted.publicUrl,
      slug: formatted.slug,
      localUrl: formatted.localUrl,
      updated: Boolean(latest),
      publication: formatted
    });
    return;
  }

  const targetAdoptionMatch = /^\/api\/publications\/([^/]+)\/target$/.exec(url.pathname);
  if (targetAdoptionMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.confirm !== true) {
      throw appError("Set `confirm: true` to attach this legacy link to the selected project.", 400);
    }
    const token = decodeURIComponent(targetAdoptionMatch[1]);
    if (!store.findPublication(token)) {
      throw appError("Published link was not found.", 404);
    }
    const current = configStore.get().pages;
    const selectedAccountId = body.accountId || current.accountId;
    const selectedProjectName = body.projectName || current.projectName;
    const changesIdentity =
      selectedAccountId !== current.accountId || selectedProjectName !== current.projectName;
    if (changesIdentity && !body.baseUrl) {
      throw appError(
        "A production baseUrl from the selected Cloudflare project is required when adopting a different account or project.",
        400
      );
    }
    let pagesConfig;
    try {
      pagesConfig = normalizeProjectRef({
        accountId: selectedAccountId,
        projectName: selectedProjectName,
        baseUrl: body.baseUrl || current.baseUrl
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw appError(error.message, 400);
      }
      throw error;
    }
    const adopted = await store.adoptPublicationTarget(token, pagesConfig);
    await configStore.claimManagedTarget(pagesConfig);
    await pagesPublisher.migrateLegacyStaging({ publications: [adopted.publication] });
    sendJson(res, 200, {
      report: store.formatReport(adopted.report, options),
      publication: store.formatPublication(adopted.publication, {
        ...options,
        passwordProtected: adopted.report.passwordProtected === true
      }),
      projectRef: pagesConfig
    });
    return;
  }

  const snapshotSyncMatch = /^\/api\/publications\/([^/]+)\/sync$/.exec(url.pathname);
  if (snapshotSyncMatch && req.method === "POST") {
    const token = decodeURIComponent(snapshotSyncMatch[1]);
    const existing = store.findActivePublication(token);
    if (!existing) {
      throw appError("Published link was not found.", 404);
    }
    if (existing.publication.kind !== "snapshot") {
      throw appError("Only snapshot publications can be synced.", 400);
    }
    if (existing.report.kind === "folder" && existing.report.buildCommand) {
      await store.buildReport(existing.report.id);
    }
    const { report, publication } = await syncSnapshotPublication(existing);
    sendJson(res, 200, {
      report: store.formatReport(report, options),
      publication: store.formatPublication(publication, {
        ...options,
        passwordProtected: report.passwordProtected === true
      })
    });
    return;
  }

  const expiryMatch = /^\/api\/publications\/([^/]+)\/expiry$/.exec(url.pathname);
  if (expiryMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const token = decodeURIComponent(expiryMatch[1]);
    const existing = store.findActivePublication(token);
    if (!existing) {
      throw appError("Published link was not found.", 404);
    }
    if (existing.publication.kind !== "snapshot") {
      throw appError("Only snapshot publications can expire.", 400);
    }
    const expiresAt = resolveExpiresAt({ expires: body.expires, defaultExpiry: configStore.get().defaultExpiry });
    // Capture the prior expiry BEFORE the store mutates the record in place, so a
    // failed redeploy can roll it back (stored state must never claim an expiry
    // the live edge isn't enforcing — mirrors the password-protection rollback).
    const previousExpiresAt =
      typeof existing.publication.expiresAt === "number" && existing.publication.expiresAt > 0
        ? existing.publication.expiresAt
        : null;
    await store.setPublicationExpiry(token, expiresAt);
    // Redeploy so the edge middleware manifest reflects the new expiry.
    try {
      await syncSnapshotPublication(existing);
    } catch (error) {
      if (!error?.remoteSucceeded) {
        await store.setPublicationExpiry(token, previousExpiresAt).catch(() => {});
      }
      throw error;
    }
    const refreshed = store.findPublication(token);
    sendJson(res, 200, {
      report: store.formatReport(refreshed.report, options),
      publication: store.formatPublication(refreshed.publication, {
        ...options,
        passwordProtected: refreshed.report.passwordProtected === true
      })
    });
    return;
  }

  const slugRenameMatch = /^\/api\/publications\/([^/]+)\/slug$/.exec(url.pathname);
  if (slugRenameMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    const token = decodeURIComponent(slugRenameMatch[1]);
    const existing = store.findActivePublication(token);
    if (!existing) {
      throw appError("Published link was not found.", 404);
    }
    const previous = {
      slug: existing.publication.slug || existing.publication.token,
      drop: existing.publication.drop === true,
      publicUrl: existing.publication.publicUrl,
      publicationUpdatedAt: existing.publication.updatedAt,
      reportUpdatedAt: existing.report.updatedAt,
      redirects: store.listRedirects()
    };
    // Validate + reserve the slug (throws 400/409) before any deploy work.
    const { oldSlug, newSlug } = await store.renameSlug(token, body.slug);
    let remoteSucceeded = false;
    let renamePagesConfig = null;
    try {
      if (oldSlug !== newSlug && existing.publication.kind === "snapshot") {
        const pagesConfig = pagesConfigForPublication(existing.publication, configStore.get().pages);
        renamePagesConfig = pagesConfig;
        await store.beginOperations([
          {
            type: "rename",
            token,
            slug: newSlug,
            projectRef: pagesConfig,
            previousSlug: oldSlug
          }
        ]);
        const canonicalUrl = await deployQueue.enqueue(() => {
          rememberPublicationPagesTarget(existing.publication, pagesConfig);
          return pagesPublisher.renamePublication({
            oldSlug,
            newSlug,
            report: existing.report,
            publication: existing.publication,
            pagesConfig
          });
        });
        remoteSucceeded = true;
        existing.publication.publicUrl = canonicalUrl;
        await persistActualPublicationOrigin(existing.publication, configStore);
        await store.syncSnapshot(token);
        await store.clearOperation("rename", token);
      }
    } catch (error) {
      if (renamePagesConfig) {
        await store
          .recordOperationFailure({
            type: "rename",
            token,
            slug: newSlug,
            projectRef: renamePagesConfig,
            error
          })
          .catch(() => {});
      }
      if (!remoteSucceeded) {
        await store.restorePublicationSlug(token, previous).catch(() => {});
      }
      throw error;
    }
    const refreshed = store.findPublication(token);
    sendJson(res, 200, {
      report: store.formatReport(refreshed.report, options),
      publication: store.formatPublication(refreshed.publication, {
        ...options,
        passwordProtected: refreshed.report.passwordProtected === true
      })
    });
    return;
  }

  const revokeAllMatch = /^\/api\/reports\/([^/]+)\/revoke-all$/.exec(url.pathname);
  if (revokeAllMatch && req.method === "POST") {
    const id = decodeURIComponent(revokeAllMatch[1]);
    const reportBeforeRevoke = store.get(id);
    if (!reportBeforeRevoke) {
      throw appError("Report was not found.", 404);
    }
    const snapshotRevokedCount = await revokeSnapshotPublications(
      reportBeforeRevoke.publications || []
    );
    const { report, revokedCount: locallyRevokedCount } = await store.revokeAll(id);
    sendJson(res, 200, {
      revokedCount: snapshotRevokedCount + locallyRevokedCount,
      report: store.formatReport(report, options)
    });
    return;
  }

  const deleteMatch = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
  if (deleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteMatch[1]);
    const reportBeforeDelete = store.get(id);
    if (reportBeforeDelete) {
      await revokeSnapshotPublications(reportBeforeDelete.publications || []);
    }
    const removed = await store.remove(id);
    if (removed && watchManager) {
      watchManager.unregister(id);
    }
    const pendingDeletion = removed
      ? store.listPendingDeletions().find((entry) => entry.reportId === id)
      : null;
    sendJson(res, removed ? 200 : 404, {
      removed,
      cleanupPending: Boolean(pendingDeletion),
      cleanupError: pendingDeletion?.error || null
    });
    return;
  }

  const revokePublicationMatch = /^\/api\/publications\/([^/]+)\/revoke$/.exec(url.pathname);
  if (revokePublicationMatch && req.method === "POST") {
    const token = decodeURIComponent(revokePublicationMatch[1]);
    const existing = store.findPublication(token);
    if (!existing) {
      throw appError("Published link was not found.", 404);
    }
    if (!existing.publication.revokedAt && existing.publication.kind === "snapshot") {
      await revokeSnapshotPublications([existing.publication]);
    } else if (existing.publication.revokedAt) {
      // A prior remote success may have committed revokedAt before a later local
      // cleanup failed. Retrying must still clear any durable revoke journal.
      await store.commitSuccessfulRevoke(token);
    } else {
      await store.revokePublication(token);
    }
    const { report, publication } = store.findPublication(token);
    sendJson(res, 200, {
      report: store.formatReport(report, options),
      publication: store.formatPublication(publication, {
        ...options,
        passwordProtected: report.passwordProtected === true
      })
    });
    return;
  }

  if (url.pathname === "/api/reports/reorder" && req.method === "POST") {
    const body = await readJsonBody(req);
    await store.reorder(body.ids);
    sendJson(res, 200, { reports: store.list(options) });
    return;
  }

  const contentMatch = /^\/api\/reports\/([^/]+)\/content$/.exec(url.pathname);
  if (contentMatch && req.method === "GET") {
    const id = decodeURIComponent(contentMatch[1]);
    const { html } = await store.readContent(id);
    sendJson(res, 200, { html });
    return;
  }

  if (contentMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    const id = decodeURIComponent(contentMatch[1]);
    const before = store.get(id);
    if (!before) {
      throw appError("Report was not found.", 404);
    }
    const targets = reportDeploymentTargets(store, before, configStore.get().pages);
    const operationsForEdit = targets.map(({ publication, pagesConfig }) => ({
      type: "content_sync",
      token: publication.token,
      slug: publication.slug || publication.token,
      projectRef: pagesConfig,
      reportId: id
    }));
    if (operationsForEdit.length > 0) {
      await store.beginOperations(operationsForEdit);
    }
    try {
      await store.writeContent(id, body.html);
    } catch (error) {
      await store.clearOperations(operationsForEdit).catch(() => {});
      throw error;
    }
    // Local content is the durable desired state. Each target has a write-ahead
    // journal entry before the first remote side effect; a partial failure stays
    // visible and is idempotently retried by saving again.
    for (const target of targets) {
      try {
        await deployReportTargetState({
          store,
          configStore,
          pagesPublisher,
          deployQueue,
          report: store.get(id),
          ...target
        });
        await store.clearOperation("content_sync", target.publication.token);
      } catch (error) {
        await store
          .recordOperationFailure({
            type: "content_sync",
            token: target.publication.token,
            slug: target.publication.slug || target.publication.token,
            projectRef: target.pagesConfig,
            error
          })
          .catch(() => {});
        throw appError(
          `Content was saved locally, but one or more publication targets still need to sync. Retry Save after resolving the operation journal. (${error.message || error})`,
          error.statusCode || 502
        );
      }
    }
    sendJson(res, 200, { report: store.formatReport(store.get(id), options) });
    return;
  }

  const autoSyncMatch = /^\/api\/reports\/([^/]+)\/auto-sync$/.exec(url.pathname);
  if (autoSyncMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const id = decodeURIComponent(autoSyncMatch[1]);
    const report = await store.setAutoSync(id, body.enabled === true);
    if (watchManager) {
      if (report.autoSync) {
        watchManager.register(id);
      } else {
        watchManager.unregister(id);
      }
    }
    sendJson(res, 200, { report: store.formatReport(report, options) });
    return;
  }

  const passwordMatch = /^\/api\/reports\/([^/]+)\/password-protection$/.exec(url.pathname);
  if (passwordMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const id = decodeURIComponent(passwordMatch[1]);
    const report = await updatePasswordProtection(id, {
      enabled: body.enabled === true,
      password: typeof body.password === "string" ? body.password : ""
    });
    sendJson(res, 200, { report: store.formatReport(report, options) });
    return;
  }

  if (url.pathname.startsWith("/api/tunnel/")) {
    sendJson(res, 410, {
      error: {
        message: "Live tunnel publishing has been removed. Use Cloudflare Pages publishing.",
        statusCode: 410
      }
    });
    return;
  }

  sendJson(res, 404, {
    error: {
      message: "API route was not found.",
      statusCode: 404
    }
  });
}

function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function closeListeningServers(servers, closeImpl = closeServer) {
  const unique = [...new Set(servers.filter((server) => server?.listening))];
  const results = await Promise.allSettled(unique.map((server) => closeImpl(server)));
  return results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
}

function isPortInUse(error) {
  return error && error.code === "EADDRINUSE";
}

function localPortCandidates(adminPort, publicPort) {
  const candidates = [[adminPort, publicPort]];
  for (let admin = DEFAULT_ADMIN_PORT; admin <= DEFAULT_ADMIN_PORT + 18; admin += 2) {
    const pair = [admin, admin + 1];
    if (!candidates.some(([a, p]) => a === pair[0] && p === pair[1])) {
      candidates.push(pair);
    }
  }
  return candidates;
}

export async function startServers({
  host = process.env.HOST || DEFAULT_HOST,
  allowLoopbackProxy = process.env.PAGECAST_ALLOW_LOOPBACK_PROXY === "1",
  adminPort,
  publicPort,
  displayHost,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  staticDir = path.join(PROJECT_ROOT, "public"),
  spawnImpl = spawn,
  tunnelTimeoutMs = 30000,
  fetchImpl = fetch,
  cloudflareAuthSpawnImpl = spawn,
  cloudflareLoginTimeoutMs = DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  pagesDeploySpawnImpl = spawn,
  pagesDeployTimeoutMs = 180000,
  serverFactory = createServer,
  serverCloseImpl = closeServer
} = {}) {
  assertSafeAdminBind(host, { allowLoopbackProxy });
  const commandCapability = randomBytes(32).toString("base64url");
  const workspaceLease = new WorkspaceLease(dataDir);
  await workspaceLease.acquire({ capability: commandCapability, role: "daemon" });
  let activePublicServer = null;
  let activeAdminServer = null;
  let activeTunnelManager = null;
  let activeWatchManager = null;
  let activeDeployQueue = null;
  let activeMutationQueue = null;
  try {
    const store = createReportStore({ dataDir, recoverFetchImpl: fetchImpl });
    await store.init();
    const configStore = createConfigStore({ dataDir });
    await configStore.init();
  for (const projectRef of store.listProjectRefs()) {
    await configStore.claimManagedTarget(projectRef);
  }
  const localConfig = configStore.get().local;
  const explicitAdminPort = adminPort !== undefined || process.env.PORT;
  const explicitPublicPort = publicPort !== undefined || process.env.PUBLIC_PORT;
  const resolvedAdminPort = normalizeRuntimePort(
    adminPort !== undefined ? adminPort : process.env.PORT || localConfig.adminPort,
    DEFAULT_ADMIN_PORT
  );
  const resolvedPublicPort = normalizeRuntimePort(
    publicPort !== undefined ? publicPort : process.env.PUBLIC_PORT || localConfig.publicPort,
    DEFAULT_PUBLIC_PORT
  );
  const fallbackAllowed = !explicitAdminPort && !explicitPublicPort;
  const displayHostname = normalizeLocalHostname(displayHost || localConfig.hostname);
  const cloudflareAuth = createCloudflareAuthManager({
    spawnImpl: cloudflareAuthSpawnImpl,
    loginTimeoutMs: cloudflareLoginTimeoutMs,
    listTimeoutMs: cloudflareListTimeoutMs
  });
  const pagesPublisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: pagesDeploySpawnImpl,
    fetchImpl,
    timeoutMs: pagesDeployTimeoutMs,
    getRedirects: (pagesConfig) => store.listRedirects(pagesConfig),
    getFeedback: () => configStore.get().feedback,
    getBadge: () => configStore.get().badge,
    getProtectedPublications: (pagesConfig) => store.protectedPublicationManifest(pagesConfig),
    getPublications: (pagesConfig) => store.listPublications(pagesConfig),
    getAuthCookieSecret: () => configStore.get().authCookieSecret,
    getSyncToken: () => configStore.get().syncSecret,
    getOwnerId: () => configStore.getOwnerId(),
    isTargetManaged: (projectRef) => configStore.isTargetManaged(projectRef),
    claimTargetManaged: (projectRef) => configStore.claimManagedTarget(projectRef)
  });
  await pagesPublisher.migrateLegacyStaging({
    publications: store.listPublications(),
    redirects: store.listRedirects()
  });
  const deployQueue = createDeployQueue();
  const mutationQueue = createDeployQueue();
  activeDeployQueue = deployQueue;
  activeMutationQueue = mutationQueue;
  const watchManager = createWatchManager({
    store,
    pagesPublisher,
    configStore,
    deployQueue,
    mutationQueue,
    // Auto-sync runs in the background; surface failures (e.g. expired Cloudflare
    // auth) instead of swallowing them, so a silently-broken watch is visible.
    onError: (error) => {
      console.warn(`Pagecast auto-sync failed: ${error?.message || error}`);
    }
  });
  activeWatchManager = watchManager;
  for (const report of store.listAutoSyncReports()) {
    watchManager.register(report.id);
  }

  // `host` may be a wildcard bind address (0.0.0.0 / ::) — correct for listen(),
  // but invalid as a hostname in client-facing URLs (browsers, incl. Chrome
  // 128+, refuse to connect to 0.0.0.0). Map wildcard binds to a loopback host
  // for the URLs we hand back to the admin UI and terminal, and for the admin
  // host-header allowlist (so a wildcard bind doesn't make `Host: 0.0.0.0`
  // trusted). `urlHost` stays unbracketed for the allowlist comparison;
  // `hostForUrl` brackets IPv6 literals (e.g. ::1) so URLs stay well-formed:
  // http://[::1]:4173, not http://::1:4173.
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  // Keep an explicit IPv6 loopback bind as [::1]. Replacing it with a friendly
  // alias can resolve back to IPv4 and miss an IPv6-only listener.
  const externalUrlHost = urlHost === "127.0.0.1" ? displayHostname : urlHost;
  const internalHostForUrl = urlHost.includes(":") ? `[${urlHost}]` : urlHost;
  const displayHostForUrl = externalUrlHost.includes(":")
    ? `[${externalUrlHost}]`
    : externalUrlHost;

  let lastPortError = null;
  for (const [candidateAdminPort, candidatePublicPort] of localPortCandidates(resolvedAdminPort, resolvedPublicPort)) {
    const publicServer = serverFactory(createPublicHandler({ store }));
    let actualPublicPort = candidatePublicPort;
    try {
      await listen(publicServer, { host, port: candidatePublicPort });
      activePublicServer = publicServer;
      actualPublicPort = publicServer.address().port;
    } catch (error) {
      await serverCloseImpl(publicServer).catch(() => {});
      activePublicServer = null;
      if (fallbackAllowed && isPortInUse(error)) {
        lastPortError = error;
        continue;
      }
      throw error;
    }

    const internalPublicUrl = `http://${internalHostForUrl}:${actualPublicPort}`;
    const displayPublicUrl = `http://${displayHostForUrl}:${actualPublicPort}`;
    let adminBaseUrl = null;
    let commandBaseUrl = null;
    const tunnelManager = new TunnelManager({
      localUrl: internalPublicUrl,
      spawnImpl,
      timeoutMs: tunnelTimeoutMs
    });
    activeTunnelManager = tunnelManager;

    const adminServer = serverFactory(
      createAdminHandler({
        store,
        configStore,
        cloudflareAuth,
        pagesPublisher,
        staticDir,
        getAdminBaseUrl: () => adminBaseUrl,
        getCommandBaseUrl: () => commandBaseUrl,
        getLocalPublicBaseUrl: () => displayPublicUrl,
        tunnelManager,
        deployQueue,
        mutationQueue,
        watchManager,
        serviceFetch: fetchImpl,
        commandCapability,
        bindHost: urlHost,
        allowedHosts: [displayHostname]
      })
    );

    try {
      await listen(adminServer, { host, port: candidateAdminPort });
      activeAdminServer = adminServer;
    } catch (error) {
      try {
        await serverCloseImpl(publicServer);
      } catch (closeError) {
        // Keep the listener registered for outer cleanup and retain the
        // workspace lease if that cleanup also fails. Continuing to another
        // port pair here would leave two public listeners and an unowned writer.
        throw new AggregateError(
          [error, closeError],
          "The admin port was unavailable and the public listener could not be closed."
        );
      }
      activePublicServer = null;
      activeTunnelManager = null;
      if (fallbackAllowed && isPortInUse(error)) {
        lastPortError = error;
        continue;
      }
      throw error;
    }

    const actualAdminPort = adminServer.address().port;
    const adminUrl = `http://${internalHostForUrl}:${actualAdminPort}`;
    const displayAdminUrl = `http://${displayHostForUrl}:${actualAdminPort}`;
    adminBaseUrl = displayAdminUrl;
    commandBaseUrl = adminUrl;
    // Node clients and one-shot adapters must never depend on a friendly alias
    // being present in the host resolver (pagecast.localhost is not resolved by
    // Node on every supported OS). The runtime descriptor is machine transport,
    // while displayAdminUrl is the browser-facing address.
    await workspaceLease.updateRuntime({ adminUrl });
    if (fallbackAllowed) {
      await configStore.setLocalRuntime({
        hostname: displayHostname,
        adminPort: actualAdminPort,
        publicPort: actualPublicPort
      });
    }

    let closePromise = null;
    return {
      adminServer,
      publicServer,
      store,
      configStore,
      cloudflareAuth,
      pagesPublisher,
      tunnelManager,
      deployQueue,
      mutationQueue,
      watchManager,
      commandCapability,
      workspaceLease,
      adminUrl,
      publicUrl: internalPublicUrl,
      displayAdminUrl,
      displayPublicUrl,
      close() {
        closePromise ||= (async () => {
          const errors = [];
          try {
            watchManager.closeAll();
          } catch (error) {
            errors.push(error);
          }
          const closingServers = closeListeningServers(
            [adminServer, publicServer],
            serverCloseImpl
          );
          try {
            await tunnelManager.stop();
          } catch (error) {
            errors.push(error);
          }
          const serverErrors = await closingServers;
          errors.push(...serverErrors);
          await mutationQueue.drain();
          await deployQueue.drain();
          if (serverErrors.length === 0) {
            activeAdminServer = null;
            activePublicServer = null;
            activeTunnelManager = null;
            activeWatchManager = null;
            activeDeployQueue = null;
            activeMutationQueue = null;
            try {
              await workspaceLease.release();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, "Pagecast did not shut down cleanly.");
          }
        })();
        return closePromise;
      }
    };
  }

    throw lastPortError || appError("Could not find an available local Pagecast port.", 500);
  } catch (error) {
    const cleanupErrors = [];
    try {
      activeWatchManager?.closeAll();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await activeTunnelManager?.stop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    const serverErrors = await closeListeningServers(
      [activeAdminServer, activePublicServer],
      serverCloseImpl
    );
    cleanupErrors.push(...serverErrors);
    await activeMutationQueue?.drain();
    await activeDeployQueue?.drain();
    if (serverErrors.length === 0) {
      await workspaceLease.release().catch((cleanupError) => cleanupErrors.push(cleanupError));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Pagecast startup failed and cleanup was incomplete."
      );
    }
    throw error;
  }
}

async function createHeadlessCloudflareContext({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  store = null,
  fetchImpl = fetch,
  cloudflareAuthSpawnImpl = spawn,
  pagesDeploySpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  pagesDeployTimeoutMs = 180000
} = {}) {
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  if (store) {
    for (const projectRef of store.listProjectRefs()) {
      await configStore.claimManagedTarget(projectRef);
    }
  }
  const cloudflareAuth = createCloudflareAuthManager({
    spawnImpl: cloudflareAuthSpawnImpl,
    listTimeoutMs: cloudflareListTimeoutMs
  });
  const pagesPublisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: pagesDeploySpawnImpl,
    fetchImpl,
    timeoutMs: pagesDeployTimeoutMs,
    // Headless/CLI publishes (incl. the agent skill's `npx pagecast publish`)
    // must inject the feedback widget too, not just the running app.
    getFeedback: () => configStore.get().feedback,
    getBadge: () => configStore.get().badge,
    // A store is passed whenever the caller deploys the /p/ site, so a headless
    // re-deploy regenerates (rather than wipes) the edge gate for protected
    // reports. Site-only deploys (deploySite) pass none and never touch it.
    getRedirects: store ? (pagesConfig) => store.listRedirects(pagesConfig) : () => [],
    getProtectedPublications: store
      ? (pagesConfig) => store.protectedPublicationManifest(pagesConfig)
      : () => [],
    getPublications: store ? (pagesConfig) => store.listPublications(pagesConfig) : () => [],
    getAuthCookieSecret: () => configStore.get().authCookieSecret,
    getSyncToken: () => configStore.get().syncSecret,
    getOwnerId: () => configStore.getOwnerId(),
    isTargetManaged: (projectRef) => configStore.isTargetManaged(projectRef),
    claimTargetManaged: (projectRef) => configStore.claimManagedTarget(projectRef)
  });
  return { configStore, cloudflareAuth, pagesPublisher };
}

async function runCoordinatedHeadlessOperation(
  {
    dataDir,
    routeToDaemon = true,
    command = "",
    payload = {},
    commandFetchImpl = fetch
  },
  operation
) {
  if (routeToDaemon !== false && command) {
    const routed = await tryInvokeLiveCommand(dataDir, command, payload, {
      fetchImpl: commandFetchImpl
    });
    if (routed !== null) {
      return routed;
    }
  }

  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: randomBytes(32).toString("base64url") });
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

async function applyPagesSelection({ configStore, projectName, accountId, accountName, baseUrl }) {
  const current = configStore.get();
  const selectedProjectName = projectName ? normalizePagesProjectName(projectName) : current.pages.projectName;
  const selectedAccountId = accountId ? normalizeAccountId(accountId) : current.pages.accountId;
  if (projectName || accountId || baseUrl) {
    await configStore.updatePages({
      projectName: selectedProjectName,
      accountId: selectedAccountId,
      accountName: accountName === undefined ? (accountId ? "" : current.pages.accountName) : accountName,
      baseUrl
    });
  }
  return configStore.get();
}

function cloudflareAuthRequiredMessage() {
  return "Not signed in to Cloudflare. Run `npx pagecast pages setup` once, then retry.";
}

async function ensureHeadlessPagesTarget({
  configStore,
  cloudflareAuth,
  projectName,
  accountId,
  accountName,
  baseUrl,
  branch = DEFAULT_PAGES_BRANCH,
  autoCreate = true,
  adoptExisting = false,
  loginIfNeeded = false
} = {}) {
  await applyPagesSelection({ configStore, projectName, accountId, accountName, baseUrl });

  const credential = cloudflareCredentialStatus();
  if (!credential.tokenConfigured) {
    const session = await cloudflareAuth.refreshSession();
    if (!session.loggedIn) {
      if (!loginIfNeeded) {
        throw appError(cloudflareAuthRequiredMessage(), 401);
      }
      await cloudflareAuth.login();
    }
  }

  const target = await ensureCloudflarePagesTarget({
    cloudflareAuth,
    configStore,
    autoCreate,
    adoptExisting,
    branch
  });

  if (!target.cloudflare.authenticated) {
    throw appError(cloudflareAuthRequiredMessage(), 401);
  }
  if (target.cloudflare.needsAccountChoice) {
    throw appError(
      "Multiple Cloudflare accounts found. Run `npx pagecast pages setup --account <account-id>` once, then retry.",
      409
    );
  }

  return target;
}

export async function setupCloudflarePages(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  return runCoordinatedHeadlessOperation(
    {
      dataDir,
      routeToDaemon: options.routeToDaemon,
      command: "pages_setup",
      payload: {
        projectName: options.projectName,
        accountId: options.accountId,
        accountName: options.accountName,
        baseUrl: options.baseUrl,
        branch: options.branch
      },
      commandFetchImpl: options.commandFetchImpl || fetch
    },
    () => setupCloudflarePagesOneShot({ ...options, dataDir })
  );
}

async function setupCloudflarePagesWithContext({
  configStore,
  cloudflareAuth,
  projectName,
  accountId,
  accountName,
  baseUrl,
  branch = DEFAULT_PAGES_BRANCH
} = {}) {
  const target = await ensureHeadlessPagesTarget({
    configStore,
    cloudflareAuth,
    projectName,
    accountId,
    accountName,
    baseUrl,
    branch,
    autoCreate: true,
    adoptExisting: true,
    loginIfNeeded: true
  });
  return {
    config: configStore.getPublicConfig(),
    cloudflare: target.cloudflare
  };
}

async function setupCloudflarePagesOneShot({
  projectName,
  accountId,
  accountName,
  baseUrl,
  branch = DEFAULT_PAGES_BRANCH,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const { configStore, cloudflareAuth } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
  return setupCloudflarePagesWithContext({
    configStore,
    cloudflareAuth,
    projectName,
    accountId,
    accountName,
    baseUrl,
    branch
  });
}

// Provision the feedback Worker + KV on the user's account and persist the
// resulting config. Reuses an existing stats token/namespace on re-run.
export async function setupCloudflareFeedback(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  return runCoordinatedHeadlessOperation(
    {
      dataDir,
      routeToDaemon: options.routeToDaemon,
      command: "feedback_setup",
      payload: { accountId: options.accountId },
      commandFetchImpl: options.commandFetchImpl || fetch
    },
    () => setupCloudflareFeedbackOneShot({ ...options, dataDir })
  );
}

async function setupCloudflareFeedbackOneShot({
  accountId,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  feedbackTimeoutMs = 120000
} = {}) {
  const { configStore, cloudflareAuth } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
  const pages = configStore.get().pages;
  const resolvedAccountId = normalizeAccountId(accountId || pages.accountId || "");

  const workerPath = path.join(PROJECT_ROOT, "feedback", "worker.js");
  let workerSource;
  let schemaSource;
  try {
    workerSource = await fs.readFile(workerPath, "utf8");
    schemaSource = await fs.readFile(path.join(PROJECT_ROOT, "feedback", "schema.sql"), "utf8");
  } catch {
    throw appError("Feedback Worker source not found in the package.", 500);
  }

  const existing = configStore.get().feedback;
  const statsToken = existing?.statsToken || randomBytes(24).toString("hex");
  const visitorSecret = existing?.visitorSecret || randomBytes(32).toString("hex");

  const result = await cloudflareAuth.setupFeedback({
    accountId: resolvedAccountId,
    workerSource,
    schemaSource,
    statsToken,
    visitorSecret,
    reactionsEnabled: false,
    deployDir: path.join(dataDir, "feedback-deploy")
  });

  const config = await configStore.updateFeedback({
    ...result,
    analyticsEnabled: true,
    reactionsEnabled: false
  });
  return { config, feedback: config.feedback };
}

export async function getCloudflarePagesStatus(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  return runCoordinatedHeadlessOperation(
    {
      dataDir,
      routeToDaemon: options.routeToDaemon,
      command: "pages_status",
      commandFetchImpl: options.commandFetchImpl || fetch
    },
    () => getCloudflarePagesStatusOneShot({ ...options, dataDir })
  );
}

async function getCloudflarePagesStatusOneShot({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const { configStore, cloudflareAuth } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
  const credential = cloudflareCredentialStatus();
  const session = credential.tokenConfigured
    ? { loggedIn: credential.accountIdConfigured, accounts: [] }
    : await cloudflareAuth.refreshSession();
  const pages = configStore.get().pages;
  const activeAccount =
    session.accounts.find((account) => account.id === pages.accountId) ||
    session.accounts[0] ||
    null;
  const accountName =
    normalizeAccountName(activeAccount?.name || "") || normalizeAccountName(pages.accountName || "");

  return {
    config: configStore.getPublicConfig(),
    cloudflare: {
      ...credential,
      loggedIn: session.loggedIn,
      accounts: session.accounts,
      accountName,
      accountId: pages.accountId || activeAccount?.id || "",
      projectName: pages.projectName,
      baseUrl: pages.baseUrl,
      ...targetManagementState(configStore, pages)
    }
  };
}

export async function listCloudflarePagesProjects(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  return runCoordinatedHeadlessOperation(
    {
      dataDir,
      routeToDaemon: options.routeToDaemon,
      command: "pages_projects_list",
      payload: { accountId: options.accountId },
      commandFetchImpl: options.commandFetchImpl || fetch
    },
    () => listCloudflarePagesProjectsOneShot({ ...options, dataDir })
  );
}

async function listCloudflarePagesProjectsWithContext({
  accountId,
  configStore,
  cloudflareAuth
} = {}) {
  const current = configStore.get();
  const credential = cloudflareCredentialStatus();
  const envAccountId = normalizeAccountIdSafe(process.env.CLOUDFLARE_ACCOUNT_ID);
  let selectedAccountId = normalizeAccountIdSafe(accountId || envAccountId || current.pages.accountId);

  if (!credential.tokenConfigured) {
    const session = await cloudflareAuth.refreshSession();
    if (!session.loggedIn) {
      throw appError(cloudflareAuthRequiredMessage(), 401);
    }
    if (!selectedAccountId && session.accounts.length === 1) {
      selectedAccountId = session.accounts[0].id;
    }
    if (!selectedAccountId && session.accounts.length > 1) {
      throw appError(
        "Multiple Cloudflare accounts found. Re-run with `--account <account-id>`.",
        409
      );
    }
  }

  if (credential.tokenConfigured && !selectedAccountId) {
    throw appError("Cloudflare API token mode requires CLOUDFLARE_ACCOUNT_ID or --account.", 401);
  }

  const projects = await cloudflareAuth.listProjects({ accountId: selectedAccountId });
  return {
    projects,
    accountId: selectedAccountId,
    selectedProject: chooseWranglerPagesProject(projects, {
      ...current.pages,
      accountId: selectedAccountId
    })
  };
}

async function listCloudflarePagesProjectsOneShot({
  accountId,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const { configStore, cloudflareAuth } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
  return listCloudflarePagesProjectsWithContext({ accountId, configStore, cloudflareAuth });
}

async function resolveDeploymentContextWithContext({
  accountId,
  configStore,
  cloudflareAuth
} = {}) {
  const current = configStore.get();
  const pages = current.pages;
  if (!pages.projectName) {
    throw appError("No Cloudflare Pages project configured. Run `npx pagecast pages setup` first.", 400);
  }
  const credential = cloudflareCredentialStatus();
  const envAccountId = normalizeAccountIdSafe(process.env.CLOUDFLARE_ACCOUNT_ID);
  let selectedAccountId = normalizeAccountIdSafe(accountId || envAccountId || pages.accountId);

  if (!credential.tokenConfigured) {
    const session = await cloudflareAuth.refreshSession();
    if (!session.loggedIn) {
      throw appError(cloudflareAuthRequiredMessage(), 401);
    }
    if (!selectedAccountId && session.accounts.length === 1) {
      selectedAccountId = session.accounts[0].id;
    }
    if (!selectedAccountId && session.accounts.length > 1) {
      throw appError("Multiple Cloudflare accounts found. Re-run with `--account <account-id>`.", 409);
    }
  }
  if (credential.tokenConfigured && !selectedAccountId) {
    throw appError("Cloudflare API token mode requires CLOUDFLARE_ACCOUNT_ID or --account.", 401);
  }

  return { cloudflareAuth, pages, accountId: selectedAccountId };
}

export async function listCloudflarePagesDeployments(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  return runCoordinatedHeadlessOperation(
    {
      dataDir,
      routeToDaemon: options.routeToDaemon,
      command: "deployments_list",
      payload: { accountId: options.accountId },
      commandFetchImpl: options.commandFetchImpl || fetch
    },
    () => listCloudflarePagesDeploymentsOneShot({ ...options, dataDir })
  );
}

async function listCloudflarePagesDeploymentsWithContext({
  accountId,
  configStore,
  cloudflareAuth
} = {}) {
  const ctx = await resolveDeploymentContextWithContext({ accountId, configStore, cloudflareAuth });
  const deployments = await ctx.cloudflareAuth.listDeployments({
    projectName: ctx.pages.projectName,
    accountId: ctx.accountId
  });
  return {
    deployments: flagLiveDeployment(deployments, { baseUrl: ctx.pages.baseUrl }),
    projectName: ctx.pages.projectName,
    baseUrl: ctx.pages.baseUrl
  };
}

async function listCloudflarePagesDeploymentsOneShot({
  accountId,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const { configStore, cloudflareAuth } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
  return listCloudflarePagesDeploymentsWithContext({ accountId, configStore, cloudflareAuth });
}

export async function deleteCloudflarePagesDeployment(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  return runCoordinatedHeadlessOperation(
    {
      dataDir,
      routeToDaemon: options.routeToDaemon,
      command: "deployment_delete",
      payload: { id: options.id, force: options.force === true, accountId: options.accountId },
      commandFetchImpl: options.commandFetchImpl || fetch
    },
    () => deleteCloudflarePagesDeploymentOneShot({ ...options, dataDir })
  );
}

async function deleteCloudflarePagesDeploymentWithContext({
  id,
  force = false,
  accountId,
  configStore,
  cloudflareAuth
} = {}) {
  const deployId = String(id || "").trim();
  if (!deployId) {
    throw appError("A deployment id is required.", 400);
  }
  const ctx = await resolveDeploymentContextWithContext({ accountId, configStore, cloudflareAuth });
  const current = flagLiveDeployment(
    await ctx.cloudflareAuth.listDeployments({ projectName: ctx.pages.projectName, accountId: ctx.accountId }),
    { baseUrl: ctx.pages.baseUrl }
  );
  const target = current.find((deployment) => deployment.id === deployId);
  if (!target) {
    throw appError(`Deployment ${deployId} was not found for ${ctx.pages.projectName}.`, 404);
  }
  if (target.isLive) {
    throw appError("This is the live deployment and can't be deleted. Publish a newer one first.", 409);
  }
  await ctx.cloudflareAuth.deleteDeployment({
    id: deployId,
    projectName: ctx.pages.projectName,
    accountId: ctx.accountId,
    force,
    environment: target.environment
  });
  return { id: deployId, deleted: true };
}

async function deleteCloudflarePagesDeploymentOneShot({
  id,
  force = false,
  accountId,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const { configStore, cloudflareAuth } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
  return deleteCloudflarePagesDeploymentWithContext({
    id,
    force,
    accountId,
    configStore,
    cloudflareAuth
  });
}

export async function pruneCloudflarePagesDeployments(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  return runCoordinatedHeadlessOperation(
    {
      dataDir,
      routeToDaemon: options.routeToDaemon,
      command: "deployments_prune",
      payload: { keep: options.keep, accountId: options.accountId },
      commandFetchImpl: options.commandFetchImpl || fetch
    },
    () => pruneCloudflarePagesDeploymentsOneShot({ ...options, dataDir })
  );
}

async function pruneCloudflarePagesDeploymentsWithContext({
  keep,
  accountId,
  configStore,
  cloudflareAuth
} = {}) {
  const keepCount = Number(keep);
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw appError("`keep` must be an integer of at least 1.", 400);
  }
  const ctx = await resolveDeploymentContextWithContext({ accountId, configStore, cloudflareAuth });
  const flagged = flagLiveDeployment(
    await ctx.cloudflareAuth.listDeployments({ projectName: ctx.pages.projectName, accountId: ctx.accountId }),
    { baseUrl: ctx.pages.baseUrl }
  );
  const toDelete = selectDeploymentsToPrune(flagged, keepCount);
  const deleted = [];
  const failed = [];
  for (const deployment of toDelete) {
    try {
      await ctx.cloudflareAuth.deleteDeployment({
        id: deployment.id,
        projectName: ctx.pages.projectName,
        accountId: ctx.accountId,
        force: deployment.environment !== "production",
        environment: deployment.environment
      });
      deleted.push(deployment.id);
    } catch (error) {
      failed.push({ id: deployment.id, error: error.message });
    }
  }
  return { pruned: deleted.length, kept: keepCount, deleted, failed };
}

async function pruneCloudflarePagesDeploymentsOneShot({
  keep,
  accountId,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const { configStore, cloudflareAuth } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
  return pruneCloudflarePagesDeploymentsWithContext({
    keep,
    accountId,
    configStore,
    cloudflareAuth
  });
}

export async function deployCloudflarePagesSite(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  return runCoordinatedHeadlessOperation(
    {
      dataDir,
      routeToDaemon: options.routeToDaemon,
      command: "pages_deploy_site",
      payload: {
        sourceDir: options.sourceDir,
        projectName: options.projectName,
        accountId: options.accountId,
        accountName: options.accountName,
        baseUrl: options.baseUrl,
        branch: options.branch
      },
      commandFetchImpl: options.commandFetchImpl || fetch
    },
    () => deployCloudflarePagesSiteOneShot({ ...options, dataDir })
  );
}

async function deployCloudflarePagesSiteWithContext({
  sourceDir,
  projectName,
  accountId,
  accountName,
  baseUrl,
  branch = DEFAULT_PAGES_BRANCH,
  cloudflareAuth,
  pagesPublisher
} = {}) {
  if (!projectName) {
    throw appError("Provide --project for direct Pages site deploys.", 400);
  }
  const normalizedBranch = normalizePagesBranch(branch);
  const normalizedSourceDir = await normalizeLocalFolderPath(sourceDir);
  const normalizedProjectName = normalizePagesProjectName(projectName);
  const credential = cloudflareCredentialStatus();
  const envAccountId = normalizeAccountIdSafe(process.env.CLOUDFLARE_ACCOUNT_ID);
  let selectedAccountId = normalizeAccountIdSafe(accountId || envAccountId);
  let selectedAccountName = normalizeAccountName(accountName || "");
  if (!credential.tokenConfigured) {
    const session = await cloudflareAuth.refreshSession();
    if (!session.loggedIn) {
      throw appError(cloudflareAuthRequiredMessage(), 401);
    }
    if (!selectedAccountId && session.accounts.length === 1) {
      selectedAccountId = session.accounts[0].id;
      selectedAccountName = normalizeAccountName(session.accounts[0].name || selectedAccountName);
    }
    if (!selectedAccountId && session.accounts.length > 1) {
      throw appError("Multiple Cloudflare accounts found. Re-run with `--account <account-id>`.", 409);
    }
  }
  if (!selectedAccountId) {
    throw appError("Direct Pages deploy requires an explicit Cloudflare account ID.", 400);
  }
  let projects = await cloudflareAuth.listProjects({ accountId: selectedAccountId });
  let project = projects.find(
    (entry) =>
      entry.name === normalizedProjectName &&
      (!entry.accountId || entry.accountId === selectedAccountId)
  );
  if (!project) {
    await cloudflareAuth.ensureProject({
      projectName: normalizedProjectName,
      accountId: selectedAccountId,
      branch: normalizedBranch
    });
    projects = await cloudflareAuth.listProjects({ accountId: selectedAccountId });
    project = projects.find(
      (entry) =>
        entry.name === normalizedProjectName &&
        (!entry.accountId || entry.accountId === selectedAccountId)
    );
  }
  const pagesConfig = {
    projectName: normalizedProjectName,
    accountId: selectedAccountId,
    accountName: selectedAccountName || normalizeAccountName(project?.accountName || ""),
    baseUrl: normalizePagesBaseUrl(baseUrl || project?.baseUrl, normalizedProjectName),
    branch: normalizedBranch
  };
  const deployment = await pagesPublisher.deploySite({
    sourceDir: normalizedSourceDir,
    pagesConfig,
    branch: normalizedBranch
  });

  return {
    url: deployment.baseUrl,
    deploymentUrl: deployment.deploymentUrl,
    projectName: pagesConfig.projectName,
    accountId: pagesConfig.accountId,
    accountName: pagesConfig.accountName,
    branch: deployment.branch,
    sourceDir: normalizedSourceDir
  };
}

async function deployCloudflarePagesSiteOneShot({
  sourceDir,
  projectName,
  accountId,
  accountName,
  baseUrl,
  branch = DEFAULT_PAGES_BRANCH,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  pagesDeploySpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  pagesDeployTimeoutMs = 180000
} = {}) {
  const { cloudflareAuth, pagesPublisher } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    pagesDeploySpawnImpl,
    cloudflareListTimeoutMs,
    pagesDeployTimeoutMs
  });
  return deployCloudflarePagesSiteWithContext({
    sourceDir,
    projectName,
    accountId,
    accountName,
    baseUrl,
    branch,
    cloudflareAuth,
    pagesPublisher
  });
}

// Headless one-shot snapshot publish for the CLI / agent skill. Reuses the same
// store, config, auth, and publisher wiring as the server, auto-provisioning the
// Cloudflare account and Pages project, and returns the public URL. Throws a
// structured (statusCode-bearing) error when the user is not signed in, so the
// caller can turn it into clear guidance instead of a stack trace.
export async function publishReportSnapshot(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  const callerEnv = options.env || process.env;
  const routedContextId =
    options.contextId ||
    callerEnv.PAGECAST_CONTEXT_ID ||
    callerEnv.CODEX_THREAD_ID ||
    callerEnv.CLAUDE_SESSION_ID ||
    "";
  if (options.routeToDaemon !== false) {
    const routed = await tryInvokeLiveCommand(
      dataDir,
      "publish_report",
      {
        path: options.path,
        label: options.label,
        password: options.password,
        disableProtection: options.disableProtection === true,
        expires: options.expires,
        contextId: routedContextId,
        workspaceId: options.workspaceId,
        itemKey: options.itemKey,
        mode: options.mode,
        newLink: options.newLink === true,
        update: options.update
      },
      { fetchImpl: options.commandFetchImpl || fetch }
    );
    if (routed !== null) {
      return routed;
    }
  }
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: randomBytes(32).toString("base64url") });
  try {
    return await publishReportSnapshotOneShot({ ...options, dataDir });
  } finally {
    await lease.release();
  }
}

async function publishReportSnapshotOneShot({
  path: reportPath,
  label,
  password,
  disableProtection = false,
  expires,
  contextId = "",
  workspaceId = "",
  itemKey = "",
  mode = "",
  newLink = false,
  update = "",
  nonInteractive = false,
  env = process.env,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  pagesDeploySpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  pagesDeployTimeoutMs = 180000
} = {}) {
  if (!reportPath) {
    throw appError("Provide a path to an HTML report to publish.", 400);
  }

  const store = createReportStore({ dataDir });
  await store.init();
  const { configStore, cloudflareAuth, pagesPublisher } = await createHeadlessCloudflareContext({
    dataDir,
    store,
    cloudflareAuthSpawnImpl,
    pagesDeploySpawnImpl,
    cloudflareListTimeoutMs,
    pagesDeployTimeoutMs
  });

  const credential = cloudflareCredentialStatus();
  if (!credential.tokenConfigured) {
    let session = await cloudflareAuth.refreshSession();
    if (!session.loggedIn) {
      if (nonInteractive || String(env.CI || "").trim()) {
        throw appError(
          "Not signed in to Cloudflare. Run `npx pagecast` interactively to connect, then retry.",
          401
        );
      }
      await cloudflareAuth.login(CLOUDFLARE_OAUTH_SCOPES);
      session = await cloudflareAuth.refreshSession();
      if (!session.loggedIn) {
        throw appError("Cloudflare sign-in did not complete. Retry the publish when ready.", 401);
      }
    }
  }

  const target = await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
  if (target.cloudflare.needsAccountChoice) {
    throw appError(
      "Multiple Cloudflare accounts found. Run `npx pagecast` to choose one, then retry.",
      409
    );
  }

  const publishMode = normalizePublishMode({ mode, newLink, update });
  const publicationContext = resolvePublicationContext({
    contextId,
    workspaceId,
    itemKey,
    sourcePath: reportPath,
    env
  });
  const existing = store.findPublishMatch({
    ...publishMode,
    contextKey: publicationContext.contextKey
  });
  const report = existing
    ? await store.replaceSourceWithPath(existing.report.id, reportPath)
    : await store.addPath(reportPath);
  // --password sets/replaces protection; --no-password removes it. Otherwise any
  // existing protection on a reused report is left untouched.
  if (typeof password === "string" && password.trim()) {
    await updateReportPasswordProtection({
      store,
      configStore,
      pagesPublisher,
      deployQueue: null,
      reportId: report.id,
      enabled: true,
      password
    });
  } else if (disableProtection) {
    await updateReportPasswordProtection({
      store,
      configStore,
      pagesPublisher,
      deployQueue: null,
      reportId: report.id,
      enabled: false
    });
  }

  const resolvedExpiresAt =
    existing && (expires === undefined || expires === "")
      ? existing.publication.expiresAt || null
      : resolveExpiresAt({ expires, defaultExpiry: configStore.get().defaultExpiry });

  if (existing) {
    const publication = existing.publication;
    publication.contextKey = publicationContext.contextKey;
    publication.contextHash = publicationContext.contextHash;
    publication.itemHash = publicationContext.itemHash;
    publication.workspaceHash = publicationContext.workspaceHash;
    if (typeof label === "string" && label.trim()) {
      publication.label = label.trim();
    }
    publication.expiresAt = resolvedExpiresAt;
    const pagesConfig = pagesConfigForPublication(publication, configStore.get().pages);
    rememberPublicationPagesTarget(publication, pagesConfig);
    await store.beginOperations([
      {
        type: "sync",
        token: publication.token,
        slug: publication.slug || publication.token,
        projectRef: pagesConfig,
        reportId: report.id
      }
    ]);
    try {
      publication.publicUrl = await pagesPublisher.syncPublication({
        report: store.get(report.id),
        publication,
        pagesConfig
      });
      await persistActualPublicationOrigin(publication, configStore);
      await store.syncSnapshot(publication.token);
      await store.clearOperation("sync", publication.token);
    } catch (error) {
      await store
        .recordOperationFailure({
          type: "sync",
          token: publication.token,
          slug: publication.slug || publication.token,
          projectRef: pagesConfig,
          error
        })
        .catch(() => {});
      throw error;
    }
    const updatedReport = store.get(report.id);
    return {
      action: "updated",
      contextMatched: publishMode.mode === "upsert",
      url: publication.publicUrl,
      token: publication.token,
      publicationToken: publication.token,
      label: publication.label,
      projectName: pagesConfig.projectName,
      reportId: report.id,
      passwordProtected: updatedReport.passwordProtected === true,
      linkKind: classifyLinkKind({
        slug: publication.slug || publication.token,
        drop: publication.drop === true,
        passwordProtected: updatedReport.passwordProtected === true
      }),
      expiresAt: publication.expiresAt || null
    };
  }

  const draft = store.draftPublication(report.id, {
    label,
    kind: "snapshot",
    expiresAt: resolvedExpiresAt
  });
  Object.assign(draft.publication, {
    contextKey: publicationContext.contextKey,
    contextHash: publicationContext.contextHash,
    itemHash: publicationContext.itemHash,
    workspaceHash: publicationContext.workspaceHash
  });
  const gated = Boolean(store.get(report.id).passwordProtected || draft.publication.expiresAt);
  const pagesConfig = configStore.get().pages;
  rememberPublicationPagesTarget(draft.publication, pagesConfig);
  const operation = {
    type: "publish",
    token: draft.publication.token,
    slug: draft.publication.slug || draft.publication.token,
    projectRef: pagesConfig,
    reportId: report.id,
    publication: structuredClone(draft.publication),
    remoteSucceeded: false
  };
  await store.beginOperations([operation]);
  if (gated) {
    await store.commitPublication(report.id, draft.publication);
  }
  try {
    draft.publication.publicUrl = await (gated
      ? pagesPublisher.syncPublication
      : pagesPublisher.publish)({
      report: store.get(report.id),
      publication: draft.publication,
      pagesConfig
    });
    await store.beginOperations([
      {
        ...operation,
        publication: structuredClone(draft.publication),
        publicUrl: draft.publication.publicUrl,
        remoteSucceeded: true
      }
    ]);
    await persistActualPublicationOrigin(draft.publication, configStore);
    draft.publication.pending = false;
    if (gated) {
      await store.syncSnapshot(draft.publication.token);
    } else {
      await store.commitPublication(report.id, draft.publication);
    }
    await store.clearOperation("publish", draft.publication.token);
  } catch (error) {
    await store
      .recordOperationFailure({
        type: "publish",
        token: operation.token,
        slug: operation.slug,
        projectRef: pagesConfig,
        error
      })
      .catch(() => {});
    throw error;
  }

  return {
    action: "created",
    contextMatched: false,
    url: draft.publication.publicUrl,
    token: draft.publication.token,
    publicationToken: draft.publication.token,
    label: draft.publication.label,
    projectName: configStore.get().pages.projectName,
    reportId: report.id,
    passwordProtected: store.get(report.id).passwordProtected === true,
    linkKind: classifyLinkKind({
      slug: draft.publication.slug || draft.publication.token,
      drop: draft.publication.drop === true,
      passwordProtected: store.get(report.id).passwordProtected === true
    }),
    expiresAt: draft.publication.expiresAt || null
  };
}

export async function revokeReportPublication(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  if (options.routeToDaemon !== false) {
    const routed = await tryInvokeLiveCommand(
      dataDir,
      "revoke_publication",
      { token: options.token },
      { fetchImpl: options.commandFetchImpl || fetch }
    );
    if (routed !== null) {
      return routed;
    }
  }
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: randomBytes(32).toString("base64url") });
  try {
    return await revokeReportPublicationOneShot({ ...options, dataDir });
  } finally {
    await lease.release();
  }
}

async function revokeReportPublicationOneShot({
  token,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  pagesDeploySpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  pagesDeployTimeoutMs = 180000
} = {}) {
  const publicationToken = String(token || "").trim();
  if (!publicationToken) {
    throw appError("A publication token is required.", 400);
  }

  const store = createReportStore({ dataDir });
  await store.init();
  const existing = store.findPublication(publicationToken);
  if (!existing) {
    throw appError("Published link was not found.", 404);
  }

  if (!existing.publication.revokedAt && existing.publication.kind === "snapshot") {
    const { configStore, cloudflareAuth, pagesPublisher } = await createHeadlessCloudflareContext({
      dataDir,
      store,
      cloudflareAuthSpawnImpl,
      pagesDeploySpawnImpl,
      cloudflareListTimeoutMs,
      pagesDeployTimeoutMs
    });
    const credential = cloudflareCredentialStatus();
    if (!credential.tokenConfigured) {
      const session = await cloudflareAuth.refreshSession();
      if (!session.loggedIn) {
        throw appError(cloudflareAuthRequiredMessage(), 401);
      }
    }
    const pagesConfig = pagesConfigForPublication(existing.publication, configStore.get().pages);
    const slug = existing.publication.slug || existing.publication.token;
    await store.beginOperations([
      { type: "revoke", token: publicationToken, slug, projectRef: pagesConfig }
    ]);
    try {
      await pagesPublisher.revoke([slug], pagesConfig);
      await store.commitSuccessfulRevoke(publicationToken);
    } catch (error) {
      await store.recordOperationFailure({
        type: "revoke",
        token: publicationToken,
        slug,
        projectRef: pagesConfig,
        error
      });
      throw error;
    }
  }

  // This is also the retry path for a remotely-revoked publication whose later
  // local cleanup failed. The atomic helper clears any stale revoke journal even
  // when revokedAt is already present.
  const { report, publication } = await store.commitSuccessfulRevoke(publicationToken);
  return {
    report: store.formatReport(report, {}),
    publication: store.formatPublication(publication, {
      passwordProtected: report.passwordProtected === true
    })
  };
}

async function runPublicationMutation(deployQueue, mutation) {
  return deployQueue ? deployQueue.enqueue(mutation) : mutation();
}

async function publishGoalWithContext({
  file,
  requestedSlug = "goal",
  dataDir,
  store,
  configStore,
  pagesPublisher,
  deployQueue = null
}) {
  const absFile = path.resolve(file);
  const goalSrcDir = path.join(dataDir, "goal-src");
  const isHtml = /\.html?$/i.test(absFile);
  const entryName = isHtml ? "index.html" : "goal.md";
  const stagedSource = path.join(goalSrcDir, entryName);
  await fs.rm(goalSrcDir, { recursive: true, force: true });
  await fs.mkdir(goalSrcDir, { recursive: true });
  await fs.copyFile(absFile, stagedSource);

  const existing = configStore.get().goal;
  if (existing?.token) {
    const match = store.findActivePublication(existing.token);
    if (match && match.publication.kind === "snapshot") {
      const pagesConfig = pagesConfigForPublication(
        match.publication,
        configStore.get().pages
      );
      await store.beginOperations([
        {
          type: "goal_sync",
          token: existing.token,
          slug: match.publication.slug || match.publication.token,
          projectRef: pagesConfig,
          reportId: match.report.id,
          goalFile: absFile
        }
      ]);
      try {
        const url = await runPublicationMutation(deployQueue, () =>
          pagesPublisher.syncPublication({
            report: match.report,
            publication: match.publication,
            pagesConfig
          })
        );
        match.publication.publicUrl = url;
        await persistActualPublicationOrigin(match.publication, configStore);
        await store.syncSnapshot(existing.token);
        const next = await configStore.setGoal({
          ...existing,
          url,
          file: absFile,
          expiresAt: null,
          updatedAt: nowIso()
        });
        await store.clearOperation("goal_sync", existing.token);
        return {
          url,
          slug: next.goal.slug,
          token: existing.token,
          started: false,
          recreated: false,
          linkKind: classifyLinkKind({
            slug: match.publication.slug || match.publication.token,
            drop: match.publication.drop === true,
            passwordProtected: match.report.passwordProtected === true
          }),
          expiresAt: null
        };
      } catch (error) {
        await store
          .recordOperationFailure({
            type: "goal_sync",
            token: existing.token,
            slug: match.publication.slug || match.publication.token,
            projectRef: pagesConfig,
            error
          })
          .catch(() => {});
        throw error;
      }
    }
  }

  const report = await store.addPath(stagedSource);
  const draft = store.draftPublication(report.id, { label: "goal", kind: "snapshot" });
  const pagesConfig = configStore.get().pages;
  rememberPublicationPagesTarget(draft.publication, pagesConfig);
  const publishOperation = {
    type: "publish",
    token: draft.publication.token,
    slug: draft.publication.slug || draft.publication.token,
    projectRef: pagesConfig,
    reportId: report.id,
    publication: structuredClone(draft.publication),
    remoteSucceeded: false
  };
  await store.beginOperations([publishOperation]);
  let url;
  try {
    url = await runPublicationMutation(deployQueue, () =>
      pagesPublisher.publish({
        report: draft.report,
        publication: draft.publication,
        pagesConfig
      })
    );
    draft.publication.publicUrl = url;
    await store.beginOperations([
      {
        ...publishOperation,
        publication: structuredClone(draft.publication),
        publicUrl: url,
        remoteSucceeded: true
      }
    ]);
    await persistActualPublicationOrigin(draft.publication, configStore);
    draft.publication.pending = false;
    await store.commitPublication(report.id, draft.publication);
    await store.clearOperation("publish", draft.publication.token);
  } catch (error) {
    await store
      .recordOperationFailure({
        type: "publish",
        token: publishOperation.token,
        slug: publishOperation.slug,
        projectRef: pagesConfig,
        error
      })
      .catch(() => {});
    throw error;
  }

  let slug = draft.publication.token;
  let rename = null;
  const previous = {
    slug: draft.publication.slug || draft.publication.token,
    drop: draft.publication.drop === true,
    publicUrl: url,
    publicationUpdatedAt: draft.publication.updatedAt,
    reportUpdatedAt: draft.report.updatedAt,
    redirects: store.listRedirects()
  };
  try {
    rename = await store.renameSlug(draft.publication.token, requestedSlug);
  } catch (error) {
    if (error.statusCode !== 400 && error.statusCode !== 409) {
      throw error;
    }
  }
  if (rename && rename.oldSlug !== rename.newSlug) {
    const renameOperation = {
      type: "rename",
      token: draft.publication.token,
      slug: rename.newSlug,
      projectRef: pagesConfig,
      previousSlug: rename.oldSlug,
      reportId: report.id
    };
    await store.beginOperations([renameOperation]);
    try {
      url = await runPublicationMutation(deployQueue, () =>
        pagesPublisher.renamePublication({
          oldSlug: rename.oldSlug,
          newSlug: rename.newSlug,
          report: draft.report,
          publication: draft.publication,
          pagesConfig
        })
      );
      draft.publication.publicUrl = url;
      await persistActualPublicationOrigin(draft.publication, configStore);
      await store.syncSnapshot(draft.publication.token);
      await store.clearOperation("rename", draft.publication.token);
      slug = rename.newSlug;
    } catch (error) {
      await store
        .recordOperationFailure({ ...renameOperation, error })
        .catch(() => {});
      if (error?.remoteSucceeded) {
        throw error;
      }
      await store.restorePublicationSlug(draft.publication.token, previous).catch(() => {});
      let revokeCommitted = false;
      try {
        await store.beginOperations([
          {
            type: "revoke",
            token: draft.publication.token,
            slug: previous.slug,
            projectRef: pagesConfig
          }
        ]);
        await runPublicationMutation(deployQueue, () =>
          pagesPublisher.revoke([previous.slug], pagesConfig)
        );
        await store.commitSuccessfulRevoke(draft.publication.token);
        await store.clearOperation("rename", draft.publication.token);
        revokeCommitted = true;
        await store.remove(report.id);
      } catch (cleanupError) {
        // Only a failed/uncertain revoke needs a retry journal and recovery goal.
        // If revoke already committed, a later report-removal failure leaves a
        // visible revoked report that can be deleted normally; recording another
        // revoke would create a dead-link journal entry that cannot help cleanup.
        if (!revokeCommitted) {
          await store.recordOperationFailure({
            type: "revoke",
            token: draft.publication.token,
            slug: previous.slug,
            projectRef: pagesConfig,
            error: cleanupError
          });
          const startedAt = existing?.startedAt || nowIso();
          await configStore.setGoal({
            token: draft.publication.token,
            slug: previous.slug,
            url: previous.publicUrl,
            file: absFile,
            startedAt,
            updatedAt: nowIso()
          });
        }
      }
      throw error;
    }
  }

  const startedAt = existing?.startedAt || nowIso();
  await configStore.setGoal({
    token: draft.publication.token,
    slug,
    url,
    file: absFile,
    expiresAt: null,
    startedAt,
    updatedAt: nowIso()
  });
  return {
    url,
    slug,
    token: draft.publication.token,
    started: true,
    recreated: Boolean(existing?.token),
    linkKind: classifyLinkKind({
      slug,
      drop: draft.publication.drop === true,
      passwordProtected: draft.report.passwordProtected === true
    }),
    expiresAt: null
  };
}

async function stopGoalWithContext({ store, configStore, pagesPublisher, deployQueue = null }) {
  const goal = configStore.get().goal;
  if (!goal?.token) {
    return { stopped: false, url: null };
  }
  const match = store.findActivePublication(goal.token);
  if (match) {
    const pagesConfig = pagesConfigForPublication(match.publication, configStore.get().pages);
    await store.beginOperations([
      {
        type: "revoke",
        token: goal.token,
        slug: goal.slug || goal.token,
        projectRef: pagesConfig
      }
    ]);
    try {
      await runPublicationMutation(deployQueue, () =>
        pagesPublisher.revoke([goal.slug || goal.token], pagesConfig)
      );
      await store.commitSuccessfulRevoke(goal.token);
    } catch (error) {
      await store.recordOperationFailure({
        type: "revoke",
        token: goal.token,
        slug: goal.slug || goal.token,
        projectRef: pagesConfig,
        error
      });
      throw error;
    }
  }
  await configStore.setGoal(null);
  return { stopped: true, url: goal.url };
}

// Publish (or update in place) the live goal-progress page. Idempotent: the first
// call publishes <file> and records it in config.goal; later calls re-sync the
// SAME slug/URL with the file's new content (never minting a new link). Stop with
// stopGoalProgress. Designed for headless agent use (`npx pagecast goal publish`).
export async function publishGoalProgress(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  if (options.routeToDaemon !== false) {
    const routed = await tryInvokeLiveCommand(
      dataDir,
      "goal_publish",
      { file: options.file, slug: options.slug || "goal" },
      { fetchImpl: options.commandFetchImpl || fetch }
    );
    if (routed !== null) {
      return routed;
    }
  }
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: randomBytes(32).toString("base64url") });
  try {
    return await publishGoalProgressOneShot({ ...options, dataDir });
  } finally {
    await lease.release();
  }
}

async function publishGoalProgressOneShot({
  file,
  slug: requestedSlug = "goal",
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  pagesDeploySpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  pagesDeployTimeoutMs = 180000
} = {}) {
  if (!file) {
    throw appError("Provide a path to the goal-progress file.", 400);
  }
  const store = createReportStore({ dataDir });
  await store.init();
  const { configStore, cloudflareAuth, pagesPublisher } = await createHeadlessCloudflareContext({
    dataDir,
    store,
    cloudflareAuthSpawnImpl,
    pagesDeploySpawnImpl,
    cloudflareListTimeoutMs,
    pagesDeployTimeoutMs
  });

  const credential = cloudflareCredentialStatus();
  if (!credential.tokenConfigured) {
    const session = await cloudflareAuth.refreshSession();
    if (!session.loggedIn) {
      throw appError(
        "Not signed in to Cloudflare. Run `npx pagecast` once, click Connect Cloudflare, then retry.",
        401
      );
    }
  }
  const target = await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
  if (target.cloudflare.needsAccountChoice) {
    throw appError(
      "Multiple Cloudflare accounts found. Run `npx pagecast` to choose one, then retry.",
      409
    );
  }

  return publishGoalWithContext({
    file,
    requestedSlug,
    dataDir,
    store,
    configStore,
    pagesPublisher
  });
}

export async function getGoalStatus(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  if (options.routeToDaemon !== false) {
    const routed = await tryInvokeLiveCommand(
      dataDir,
      "goal_status",
      {},
      { fetchImpl: options.commandFetchImpl || fetch }
    );
    if (routed !== null) {
      return routed;
    }
  }
  const configStore = createConfigStore({ dataDir });
  await configStore.init({ persist: false });
  return { goal: configStore.get().goal };
}

export async function stopGoalProgress(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, ".pagecast");
  if (options.routeToDaemon !== false) {
    const routed = await tryInvokeLiveCommand(
      dataDir,
      "goal_stop",
      {},
      { fetchImpl: options.commandFetchImpl || fetch }
    );
    if (routed !== null) {
      return routed;
    }
  }
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: randomBytes(32).toString("base64url") });
  try {
    return await stopGoalProgressOneShot({ ...options, dataDir });
  } finally {
    await lease.release();
  }
}

async function stopGoalProgressOneShot({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  pagesDeploySpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  pagesDeployTimeoutMs = 180000
} = {}) {
  const store = createReportStore({ dataDir });
  await store.init();
  const { configStore, cloudflareAuth, pagesPublisher } = await createHeadlessCloudflareContext({
    dataDir,
    store,
    cloudflareAuthSpawnImpl,
    pagesDeploySpawnImpl,
    cloudflareListTimeoutMs,
    pagesDeployTimeoutMs
  });
  const goal = configStore.get().goal;
  if (!goal?.token) {
    return { stopped: false, url: null };
  }
  const match = store.findActivePublication(goal.token);
  if (match) {
    const credential = cloudflareCredentialStatus();
    if (!credential.tokenConfigured && !(await cloudflareAuth.refreshSession()).loggedIn) {
      throw appError(cloudflareAuthRequiredMessage(), 401);
    }
    await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
  }
  return stopGoalWithContext({ store, configStore, pagesPublisher });
}

async function main() {
  const runtime = await startServers();
  console.log(`Pagecast admin: ${runtime.displayAdminUrl || runtime.adminUrl}`);
  console.log(`Local published-page server: ${runtime.displayPublicUrl || runtime.publicUrl}`);
  console.log("Press Ctrl-C to stop.");

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
