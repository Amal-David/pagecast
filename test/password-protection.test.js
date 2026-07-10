import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCloudflarePagesPublisher,
  createConfigStore,
  createReportStore,
  publishReportSnapshot
} from "../src/server.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-pw-"));
}

// Fake `npx wrangler pages deploy` that always succeeds and prints a deployment
// URL the publisher can parse. Records every spawn for assertions.
function fakeDeploySpawn() {
  const captured = [];
  function spawnImpl(command, args, options) {
    captured.push({ command, args, env: options?.env || {} });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("https://abcdef123456.pagecast.pages.dev/"));
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return child;
  }
  return { spawnImpl, captured };
}

async function setup() {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  // A MULTI-FILE report: edge protection must cover the asset too, which the old
  // single-file client-side model could not do.
  await fs.writeFile(path.join(reportDir, "index.html"), '<link rel="stylesheet" href="style.css"><h1>Secret Report</h1>');
  await fs.writeFile(path.join(reportDir, "style.css"), "body { color: red; }");

  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    adoptExisting: true
  });
  const store = createReportStore({ dataDir });
  await store.init();
  const { spawnImpl } = fakeDeploySpawn();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl,
    timeoutMs: 5000,
    getRedirects: () => store.listRedirects(),
    getFeedback: () => configStore.get().feedback,
    getBadge: () => configStore.get().badge,
    getProtectedPublications: () => store.protectedPublicationManifest(),
    getAuthCookieSecret: () => configStore.get().authCookieSecret,
    getOwnerId: () => configStore.getOwnerId(),
    isTargetManaged: (projectRef) => configStore.isTargetManaged(projectRef),
    claimTargetManaged: (projectRef) => configStore.claimManagedTarget(projectRef)
  });

  // Publish once (unprotected) so an active snapshot exists.
  const added = await store.addPath(path.join(reportDir, "index.html"));
  const draft = store.draftPublication(added.id, { kind: "snapshot" });
  Object.assign(draft.publication, {
    pagesProjectName: configStore.get().pages.projectName,
    pagesAccountId: configStore.get().pages.accountId,
    pagesBaseUrl: configStore.get().pages.baseUrl,
    projectRef: configStore.get().pages
  });
  draft.publication.publicUrl = await publisher.publish({
    report: draft.report,
    publication: draft.publication,
    pagesConfig: configStore.get().pages
  });
  await store.commitPublication(added.id, draft.publication);

  const slug = draft.publication.slug || draft.publication.token;
  return { dataDir, store, configStore, publisher, reportId: added.id, slug };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function syncActive({ store, publisher, configStore, reportId }) {
  const report = store.get(reportId);
  for (const publication of store.activeSnapshotPublications(report)) {
    await publisher.syncPublication({ report, publication, pagesConfig: configStore.get().pages });
    await store.syncSnapshot(publication.token);
  }
}

test("unprotected report deploys no edge function", async () => {
  const { publisher } = await setup();
  assert.equal(await exists(path.join(publisher.siteRoot, "functions", "_middleware.js")), false);
  assert.equal(await exists(path.join(publisher.siteRoot, "_routes.json")), false);
});

test("enabling protection bakes the gate (covering assets) and keeps content plain", async () => {
  const ctx = await setup();
  const { store, publisher, reportId, slug } = ctx;

  await store.setPasswordProtection(reportId, { enabled: true, password: "open sesame" });
  await syncActive(ctx);

  const middlewarePath = path.join(publisher.siteRoot, "functions", "_middleware.js");
  const routesPath = path.join(publisher.siteRoot, "_routes.json");
  assert.equal(await exists(middlewarePath), true, "middleware should be generated");
  assert.equal(await exists(routesPath), true, "routes should be generated");

  // _routes.json scopes the Function to this slug only.
  const routes = JSON.parse(await fs.readFile(routesPath, "utf8"));
  assert.deepEqual(routes.include, [`/p/${slug}/*`]);

  // The middleware bakes in this slug and the report's stored hash.
  const middleware = await fs.readFile(middlewarePath, "utf8");
  const persisted = JSON.parse(await fs.readFile(path.join(ctx.dataDir, "reports.json"), "utf8"));
  const persistedReport = persisted.reports.find((r) => r.id === reportId);
  assert.ok(persistedReport.passwordHash?.hash, "hash should persist in state.json");
  assert.ok(middleware.includes(slug), "middleware references the slug");
  assert.ok(middleware.includes(persistedReport.passwordHash.hash), "middleware bakes the hash");

  // Content is deployed PLAIN (gated at the edge): both the HTML and its asset
  // are present and unencrypted in the publication dir.
  const stagedHtml = await fs.readFile(path.join(publisher.publicationDir(slug), "index.html"), "utf8");
  assert.ok(stagedHtml.includes("<h1>Secret Report</h1>"), "html stays plain");
  assert.equal(await exists(path.join(publisher.publicationDir(slug), "style.css")), true, "asset is staged");
});

