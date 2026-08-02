import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicWriteJson, WorkspaceLease } from "./state-coordinator.js";

const HOME_DIRECTORY_NAME = ".pagecast";
const HOME_PROFILE_NAME = "home";
const WORKSPACE_METADATA_FILE = "workspace.json";
const WORKSPACE_REGISTRY_FILE = "workspaces.json";
const REPORT_STATE_FILE = "reports.json";
const CONFIG_FILE = "config.json";
const PUBLISHER_OWNER_FILE = "publisher-owner.json";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) {
      return structuredClone(fallback);
    }
    throw new Error(`Pagecast state is corrupt at ${filePath}: ${error.message}`, {
      cause: error
    });
  }
}

function normalizeTarget(config) {
  const pages = config?.pages;
  const accountId = nonEmpty(pages?.accountId);
  const projectName = nonEmpty(pages?.projectName);
  if (!accountId || !projectName) return null;
  return {
    accountId,
    projectName,
    baseUrl: nonEmpty(pages?.baseUrl),
    accountName: nonEmpty(pages?.accountName),
    // Carried so a Home migration keeps the target's custom domain. Identity
    // stays {accountId, projectName}; sameTarget below intentionally ignores
    // this, because a hostname is metadata, not identity.
    customDomain: pages?.customDomain || null
  };
}

function sameTarget(left, right) {
  return Boolean(
    left &&
      right &&
      left.accountId === right.accountId &&
      left.projectName === right.projectName
  );
}

function emptyReportState() {
  return {
    version: 4,
    reports: [],
    redirects: [],
    operations: [],
    pendingDeletions: []
  };
}

function reportIdentity(report) {
  const source = nonEmpty(report?.sourcePath) || nonEmpty(report?.rootDir);
  return `${nonEmpty(report?.kind)}\0${source}`;
}

