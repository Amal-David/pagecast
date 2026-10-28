import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializePagecastHome,
  resolvePagecastHomePaths
} from "../src/pagecast-home.js";
import { WorkspaceLease } from "../src/state-coordinator.js";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-home-"));
}

test("default managed state resolves to one user-level Home while --data-dir stays isolated", () => {
  const homeDir = path.join(path.sep, "Users", "pagecast");
  const cwd = path.join(path.sep, "work", "quarterly-report");

  assert.deepEqual(resolvePagecastHomePaths({ homeDir, cwd }), {
    dataDir: path.resolve(homeDir, ".pagecast", "home"),
    workspaceDataDir: path.resolve(cwd, ".pagecast"),
    isolated: false
  });
  assert.deepEqual(
    resolvePagecastHomePaths({ homeDir, cwd, explicitDataDir: "./isolated" }),
    {
      dataDir: path.resolve(cwd, "isolated"),
      workspaceDataDir: path.resolve(cwd, "isolated"),
      isolated: true
    }
  );
});

test("first legacy workspace becomes the Home without changing publications or ownership secrets", async () => {
  const root = await tempRoot();
  const homeDir = path.join(root, "user");
  const cwd = path.join(root, "workspace");
  const legacy = path.join(cwd, ".pagecast");
  const sourcePath = path.join(cwd, "index.html");
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(sourcePath, "<h1>Legacy</h1>");
  await fs.writeFile(
    path.join(legacy, "config.json"),
    JSON.stringify({
      version: 4,
      installationId: "11111111111111111111111111111111",
      pages: {
        accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        projectName: "my-pagecast-home",
        baseUrl: "https://my-pagecast-home.pages.dev"
      }
    })
  );
  await fs.writeFile(
    path.join(legacy, "publisher-owner.json"),
    JSON.stringify({
      ownerId: "22222222222222222222222222222222",
      markerSecret: "3".repeat(64)
    })
  );
  const legacyState = {
    version: 4,
    reports: [
      {
        id: "legacy-report",
        kind: "path",
        name: "Legacy",
        sourcePath,
        rootDir: cwd,
        entryFile: "index.html",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        publications: [
          {
            token: "legacy-token",
            slug: "legacy-slug",
            publicUrl: "https://my-pagecast-home.pages.dev/p/legacy-slug/",
            createdAt: "2026-07-01T00:00:00.000Z"
          }
        ]
      }
    ],
    redirects: [],
    operations: [],
    pendingDeletions: []
  };
  await fs.writeFile(path.join(legacy, "reports.json"), JSON.stringify(legacyState));

  const result = await initializePagecastHome({ homeDir, cwd });
  assert.equal(result.imported, true);
  assert.equal(result.mode, "home");

  const homeState = JSON.parse(await fs.readFile(path.join(result.dataDir, "reports.json"), "utf8"));
  assert.equal(homeState.reports.length, 1);
  assert.equal(homeState.reports[0].workspaceId, result.workspaceId);
  assert.equal(
    homeState.reports[0].publications[0].publicUrl,
    "https://my-pagecast-home.pages.dev/p/legacy-slug/"
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(result.dataDir, "publisher-owner.json"), "utf8")),
    { ownerId: "22222222222222222222222222222222", markerSecret: "3".repeat(64) }
  );

  const rerun = await initializePagecastHome({ homeDir, cwd });
  assert.equal(rerun.imported, false);
  const rerunState = JSON.parse(await fs.readFile(path.join(result.dataDir, "reports.json"), "utf8"));
  assert.equal(rerunState.reports.length, 1);
  assert.equal(rerunState.reports[0].publications.length, 1);

  await fs.rm(root, { recursive: true, force: true });
});

