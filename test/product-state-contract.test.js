import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createConfigStore,
  createReportStore,
  deployCloudflarePagesSite,
  publishGoalProgress,
  publishReportSnapshot,
  startServers
} from "../src/server.js";
import {
  PAGECAST_PROJECT_MARKER_FILE,
  parseOwnershipMarker,
  projectRefFilesystemKey
} from "../src/project-ref.js";

const ACCOUNT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function makeWorkspace(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function fakeSpawn(handler, { delayMs = 0, captured = [] } = {}) {
  const spawn = (command, args, options = {}) => {
    captured.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    setTimeout(() => {
      const result = handler(command, args, options) || {};
      const code = result.code ?? 0;
      if (result.output) {
        (result.stderr ? child.stderr : child.stdout).emit(
          "data",
          Buffer.from(result.output)
        );
      }
      child.exitCode = code;
      child.emit("exit", code, null);
    }, delayMs);
    return child;
  };
  return { spawn, captured };
}

function authenticatedCloudflareSpawn(projects) {
  return fakeSpawn((_command, args) => {
    if (args.includes("whoami")) {
      return {
        output: JSON.stringify({
          accounts: [
            { id: ACCOUNT_A, name: "Account A" },
            { id: ACCOUNT_B, name: "Account B" }
          ]
        })
      };
    }
    if (args.includes("list")) {
      return { output: JSON.stringify(projects) };
    }
    return { output: "" };
  }).spawn;
}

async function adoptTarget(dataDir, {
  accountId = ACCOUNT_A,
  projectName = "pagecast",
  baseUrl = `https://${projectName}.pages.dev`
} = {}) {
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    accountId,
    projectName,
    baseUrl,
    adoptExisting: true
  });
}

test("concurrent one-shot publishes have one lease winner and cannot lose committed state", async () => {
  const root = await makeWorkspace("pagecast-one-shot-concurrency-");
  const dataDir = path.join(root, "data");
  const firstPath = path.join(root, "first.html");
  const secondPath = path.join(root, "second.html");
  await fs.writeFile(firstPath, "<h1>First</h1>");
  await fs.writeFile(secondPath, "<h1>Second</h1>");
  await adoptTarget(dataDir, { projectName: "concurrent" });

  const authSpawn = authenticatedCloudflareSpawn([
    { name: "concurrent", account_id: ACCOUNT_A }
  ]);
  const deploy = fakeSpawn(
    () => ({ output: "https://a1b2c3d4.concurrent.pages.dev" }),
    { delayMs: 100 }
  );
  const publish = (reportPath) =>
    publishReportSnapshot({
      path: reportPath,
      dataDir,
      routeToDaemon: false,
      cloudflareAuthSpawnImpl: authSpawn,
      pagesDeploySpawnImpl: deploy.spawn,
      cloudflareListTimeoutMs: 1000,
      pagesDeployTimeoutMs: 1000
    });

  const outcomes = await Promise.allSettled([publish(firstPath), publish(secondPath)]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "PAGECAST_WORKSPACE_BUSY");

  const persisted = JSON.parse(
    await fs.readFile(path.join(dataDir, "reports.json"), "utf8")
  );
  assert.equal(persisted.reports.length, 1);
  assert.equal(persisted.reports[0].publications.length, 1);
  assert.equal(
    persisted.reports[0].publications[0].token,
    fulfilled[0].value.token
  );
  assert.ok(
    fulfilled[0].value.expiresAt > Date.now() + 29 * 86_400_000,
    "the effective 30-day default expiry is returned by the headless adapter"
  );
});

