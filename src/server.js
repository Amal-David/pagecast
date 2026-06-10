import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, watch as fsWatch } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { markdownToHtml } from "./markdown.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_HOST = "127.0.0.1";
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

function createPublicToken(label) {
  return `${slugifyReportName(label)}-${randomBytes(8).toString("hex")}`;
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
      baseUrl: pagesBaseUrl(projectName)
    },
    feedback: normalizeFeedback(config.feedback)
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
      const name = firstString(project?.name, project?.projectName, project?.project_name);
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
          project?.deployment_configs?.production?.branch
        ),
        baseUrl: pagesBaseUrl(projectName)
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
  // Only adopt a project that is actually requested. If no explicit preference
  // is available, fall back to Pagecast's default project.
  if (preferredName) {
    return projects.find((project) => project.name === preferredName) || null;
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
      child = spawnImpl(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env
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
  if (!schemeMatch) {
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

  async function init() {
    if (!(await pathExists(configPath))) {
      await save();
      return;
    }

    const parsed = safeJsonParse(await fs.readFile(configPath, "utf8"), {});
    config = normalizeConfig(parsed);
    await save();
  }

  function get() {
    return structuredClone(config);
  }

  async function updatePages({ projectName, accountId, accountName } = {}) {
    const nextAccountId = accountId === undefined ? config.pages.accountId : accountId;
    const nextAccountName =
      accountName === undefined && nextAccountId === config.pages.accountId
        ? config.pages.accountName
        : accountName;
    config = normalizeConfig({
      pages: {
        projectName: projectName === undefined ? config.pages.projectName : projectName,
        accountId: nextAccountId,
        accountName: nextAccountName
      }
    });
    await save();
    return get();
  }

  async function updateFeedback(feedback) {
    config = normalizeConfig({
      pages: config.pages,
      feedback: feedback === null ? null : { ...(config.feedback || {}), ...feedback }
    });
    await save();
    return get();
  }

  return {
    init,
    get,
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

export function createCloudflarePagesPublisher({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  spawnImpl = spawn,
  timeoutMs = 180000,
  getRedirects = () => [],
  getFeedback = () => null
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

  async function ensureSiteRoot() {
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
  }

  async function stagePublication(report, publication) {
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
    await fs.writeFile(indexPath, html, "utf8");
  }

  async function removePublication(slug) {
    await fs.rm(publicationDir(slug), { recursive: true, force: true });
  }

  async function runPagesDeploy(rootDir, pagesConfig, branch = DEFAULT_PAGES_BRANCH) {
    const projectName = normalizePagesProjectName(pagesConfig.projectName);
    const accountId = normalizeAccountId(pagesConfig.accountId || "");
    const deployBranch = normalizePagesBranch(branch);

    const args = [
      "--yes",
      "wrangler",
      "pages",
      "deploy",
      rootDir,
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
    await ensureSiteRoot();
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
    await ensureSiteRoot();
    await stagePublication(report, publication);
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
    await ensureSiteRoot();
    await stagePublication(report, publication);
    const baseUrl = await deploy(pagesConfig);
    return joinUrl(baseUrl, `/p/${encodeURIComponent(slug)}/`);
  }

  // Move a publication's staged content from oldSlug to newSlug and redeploy,
  // returning the new public URL.
  async function renamePublication({ oldSlug, newSlug, report, publication, pagesConfig }) {
    await ensureSiteRoot();
    await stagePublication(report, { ...publication, slug: newSlug });
    if (oldSlug && oldSlug !== newSlug) {
      await removePublication(oldSlug);
    }
    const baseUrl = await deploy(pagesConfig);
    return joinUrl(baseUrl, `/p/${encodeURIComponent(newSlug)}/`);
  }

  async function revoke(slugs, pagesConfig) {
    await ensureSiteRoot();
    for (const slug of slugs) {
      await removePublication(slug);
    }
    return deploy(pagesConfig);
  }

  return {
    siteRoot,
    deployRoot,
    publish,
    syncPublication,
    renamePublication,
    revoke,
    deploySite,
    publicationDir,
    publishSourceFor
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
        await pagesPublisher.syncPublication({
          report,
          publication,
          pagesConfig: configStore.get().pages
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
  async function runWrangler(args, timeoutMs, env = {}) {
    const result = await runSpawnCommand({
      spawnImpl,
      command: "npx",
      args: ["--yes", "wrangler", ...args],
      timeoutMs,
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
      const deployOut = await runWrangler(
        ["deploy", "--config", path.join(deployDir, "wrangler.toml")],
        timeoutMs,
        env
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
    whoami,
    ensureProject,
    setupFeedback,
    cachedSession,
    refreshSession,
    invalidateSession
  };
}

export function createReportStore({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  buildSpawnImpl = spawn,
  buildTimeoutMs = 5 * 60 * 1000
} = {}) {
  const statePath = path.join(dataDir, "reports.json");
  const uploadRoot = path.join(dataDir, "uploads");
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
      publicUrl: kind === "snapshot" ? publication.publicUrl || null : null,
      revokedAt: publication.revokedAt || null,
      updatedAt: publication.updatedAt || publication.createdAt
    };
  }

  function normalizeReport(report) {
    const kind = report.kind;
    const defaultSourceMode = kind === "upload" ? "edited-in-pagecast" : "source-tracked";
    return {
      ...report,
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
      publications: Array.isArray(report.publications)
        ? report.publications.map(normalizePublication)
        : []
    };
  }

  function reportSourceRoot(report) {
    return path.resolve(report.workingDir || report.buildOutputRoot || report.rootDir);
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
    const active = !publication.revokedAt;
    const kind = publication.kind || "snapshot";
    return {
      token: publication.token,
      slug,
      label: publication.label,
      kind,
      active,
      createdAt: publication.createdAt,
      updatedAt: publication.updatedAt || publication.createdAt,
      revokedAt: publication.revokedAt || null,
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
    const createdAt = nowIso();
    const report = {
      id: createReportId(normalizedPath),
      kind: "path",
      name: path.basename(normalizedPath),
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
    if (report.kind === "upload" || (report.kind === "folder" && isPathInside(uploadRoot, report.rootDir))) {
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

  function draftPublication(id, { label, kind = "snapshot", publicUrl = null } = {}) {
    const report = reports.get(id);
    if (!report) {
      throw appError("Report was not found.", 404);
    }

    const createdAt = nowIso();
    const cleanLabel = slugifyReportName(label || nextPublicationLabel(report));
    const token = createPublicToken(cleanLabel);
    const publication = {
      token,
      slug: token,
      label: cleanLabel,
      kind,
      publicUrl: kind === "snapshot" ? publicUrl : null,
      createdAt,
      updatedAt: createdAt,
      revokedAt: null
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

  async function publish(id, { label } = {}) {
    const { publication } = draftPublication(id, { label, kind: "snapshot" });
    return commitPublication(id, publication);
  }

  function get(id) {
    return reports.get(id) || null;
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
    const rootDir = reportSourceRoot(report);
    const targetPath = path.resolve(rootDir, report.entryFile);
    if (!isPathInside(rootDir, targetPath)) {
      throw appError("Report content path is not allowed.", 403);
    }
    const html = await fs.readFile(targetPath, "utf8");
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
    findPublication,
    findActivePublication,
    findActivePublicationBySlug,
    activeSnapshotPublications,
    revokePublication,
    revokeAll,
    syncSnapshot,
    renameSlug,
    detachToWorkingCopy,
    readContent,
    writeContent,
    setAutoSync,
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
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

function activeSnapshotSlugs(report) {
  return (report.publications || [])
    .filter((publication) => !publication.revokedAt && publication.kind === "snapshot")
    .map((publication) => publication.slug || publication.token);
}

async function detectAndPersistCloudflareProjects({ cloudflareAuth, configStore }) {
  const currentConfig = configStore.get();
  const projects = await cloudflareAuth.listProjects({
    accountId: currentConfig.pages.accountId
  });
  const selectedProject = chooseWranglerPagesProject(projects, currentConfig.pages);
  const config = selectedProject
    ? await configStore.updatePages({
        projectName: selectedProject.name,
        accountId: selectedProject.accountId || currentConfig.pages.accountId,
        accountName: selectedProject.accountName || currentConfig.pages.accountName
      })
    : currentConfig;

  return {
    config,
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
  const currentConfig = configStore.get();
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

  let config = currentConfig;
  if (selectedProject) {
    config = await configStore.updatePages({
      projectName: selectedProject.name,
      accountId: selectedProject.accountId || accountId,
      accountName: accountName || selectedProject.accountName
    });
  } else if (accountId) {
    config = await configStore.updatePages({
      projectName: currentConfig.pages.projectName,
      accountId,
      accountName
    });
  }

  return {
    config,
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
export function isLoopbackHostHeader(hostHeader, bindHost) {
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
  if (hostname === "localhost" || hostname === "::1") {
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
  return false;
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
  bindHost = DEFAULT_HOST
}) {
  return async function adminHandler(req, res) {
    try {
      if (!isLoopbackHostHeader(req.headers.host, bindHost)) {
        sendText(
          res,
          403,
          "Forbidden: the Pagecast admin server only accepts loopback (localhost) requests."
        );
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

  if (url.pathname === "/api/status" && req.method === "GET") {
    const credential = cloudflareCredentialStatus();
    const session = credential.tokenConfigured
      ? { loggedIn: credential.accountIdConfigured, accounts: [] }
      : cloudflareAuth.cachedSession();
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
      config: configStore.get()
    });
    return;
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    sendJson(res, 200, { config: configStore.get() });
    return;
  }

  if (url.pathname === "/api/config/pages" && req.method === "POST") {
    const body = await readJsonBody(req);
    const config = await configStore.updatePages({
      projectName: body.projectName,
      accountId: body.accountId,
      accountName: body.accountName
    });
    sendJson(res, 200, { config });
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
      config: configStore.get()
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
    const draft = store.draftPublication(id, {
      label: body.label,
      kind: "snapshot"
    });
    await deployQueue.enqueue(async () => {
      try {
        draft.publication.publicUrl = await pagesPublisher.publish({
          report: draft.report,
          publication: draft.publication,
          pagesConfig: configStore.get().pages
        });
      } catch (error) {
        // Self-provision and retry once when the failure is a missing Pages
        // project or account, so a snapshot can publish without first visiting
        // the Cloudflare panel.
        const message = stripAnsi(error.message || "");
        const provisionable =
          /project.*not.*found|could not find.*project|does not exist|no such project|account|select an account/i.test(
            message
          );
        if (!provisionable) {
          throw error;
        }
        await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
        draft.publication.publicUrl = await pagesPublisher.publish({
          report: draft.report,
          publication: draft.publication,
          pagesConfig: configStore.get().pages
        });
      }
    });
    const { report, publication } = await store.commitPublication(id, draft.publication);
    sendJson(res, 201, {
      report: store.formatReport(report, options),
      publication: store.formatPublication(publication, options)
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
    await deployQueue.enqueue(async () => {
      try {
        await pagesPublisher.syncPublication({
          report: existing.report,
          publication: existing.publication,
          pagesConfig: configStore.get().pages
        });
      } catch (error) {
        const message = stripAnsi(error.message || "");
        const provisionable =
          /project.*not.*found|could not find.*project|does not exist|no such project|account|select an account/i.test(
            message
          );
        if (!provisionable) {
          throw error;
        }
        await ensureCloudflarePagesTarget({ cloudflareAuth, configStore });
        await pagesPublisher.syncPublication({
          report: existing.report,
          publication: existing.publication,
          pagesConfig: configStore.get().pages
        });
      }
    });
    const { report, publication } = await store.syncSnapshot(token);
    sendJson(res, 200, {
      report: store.formatReport(report, options),
      publication: store.formatPublication(publication, options)
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
    // Validate + reserve the slug (throws 400/409) before any deploy work.
    const { oldSlug, newSlug } = await store.renameSlug(token, body.slug);
    if (oldSlug !== newSlug && existing.publication.kind === "snapshot") {
      await deployQueue.enqueue(() =>
        pagesPublisher.renamePublication({
          oldSlug,
          newSlug,
          report: existing.report,
          publication: existing.publication,
          pagesConfig: configStore.get().pages
        })
      );
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
    const snapshotSlugs = activeSnapshotSlugs(reportBeforeRevoke);
    if (snapshotSlugs.length > 0) {
      await deployQueue.enqueue(() =>
        pagesPublisher.revoke(snapshotSlugs, configStore.get().pages)
      );
    }
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
      const snapshotSlugs = activeSnapshotSlugs(reportBeforeDelete);
      if (snapshotSlugs.length > 0) {
        await deployQueue.enqueue(() =>
          pagesPublisher.revoke(snapshotSlugs, configStore.get().pages)
        );
      }
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
      const slug = existing.publication.slug || existing.publication.token;
      await deployQueue.enqueue(() =>
        pagesPublisher.revoke([slug], configStore.get().pages)
      );
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
      await deployQueue.enqueue(async () => {
        await pagesPublisher.syncPublication({
          report,
          publication,
          pagesConfig: configStore.get().pages
        });
        await store.syncSnapshot(publication.token);
      });
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

export async function startServers({
  host = DEFAULT_HOST,
  adminPort = Number(process.env.PORT || DEFAULT_ADMIN_PORT),
  publicPort = Number(process.env.PUBLIC_PORT || DEFAULT_PUBLIC_PORT),
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
  staticDir = path.join(PROJECT_ROOT, "public"),
  spawnImpl = spawn,
  tunnelTimeoutMs = 30000,
  cloudflareAuthSpawnImpl = spawn,
  cloudflareLoginTimeoutMs = DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS,
  cloudflareListTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS,
  pagesDeploySpawnImpl = spawn,
  pagesDeployTimeoutMs = 180000
} = {}) {
  const store = createReportStore({ dataDir });
  await store.init();
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  const cloudflareAuth = createCloudflareAuthManager({
    spawnImpl: cloudflareAuthSpawnImpl,
    loginTimeoutMs: cloudflareLoginTimeoutMs,
    listTimeoutMs: cloudflareListTimeoutMs
  });
  const pagesPublisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: pagesDeploySpawnImpl,
    timeoutMs: pagesDeployTimeoutMs,
    getRedirects: () => store.listRedirects(),
    getFeedback: () => configStore.get().feedback
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

  const publicServer = createServer(createPublicHandler({ store }));
  await listen(publicServer, { host, port: publicPort });
  const actualPublicPort = publicServer.address().port;
  const localPublicBaseUrl = `http://${host}:${actualPublicPort}`;
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
      bindHost: host
    })
  );

  try {
    await listen(adminServer, { host, port: adminPort });
  } catch (error) {
    await closeServer(publicServer);
    throw error;
  }

  const actualAdminPort = adminServer.address().port;
  const adminUrl = `http://${host}:${actualAdminPort}`;
  adminBaseUrl = adminUrl;

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

async function createHeadlessCloudflareContext({
  dataDir = path.join(PROJECT_ROOT, ".pagecast"),
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
    timeoutMs: pagesDeployTimeoutMs
  });
  return { configStore, cloudflareAuth, pagesPublisher };
}

async function applyPagesSelection({ configStore, projectName, accountId }) {
  const current = configStore.get();
  const selectedProjectName = projectName ? normalizePagesProjectName(projectName) : current.pages.projectName;
  const selectedAccountId = accountId ? normalizeAccountId(accountId) : current.pages.accountId;
  if (projectName || accountId) {
    await configStore.updatePages({
      projectName: selectedProjectName,
      accountId: selectedAccountId,
      accountName: accountId ? "" : current.pages.accountName
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
  branch = DEFAULT_PAGES_BRANCH,
  autoCreate = true,
  loginIfNeeded = false
} = {}) {
  await applyPagesSelection({ configStore, projectName, accountId });

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
    branch,
    autoCreate: true,
    loginIfNeeded: true
  });
  return {
    config: configStore.get(),
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
    config: configStore.get(),
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

export async function deployCloudflarePagesSite({
  sourceDir,
  projectName,
  accountId,
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
  const draft = store.draftPublication(report.id, { label, kind: "snapshot" });
  draft.publication.publicUrl = await pagesPublisher.publish({
    report: draft.report,
    publication: draft.publication,
    pagesConfig: configStore.get().pages
  });
  await store.commitPublication(report.id, draft.publication);

  return {
    url: draft.publication.publicUrl,
    token: draft.publication.token,
    label: draft.publication.label,
    projectName: configStore.get().pages.projectName,
    reportId: report.id
  };
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
