import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializePagecastHome,
  resolvePagecastHomePaths
} from "../src/pagecast-home.js";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-home-"));
}

test("default managed state resolves to one user-level Home while --data-dir stays isolated", () => {
  const homeDir = path.join(path.sep, "Users", "pagecast");
  const cwd = path.join(path.sep, "work", "quarterly-report");

  assert.deepEqual(resolvePagecastHomePaths({ homeDir, cwd }), {
    dataDir: path.join(homeDir, ".pagecast", "home"),
    workspaceDataDir: path.join(cwd, ".pagecast"),
    isolated: false
  });
  assert.deepEqual(
    resolvePagecastHomePaths({ homeDir, cwd, explicitDataDir: "./isolated" }),
    {
      dataDir: path.join(cwd, "isolated"),
      workspaceDataDir: path.join(cwd, "isolated"),
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

  await fs.rm(root, { recursive: true, force: true });
});