test("goal publishing delegates to the live workspace owner", async () => {
  const root = await makeWorkspace("pagecast-goal-live-owner-");
  const dataDir = path.join(root, "data");
  const goalPath = path.join(root, "goal.md");
  await fs.writeFile(goalPath, "# Goal\n\nLive-owner mutation\n");
  await adoptTarget(dataDir, { projectName: "live-goal" });

  const authSpawn = authenticatedCloudflareSpawn([
    { name: "live-goal", account_id: ACCOUNT_A }
  ]);
  const deploy = fakeSpawn(() => ({
    output: "https://a1b2c3d4.live-goal.pages.dev"
  }));
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: deploy.spawn,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  });

  try {
    const oneShotMustNotRun = () => {
      throw new Error("the one-shot adapter must not run while a live owner exists");
    };
    const result = await publishGoalProgress({
      file: goalPath,
      slug: "goal",
      dataDir,
      cloudflareAuthSpawnImpl: oneShotMustNotRun,
      pagesDeploySpawnImpl: oneShotMustNotRun
    });

    assert.equal(result.slug, "goal");
    assert.match(result.url, /^https:\/\/live-goal\.pages\.dev\/p\/goal\/$/);
    const livePublication = runtime.store.findPublication(result.token);
    assert.ok(livePublication, "the server-owned in-memory store receives the mutation");
    assert.equal(runtime.configStore.get().goal?.token, result.token);
    assert.ok(deploy.captured.length >= 1);
  } finally {
    await runtime.close();
  }
});

test("config and report saves preserve mutator invocation order", async () => {
  const root = await makeWorkspace("pagecast-save-order-");
  const dataDir = path.join(root, "data");
  const configStore = createConfigStore({ dataDir });
  await configStore.init();

  const slowLargeSnapshot = configStore.updateFeedback({
    url: "https://feedback.example.test",
    workerName: "feedback",
    statsToken: "x".repeat(4 * 1024 * 1024)
  });
  const laterClear = configStore.updateFeedback(null);
  await Promise.all([slowLargeSnapshot, laterClear]);

  const reopenedConfig = createConfigStore({ dataDir });
  await reopenedConfig.init();
  assert.equal(
    reopenedConfig.get().feedback,
    null,
    "a slower earlier write cannot overwrite the later config mutation"
  );

  const reportPath = path.join(root, "report.html");
  await fs.writeFile(reportPath, "<h1>Ordered state</h1>");
  const reportStore = createReportStore({ dataDir });
  await reportStore.init();
  const report = await reportStore.addPath(reportPath);
  const draft = reportStore.draftPublication(report.id, { kind: "snapshot" });
  const commit = reportStore.commitPublication(report.id, draft.publication);
  const laterRevoke = reportStore.revokePublication(draft.publication.token);
  await Promise.all([commit, laterRevoke]);

  const reopenedReports = createReportStore({ dataDir });
  await reopenedReports.init();
  assert.ok(
    reopenedReports.findPublication(draft.publication.token)?.publication.revokedAt,
    "the later report mutation remains the durable state"
  );
});

test("fresh telemetry defaults to enabled while existing config choices migrate compatibly", async () => {
  const root = await makeWorkspace("pagecast-telemetry-consent-");

  const freshDir = path.join(root, "fresh");
  const fresh = createConfigStore({ dataDir: freshDir });
  await fresh.init();
  assert.equal(fresh.get().telemetry, true);
  assert.equal(fresh.getPublicConfig().telemetryConsent, true);
  assert.equal(fresh.get().telemetryId, null);

  const legacyDir = path.join(root, "legacy");
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, "config.json"), "{}\n");
  const legacy = createConfigStore({ dataDir: legacyDir });
  await legacy.init();
  assert.equal(legacy.get().telemetry, true);
  assert.equal(legacy.getPublicConfig().telemetryConsent, true);

  const optedOutDir = path.join(root, "opted-out");
  await fs.mkdir(optedOutDir, { recursive: true });
  await fs.writeFile(
    path.join(optedOutDir, "config.json"),
    `${JSON.stringify({ telemetry: false })}\n`
  );
  const optedOut = createConfigStore({ dataDir: optedOutDir });
  await optedOut.init();
  assert.equal(optedOut.get().telemetry, false);
  assert.equal(optedOut.getPublicConfig().telemetryConsent, false);
});

