import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appError } from "./app-error.js";
import { createWranglerInvocation } from "./platform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_PAGES_PROJECT_NAME = "pagecast";
export const DEFAULT_PAGES_BRANCH = "main";
export const DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS = 60 * 1000;
export const CLOUDFLARE_OAUTH_SCOPES = ["account:read", "user:read", "pages:write"];

// Feedback provisioning needs Workers/KV scopes only after the user opts in.
export const FEEDBACK_OAUTH_SCOPES = [
  "account:read",
  "user:read",
  "pages:write",
  "workers_scripts:write",
  "workers_kv:write"
];

export function stripAnsi(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function cleanCommandOutput(output) {
  return stripAnsi(output)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizePagesProjectName(value) {
  const projectName = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(projectName)) {
    throw appError("Cloudflare Pages project name must be a valid lowercase slug.", 400);
  }
  return projectName;
}

export function normalizePagesProjectNameSafe(value) {
  try {
    return normalizePagesProjectName(value || "");
  } catch {
    return "";
  }
}

export function normalizeAccountId(value) {
  const accountId = String(value || "").trim();
  if (!accountId) {
    return "";
  }
  if (!/^[a-fA-F0-9]{32}$/.test(accountId)) {
    throw appError("Cloudflare account ID must be 32 hex characters.", 400);
  }
  return accountId;
}

export function normalizeAccountIdSafe(value) {
  try {
    return normalizeAccountId(value || "");
  } catch {
    return "";
  }
}

export function normalizePagesBranch(value = DEFAULT_PAGES_BRANCH) {
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

function isRedactedAccountName(value) {
  return /^\(?redacted\)?$/i.test(String(value || "").trim());
}

export function normalizeAccountName(value) {
  const accountName = stripAnsi(value).trim();
  if (!accountName || isRedactedAccountName(accountName)) {
    return "";
  }
  return accountName;
}

export function pagesBaseUrl(projectName) {
  return `https://${projectName}.pages.dev`;
}

export function normalizePagesBaseUrl(value, projectName) {
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
    return `${url.protocol}//${url.host}`.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
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
        // Fall through to the stable public error below.
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

function extractProjectCandidates(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.projects)) return parsed.projects;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.result)) return parsed.result;
  if (Array.isArray(parsed?.result?.projects)) return parsed.result.projects;
  return [];
}

