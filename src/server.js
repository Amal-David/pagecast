import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, watch as fsWatch } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { markdownToHtml } from "./markdown.js";
import { generateName, generateUniqueName, generateUnguessableName } from "./nameGenerator.js";
import {
  PAGECAST_SYNC_MANIFEST_PATH,
  isValidPasswordHash,
  makePasswordHash,
  renderAuthMiddleware,
  renderRoutesJson
} from "./crypto.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_HOSTNAME = "pagecast.localhost";
export const DEFAULT_ADMIN_PORT = 4173;
export const DEFAULT_PUBLIC_PORT = 4174;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_FOLDER_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_FOLDER_UPLOAD_FILES = 1000;
export const MAX_FOLDER_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_PAGES_PROJECT_NAME = "pagecast";
export const DEFAULT_PAGES_BRANCH = "main";
export const DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS = 60 * 1000;
export const CLOUDFLARE_OAUTH_SCOPES = ["account:read", "user:read", "pages:write"];
const PAGECAST_MARKETING_PROJECT_NAME = "pagecasthq";
const PAGECAST_MARKETING_REQUIRED_FILES = ["index.html", "og-image.png"];
const MAX_SYNC_IMPORT_FILES = MAX_FOLDER_UPLOAD_FILES;
const MAX_SYNC_IMPORT_BYTES = MAX_FOLDER_UPLOAD_BYTES;
const MAX_SYNC_IMPORT_FILE_BYTES = MAX_FOLDER_UPLOAD_FILE_BYTES;
const SYNC_MANIFEST_FETCH_TIMEOUT_MS = 5000;

// Feedback provisioning deploys a Worker + KV, which the base publishing scopes
// don't permit. These elevate the grant only when the user opts into feedback,
// so publishing never has to request Workers/KV access up front.
export const FEEDBACK_OAUTH_SCOPES = [
  "account:read",
  "user:read",
  "pages:write",
  "workers_scripts:write",
  "workers_kv:write"
];

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

export function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

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

function createReportId(fileName) {
  return `${slugifyReportName(fileName)}-${randomBytes(4).toString("hex")}`;
}

// Recover the human-readable name from a public token. New tokens ARE the name
// (e.g. "hollow-paperclip"); this also strips the trailing "-<32 hex>" tail from
// any legacy token (e.g. "v1-<hex>" -> "v1") so old and new compare cleanly.
export function publicTokenNamePrefix(token) {
  return String(token || "").replace(/-[0-9a-f]{32}$/i, "");
}

// A published page's URL slug is now a memorable all-words name with NO random
// tail (e.g. /p/hollow-paperclip/). Uniqueness comes from the very large word
// library plus a per-publish collision check (isNameTaken); see nameGenerator.js.
// NOTE: without the old entropy tail the slug is guessable, so it is no longer an
// access-control boundary — sensitive pages must use password protection.
export function createPublicToken(isNameTaken = () => false, { drop = false } = {}) {
  // A "drop" is a deliberately public link: short and memorable, but guessable.
  // Otherwise the link is private and gets a long, hard-to-guess all-words name
  // (still no digits). Password protection remains the boundary for true secrecy.
  const generate = drop ? () => generateName() : () => generateUnguessableName();
  return generateUniqueName(isNameTaken, { generate });
}

function isPathInside(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePagesProjectName(value) {
  const projectName = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(projectName)) {
    throw appError("Cloudflare Pages project name must be a valid lowercase slug.", 400);
  }
  return projectName;
}

function normalizePagesProjectNameSafe(value) {
  try {
    return normalizePagesProjectName(value || "");
  } catch {
    return "";
  }
}

function normalizeAccountId(value) {
  const accountId = String(value || "").trim();
  if (!accountId) {
    return "";
  }

  if (!/^[a-fA-F0-9]{32}$/.test(accountId)) {
    throw appError("Cloudflare account ID must be 32 hex characters.", 400);
  }
  return accountId;
}

function normalizePagesBranch(value = DEFAULT_PAGES_BRANCH) {
  const branch = String(value || DEFAULT_PAGES_BRANCH).trim();
  if (
    !branch ||
    branch.length > 128 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw appError("Cloudflare Pages branch must be a valid branch name.", 400);
  }
  return branch;
}

function normalizeAccountName(value) {
  const accountName = stripAnsi(value).trim();
  if (!accountName || isRedactedAccountName(accountName)) {
    return "";
  }
  return accountName;
}

function pagesBaseUrl(projectName) {
  return `https://${projectName}.pages.dev`;
}

function normalizePagesBaseUrl(value, projectName) {
  const fallback = pagesBaseUrl(projectName);
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }

  const firstDomain = raw.split(/[,\s]+/).find((item) => item && item !== "-") || "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(firstDomain)
    ? firstDomain
    : `https://${firstDomain}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
      return fallback;
    }
    return stripTrailingSlash(`${url.protocol}//${url.host}`);
  } catch {
    return fallback;
  }
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

function pagesConfigForPublication(publication, currentPages) {
  const currentProjectName = normalizePagesProjectNameSafe(currentPages?.projectName) || DEFAULT_PAGES_PROJECT_NAME;
  const currentBaseUrl = stripTrailingSlash(currentPages?.baseUrl || pagesBaseUrl(currentProjectName));
  const storedProjectName = normalizePagesProjectNameSafe(publication.pagesProjectName);
  const inferredProjectName = pagesProjectNameFromPublicUrl(publication.publicUrl);
  const projectName = storedProjectName || inferredProjectName || currentProjectName;
  const storedBaseUrl = publication.pagesBaseUrl ? stripTrailingSlash(publication.pagesBaseUrl) : "";
  const inferredBaseUrl = inferredProjectName ? pagesBaseUrl(inferredProjectName) : "";
  const publicOrigin = publicUrlOrigin(publication.publicUrl);

  if (!storedProjectName && !inferredProjectName && publicOrigin && publicOrigin !== currentBaseUrl) {
    throw appError(
      `This published link belongs to ${publicOrigin}, but Pagecast is connected to ${currentBaseUrl}. Click Publish URL to publish it to the current Pages project, or switch back to the original project before syncing.`,
      409
    );
  }

  return {
    ...currentPages,
    projectName,
    accountId: normalizeAccountIdSafe(publication.pagesAccountId || currentPages?.accountId),
    accountName: publication.pagesAccountName || currentPages?.accountName || "",
    branch: DEFAULT_PAGES_BRANCH,
    baseUrl: storedBaseUrl || inferredBaseUrl || currentBaseUrl || pagesBaseUrl(projectName)
  };
}

function rememberPublicationPagesTarget(publication, pagesConfig) {
  publication.pagesProjectName = pagesConfig.projectName;
  publication.pagesAccountId = normalizeAccountIdSafe(pagesConfig.accountId);
  publication.pagesAccountName = normalizeAccountName(pagesConfig.accountName || "");
  publication.pagesBaseUrl = stripTrailingSlash(pagesConfig.baseUrl || pagesBaseUrl(pagesConfig.projectName));
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

function stripAnsi(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function cleanCommandOutput(output) {
  return stripAnsi(output)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Feedback Worker provisioning: parse wrangler outputs --------------------

// A KV namespace id is a 32-char hex string. `wrangler kv namespace create`
// prints a TOML/JSON snippet containing `id = "<hex>"` / `"id": "<hex>"`.
export function parseKvNamespaceId(output) {
  const text = stripAnsi(output || "");
  const match = text.match(/(?:id\s*=\s*|"id"\s*:\s*)"([0-9a-f]{32})"/i);
  return match ? match[1].toLowerCase() : "";
}

// `wrangler kv namespace list` prints a JSON array of { id, title }. Reuse an
// existing namespace by title so re-running setup is idempotent.
export function findKvNamespaceId(output, title) {
  const text = stripAnsi(output || "");
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
      const list = JSON.parse(text.slice(start, end + 1));
      const hit = list.find((entry) => entry && entry.title === title);
      if (hit && /^[0-9a-f]{32}$/i.test(hit.id || "")) {
        return String(hit.id).toLowerCase();
      }
    }
  } catch {
    // Non-JSON or unexpected shape — treat as "not found" and create one.
  }
  return "";
}

// The deployed Worker's public origin, e.g. https://name.sub.workers.dev.
export function parseWorkerDevUrl(output) {
  const text = stripAnsi(output || "");
  const match = text.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  return match ? match[0].toLowerCase() : "";
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
    workerName: String(feedback.workerName || ""),
    kvId: String(feedback.kvId || "")
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
  const hostname = String(value || "").trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname)
    ? hostname
    : DEFAULT_LOCAL_HOSTNAME;
}

function normalizeLocalConfig(local = {}) {
  return {
    hostname: normalizeLocalHostname(local.hostname || DEFAULT_LOCAL_HOSTNAME),
    adminPort: normalizeLocalPort(local.adminPort, DEFAULT_ADMIN_PORT),
    publicPort: normalizeLocalPort(local.publicPort, DEFAULT_PUBLIC_PORT)
  };
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
    // Anonymous usage telemetry (which commands run, version, OS). On by default;
    // opt out via `pagecast telemetry disable`, PAGECAST_TELEMETRY=0, or DO_NOT_TRACK=1.
    telemetry: config.telemetry !== false,
    // Opaque random install id (no PII). Generated lazily only when telemetry is
    // enabled and about to send; stripped from any client-/CLI-facing config.
    telemetryId:
      typeof config.telemetryId === "string" && config.telemetryId
        ? config.telemetryId
        : null,
    // Whether the one-time first-run telemetry notice has been shown.
    telemetryNotified: config.telemetryNotified === true
  };
}

export function cloudflareCredentialStatus(env = process.env) {
  const tokenConfigured = Boolean(String(env.CLOUDFLARE_API_TOKEN || "").trim());
  const rawAccountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  let accountIdConfigured = false;
  let accountId = "";

  if (rawAccountId) {
    try {
      accountId = normalizeAccountId(rawAccountId);
      accountIdConfigured = true;
    } catch {
      accountIdConfigured = false;
    }
  }

  return {
    authMode: tokenConfigured ? "api-token" : "scoped-oauth",
    tokenConfigured,
    accountIdConfigured,
    accountId,
    scopedOauthAvailable: true,
    oauthScopes: CLOUDFLARE_OAUTH_SCOPES
  };
}

function parseJsonFromCommandOutput(output) {
  const text = String(output || "").trim();
  if (!text) {
    throw appError("Wrangler did not return JSON output.", 502);
  }

  try {
    return JSON.parse(text);
  } catch {
    const firstObject = text.indexOf("{");
    const firstArray = text.indexOf("[");
    const starts = [firstObject, firstArray].filter((index) => index >= 0);
    const start = starts.length > 0 ? Math.min(...starts) : -1;
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to the public error below.
      }
    }
  }

  throw appError("Wrangler project list output was not valid JSON.", 502);
}

function firstString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) {
        return nested;
      }
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function isRedactedAccountName(value) {
  return /^\(?redacted\)?$/i.test(String(value || "").trim());
}

function extractProjectCandidates(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed?.projects)) {
    return parsed.projects;
  }

  if (Array.isArray(parsed?.items)) {
    return parsed.items;
  }

  if (Array.isArray(parsed?.result)) {
    return parsed.result;
  }

  if (Array.isArray(parsed?.result?.projects)) {
    return parsed.result.projects;
  }

  return [];
}

function parseWranglerPagesProjectTable(output) {
  const text = stripAnsi(output);
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").slice(1, -1).map((column) => column.trim()))
    .filter((columns) => columns.some(Boolean));

  if (rows.length === 0) {
    return [];
  }

  const headerIndex = rows.findIndex((columns) =>
    columns.some((column) => /^(project\s+)?name$/i.test(column))
  );
  if (headerIndex === -1) {
    return [];
  }

  const headers = rows[headerIndex].map((column) => column.toLowerCase());
  const nameIndex = headers.findIndex((header) => header === "name" || header === "project name");
  const domainIndex = headers.findIndex((header) => header.includes("domain"));
  const branchIndex = headers.findIndex((header) => header.includes("branch"));
  const accountIdIndex = headers.findIndex((header) => header === "account id");
  const accountNameIndex = headers.findIndex((header) => header === "account");

  return rows.slice(headerIndex + 1)
    .map((columns) => {
      const name = columns[nameIndex] || "";
      if (!name || /^(name|project name)$/i.test(name)) {
        return null;
      }

      return {
        name,
        project_domains: domainIndex >= 0 ? columns[domainIndex] : "",
        account_id: accountIdIndex >= 0 ? columns[accountIdIndex] : "",
        account_name: accountNameIndex >= 0 ? columns[accountNameIndex] : "",
        production_branch: branchIndex >= 0 ? columns[branchIndex] : ""
      };
    })
    .filter(Boolean);
}

