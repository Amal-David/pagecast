import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createConfigStore,
  deleteCloudflarePagesDeployment,
  deployCloudflarePagesSite,
  getCloudflarePagesStatus,
  getGoalStatus,
  listCloudflarePagesDeployments,
  listCloudflarePagesProjects,
  pruneCloudflarePagesDeployments,
  publishReportSnapshot,
  setupCloudflareFeedback,
  setupCloudflarePages,
  startServers
} from "../src/server.js";

const execFileAsync = promisify(execFile);

function deployController() {
  let failNext = false;
  let count = 0;
  return {
    get count() {
      return count;
    },
    failNext() {
      failNext = true;
    },
    spawn() {
      count += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal = "SIGTERM") => child.emit("exit", null, signal);
      setImmediate(() => {
        if (failNext) {
          failNext = false;
          child.stderr.emit("data", Buffer.from("simulated remote revoke failure"));
          child.exitCode = 1;
          child.emit("exit", 1, null);
          return;
        }
        child.stdout.emit("data", Buffer.from("https://state-recovery.pages.dev"));
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    }
  };
}

function gatedDeployController() {
  let releaseDeploy;
  let announceDeploy;
  const started = new Promise((resolve) => {
    announceDeploy = resolve;
  });
  const released = new Promise((resolve) => {
    releaseDeploy = resolve;
  });
  return {
    started,
    release() {
      releaseDeploy();
    },
    spawn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal = "SIGTERM") => child.emit("exit", null, signal);
      setImmediate(async () => {
        announceDeploy();
        await released;
        child.stdout.emit("data", Buffer.from("https://atomic-command.pages.dev"));
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    }
  };
}

function wranglerSpawn(handler) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => child.emit("exit", null, signal);
    Promise.resolve()
      .then(() => handler({ command, args, options }))
      .then(({ code = 0, output = "" } = {}) => {
        if (output) {
          child.stdout.emit("data", Buffer.from(output));
        }
        child.exitCode = code;
        child.emit("exit", code, null);
      })
      .catch((error) => {
        child.stderr.emit("data", Buffer.from(error.message));
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
    return child;
  };
}

async function jsonRequest(runtime, pathname, options = {}) {
  const method = options.method || "GET";
  const response = await fetch(`${runtime.adminUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
        ? { "X-Pagecast-Capability": runtime.commandCapability }
        : {}),
      ...(options.headers || {})
    },
    body: options.body === undefined && options.method && options.method !== "GET" ? "{}" : options.body
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}

test("failed revoke stays active, persists a retryable operation, and clears only after success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-revoke-recovery-"));
  const dataDir = path.join(root, "data");
  const sourceDir = path.join(root, "source");
  const reportPath = path.join(sourceDir, "index.html");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(reportPath, "<h1>Keep live until remote revoke succeeds</h1>", "utf8");
  const deploy = deployController();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: (...args) => deploy.spawn(...args),
    pagesDeployTimeoutMs: 1000
  });

  try {
    let result = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "state-recovery",
        accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        adoptExisting: true
      })
    });
    assert.equal(result.response.status, 200);

    result = await jsonRequest(runtime, "/api/reports/path", {
      method: "POST",
      body: JSON.stringify({ path: reportPath })
    });
    assert.equal(result.response.status, 201);
    const reportId = result.body.report.id;

    result = await jsonRequest(runtime, `/api/reports/${reportId}/publish-snapshot`, {
      method: "POST"
    });
    assert.equal(result.response.status, 201);
    const publication = result.body.publication;

    deploy.failNext();
    result = await jsonRequest(
      runtime,
      `/api/publications/${publication.token}/revoke`,
      { method: "POST" }
    );
    assert.equal(result.response.status, 502);

    result = await jsonRequest(runtime, "/api/reports", { method: "GET" });
    const failedPublication = result.body.reports[0].publications[0];
    assert.equal(failedPublication.active, true);
    assert.equal(failedPublication.revokedAt, null);

    result = await jsonRequest(runtime, "/api/operations", { method: "GET" });
    assert.equal(result.body.operations.length, 1);
    assert.equal(result.body.operations[0].id, `revoke:${publication.token}`);
    assert.equal(result.body.operations[0].attempts, 1);
    assert.equal(result.body.operations[0].recovery.mode, "automatic");
    assert.equal(result.body.operations[0].recovery.action, "Retry revoke");

    result = await jsonRequest(
      runtime,
      `/api/operations/${encodeURIComponent(`revoke:${publication.token}`)}/retry`,
      { method: "POST" }
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.body.recovered, true);
    assert.equal(result.body.operationId, `revoke:${publication.token}`);

    result = await jsonRequest(runtime, "/api/reports", { method: "GET" });
    assert.equal(result.body.reports[0].publications[0].active, false);

    result = await jsonRequest(runtime, "/api/operations", { method: "GET" });
    assert.deepEqual(result.body.operations, []);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generic recovery dispatches sync, content, password, and goal work without revoking", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-operation-dispatch-"));
  const dataDir = path.join(root, "data");
  const reportPath = path.join(root, "index.html");
  await fs.writeFile(reportPath, "<h1>Keep this link active</h1>", "utf8");
  const deploy = deployController();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: (...args) => deploy.spawn(...args),
    pagesDeployTimeoutMs: 1000
  });

  try {
    let result = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "operation-dispatch",
        accountId: "12121212121212121212121212121212",
        adoptExisting: true
      })
    });
    assert.equal(result.response.status, 200);
    result = await jsonRequest(runtime, "/api/reports/path", {
      method: "POST",
      body: JSON.stringify({ path: reportPath })
    });
    const reportId = result.body.report.id;
    result = await jsonRequest(runtime, `/api/reports/${reportId}/publish-snapshot`, {
      method: "POST"
    });
    assert.equal(result.response.status, 201);
    const token = result.body.publication.token;

    const retryableTypes = [
      "sync",
      "auto_sync",
      "content_sync",
      "password_sync",
      "password_compensate",
      "goal_sync"
    ];
    for (const type of retryableTypes) {
      const live = runtime.store.findActivePublication(token);
      const operation = {
        type,
        token,
        slug: live.publication.slug,
        projectRef: live.publication.projectRef,
        reportId,
        ...(type === "goal_sync" ? { goalFile: reportPath } : {}),
        ...(type.startsWith("password_") ? { desiredProtected: true } : {})
      };
      if (type === "goal_sync") {
        await runtime.configStore.setGoal({
          token,
          slug: live.publication.slug,
          url: live.publication.publicUrl,
          file: "/tmp/older-goal-source.md",
          startedAt: "2026-07-10T00:00:00.000Z"
        });
      }
      await runtime.store.beginOperations([operation]);
      if (type !== "sync") {
        await runtime.store.recordOperationFailure({
          ...operation,
          error: new Error(`simulated ${type} interruption`)
        });
      }

      const beforeDeploy = deploy.count;
      result = await jsonRequest(runtime, "/api/operations", { method: "GET" });
      const journal = result.body.operations.find((entry) => entry.id === `${type}:${token}`);
      assert.ok(journal, `${type} must be visible in the API journal`);
      assert.equal(journal.status, type === "sync" ? "pending" : "failed");
      assert.equal(journal.recovery.mode, "automatic");

      result = await jsonRequest(
        runtime,
        `/api/operations/${encodeURIComponent(`${type}:${token}`)}/retry`,
        { method: "POST" }
      );
      assert.equal(result.response.status, 200, `${type} should recover automatically`);
      assert.equal(deploy.count, beforeDeploy + 1, `${type} must deploy current target state`);
      assert.equal(runtime.store.findActivePublication(token)?.publication.revokedAt, null);
      assert.equal(
        runtime.store.listOperations().some((entry) => entry.token === token),
        false,
        `${type} recovery must clear its journal`
      );
    }

    assert.notEqual(runtime.store.get(reportId).passwordProtected, true);
    assert.equal(runtime.configStore.get().goal.file, reportPath);

    const live = runtime.store.findActivePublication(token);
    const unknown = {
      type: "future_operation",
      token,
      slug: live.publication.slug,
      projectRef: live.publication.projectRef,
      reportId
    };
    await runtime.store.beginOperations([unknown]);
    await runtime.store.recordOperationFailure({
      ...unknown,
      error: new Error("future operation failed")
    });
    const beforeManualAttempt = deploy.count;
    result = await jsonRequest(runtime, "/api/operations", { method: "GET" });
    assert.equal(result.body.operations[0].recovery.mode, "manual");
    assert.match(result.body.operations[0].recovery.manualReason, /not supported/);
    result = await jsonRequest(
      runtime,
      `/api/operations/${encodeURIComponent(`future_operation:${token}`)}/retry`,
      { method: "POST" }
    );
    assert.equal(result.response.status, 409);
    assert.equal(deploy.count, beforeManualAttempt);
    assert.ok(runtime.store.findActivePublication(token), "manual recovery must not revoke the link");
    assert.ok(runtime.store.getOperation(`future_operation:${token}`));

    const legacyRename = {
      type: "rename",
      token,
      slug: "missing-previous-slug",
      projectRef: live.publication.projectRef,
      reportId
    };
    await runtime.store.beginOperations([legacyRename]);
    await runtime.store.recordOperationFailure({
      ...legacyRename,
      error: new Error("legacy rename record")
    });
    result = await jsonRequest(runtime, "/api/operations", { method: "GET" });
    const manualRename = result.body.operations.find(
      (entry) => entry.id === `rename:${token}`
    );
    assert.equal(manualRename.recovery.mode, "manual");
    assert.match(manualRename.recovery.manualReason, /previous link path/);
    result = await jsonRequest(
      runtime,
      `/api/operations/${encodeURIComponent(`rename:${token}`)}/retry`,
      { method: "POST" }
    );
    assert.equal(result.response.status, 409);
    assert.equal(deploy.count, beforeManualAttempt);
    assert.equal(runtime.store.findActivePublication(token).publication.slug, live.publication.slug);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("publish recovery resumes both sides of the durable remote-success checkpoint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-publish-recovery-"));
  const dataDir = path.join(root, "data");
  const reportPath = path.join(root, "index.html");
  await fs.writeFile(reportPath, "<h1>Recover publish</h1>", "utf8");
  const deploy = deployController();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: (...args) => deploy.spawn(...args),
    pagesDeployTimeoutMs: 1000
  });

  try {
    let result = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "publish-recovery",
        accountId: "34343434343434343434343434343434",
        adoptExisting: true
      })
    });
    assert.equal(result.response.status, 200);
    result = await jsonRequest(runtime, "/api/reports/path", {
      method: "POST",
      body: JSON.stringify({ path: reportPath })
    });
    const reportId = result.body.report.id;

    const beforeRemote = runtime.store.draftPublication(reportId, {
      label: "before-remote",
      kind: "snapshot"
    });
    const preRemoteOperation = {
      type: "publish",
      token: beforeRemote.publication.token,
      slug: beforeRemote.publication.slug,
      projectRef: runtime.configStore.get().pages,
      reportId,
      publication: structuredClone(beforeRemote.publication),
      remoteSucceeded: false
    };
    await runtime.store.beginOperations([preRemoteOperation]);
    await runtime.store.recordOperationFailure({
      ...preRemoteOperation,
      error: new Error("failed before remote deploy")
    });
    const beforePreRemoteRetry = deploy.count;
    result = await jsonRequest(
      runtime,
      `/api/operations/${encodeURIComponent(`publish:${beforeRemote.publication.token}`)}/retry`,
      { method: "POST" }
    );
    assert.equal(result.response.status, 200);
    assert.equal(deploy.count, beforePreRemoteRetry + 1);
    const recoveredBeforeRemote = runtime.store.findActivePublication(
      beforeRemote.publication.token
    );
    assert.ok(recoveredBeforeRemote);
    assert.equal(recoveredBeforeRemote.publication.pending, false);

    const afterRemote = runtime.store.draftPublication(reportId, {
      label: "after-remote",
      kind: "snapshot"
    });
    const publicUrl = `${runtime.configStore.get().pages.baseUrl}/p/${afterRemote.publication.slug}/`;
    const postRemoteOperation = {
      type: "publish",
      token: afterRemote.publication.token,
      slug: afterRemote.publication.slug,
      projectRef: runtime.configStore.get().pages,
      reportId,
      publication: {
        ...structuredClone(afterRemote.publication),
        publicUrl
      },
      publicUrl,
      remoteSucceeded: true
    };
    await runtime.store.beginOperations([postRemoteOperation]);
    await runtime.store.recordOperationFailure({
      ...postRemoteOperation,
      error: new Error("remote succeeded; local commit failed")
    });
    const beforePostRemoteRetry = deploy.count;
    result = await jsonRequest(
      runtime,
      `/api/operations/${encodeURIComponent(`publish:${afterRemote.publication.token}`)}/retry`,
      { method: "POST" }
    );
    assert.equal(result.response.status, 200);
    assert.equal(
      deploy.count,
      beforePostRemoteRetry,
      "a remote-success checkpoint must finalize locally without publishing again"
    );
    const recoveredAfterRemote = runtime.store.findActivePublication(afterRemote.publication.token);
    assert.equal(recoveredAfterRemote.publication.publicUrl, publicUrl);
    assert.equal(recoveredAfterRemote.publication.pending, false);
    assert.deepEqual(runtime.store.listOperations(), []);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rename recovery reapplies the requested slug after the original local rollback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-rename-recovery-"));
  const dataDir = path.join(root, "data");
  const reportPath = path.join(root, "index.html");
  await fs.writeFile(reportPath, "<h1>Recover rename</h1>", "utf8");
  const deploy = deployController();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: (...args) => deploy.spawn(...args),
    pagesDeployTimeoutMs: 1000
  });

  try {
    let result = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "rename-recovery",
        accountId: "56565656565656565656565656565656",
        adoptExisting: true
      })
    });
    result = await jsonRequest(runtime, "/api/reports/path", {
      method: "POST",
      body: JSON.stringify({ path: reportPath })
    });
    const reportId = result.body.report.id;
    result = await jsonRequest(runtime, `/api/reports/${reportId}/publish-snapshot`, {
      method: "POST"
    });
    const token = result.body.publication.token;
    const live = runtime.store.findActivePublication(token);
    const previousSlug = live.publication.slug;
    const renameOperation = {
      type: "rename",
      token,
      slug: "recovered-name",
      previousSlug,
      projectRef: live.publication.projectRef,
      reportId
    };
    // The normal rename path records the intent before the remote call, then
    // restores previousSlug when that call fails. This reproduces that durable
    // post-rollback journal state directly.
    await runtime.store.beginOperations([renameOperation]);
    await runtime.store.recordOperationFailure({
      ...renameOperation,
      error: new Error("rename deploy failed before remote success")
    });
    assert.equal(runtime.store.findActivePublication(token).publication.slug, previousSlug);

    result = await jsonRequest(
      runtime,
      `/api/operations/${encodeURIComponent(`rename:${token}`)}/retry`,
      { method: "POST" }
    );
    assert.equal(result.response.status, 200);
    const renamed = runtime.store.findActivePublication(token);
    assert.equal(renamed.publication.slug, "recovered-name");
    assert.equal(renamed.publication.revokedAt, null);
    assert.equal(runtime.store.getOperation(`rename:${token}`), null);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("authenticated daemon commands mutate the live server-owned store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-command-service-"));
  const dataDir = path.join(root, "data");
  const sourceDir = path.join(root, "source");
  const reportPath = path.join(sourceDir, "index.html");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(reportPath, "<h1>Daemon-owned publication</h1>", "utf8");
  const deploy = deployController();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: (...args) => deploy.spawn(...args),
    pagesDeployTimeoutMs: 1000
  });

  try {
    let result = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "command-service",
        accountId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        adoptExisting: true
      })
    });
    assert.equal(result.response.status, 200);

    result = await jsonRequest(runtime, "/api/command", {
      method: "POST",
      headers: { "X-Pagecast-Capability": "intentionally-invalid" },
      body: JSON.stringify({ command: "publish_report", payload: { path: reportPath } })
    });
    assert.equal(result.response.status, 403);

    result = await jsonRequest(runtime, "/api/command", {
      method: "POST",
      headers: { "X-Pagecast-Capability": runtime.commandCapability },
      body: JSON.stringify({
        command: "publish_report",
        payload: { path: reportPath, label: "daemon", expires: "never" }
      })
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.projectName, "command-service");
    assert.match(result.body.url, /command-service\.pages\.dev\/p\//);
    assert.equal(result.body.linkKind, "unlisted");
    assert.deepEqual(Object.keys(result.body).sort(), [
      "expiresAt",
      "label",
      "linkKind",
      "passwordProtected",
      "projectName",
      "reportId",
      "token",
      "url"
    ]);

    const live = runtime.store.findPublication(result.body.token);
    assert.ok(live, "the command must update the server's in-memory owner, not a second store");
    assert.equal(live.publication.publicUrl, result.body.url);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("daemon publish is one mutation transaction and preserves one-shot result parity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-atomic-command-"));
  const dataDir = path.join(root, "data");
  const reportPath = path.join(root, "index.html");
  await fs.writeFile(reportPath, "<h1>Atomic daemon publication</h1>", "utf8");
  const deploy = gatedDeployController();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: (...args) => deploy.spawn(...args),
    pagesDeployTimeoutMs: 1000
  });

  try {
    const configured = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "atomic-command",
        accountId: "abababababababababababababababab",
        adoptExisting: true
      })
    });
    assert.equal(configured.response.status, 200);

    const publishing = jsonRequest(runtime, "/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "publish_report",
        payload: { path: reportPath, label: "atomic", expires: "never" }
      })
    });
    await deploy.started;

    const expiryMutation = jsonRequest(runtime, "/api/config/expiry", {
      method: "POST",
      body: JSON.stringify({ default: "7d" })
    });
    const earlyResult = await Promise.race([
      expiryMutation.then(() => "interleaved"),
      new Promise((resolve) => setTimeout(() => resolve("queued"), 30))
    ]);
    assert.equal(earlyResult, "queued", "an unrelated mutation must wait for the whole publish command");
    assert.equal(runtime.configStore.get().defaultExpiry, "30d");

    deploy.release();
    const [published, expiry] = await Promise.all([publishing, expiryMutation]);
    assert.equal(published.response.status, 200);
    assert.equal(expiry.response.status, 200);
    assert.equal(published.body.linkKind, "unlisted");
    assert.deepEqual(Object.keys(published.body).sort(), [
      "expiresAt",
      "label",
      "linkKind",
      "passwordProtected",
      "projectName",
      "reportId",
      "token",
      "url"
    ]);
    assert.equal(runtime.configStore.get().defaultExpiry, "7d");
  } finally {
    deploy.release();
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a one-shot publisher delegates to the live workspace owner instead of opening a second store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-live-delegation-"));
  const dataDir = path.join(root, "data");
  const sourceDir = path.join(root, "source");
  const reportPath = path.join(sourceDir, "index.html");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(reportPath, "<h1>Delegated publish</h1>", "utf8");
  const deploy = deployController();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: (...args) => deploy.spawn(...args),
    pagesDeployTimeoutMs: 1000
  });

  try {
    const configured = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "live-delegation",
        accountId: "cccccccccccccccccccccccccccccccc",
        adoptExisting: true
      })
    });
    assert.equal(configured.response.status, 200);

    const result = await publishReportSnapshot({ path: reportPath, dataDir });
    assert.match(result.url, /live-delegation\.pages\.dev\/p\//);
    assert.ok(runtime.store.findPublication(result.token));
    assert.equal(deploy.count, 1);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("headless setup routes through the live config owner instead of opening a second writer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-live-config-owner-"));
  const dataDir = path.join(root, "data");
  const liveAccountId = "dddddddddddddddddddddddddddddddd";
  const runtimeAuthSpawn = wranglerSpawn(({ args }) => {
    const command = args.join(" ");
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({ accounts: [{ name: "Live owner", id: liveAccountId }] })
      };
    }
    if (args.includes("deployment") && args.includes("list")) {
      return {
        code: 0,
        output: JSON.stringify([
          {
            id: "live-deployment",
            url: "https://live-deployment.live-owner.pages.dev",
            environment: "production",
            created_on: "2026-07-10T10:00:00Z"
          },
          {
            id: "old-preview",
            url: "https://old-preview.live-owner.pages.dev",
            environment: "preview",
            created_on: "2026-07-09T10:00:00Z"
          }
        ])
      };
    }
    if (command.includes("kv namespace list")) {
      return {
        code: 0,
        output: JSON.stringify([
          { id: "33333333333333333333333333333333", title: "pagecast-feedback-store" }
        ])
      };
    }
    if (command.includes("deploy")) {
      return {
        code: 0,
        output: "Uploaded\nhttps://pagecast-feedback.live-owner.workers.dev"
      };
    }
    return { code: 0, output: "" };
  });
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: runtimeAuthSpawn
  });

  try {
    const configured = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "live-owner",
        accountId: liveAccountId,
        baseUrl: "https://live-owner.pages.dev",
        adoptExisting: true
      })
    });
    assert.equal(configured.response.status, 200);

    let headlessSpawnCalls = 0;
    const routedSetup = await setupCloudflarePages({
      projectName: "routed-live-writer",
      accountId: liveAccountId,
      dataDir,
      cloudflareAuthSpawnImpl: () => {
        headlessSpawnCalls += 1;
        throw new Error("the second config store must never initialize");
      }
    });
    assert.equal(routedSetup.config.pages.projectName, "routed-live-writer");
    assert.equal(headlessSpawnCalls, 0);

    const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8"));
    assert.equal(onDisk.pages.projectName, "routed-live-writer");
    assert.equal(onDisk.pages.accountId, liveAccountId);

    let oneShotStatusSpawns = 0;
    const status = await getCloudflarePagesStatus({
      dataDir,
      cloudflareAuthSpawnImpl: () => {
        oneShotStatusSpawns += 1;
        throw new Error("status should route to the live daemon");
      }
    });
    assert.equal(oneShotStatusSpawns, 0);
    assert.equal(status.config.pages.projectName, "routed-live-writer");
    assert.equal(status.config.pages.accountId, liveAccountId);

    let oneShotProjectSpawns = 0;
    const projects = await listCloudflarePagesProjects({
      dataDir,
      accountId: liveAccountId,
      cloudflareAuthSpawnImpl: () => {
        oneShotProjectSpawns += 1;
        throw new Error("project listing should route to the live daemon");
      }
    });
    assert.deepEqual(projects.projects, []);
    assert.equal(oneShotProjectSpawns, 0);

    let oneShotDeploymentSpawns = 0;
    const deploymentOptions = {
      dataDir,
      accountId: liveAccountId,
      cloudflareAuthSpawnImpl: () => {
        oneShotDeploymentSpawns += 1;
        throw new Error("deployment commands should route to the live daemon");
      }
    };
    const deployments = await listCloudflarePagesDeployments(deploymentOptions);
    assert.deepEqual(
      deployments.deployments.map((deployment) => deployment.id),
      ["live-deployment", "old-preview"]
    );
    const deleted = await deleteCloudflarePagesDeployment({
      ...deploymentOptions,
      id: "old-preview"
    });
    assert.deepEqual(deleted, { id: "old-preview", deleted: true });
    const pruned = await pruneCloudflarePagesDeployments({
      ...deploymentOptions,
      keep: 1
    });
    assert.equal(pruned.pruned, 1);
    assert.deepEqual(pruned.deleted, ["old-preview"]);
    assert.equal(oneShotDeploymentSpawns, 0);

    let oneShotFeedbackSpawns = 0;
    const feedback = await setupCloudflareFeedback({
      accountId: liveAccountId,
      dataDir,
      cloudflareAuthSpawnImpl: () => {
        oneShotFeedbackSpawns += 1;
        throw new Error("feedback setup should route to the live daemon");
      }
    });
    assert.equal(oneShotFeedbackSpawns, 0);
    assert.equal(
      feedback.feedback.url,
      "https://pagecast-feedback.live-owner.workers.dev"
    );
    assert.equal(
      runtime.configStore.get().feedback.url,
      "https://pagecast-feedback.live-owner.workers.dev"
    );
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("direct site deploy routes through the live owner and keeps its target stateless", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-live-direct-deploy-"));
  const dataDir = path.join(root, "data");
  const sourceDir = path.join(root, "site");
  const accountId = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "index.html"), "<h1>direct</h1>", "utf8");
  const deploy = deployController();
  const auth = wranglerSpawn(({ args }) => {
    if (args.includes("whoami")) {
      return { code: 0, output: JSON.stringify({ accounts: [{ name: "Direct", id: accountId }] }) };
    }
    if (args.includes("project") && args.includes("list")) {
      return {
        code: 0,
        output: JSON.stringify([
          { name: "direct-site", account_id: accountId, production_branch: "main" }
        ])
      };
    }
    return { code: 0, output: "" };
  });
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: auth,
    pagesDeploySpawnImpl: (...args) => deploy.spawn(...args),
    pagesDeployTimeoutMs: 1000
  });

  try {
    const selectedBefore = runtime.configStore.get().pages;
    let oneShotSpawns = 0;
    const result = await deployCloudflarePagesSite({
      sourceDir,
      projectName: "direct-site",
      accountId,
      dataDir,
      cloudflareAuthSpawnImpl: () => {
        oneShotSpawns += 1;
        throw new Error("direct deploy should use the live auth manager");
      },
      pagesDeploySpawnImpl: () => {
        oneShotSpawns += 1;
        throw new Error("direct deploy should use the live publisher");
      }
    });
    assert.equal(oneShotSpawns, 0);
    assert.equal(deploy.count, 1);
    assert.equal(result.projectName, "direct-site");
    assert.equal(result.accountId, accountId);
    assert.deepEqual(runtime.configStore.get().pages, selectedBefore);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("goal status reads through the live owner and read-only config init never creates state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-readonly-config-"));
  const missingDataDir = path.join(root, "missing-data");
  const readOnlyStore = createConfigStore({ dataDir: missingDataDir });
  await readOnlyStore.init({ persist: false });
  assert.equal(readOnlyStore.get().goal, null);
  await assert.rejects(
    () => fs.access(path.join(missingDataDir, "config.json")),
    (error) => error?.code === "ENOENT"
  );

  const dataDir = path.join(root, "live-data");
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });
  const configPath = path.join(dataDir, "config.json");
  const backupPath = path.join(dataDir, "config.backup.json");
  try {
    await runtime.configStore.setGoal({
      token: "live-goal-token",
      slug: "goal",
      url: "https://live-goal.pages.dev/p/goal/",
      file: "/tmp/live-goal.md",
      startedAt: "2026-07-09T00:00:00.000Z"
    });
    await fs.rename(configPath, backupPath);
    const status = await getGoalStatus({ dataDir });
    assert.equal(status.goal?.token, "live-goal-token");
    await assert.rejects(
      () => fs.access(configPath),
      (error) => error?.code === "ENOENT"
    );
  } finally {
    await fs.rename(backupPath, configPath).catch(() => {});
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("real CLI telemetry preflight never opens a competing config writer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-cli-config-owner-"));
  const dataDir = path.join(root, ".pagecast");
  const accountId = "abababababababababababababababab";
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: wranglerSpawn(() => ({
      code: 0,
      output: "You are not authenticated."
    }))
  });

  try {
    const configured = await jsonRequest(runtime, "/api/config/pages", {
      method: "POST",
      body: JSON.stringify({
        projectName: "cli-live-owner",
        accountId,
        baseUrl: "https://cli-live-owner.pages.dev",
        adoptExisting: true
      })
    });
    assert.equal(configured.response.status, 200);
    const configPath = path.join(dataDir, "config.json");
    const before = await fs.readFile(configPath, "utf8");
    const cliPath = path.resolve("src/cli.js");
    const env = {
      ...process.env,
      CI: "",
      DO_NOT_TRACK: "",
      PAGECAST_TELEMETRY: "1",
      PAGECAST_TELEMETRY_URL: "http://127.0.0.1:1"
    };

    const status = await execFileAsync(
      process.execPath,
      [cliPath, "pages", "status", "--json"],
      { cwd: root, env }
    );
    const statusBody = JSON.parse(status.stdout);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.config.pages.projectName, "cli-live-owner");
    assert.equal(
      await fs.readFile(configPath, "utf8"),
      before,
      "telemetry preflight must not initialize or save a second config store"
    );

    const telemetry = await execFileAsync(
      process.execPath,
      [cliPath, "telemetry", "disable", "--json"],
      { cwd: root, env }
    );
    assert.deepEqual(JSON.parse(telemetry.stdout), {
      ok: true,
      telemetry: { configEnabled: false, enabled: true, reason: "env" }
    });
    const afterTelemetry = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(afterTelemetry.telemetry, false);
    assert.equal(afterTelemetry.telemetryNotified, true);
    assert.equal(afterTelemetry.pages.projectName, "cli-live-owner");
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("standalone CLI telemetry mutations retain their JSON contract under the lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-cli-telemetry-"));
  const env = { ...process.env, CI: "", DO_NOT_TRACK: "", PAGECAST_TELEMETRY: "" };
  try {
    const result = await execFileAsync(
      process.execPath,
      [path.resolve("src/cli.js"), "telemetry", "disable", "--json"],
      { cwd: root, env }
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      telemetry: { configEnabled: false, enabled: false, reason: "config" }
    });
    const saved = JSON.parse(
      await fs.readFile(path.join(root, ".pagecast", "config.json"), "utf8")
    );
    assert.equal(saved.telemetry, false);
    assert.equal(saved.telemetryNotified, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent headless config mutations have one lease owner and fail the contender visibly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-headless-contended-"));
  const dataDir = path.join(root, "data");
  const accountId = "ffffffffffffffffffffffffffffffff";
  let announceFirstSpawn;
  let releaseFirstSpawn;
  let blocked = false;
  const firstSpawnStarted = new Promise((resolve) => {
    announceFirstSpawn = resolve;
  });
  const firstSpawnRelease = new Promise((resolve) => {
    releaseFirstSpawn = resolve;
  });
  const spawnImpl = wranglerSpawn(async ({ args }) => {
    if (args.includes("whoami")) {
      if (!blocked) {
        blocked = true;
        announceFirstSpawn();
        await firstSpawnRelease;
      }
      return {
        code: 0,
        output: JSON.stringify({ accounts: [{ name: "Contended", id: accountId }] })
      };
    }
    if (args.includes("list")) {
      return {
        code: 0,
        output: JSON.stringify([
          { name: "lease-winner", account_id: accountId, production_branch: "main" }
        ])
      };
    }
    return { code: 0, output: "" };
  });

  const first = setupCloudflarePages({
    projectName: "lease-winner",
    accountId,
    dataDir,
    cloudflareAuthSpawnImpl: spawnImpl,
    cloudflareListTimeoutMs: 1000
  });
  await firstSpawnStarted;
  try {
    await assert.rejects(
      () =>
        setupCloudflarePages({
          projectName: "lease-loser",
          accountId,
          dataDir,
          cloudflareAuthSpawnImpl: spawnImpl,
          cloudflareListTimeoutMs: 1000
        }),
      (error) => error?.code === "PAGECAST_WORKSPACE_BUSY"
    );
  } finally {
    releaseFirstSpawn();
  }

  try {
    const result = await first;
    assert.equal(result.config.pages.projectName, "lease-winner");
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8"));
    assert.equal(saved.pages.projectName, "lease-winner");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read-only project listing does not persist an account override", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-project-list-readonly-"));
  const dataDir = path.join(root, "data");
  const originalAccountId = "11111111111111111111111111111111";
  const overrideAccountId = "22222222222222222222222222222222";
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    projectName: "saved-project",
    accountId: originalAccountId,
    baseUrl: "https://saved-project.pages.dev"
  });

  const spawnImpl = wranglerSpawn(({ args, options }) => {
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({ accounts: [{ name: "Override", id: overrideAccountId }] })
      };
    }
    if (args.includes("list")) {
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, overrideAccountId);
      return {
        code: 0,
        output: JSON.stringify([
          { name: "other-project", account_id: overrideAccountId, production_branch: "main" }
        ])
      };
    }
    return { code: 0, output: "" };
  });

  try {
    const result = await listCloudflarePagesProjects({
      accountId: overrideAccountId,
      dataDir,
      cloudflareAuthSpawnImpl: spawnImpl,
      cloudflareListTimeoutMs: 1000
    });
    assert.equal(result.accountId, overrideAccountId);
    assert.equal(result.projects[0].name, "other-project");

    const saved = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8"));
    assert.equal(saved.pages.projectName, "saved-project");
    assert.equal(saved.pages.accountId, originalAccountId);
    assert.equal(saved.pages.baseUrl, "https://saved-project.pages.dev");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
