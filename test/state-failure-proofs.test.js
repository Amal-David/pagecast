import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createConfigStore,
  createReportStore,
  getGoalStatus,
  publishGoalProgress,
  revokeReportPublication,
  startServers
} from "../src/server.js";
import {
  atomicWriteJson,
  runtimeDescriptorPath,
  WorkspaceLease
} from "../src/state-coordinator.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

function failNextAtomicWrite() {
  let shouldFail = false;
  return {
    fail() {
      shouldFail = true;
    },
    async write(file, value) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("injected atomic replacement failure");
      }
      return atomicWriteJson(file, value);
    }
  };
}

test("rejected config and report writes never survive in memory or a later save", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-state-write-rollback-"));
  const configFailure = failNextAtomicWrite();
  const configStore = createConfigStore({
    dataDir: path.join(root, "config"),
    atomicWriteJsonImpl: configFailure.write
  });
  await configStore.init();
  const originalPages = configStore.get().pages;
  configFailure.fail();
  await assert.rejects(
    () =>
      configStore.updatePages({
        projectName: "should-not-stick",
        accountId: ACCOUNT_ID,
        baseUrl: "https://should-not-stick.pages.dev"
      }),
    /injected atomic replacement failure/
  );
  assert.deepEqual(configStore.get().pages, originalPages);
  await configStore.setBadge(false);
  const savedConfig = JSON.parse(
    await fs.readFile(path.join(root, "config", "config.json"), "utf8")
  );
  assert.equal(savedConfig.pages.projectName, originalPages.projectName);

  const source = path.join(root, "report.html");
  await fs.writeFile(source, "<h1>rollback</h1>", "utf8");
  const reportFailure = failNextAtomicWrite();
  const reportStore = createReportStore({
    dataDir: path.join(root, "reports"),
    atomicWriteJsonImpl: reportFailure.write
  });
  await reportStore.init();
  const report = await reportStore.addPath(source);
  const draft = reportStore.draftPublication(report.id, { label: "rejected" });
  reportFailure.fail();
  await assert.rejects(
    () => reportStore.commitPublication(report.id, draft.publication),
    /injected atomic replacement failure/
  );
  assert.equal(reportStore.get(report.id).publications.length, 0);
  await reportStore.setAutoSync(report.id, true);
  const savedReports = JSON.parse(
    await fs.readFile(path.join(root, "reports", "reports.json"), "utf8")
  );
  assert.equal(savedReports.reports[0].publications.length, 0);

  await fs.rm(root, { recursive: true, force: true });
});

test("failed owned-file commits remove uploads and restore edited bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-owned-file-rollback-"));
  const failure = failNextAtomicWrite();
  const dataDir = path.join(root, "data");
  const store = createReportStore({ dataDir, atomicWriteJsonImpl: failure.write });
  await store.init();

  failure.fail();
  await assert.rejects(
    () => store.addUpload({ filename: "orphan.html", content: Buffer.from("ORPHAN") }),
    /injected atomic replacement failure/
  );
  assert.deepEqual(await fs.readdir(path.join(dataDir, "uploads")), []);

  const report = await store.addUpload({
    filename: "kept.html",
    content: Buffer.from("<h1>before</h1>")
  });
  const entry = path.join(report.rootDir, report.entryFile);
  failure.fail();
  await assert.rejects(
    () => store.writeContent(report.id, "<h1>after</h1>"),
    /injected atomic replacement failure/
  );
  assert.equal(await fs.readFile(entry, "utf8"), "<h1>before</h1>");
  await store.setPasswordProtection(report.id, { enabled: false });
  assert.equal(await fs.readFile(entry, "utf8"), "<h1>before</h1>");

  await fs.rm(root, { recursive: true, force: true });
});

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return Boolean(await predicate());
}