export function parseWranglerPagesProjects(output) {
  let parsed;
  try {
    parsed = parseJsonFromCommandOutput(output);
  } catch {
    parsed = parseWranglerPagesProjectTable(output);
  }

  return extractProjectCandidates(parsed)
    .map((project) => {
      const name = firstString(project?.name, project?.projectName, project?.project_name, project?.["Project Name"]);
      if (!name) {
        return null;
      }

      let projectName;
      try {
        projectName = normalizePagesProjectName(name);
      } catch {
        return null;
      }

      let accountId = "";
      try {
        accountId = normalizeAccountId(
          firstString(
            project?.accountId,
            project?.account_id,
            project?.account?.id,
            project?.account?.account_id
          )
        );
      } catch {
        accountId = "";
      }

      return {
        name: projectName,
        accountId,
        accountName: firstString(project?.accountName, project?.account_name, project?.account?.name),
        productionBranch: firstString(
          project?.productionBranch,
          project?.production_branch,
          project?.deployment_configs?.production?.branch,
          project?.["Production Branch"]
        ),
        baseUrl: normalizePagesBaseUrl(
          firstString(
            project?.baseUrl,
            project?.base_url,
            project?.url,
            project?.domains,
            project?.domain,
            project?.projectDomains,
            project?.project_domains,
            project?.["Project Domains"]
          ),
          projectName
        )
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function chooseWranglerPagesProject(projects, pagesConfig = {}) {
  if (!Array.isArray(projects) || projects.length === 0) {
    return null;
  }

  const preferredName = String(pagesConfig.projectName || "").toLowerCase();
  const preferredAccountId = String(pagesConfig.accountId || "").toLowerCase();
  // Only adopt a project that is actually requested. If no explicit preference
  // is available, fall back to Pagecast's default project.
  if (preferredName) {
    const matches = projects.filter((project) => project.name === preferredName);
    if (preferredAccountId) {
      return matches.find((project) => String(project.accountId || "").toLowerCase() === preferredAccountId) || matches[0] || null;
    }
    return matches[0] || null;
  }
  return projects.find((project) => project.name === DEFAULT_PAGES_PROJECT_NAME) || null;
}

function normalizeAccountIdSafe(value) {
  try {
    return normalizeAccountId(value || "");
  } catch {
    return "";
  }
}

function parseWranglerWhoamiTable(output) {
  const text = stripAnsi(output);
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").slice(1, -1).map((column) => column.trim()))
    .filter((columns) => columns.some(Boolean));

  if (rows.length === 0) {
    return [];
  }

  const headerIndex = rows.findIndex((columns) =>
    columns.some((column) => /account\s*id/i.test(column))
  );
  if (headerIndex === -1) {
    return [];
  }

  const headers = rows[headerIndex].map((column) => column.toLowerCase());
  const idIndex = headers.findIndex((header) => /account\s*id/.test(header));
  const nameIndex = headers.findIndex(
    (header) => /account\s*name/.test(header) || header === "account" || header === "name"
  );

  return rows.slice(headerIndex + 1)
    .map((columns) => {
      const id = normalizeAccountIdSafe(idIndex >= 0 ? columns[idIndex] : "");
      const name = nameIndex >= 0 ? columns[nameIndex] || "" : "";
      return id ? { id, name } : null;
    })
    .filter(Boolean);
}

export function parseWranglerWhoamiAccounts(output) {
  let parsed = null;
  try {
    parsed = parseJsonFromCommandOutput(output);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const candidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.accounts)
        ? parsed.accounts
        : Array.isArray(parsed.result?.accounts)
          ? parsed.result.accounts
          : Array.isArray(parsed.result)
            ? parsed.result
            : [];

    const accounts = candidates
      .map((account) => {
        const id = normalizeAccountIdSafe(
          firstString(account?.id, account?.account_id, account?.accountId, account?.account?.id)
        );
        const name = firstString(
          account?.name,
          account?.account_name,
          account?.accountName,
          account?.account?.name
        );
        return id ? { id, name } : null;
      })
      .filter(Boolean);

    if (accounts.length > 0) {
      return accounts;
    }
  }

  return parseWranglerWhoamiTable(output);
}

// --- Cloudflare Pages deployment history: parse `wrangler pages deployment`
// outputs and flag/select deployments for the view-and-remove feature. --------

function parseWranglerPagesDeploymentTable(output) {
  // Text fallback for Wrangler versions where `--json` is unsupported. The table
  // can't carry aliases, so live-detection degrades to the env+date heuristic.
  const text = stripAnsi(output);
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").slice(1, -1).map((column) => column.trim()))
    .filter((columns) => columns.some(Boolean));

  if (rows.length === 0) {
    return [];
  }

  const headerIndex = rows.findIndex((columns) =>
    columns.some((column) => /deployment\s*id|^id$/i.test(column))
  );
  if (headerIndex === -1) {
    return [];
  }

  const headers = rows[headerIndex].map((column) => column.toLowerCase());
  const idIndex = headers.findIndex((header) => /deployment\s*id|^id$/.test(header));
  const envIndex = headers.findIndex((header) => header.includes("environment"));
  const branchIndex = headers.findIndex((header) => header.includes("branch"));
  const createdIndex = headers.findIndex((header) => header.includes("created") || header.includes("date"));
  const urlIndex = headers.findIndex((header) => header.includes("url") || header.includes("source"));

  return rows.slice(headerIndex + 1)
    .map((columns) => {
      const id = idIndex >= 0 ? columns[idIndex] : "";
      if (!id || /deployment\s*id|^id$/i.test(id)) {
        return null;
      }
      return {
        id,
        deployment_id: id,
        environment: envIndex >= 0 ? columns[envIndex] : "",
        branch: branchIndex >= 0 ? columns[branchIndex] : "",
        created_on: createdIndex >= 0 ? columns[createdIndex] : "",
        url: urlIndex >= 0 ? columns[urlIndex] : ""
      };
    })
    .filter(Boolean);
}

// Normalize `wrangler pages deployment list` output (JSON first, table fallback)
// into a stable shape. Tolerant of field-name drift across Wrangler versions.
export function parseWranglerPagesDeployments(output) {
  let parsed;
  try {
    parsed = parseJsonFromCommandOutput(output);
  } catch {
    parsed = parseWranglerPagesDeploymentTable(output);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.result)
      ? parsed.result
      : Array.isArray(parsed?.deployments)
        ? parsed.deployments
        : [];

  return list
    .map((deployment) => {
      // Wrangler's CLI `--json` emits PascalCase, column-named fields
      // (Id/Environment/Deployment/Status), while the REST API and the text
      // table use snake_case/lowercase. Read every known casing.
      const id = firstString(deployment?.id, deployment?.Id, deployment?.deployment_id);
      if (!id) {
        return null;
      }
      const aliases = Array.isArray(deployment?.aliases)
        ? deployment.aliases.filter((alias) => typeof alias === "string")
        : [];
      return {
        id,
        shortId: firstString(deployment?.short_id, deployment?.shortId) || id.slice(0, 8),
        url: firstString(deployment?.url, deployment?.Deployment, deployment?.deployment_url),
        // Normalize case: JSON returns "production"/"preview"; wrangler's CLI
        // JSON and the text table yield "Production"/"Preview". Downstream live
        // detection compares against "production", so lowercase it here.
        environment: (
          firstString(deployment?.environment, deployment?.Environment) || "preview"
        ).toLowerCase(),
        branch: firstString(
          deployment?.deployment_trigger?.metadata?.branch,
          deployment?.branch,
          deployment?.Branch
        ),
        // ISO timestamp when present (REST shape). Wrangler's CLI JSON omits it
        // and lists newest-first, so live-detection's stable sort preserves order.
        createdOn: firstString(deployment?.created_on, deployment?.createdOn, deployment?.created_at),
        modifiedOn: firstString(deployment?.modified_on, deployment?.modifiedOn, deployment?.modified_at),
        // A human-friendly age/stage for display when no ISO timestamp exists
        // (wrangler's CLI JSON puts e.g. "2 days ago" in Status).
        status: firstString(
          deployment?.Status,
          deployment?.latest_stage?.name,
          deployment?.latest_stage,
          deployment?.status
        ),
        latestStage: firstString(deployment?.latest_stage?.name, deployment?.latest_stage),
        isSkipped: deployment?.is_skipped === true,
        aliases,
        isLive: false
      };
    })
    .filter(Boolean);
}

function deploymentTimestamp(deployment) {
  const parsed = Date.parse(deployment?.modifiedOn || deployment?.createdOn || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Flag the single live production deployment so callers can protect it from
// deletion. Live = the newest non-skipped production deployment, OR (when JSON
// aliases are present) any production deployment aliased to the project base URL.
// Returns a NEW list sorted newest-first with `isLive` set.
export function flagLiveDeployment(deployments, { baseUrl = "" } = {}) {
  const host = String(baseUrl || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const sorted = [...deployments].sort((a, b) => deploymentTimestamp(b) - deploymentTimestamp(a));
  const production = sorted.filter((d) => d.environment === "production" && !d.isSkipped);
  const liveId = production.length > 0 ? production[0].id : "";
  return sorted.map((deployment) => {
    const aliasMatch =
      host &&
      deployment.environment === "production" &&
      deployment.aliases.some(
        (alias) =>
          alias.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase() === host
      );
    return { ...deployment, isLive: deployment.id === liveId || Boolean(aliasMatch) };
  });
}

// Pick which deployments a `keep N` prune should delete: keep the N newest
// (including the live one), delete the rest oldest-first, NEVER the live one.
export function selectDeploymentsToPrune(deployments, keep) {
  const keepCount = Math.max(0, Number.isFinite(keep) ? Math.floor(keep) : 0);
  const sorted = [...deployments].sort((a, b) => deploymentTimestamp(b) - deploymentTimestamp(a));
  return sorted
    .slice(keepCount)
    .filter((deployment) => !deployment.isLive)
    .reverse();
}

async function copyPublicTree(sourceRoot, destinationRoot) {
  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.mkdir(destinationRoot, { recursive: true });

  async function copyDirectory(currentSource, currentRelative = "") {
    const entries = await fs.readdir(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const sourcePath = path.join(currentSource, entry.name);
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
  return {
    slug,
    source,
    files,
    title: String(record?.title || record?.name || "").trim(),
    label: String(record?.label || "imported").trim(),
    token: String(record?.token || slug).trim(),
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

  const content = Buffer.from(await response.arrayBuffer());
  if (content.length > MAX_SYNC_IMPORT_FILE_BYTES) {
    throw appError("Synced page includes a file that is too large.", 413);
  }
  const nextTotalBytes = totalBytes + content.length;
  if (nextTotalBytes > MAX_SYNC_IMPORT_BYTES) {
    throw appError("Synced page is too large.", 413);
  }
  return { content, totalBytes: nextTotalBytes };
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
    if (fileCount >= MAX_SYNC_IMPORT_FILES) {
      throw appError(`Synced page includes more than ${MAX_SYNC_IMPORT_FILES} files.`, 413);
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
    let body = await readSyncImportResponse(response, totalBytes);
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

async function runSpawnCommand({
  spawnImpl,
  command,
  args,
  timeoutMs,
  cwd = PROJECT_ROOT,
  env = process.env
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    let output = "";

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      terminateChild(child);
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(appError(`${command} did not finish within ${timeoutMs}ms.\n${output.trim()}`, 504));
    }, timeoutMs);
    timer.unref?.();

    try {
      // On Windows, `npx` is a `.cmd` shim that CreateProcess cannot launch
      // directly (modern Node also refuses to spawn .cmd/.bat without a shell),
      // so spawn it through the shell. Scoped to `npx`; other callers (e.g. the
      // `sh -lc` build runner) keep direct argv semantics. shell:true joins the
      // args into one unquoted cmd.exe line, so npx callers must keep them free
      // of spaces and shell metacharacters: slugs/branch/32-hex account id are
      // validated, and filesystem paths are passed via `cwd` + a relative arg,
      // never inline.
      child = spawnImpl(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        shell: process.platform === "win32" && command === "npx"
      });
    } catch (error) {
      fail(appError(`${command} could not start.`, 502));
      return;
    }

    const recordOutput = (chunk) => {
      output += chunk.toString();
    };

    child.stdout?.on("data", recordOutput);
    child.stderr?.on("data", recordOutput);
    child.on("error", () => fail(appError(`${command} could not start.`, 502)));
    child.on("exit", (code, signal) => finish({ code, signal, output }));
  });
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

export function createConfigStore({ dataDir = path.join(PROJECT_ROOT, ".pagecast") } = {}) {
  const configPath = path.join(dataDir, "config.json");
  let config = normalizeConfig();

  async function save() {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  // Generate local secrets once and keep them stable across redeploys.
  function ensureSecrets() {
    if (!config.authCookieSecret) {
      config = { ...config, authCookieSecret: randomBytes(32).toString("hex") };
    }
    if (!config.syncSecret) {
      config = { ...config, syncSecret: randomBytes(32).toString("hex") };
    }
  }

  async function init() {
    if (!(await pathExists(configPath))) {
      ensureSecrets();
      await save();
      return;
    }

    const parsed = safeJsonParse(await fs.readFile(configPath, "utf8"), {});
    config = normalizeConfig(parsed);
    ensureSecrets();
    await save();
  }

  function get() {
    return structuredClone(config);
  }

  // Client-safe view of the config. Secrets must never reach the browser
  // (it's served by /api/status and /api/config), or auth/sync tokens leak.
  function getPublicConfig() {
    // telemetryId is an internal anonymous id; like secrets it must never reach
    // the browser or CLI JSON output. The `telemetry` boolean stays visible.
    const { authCookieSecret, syncSecret, telemetryId, ...rest } = config;
    return structuredClone(rest);
  }

  async function updatePages({ projectName, accountId, accountName, baseUrl } = {}) {
    const nextProjectName = projectName === undefined ? config.pages.projectName : projectName;
    const nextAccountId = accountId === undefined ? config.pages.accountId : accountId;
    const nextAccountName =
      accountName === undefined && nextAccountId === config.pages.accountId
        ? config.pages.accountName
        : accountName;
    const nextBaseUrl =
      baseUrl === undefined && nextProjectName === config.pages.projectName
        ? config.pages.baseUrl
        : baseUrl;
    config = normalizeConfig({
      pages: {
        projectName: nextProjectName,
        accountId: nextAccountId,
        accountName: nextAccountName,
        baseUrl: nextBaseUrl
      },
      // Preserve feedback + badge + goal config — a pages update (e.g. persisting
      // the account on publish) must not wipe other settings.
      feedback: config.feedback,
      badge: config.badge,
      goal: config.goal,
      defaultExpiry: config.defaultExpiry,
      cloudflareSyncEnabled: config.cloudflareSyncEnabled,
      local: config.local,
      authCookieSecret: config.authCookieSecret,
      syncSecret: config.syncSecret,
      telemetry: config.telemetry,
      telemetryId: config.telemetryId,
      telemetryNotified: config.telemetryNotified
    });
    await save();
    return get();
  }

  async function setBadge(enabled) {
    config = normalizeConfig({ ...config, badge: enabled !== false });
    await save();
    return get();
  }

  async function setDefaultExpiry(value) {
    config = normalizeConfig({ ...config, defaultExpiry: value });
    await save();
    return get();
  }

  async function setCloudflareSyncEnabled(enabled) {
    config = normalizeConfig({ ...config, cloudflareSyncEnabled: enabled !== false });
    await save();
    return get();
  }

  async function setLocalRuntime(local) {
    config = normalizeConfig({ ...config, local: { ...config.local, ...local } });
    await save();
    return get();
  }

  async function setGoal(goal) {
    config = normalizeConfig({ ...config, goal });
    await save();
    return get();
  }

  async function setTelemetry(enabled) {
    config = normalizeConfig({ ...config, telemetry: enabled !== false });
    await save();
    return get();
  }

  // Generate the opaque anonymous install id once, on demand. Random and PII-free;
  // only created when telemetry is enabled and about to send its first event.
  async function ensureTelemetryId() {
    if (!config.telemetryId) {
      config = { ...config, telemetryId: randomBytes(16).toString("hex") };
      await save();
    }
    return config.telemetryId;
  }

  async function markTelemetryNotified() {
    if (!config.telemetryNotified) {
      config = { ...config, telemetryNotified: true };
      await save();
    }
    return get();
  }

  async function updateFeedback(feedback) {
    config = normalizeConfig({
      pages: config.pages,
      badge: config.badge,
      goal: config.goal,
      defaultExpiry: config.defaultExpiry,
      cloudflareSyncEnabled: config.cloudflareSyncEnabled,
      local: config.local,
      authCookieSecret: config.authCookieSecret,
      syncSecret: config.syncSecret,
      telemetry: config.telemetry,
      telemetryId: config.telemetryId,
      telemetryNotified: config.telemetryNotified,
      feedback: feedback === null ? null : { ...(config.feedback || {}), ...feedback }
    });
    await save();
    return get();
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

  return { enqueue };
}

// Insert the feedback widget into a published HTML document. The widget (served
// by the user's feedback Worker) beacons a view and renders the reactions bar.
// Injected just before </body> so it loads after page content. `url` is the
// Worker origin and `slug` keys this page's stats. Returns the HTML unchanged
// when feedback is not configured. Pure + exported for testing.
export function injectFeedbackWidget(html, { url, slug } = {}) {
  const baseUrl = String(url || "").trim().replace(/\/+$/, "");
  const pageSlug = String(slug || "").trim();
  if (!baseUrl || !pageSlug) {
    return html;
  }
  const esc = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const tag =
    `<script src="${esc(`${baseUrl}/widget.js`)}" data-slug="${esc(pageSlug)}" defer></script>`;
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

// Default Open Graph card image — a Pagecast-branded card already hosted on the
// landing site. Branded so every shared link carries Pagecast into the feed
// (the pre-click half of the badge loop). Per-report dynamic cards are a future
// enhancement; keep this a single constant so it's a one-line change.
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

// Inject Open Graph + Twitter card meta so shared links unfurl richly instead of
// as bare URLs. Idempotent and non-clobbering: if the document already declares
// its own og: meta, it's returned unchanged. `image`/`siteName` are only emitted
// when provided (the caller gates Pagecast branding on the badge/white-label
// setting). Pure + exported for testing.
export function injectSocialMeta(html, { title, description, url, image, siteName } = {}) {
  const doc = String(html || "");
  if (/(?:property|name)=["']og:/i.test(doc)) {
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

export function createCloudflarePagesPublisher({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  spawnImpl = spawn,
  fetchImpl = fetch,
  timeoutMs = 180000,
  getRedirects = () => [],
  getFeedback = () => null,
  getBadge = () => true,
  getProtectedPublications = () => [],
  getAuthCookieSecret = () => null,
  getSyncToken = () => ""
} = {}) {
  const siteRoot = path.join(dataDir, "pages-site");
  const deployRoot = path.join(dataDir, "pages-deploy");

  function publicationDir(slug) {
    return path.join(siteRoot, "p", slug);
  }

  // Returns the directory whose contents should be published for a report: the
  // working copy when the report has been detached/edited in-app, otherwise the
  // original source directory.
  function publishSourceFor(report) {
    return report.workingDir || report.buildOutputRoot || report.rootDir;
  }

  async function buildSyncManifest(pagesConfig = {}) {
    const baseUrl = pagesConfig?.baseUrl || pagesBaseUrl(pagesConfig?.projectName || DEFAULT_PAGES_PROJECT_NAME);
    const pRoot = path.join(siteRoot, "p");
    const publications = [];
    let entries = [];
    try {
      entries = await fs.readdir(pRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      let slug;
      try {
        slug = normalizeCustomSlug(entry.name);
      } catch {
        continue;
      }
      const root = publicationDir(slug);
      const files = await listPublicTreeFiles(root);
      if (!files.includes("index.html") && !files.includes("index.htm")) {
        continue;
      }
      let title = slug;
      try {
        const indexName = files.includes("index.html") ? "index.html" : "index.htm";
        const html = await fs.readFile(path.join(root, indexName), "utf8");
        title = extractTitle(html, slug) || slug;
      } catch {
        title = slug;
      }
      publications.push({
        slug,
        title,
        files,
        publicUrl: baseUrl ? joinUrl(baseUrl, `/p/${encodeURIComponent(slug)}/`) : "",
        updatedAt: nowIso()
      });
    }

    publications.sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      version: 1,
      generatedAt: nowIso(),
      baseUrl,
      publications
    };
  }

  async function ensureSiteRoot(pagesConfig = {}) {
    await fs.mkdir(siteRoot, { recursive: true });
    await fs.rm(path.join(siteRoot, "index.html"), { force: true });
    await fs.writeFile(path.join(siteRoot, "404.html"), "<!doctype html><title>Not found</title>", "utf8");
    await fs.writeFile(
      path.join(siteRoot, "_headers"),
      "/*\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n",
      "utf8"
    );

    const redirects = getRedirects() || [];
    const redirectsPath = path.join(siteRoot, "_redirects");
    if (redirects.length > 0) {
      const lines = redirects
        .map((entry) => `${stripTrailingSlash(entry.from)}/* ${stripTrailingSlash(entry.to)}/:splat 301`)
        .join("\n");
      await fs.writeFile(redirectsPath, `${lines}\n`, "utf8");
    } else {
      await fs.rm(redirectsPath, { force: true });
    }

    await writeAuthAssets(pagesConfig);
  }

  // (Re)generate the edge gate on every deploy. When any publication needs one —
  // password-protected and/or expiring — write functions/_middleware.js (the
  // gate + baked manifest) and a _routes.json scoping the Function to those
  // prefixes only. When none need it, remove both so the site stays pure-static.
  async function writeAuthAssets(pagesConfig = {}) {
    const manifest = (getProtectedPublications() || []).filter(
      (entry) =>
        entry &&
        entry.slug &&
        (isValidPasswordHash(entry) || (Number.isFinite(entry.expiresAt) && entry.expiresAt > 0))
    );
    const functionsDir = path.join(siteRoot, "functions");
    const middlewarePath = path.join(functionsDir, "_middleware.js");
    const routesPath = path.join(siteRoot, "_routes.json");
    const syncToken = String(getSyncToken() || "");
    const syncManifest = syncToken ? await buildSyncManifest(pagesConfig) : null;
    const includeSyncEndpoint = Boolean(syncToken && syncManifest?.publications?.length);

    if (manifest.length === 0 && !includeSyncEndpoint) {
      await fs.rm(functionsDir, { recursive: true, force: true });
      await fs.rm(routesPath, { force: true });
      return;
    }

    await fs.mkdir(functionsDir, { recursive: true });
    await fs.writeFile(
      middlewarePath,
      renderAuthMiddleware(manifest, {
        cookieSecret: getAuthCookieSecret() || "",
        badge: getBadge(),
        syncToken,
        syncManifest
      }),
      "utf8"
    );
    await fs.writeFile(
      routesPath,
      renderRoutesJson(manifest.map((entry) => entry.slug), { includeSyncEndpoint }),
      "utf8"
    );
  }

  async function stagePublication(report, publication, { pagesBaseUrl = "" } = {}) {
    const slug = publication.slug || publication.token;
    const destinationRoot = publicationDir(slug);
    const sourceRoot = publishSourceFor(report);
    await copyPublicTree(sourceRoot, destinationRoot);

    const indexPath = path.join(destinationRoot, "index.html");
    let html;
    if (isMarkdownFileName(report.entryFile)) {
      // Render the raw markdown entry to real HTML so the published Cloudflare
      // site serves a proper document; sibling assets were copied above.
      const markdown = await fs.readFile(path.join(sourceRoot, report.entryFile), "utf8");
      html = markdownToHtml(markdown, { title: report.name });
    } else {
      html = await fs.readFile(path.join(sourceRoot, report.entryFile), "utf8");
    }

    // Inject the reactions + analytics widget when feedback is provisioned.
    const feedback = getFeedback();
    if (feedback?.url) {
      html = injectFeedbackWidget(html, { url: feedback.url, slug });
    }
    // Inject the "Published with Pagecast" badge unless turned off (white-label).
    const badgeOn = getBadge();
    if (badgeOn) {
      html = injectBadge(html);
    }
    // Inject Open Graph / Twitter meta so the shared link unfurls richly. The
    // Pagecast-branded card image + site_name are gated on the badge setting, so
    // white-label pages get clean per-report unfurls without Pagecast branding.
    html = injectSocialMeta(html, {
      title: extractTitle(html, report.name),
      description: extractDescription(html),
      url: pagesBaseUrl ? joinUrl(pagesBaseUrl, `/p/${encodeURIComponent(slug)}/`) : "",
      image: badgeOn ? DEFAULT_OG_IMAGE : "",
      siteName: badgeOn ? "Pagecast" : ""
    });
    await fs.writeFile(indexPath, html, "utf8");
  }

  async function removePublication(slug) {
    await fs.rm(publicationDir(slug), { recursive: true, force: true });
  }

  async function runPagesDeploy(rootDir, pagesConfig, branch = DEFAULT_PAGES_BRANCH) {
    const projectName = normalizePagesProjectName(pagesConfig.projectName);
    const accountId = normalizeAccountId(pagesConfig.accountId || "");
    const deployBranch = normalizePagesBranch(branch);
    await assertSafePagesDeployRoot(rootDir, projectName);

    // Deploy from INSIDE rootDir (path arg ".") instead of passing rootDir as
    // the path. `wrangler pages deploy` resolves the Functions directory
    // relative to the current working directory, NOT the deploy-path argument —
    // so running from rootDir is what lets our generated functions/_middleware.js
    // (the password gate) and _routes.json actually get compiled and uploaded.
    const args = [
      "--yes",
      "wrangler",
      "pages",
      "deploy",
      ".",
      "--project-name",
      projectName,
      "--branch",
      deployBranch
    ];

    // `wrangler pages deploy` does not accept an `--account-id` flag (it errors
    // with "Unknown arguments: account-id" on e.g. 4.63.0). The account is
    // selected via the CLOUDFLARE_ACCOUNT_ID environment variable instead.
    const result = await runSpawnCommand({
      spawnImpl,
      command: "npx",
      args,
      timeoutMs,
      cwd: rootDir,
      env: accountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } : process.env
    });

    if (result.code !== 0) {
      throw appError(
        `Cloudflare Pages deploy failed (${result.signal || result.code}).\n${cleanCommandOutput(result.output)}`,
        502
      );
    }

    // Use the real subdomain Cloudflare actually assigned (may differ from the
    // project name on a global subdomain collision), not an assumed one.
    const baseUrl = pagesBaseUrlFromDeployOutput(result.output, projectName);
    return {
      baseUrl,
      deploymentUrl: pagesDeploymentUrlFromDeployOutput(result.output, baseUrl),
      output: result.output
    };
  }

  async function deploy(pagesConfig) {
    await ensureSiteRoot(pagesConfig);
    const result = await runPagesDeploy(siteRoot, pagesConfig, DEFAULT_PAGES_BRANCH);
    return result.baseUrl;
  }

  async function deploySite({ sourceDir, pagesConfig, branch = DEFAULT_PAGES_BRANCH } = {}) {
    const normalizedSourceDir = await normalizeLocalFolderPath(sourceDir);
    const projectName = normalizePagesProjectName(pagesConfig.projectName);
    if (isPathInside(deployRoot, normalizedSourceDir)) {
      throw appError("Cannot deploy Pagecast's internal deploy staging folder.", 400);
    }
    const stagingRoot = path.join(deployRoot, projectName);
    await copyPublicTree(normalizedSourceDir, stagingRoot);
    const result = await runPagesDeploy(stagingRoot, pagesConfig, branch);
    return {
      ...result,
      sourceDir: normalizedSourceDir,
      stagingRoot,
      projectName,
      branch: normalizePagesBranch(branch)
    };
  }

  async function publish({ report, publication, pagesConfig }) {
    const slug = publication.slug || publication.token;
    await ensureSiteRoot(pagesConfig);
    await stagePublication(report, publication, { pagesBaseUrl: pagesConfig?.baseUrl });
    try {
      const baseUrl = await deploy(pagesConfig);
      return joinUrl(baseUrl, `/p/${encodeURIComponent(slug)}/`);
    } catch (error) {
      await removePublication(slug);
      throw error;
    }
  }

  // Re-stage and redeploy the SAME slug folder so the public URL updates in
  // place. Unlike publish(), this never removes the staged folder on failure so
  // the last known-good content stays live.
  async function syncPublication({ report, publication, pagesConfig }) {
    const slug = publication.slug || publication.token;
    await ensureSiteRoot(pagesConfig);
    await stagePublication(report, publication, { pagesBaseUrl: pagesConfig?.baseUrl });
    const baseUrl = await deploy(pagesConfig);
    return joinUrl(baseUrl, `/p/${encodeURIComponent(slug)}/`);
  }

  // Move a publication's staged content from oldSlug to newSlug and redeploy,
  // returning the new public URL.
  async function renamePublication({ oldSlug, newSlug, report, publication, pagesConfig }) {
    await ensureSiteRoot(pagesConfig);
    await stagePublication(report, { ...publication, slug: newSlug }, { pagesBaseUrl: pagesConfig?.baseUrl });
    if (oldSlug && oldSlug !== newSlug) {
      await removePublication(oldSlug);
    }
    try {
      const baseUrl = await deploy(pagesConfig);
      return joinUrl(baseUrl, `/p/${encodeURIComponent(newSlug)}/`);
    } catch (error) {
      if (oldSlug && oldSlug !== newSlug) {
        await removePublication(newSlug).catch(() => {});
        await stagePublication(report, { ...publication, slug: oldSlug }, { pagesBaseUrl: pagesConfig?.baseUrl })
          .catch(() => {});
      }
      throw error;
    }
  }

  async function revoke(slugs, pagesConfig) {
    await ensureSiteRoot(pagesConfig);
    for (const slug of slugs) {
      await removePublication(slug);
    }
    return deploy(pagesConfig);
  }

  async function discoverPublishedPages({ pagesConfig = {}, syncToken = "" } = {}) {
    const baseUrl = pagesConfig?.baseUrl || pagesBaseUrl(pagesConfig?.projectName || DEFAULT_PAGES_PROJECT_NAME);
    const records = new Map();
    const warnings = [];
    let remoteManifestFound = false;

    if (baseUrl && syncToken) {
      const manifestUrl = joinUrl(
        baseUrl,
        `${PAGECAST_SYNC_MANIFEST_PATH}?token=${encodeURIComponent(syncToken)}`
      );
      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          manifestUrl,
          { headers: { Accept: "application/json" } }
        );
        if (response.ok) {
          const contentType = response.headers.get("content-type") || "";
          if (!contentType.includes("application/json")) {
            remoteManifestFound = false;
          } else {
            const manifest = await response.json();
            const remoteBaseUrl = String(manifest?.baseUrl || baseUrl);
            for (const item of manifest?.publications || []) {
              const record = normalizeSyncRecord(item, {
                baseUrl: remoteBaseUrl,
                source: "cloudflare"
              });
              if (record) {
                records.set(record.slug, record);
              }
            }
            remoteManifestFound = true;
          }
        } else if (response.status !== 404) {
          warnings.push(`Cloudflare sync manifest returned ${response.status}.`);
        }
      } catch (error) {
        warnings.push(`Cloudflare sync manifest could not be read: ${error.message || error}.`);
      }
    }

    const localManifest = await buildSyncManifest(pagesConfig);
    for (const item of localManifest.publications) {
      const record = normalizeSyncRecord(item, {
        baseUrl: localManifest.baseUrl,
        source: "local-staged"
      });
      if (record) {
        records.set(record.slug, {
          ...records.get(record.slug),
          ...record,
          sourceRoot: publicationDir(record.slug),
          source: records.has(record.slug) ? "cloudflare+local-staged" : "local-staged"
        });
      }
    }

    const projectName =
      normalizePagesProjectNameSafe(pagesConfig?.projectName) || DEFAULT_PAGES_PROJECT_NAME;
    const projectDeployRoot = path.join(deployRoot, projectName);
    try {
      const projectEntry = await findFolderEntry(projectDeployRoot);
      const files = await listPublicTreeFiles(projectDeployRoot);
      const slug = normalizeCustomSlug(projectName);
      let title = projectName;
      try {
        const html = await fs.readFile(path.join(projectDeployRoot, projectEntry), "utf8");
        title = extractTitle(html, title) || title;
      } catch {
        title = projectName;
      }
      if (!records.has(slug)) {
        records.set(slug, {
          slug,
          source: "local-staged-site-root",
          sourceRoot: projectDeployRoot,
          files,
          title,
          label: "recovered",
          token: slug,
          publicUrl: baseUrl,
          baseUrl,
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.statusCode !== 400) {
        warnings.push(`Local staged Pages project could not be read: ${error.message || error}.`);
      }
    }

    if (records.size === 0 && baseUrl) {
      const slug = normalizeCustomSlug(projectName);
      records.set(slug, {
        slug,
        source: "cloudflare-public-root",
        files: [],
        title: projectName,
        label: "recovered",
        token: slug,
        publicUrl: baseUrl,
        baseUrl,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }

    return {
      publications: [...records.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
      warnings,
      remoteManifestFound
    };
  }

  return {
    siteRoot,
    deployRoot,
    fetchImpl,
    publish,
    syncPublication,
    renamePublication,
    revoke,
    deploySite,
    publicationDir,
    publishSourceFor,
    discoverPublishedPages,
    buildSyncManifest
  };
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
    const snapshots = store.activeSnapshotPublications(report);
    if (snapshots.length === 0) {
      return;
    }
    for (const publication of snapshots) {
      try {
        const pagesConfig = pagesConfigForPublication(publication, configStore.get().pages);
        rememberPublicationPagesTarget(publication, pagesConfig);
        await pagesPublisher.syncPublication({
          report,
          publication,
          pagesConfig
        });
        await store.syncSnapshot(publication.token);
      } catch (error) {
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
      deployQueue
        .enqueue(() => syncReportSnapshots(reportId))
        .catch((error) => onError(error));
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

  return { register, unregister, closeAll };
}

export function createCloudflareAuthManager({
  spawnImpl = spawn,
  loginTimeoutMs = DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS,
  listTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  async function runWrangler(args, timeoutMs, env = {}, cwd) {
    const result = await runSpawnCommand({
      spawnImpl,
      command: "npx",
      args: ["--yes", "wrangler", ...args],
      timeoutMs,
      // Defaults to PROJECT_ROOT in runSpawnCommand when undefined. Callers
      // pass a cwd so any filesystem path can be given as a relative arg
      // instead of an absolute one (see the feedback deploy below).
      cwd,
      env: {
        ...process.env,
        ...env
      }
    });

    if (result.code !== 0) {
      throw appError(
        `Wrangler failed (${result.signal || result.code}).\n${cleanCommandOutput(result.output)}`,
        502
      );
    }

    return result.output;
  }

  // Cached view of the current Wrangler OAuth session so /api/status can report
  // "logged in" without spawning Wrangler on every poll. The probe runs at
  // connect/refresh time; the cache is invalidated whenever login state changes.
  let sessionCache = null;

  async function login(scopes = CLOUDFLARE_OAUTH_SCOPES) {
    const scopedArgs = scopes.flatMap((scope) => ["--scopes", scope]);
    await runWrangler(["login", ...scopedArgs], loginTimeoutMs);
    sessionCache = null;
  }

  async function logout() {
    await runWrangler(["logout"], listTimeoutMs);
    sessionCache = null;
  }

  async function listProjects({ accountId = "" } = {}) {
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    // Try the JSON form, but fall back to the plain-text listing on ANY failure:
    // some Wrangler versions (e.g. 4.63.0) don't support `--json` and exit 1 with
    // a help screen rather than a clean "Unknown argument: json" message.
    try {
      const output = await runWrangler(["pages", "project", "list", "--json"], listTimeoutMs, env);
      const projects = parseWranglerPagesProjects(output);
      if (projects.length > 0) {
        return projects;
      }
    } catch {
      // fall through to the text listing
    }
    const output = await runWrangler(["pages", "project", "list"], listTimeoutMs, env);
    return parseWranglerPagesProjects(output);
  }

  async function loginAndListProjects(options = {}) {
    await login();
    return listProjects(options);
  }

  // List a Pages project's deployment snapshots (the immutable per-deploy
  // <hash>.pages.dev versions). JSON-first with a plain-text fallback, mirroring
  // listProjects(): some Wrangler versions exit 1 on `--json`. Returns the
  // normalized (unflagged) list; callers flag the live one via flagLiveDeployment
  // since the project base URL lives in config, not here.
  async function listDeployments({ projectName, accountId = "" } = {}) {
    const name = normalizePagesProjectName(projectName);
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    try {
      const output = await runWrangler(
        ["pages", "deployment", "list", "--project-name", name, "--json"],
        listTimeoutMs,
        env
      );
      const deployments = parseWranglerPagesDeployments(output);
      if (deployments.length > 0) {
        return deployments;
      }
    } catch {
      // fall through to the text listing
    }
    const output = await runWrangler(
      ["pages", "deployment", "list", "--project-name", name],
      listTimeoutMs,
      env
    );
    return parseWranglerPagesDeployments(output);
  }

  // Delete one deployment snapshot by id. `force` adds --force, required for
  // aliased non-production deployments. Cloudflare refuses the live/latest
  // production deploy regardless — callers should pre-check isLive. On a
  // non-force failure that asks for --force, retry once for non-production
  // deploys only (never force the live production one).
  async function deleteDeployment({ id, projectName, accountId = "", force = false, environment = "" } = {}) {
    const name = normalizePagesProjectName(projectName);
    const deployId = String(id || "").trim();
    if (!deployId) {
      throw appError("A deployment id is required.", 400);
    }
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    const runDelete = async (useForce) => {
      const args = ["pages", "deployment", "delete", deployId, "--project-name", name];
      if (useForce) {
        args.push("--force");
      }
      await runWrangler(args, listTimeoutMs, env);
    };
    try {
      await runDelete(force);
    } catch (error) {
      const message = stripAnsi(error.message || "");
      const needsForce = /--force|aliased|alias/i.test(message);
      if (needsForce && !force && environment && environment !== "production") {
        await runDelete(true);
      } else {
        throw error;
      }
    }
    return { id: deployId, deleted: true };
  }

  // Returns the Cloudflare accounts visible to the current OAuth session.
  // An empty array means "not logged in". Used to auto-detect the account so
  // the user never has to paste an account ID for the single-account case.
  async function whoami() {
    // Prefer the JSON form on newer Wrangler, but fall back to the stable text
    // table whenever `--json` is unsupported or yields nothing. Wrangler 4.63.0
    // exits 1 and prints a help screen for `whoami --json` — that must NOT be
    // read as "logged out", or the app will trigger a needless re-login.
    try {
      const output = await runWrangler(["whoami", "--json"], listTimeoutMs);
      const accounts = parseWranglerWhoamiAccounts(output);
      if (accounts.length > 0) {
        return accounts;
      }
    } catch {
      // fall through to the text whoami
    }
    try {
      const output = await runWrangler(["whoami"], listTimeoutMs);
      return parseWranglerWhoamiAccounts(output);
    } catch (error) {
      const message = stripAnsi(error.message || "");
      if (/not authenticated|not logged in|wrangler login|run `?wrangler login/i.test(message)) {
        return [];
      }
      throw error;
    }
  }

  // Idempotently ensures a Pages project exists so a first-time user can publish
  // without manually creating one in the Cloudflare dashboard.
  async function ensureProject({ projectName, accountId = "", branch = DEFAULT_PAGES_BRANCH } = {}) {
    const name = normalizePagesProjectName(projectName);
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    try {
      await runWrangler(
        ["pages", "project", "create", name, "--production-branch", branch],
        listTimeoutMs,
        env
      );
    } catch (error) {
      const message = stripAnsi(error.message);
      if (/already exists|already taken|name is taken|project with.*name/i.test(message)) {
        return name;
      }
      throw error;
    }
    return name;
  }

  // Provision the feedback Worker: reuse-or-create a KV namespace, stage the
  // worker + a generated wrangler.toml, and deploy it to the account's
  // workers.dev. Returns { url, kvId, workerName, statsToken }. Side-effecting
  // (creates real Cloudflare resources) — only run on explicit user action.
  async function setupFeedback({
    accountId = "",
    workerName = "pagecast-feedback",
    workerSource = "",
    statsToken = "",
    deployDir,
    timeoutMs = 120000
  } = {}) {
    if (!workerSource) {
      throw appError("Feedback Worker source was not found in the package.", 500);
    }
    if (!deployDir) {
      throw appError("A deploy directory is required to set up feedback.", 500);
    }
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    const kvTitle = `${workerName}-store`;

    const provision = async () => {
      // 1. Reuse or create the KV namespace.
      let kvId = "";
      try {
        const listOut = await runWrangler(["kv", "namespace", "list"], timeoutMs, env);
        kvId = findKvNamespaceId(listOut, kvTitle);
      } catch {
        // Listing isn't available/authorized — fall through to create.
      }
      if (!kvId) {
        const createOut = await runWrangler(
          ["kv", "namespace", "create", kvTitle],
          timeoutMs,
          env
        );
        kvId = parseKvNamespaceId(createOut);
      }
      if (!kvId) {
        throw appError("Could not create the feedback KV namespace.", 502);
      }

      // 2. Stage worker.js + a generated wrangler.toml in a clean temp dir.
      await fs.rm(deployDir, { recursive: true, force: true });
      await fs.mkdir(deployDir, { recursive: true });
      await fs.writeFile(path.join(deployDir, "worker.js"), workerSource, "utf8");
      const toml = [
        `name = "${workerName}"`,
        `main = "worker.js"`,
        `compatibility_date = "2024-09-01"`,
        `workers_dev = true`,
        ``,
        `[[kv_namespaces]]`,
        `binding = "PAGECAST_FEEDBACK"`,
        `id = "${kvId}"`,
        ``,
        `[vars]`,
        `PAGECAST_STATS_TOKEN = "${statsToken}"`,
        ``
      ].join("\n");
      await fs.writeFile(path.join(deployDir, "wrangler.toml"), toml, "utf8");

      // 3. Deploy. Wrangler resolves `main` relative to the config file's dir.
      // Run from inside deployDir with a RELATIVE --config so the absolute
      // path (which may contain spaces, e.g. C:\Users\John Doe\...) never
      // crosses the cmd.exe command line when npx is spawned with shell:true
      // on Windows. cwd is passed to spawn natively and is space-safe.
      const deployOut = await runWrangler(
        ["deploy", "--config", "wrangler.toml"],
        timeoutMs,
        env,
        deployDir
      );
      const url = parseWorkerDevUrl(deployOut);
      if (!url) {
        throw appError(
          "Feedback Worker deployed but no workers.dev URL was returned. Enable a workers.dev subdomain in your Cloudflare dashboard, then retry.",
          502
        );
      }
      return { url, kvId, workerName, statsToken };
    };

    try {
      return await provision();
    } catch (error) {
      // The base publishing OAuth lacks Workers/KV permission, surfacing as a
      // Cloudflare "Authentication error [code: 10000]". Elevate the grant to the
      // feedback scopes once, then retry. (No-op if a token is already broad.)
      if (/code:\s*10000|authentication error/i.test(stripAnsi(error.message || ""))) {
        await login(FEEDBACK_OAUTH_SCOPES);
        return await provision();
      }
      throw error;
    }
  }

  function cachedSession() {
    return sessionCache ? sessionCache.value : { loggedIn: false, accounts: [] };
  }

  // Whether the session has ever been probed. False on a fresh boot, so callers
  // can do a one-time refresh to detect an existing Wrangler login instead of
  // reporting "not connected" until the user clicks Connect again.
  function isSessionInitialized() {
    return sessionCache !== null;
  }

  async function refreshSession() {
    let accounts = [];
    try {
      accounts = await whoami();
    } catch {
      accounts = [];
    }
    const value = { loggedIn: accounts.length > 0, accounts };
    sessionCache = { value };
    return value;
  }

  function invalidateSession() {
    sessionCache = null;
  }

  return {
    login,
    logout,
    listProjects,
    loginAndListProjects,
    listDeployments,
    deleteDeployment,
    whoami,
    ensureProject,
    setupFeedback,
    cachedSession,
    isSessionInitialized,
    refreshSession,
    invalidateSession
  };
}

export function createReportStore({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  buildSpawnImpl = spawn,
  buildTimeoutMs = 5 * 60 * 1000,
  recoverFetchImpl = fetch
} = {}) {
  const statePath = path.join(dataDir, "reports.json");
  const uploadRoot = path.join(dataDir, "uploads");
  const importRoot = path.join(dataDir, "imports");
  const workingRoot = path.join(dataDir, "working");
  const reports = new Map();
  let redirects = [];

  function normalizePublication(publication) {
    const kind = publication.kind || "snapshot";
    // Legacy (version-2) publications had no slug; the token doubled as the
    // staged-folder/URL-path key, so backfill slug from token.
    const slug = publication.slug || publication.token;
    return {
      ...publication,
      kind,
      slug,
      // Whether this link was published as a public "drop" (short, guessable
      // slug). Legacy publications default to false (treated as private).
      drop: publication.drop === true,
      publicUrl: kind === "snapshot" ? publication.publicUrl || null : null,
      pagesProjectName: normalizePagesProjectNameSafe(publication.pagesProjectName),
      pagesAccountId: normalizeAccountIdSafe(publication.pagesAccountId),
      pagesAccountName: normalizeAccountName(publication.pagesAccountName || ""),
      pagesBaseUrl: publication.pagesBaseUrl ? stripTrailingSlash(publication.pagesBaseUrl) : "",
      revokedAt: publication.revokedAt || null,
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
    const rootDir = reportSourceRoot(report);
    const entryPath = path.resolve(rootDir, report.entryFile || "index.html");
    if (!isPathInside(rootDir, entryPath)) {
      return true;
    }
    return !existsSync(entryPath);
  }

  async function save() {
    await fs.mkdir(dataDir, { recursive: true });
    const state = {
      version: 3,
      reports: Array.from(reports.values()),
      redirects
    };
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function init() {
    await fs.mkdir(uploadRoot, { recursive: true });
    await fs.mkdir(importRoot, { recursive: true });
    await fs.mkdir(workingRoot, { recursive: true });
    if (!(await pathExists(statePath))) {
      await save();
      return;
    }

    const rawState = await fs.readFile(statePath, "utf8");
    const parsed = safeJsonParse(rawState, { reports: [] });
    redirects = Array.isArray(parsed.redirects)
      ? parsed.redirects
          .filter((entry) => entry && typeof entry.from === "string" && typeof entry.to === "string")
          .map((entry) => ({ from: entry.from, to: entry.to }))
      : [];
    for (const report of parsed.reports || []) {
      if (typeof report?.id === "string" && typeof report?.kind === "string") {
        reports.set(report.id, normalizeReport(report));
      }
    }

    // Group legacy duplicates: before re-publishing reused a report, each publish
    // of the same file created a separate row. Merge same-source path reports
    // into one whose Published links hold every version. Idempotent.
    if (mergeDuplicatePathReports()) {
      await save();
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

  function listRedirects() {
    return redirects.map((entry) => ({ ...entry }));
  }

  // Add a 301 redirect, collapsing chains: if an existing entry pointed at the
  // slug we are now renaming away from, rewrite its target to the new
  // destination so we never need a multi-hop redirect. Dedupes on `from`.
  function addRedirect(from, to) {
    if (!from || !to || from === to) {
      return;
    }
    for (const entry of redirects) {
      if (entry.to === from) {
        entry.to = to;
      }
    }
    const existing = redirects.find((entry) => entry.from === from);
    if (existing) {
      existing.to = to;
    } else {
      redirects.push({ from, to });
    }
    // Drop any self-referential entries produced by collapsing.
    redirects = redirects.filter((entry) => entry.from !== entry.to);
  }

  function formatPublication(publication, { localPublicBaseUrl } = {}) {
    const slug = publication.slug || publication.token;
    const suffix = `/p/${encodeURIComponent(slug)}/`;
    const expiresAt = typeof publication.expiresAt === "number" && publication.expiresAt > 0 ? publication.expiresAt : null;
    const expired = expiresAt !== null && Date.now() > expiresAt;
    // Expired links read as inactive (the edge serves a 410), like revoked ones.
    const active = !publication.revokedAt && !expired;
    const kind = publication.kind || "snapshot";
    return {
      token: publication.token,
      slug,
      label: publication.label,
      kind,
      // Public "drop" (short, guessable slug) vs a private hard-to-guess link.
      drop: publication.drop === true,
      active,
      createdAt: publication.createdAt,
      updatedAt: publication.updatedAt || publication.createdAt,
      revokedAt: publication.revokedAt || null,
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
      .map((publication) => formatPublication(publication, { localPublicBaseUrl }));
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
      localUrl: adminBaseUrl ? joinUrl(adminBaseUrl, previewSuffix) : null,
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
    return report;
  }

  async function addFolderUpload({ files, name = "" }) {
    if (!Array.isArray(files) || files.length === 0) {
      throw appError("Folder upload did not include any files.", 400);
    }
    if (files.length > MAX_FOLDER_UPLOAD_FILES) {
      throw appError(`Folder upload can include at most ${MAX_FOLDER_UPLOAD_FILES} files.`, 413);
    }

    const createdAt = nowIso();
    const id = createReportId(name || files[0].filename || "folder");
    const reportDir = path.join(uploadRoot, id);
    let totalBytes = 0;

    await fs.mkdir(reportDir, { recursive: true });
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
      const destinationPath = path.resolve(reportDir, relativePath);
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
        files
          .map((file) => normalizeAssetRequestPath(file.filename || ""))
          .filter(Boolean)
          .map((relativePath) => relativePath.split(path.sep)[0])
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
    return report;
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

    const result = await runSpawnCommand({
      spawnImpl: buildSpawnImpl,
      command: "sh",
      args: ["-lc", report.buildCommand],
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

    reports.delete(id);
    if (
      report.kind === "upload" ||
      (report.kind === "folder" && (isPathInside(uploadRoot, report.rootDir) || isPathInside(importRoot, report.rootDir)))
    ) {
      await fs.rm(report.rootDir, { recursive: true, force: true });
    }
    if (report.workingDir && isPathInside(workingRoot, report.workingDir)) {
      await fs.rm(report.workingDir, { recursive: true, force: true });
    }
    await save();
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
    // The slug now carries no random tail, so it must be unique on its own.
    // Collect every existing slug (and any legacy name prefix) and re-roll the
    // generated name until it does not collide. A drop gets a short, shareable
    // (guessable) name; otherwise a long, hard-to-guess private name.
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
      // Whether this is a public "drop" (short, guessable slug) vs a private,
      // hard-to-guess link.
      drop: isDrop,
      publicUrl: kind === "snapshot" ? publicUrl : null,
      createdAt,
      updatedAt: createdAt,
      revokedAt: null,
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

  async function importPublishedPage(record, { pagesBaseUrl = "", fetchImpl = fetch } = {}) {
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
    const pagesProjectName = pagesProjectNameFromPublicUrl(publicUrl);
    const publication = {
      token,
      slug: normalized.slug,
      label: normalized.label || "imported",
      kind: "snapshot",
      drop: false,
      publicUrl,
      pagesProjectName,
      pagesAccountId: "",
      pagesAccountName: "",
      pagesBaseUrl: pagesProjectName
        ? `https://${pagesProjectName}.pages.dev`
        : publicUrlOrigin(publicUrl),
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
      match.publication.revokedAt = revokedAt;
      match.report.updatedAt = revokedAt;
      await save();
    }
    return match;
  }

  async function revokeAll(id) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }

    const revokedAt = nowIso();
    let revokedCount = 0;
    for (const publication of report.publications || []) {
      if (!publication.revokedAt) {
        publication.revokedAt = revokedAt;
        revokedCount += 1;
      }
    }

    if (revokedCount > 0) {
      report.updatedAt = revokedAt;
      await save();
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
    const pagesProjectName =
      publication.pagesProjectName || pagesProjectNameFromPublicUrl(publication.publicUrl);
    const localCandidates = [
      slug ? path.join(dataDir, "pages-site", "p", slug) : "",
      pagesProjectName && slug ? path.join(dataDir, "pages-deploy", pagesProjectName, "p", slug) : "",
      pagesProjectName && publication.publicUrl === pagesBaseUrl(pagesProjectName)
        ? path.join(dataDir, "pages-deploy", pagesProjectName)
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
  function protectedPublicationManifest() {
    const manifest = [];
    for (const report of reports.values()) {
      const protectedReport = report.passwordProtected && isValidPasswordHash(report.passwordHash);
      for (const publication of activeSnapshotPublications(report)) {
        const hasExpiry = typeof publication.expiresAt === "number" && publication.expiresAt > 0;
        if (!protectedReport && !hasExpiry) {
          continue;
        }
        const entry = { slug: publication.slug || publication.token };
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
    if (match.publication.kind === "snapshot" && match.publication.publicUrl) {
      const base = match.publication.publicUrl.replace(/\/p\/[^/]+\/?$/, "");
      match.publication.publicUrl = joinUrl(base, `/p/${encodeURIComponent(newSlug)}/`);
    }
    match.publication.updatedAt = updatedAt;
    match.report.updatedAt = updatedAt;
    addRedirect(`/p/${oldSlug}/`, `/p/${newSlug}/`);
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
      redirects = previous.redirects.map((entry) => ({ from: entry.from, to: entry.to }));
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
    return report;
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
    await fs.writeFile(targetPath, html, "utf8");
    report.updatedAt = nowIso();
    await save();
    return report;
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
    addPath,
    addFolder,
    addUpload,
    addFolderUpload,
    buildReport,
    remove,
    draftPublication,
    commitPublication,
    publish,
    importPublishedPage,
    importPublishedPages,
    findPublication,
    findActivePublication,
    findActivePublicationBySlug,
    activeSnapshotPublications,
    protectedPublicationManifest,
    setPublicationExpiry,
    revokePublication,
    revokeAll,
    syncSnapshot,
    renameSlug,
    restorePublicationSlug,
    detachToWorkingCopy,
    readContent,
    writeContent,
    setAutoSync,
    setPasswordProtection,
    reorder,
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

export function extractPublicUrl(text) {
  const urls = String(text).match(/https:\/\/[^\s"'<>]+/g) || [];
  const cleanedUrls = urls.map((url) => url.replace(/[),.]+$/g, ""));
  return cleanedUrls.find((url) => /\.ts\.net/i.test(url)) || null;
}

function tunnelCommandFor(provider, localUrl) {
  if (provider === "tailscale") {
    return {
      command: "tailscale",
      args: ["funnel", "--bg", "--yes", "--https=443", localUrl],
      stopArgs: ["funnel", "--https=443", "off"],
      startupHint: "Start Tailscale and make sure Funnel is enabled for this tailnet."
    };
  }

  throw appError("Pagecast is configured for Tailscale Funnel only.", 400);
}

function hasTailscaleFunnelCapability(capabilities) {
  return capabilities.some(
    (capability) =>
      capability === "funnel" ||
      capability === "https://tailscale.com/cap/funnel" ||
      capability.startsWith("https://tailscale.com/cap/funnel-ports")
  );
}

function terminateChild(child) {
  if (!child) {
    return;
  }

  const hasExited =
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
  if (hasExited) {
    return;
  }

  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    const stillRunning = child.exitCode === null || child.exitCode === undefined;
    if (stillRunning) {
      child.kill("SIGKILL");
    }
  }, 1000);
  timer.unref?.();
}

export class TunnelManager {
  constructor({ localUrl, spawnImpl = spawn, timeoutMs = 30000 } = {}) {
    this.localUrl = localUrl;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.provider = null;
    this.publicUrl = null;
    this.startedAt = null;
    this.logs = [];
  }

  status() {
    return {
      running: Boolean(this.child || this.publicUrl),
      provider: this.provider,
      publicUrl: this.publicUrl,
      localUrl: this.localUrl,
      startedAt: this.startedAt,
      logs: this.logs.slice(-20)
    };
  }

  async start(provider = "tailscale") {
    if (this.publicUrl) {
      return this.status();
    }

    const providers = [provider === "auto" ? "tailscale" : provider];
    const errors = [];

    for (const candidate of providers) {
      try {
        return await this.startProvider(candidate);
      } catch (error) {
        errors.push(`${candidate}: ${error.message}`);
      }
    }

    throw appError(`Could not start a public tunnel. ${errors.join(" ")}`, 502);
  }

  async startProvider(provider) {
    const config = tunnelCommandFor(provider, this.localUrl);
    this.logs = [];
    await this.preflightProvider(provider);
    const result = await this.runCommand(config);

    if (result.code !== 0) {
      throw appError(
        this.withRecentOutput(`${provider} exited before returning a public URL (${result.signal || result.code}).`),
        502
      );
    }

    const publicUrl = extractPublicUrl(result.output);
    if (!publicUrl) {
      throw appError(this.withRecentOutput(`${provider} did not return a public URL.`), 502);
    }

    this.child = null;
    this.provider = provider;
    this.publicUrl = stripTrailingSlash(publicUrl);
    this.startedAt = nowIso();
    return this.status();
  }

  async preflightProvider(provider) {
    if (provider !== "tailscale") {
      return;
    }

    const result = await this.runCommand(
      {
        command: "tailscale",
        args: ["status", "--json"],
        startupHint: "Start Tailscale before starting a public URL."
      },
      { timeoutMs: 10000, recordLogs: false }
    );

    if (result.code !== 0) {
      throw appError(`Tailscale is not running.\n${result.output.trim()}`, 502);
    }

    const status = safeJsonParse(result.output, null);
    if (!status?.Self?.ID) {
      throw appError("Tailscale status did not include this device ID.", 502);
    }

    const capabilities = status.Self.Capabilities || [];
    if (!hasTailscaleFunnelCapability(capabilities)) {
      const nodeId = encodeURIComponent(status.Self.ID);
      throw appError(
        `Tailscale Funnel is not enabled on this tailnet. Enable it here:\nhttps://login.tailscale.com/f/funnel?node=${nodeId}`,
        502
      );
    }
  }

  withRecentOutput(message) {
    const recent = this.logs.slice(-3).join("\n").trim();
    return recent ? `${message}\n${recent}` : message;
  }

  runCommand(config, { timeoutMs = this.timeoutMs, recordLogs = true } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      let output = "";

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        terminateChild(child);
        reject(error);
      };

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const recordOutput = (chunk) => {
        const text = chunk.toString();
        output += text;
        if (recordLogs) {
          this.logs.push(text.trim());
          this.logs = this.logs.filter(Boolean).slice(-50);
        }
      };

      const timer = setTimeout(() => {
        fail(
          appError(
            this.withRecentOutput(`${config.command} did not finish within ${timeoutMs}ms.`),
            504
          )
        );
      }, timeoutMs);
      timer.unref?.();

      try {
        child = this.spawnImpl(config.command, config.args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env
        });
      } catch (error) {
        fail(appError(`${config.command} could not start. ${config.startupHint}`, 502));
        return;
      }

      child.stdout?.on("data", recordOutput);
      child.stderr?.on("data", recordOutput);
      child.on("error", () => {
        fail(appError(`${config.command} could not start. ${config.startupHint}`, 502));
      });
      child.on("exit", (code, signal) => {
        finish({ code, signal, output });
      });
    });
  }

  async stop() {
    if (!this.child && !this.publicUrl) {
      this.provider = null;
      this.publicUrl = null;
      this.startedAt = null;
      return this.status();
    }

    const provider = this.provider;
    const child = this.child;
    if (child) {
      terminateChild(child);
    }
    if (provider) {
      const config = tunnelCommandFor(provider, this.localUrl);
      this.logs = [];
      const result = await this.runCommand(
        { ...config, args: config.stopArgs || config.args },
        { timeoutMs: 10000 }
      );
      if (result.code !== 0) {
        throw appError(
          this.withRecentOutput(`${provider} did not stop cleanly (${result.signal || result.code}).`),
          502
        );
      }
    }

    this.child = null;
    this.provider = null;
    this.publicUrl = null;
    this.startedAt = null;
    return this.status();
  }

  async rotate(provider = "tailscale") {
    await this.stop();
    return this.start(provider);
  }
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
function sendHtmlBody(req, res, file) {
  const buffer = Buffer.isBuffer(file.body) ? file.body : Buffer.from(String(file.body), "utf8");
  res.writeHead(200, {
    "Content-Type": file.contentType || "text/html; charset=utf-8",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(buffer);
}

async function sendFile(req, res, file) {
  res.writeHead(200, {
    "Content-Type": file.contentType || contentTypeFor(file.filePath),
    "Content-Length": file.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
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
      projectCount: projects.length
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
        autoCreated: false
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
        autoCreated: false
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
      baseUrl
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
      autoCreated
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

// DNS-rebinding defense for the admin server. The admin API is unauthenticated
// and can run shell (folder build commands), so it must only answer requests
// addressed to a loopback host. A malicious web page that rebinds its own domain
// to 127.0.0.1 still sends *its* Host header (e.g. "evil.example"), which fails
// this check, while the real admin UI on 127.0.0.1/localhost passes.
export function isLoopbackHostHeader(hostHeader, bindHost, allowedHosts = []) {
  if (!hostHeader) {
    // No Host header (HTTP/1.0, some internal callers) — the request cannot have
    // come from a rebound browser origin, so allow it.
    return true;
  }
  let hostname = String(hostHeader);
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(hostname);
  if (ipv6) {
    // Bracketed IPv6: "[::1]:4173" -> "::1".
    hostname = ipv6[1];
  } else if ((hostname.match(/:/g) || []).length <= 1) {
    // "host:port" or bare "host" — strip a single trailing ":port" only. A value
    // with more than one colon is a bare IPv6 literal (e.g. "::1") and is left
    // intact rather than truncated at its first colon.
    const colon = hostname.lastIndexOf(":");
    if (colon > -1) {
      hostname = hostname.slice(0, colon);
    }
  }
  hostname = hostname.toLowerCase();
  if (hostname === "localhost" || hostname === DEFAULT_LOCAL_HOSTNAME || hostname === "::1") {
    return true;
  }
  // The entire 127.0.0.0/8 block is loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }
  // An explicitly configured non-default bind host is trusted by definition.
  if (bindHost && hostname === String(bindHost).toLowerCase()) {
    return true;
  }
  if (allowedHosts.some((allowedHost) => hostname === String(allowedHost).toLowerCase())) {
    return true;
  }
  return false;
}

// Reflect ONLY a chrome-extension:// Origin (so the Local-to-Public extension can
// read admin-API responses). Never a wildcard — random sites get no CORS grant,
// and browser Private-Network-Access already blocks https→127.0.0.1 anyway.
export function extensionCorsOrigin(originHeader) {
  if (typeof originHeader === "string" && /^chrome-extension:\/\/[a-z]+$/.test(originHeader)) {
    return originHeader;
  }
  return null;
}

export function createAdminHandler({
  store,
  configStore,
  cloudflareAuth,
  pagesPublisher,
  staticDir,
  getAdminBaseUrl,
  getLocalPublicBaseUrl,
  tunnelManager,
  deployQueue,
  watchManager,
  bindHost = DEFAULT_HOST,
  allowedHosts = []
}) {
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

      // Chrome-extension CORS: stash the reflected origin for the senders, and
      // answer the preflight directly.
      const corsOrigin = extensionCorsOrigin(req.headers.origin);
      if (corsOrigin) {
        res.__corsOrigin = corsOrigin;
      }
      if (req.method === "OPTIONS") {
        const headers = { "Cache-Control": "no-store" };
        if (corsOrigin) {
          headers["Access-Control-Allow-Origin"] = corsOrigin;
          headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
          headers["Access-Control-Allow-Headers"] = "Content-Type";
          headers.Vary = "Origin";
        }
        res.writeHead(204, headers);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || DEFAULT_HOST}`);

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, {
          store,
          configStore,
          cloudflareAuth,
          pagesPublisher,
          getAdminBaseUrl,
          getLocalPublicBaseUrl,
          tunnelManager,
          deployQueue,
          watchManager
        });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method not allowed.");
        return;
      }

      const previewMatch = /^\/preview\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (previewMatch) {
        const id = decodeURIComponent(previewMatch[1]);
        const tail = previewMatch[2] || "";
        if (tail === "") {
          res.writeHead(302, { Location: `/preview/${encodeURIComponent(id)}/` });
          res.end();
          return;
        }

        const rawAssetPath = tail === "/" ? "" : tail.slice(1);
        const resolvedAsset = await store.resolveAsset(id, rawAssetPath);
        if (resolvedAsset.statusCode !== 200) {
          sendText(res, resolvedAsset.statusCode, resolvedAsset.message);
          return;
        }

        // Markdown entries resolve with an in-memory rendered HTML body; serve it
        // directly instead of streaming the raw .md file.
        if (resolvedAsset.body !== undefined) {
          sendHtmlBody(req, res, resolvedAsset);
          return;
        }

        await sendFile(req, res, resolvedAsset);
        return;
      }

      await serveStatic(req, res, staticDir, url.pathname);
    } catch (error) {
      sendError(res, error);
    }
  };
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
    getLocalPublicBaseUrl,
    tunnelManager,
    deployQueue,
    watchManager
  }
) {
  const options = reportOptions({ getAdminBaseUrl, getLocalPublicBaseUrl });

  async function syncSnapshotPublication({ report, publication }) {
    await deployQueue.enqueue(async () => {
      const currentPages = configStore.get().pages;
      let pagesConfig = pagesConfigForPublication(publication, currentPages);
      rememberPublicationPagesTarget(publication, pagesConfig);
      try {
        publication.publicUrl = await pagesPublisher.syncPublication({
          report,
          publication,
          pagesConfig
        });
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
      }
    });
    return store.syncSnapshot(publication.token);
  }

  async function revokeSnapshotPublications(publications) {
    for (const publication of publications) {
      if (publication.revokedAt || publication.kind !== "snapshot") {
        continue;
      }
      const slug = publication.slug || publication.token;
      try {
        const pagesConfig = pagesConfigForPublication(publication, configStore.get().pages);
        await deployQueue.enqueue(() => pagesPublisher.revoke([slug], pagesConfig));
      } catch (error) {
        console.warn(`Pagecast could not revoke ${slug} from Cloudflare: ${error?.message || error}`);
      }
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
      admin: { ok: true },
      public: { localBaseUrl: getLocalPublicBaseUrl() },
      cloudflare: {
        ...credential,
        loggedIn: session.loggedIn,
        accounts: session.accounts,
        accountName,
        accountId: pages.accountId || activeAccount?.id || "",
        projectName: pages.projectName,
        baseUrl: pages.baseUrl
      },
      config: configStore.getPublicConfig()
    });
    return;
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    sendJson(res, 200, { config: configStore.getPublicConfig() });
    return;
  }

  if (url.pathname === "/api/config/pages" && req.method === "POST") {
    const body = await readJsonBody(req);
    await configStore.updatePages({
      projectName: body.projectName,
      accountId: body.accountId,
      accountName: body.accountName,
      baseUrl: body.baseUrl
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
    try {
      workerSource = await fs.readFile(workerPath, "utf8");
    } catch {
      sendError(res, appError("Feedback Worker source not found in the package.", 500));
      return;
    }
    const existing = configStore.get().feedback;
    const statsToken = existing?.statsToken || randomBytes(24).toString("hex");
    const dataDir = path.dirname(configStore.configPath);
    try {
      const result = await cloudflareAuth.setupFeedback({
        accountId,
        workerSource,
        statsToken,
        deployDir: path.join(dataDir, "feedback-deploy")
      });
      const config = await configStore.updateFeedback(result);
      sendJson(res, 200, { config, feedback: config.feedback });
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
    const statsUrl =
      `${feedback.url}/api/v1/stats?slug=${encodeURIComponent(slug)}` +
      `&token=${encodeURIComponent(feedback.statsToken)}`;
    try {
      const response = await fetch(statsUrl);
      const data = await response.json().catch(() => ({}));
      sendJson(res, 200, { ok: response.ok, configured: true, ...data });
    } catch {
      sendError(res, appError("Could not reach the feedback service.", 502));
    }
    return;
  }

  if (url.pathname === "/api/cloudflare/login" && req.method === "POST") {
    await readJsonBody(req);
    await cloudflareAuth.login();
    sendJson(res, 200, await detectAndPersistCloudflareProjects({ cloudflareAuth, configStore }));
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
    const sourceReport = store.get(id);
    if (sourceReport?.kind === "folder" && sourceReport.buildCommand) {
      await store.buildReport(id);
    }
    const expiresAt = resolveExpiresAt({ expires: body.expires, defaultExpiry: configStore.get().defaultExpiry });
    const draft = store.draftPublication(id, { label: body.label, kind: "snapshot", expiresAt, drop: body.drop === true });
    // An expiring or password-protected snapshot needs an edge gate built from
    // COMMITTED snapshots, so commit before the first deploy (else it ships
    // ungated until a later redeploy). Deploy in place (syncPublication) and
    // revoke on failure. Plain permanent links keep the publish-then-commit path.
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
    try {
      await deployQueue.enqueue(async () => {
        try {
          draft.publication.publicUrl = await deployOnce();
        } catch (error) {
          // Self-provision and retry once when the failure is a missing Pages
          // project or account, so a snapshot can publish without first visiting
          // the Cloudflare panel.
          if (!isProvisionablePagesError(error)) {
            throw error;
          }
          await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
          draft.publication.publicUrl = await deployOnce();
        }
      });
    } catch (error) {
      if (gated) {
        await store.revokePublication(draft.publication.token).catch(() => {});
      }
      throw error;
    }
    if (gated) {
      await store.syncSnapshot(draft.publication.token);
    } else {
      await store.commitPublication(id, draft.publication);
    }
    const fresh = store.findPublication(draft.publication.token);
    sendJson(res, 201, {
      report: store.formatReport(fresh.report, options),
      publication: store.formatPublication(fresh.publication, options)
    });
    return;
  }

  // One-shot "publish this local file and return the URL" for the Chrome
  // extension. Re-publishing the same file UPDATES the same link in place.
  if (url.pathname === "/api/publish-local" && req.method === "POST") {
    const body = await readJsonBody(req);
    const report = await store.addPath(typeof body.path === "string" ? body.path : "");

    // Deploy (or re-deploy) with the same self-provision retry the snapshot path
    // uses, so a first-time user publishes without visiting the Cloudflare panel.
    const deployWith = async (run) => {
      await deployQueue.enqueue(async () => {
        try {
          await run();
        } catch (error) {
          if (!isProvisionablePagesError(error)) {
            throw error;
          }
          await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
          await run();
        }
      });
    };

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
      const expiresAt = resolveExpiresAt({ expires: body.expires, defaultExpiry: configStore.get().defaultExpiry });
      const draft = store.draftPublication(report.id, { kind: "snapshot", expiresAt });
      // An expiring or password-protected link needs an edge gate built from
      // COMMITTED snapshots, so commit before the first deploy (else it ships
      // ungated until a later redeploy). Deploy in place (syncPublication) and
      // revoke on failure. Plain permanent links keep the publish-then-commit path.
      const gated = Boolean(expiresAt) || store.get(report.id).passwordProtected === true;
      if (gated) {
        await store.commitPublication(report.id, draft.publication);
      }
      try {
        await deployWith(async () => {
          const pagesConfig = configStore.get().pages;
          rememberPublicationPagesTarget(draft.publication, pagesConfig);
          draft.publication.publicUrl = await (gated
            ? pagesPublisher.syncPublication
            : pagesPublisher.publish)({
            report: store.get(report.id),
            publication: draft.publication,
            pagesConfig
          });
        });
      } catch (error) {
        if (gated) {
          await store.revokePublication(draft.publication.token).catch(() => {});
        }
        throw error;
      }
      publication = gated
        ? (await store.syncSnapshot(draft.publication.token)).publication
        : (await store.commitPublication(report.id, draft.publication)).publication;
    }

    const formatted = store.formatPublication(publication, options);
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
      publication: store.formatPublication(publication, options)
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
      await store.setPublicationExpiry(token, previousExpiresAt).catch(() => {});
      throw error;
    }
    const refreshed = store.findPublication(token);
    sendJson(res, 200, {
      report: store.formatReport(refreshed.report, options),
      publication: store.formatPublication(refreshed.publication, options)
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
      publicUrl: existing.publication.publicUrl,
      publicationUpdatedAt: existing.publication.updatedAt,
      reportUpdatedAt: existing.report.updatedAt,
      redirects: store.listRedirects()
    };
    // Validate + reserve the slug (throws 400/409) before any deploy work.
    const { oldSlug, newSlug } = await store.renameSlug(token, body.slug);
    try {
      if (oldSlug !== newSlug && existing.publication.kind === "snapshot") {
        await deployQueue.enqueue(() => {
          const pagesConfig = pagesConfigForPublication(existing.publication, configStore.get().pages);
          rememberPublicationPagesTarget(existing.publication, pagesConfig);
          return pagesPublisher.renamePublication({
            oldSlug,
            newSlug,
            report: existing.report,
            publication: existing.publication,
            pagesConfig
          });
        });
      }
    } catch (error) {
      await store.restorePublicationSlug(token, previous).catch(() => {});
      throw error;
    }
    const refreshed = store.findPublication(token);
    sendJson(res, 200, {
      report: store.formatReport(refreshed.report, options),
      publication: store.formatPublication(refreshed.publication, options)
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
    await revokeSnapshotPublications(reportBeforeRevoke.publications || []);
    const { report, revokedCount } = await store.revokeAll(id);
    sendJson(res, 200, {
      revokedCount,
      report: store.formatReport(report, options)
    });
    return;
  }

  const deleteMatch = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
  if (deleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteMatch[1]);
    const reportBeforeDelete = store.get(id);
    if (reportBeforeDelete) {
      if (watchManager) {
        watchManager.unregister(id);
      }
      await revokeSnapshotPublications(reportBeforeDelete.publications || []);
    }
    const removed = await store.remove(id);
    sendJson(res, removed ? 200 : 404, { removed });
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
    }
    const { report, publication } = await store.revokePublication(token);
    sendJson(res, 200, {
      report: store.formatReport(report, options),
      publication: store.formatPublication(publication, options)
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
    const report = await store.writeContent(id, body.html);
    // Push the edit live to every active snapshot of this report (same URL).
    const snapshots = store.activeSnapshotPublications(report);
    for (const publication of snapshots) {
      await syncSnapshotPublication({ report, publication });
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
    // Capture prior protection state so we can roll back if a deploy fails —
    // persisted state must never claim a protection status the live site lacks.
    const beforeState = store.get(id);
    const prevPasswordState = beforeState
      ? { passwordProtected: beforeState.passwordProtected === true, passwordHash: beforeState.passwordHash || null }
      : null;
    const report = await store.setPasswordProtection(id, {
      enabled: body.enabled === true,
      password: typeof body.password === "string" ? body.password : ""
    });
    // Redeploy active snapshots so the edge gate turns on/off in place at the
    // same URL. Content is unchanged; only the generated middleware differs.
    const snapshots = store.activeSnapshotPublications(report);
    try {
      for (const publication of snapshots) {
        await syncSnapshotPublication({ report, publication });
      }
    } catch (error) {
      if (prevPasswordState) {
        await store
          .setPasswordProtection(id, {
            enabled: prevPasswordState.passwordProtected,
            hash: prevPasswordState.passwordHash
          })
          .catch(() => {});
      }
      throw error;
    }
    sendJson(res, 200, { report: store.formatReport(store.get(id), options) });
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
  pagesDeployTimeoutMs = 180000
} = {}) {
  const store = createReportStore({ dataDir, recoverFetchImpl: fetchImpl });
  await store.init();
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
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
    getRedirects: () => store.listRedirects(),
    getFeedback: () => configStore.get().feedback,
    getBadge: () => configStore.get().badge,
    getProtectedPublications: () => store.protectedPublicationManifest(),
    getAuthCookieSecret: () => configStore.get().authCookieSecret,
    getSyncToken: () => configStore.get().syncSecret
  });
  const deployQueue = createDeployQueue();
  const watchManager = createWatchManager({
    store,
    pagesPublisher,
    configStore,
    deployQueue,
    // Auto-sync runs in the background; surface failures (e.g. expired Cloudflare
    // auth) instead of swallowing them, so a silently-broken watch is visible.
    onError: (error) => {
      console.warn(`Pagecast auto-sync failed: ${error?.message || error}`);
    }
  });
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
  const externalUrlHost =
    urlHost === "127.0.0.1" || urlHost === "::1" ? displayHostname : urlHost;
  const hostForUrl = externalUrlHost.includes(":") ? `[${externalUrlHost}]` : externalUrlHost;

  let lastPortError = null;
  for (const [candidateAdminPort, candidatePublicPort] of localPortCandidates(resolvedAdminPort, resolvedPublicPort)) {
    const publicServer = createServer(createPublicHandler({ store }));
    let actualPublicPort = candidatePublicPort;
    try {
      await listen(publicServer, { host, port: candidatePublicPort });
      actualPublicPort = publicServer.address().port;
    } catch (error) {
      await closeServer(publicServer).catch(() => {});
      if (fallbackAllowed && isPortInUse(error)) {
        lastPortError = error;
        continue;
      }
      throw error;
    }

    const localPublicBaseUrl = `http://${hostForUrl}:${actualPublicPort}`;
    let adminBaseUrl = null;
    const tunnelManager = new TunnelManager({
      localUrl: localPublicBaseUrl,
      spawnImpl,
      timeoutMs: tunnelTimeoutMs
    });

    const adminServer = createServer(
      createAdminHandler({
        store,
        configStore,
        cloudflareAuth,
        pagesPublisher,
        staticDir,
        getAdminBaseUrl: () => adminBaseUrl,
        getLocalPublicBaseUrl: () => localPublicBaseUrl,
        tunnelManager,
        deployQueue,
        watchManager,
        bindHost: urlHost,
        allowedHosts: [displayHostname]
      })
    );

    try {
      await listen(adminServer, { host, port: candidateAdminPort });
    } catch (error) {
      await closeServer(publicServer).catch(() => {});
      if (fallbackAllowed && isPortInUse(error)) {
        lastPortError = error;
        continue;
      }
      throw error;
    }

    const actualAdminPort = adminServer.address().port;
    const adminUrl = `http://${hostForUrl}:${actualAdminPort}`;
    adminBaseUrl = adminUrl;
    if (fallbackAllowed) {
      await configStore.setLocalRuntime({
        hostname: displayHostname,
        adminPort: actualAdminPort,
        publicPort: actualPublicPort
      });
    }

    return {
      adminServer,
      publicServer,
      store,
      configStore,
      cloudflareAuth,
      pagesPublisher,
      tunnelManager,
      deployQueue,
      watchManager,
      adminUrl,
      publicUrl: localPublicBaseUrl,
      async close() {
        watchManager.closeAll();
        await tunnelManager.stop();
        await Promise.all([closeServer(adminServer), closeServer(publicServer)]);
      }
    };
  }

  throw lastPortError || appError("Could not find an available local Pagecast port.", 500);
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
    getProtectedPublications: store ? () => store.protectedPublicationManifest() : () => [],
    getAuthCookieSecret: () => configStore.get().authCookieSecret,
    getSyncToken: () => configStore.get().syncSecret
  });
  return { configStore, cloudflareAuth, pagesPublisher };
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

export async function setupCloudflarePages({
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
  const target = await ensureHeadlessPagesTarget({
    configStore,
    cloudflareAuth,
    projectName,
    accountId,
    accountName,
    baseUrl,
    branch,
    autoCreate: true,
    loginIfNeeded: true
  });
  return {
    config: configStore.getPublicConfig(),
    cloudflare: target.cloudflare
  };
}

// Provision the feedback Worker + KV on the user's account and persist the
// resulting config. Reuses an existing stats token/namespace on re-run.
export async function setupCloudflareFeedback({
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
  try {
    workerSource = await fs.readFile(workerPath, "utf8");
  } catch {
    throw appError("Feedback Worker source not found in the package.", 500);
  }

  const existing = configStore.get().feedback;
  const statsToken = existing?.statsToken || randomBytes(24).toString("hex");

  const result = await cloudflareAuth.setupFeedback({
    accountId: resolvedAccountId,
    workerSource,
    statsToken,
    deployDir: path.join(dataDir, "feedback-deploy")
  });

  const config = await configStore.updateFeedback(result);
  return { config, feedback: config.feedback };
}

export async function getCloudflarePagesStatus({
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
      baseUrl: pages.baseUrl
    }
  };
}

export async function listCloudflarePagesProjects({
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
  const current = await applyPagesSelection({ configStore, accountId });
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
    selectedProject: chooseWranglerPagesProject(projects, configStore.get().pages)
  };
}

// Resolve a headless Cloudflare context for deployment-history commands: the
// configured project + a usable account id, with the same auth/account guards
// as listCloudflarePagesProjects (401 when signed out, 409 when ambiguous).
async function resolveHeadlessDeploymentContext({
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
  const current = await applyPagesSelection({ configStore, accountId });
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

export async function listCloudflarePagesDeployments({
  accountId,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const ctx = await resolveHeadlessDeploymentContext({
    accountId,
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
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

export async function deleteCloudflarePagesDeployment({
  id,
  force = false,
  accountId,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const deployId = String(id || "").trim();
  if (!deployId) {
    throw appError("A deployment id is required.", 400);
  }
  const ctx = await resolveHeadlessDeploymentContext({
    accountId,
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
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

export async function pruneCloudflarePagesDeployments({
  keep,
  accountId,
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  cloudflareAuthSpawnImpl = spawn,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  const keepCount = Number(keep);
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw appError("`keep` must be an integer of at least 1.", 400);
  }
  const ctx = await resolveHeadlessDeploymentContext({
    accountId,
    dataDir,
    cloudflareAuthSpawnImpl,
    cloudflareListTimeoutMs
  });
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

export async function deployCloudflarePagesSite({
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
  if (!projectName) {
    throw appError("Provide --project for direct Pages site deploys.", 400);
  }
  const normalizedBranch = normalizePagesBranch(branch);
  const normalizedSourceDir = await normalizeLocalFolderPath(sourceDir);
  const { configStore, cloudflareAuth, pagesPublisher } = await createHeadlessCloudflareContext({
    dataDir,
    cloudflareAuthSpawnImpl,
    pagesDeploySpawnImpl,
    cloudflareListTimeoutMs,
    pagesDeployTimeoutMs
  });
  await ensureHeadlessPagesTarget({
    configStore,
    cloudflareAuth,
    projectName,
    accountId,
    accountName,
    baseUrl,
    branch: normalizedBranch,
    autoCreate: true,
    loginIfNeeded: false
  });
  const pagesConfig = configStore.get().pages;
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

// Headless one-shot snapshot publish for the CLI / agent skill. Reuses the same
// store, config, auth, and publisher wiring as the server, auto-provisioning the
// Cloudflare account and Pages project, and returns the public URL. Throws a
// structured (statusCode-bearing) error when the user is not signed in, so the
// caller can turn it into clear guidance instead of a stack trace.
export async function publishReportSnapshot({
  path: reportPath,
  label,
  password,
  disableProtection = false,
  expires,
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

  const report = await store.addPath(reportPath);
  // --password sets/replaces protection; --no-password removes it. Otherwise any
  // existing protection on a reused report is left untouched.
  if (typeof password === "string" && password.trim()) {
    await store.setPasswordProtection(report.id, { enabled: true, password });
  } else if (disableProtection) {
    await store.setPasswordProtection(report.id, { enabled: false });
  }

  const draft = store.draftPublication(report.id, {
    label,
    kind: "snapshot",
    expiresAt: resolveExpiresAt({ expires, defaultExpiry: configStore.get().defaultExpiry })
  });
  // A snapshot that's password-protected OR expiring needs an edge gate, whose
  // manifest is built from COMMITTED snapshots — so commit before the first
  // deploy (no window where the page is served ungated). Revoke on deploy
  // failure so we don't leave a dangling active publication with no URL.
  if (store.get(report.id).passwordProtected || draft.publication.expiresAt) {
    await store.commitPublication(report.id, draft.publication);
    try {
      rememberPublicationPagesTarget(draft.publication, configStore.get().pages);
      draft.publication.publicUrl = await pagesPublisher.syncPublication({
        report: store.get(report.id),
        publication: draft.publication,
        pagesConfig: configStore.get().pages
      });
    } catch (error) {
      await store.revokePublication(draft.publication.token).catch(() => {});
      throw error;
    }
    await store.syncSnapshot(draft.publication.token);
  } else {
    rememberPublicationPagesTarget(draft.publication, configStore.get().pages);
    draft.publication.publicUrl = await pagesPublisher.publish({
      report: draft.report,
      publication: draft.publication,
      pagesConfig: configStore.get().pages
    });
    await store.commitPublication(report.id, draft.publication);
  }

  return {
    url: draft.publication.publicUrl,
    token: draft.publication.token,
    label: draft.publication.label,
    projectName: configStore.get().pages.projectName,
    reportId: report.id,
    passwordProtected: store.get(report.id).passwordProtected === true,
    expiresAt: draft.publication.expiresAt || null
  };
}

export async function revokeReportPublication({
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
    await pagesPublisher.revoke(
      [existing.publication.slug || existing.publication.token],
      pagesConfig
    );
  }

  const { report, publication } = await store.revokePublication(publicationToken);
  return {
    report: store.formatReport(report, {}),
    publication: store.formatPublication(publication, {})
  };
}

// Publish (or update in place) the live goal-progress page. Idempotent: the first
// call publishes <file> and records it in config.goal; later calls re-sync the
// SAME slug/URL with the file's new content (never minting a new link). Stop with
// stopGoalProgress. Designed for headless agent use (`npx pagecast goal publish`).
export async function publishGoalProgress({
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
  const absFile = path.resolve(file);

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

  const pagesConfig = () => configStore.get().pages;
  const existing = configStore.get().goal;

  // Stage the goal page from an ISOLATED copy, never the user's folder: a goal
  // file written in the project root would otherwise drag every sibling (and
  // potentially private files) into the published page. We copy just the file
  // into .pagecast/goal-src/ and publish that.
  const goalSrcDir = path.join(dataDir, "goal-src");
  const isHtml = /\.html?$/i.test(absFile);
  const entryName = isHtml ? "index.html" : "goal.md";
  const stagedSource = path.join(goalSrcDir, entryName);
  await fs.rm(goalSrcDir, { recursive: true, force: true });
  await fs.mkdir(goalSrcDir, { recursive: true });
  await fs.copyFile(absFile, stagedSource);

  // UPDATE: the recorded goal page is still active — re-sync the same slug/URL.
  if (existing?.token) {
    const match = store.findActivePublication(existing.token);
    if (match && match.publication.kind === "snapshot") {
      const url = await pagesPublisher.syncPublication({
        report: match.report,
        publication: match.publication,
        pagesConfig: pagesConfig()
      });
      await store.syncSnapshot(existing.token);
      const next = await configStore.setGoal({
        ...existing,
        url,
        file: absFile,
        updatedAt: nowIso()
      });
      return {
        url,
        slug: next.goal.slug,
        token: existing.token,
        started: false,
        recreated: false
      };
    }
    // Recorded link was revoked/removed out-of-band — fall through and recreate.
  }

  // START: publish the isolated copy as a snapshot, then try a vanity slug.
  const report = await store.addPath(stagedSource);
  const draft = store.draftPublication(report.id, { label: "goal", kind: "snapshot" });
  let url = await pagesPublisher.publish({
    report: draft.report,
    publication: draft.publication,
    pagesConfig: pagesConfig()
  });
  await store.commitPublication(report.id, draft.publication);

  let slug = draft.publication.token;
  try {
    const { oldSlug, newSlug } = await store.renameSlug(draft.publication.token, requestedSlug);
    if (oldSlug !== newSlug) {
      url = await pagesPublisher.renamePublication({
        oldSlug,
        newSlug,
        report: draft.report,
        publication: draft.publication,
        pagesConfig: pagesConfig()
      });
      slug = newSlug;
    }
  } catch {
    // Vanity slug taken/reserved/invalid — keep the random token slug.
  }

  const startedAt = existing?.startedAt || nowIso();
  await configStore.setGoal({
    token: draft.publication.token,
    slug,
    url,
    file: absFile,
    startedAt,
    updatedAt: nowIso()
  });
  return {
    url,
    slug,
    token: draft.publication.token,
    started: true,
    recreated: Boolean(existing?.token)
  };
}

export async function getGoalStatus({ dataDir = path.join(PROJECT_ROOT, ".pagecast") } = {}) {
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  return { goal: configStore.get().goal };
}

export async function stopGoalProgress({
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
    if (credential.tokenConfigured || (await cloudflareAuth.refreshSession()).loggedIn) {
      await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
      await pagesPublisher.revoke([goal.slug || goal.token], configStore.get().pages);
    }
    await store.revokePublication(goal.token);
  }
  await configStore.setGoal(null);
  return { stopped: true, url: goal.url };
}

async function main() {
  const runtime = await startServers();
  console.log(`Pagecast admin: ${runtime.adminUrl}`);
  console.log(`Local published-page server: ${runtime.publicUrl}`);
  console.log("Press Ctrl-C to stop.");

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