function parseWranglerPagesProjectTable(output) {
  const rows = stripAnsi(output)
    .split(/\r?\n/)
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").slice(1, -1).map((column) => column.trim()))
    .filter((columns) => columns.some(Boolean));
  if (rows.length === 0) return [];

  const headerIndex = rows.findIndex((columns) =>
    columns.some((column) => /^(project\s+)?name$/i.test(column))
  );
  if (headerIndex === -1) return [];

  const headers = rows[headerIndex].map((column) => column.toLowerCase());
  const nameIndex = headers.findIndex((header) => header === "name" || header === "project name");
  const domainIndex = headers.findIndex((header) => header.includes("domain"));
  const branchIndex = headers.findIndex((header) => header.includes("branch"));
  const accountIdIndex = headers.findIndex((header) => header === "account id");
  const accountNameIndex = headers.findIndex((header) => header === "account");

  return rows
    .slice(headerIndex + 1)
    .map((columns) => {
      const name = columns[nameIndex] || "";
      if (!name || /^(name|project name)$/i.test(name)) return null;
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
      const name = firstString(
        project?.name,
        project?.projectName,
        project?.project_name,
        project?.["Project Name"]
      );
      if (!name) return null;

      let projectName;
      try {
        projectName = normalizePagesProjectName(name);
      } catch {
        return null;
      }

      const accountId = normalizeAccountIdSafe(
        firstString(
          project?.accountId,
          project?.account_id,
          project?.account?.id,
          project?.account?.account_id
        )
      );
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
  if (!Array.isArray(projects) || projects.length === 0) return null;
  const preferredName = String(pagesConfig.projectName || "").toLowerCase();
  const preferredAccountId = String(pagesConfig.accountId || "").toLowerCase();
  if (preferredName) {
    const matches = projects.filter((project) => project.name === preferredName);
    if (preferredAccountId) {
      return (
        matches.find(
          (project) => String(project.accountId || "").toLowerCase() === preferredAccountId
        ) ||
        matches[0] ||
        null
      );
    }
    return matches[0] || null;
  }
  return projects.find((project) => project.name === DEFAULT_PAGES_PROJECT_NAME) || null;
}

function parseWranglerWhoamiTable(output) {
  const rows = stripAnsi(output)
    .split(/\r?\n/)
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").slice(1, -1).map((column) => column.trim()))
    .filter((columns) => columns.some(Boolean));
  if (rows.length === 0) return [];

  const headerIndex = rows.findIndex((columns) =>
    columns.some((column) => /account\s*id/i.test(column))
  );
  if (headerIndex === -1) return [];

  const headers = rows[headerIndex].map((column) => column.toLowerCase());
  const idIndex = headers.findIndex((header) => /account\s*id/.test(header));
  const nameIndex = headers.findIndex(
    (header) => /account\s*name/.test(header) || header === "account" || header === "name"
  );
  return rows
    .slice(headerIndex + 1)
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
    if (accounts.length > 0) return accounts;
  }
  return parseWranglerWhoamiTable(output);
}

function parseWranglerPagesDeploymentTable(output) {
  const rows = stripAnsi(output)
    .split(/\r?\n/)
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").slice(1, -1).map((column) => column.trim()))
    .filter((columns) => columns.some(Boolean));
  if (rows.length === 0) return [];

  const headerIndex = rows.findIndex((columns) =>
    columns.some((column) => /deployment\s*id|^id$/i.test(column))
  );
  if (headerIndex === -1) return [];

  const headers = rows[headerIndex].map((column) => column.toLowerCase());
  const idIndex = headers.findIndex((header) => /deployment\s*id|^id$/.test(header));
  const envIndex = headers.findIndex((header) => header.includes("environment"));
  const branchIndex = headers.findIndex((header) => header.includes("branch"));
  const createdIndex = headers.findIndex(
    (header) => header.includes("created") || header.includes("date")
  );
  const urlIndex = headers.findIndex(
    (header) => header.includes("url") || header.includes("source")
  );
  return rows
    .slice(headerIndex + 1)
    .map((columns) => {
      const id = idIndex >= 0 ? columns[idIndex] : "";
      if (!id || /deployment\s*id|^id$/i.test(id)) return null;
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
      const id = firstString(deployment?.id, deployment?.Id, deployment?.deployment_id);
      if (!id) return null;
      const aliases = Array.isArray(deployment?.aliases)
        ? deployment.aliases.filter((alias) => typeof alias === "string")
        : [];
      return {
        id,
        shortId: firstString(deployment?.short_id, deployment?.shortId) || id.slice(0, 8),
        url: firstString(deployment?.url, deployment?.Deployment, deployment?.deployment_url),
        environment: (
          firstString(deployment?.environment, deployment?.Environment) || "preview"
        ).toLowerCase(),
        branch: firstString(
          deployment?.deployment_trigger?.metadata?.branch,
          deployment?.branch,
          deployment?.Branch
        ),
        createdOn: firstString(
          deployment?.created_on,
          deployment?.createdOn,
          deployment?.created_at
        ),
        modifiedOn: firstString(
          deployment?.modified_on,
          deployment?.modifiedOn,
          deployment?.modified_at
        ),
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

export function flagLiveDeployment(deployments, { baseUrl = "" } = {}) {
  const host = String(baseUrl || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const sorted = [...deployments].sort(
    (a, b) => deploymentTimestamp(b) - deploymentTimestamp(a)
  );
  const production = sorted.filter(
    (deployment) => deployment.environment === "production" && !deployment.isSkipped
  );
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

export function selectDeploymentsToPrune(deployments, keep) {
  const keepCount = Math.max(0, Number.isFinite(keep) ? Math.floor(keep) : 0);
  const sorted = [...deployments].sort(
    (a, b) => deploymentTimestamp(b) - deploymentTimestamp(a)
  );
  return sorted
    .slice(keepCount)
    .filter((deployment) => !deployment.isLive)
    .reverse();
}

export function parseKvNamespaceId(output) {
  const match = stripAnsi(output || "").match(
    /(?:id\s*=\s*|"id"\s*:\s*)"([0-9a-f]{32})"/i
  );
  return match ? match[1].toLowerCase() : "";
}

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
    // Unexpected output means no reusable namespace was found.
  }
  return "";
}

export function parseWorkerDevUrl(output) {
  const match = stripAnsi(output || "").match(
    /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i
  );
  return match ? match[0].toLowerCase() : "";
}

export function cloudflareCredentialStatus(env = process.env) {
  const tokenConfigured = Boolean(String(env.CLOUDFLARE_API_TOKEN || "").trim());
  const accountId = normalizeAccountIdSafe(env.CLOUDFLARE_ACCOUNT_ID);
  return {
    authMode: tokenConfigured ? "api-token" : "scoped-oauth",
    tokenConfigured,
    accountIdConfigured: Boolean(accountId),
    accountId,
    scopedOauthAvailable: true,
    oauthScopes: CLOUDFLARE_OAUTH_SCOPES
  };
}

function terminateChild(child) {
  const hasExitCode = child?.exitCode !== null && child?.exitCode !== undefined;
  const hasSignalCode = child?.signalCode !== null && child?.signalCode !== undefined;
  if (!child || hasExitCode || hasSignalCode) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup after a timeout or spawn failure.
  }
}

export async function runSpawnCommand({
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
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
        env,
        shell: process.platform === "win32" && command === "npx"
      });
    } catch {
      fail(appError(`${command} could not start.`, 502));
      return;
    }
    const recordOutput = (chunk) => {
      output += chunk.toString();
    };
    child.stdout?.on("data", recordOutput);
    child.stderr?.on("data", recordOutput);
    child.on("error", () => fail(appError(`${command} could not start.`, 502)));
    const hasReadableStreams = [child.stdout, child.stderr].some(
      (stream) => typeof stream?.read === "function"
    );
    child.on("exit", (code, signal) => {
      // Lightweight injected test adapters may expose EventEmitters instead of
      // real streams. Production children resolve on `close` below so buffered
      // stdout/stderr cannot arrive after the result has already settled.
      if (!hasReadableStreams) {
        finish({ code, signal, output });
      }
    });
    child.on("close", (code, signal) => finish({ code, signal, output }));
  });
}