test("a workspace on another Cloudflare project is registered as legacy and never becomes a second writer", async () => {
  const root = await tempRoot();
  const homeDir = path.join(root, "user");
  const firstCwd = path.join(root, "first");
  const secondCwd = path.join(root, "second");
  for (const [cwd, projectName, token] of [
    [firstCwd, "primary-home", "primary-token"],
    [secondCwd, "other-project", "other-token"]
  ]) {
    const legacy = path.join(cwd, ".pagecast");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(
      path.join(legacy, "config.json"),
      JSON.stringify({
        installationId: token.padEnd(32, "0").slice(0, 32),
        pages: {
          accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          projectName,
          baseUrl: `https://${projectName}.pages.dev`
        }
      })
    );
    await fs.writeFile(
      path.join(legacy, "reports.json"),
      JSON.stringify({ version: 4, reports: [], redirects: [], operations: [], pendingDeletions: [] })
    );
  }

  const first = await initializePagecastHome({ homeDir, cwd: firstCwd });
  const second = await initializePagecastHome({ homeDir, cwd: secondCwd });
  assert.equal(first.mode, "home");
  assert.equal(second.mode, "legacy-target");

  const config = JSON.parse(await fs.readFile(path.join(first.dataDir, "config.json"), "utf8"));
  assert.equal(config.pages.projectName, "primary-home");
  const registry = JSON.parse(await fs.readFile(path.join(first.dataDir, "workspaces.json"), "utf8"));
  const secondEntry = registry.workspaces.find((entry) => entry.id === second.workspaceId);
  assert.equal(secondEntry.mode, "legacy-target");
  assert.equal(secondEntry.legacyTarget.projectName, "other-project");

  // A previously registered legacy workspace can later supply the only copy
  // of account-scoped feedback credentials without changing Home's Pages target.
  const secondConfigPath = path.join(secondCwd, ".pagecast", "config.json");
  const secondConfig = JSON.parse(await fs.readFile(secondConfigPath, "utf8"));
  secondConfig.feedback = {
    url: "https://pagecast-feedback.example.workers.dev",
    workerName: "pagecast-feedback",
    kvId: "legacy-kv-id",
    statsToken: "preserved-stats-token"
  };
  await fs.writeFile(secondConfigPath, JSON.stringify(secondConfig));
  const registeredRerun = await initializePagecastHome({ homeDir, cwd: secondCwd });
  assert.equal(registeredRerun.imported, false);

  const mergedConfig = JSON.parse(await fs.readFile(path.join(first.dataDir, "config.json"), "utf8"));
  assert.equal(mergedConfig.pages.projectName, "primary-home");
  assert.deepEqual(mergedConfig.feedback, secondConfig.feedback);

  await fs.rm(root, { recursive: true, force: true });
});

test("legacy feedback credentials never cross Cloudflare account boundaries", async () => {
  const root = await tempRoot();
  const homeDir = path.join(root, "user");
  const primaryCwd = path.join(root, "primary");
  const foreignCwd = path.join(root, "foreign");

  for (const [cwd, accountId, feedback] of [
    [primaryCwd, "a".repeat(32), null],
    [foreignCwd, "b".repeat(32), { statsToken: "must-not-cross-accounts" }]
  ]) {
    const legacy = path.join(cwd, ".pagecast");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "config.json"), JSON.stringify({
      pages: { accountId, projectName: `${path.basename(cwd)}-project` },
      feedback
    }));
    await fs.writeFile(
      path.join(legacy, "reports.json"),
      JSON.stringify({ version: 4, reports: [], redirects: [], operations: [], pendingDeletions: [] })
    );
  }

  const primary = await initializePagecastHome({ homeDir, cwd: primaryCwd });
  await initializePagecastHome({ homeDir, cwd: foreignCwd });
  const config = JSON.parse(await fs.readFile(path.join(primary.dataDir, "config.json"), "utf8"));
  assert.equal(config.feedback, null);

  await fs.rm(root, { recursive: true, force: true });
});

async function pathExists(target) {
  return fs.access(target).then(() => true, () => false);
}

async function writeLegacyWorkspace(cwd, { operations = [] } = {}) {
  const legacy = path.join(cwd, ".pagecast");
  for (const dir of [
    "pages-site/p/legacy-slug",
    "pages-deploy/direct/target/main",
    "feedback-deploy",
    "working/report-1",
    "imports/upload-1"
  ]) {
    await fs.mkdir(path.join(legacy, dir), { recursive: true });
    await fs.writeFile(path.join(legacy, dir, "index.html"), "<h1>legacy</h1>");
  }
  await fs.writeFile(
    path.join(legacy, "reports.json"),
    JSON.stringify({
      version: 4,
      reports: [
        {
          id: "report-1",
          kind: "folder",
          rootDir: path.join(legacy, "imports", "upload-1"),
          workingDir: path.join(legacy, "working", "report-1"),
          publications: []
        }
      ],
      redirects: [],
      operations,
      pendingDeletions: []
    })
  );
  return legacy;
}

