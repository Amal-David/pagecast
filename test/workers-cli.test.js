import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WORKER_CREDENTIAL_FILE } from "../src/worker-client.js";

const root = path.resolve(import.meta.dirname, "..");

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("workers CLI versions, rollback, and protected migration dispatch without a missing store binding", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-workers-cli-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url.includes("/versions/ver-2/rollback")) response.end(JSON.stringify({ publicationId: "remote-pub", versionId: "ver-2" }));
    else response.end(JSON.stringify({ versions: [{ id: "ver-1", versionNumber: 1, status: "published" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const publication = {
    token: "local-token", slug: "local-token", label: "protected", kind: "snapshot", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    publicUrl: "https://legacy.pages.dev/p/local-token/", passwordProtected: false, expiresAt: null,
    target: { backend: "workers", origin, ownerId: "owner", profileId: "profile_123", publicationId: "remote-pub", activeVersionId: "ver-1", allowLoopbackHttp: true }
  };
  try {
    await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ workers: { activeProfileId: "profile_123", profiles: [{ profileId: "profile_123", origin, ownerId: "owner", allowLoopbackHttp: true }] } }));
    await fs.writeFile(path.join(dataDir, WORKER_CREDENTIAL_FILE), JSON.stringify({ profile_123: "secret" }), { mode: 0o600 });
    await fs.writeFile(path.join(dataDir, "reports.json"), JSON.stringify({ version: 4, reports: [{ id: "report", kind: "path", name: "report", sourcePath: path.join(dataDir, "report.html"), rootDir: dataDir, entryFile: "report.html", createdAt: publication.createdAt, updatedAt: publication.updatedAt, publications: [publication] }], redirects: [], operations: [], pendingDeletions: [] }));
    await fs.writeFile(path.join(dataDir, "report.html"), "<title>report</title>");
    const versions = await run(["workers", "versions", "local-token", "--data-dir", dataDir, "--json"]);
    assert.equal(versions.code, 0, versions.stderr);
    const rollback = await run(["workers", "rollback", "local-token", "ver-2", "--data-dir", dataDir, "--json"]);
    assert.equal(rollback.code, 0, rollback.stderr);
    assert.ok(requests.some((entry) => entry.includes("GET /v1/owners/owner/publications/remote-pub")));
    assert.ok(requests.some((entry) => entry.includes("POST /v1/owners/owner/publications/remote-pub/versions/ver-2/rollback")));
    const after = JSON.parse(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"));
    assert.equal(after.reports[0].publications[0].target.activeVersionId, "ver-2");
    after.reports[0].passwordProtected = true;
    after.reports[0].passwordHash = { salt: "aabbccddeeff0011", hash: "a".repeat(64), iterations: 100000 };
    delete after.reports[0].publications[0].target;
    await fs.writeFile(path.join(dataDir, "reports.json"), JSON.stringify(after));
    const migrate = await run(["workers", "migrate", "local-token", "--data-dir", dataDir, "--json"]);
    assert.equal(migrate.code, 2, JSON.stringify(migrate));
    assert.match(migrate.stdout, /requires a new Worker --password/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
