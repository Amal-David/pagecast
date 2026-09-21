import { promises as nodeFs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { markdownToHtml } from "./markdown.js";
import { listPublicTreeFiles } from "./publication-files.js";

function isMarkdown(file) { return [".md", ".markdown"].includes(path.extname(file).toLowerCase()); }

// A Worker version is a self-contained snapshot. Never point its manifest at a
// file's parent directory: that would turn unrelated siblings into public data.
export async function materializeWorkerPublishRoot({ dataDir, report, fs = nodeFs } = {}) {
  const sourceRoot = path.resolve(report.workingDir || report.buildOutputRoot || report.rootDir);
  const stagingRoot = path.join(path.resolve(dataDir), "worker-staging", randomBytes(12).toString("hex"));
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  try {
    const entry = path.resolve(sourceRoot, report.entryFile || "index.html");
    const rootPrefix = `${sourceRoot}${path.sep}`;
    if (entry !== sourceRoot && !entry.startsWith(rootPrefix)) throw new Error("Worker publication entry is outside its selected source.");
    const entryStat = await fs.stat(entry);
    if (!entryStat.isFile()) throw new Error("Worker publication entry was not found.");

    if (report.kind === "path") {
      if (isMarkdown(entry)) {
        await fs.writeFile(path.join(stagingRoot, "index.html"), markdownToHtml(await fs.readFile(entry, "utf8")), "utf8");
      } else {
        await fs.copyFile(entry, path.join(stagingRoot, "index.html"));
      }
      return { rootDir: stagingRoot, cleanup: () => fs.rm(stagingRoot, { recursive: true, force: true }) };
    }

    const entryRelative = path.relative(sourceRoot, entry).split(path.sep).join("/");
    const replacesEntry = isMarkdown(entry) || entryRelative !== "index.html";
    let files;
    // The source entry is replaced by index.html below, so the staged tree can
    // never gain a 26th file while normalizing a non-index report.
    try { files = await listPublicTreeFiles(sourceRoot, { maxFiles: 25 }); }
    catch (error) {
      if (error?.message === "public_tree_file_limit") throw new Error("Worker publications support at most 25 files.");
      throw error;
    }
    for (const relative of files) {
      if (replacesEntry && relative === entryRelative) continue;
      const destination = path.join(stagingRoot, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(sourceRoot, relative), destination);
    }
    if (isMarkdown(entry)) {
      await fs.writeFile(path.join(stagingRoot, "index.html"), markdownToHtml(await fs.readFile(entry, "utf8")), "utf8");
    } else if (entryRelative !== "index.html") {
      await fs.copyFile(entry, path.join(stagingRoot, "index.html"));
    }
    return { rootDir: stagingRoot, cleanup: () => fs.rm(stagingRoot, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// Server-owned stores are injected so this module owns the Worker transaction
// without importing server.js back into itself.
export async function publishWorkerSnapshotOneShot({
  path: reportPath, label, password, disableProtection = false, expires,
  contextId = "", workspaceId = "", itemKey = "", mode = "", newLink = false,
  update = "", env = process.env, dataDir, workerFetchImpl = fetch,
  expiresAt: explicitExpiresAt = undefined, linkKind = "unlisted", drop = false,
  attachToReportId = "",
  store: suppliedStore = null, configStore: suppliedConfigStore = null
} = {}, {
  createReportStore, createConfigStore, normalizePublishMode,
  resolvePublicationContext, resolveExpiresAt, appError, fs = nodeFs,
  randomBytes
} = {}) {
  if (!reportPath) throw appError("Provide a path to an HTML report to publish.", 400);
  const store = suppliedStore || createReportStore({ dataDir });
  if (!suppliedStore) await store.init();
  const configStore = suppliedConfigStore || createConfigStore({ dataDir });
  if (!suppliedConfigStore) await configStore.init();
  const publishMode = normalizePublishMode({ mode, newLink, update });
  if (typeof password === "string" && password.trim() && password.trim().length < 12) {
    throw appError("Worker password protection requires a password of at least 12 characters.", 400);
  }
  const publicationContext = resolvePublicationContext({ contextId, workspaceId, itemKey, sourcePath: reportPath, env });
  const attachedReport = attachToReportId ? store.get(attachToReportId) : null;
  if (attachToReportId && !attachedReport) throw appError("The selected Pages report no longer exists.", 404);
  const matched = attachToReportId ? null : store.findPublishMatch({ ...publishMode, contextKey: publicationContext.contextKey });
  if (publishMode.mode === "update" && matched?.publication?.target?.backend !== "workers") {
    throw appError("`--backend workers --update` requires an existing Worker publication; migrate or create a new Worker link instead.", 409);
  }
  const existing = matched?.publication?.target?.backend === "workers" ? matched : null;
  const workerLinkKind = existing?.publication?.target?.linkKind || (existing?.publication?.drop === true ? "public" : (linkKind === "public" || drop === true ? "public" : "unlisted"));
  const sourceStat = await fs.stat(reportPath).catch(() => null);
  if (!sourceStat) throw appError("Report path was not found.", 404);
  const report = attachedReport
    ? await (sourceStat.isDirectory() ? store.replaceSourceWithFolder(attachedReport.id, reportPath) : store.replaceSourceWithPath(attachedReport.id, reportPath))
    : matched
    ? await (sourceStat.isDirectory() ? store.replaceSourceWithFolder(matched.report.id, reportPath) : store.replaceSourceWithPath(matched.report.id, reportPath))
    : await (sourceStat.isDirectory() ? store.addFolder({ folderPath: reportPath }) : store.addPath(reportPath));
  const source = store.get(report.id);
  const operationType = "worker_publish";
  let publication = existing?.publication || null;
  let operation = publication
    ? store.listOperations().find((candidate) => candidate.type === operationType && candidate.token === publication.token)
    : null;
  if (!publication) {
    operation = store.listOperations().find((candidate) => candidate.type === operationType && candidate.reportId === report.id && candidate.publication?.contextKey === publicationContext.contextKey) || null;
    publication = operation?.publication ? structuredClone(operation.publication) : null;
  }
  const persistedWorker = existing?.publication?.target || operation?.worker || null;
  const { profile, client } = await configStore.workerClient(persistedWorker?.profileId, { fetchImpl: workerFetchImpl });
  if (persistedWorker && (profile.profileId !== persistedWorker.profileId || profile.origin !== persistedWorker.origin || profile.ownerId !== persistedWorker.ownerId)) {
    throw appError("The Worker profile recorded by this publication no longer matches its persisted target.", 409);
  }
  const capability = await client.capabilities();
  if (!publication) {
    const draft = store.draftPublication(report.id, { label, kind: "snapshot", drop: workerLinkKind === "public" });
    publication = draft.publication;
    Object.assign(publication, {
      contextKey: publicationContext.contextKey, contextHash: publicationContext.contextHash,
      itemHash: publicationContext.itemHash, workspaceHash: publicationContext.workspaceHash
    });
  }
  if (typeof label === "string" && label.trim()) publication.label = label.trim();
  const expiryWasExplicit = explicitExpiresAt !== undefined || (expires !== undefined && expires !== "");
  publication.expiresAt = explicitExpiresAt === null
    ? null
    : typeof explicitExpiresAt === "number" && explicitExpiresAt > 0
    ? explicitExpiresAt
    : existing && !expiryWasExplicit
    ? publication.expiresAt || null
    : resolveExpiresAt({ expires, defaultExpiry: configStore.get().defaultExpiry });
  const resultingAccessMode = typeof password === "string" && password.trim()
    ? "password"
    : disableProtection
    ? workerLinkKind
    : existing?.publication?.target?.accessMode || workerLinkKind;
  operation = {
    ...(operation || {}), type: operationType, token: publication.token,
    slug: publication.slug || publication.token, reportId: report.id,
    publication: structuredClone(publication), idempotencyKey: operation?.idempotencyKey || randomBytes(18).toString("base64url"),
    worker: { ...(operation?.worker || {}), profileId: profile.profileId, origin: profile.origin, ownerId: profile.ownerId }, remoteSucceeded: false
  };
  await store.beginOperations([operation]);
  const checkpoint = async (worker) => {
    operation = { ...operation, worker: { ...operation.worker, ...worker }, publication: structuredClone(publication) };
    await store.beginOperations([operation]);
  };
  const materialized = await materializeWorkerPublishRoot({ dataDir, report: source, fs });
  try {
    const result = await client.publish({
      rootDir: materialized.rootDir,
      title: publication.label, mode: existing ? "explicit-update" : publishMode.mode === "new" ? "new-link" : publishMode.mode === "upsert" ? "context-upsert" : "create",
      publicationId: existing?.publication?.target?.publicationId,
      contextKey: publicationContext.contextKey || undefined, slug: publication.slug, linkKind: workerLinkKind,
      operation: { idempotencyKey: operation.idempotencyKey, ...operation.worker }, checkpoint,
      beforeActivate: async ({ publicationId, idempotencyKey }) => {
        const expiresAt = publication.expiresAt ? new Date(publication.expiresAt).toISOString() : null;
        if (typeof password === "string" && password.trim()) {
          await client.setAccessPolicy(publicationId, { mode: "password", password: password.trim(), expiresAt }, `${idempotencyKey}:access`);
        } else if (disableProtection || (!existing && publication.expiresAt)) {
          await client.setAccessPolicy(publicationId, { mode: workerLinkKind, expiresAt }, `${idempotencyKey}:access`);
        } else if (existing && expiryWasExplicit) {
          await client.setExpiry(publicationId, expiresAt, `${idempotencyKey}:expiry`);
        }
      }
    });
    publication.slug = result.slug || publication.slug;
    publication.publicUrl = `${profile.origin}/p/${encodeURIComponent(publication.slug)}/`;
    publication.target = { backend: "workers", origin: profile.origin, ownerId: profile.ownerId, profileId: profile.profileId, publicationId: result.publicationId, activeVersionId: result.versionId, linkKind: workerLinkKind, accessMode: resultingAccessMode, allowLoopbackHttp: profile.allowLoopbackHttp === true };
    publication.pending = false;
    if (existing) await store.syncSnapshot(publication.token);
    else await store.commitPublication(report.id, publication);
    await store.clearOperation(operationType, publication.token);
    return { action: existing ? "updated" : "created", contextMatched: Boolean(existing && publishMode.mode === "upsert"), url: publication.publicUrl, token: publication.token, publicationToken: publication.token, publicationId: result.publicationId, versionId: result.versionId, backend: "workers", label: publication.label, reportId: report.id, passwordProtected: resultingAccessMode === "password", linkKind: workerLinkKind, expiresAt: publication.expiresAt || null, worker: { origin: profile.origin, ownerId: profile.ownerId, apiVersion: capability.apiVersion } };
  } catch (error) {
    await store.recordOperationFailure({ ...operation, worker: operation.worker, error }).catch(() => {});
    throw error;
  } finally {
    // Cleanup is not part of the durable publication transaction. A staging
    // filesystem failure must never turn a committed Worker version into a retry.
    await materialized.cleanup().catch(() => {});
  }
}

export async function rollbackWorkerPublication({ token, versionId, dataDir, workerFetchImpl = fetch, store: suppliedStore = null, configStore: suppliedConfigStore = null } = {}, {
  createReportStore, createConfigStore, WorkspaceLease, randomBytes, appError
} = {}) {
  if (!token || !versionId) throw appError("A Worker publication token and version ID are required.", 400);
  const lease = suppliedStore && suppliedConfigStore ? null : new WorkspaceLease(dataDir);
  await lease?.acquire({ capability: randomBytes(32).toString("base64url") });
  try {
    const store = suppliedStore || createReportStore({ dataDir });
    await store.init?.();
    const configStore = suppliedConfigStore || createConfigStore({ dataDir });
    await configStore.init?.();
    const match = store.findPublication(token);
    if (!match?.publication?.target || match.publication.target.backend !== "workers") {
      throw appError("That publication is not a Worker-backed Pagecast link.", 404);
    }
    const { client } = await configStore.workerClient(match.publication.target.profileId, { fetchImpl: workerFetchImpl });
    const prior = store.listOperations().find((operation) => operation.type === "worker_rollback" && operation.token === token && operation.versionId === versionId);
    const operation = {
      ...(prior || {}), type: "worker_rollback", token, slug: match.publication.slug || token,
      reportId: match.report.id, versionId, idempotencyKey: prior?.idempotencyKey || randomBytes(18).toString("base64url"),
      worker: { profileId: match.publication.target.profileId, publicationId: match.publication.target.publicationId }
    };
    await store.beginOperations([operation]);
    try {
      await client.rollback(match.publication.target.publicationId, versionId, operation.idempotencyKey);
      match.publication.target = { ...match.publication.target, activeVersionId: versionId };
      await store.syncSnapshot(token);
      await store.clearOperation("worker_rollback", token);
      return { publication: match.publication, versionId };
    } catch (error) {
      await store.recordOperationFailure({ ...operation, error }).catch(() => {});
      throw error;
    }
  } finally {
    await lease?.release();
  }
}
