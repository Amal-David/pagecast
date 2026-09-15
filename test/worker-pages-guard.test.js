import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServers } from "../src/server.js";

const root = path.resolve(import.meta.dirname, "..");

const pagesTarget = {
  accountId: "0123456789abcdef0123456789abcdef",
  projectName: "worker-guard-pages",
  baseUrl: "https://worker-guard-pages.pages.dev"
};

function countedPagesDeploy() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    spawn() {
      calls += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => child.emit("exit", null, "SIGTERM");
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("https://worker-guard-pages.pages.dev"));
        child.emit("exit", 0, null);
      });
      return child;
    }
  };
}

async function startWorkerBackedReport() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-pages-sync-"));
  const now = new Date().toISOString();
  const reportPath = path.join(dataDir, "report.html");
  const publication = {
    token: "worker-publication", slug: "worker-publication", label: "Worker report", kind: "snapshot",
    createdAt: now, updatedAt: now, publicUrl: "https://worker.example/p/worker-publication/",
    localUrl: null, expiresAt: null, revokedAt: null,
    pagesProjectName: pagesTarget.projectName, pagesAccountId: pagesTarget.accountId,
    pagesBaseUrl: pagesTarget.baseUrl, projectRef: pagesTarget,
    target: { backend: "workers", origin: "https://worker.example", ownerId: "owner", profileId: "profile_123", publicationId: "remote-publication", activeVersionId: "version-1" }
  };
  await fs.writeFile(path.join(dataDir, "config.json"), "{}");
  await fs.writeFile(reportPath, "<h1>Worker report</h1>");
  await fs.writeFile(path.join(dataDir, "reports.json"), JSON.stringify({
    version: 4, redirects: [], operations: [], pendingDeletions: [], reports: [{
      id: "report", kind: "path", name: "Worker report", sourcePath: reportPath, rootDir: dataDir,
      entryFile: "report.html", createdAt: now, updatedAt: now, passwordProtected: false, publications: [publication]
    }]
  }));
  const deploy = countedPagesDeploy();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.join(root, "public"),
    pagesDeploySpawnImpl: deploy.spawn
  });
  const request = (pathname, method, body) => fetch(`${runtime.adminUrl}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Pagecast-Capability": runtime.commandCapability },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return {
    runtime,
    reportPath,
    publication,
    deploy,
    request,
    async close() {
      await runtime.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}

test("Pages-only publication endpoints reject Worker-backed rows before local or Pages mutation", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-pages-guard-"));
  const now = new Date().toISOString();
  const publication = {
    token: "worker-publication", slug: "worker-publication", label: "Worker report", kind: "snapshot",
    createdAt: now, updatedAt: now, publicUrl: "https://worker.example/p/worker-publication/",
    localUrl: null, expiresAt: null, revokedAt: null,
    target: { backend: "workers", origin: "https://worker.example", ownerId: "owner", profileId: "profile_123", publicationId: "remote-publication", activeVersionId: "version-1" }
  };
  await fs.writeFile(path.join(dataDir, "config.json"), "{}");
  await fs.writeFile(path.join(dataDir, "report.html"), "<h1>Worker report</h1>");
  await fs.writeFile(path.join(dataDir, "reports.json"), JSON.stringify({
    version: 4, redirects: [], operations: [], pendingDeletions: [], reports: [{
      id: "report", kind: "path", name: "Worker report", sourcePath: path.join(dataDir, "report.html"), rootDir: dataDir,
      entryFile: "report.html", createdAt: now, updatedAt: now, passwordProtected: false, publications: [publication]
    }]
  }));
  const runtime = await startServers({ adminPort: 0, publicPort: 0, dataDir, staticDir: path.join(root, "public") });
  try {
    const request = async (pathname, method, body) => {
      const response = await fetch(`${runtime.adminUrl}${pathname}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Pagecast-Capability": runtime.commandCapability },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      assert.equal(response.status, 409, `${method} ${pathname}`);
      await assert.doesNotReject(response.json());
    };
    await request(`/api/publications/${publication.token}/target`, "POST", { confirm: true });
    await request(`/api/publications/${publication.token}/sync`, "POST", {});
    await request(`/api/publications/${publication.token}/expiry`, "POST", { expires: "7d" });
    await request(`/api/publications/${publication.token}/slug`, "PUT", { slug: "changed" });
    await request(`/api/publications/${publication.token}/revoke`, "POST", {});
    await request("/api/reports/report/revoke-all", "POST", {});
    await request("/api/reports/report", "DELETE");
    const after = JSON.parse(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"));
    assert.equal(after.reports[0].publications[0].slug, publication.slug);
    assert.equal(after.reports[0].publications[0].revokedAt, null);
  } finally {
    await runtime.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("saving a Worker-backed report does not invoke the Pages deployment path", async () => {
  const fixture = await startWorkerBackedReport();
  try {
    const response = await fixture.request("/api/reports/report/content", "PUT", { html: "<h1>Updated locally</h1>" });
    assert.equal(response.status, 200);
    assert.equal(fixture.deploy.calls, 0);
  } finally {
    await fixture.close();
  }
});

test("changing a Worker-backed report password does not invoke the Pages deployment path", async () => {
  const fixture = await startWorkerBackedReport();
  try {
    const response = await fixture.request("/api/reports/report/password-protection", "POST", { enabled: true, password: "worker-only-password" });
    assert.equal(response.status, 200);
    assert.equal(fixture.deploy.calls, 0);
  } finally {
    await fixture.close();
  }
});

test("auto-sync changes for a Worker-backed report do not invoke the Pages deployment path", async () => {
  const fixture = await startWorkerBackedReport();
  try {
    const enabled = await fixture.request("/api/reports/report/auto-sync", "POST", { enabled: true });
    assert.equal(enabled.status, 200);
    await fs.writeFile(fixture.reportPath, "<h1>Changed at the source</h1>");
    await new Promise((resolve) => setTimeout(resolve, 1400));
    assert.equal(fixture.deploy.calls, 0);
    assert.equal(fixture.runtime.store.get("report").publications[0].updatedAt, fixture.publication.updatedAt);
  } finally {
    await fixture.close();
  }
});