test("disabling protection removes the gate", async () => {
  const ctx = await setup();
  const { store, publisher, reportId } = ctx;

  await store.setPasswordProtection(reportId, { enabled: true, password: "pw" });
  await syncActive(ctx);
  assert.equal(await exists(path.join(publisher.siteRoot, "functions", "_middleware.js")), true);

  await store.setPasswordProtection(reportId, { enabled: false });
  await syncActive(ctx);
  assert.equal(await exists(path.join(publisher.siteRoot, "functions", "_middleware.js")), false);
  assert.equal(await exists(path.join(publisher.siteRoot, "_routes.json")), false);
});

test("the password hash is never serialized to the API, only persisted on disk", async () => {
  const ctx = await setup();
  const { store, reportId, dataDir } = ctx;
  await store.setPasswordProtection(reportId, { enabled: true, password: "topsecret" });

  const formatted = store.formatReport(store.get(reportId), {});
  assert.equal(formatted.passwordProtected, true);
  const serialized = JSON.stringify(formatted);
  assert.equal(serialized.includes("passwordHash"), false);
  assert.equal(serialized.includes("topsecret"), false);
  // But the actual lock IS persisted server-side for the next deploy.
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"));
  const persistedReport = persisted.reports.find((r) => r.id === reportId);
  assert.ok(persistedReport.passwordHash?.salt && persistedReport.passwordHash?.hash);
});

// A combined fake that answers Wrangler auth probes (whoami / project list) and
// records pages deploys, so the headless publish path runs end-to-end offline.
function headlessFakes() {
  function authSpawn(command, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      let output = "";
      if (args.includes("whoami")) {
        output = JSON.stringify({ accounts: [{ name: "Personal", id: "abcdef0123456789abcdef0123456789" }] });
      } else if (args.includes("list")) {
        output = JSON.stringify([{ name: "pagecast", account_id: "abcdef0123456789abcdef0123456789" }]);
      }
      if (output) child.stdout.emit("data", Buffer.from(output));
      child.emit("exit", 0, null);
    });
    return child;
  }
  const deploys = [];
  function deploySpawn(command, args) {
    deploys.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("https://abcdef123456.pagecast.pages.dev/"));
      child.emit("exit", 0, null);
    });
    return child;
  }
  return { authSpawn, deploySpawn, deploys };
}

test("CLI publish --password protects the report and bakes the gate before serving", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "report.html"), "<h1>Confidential</h1>");

  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    accountId: "abcdef0123456789abcdef0123456789",
    adoptExisting: true
  });

  const { authSpawn, deploySpawn } = headlessFakes();
  const result = await publishReportSnapshot({
    path: path.join(reportDir, "report.html"),
    password: "letmein",
    dataDir,
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: deploySpawn,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  });

  assert.equal(result.passwordProtected, true);
  const middleware = await fs.readFile(
    path.join(
      dataDir,
      "targets",
      "abcdef0123456789abcdef0123456789--pagecast",
      "last-deployed",
      "functions",
      "_middleware.js"
    ),
    "utf8"
  );
  const slug = result.url.match(/\/p\/([^/]+)\//)[1];
  assert.ok(middleware.includes(slug), "gate covers the published slug");
});

test("setPasswordProtection validates password and report id", async () => {
  const { store, reportId } = await setup();
  await assert.rejects(
    () => store.setPasswordProtection(reportId, { enabled: true, password: "   " }),
    /password is required/i
  );
  await assert.rejects(
    () => store.setPasswordProtection("does-not-exist", { enabled: true, password: "x" }),
    /not be? found|not found/i
  );
});

// CodeRabbit highlight: keep authCookieSecret server-only at the API boundary.
test("getPublicConfig strips the cookie-signing secret that get() retains", async () => {
  const tempDir = await makeTempDir();
  const configStore = createConfigStore({ dataDir: path.join(tempDir, "data") });
  await configStore.init();

  const full = configStore.get();
  assert.ok(full.authCookieSecret, "get() keeps the secret for server-side cookie signing");

  const pub = configStore.getPublicConfig();
  assert.equal(Object.prototype.hasOwnProperty.call(pub, "authCookieSecret"), false);
  assert.equal(
    JSON.stringify(pub).includes(full.authCookieSecret),
    false,
    "the cookie-signing secret must never appear in client-facing config"
  );
});

// CodeRabbit highlight: rollback symmetry — a failed deploy must not leave a
// dangling, URL-less active publication.
test("a failed deploy on a protected publish revokes the dangling snapshot", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "report.html"), "<h1>Secret</h1>");

  const { authSpawn } = headlessFakes();
  function failingDeploy() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("Deployment failed: simulated edge error"));
      child.emit("exit", 1, null);
    });
    return child;
  }

  await assert.rejects(() =>
    publishReportSnapshot({
      path: path.join(reportDir, "report.html"),
      password: "letmein",
      dataDir,
      cloudflareAuthSpawnImpl: authSpawn,
      pagesDeploySpawnImpl: failingDeploy,
      cloudflareListTimeoutMs: 1000,
      pagesDeployTimeoutMs: 1000
    })
  );

  const store = createReportStore({ dataDir });
  await store.init();
  const active = store.list().flatMap((r) => r.publications.filter((p) => p.active));
  assert.equal(active.length, 0, "a failed protected deploy must leave no active snapshot");
});