test("direct deploy is stateless for managed publishing and isolates account/project roots", async () => {
  const root = await makeWorkspace("pagecast-direct-isolation-");
  const dataDir = path.join(root, "data");
  const siteA = path.join(root, "site-a");
  const siteB = path.join(root, "site-b");
  const siteC = path.join(root, "site-c");
  await fs.mkdir(siteA, { recursive: true });
  await fs.mkdir(siteB, { recursive: true });
  await fs.mkdir(siteC, { recursive: true });
  await fs.writeFile(path.join(siteA, "index.html"), "<h1>Account A</h1>");
  await fs.writeFile(path.join(siteB, "index.html"), "<h1>Account B</h1>");
  await fs.writeFile(path.join(siteC, "index.html"), "<h1>Other project</h1>");

  const beforeStore = createConfigStore({ dataDir });
  await beforeStore.init();
  const before = beforeStore.get();
  const authSpawn = authenticatedCloudflareSpawn([
    { name: "shared-project", account_id: ACCOUNT_A },
    { name: "shared-project", account_id: ACCOUNT_B },
    { name: "other-project", account_id: ACCOUNT_A }
  ]);
  const deploy = fakeSpawn((_command, args, options) => {
    const account = options.env.CLOUDFLARE_ACCOUNT_ID;
    const projectName = args[args.indexOf("--project-name") + 1];
    const suffix =
      projectName === "other-project"
        ? "other-project"
        : account === ACCOUNT_A
          ? "account-a"
          : "account-b";
    return { output: `https://a1b2c3d4.${suffix}.pages.dev` };
  });

  const deployDirect = (sourceDir, accountId, projectName = "shared-project") =>
    deployCloudflarePagesSite({
      sourceDir,
      projectName,
      accountId,
      dataDir,
      cloudflareAuthSpawnImpl: authSpawn,
      pagesDeploySpawnImpl: deploy.spawn,
      cloudflareListTimeoutMs: 1000,
      pagesDeployTimeoutMs: 1000
    });
  const first = await deployDirect(siteA, ACCOUNT_A);
  const second = await deployDirect(siteB, ACCOUNT_B);
  const third = await deployDirect(siteC, ACCOUNT_A, "other-project");

  assert.equal(first.url, "https://account-a.pages.dev");
  assert.equal(second.url, "https://account-b.pages.dev");
  assert.equal(third.url, "https://other-project.pages.dev");
  const roots = deploy.captured.map((call) => call.options.cwd);
  const expectedA = path.join(
    dataDir,
    "pages-deploy",
    "direct",
    `${ACCOUNT_A}--shared-project`,
    "main"
  );
  const expectedB = path.join(
    dataDir,
    "pages-deploy",
    "direct",
    `${ACCOUNT_B}--shared-project`,
    "main"
  );
  const expectedC = path.join(
    dataDir,
    "pages-deploy",
    "direct",
    `${ACCOUNT_A}--other-project`,
    "main"
  );
  assert.deepEqual(roots, [expectedA, expectedB, expectedC]);
  assert.equal(await fs.readFile(path.join(expectedA, "index.html"), "utf8"), "<h1>Account A</h1>");
  assert.equal(await fs.readFile(path.join(expectedB, "index.html"), "utf8"), "<h1>Account B</h1>");
  assert.equal(await fs.readFile(path.join(expectedC, "index.html"), "utf8"), "<h1>Other project</h1>");

  for (const [stagingRoot, accountId, projectName] of [
    [expectedA, ACCOUNT_A, "shared-project"],
    [expectedB, ACCOUNT_B, "shared-project"],
    [expectedC, ACCOUNT_A, "other-project"]
  ]) {
    const marker = parseOwnershipMarker(
      await fs.readFile(path.join(stagingRoot, PAGECAST_PROJECT_MARKER_FILE), "utf8")
    );
    assert.equal(marker.mode, "direct");
    assert.equal(marker.projectRef.accountId, accountId);
    assert.equal(marker.projectRef.projectName, projectName);
  }

  const afterStore = createConfigStore({ dataDir });
  await afterStore.init();
  const after = afterStore.get();
  assert.deepEqual(after.pages, before.pages);
  assert.deepEqual(after.managedTargets, before.managedTargets);
  assert.equal(after.goal, before.goal);
});