export function createCloudflareAuthManager({
  spawnImpl = spawn,
  loginTimeoutMs = DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS,
  listTimeoutMs = DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS
} = {}) {
  async function runWrangler(args, timeoutMs, env = {}, cwd) {
    const commandEnv = { ...process.env, ...env };
    const invocation = createWranglerInvocation(args, { env: commandEnv });
    const result = await runSpawnCommand({
      spawnImpl,
      command: invocation.command,
      args: invocation.args,
      timeoutMs,
      cwd,
      env: commandEnv
    });
    if (result.code !== 0) {
      throw appError(
        `Wrangler failed (${result.signal || result.code}).\n${cleanCommandOutput(result.output)}`,
        502
      );
    }
    return result.output;
  }

  let sessionCache = null;

  async function login(scopes = CLOUDFLARE_OAUTH_SCOPES) {
    await runWrangler(
      ["login", ...scopes.flatMap((scope) => ["--scopes", scope])],
      loginTimeoutMs
    );
    sessionCache = null;
  }

  async function logout() {
    await runWrangler(["logout"], listTimeoutMs);
    sessionCache = null;
  }

  async function listProjects({ accountId = "" } = {}) {
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    try {
      const output = await runWrangler(
        ["pages", "project", "list", "--json"],
        listTimeoutMs,
        env
      );
      const projects = parseWranglerPagesProjects(output);
      if (projects.length > 0) return projects;
    } catch {
      // Fall back for Wrangler versions without JSON output.
    }
    return parseWranglerPagesProjects(
      await runWrangler(["pages", "project", "list"], listTimeoutMs, env)
    );
  }

  async function loginAndListProjects(options = {}) {
    await login();
    return listProjects(options);
  }

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
      if (deployments.length > 0) return deployments;
    } catch {
      // Fall back for Wrangler versions without JSON output.
    }
    return parseWranglerPagesDeployments(
      await runWrangler(
        ["pages", "deployment", "list", "--project-name", name],
        listTimeoutMs,
        env
      )
    );
  }

  async function deleteDeployment({
    id,
    projectName,
    accountId = "",
    force = false,
    environment = ""
  } = {}) {
    const name = normalizePagesProjectName(projectName);
    const deployId = String(id || "").trim();
    if (!deployId) throw appError("A deployment id is required.", 400);
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    const runDelete = async (useForce) => {
      const args = ["pages", "deployment", "delete", deployId, "--project-name", name];
      if (useForce) args.push("--force");
      await runWrangler(args, listTimeoutMs, env);
    };
    try {
      await runDelete(force);
    } catch (error) {
      const needsForce = /--force|aliased|alias/i.test(stripAnsi(error.message || ""));
      if (needsForce && !force && environment && environment !== "production") {
        await runDelete(true);
      } else {
        throw error;
      }
    }
    return { id: deployId, deleted: true };
  }

  async function whoami() {
    try {
      const accounts = parseWranglerWhoamiAccounts(
        await runWrangler(["whoami", "--json"], listTimeoutMs)
      );
      if (accounts.length > 0) return accounts;
    } catch {
      // Fall back for Wrangler versions without JSON output.
    }
    try {
      return parseWranglerWhoamiAccounts(await runWrangler(["whoami"], listTimeoutMs));
    } catch (error) {
      if (/not authenticated|not logged in|wrangler login|run `?wrangler login/i.test(
        stripAnsi(error.message || "")
      )) {
        return [];
      }
      throw error;
    }
  }

  async function ensureProject({
    projectName,
    accountId = "",
    branch = DEFAULT_PAGES_BRANCH
  } = {}) {
    const name = normalizePagesProjectName(projectName);
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    try {
      await runWrangler(
        ["pages", "project", "create", name, "--production-branch", branch],
        listTimeoutMs,
        env
      );
    } catch (error) {
      if (/already exists|already taken|name is taken|project with.*name/i.test(
        stripAnsi(error.message)
      )) {
        return name;
      }
      throw error;
    }
    return name;
  }

  async function setupFeedback({
    accountId = "",
    workerName = "pagecast-feedback",
    workerSource = "",
    statsToken = "",
    deployDir,
    timeoutMs = 120000
  } = {}) {
    if (!workerSource) throw appError("Feedback Worker source was not found in the package.", 500);
    if (!deployDir) throw appError("A deploy directory is required to set up feedback.", 500);
    const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
    const kvTitle = `${workerName}-store`;

    const provision = async () => {
      let kvId = "";
      try {
        kvId = findKvNamespaceId(
          await runWrangler(["kv", "namespace", "list"], timeoutMs, env),
          kvTitle
        );
      } catch {
        // A missing listing permission still allows the create attempt below.
      }
      if (!kvId) {
        kvId = parseKvNamespaceId(
          await runWrangler(["kv", "namespace", "create", kvTitle], timeoutMs, env)
        );
      }
      if (!kvId) throw appError("Could not create the feedback KV namespace.", 502);

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
      if (/code:\s*10000|authentication error/i.test(stripAnsi(error.message || ""))) {
        await login(FEEDBACK_OAUTH_SCOPES);
        return provision();
      }
      throw error;
    }
  }

  function cachedSession() {
    return sessionCache ? sessionCache.value : { loggedIn: false, accounts: [] };
  }

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