function collisionSafeReportId(report, workspaceId) {
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${reportIdentity(report)}\0${nonEmpty(report?.id)}`)
    .digest("hex")
    .slice(0, 12);
  return `${nonEmpty(report?.id) || "report"}-${digest}`;
}

function mergePublications(current = [], incoming = []) {
  const byToken = new Map();
  for (const publication of [...current, ...incoming]) {
    const token = nonEmpty(publication?.token);
    if (!token || byToken.has(token)) continue;
    byToken.set(token, publication);
  }
  return Array.from(byToken.values());
}

function mergeReportState(homeState, legacyState, workspaceId, { activate } = {}) {
  const next = structuredClone(homeState || emptyReportState());
  next.version = Math.max(Number(next.version) || 4, 4);
  next.reports = Array.isArray(next.reports) ? next.reports : [];
  next.redirects = Array.isArray(next.redirects) ? next.redirects : [];
  next.operations = Array.isArray(next.operations) ? next.operations : [];
  next.pendingDeletions = Array.isArray(next.pendingDeletions) ? next.pendingDeletions : [];
  if (!activate) return next;

  const byIdentity = new Map(next.reports.map((report) => [reportIdentity(report), report]));
  const byId = new Map(next.reports.map((report) => [report.id, report]));
  for (const rawReport of legacyState?.reports || []) {
    const report = structuredClone(rawReport);
    report.workspaceId = nonEmpty(report.workspaceId) || workspaceId;
    const identity = reportIdentity(report);
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.publications = mergePublications(existing.publications, report.publications);
      continue;
    }
    if (!nonEmpty(report.id) || byId.has(report.id)) {
      report.id = collisionSafeReportId(report, workspaceId);
    }
    next.reports.push(report);
    byIdentity.set(identity, report);
    byId.set(report.id, report);
  }

  const redirectKeys = new Set(
    next.redirects.map((entry) => JSON.stringify([entry.from, entry.to, entry.projectRef || null]))
  );
  for (const redirect of legacyState?.redirects || []) {
    const key = JSON.stringify([redirect.from, redirect.to, redirect.projectRef || null]);
    if (!redirectKeys.has(key)) {
      next.redirects.push(structuredClone(redirect));
      redirectKeys.add(key);
    }
  }
  // Active operation and deletion journals cannot be moved safely between
  // owners. Their counts remain visible in the workspace registry instead.
  return next;
}

export function resolvePagecastHomePaths({
  cwd = process.cwd(),
  homeDir = os.homedir(),
  explicitDataDir = ""
} = {}) {
  const workspaceRoot = path.resolve(cwd);
  if (nonEmpty(explicitDataDir)) {
    const isolatedDataDir = path.resolve(workspaceRoot, explicitDataDir);
    return {
      dataDir: isolatedDataDir,
      workspaceDataDir: isolatedDataDir,
      isolated: true
    };
  }
  return {
    dataDir: path.resolve(homeDir, HOME_DIRECTORY_NAME, HOME_PROFILE_NAME),
    workspaceDataDir: path.join(workspaceRoot, HOME_DIRECTORY_NAME),
    isolated: false
  };
}

async function ensureWorkspaceMetadata(workspaceDataDir, cwd) {
  const metadataPath = path.join(workspaceDataDir, WORKSPACE_METADATA_FILE);
  const existing = await readJson(metadataPath, null);
  if (existing?.id && existing?.root) {
    return existing;
  }
  const metadata = {
    version: 1,
    id: nonEmpty(existing?.id) || randomUUID(),
    root: path.resolve(cwd),
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  await fs.mkdir(workspaceDataDir, { recursive: true, mode: 0o700 });
  await atomicWriteJson(metadataPath, metadata);
  return metadata;
}

async function initializeUnderLease({ dataDir, workspaceDataDir, cwd }) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const workspace = await ensureWorkspaceMetadata(workspaceDataDir, cwd);
  const registryPath = path.join(dataDir, WORKSPACE_REGISTRY_FILE);
  const registry = await readJson(registryPath, { version: 1, workspaces: [] });
  registry.version = 1;
  registry.workspaces = Array.isArray(registry.workspaces) ? registry.workspaces : [];
  const legacyConfigPath = path.join(workspaceDataDir, CONFIG_FILE);
  const legacyReportsPath = path.join(workspaceDataDir, REPORT_STATE_FILE);
  const legacyOwnerPath = path.join(workspaceDataDir, PUBLISHER_OWNER_FILE);
  const homeConfigPath = path.join(dataDir, CONFIG_FILE);
  const homeReportsPath = path.join(dataDir, REPORT_STATE_FILE);
  const homeOwnerPath = path.join(dataDir, PUBLISHER_OWNER_FILE);
  const legacyConfig = await readJson(legacyConfigPath, null);
  const homeConfig = await readJson(homeConfigPath, null);
  const legacyTarget = normalizeTarget(legacyConfig);
  const homeTarget = normalizeTarget(homeConfig);
  const homeHasConfig = Boolean(homeConfig);
  const mode = homeTarget && legacyTarget && !sameTarget(homeTarget, legacyTarget)
    ? "legacy-target"
    : "home";

  // Feedback resources are account-scoped, not Pages-project-scoped. A legacy
  // workspace may therefore hold the only copy of the Worker credentials even
  // when its Pages project is quarantined from Home. Adopt only that feedback
  // block, and only when both profiles name the same Cloudflare account.
  if (
    homeConfig &&
    !homeConfig.feedback &&
    legacyConfig?.feedback &&
    homeTarget?.accountId &&
    homeTarget.accountId === legacyTarget?.accountId
  ) {
    await atomicWriteJson(homeConfigPath, {
      ...homeConfig,
      feedback: structuredClone(legacyConfig.feedback)
    });
  }

  const registered = registry.workspaces.find((entry) => entry.id === workspace.id);
  if (registered) {
    return {
      dataDir,
      workspaceDataDir,
      workspaceId: workspace.id,
      imported: false,
      mode: registered.mode || "home"
    };
  }

  if (!homeHasConfig && legacyConfig) {
    await atomicWriteJson(homeConfigPath, legacyConfig);
    if (await exists(legacyOwnerPath)) {
      await atomicWriteJson(homeOwnerPath, await readJson(legacyOwnerPath));
    }
  }

  const legacyState = await readJson(legacyReportsPath, emptyReportState());
  const homeState = await readJson(homeReportsPath, emptyReportState());
  const merged = mergeReportState(homeState, legacyState, workspace.id, {
    activate: mode === "home"
  });
  await atomicWriteJson(homeReportsPath, merged);

  const now = new Date().toISOString();
  registry.workspaces.push({
    id: workspace.id,
    root: workspace.root,
    legacyDataDir: workspaceDataDir,
    mode,
    importedAt: now,
    legacyTarget: mode === "legacy-target" ? legacyTarget : null,
    quarantinedOperations: Array.isArray(legacyState.operations)
      ? legacyState.operations.length
      : 0,
    quarantinedDeletions: Array.isArray(legacyState.pendingDeletions)
      ? legacyState.pendingDeletions.length
      : 0
  });
  await atomicWriteJson(registryPath, registry);
  return {
    dataDir,
    workspaceDataDir,
    workspaceId: workspace.id,
    imported: true,
    mode
  };
}

export async function initializePagecastHome(options = {}) {
  const paths = resolvePagecastHomePaths(options);
  if (paths.isolated) {
    return {
      ...paths,
      workspaceId: null,
      imported: false,
      mode: "isolated"
    };
  }
  const cwd = path.resolve(options.cwd || process.cwd());
  const lease = new WorkspaceLease(paths.dataDir);
  await lease.acquire({ capability: randomUUID(), role: "migration" });
  try {
    return await initializeUnderLease({ ...paths, cwd });
  } finally {
    await lease.release();
  }
}

// The live daemon already owns the Home lease, so its authenticated command
// service uses this entry point to register another workspace without opening a
// competing writer.
export async function registerPagecastWorkspace({ dataDir, workspaceDataDir, cwd } = {}) {
  if (!nonEmpty(dataDir) || !nonEmpty(workspaceDataDir) || !nonEmpty(cwd)) {
    throw new TypeError("Pagecast workspace registration requires Home, workspace, and root paths.");
  }
  return initializeUnderLease({
    dataDir: path.resolve(dataDir),
    workspaceDataDir: path.resolve(workspaceDataDir),
    cwd: path.resolve(cwd)
  });
}