function scriptedDeploy(projectName) {
  const calls = [];
  const plans = [];
  let failNextDeploy = false;

  function finish(call, { ok, message } = {}) {
    if (call.finished) {
      return;
    }
    call.finished = true;
    if (ok) {
      call.child.stdout.emit("data", Buffer.from(message || `https://${projectName}.pages.dev`));
      call.child.exitCode = 0;
      call.child.emit("exit", 0, null);
    } else {
      call.child.stderr.emit("data", Buffer.from(message || "simulated Pages deploy failure"));
      call.child.exitCode = 1;
      call.child.emit("exit", 1, null);
    }
  }

  function spawn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => child.emit("exit", null, signal);
    const call = {
      child,
      finished: false,
      succeed(message) {
        finish(call, { ok: true, message });
      },
      fail(message) {
        finish(call, { ok: false, message });
      }
    };
    calls.push(call);

    const plan = plans.shift();
    if (plan === "hold") {
      return child;
    }
    setImmediate(() => {
      if (plan === "fail" || failNextDeploy) {
        failNextDeploy = false;
        call.fail();
      } else {
        call.succeed();
      }
    });
    return child;
  }

  return {
    calls,
    spawn,
    plan(...nextPlans) {
      plans.push(...nextPlans);
    },
    failNext() {
      failNextDeploy = true;
    }
  };
}

async function jsonRequest(runtime, pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${runtime.adminUrl}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { "X-Pagecast-Capability": runtime.commandCapability }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let result = text;
  try {
    result = JSON.parse(text);
  } catch {
    // Non-JSON error bodies are still useful to the caller through `text`.
  }
  return { response, body: result };
}

async function configurePages(runtime, projectName) {
  const result = await jsonRequest(runtime, "/api/config/pages", {
    method: "POST",
    body: {
      accountId: ACCOUNT_ID,
      projectName,
      baseUrl: `https://${projectName}.pages.dev`,
      adoptExisting: true
    }
  });
  assert.equal(result.response.status, 200);
}

async function addPathReport(runtime, reportPath) {
  const result = await jsonRequest(runtime, "/api/reports/path", {
    method: "POST",
    body: { path: reportPath }
  });
  assert.equal(result.response.status, 201);
  return result.body.report;
}

async function publishSnapshot(runtime, reportId, body = {}) {
  const result = await jsonRequest(runtime, `/api/reports/${reportId}/publish-snapshot`, {
    method: "POST",
    body
  });
  assert.equal(result.response.status, 201);
  return result.body.publication;
}

async function closeHttpServer(server) {
  if (!server?.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function unusedPort() {
  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await closeHttpServer(server);
  return port;
}

function activeServersOnPorts(ports) {
  const expected = new Set(ports);
  return process
    ._getActiveHandles()
    .filter((handle) => {
      if (!handle?.listening || typeof handle.address !== "function") {
        return false;
      }
      const address = handle.address();
      return address && expected.has(address.port);
    });
}

function errorMessages(error) {
  return [
    String(error?.message || error || ""),
    ...(Array.isArray(error?.errors) ? error.errors.flatMap(errorMessages) : [])
  ];
}

test("a later expiry mutation wins when an earlier queued deploy fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-expiry-race-"));
  const dataDir = path.join(root, "data");
  const reportDir = path.join(root, "report");
  const reportPath = path.join(reportDir, "index.html");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, "<h1>Expiry race</h1>");
  const deploy = scriptedDeploy("expiry-race");
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: deploy.spawn,
    pagesDeployTimeoutMs: 1000
  });

  try {
    await configurePages(runtime, "expiry-race");
    const report = await addPathReport(runtime, reportPath);
    const publication = await publishSnapshot(runtime, report.id, { expires: "1d" });
    const originalExpiresAt = publication.expiresAt;
    const deployBaseline = deploy.calls.length;
    assert.ok(deployBaseline >= 1, "the initial publish reached Pages");

    deploy.plan("hold", "hold");
    const earlier = jsonRequest(runtime, `/api/publications/${publication.token}/expiry`, {
      method: "POST",
      body: { expires: "7d" }
    });
    let earlierSettled = null;
    earlier.then((result) => {
      earlierSettled = result;
    });
    assert.ok(
      await waitUntil(() => deploy.calls.length >= deployBaseline + 1),
      `earlier deploy started (initial deploy count: ${deployBaseline}, early response: ${JSON.stringify(
        earlierSettled && { status: earlierSettled.response.status, body: earlierSettled.body }
      )})`
    );

    const laterStartedAt = Date.now();
    const later = jsonRequest(runtime, `/api/publications/${publication.token}/expiry`, {
      method: "POST",
      body: { expires: "30d" }
    });

    deploy.calls[deployBaseline].fail("the earlier expiry deploy failed");
    assert.equal(
      await waitUntil(() => deploy.calls.length >= deployBaseline + 2),
      true,
      "later deploy started"
    );
    deploy.calls[deployBaseline + 1].succeed();

    const [earlierResult, laterResult] = await Promise.all([earlier, later]);
    assert.equal(earlierResult.response.status, 502);
    assert.equal(laterResult.response.status, 200);
    assert.ok(
      laterResult.body.publication.expiresAt > laterStartedAt + 29 * 86_400_000,
      "the later response returns its 30-day expiry"
    );
    assert.notEqual(laterResult.body.publication.expiresAt, originalExpiresAt);

    const reopened = createReportStore({ dataDir });
    await reopened.init();
    assert.equal(
      reopened.findPublication(publication.token).publication.expiresAt,
      laterResult.body.publication.expiresAt,
      "the later expiry is the value durably persisted"
    );
  } finally {
    await runtime.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an initial goal vanity-rename deploy failure leaves no active orphan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-goal-rename-"));
  const dataDir = path.join(root, "data");
  const goalFile = path.join(root, "goal.md");
  await fs.writeFile(goalFile, "# Goal\n\nStill working.\n");

  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    accountId: ACCOUNT_ID,
    projectName: "goal-rename",
    baseUrl: "https://goal-rename.pages.dev",
    adoptExisting: true
  });

  const deploy = scriptedDeploy("goal-rename");
  deploy.plan("success", "fail");
  const authSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => child.emit("exit", null, signal);
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ accounts: [{ id: ACCOUNT_ID, name: "Test" }] }))
      );
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return child;
  };

  await assert.rejects(
    publishGoalProgress({
      file: goalFile,
      slug: "goal",
      dataDir,
      routeToDaemon: false,
      cloudflareAuthSpawnImpl: authSpawn,
      pagesDeploySpawnImpl: deploy.spawn,
      cloudflareListTimeoutMs: 1000,
      pagesDeployTimeoutMs: 1000
    }),
    /simulated Pages deploy failure/
  );

  const reopened = createReportStore({ dataDir });
  await reopened.init();
  assert.equal(
    reopened.listPublications().filter((publication) => !publication.revokedAt).length,
    0,
    "the successfully uploaded token is not left active when its vanity rename fails"
  );
  assert.equal((await getGoalStatus({ dataDir })).goal, null);
  await fs.rm(root, { recursive: true, force: true });
});

