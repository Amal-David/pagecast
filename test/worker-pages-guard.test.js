import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishReportSnapshot, startServers } from "../src/server.js";

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

test("revoked Worker publications no longer block Pages revoke-all or report deletion", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-revoked-worker-pages-guard-"));
  const now = new Date().toISOString();
  const publication = {
    token: "revoked-worker-publication", slug: "revoked-worker-publication", label: "Worker report", kind: "snapshot",
    createdAt: now, updatedAt: now, publicUrl: "https://worker.example/p/revoked-worker-publication/", expiresAt: null,
    revokedAt: now, target: { backend: "workers", origin: "https://worker.example", ownerId: "owner", profileId: "profile_123", publicationId: "remote-publication", activeVersionId: "version-1" }
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
    const request = (pathname, method) => fetch(`${runtime.adminUrl}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Pagecast-Capability": runtime.commandCapability }
    });
    assert.equal((await request("/api/reports/report/revoke-all", "POST")).status, 200);
    assert.equal((await request("/api/reports/report", "DELETE")).status, 200);
    assert.equal(runtime.store.get("report"), null);
  } finally {
    await runtime.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("daemon-routed Worker publishes preserve attachToReportId", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-daemon-attachment-"));
  const now = new Date().toISOString();
  const reportPath = path.join(dataDir, "report.html");
  const workerFetch = async (url, options = {}) => {
    if (url.endsWith("/v1/status")) return Response.json({ apiVersion: 2, capabilities: ["publications.upload", "publications.access", "publications.versions"] });
    if (options.method === "POST" && url.includes("upload-sessions") && !url.includes("complete")) return Response.json({ sessionId: "session", publicationId: "worker-publication", versionId: "version-1", slug: "worker-report" });
    if (options.method === "PUT") return Response.json({ uploaded: true });
    if (options.method === "POST" && url.endsWith("/complete")) return Response.json({ status: "complete" });
    if (options.method === "POST" && url.endsWith("/activate")) return Response.json({ publicationId: "worker-publication", versionId: "version-1", state: "published" });
    throw new Error(`Unexpected Worker request: ${options.method || "GET"} ${url}`);
  };
  await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ workers: { activeProfileId: "profile_123", profiles: [{ profileId: "profile_123", origin: "http://127.0.0.1:8787", ownerId: "owner", allowLoopbackHttp: true }] } }));
  await fs.writeFile(path.join(dataDir, "worker-credentials.json"), JSON.stringify({ profile_123: "secret" }), { mode: 0o600 });
  await fs.writeFile(reportPath, "<h1>Report</h1>");
  await fs.writeFile(path.join(dataDir, "reports.json"), JSON.stringify({
    version: 4, redirects: [], operations: [], pendingDeletions: [], reports: [{
      id: "report", kind: "path", name: "Report", sourcePath: reportPath, rootDir: dataDir, entryFile: "report.html",
      createdAt: now, updatedAt: now, passwordProtected: false, publications: [{ token: "pages-publication", slug: "pages-report", label: "Pages report", kind: "snapshot", createdAt: now, updatedAt: now, publicUrl: "https://pages.example/p/pages-report/", expiresAt: null, revokedAt: null }]
    }]
  }));
  const runtime = await startServers({ adminPort: 0, publicPort: 0, dataDir, staticDir: path.join(root, "public"), fetchImpl: workerFetch });
  try {
    const result = await publishReportSnapshot({ path: reportPath, backend: "workers", newLink: true, attachToReportId: "report", dataDir });
    assert.equal(result.reportId, "report");
    const report = runtime.store.get("report");
    assert.equal(report.publications.length, 2);
    assert.equal(report.publications[1].target.backend, "workers");
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