test("legacy staging caches are removed once imported, but never under a live legacy owner", async () => {
  const root = await tempRoot();
  const homeDir = path.join(root, "user");
  const cwd = path.join(root, "workspace");
  const legacy = await writeLegacyWorkspace(cwd);
  const staging = ["pages-site", "pages-deploy", "feedback-deploy"].map((name) =>
    path.join(legacy, name)
  );

  const oldDaemon = new WorkspaceLease(legacy);
  await oldDaemon.acquire({ capability: "old-daemon-capability", role: "daemon" });
  const first = await initializePagecastHome({ homeDir, cwd });
  assert.equal(first.imported, true);
  for (const dir of staging) assert.equal(await pathExists(dir), true, `${dir} kept while owned`);
  await oldDaemon.release();

  const rerun = await initializePagecastHome({ homeDir, cwd });
  assert.equal(rerun.imported, false);
  for (const dir of staging) assert.equal(await pathExists(dir), false, `${dir} removed`);
  // Imported reports still serve from their legacy source and working copies.
  assert.equal(await pathExists(path.join(legacy, "imports", "upload-1", "index.html")), true);
  assert.equal(await pathExists(path.join(legacy, "working", "report-1", "index.html")), true);
  assert.equal(await pathExists(path.join(legacy, "workspace.lock")), false);

  await fs.rm(root, { recursive: true, force: true });
});

test("legacy staging stays when the legacy workspace has journals Home could not adopt", async () => {
  const root = await tempRoot();
  const homeDir = path.join(root, "user");
  const cwd = path.join(root, "workspace");
  const legacy = await writeLegacyWorkspace(cwd, {
    operations: [{ id: "deploy-in-flight", phase: "staged" }]
  });

  const result = await initializePagecastHome({ homeDir, cwd });
  assert.equal(result.mode, "home");
  assert.equal(await pathExists(path.join(legacy, "pages-deploy", "direct")), true);
  assert.equal(await pathExists(path.join(legacy, "pages-site", "p")), true);

  await fs.rm(root, { recursive: true, force: true });
});

test("the workspace registry follows a moved workspace and drops deleted ones on the next registration", async () => {
  const root = await tempRoot();
  const homeDir = path.join(root, "user");
  const kept = path.join(root, "kept");
  const deleted = path.join(root, "deleted");
  const moved = path.join(root, "moved");
  const fresh = path.join(root, "fresh");
  for (const cwd of [kept, deleted, moved, fresh]) await fs.mkdir(cwd, { recursive: true });

  const keptResult = await initializePagecastHome({ homeDir, cwd: kept });
  await initializePagecastHome({ homeDir, cwd: deleted });
  const movedResult = await initializePagecastHome({ homeDir, cwd: moved });
  await fs.rm(deleted, { recursive: true, force: true });
  const movedTo = path.join(root, "moved-elsewhere");
  await fs.rename(moved, movedTo);

  const rerun = await initializePagecastHome({ homeDir, cwd: movedTo });
  assert.equal(rerun.imported, false);
  assert.equal(rerun.workspaceId, movedResult.workspaceId);
  const freshResult = await initializePagecastHome({ homeDir, cwd: fresh });

  const registry = JSON.parse(await fs.readFile(path.join(rerun.dataDir, "workspaces.json"), "utf8"));
  assert.deepEqual(
    registry.workspaces.map((entry) => [entry.id, entry.root, entry.legacyDataDir]).sort(),
    [
      [keptResult.workspaceId, kept, path.join(kept, ".pagecast")],
      [movedResult.workspaceId, movedTo, path.join(movedTo, ".pagecast")],
      [freshResult.workspaceId, fresh, path.join(fresh, ".pagecast")]
    ].sort()
  );

  await fs.rm(root, { recursive: true, force: true });
});