test("goal rename cleanup never re-journals an already committed revoke", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-goal-remove-failure-"));
  const dataDir = path.join(root, "data");
  const reportsPath = path.resolve(dataDir, "reports.json");
  const goalFile = path.join(root, "goal.md");
  await fs.writeFile(goalFile, "# Goal\n\nCleanup proof.\n");

  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    accountId: ACCOUNT_ID,
    projectName: "goal-cleanup",
    baseUrl: "https://goal-cleanup.pages.dev",
    adoptExisting: true
  });

  const deploy = scriptedDeploy("goal-cleanup");
  deploy.plan("success", "fail", "success");
  const authSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => child.emit("exit", null, signal);
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ accounts: [{ id: ACCOUNT_ID, name: "Test" }] }))
      );
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return child;
  };

  const originalRename = fs.rename;
  let revokeCommitObserved = false;
  let removeFailureInjected = false;
  fs.rename = async (from, to) => {
    if (path.resolve(to) === reportsPath) {
      const candidate = JSON.parse(await fs.readFile(from, "utf8"));
      const publication = candidate.reports?.[0]?.publications?.[0];
      if (publication?.revokedAt) {
        revokeCommitObserved = true;
      } else if (
        revokeCommitObserved &&
        !removeFailureInjected &&
        Array.isArray(candidate.reports) &&
        candidate.reports.length === 0
      ) {
        removeFailureInjected = true;
        const error = new Error("simulated post-revoke report removal failure");
        error.code = "EIO";
        throw error;
      }
    }
    return originalRename(from, to);
  };
  try {
    await assert.rejects(
      publishGoalProgress({
        file: goalFile,
        slug: "goal",
        dataDir,
        routeToDaemon: false,
        cloudflareAuthSpawnImpl: authSpawn,
        pagesDeploySpawnImpl: deploy.spawn,
        cloudflareListTimeoutMs: 1000,
        pagesDeployTimeoutMs: 1000
      }),
      /simulated Pages deploy failure/
    );
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(revokeCommitObserved, true);
  assert.equal(removeFailureInjected, true);

  const reopened = createReportStore({ dataDir });
  await reopened.init();
  const [publication] = reopened.listPublications();
  assert.ok(publication?.revokedAt, "the successful remote revoke remains committed");
  assert.deepEqual(reopened.listOperations(), []);
  assert.equal((await getGoalStatus({ dataDir })).goal, null);

  await reopened.recordOperationFailure({
    type: "revoke",
    token: publication.token,
    slug: publication.slug,
    projectRef: { accountId: ACCOUNT_ID, projectName: "goal-cleanup" },
    error: new Error("simulated stale journal")
  });
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });
  try {
    const retried = await jsonRequest(
      runtime,
      `/api/publications/${encodeURIComponent(publication.token)}/revoke`,
      { method: "POST" }
    );
    assert.equal(retried.response.status, 200);
    assert.deepEqual(runtime.store.listOperations(), []);
  } finally {
    await runtime.close();
  }

  const afterApi = createReportStore({ dataDir });
  await afterApi.init();
  await afterApi.recordOperationFailure({
    type: "revoke",
    token: publication.token,
    slug: publication.slug,
    projectRef: { accountId: ACCOUNT_ID, projectName: "goal-cleanup" },
    error: new Error("second simulated stale journal")
  });
  await revokeReportPublication({ token: publication.token, dataDir, routeToDaemon: false });
  const afterHeadless = createReportStore({ dataDir });
  await afterHeadless.init();
  assert.deepEqual(afterHeadless.listOperations(), []);

  await fs.rm(root, { recursive: true, force: true });
});