test("canonical Cloudflare origin is returned, persisted, and used by OG metadata", async () => {
  const root = await makeWorkspace("pagecast-canonical-origin-");
  const dataDir = path.join(root, "data");
  const reportDir = path.join(root, "report");
  const reportPath = path.join(reportDir, "index.html");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    reportPath,
    "<!doctype html><html><head><title>Canonical</title></head><body><p>Origin</p></body></html>"
  );
  await adoptTarget(dataDir, { projectName: "pagecast" });

  const authSpawn = authenticatedCloudflareSpawn([
    { name: "pagecast", account_id: ACCOUNT_A }
  ]);
  const deploy = fakeSpawn(() => ({
    output: "Deployment: https://7a52d6ea.pagecast-6cv.pages.dev"
  }));
  const startedAt = Date.now();
  const result = await publishReportSnapshot({
    path: reportPath,
    dataDir,
    routeToDaemon: false,
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: deploy.spawn,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  });

  assert.match(result.url, /^https:\/\/pagecast-6cv\.pages\.dev\/p\/.+\/$/);
  assert.equal(deploy.captured.length, 2, "an origin change triggers a canonical metadata redeploy");
  assert.ok(result.expiresAt >= startedAt + 30 * 86_400_000 - 5000);
  assert.ok(result.expiresAt <= Date.now() + 30 * 86_400_000 + 5000);

  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  assert.equal(configStore.get().pages.baseUrl, "https://pagecast-6cv.pages.dev");

  const reports = JSON.parse(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"));
  const publication = reports.reports[0].publications[0];
  assert.equal(publication.publicUrl, result.url);
  assert.equal(publication.pagesBaseUrl, "https://pagecast-6cv.pages.dev");
  assert.equal(publication.projectRef.baseUrl, "https://pagecast-6cv.pages.dev");
  assert.equal(publication.expiresAt, result.expiresAt);

  const targetKey = projectRefFilesystemKey({
    accountId: ACCOUNT_A,
    projectName: "pagecast"
  });
  const snapshotHtml = await fs.readFile(
    path.join(
      dataDir,
      "targets",
      targetKey,
      "snapshots",
      `token-${createHash("sha256").update(result.token, "utf8").digest("hex")}`,
      "content",
      "index.html"
    ),
    "utf8"
  );
  assert.match(
    snapshotHtml,
    new RegExp(`<meta property="og:url" content="${result.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`)
  );
});

test("report builds select the native POSIX and Windows command interpreters", async () => {
  const root = await makeWorkspace("pagecast-build-shell-integration-");
  const dataDir = path.join(root, "data");
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "dist"), { recursive: true });
  await fs.writeFile(path.join(source, "dist", "index.html"), "<h1>Built</h1>");
  const builds = fakeSpawn(() => ({ output: "build complete" }));
  const store = createReportStore({
    dataDir,
    buildSpawnImpl: builds.spawn,
    buildTimeoutMs: 1000
  });
  await store.init();
  const report = await store.addFolder({
    folderPath: source,
    buildCommand: "npm run build -- --label=\"two words\"",
    buildOutputDir: "dist"
  });

  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const previousComSpec = process.env.ComSpec;
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    await store.buildReport(report.id);
    assert.equal(builds.captured[0].command, "sh");
    assert.deepEqual(builds.captured[0].args, [
      "-lc",
      "npm run build -- --label=\"two words\""
    ]);

    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    await store.buildReport(report.id);
    assert.equal(builds.captured[1].command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(builds.captured[1].args, [
      "/d",
      "/s",
      "/c",
      "npm run build -- --label=\"two words\""
    ]);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (previousComSpec === undefined) {
      delete process.env.ComSpec;
    } else {
      process.env.ComSpec = previousComSpec;
    }
  }
});
