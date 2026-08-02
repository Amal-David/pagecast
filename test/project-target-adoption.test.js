import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServers } from "../src/server.js";

const CURRENT_TARGET = {
  accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  projectName: "current-project",
  baseUrl: "https://current-project.pages.dev"
};
const ADOPTED_TARGET = {
  accountId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  projectName: "adopted-project",
  baseUrl: "https://assigned-adopted-origin.pages.dev"
};

async function makeFixture() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-target-adoption-"));
  const dataDir = path.join(tempDir, "data");
  const sourceDir = path.join(tempDir, "source");
  const reportPath = path.join(sourceDir, "legacy.html");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(reportPath, "<h1>Legacy publication</h1>", "utf8");

  const runtime = await startServers({
    host: "127.0.0.1",
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });
  await runtime.configStore.updatePages({ ...CURRENT_TARGET, adoptExisting: true });
  const report = await runtime.store.addPath(reportPath);
  const publication = {
    token: "legacy-publication",
    slug: "legacy-publication",
    label: "legacy-publication",
    kind: "snapshot",
    publicUrl: "https://assigned-collision.pages.dev/p/legacy-publication/",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    revokedAt: null
  };
  const untouchedPublication = {
    ...publication,
    token: "untouched-legacy-publication",
    slug: "untouched-legacy-publication",
    label: "untouched-legacy-publication",
    publicUrl: "https://assigned-collision.pages.dev/p/untouched-legacy-publication/"
  };
  await runtime.store.commitPublication(report.id, publication);
  await runtime.store.commitPublication(report.id, untouchedPublication);
  return { tempDir, runtime, report, publication, untouchedPublication };
}

async function postJson(runtime, pathname, body) {
  return fetch(`${runtime.adminUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pagecast-Capability": runtime.commandCapability
    },
    body: JSON.stringify(body)
  });
}

test("adopting a missing publication has no target-management side effect", async () => {
  const fixture = await makeFixture();
  const { runtime, tempDir } = fixture;
  const managedBefore = runtime.configStore.get().managedTargets;

  try {
    const response = await postJson(runtime, "/api/publications/missing/target", {
      confirm: true,
      ...ADOPTED_TARGET
    });

    assert.equal(response.status, 404);
    assert.deepEqual(runtime.configStore.get().managedTargets, managedBefore);
    assert.equal(runtime.configStore.isTargetManaged(ADOPTED_TARGET), false);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("cross-project adoption requires an explicit baseUrl and scopes only that publication", async () => {
  const fixture = await makeFixture();
  const { runtime, tempDir, publication, untouchedPublication } = fixture;
  const endpoint = `/api/publications/${publication.token}/target`;

  try {
    const missingBaseUrl = await postJson(runtime, endpoint, {
      confirm: true,
      accountId: ADOPTED_TARGET.accountId,
      projectName: ADOPTED_TARGET.projectName
    });
    assert.equal(missingBaseUrl.status, 400);
    assert.match((await missingBaseUrl.json()).error.message, /baseUrl/i);
    assert.equal(runtime.store.findPublication(publication.token).publication.projectRef ?? null, null);
    assert.equal(runtime.configStore.isTargetManaged(ADOPTED_TARGET), false);

    const adopted = await postJson(runtime, endpoint, { confirm: true, ...ADOPTED_TARGET });
    assert.equal(adopted.status, 200);
    const body = await adopted.json();
    assert.deepEqual(body.projectRef, ADOPTED_TARGET);
    assert.equal(body.publication.targetAttributed, true);

    const stored = runtime.store.findPublication(publication.token).publication;
    assert.deepEqual(stored.projectRef, ADOPTED_TARGET);
    assert.equal(stored.publicUrl, publication.publicUrl, "adoption must not invent a new origin");
    assert.equal(
      runtime.store.findPublication(untouchedPublication.token).publication.projectRef ?? null,
      null,
      "adoption must attribute only the selected publication"
    );
    assert.equal(runtime.configStore.isTargetManaged(ADOPTED_TARGET), true);
    assert.deepEqual(runtime.configStore.get().pages, {
      ...CURRENT_TARGET,
      accountName: "",
      branch: "main",
      customDomain: null
    });
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("malformed cross-project baseUrl is rejected as caller input without side effects", async () => {
  const fixture = await makeFixture();
  const { runtime, tempDir, publication } = fixture;

  try {
    const response = await postJson(
      runtime,
      `/api/publications/${publication.token}/target`,
      {
        confirm: true,
        accountId: ADOPTED_TARGET.accountId,
        projectName: ADOPTED_TARGET.projectName,
        baseUrl: "https://"
      }
    );

    assert.equal(response.status, 400);
    assert.equal(runtime.store.findPublication(publication.token).publication.projectRef ?? null, null);
    assert.equal(runtime.configStore.isTargetManaged(ADOPTED_TARGET), false);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