test("runtime close shuts both listeners before releasing its lease even when tunnel stop fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-close-failure-"));
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir: path.join(root, "data"),
    staticDir: path.resolve("public")
  });
  const originalRelease = runtime.workspaceLease.release.bind(runtime.workspaceLease);
  const releaseObservations = [];
  runtime.workspaceLease.release = async () => {
    releaseObservations.push({
      adminListening: runtime.adminServer.listening,
      publicListening: runtime.publicServer.listening
    });
    return originalRelease();
  };
  runtime.tunnelManager.stop = async () => {
    throw new Error("simulated tunnel cleanup failure");
  };

  let closeError = null;
  try {
    await runtime.close();
  } catch (error) {
    closeError = error;
  }

  try {
    assert.ok(closeError instanceof AggregateError);
    assert.ok(
      closeError.errors.some((error) => /simulated tunnel cleanup failure/.test(error?.message || "")),
      "the tunnel failure remains visible after listener cleanup"
    );
    assert.deepEqual(releaseObservations[0], {
      adminListening: false,
      publicListening: false
    });
    assert.equal(runtime.adminServer.listening, false);
    assert.equal(runtime.publicServer.listening, false);
  } finally {
    runtime.tunnelManager.stop = async () => {};
    await runtime.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an after-listen runtime persistence failure does not leave either port listening", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-listen-rollback-"));
  const dataDir = path.join(root, "data");
  const adminPort = await unusedPort();
  let publicPort = await unusedPort();
  while (publicPort === adminPort) {
    publicPort = await unusedPort();
  }

  const descriptorPath = runtimeDescriptorPath(dataDir);
  const originalRename = fs.rename;
  let descriptorWrites = 0;
  let startError = null;
  let unexpectedRuntime = null;
  fs.rename = async (from, to) => {
    if (path.resolve(to) === descriptorPath) {
      descriptorWrites += 1;
      if (descriptorWrites === 2) {
        const error = new Error("simulated runtime descriptor persistence failure");
        error.code = "EIO";
        throw error;
      }
    }
    return originalRename(from, to);
  };

  try {
    try {
      unexpectedRuntime = await startServers({
        adminPort,
        publicPort,
        dataDir,
        staticDir: path.resolve("public")
      });
    } catch (error) {
      startError = error;
    }
  } finally {
    fs.rename = originalRename;
  }

  await new Promise((resolve) => setImmediate(resolve));
  const leakedServers = activeServersOnPorts([adminPort, publicPort]);
  try {
    assert.match(startError?.message || "", /simulated runtime descriptor persistence failure/);
    assert.equal(descriptorWrites, 2, "the injected failure occurred after both listeners started");
    assert.deepEqual(
      leakedServers.map((server) => server.address().port),
      [],
      "startup rollback closes both the admin and public listeners"
    );
  } finally {
    await unexpectedRuntime?.close().catch(() => {});
    await Promise.all(leakedServers.map((server) => closeHttpServer(server).catch(() => {})));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed report delete keeps its auto-sync watcher registered", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-delete-watch-"));
  const dataDir = path.join(root, "data");
  const reportDir = path.join(root, "report");
  const reportPath = path.join(reportDir, "index.html");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, "<h1>watch-0</h1>");
  const deploy = scriptedDeploy("delete-watch");
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: deploy.spawn,
    pagesDeployTimeoutMs: 1000
  });

  try {
    await configurePages(runtime, "delete-watch");
    const report = await addPathReport(runtime, reportPath);
    await publishSnapshot(runtime, report.id);
    const enabled = await jsonRequest(runtime, `/api/reports/${report.id}/auto-sync`, {
      method: "POST",
      body: { enabled: true }
    });
    assert.equal(enabled.response.status, 200);

    deploy.failNext();
    const deleted = await jsonRequest(runtime, `/api/reports/${report.id}`, {
      method: "DELETE",
      body: {}
    });
    assert.equal(deleted.response.status, 502);
    assert.equal(runtime.store.get(report.id)?.autoSync, true, "the report remains tracked after revoke fails");

    const baseline = deploy.calls.length;
    await fs.writeFile(reportPath, "<h1>watch-1</h1>");
    assert.equal(
      await waitUntil(() => deploy.calls.length > baseline, { timeoutMs: 3500, intervalMs: 25 }),
      true,
      "the original watcher still triggers a sync after the failed delete"
    );
    assert.equal(
      await waitUntil(() => deploy.calls.at(-1)?.finished === true),
      true,
      "the watcher-triggered deploy completed before teardown"
    );
  } finally {
    await runtime.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a reports.json failure rolls back deletion without unregistering its watcher", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-delete-state-failure-"));
  const dataDir = path.join(root, "data");
  const reportDir = path.join(root, "report");
  const reportPath = path.join(reportDir, "index.html");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, "<h1>still tracked</h1>");
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });

  try {
    const report = await addPathReport(runtime, reportPath);
    const enabled = await jsonRequest(runtime, `/api/reports/${report.id}/auto-sync`, {
      method: "POST",
      body: { enabled: true }
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(runtime.watchManager.isRegistered(report.id), true);

    const reportsPath = path.resolve(dataDir, "reports.json");
    const originalRename = fs.rename;
    let injected = false;
    fs.rename = async (from, to) => {
      if (!injected && path.resolve(to) === reportsPath) {
        injected = true;
        const error = new Error("simulated report-state commit failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(from, to);
    };
    let deleted;
    try {
      deleted = await jsonRequest(runtime, `/api/reports/${report.id}`, {
        method: "DELETE",
        body: {}
      });
    } finally {
      fs.rename = originalRename;
    }

    assert.equal(deleted.response.status, 500);
    assert.equal(injected, true, "the reports.json commit failure was exercised");
    assert.equal(deleted.body.error.message, "Internal server error.");
    assert.equal(runtime.store.get(report.id)?.autoSync, true);
    assert.equal(runtime.watchManager.isRegistered(report.id), true);
    assert.equal(await fs.readFile(reportPath, "utf8"), "<h1>still tracked</h1>");
    assert.equal(runtime.store.listPendingDeletions().length, 0);
  } finally {
    await runtime.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed owned-source cleanup remains durable and is retried on the next leased init", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-delete-cleanup-"));
  const dataDir = path.join(root, "data");
  const cleanupError = new Error("simulated owned-source cleanup failure");
  const store = createReportStore({
    dataDir,
    removePathImpl: async () => {
      throw cleanupError;
    }
  });
  await store.init();
  const report = await store.addUpload({ filename: "cleanup.html", content: "<h1>cleanup</h1>" });
  const sourceRoot = store.get(report.id).rootDir;

  assert.equal(await store.remove(report.id), true);
  assert.equal(store.get(report.id), null);
  assert.equal((await fs.stat(sourceRoot)).isDirectory(), true);
  assert.match(store.listPendingDeletions()[0].error, /owned-source cleanup failure/);

  const afterFailure = JSON.parse(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"));
  assert.equal(afterFailure.reports.length, 0);
  assert.equal(afterFailure.pendingDeletions.length, 1);
  assert.deepEqual(afterFailure.pendingDeletions[0].paths, [sourceRoot]);

  const reopened = createReportStore({ dataDir });
  await reopened.init();
  await assert.rejects(fs.stat(sourceRoot), (error) => error?.code === "ENOENT");
  assert.deepEqual(reopened.listPendingDeletions(), []);
  const recovered = JSON.parse(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"));
  assert.deepEqual(recovered.pendingDeletions, []);

  await fs.rm(root, { recursive: true, force: true });
});

test("remote revoke success clears its journal and marks revoked in one atomic state write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-revoke-commit-"));
  const dataDir = path.join(root, "data");
  const reportsPath = path.resolve(dataDir, "reports.json");
  const store = createReportStore({ dataDir });
  await store.init();
  const report = await store.addUpload({ filename: "atomic.html", content: "<h1>atomic</h1>" });
  const draft = store.draftPublication(report.id, {
    kind: "snapshot",
    publicUrl: "https://atomic.pages.dev/p/atomic/"
  });
  await store.commitPublication(report.id, draft.publication);
  await store.recordOperationFailure({
    type: "revoke",
    token: draft.publication.token,
    slug: draft.publication.slug,
    projectRef: null,
    error: new Error("first remote attempt failed")
  });

  const originalRename = fs.rename;
  let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && path.resolve(to) === reportsPath) {
      failed = true;
      const error = new Error("simulated atomic revoke commit failure");
      error.code = "EIO";
      throw error;
    }
    return originalRename(from, to);
  };
  try {
    await assert.rejects(
      () => store.commitSuccessfulRevoke(draft.publication.token),
      /simulated atomic revoke commit failure/
    );
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(store.findPublication(draft.publication.token).publication.revokedAt, null);
  assert.equal(store.listOperations().length, 1);
  const beforeRetry = JSON.parse(await fs.readFile(reportsPath, "utf8"));
  assert.equal(beforeRetry.reports[0].publications[0].revokedAt, null);
  assert.equal(beforeRetry.operations.length, 1);

  let reportsWrites = 0;
  fs.rename = async (from, to) => {
    if (path.resolve(to) === reportsPath) {
      reportsWrites += 1;
    }
    return originalRename(from, to);
  };
  try {
    const committed = await store.commitSuccessfulRevoke(draft.publication.token);
    assert.equal(committed.revoked, true);
    assert.equal(committed.operationCleared, true);
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(reportsWrites, 1);
  const committed = JSON.parse(await fs.readFile(reportsPath, "utf8"));
  assert.equal(typeof committed.reports[0].publications[0].revokedAt, "string");
  assert.deepEqual(committed.operations, []);

  await fs.rm(root, { recursive: true, force: true });
});

