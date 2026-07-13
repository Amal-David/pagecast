import { createHmac } from "node:crypto";

// Internal managed-publication service. The compatibility factory in server.js
// supplies platform and policy dependencies so this module stays acyclic and
// remains outside the package root export surface.
export function createPublicationService(options = {}, dependencies = {}) {
  const {
    DEFAULT_OG_IMAGE,
    DEFAULT_PAGES_BRANCH,
    DEFAULT_PAGES_PROJECT_NAME,
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
    publicationTokenFilesystemKey,
    randomBytes,
    renderAuthMiddleware,
    renderRoutesJson,
    runSpawnCommand,
    spawn,
    stripTrailingSlash,
    validateOwnershipMarker
  } = dependencies;
  const {
    dataDir = path.join(PROJECT_ROOT, ".pagecast"),
    spawnImpl = spawn,
    fetchImpl = fetch,
    timeoutMs = 180000,
    getRedirects = () => [],
    getFeedback = () => null,
    getBadge = () => true,
    getProtectedPublications = () => [],
    getPublications = () => [],
    getAuthCookieSecret = () => null,
    getSyncToken = () => "",
    getOwnerId = () => "",
    isTargetManaged = null,
    claimTargetManaged = async () => {}
  } = options;
  // `pages-site` is the legacy v3 mutable root. It is migration input only and
  // is never deployed by the v4 publisher.
  const siteRoot = path.join(dataDir, "pages-site");
  const targetsRoot = path.join(dataDir, "targets");
  const deployRoot = path.join(dataDir, "pages-deploy");
  const publisherOwnerPath = path.join(dataDir, "publisher-owner.json");
  let lastPagesConfig = null;
  let fallbackOwnerId = "";
  let markerSecret = "";
  let fallbackOwnerPromise = null;
  let markerSecretPromise = null;

  function explicitProjectRef(value) {
    try {
      return normalizeProjectRef(value);
    } catch {
      return null;
    }
  }

  async function readPublisherOwnerRecord() {
    try {
      const parsed = JSON.parse(await fs.readFile(publisherOwnerPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) {
        return {};
      }
      throw error;
    }
  }

  async function resolveOwnerId() {
    const injected = String(getOwnerId() || "").trim();
    if (injected) {
      return injected;
    }
    if (fallbackOwnerId) {
      return fallbackOwnerId;
    }
    if (!fallbackOwnerPromise) {
      fallbackOwnerPromise = (async () => {
        const record = await readPublisherOwnerRecord();
        if (typeof record.ownerId === "string" && /^[a-f0-9]{32}$/.test(record.ownerId)) {
          fallbackOwnerId = record.ownerId;
          return fallbackOwnerId;
        }
        const nextOwnerId = randomBytes(16).toString("hex");
        await atomicWriteJson(publisherOwnerPath, { ...record, ownerId: nextOwnerId });
        fallbackOwnerId = nextOwnerId;
        return fallbackOwnerId;
      })();
    }
    try {
      return await fallbackOwnerPromise;
    } finally {
      fallbackOwnerPromise = null;
    }
  }

  async function resolveMarkerSecret() {
    if (markerSecret) {
      return markerSecret;
    }
    if (!markerSecretPromise) {
      markerSecretPromise = (async () => {
        const record = await readPublisherOwnerRecord();
        if (
          typeof record.markerSecret === "string" &&
          /^[a-f0-9]{64}$/.test(record.markerSecret)
        ) {
          markerSecret = record.markerSecret;
          return markerSecret;
        }
        const nextSecret = randomBytes(32).toString("hex");
        await atomicWriteJson(publisherOwnerPath, { ...record, markerSecret: nextSecret });
        markerSecret = nextSecret;
        return markerSecret;
      })();
    }
    try {
      return await markerSecretPromise;
    } finally {
      markerSecretPromise = null;
    }
  }

  async function targetOwnerId(pagesConfig, mode) {
    // Keep the historical owner available for legacy-marker validation, but do
    // not use that formerly-public value as the derivation key.
    await resolveOwnerId();
    const secret = await resolveMarkerSecret();
    const projectRef = normalizeProjectRef(pagesConfig);
    return createHmac("sha256", secret)
      .update(
        [
          "pagecast-project-owner-v2",
          mode,
          projectRef.accountId,
          projectRef.projectName
        ].join("\0"),
        "utf8"
      )
      .digest("hex");
  }

  function targetPaths(pagesConfig) {
    const projectRef = normalizeProjectRef(pagesConfig);
    const key = projectRefFilesystemKey(projectRef);
    const targetRoot = path.join(targetsRoot, key);
    return {
      projectRef,
      key,
      targetRoot,
      snapshotsRoot: path.join(targetRoot, "snapshots"),
      // Operations must not live below targetRoot: a committed generation swaps
      // targetRoot as one unit after remote success.
      operationsRoot: path.join(targetsRoot, ".operations", key),
      lastDeployedRoot: path.join(targetRoot, "last-deployed")
    };
  }

  function snapshotDir(token, pagesConfig) {
    const { snapshotsRoot } = targetPaths(pagesConfig || lastPagesConfig);
    return path.join(snapshotsRoot, publicationTokenFilesystemKey(token));
  }

  function publicationDir(slug, pagesConfig = undefined) {
    const resolvedPagesConfig =
      pagesConfig === undefined ? lastPagesConfig : explicitProjectRef(pagesConfig) && pagesConfig;
    if (!resolvedPagesConfig) {
      return path.join(siteRoot, "p", String(slug));
    }
    return path.join(snapshotDir(slug, resolvedPagesConfig), "content");
  }

  // Returns the directory whose contents should be published for a report: the
  // working copy when the report has been detached/edited in-app, otherwise the
  // original source directory.
  function publishSourceFor(report) {
    return report.workingDir || report.buildOutputRoot || report.rootDir;
  }

  async function readSnapshot(snapshotRoot) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(snapshotRoot, "snapshot.json"), "utf8"));
      if (!metadata?.token || !metadata?.slug) {
        return null;
      }
      return {
        token: String(metadata.token),
        slug: normalizeCustomSlug(metadata.slug),
        updatedAt: metadata.updatedAt || nowIso(),
        root: snapshotRoot,
        contentRoot: path.join(snapshotRoot, "content")
      };
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError || error.statusCode === 400) {
        return null;
      }
      throw error;
    }
  }

  async function recoverDirectorySwap(destination) {
    const parent = path.dirname(destination);
    const basename = path.basename(destination);
    try {
      const entries = await fs.readdir(parent);
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(`${basename}.next-`))
          .map((entry) => fs.rm(path.join(parent, entry), { recursive: true, force: true }))
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const previous = `${destination}.previous`;
    if (!(await pathExists(previous))) {
      return;
    }
    if (await pathExists(destination)) {
      await fs.rm(previous, { recursive: true, force: true });
    } else {
      await fs.rename(previous, destination);
    }
  }

  async function recoverTargetSwaps(pagesConfig) {
    const { targetRoot, snapshotsRoot, lastDeployedRoot } = targetPaths(pagesConfig);
    // v4 generations swap the entire target root. The nested recovery below is
    // retained for pre-generation installs that may have crashed during one of
    // the older per-directory swaps.
    await recoverDirectorySwap(targetRoot);
    await recoverDirectorySwap(lastDeployedRoot);
    let entries = [];
    try {
      entries = await fs.readdir(snapshotsRoot);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    for (const entry of entries) {
      if (entry.endsWith(".previous")) {
        await recoverDirectorySwap(path.join(snapshotsRoot, entry.slice(0, -".previous".length)));
      } else if (entry.includes(".next-")) {
        await fs.rm(path.join(snapshotsRoot, entry), { recursive: true, force: true });
      }
    }
  }

  async function listSnapshots(pagesConfig) {
    const { snapshotsRoot } = targetPaths(pagesConfig);
    await recoverTargetSwaps(pagesConfig);
    let entries = [];
    try {
      entries = await fs.readdir(snapshotsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const snapshots = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const snapshot = await readSnapshot(path.join(snapshotsRoot, entry.name));
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  async function prepareSnapshot(report, publication, pagesConfig, operationRoot) {
    const token = normalizePublicationToken(publication.token);
    const slug = normalizeCustomSlug(publication.slug || token);
    const preparedRoot = path.join(
      operationRoot,
      "prepared",
      publicationTokenFilesystemKey(token)
    );
    const contentRoot = path.join(preparedRoot, "content");
    const sourceRoot = publishSourceFor(report);
    await copyPublicTree(sourceRoot, contentRoot, { excludedRoots: [dataDir] });

    const indexPath = path.join(contentRoot, "index.html");
    let html;
    if (isMarkdownFileName(report.entryFile)) {
      const markdown = await fs.readFile(path.join(sourceRoot, report.entryFile), "utf8");
      html = markdownToHtml(markdown, { title: report.name });
    } else {
      html = await fs.readFile(path.join(sourceRoot, report.entryFile), "utf8");
    }

    const feedback = getFeedback();
    if (feedback?.url && feedback.analyticsEnabled !== false) {
      html = injectFeedbackWidget(html, {
        url: feedback.url,
        slug,
        publicationId: token,
        reactionsEnabled: feedback.reactionsEnabled === true
      });
    }
    const badgeOn = getBadge();
    if (badgeOn) {
      html = injectBadge(html);
    }
    html = injectSocialMeta(html, {
      title: extractTitle(html, report.name),
      description: extractDescription(html),
      url: pagesConfig?.baseUrl
        ? joinUrl(pagesConfig.baseUrl, `/p/${encodeURIComponent(slug)}/`)
        : "",
      image: badgeOn ? DEFAULT_OG_IMAGE : "",
      siteName: badgeOn ? "Pagecast" : ""
    });
    await fs.writeFile(indexPath, html, "utf8");
    const metadata = { token, slug, updatedAt: nowIso() };
    await fs.writeFile(
      path.join(preparedRoot, "snapshot.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8"
    );
    return { ...metadata, root: preparedRoot, contentRoot };
  }

  async function stageTargetGeneration(
    pagesConfig,
    operationRoot,
    { candidateSnapshots = [], excludeTokens = [], lastDeployedSource = null } = {}
  ) {
    const { snapshotsRoot, lastDeployedRoot } = targetPaths(pagesConfig);
    await recoverTargetSwaps(pagesConfig);
    const generationRoot = path.join(operationRoot, "target-generation");
    const generationSnapshotsRoot = path.join(generationRoot, "snapshots");
    const generationLastDeployedRoot = path.join(generationRoot, "last-deployed");
    await fs.rm(generationRoot, { recursive: true, force: true });
    await fs.mkdir(generationRoot, { recursive: true });

    if (await pathExists(snapshotsRoot)) {
      await fs.cp(snapshotsRoot, generationSnapshotsRoot, {
        recursive: true,
        force: true
      });
    } else {
      await fs.mkdir(generationSnapshotsRoot, { recursive: true });
    }
    for (const token of excludeTokens) {
      await fs.rm(
        path.join(generationSnapshotsRoot, publicationTokenFilesystemKey(token)),
        { recursive: true, force: true }
      );
    }
    for (const snapshot of candidateSnapshots) {
      const destination = path.join(
        generationSnapshotsRoot,
        publicationTokenFilesystemKey(snapshot.token)
      );
      await fs.rm(destination, { recursive: true, force: true });
      await fs.cp(snapshot.root, destination, { recursive: true, force: true });
    }

    const deployedSource = lastDeployedSource || lastDeployedRoot;
    if (await pathExists(deployedSource)) {
      await fs.cp(deployedSource, generationLastDeployedRoot, {
        recursive: true,
        force: true
      });
    }
    return generationRoot;
  }

  async function commitTargetGeneration(generationRoot, pagesConfig) {
    const { targetRoot } = targetPaths(pagesConfig);
    const previous = `${targetRoot}.previous`;
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rm(previous, { recursive: true, force: true });
    const hadTarget = await pathExists(targetRoot);
    try {
      if (hadTarget) {
        await fs.rename(targetRoot, previous);
      }
      await fs.rename(generationRoot, targetRoot);
    } catch (error) {
      // If the new generation did not take the canonical path, restore the
      // complete prior generation. Recovery repeats this after a process crash.
      if (!(await pathExists(targetRoot)) && hadTarget && (await pathExists(previous))) {
        await fs.rename(previous, targetRoot).catch(() => {});
      }
      throw error;
    }
    // The switch is committed once generationRoot owns targetRoot. Failure to
    // remove the old generation is recoverable cleanup, not a failed publish.
    await fs.rm(previous, { recursive: true, force: true }).catch(() => {});
  }

  async function commitSnapshot(snapshot, pagesConfig, operationRoot) {
    const ownsOperation = !operationRoot;
    const resolvedOperationRoot =
      operationRoot || (await createOperationRoot(pagesConfig));
    try {
      const generationRoot = await stageTargetGeneration(
        pagesConfig,
        resolvedOperationRoot,
        { candidateSnapshots: [snapshot] }
      );
      await commitTargetGeneration(generationRoot, pagesConfig);
    } finally {
      if (ownsOperation) {
        await fs.rm(resolvedOperationRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function buildSyncManifest(pagesConfig = undefined, rootDir = null) {
    const effectivePagesConfig = pagesConfig || {};
    const explicitTarget = explicitProjectRef(effectivePagesConfig);
    const implicitTarget =
      pagesConfig === undefined && lastPagesConfig ? explicitProjectRef(lastPagesConfig) : null;
    const targetConfig = explicitTarget ? effectivePagesConfig : implicitTarget ? lastPagesConfig : null;
    const baseUrl =
      effectivePagesConfig?.baseUrl ||
      targetConfig?.baseUrl ||
      pagesBaseUrl(
        effectivePagesConfig?.projectName ||
          targetConfig?.projectName ||
          DEFAULT_PAGES_PROJECT_NAME
      );
    const resolvedRoot =
      rootDir || (targetConfig ? targetPaths(targetConfig).lastDeployedRoot : siteRoot);
    const pRoot = path.join(resolvedRoot, "p");
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
      const root = path.join(pRoot, slug);
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

    // A v3 migration creates committed snapshots without claiming that those
    // bytes were deployed by this process. Until the first v4 deploy establishes
    // last-deployed, expose those committed snapshots to local reconciliation.
    if (
      targetConfig &&
      rootDir === null &&
      publications.length === 0 &&
      !(await pathExists(resolvedRoot))
    ) {
      for (const snapshot of await listSnapshots(targetConfig)) {
        const files = await listPublicTreeFiles(snapshot.contentRoot);
        if (!files.includes("index.html") && !files.includes("index.htm")) {
          continue;
        }
        let title = snapshot.slug;
        try {
          const indexName = files.includes("index.html") ? "index.html" : "index.htm";
          const html = await fs.readFile(path.join(snapshot.contentRoot, indexName), "utf8");
          title = extractTitle(html, snapshot.slug) || snapshot.slug;
        } catch {
          title = snapshot.slug;
        }
        publications.push({
          slug: snapshot.slug,
          title,
          files,
          publicUrl: baseUrl
            ? joinUrl(baseUrl, `/p/${encodeURIComponent(snapshot.slug)}/`)
            : "",
          updatedAt: snapshot.updatedAt
        });
      }
    }

    publications.sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      version: 1,
      generatedAt: nowIso(),
      baseUrl,
      publications
    };
  }

  async function ensureSiteRoot(rootDir, pagesConfig = {}, { includedSlugs = null } = {}) {
    await fs.mkdir(rootDir, { recursive: true });
    await fs.rm(path.join(rootDir, "index.html"), { force: true });
    await fs.writeFile(path.join(rootDir, "404.html"), "<!doctype html><title>Not found</title>", "utf8");
    await fs.writeFile(
      path.join(rootDir, "_headers"),
      "/*\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n",
      "utf8"
    );

    const redirects = filterEntriesForTarget(getRedirects(pagesConfig) || [], pagesConfig);
    const redirectsPath = path.join(rootDir, "_redirects");
    if (redirects.length > 0) {
      const lines = redirects
        .map((entry) => `${stripTrailingSlash(entry.from)}/* ${stripTrailingSlash(entry.to)}/:splat 301`)
        .join("\n");
      await fs.writeFile(redirectsPath, `${lines}\n`, "utf8");
    } else {
      await fs.rm(redirectsPath, { force: true });
    }

    const markerPath = path.join(rootDir, PAGECAST_PROJECT_MARKER_FILE);
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      encodeProjectOwnershipMarker({
        ...pagesConfig,
        ownerId: await targetOwnerId(pagesConfig, "publications"),
        mode: "publications"
      }),
      "utf8"
    );

    await writeAuthAssets(rootDir, pagesConfig, { includedSlugs });
  }

  // (Re)generate the edge gate on every deploy. When any publication needs one —
  // password-protected and/or expiring — write functions/_middleware.js (the
  // gate + baked manifest) and a _routes.json scoping the Function to those
  // prefixes only. When none need it, remove both so the site stays pure-static.
  async function writeAuthAssets(rootDir, pagesConfig = {}, { includedSlugs = null } = {}) {
    const manifest = filterEntriesForTarget(
      getProtectedPublications(pagesConfig) || [],
      pagesConfig
    )
      .filter((entry) => includedSlugs === null || includedSlugs.has(entry.slug))
      .filter(
        (entry) =>
          entry &&
          entry.slug &&
          (isValidPasswordHash(entry) ||
            (Number.isFinite(entry.expiresAt) && entry.expiresAt > 0))
      );
    const functionsDir = path.join(rootDir, "functions");
    const middlewarePath = path.join(functionsDir, "_middleware.js");
    const routesPath = path.join(rootDir, "_routes.json");
    const syncToken = String(getSyncToken() || "");
    const syncManifest = syncToken ? await buildSyncManifest(pagesConfig, rootDir) : null;
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

  function filterEntriesForTarget(entries, pagesConfig) {
    return entries.filter((entry) => {
      let storedRef;
      try {
        storedRef = normalizeStoredProjectRef(entry);
      } catch {
        return false;
      }
      // Ambiguous v3 records stay quarantined. The publisher boundary accepts
      // only entries attributed to this exact account/project.
      return storedRef !== null && projectRefEquals(storedRef, pagesConfig);
    });
  }

  async function assertTargetOwnership(pagesConfig) {
    const projectRef = normalizeProjectRef(pagesConfig);
    const explicitlyManaged =
      typeof isTargetManaged === "function" ? await isTargetManaged(projectRef) : null;
    if (explicitlyManaged === true) {
      return projectRef;
    }
    if (pagesConfig?.adoptExisting === true) {
      // Explicit adoption is a local authorization decision. Make it durable
      // before the irreversible remote deploy rather than after target files
      // have already been switched.
      await claimTargetManaged(projectRef);
      return projectRef;
    }
    if (pagesConfig?.baseUrl) {
      let marker = "";
      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          joinUrl(pagesConfig.baseUrl, `/${PAGECAST_PROJECT_MARKER_FILE}`),
          { headers: { Accept: "application/json", "Cache-Control": "no-store" } }
        );
        if (response.ok) {
          marker = await response.text();
        }
      } catch {
        // Adoption remains an explicit local decision even if the marker cannot
        // be reached; without that signal the operation fails closed below.
      }
      if (marker) {
        const derivedOwnership = {
          ownerId: await targetOwnerId(projectRef, "publications"),
          mode: "publications",
          projectRef
        };
        const legacyOwnership = {
          ownerId: await resolveOwnerId(),
          mode: "publications",
          projectRef
        };
        if (
          validateOwnershipMarker(marker, derivedOwnership) ||
          validateOwnershipMarker(marker, legacyOwnership)
        ) {
          // A legacy raw-owner marker remains valid for compatibility, but the
          // next deploy rewrites it with an unlinkable target derivation.
          await claimTargetManaged(projectRef);
          return projectRef;
        }
      }
    }
    throw appError(
      `Cloudflare Pages project ${projectRef.projectName} is not managed by this Pagecast workspace. Confirm adoption before publishing to it.`,
      409
    );
  }

  async function createOperationRoot(pagesConfig) {
    const { operationsRoot } = targetPaths(pagesConfig);
    await fs.mkdir(operationsRoot, { recursive: true });
    return fs.mkdtemp(path.join(operationsRoot, "deploy-"));
  }

  async function materializeDesiredSite(
    pagesConfig,
    { candidateSnapshots = [], excludeTokens = [] } = {}
  ) {
    const operationRoot = await createOperationRoot(pagesConfig);
    try {
      const desiredRoot = path.join(operationRoot, "site");
      const excluded = new Set(excludeTokens.map((token) => String(token)));
      const byToken = new Map();

      for (const snapshot of await listSnapshots(pagesConfig)) {
        if (!excluded.has(snapshot.token)) {
          byToken.set(snapshot.token, snapshot);
        }
      }
      for (const snapshot of candidateSnapshots) {
        if (!excluded.has(snapshot.token)) {
          byToken.set(snapshot.token, snapshot);
        }
      }

      const seenSlugs = new Set();
      for (const snapshot of byToken.values()) {
        if (seenSlugs.has(snapshot.slug)) {
          throw appError(`More than one publication uses the slug ${snapshot.slug}.`, 409);
        }
        seenSlugs.add(snapshot.slug);
        await copyPublicTree(snapshot.contentRoot, path.join(desiredRoot, "p", snapshot.slug));
      }
      await ensureSiteRoot(desiredRoot, pagesConfig, { includedSlugs: seenSlugs });
      return { operationRoot, desiredRoot };
    } catch (error) {
      await fs.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function deployDesired(
    pagesConfig,
    { candidateSnapshots = [], excludeTokens = [], deferCommit = false } = {}
  ) {
    const normalized = normalizeProjectRef(pagesConfig);
    const targetConfig = { ...pagesConfig, ...normalized };
    await assertTargetOwnership(targetConfig);
    const { operationRoot, desiredRoot } = await materializeDesiredSite(targetConfig, {
      candidateSnapshots,
      excludeTokens
    });
    let cleanupOperation = true;
    try {
      // Build the complete next local generation before touching Cloudflare.
      // Once the remote deploy succeeds, the local commit is one root swap.
      const generationRoot = await stageTargetGeneration(targetConfig, operationRoot, {
        candidateSnapshots,
        excludeTokens,
        lastDeployedSource: desiredRoot
      });
      const result = await runPagesDeploy(desiredRoot, targetConfig, DEFAULT_PAGES_BRANCH);
      const commit = async () => {
        try {
          await commitTargetGeneration(generationRoot, targetConfig);
          lastPagesConfig = targetConfig;
        } finally {
          await fs.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
        }
      };
      if (deferCommit) {
        cleanupOperation = false;
        let settled = false;
        return {
          ...result,
          async commit() {
            if (settled) {
              throw appError("Cloudflare Pages deployment was already finalized.", 500);
            }
            settled = true;
            try {
              await commit();
            } catch (error) {
              if (error && typeof error === "object") {
                error.remoteSucceeded = true;
                error.remoteResult = {
                  baseUrl: result.baseUrl,
                  deploymentUrl: result.deploymentUrl
                };
              }
              throw error;
            }
          },
          async discard() {
            if (!settled) {
              settled = true;
              await fs.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
            }
          }
        };
      }
      try {
        await commit();
      } catch (error) {
        if (error && typeof error === "object") {
          error.remoteSucceeded = true;
          error.remoteResult = {
            baseUrl: result.baseUrl,
            deploymentUrl: result.deploymentUrl
          };
        }
        throw error;
      }
      cleanupOperation = false;
      return result;
    } finally {
      if (cleanupOperation) {
        await fs.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
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
    const invocation = createWranglerInvocation([
      "pages",
      "deploy",
      ".",
      "--project-name",
      projectName,
      "--branch",
      deployBranch
    ]);

    // `wrangler pages deploy` does not accept an `--account-id` flag (it errors
    // with "Unknown arguments: account-id" on e.g. 4.63.0). The account is
    // selected via the CLOUDFLARE_ACCOUNT_ID environment variable instead.
    const result = await runSpawnCommand({
      spawnImpl,
      command: invocation.command,
      args: invocation.args,
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
    const result = await deployDesired(pagesConfig);
    return result.baseUrl;
  }

  async function deploySite({ sourceDir, pagesConfig, branch = DEFAULT_PAGES_BRANCH } = {}) {
    const normalizedSourceDir = await normalizeLocalFolderPath(sourceDir);
    const projectName = normalizePagesProjectName(pagesConfig.projectName);
    if (isPathInside(deployRoot, normalizedSourceDir)) {
      throw appError("Cannot deploy Pagecast's internal deploy staging folder.", 400);
    }
    const projectRef = normalizeProjectRef(pagesConfig);
    const stagingRoot = path.join(
      deployRoot,
      "direct",
      projectRefFilesystemKey(projectRef),
      encodeURIComponent(normalizePagesBranch(branch))
    );
    await copyPublicTree(normalizedSourceDir, stagingRoot, { excludedRoots: [dataDir] });
    const markerPath = path.join(stagingRoot, PAGECAST_PROJECT_MARKER_FILE);
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      encodeProjectOwnershipMarker({
        ownerId: await targetOwnerId(projectRef, "direct"),
        mode: "direct",
        projectRef
      }),
      "utf8"
    );
    const result = await runPagesDeploy(stagingRoot, pagesConfig, branch);
    return {
      ...result,
      sourceDir: normalizedSourceDir,
      stagingRoot,
      projectName,
      branch: normalizePagesBranch(branch)
    };
  }

  async function publishPublications({ report, publications, pagesConfig }) {
    if (!Array.isArray(publications) || publications.length === 0) {
      throw appError("At least one publication is required.", 400);
    }
    const normalized = normalizeProjectRef(pagesConfig);
    const resolvedPagesConfig = { ...pagesConfig, ...normalized };
    const preparationRoot = await createOperationRoot(resolvedPagesConfig);
    const prepareCandidates = async () => {
      const candidates = [];
      for (const publication of publications) {
        candidates.push(
          await prepareSnapshot(
            report,
            publication,
            resolvedPagesConfig,
            preparationRoot
          )
        );
      }
      return candidates;
    };
    try {
      const candidates = await prepareCandidates();
      const firstResult = await deployDesired(resolvedPagesConfig, {
        candidateSnapshots: candidates,
        deferCommit: true
      });
      // The first successful remote deploy is real user-visible state. Commit
      // its matching local generation before attempting an optional metadata
      // correction for a Cloudflare-assigned canonical origin.
      await firstResult.commit();
      if (
        firstResult.baseUrl &&
        stripTrailingSlash(firstResult.baseUrl) !==
          stripTrailingSlash(resolvedPagesConfig.baseUrl || "")
      ) {
        resolvedPagesConfig.baseUrl = firstResult.baseUrl;
        let correctiveResult;
        try {
          const canonicalCandidates = await prepareCandidates();
          correctiveResult = await deployDesired(resolvedPagesConfig, {
            candidateSnapshots: canonicalCandidates,
            deferCommit: true
          });
        } catch {
          // The original deployment and its local generation are already
          // committed. A best-effort canonical-meta correction must not turn a
          // successful publish into a reported total failure.
          return firstResult.baseUrl;
        }
        await correctiveResult.commit();
        return correctiveResult.baseUrl || firstResult.baseUrl;
      }
      return firstResult.baseUrl;
    } finally {
      await fs.rm(preparationRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function publish({ report, publication, pagesConfig }) {
    const baseUrl = await publishPublications({
      report,
      publications: [publication],
      pagesConfig
    });
    const slug = normalizeCustomSlug(publication.slug || publication.token);
    return joinUrl(baseUrl, `/p/${encodeURIComponent(slug)}/`);
  }

  // Re-stage and redeploy the selected publication set so every URL updates in
  // place. Report-wide edits pass every link on the target and produce one
  // complete desired-state deploy; single-link mutations keep using one item.
  async function syncPublication({ report, publication, publications, pagesConfig }) {
    const targetPublications =
      Array.isArray(publications) && publications.length > 0
        ? publications
        : [publication];
    const baseUrl = await publishPublications({
      report,
      publications: targetPublications,
      pagesConfig
    });
    const slug = normalizeCustomSlug(publication.slug || publication.token);
    return joinUrl(baseUrl, `/p/${encodeURIComponent(slug)}/`);
  }

  // Move a publication's staged content from oldSlug to newSlug and redeploy,
  // returning the new public URL.
  async function renamePublication({ oldSlug, newSlug, report, publication, pagesConfig }) {
    void oldSlug;
    return publish({
      report,
      publication: { ...publication, slug: normalizeCustomSlug(newSlug) },
      pagesConfig
    });
  }

  async function revoke(slugs, pagesConfig) {
    const normalized = normalizeProjectRef(pagesConfig);
    const resolvedPagesConfig = { ...pagesConfig, ...normalized };
    const revokedSlugs = new Set((slugs || []).map((slug) => normalizeCustomSlug(slug)));
    const excludeTokens = (await listSnapshots(resolvedPagesConfig))
      .filter((snapshot) => revokedSlugs.has(snapshot.slug))
      .map((snapshot) => snapshot.token);
    const result = await deployDesired(resolvedPagesConfig, { excludeTokens });
    return result.baseUrl;
  }

  async function migrateLegacyStaging({ publications = [], redirects = [] } = {}) {
    const migrated = [];
    const quarantined = [];
    const quarantinedRedirects = [];
    const migratedRedirects = [];
    const legacyTargetsBySlug = new Map();

    // Legacy bytes are keyed only by slug. If that one slug is attributed to
    // more than one canonical target, the bytes cannot safely identify which
    // project they came from; every mapping for that slug stays quarantined.
    for (const publication of publications) {
      if (publication?.revokedAt || (publication?.kind && publication.kind !== "snapshot")) {
        continue;
      }
      try {
        const slug = normalizeCustomSlug(publication?.slug || publication?.token);
        const projectRef = normalizeStoredProjectRef(publication, { allowLegacy: true });
        if (projectRef) {
          const targetKeys = legacyTargetsBySlug.get(slug) || new Set();
          targetKeys.add(projectRefFilesystemKey(projectRef));
          legacyTargetsBySlug.set(slug, targetKeys);
        }
      } catch {
        // The main migration loop records malformed records as quarantined.
      }
    }
    const ambiguousLegacySlugs = new Set(
      [...legacyTargetsBySlug.entries()]
        .filter(([, targetKeys]) => targetKeys.size > 1)
        .map(([slug]) => slug)
    );

    for (const publication of publications) {
      if (publication?.revokedAt || (publication?.kind && publication.kind !== "snapshot")) {
        continue;
      }
      const slugValue = publication?.slug || publication?.token;
      let slug;
      try {
        slug = normalizeCustomSlug(slugValue);
      } catch {
        quarantined.push(publication);
        continue;
      }
      if (ambiguousLegacySlugs.has(slug)) {
        quarantined.push(publication);
        continue;
      }

      let projectRef;
      try {
        projectRef = normalizeStoredProjectRef(publication, { allowLegacy: true });
      } catch {
        projectRef = null;
      }
      if (!projectRef) {
        // A pages.dev origin is mutable assignment metadata, not project
        // identity. Never use it to guess an account/project during migration.
        quarantined.push(publication);
        continue;
      }

      const legacyContentRoot = path.join(siteRoot, "p", slug);
      if (!(await pathExists(legacyContentRoot))) {
        quarantined.push(publication);
        continue;
      }

      let token;
      try {
        token = normalizePublicationToken(publication.token || slug);
      } catch {
        quarantined.push(publication);
        continue;
      }
      const destination = snapshotDir(token, projectRef);
      const existingSnapshot = await readSnapshot(destination);
      let existingSnapshotDeployable = false;
      if (existingSnapshot && (await pathExists(existingSnapshot.contentRoot))) {
        try {
          await findFolderEntry(existingSnapshot.contentRoot);
          existingSnapshotDeployable = true;
        } catch {
          existingSnapshotDeployable = false;
        }
      }
      if (!existingSnapshotDeployable) {
        const operationRoot = await createOperationRoot(projectRef);
        try {
          const preparedRoot = path.join(
            operationRoot,
            "prepared",
            publicationTokenFilesystemKey(token)
          );
          const contentRoot = path.join(preparedRoot, "content");
          await copyPublicTree(legacyContentRoot, contentRoot);
          const snapshot = {
            token,
            slug,
            updatedAt: publication.updatedAt || publication.createdAt || nowIso(),
            root: preparedRoot,
            contentRoot
          };
          await fs.writeFile(
            path.join(preparedRoot, "snapshot.json"),
            `${JSON.stringify(
              { token: snapshot.token, slug: snapshot.slug, updatedAt: snapshot.updatedAt },
              null,
              2
            )}\n`,
            "utf8"
          );
          await commitSnapshot(snapshot, projectRef, operationRoot);
        } finally {
          await fs.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
        }
      }
      migrated.push(publication);
    }

    for (const redirect of redirects) {
      let projectRef;
      try {
        projectRef = normalizeStoredProjectRef(redirect);
      } catch {
        projectRef = null;
      }
      projectRef ||= inferLegacyRedirectProjectRef(redirect, publications);
      if (!projectRef) {
        quarantinedRedirects.push(redirect);
      } else {
        migratedRedirects.push({ ...redirect, projectRef });
      }
    }

    return { migrated, quarantined, migratedRedirects, quarantinedRedirects };
  }

  async function discoverPublishedPages({ pagesConfig = {}, syncToken = "" } = {}) {
    const baseUrl = pagesConfig?.baseUrl || pagesBaseUrl(pagesConfig?.projectName || DEFAULT_PAGES_PROJECT_NAME);
    const targetConfig = explicitProjectRef(pagesConfig) ? pagesConfig : null;
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
    const committedSnapshots = targetConfig ? await listSnapshots(targetConfig) : [];
    for (const item of localManifest.publications) {
      const record = normalizeSyncRecord(item, {
        baseUrl: localManifest.baseUrl,
        source: "local-staged"
      });
      if (record) {
        const deployedSourceRoot = targetConfig
          ? path.join(targetPaths(targetConfig).lastDeployedRoot, "p", record.slug)
          : publicationDir(record.slug, null);
        const committedSourceRoot = committedSnapshots.find(
          (snapshot) => snapshot.slug === record.slug
        )?.contentRoot;
        records.set(record.slug, {
          ...records.get(record.slug),
          ...record,
          sourceRoot: (await pathExists(deployedSourceRoot))
            ? deployedSourceRoot
            : committedSourceRoot,
          source: records.has(record.slug) ? "cloudflare+local-staged" : "local-staged"
        });
      }
    }

    const projectName =
      normalizePagesProjectNameSafe(pagesConfig?.projectName) || DEFAULT_PAGES_PROJECT_NAME;
    const projectRootSlug = projectRootImportSlug(projectName);
    const projectDeployRoot = targetConfig
      ? path.join(
          deployRoot,
          "direct",
          projectRefFilesystemKey(targetConfig),
          encodeURIComponent(DEFAULT_PAGES_BRANCH)
        )
      : path.join(deployRoot, projectName);
    try {
      const projectEntry = await findFolderEntry(projectDeployRoot);
      const files = await listPublicTreeFiles(projectDeployRoot);
      let title = projectName;
      try {
        const html = await fs.readFile(path.join(projectDeployRoot, projectEntry), "utf8");
        title = extractTitle(html, title) || title;
      } catch {
        title = projectName;
      }
      if (!records.has(projectRootSlug)) {
        records.set(projectRootSlug, {
          slug: projectRootSlug,
          source: "local-staged-site-root",
          sourceRoot: projectDeployRoot,
          files,
          title,
          label: "recovered",
          token: projectRootSlug,
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

    if (!remoteManifestFound && !records.has(projectRootSlug) && baseUrl) {
      records.set(projectRootSlug, {
        slug: projectRootSlug,
        source: "cloudflare-public-root",
        files: [],
        title: projectName,
        label: "recovered",
        token: projectRootSlug,
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
    // Compatibility accessor: callers that inspected the old mutable staging
    // root now see the last committed materialization for the most recent
    // target. The legacy pages-site directory itself remains migration-only.
    get siteRoot() {
      return lastPagesConfig ? targetPaths(lastPagesConfig).lastDeployedRoot : siteRoot;
    },
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
    buildSyncManifest,
    migrateLegacyStaging,
    targetPaths
  };
}