test("admin bind retry retains the workspace lease when its public listener cannot close", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-bind-close-failure-"));
  const dataDir = path.join(root, "data");
  const blocker = createHttpServer((_req, res) => res.end("busy"));
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const blockedAdminPort = blocker.address().port;
  const candidatePublicPort = await unusedPort();
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.setLocalRuntime({
    adminPort: blockedAdminPort,
    publicPort: candidatePublicPort
  });

  const servers = [];
  let rejectPublicClose = true;
  let rejectedCloseAttempts = 0;
  const serverFactory = (handler) => {
    const server = createHttpServer(handler);
    servers.push(server);
    return server;
  };
  const serverCloseImpl = async (server) => {
    if (rejectPublicClose && server === servers[0]) {
      rejectedCloseAttempts += 1;
      throw new Error("simulated public listener close failure");
    }
    await closeHttpServer(server);
  };

  let startError;
  try {
    await startServers({
      dataDir,
      staticDir: path.resolve("public"),
      serverFactory,
      serverCloseImpl
    });
  } catch (error) {
    startError = error;
  }

  try {
    assert.ok(startError instanceof AggregateError);
    assert.ok(
      errorMessages(startError).some((message) => /public listener close failure/.test(message)),
      "listener cleanup failure remains visible"
    );
    assert.ok(rejectedCloseAttempts >= 2, "outer startup cleanup retries the public close");
    assert.equal(servers[0].listening, true);

    const competingLease = new WorkspaceLease(dataDir);
    await assert.rejects(
      () => competingLease.acquire({ capability: "competing-test-capability" }),
      (error) => error?.code === "PAGECAST_WORKSPACE_BUSY"
    );
  } finally {
    rejectPublicClose = false;
    await closeHttpServer(servers[0]).catch(() => {});
    await closeHttpServer(blocker).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});
