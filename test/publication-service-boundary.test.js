import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as packageBoundary from "../src/index.js";
import { createPublicationService } from "../src/publication-service.js";
import * as serverBoundary from "../src/server.js";

test("the historical publisher factory remains the package compatibility identity", async (t) => {
  assert.equal(
    packageBoundary.createCloudflarePagesPublisher,
    serverBoundary.createCloudflarePagesPublisher
  );
  assert.equal(serverBoundary.createCloudflarePagesPublisher.name, "createCloudflarePagesPublisher");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-publication-boundary-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const publisher = serverBoundary.createCloudflarePagesPublisher({ dataDir });
  assert.equal(typeof publisher.publish, "function");
  assert.equal(typeof publisher.deploySite, "function");
  assert.equal(typeof publisher.discoverPublishedPages, "function");
});

test("historical nested publisher defaults use legacy roots before a ProjectRef exists", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-publication-defaults-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const publisher = serverBoundary.createCloudflarePagesPublisher({ dataDir });
  const legacyPublicationRoot = path.join(dataDir, "pages-site", "p", "legacy-page");
  const legacyDirectRoot = path.join(dataDir, "pages-deploy", "legacy-project");

  assert.equal(publisher.publicationDir("legacy-page"), legacyPublicationRoot);
  await fs.mkdir(legacyPublicationRoot, { recursive: true });
  await fs.writeFile(
    path.join(legacyPublicationRoot, "index.html"),
    "<!doctype html><title>Legacy publication</title>",
    "utf8"
  );
  await fs.mkdir(legacyDirectRoot, { recursive: true });
  await fs.writeFile(
    path.join(legacyDirectRoot, "index.html"),
    "<!doctype html><title>Legacy direct project</title>",
    "utf8"
  );

  const pagesConfig = {
    projectName: "legacy-project",
    baseUrl: "https://legacy-project.pages.dev"
  };
  const defaultManifest = await publisher.buildSyncManifest();
  assert.deepEqual(defaultManifest.publications.map((entry) => entry.slug), ["legacy-page"]);
  const manifest = await publisher.buildSyncManifest(pagesConfig);
  assert.deepEqual(manifest.publications.map((entry) => entry.slug), ["legacy-page"]);

  const discovery = await publisher.discoverPublishedPages({ pagesConfig });
  const bySlug = new Map(discovery.publications.map((entry) => [entry.slug, entry]));
  assert.equal(bySlug.get("legacy-page").sourceRoot, legacyPublicationRoot);
  assert.equal(bySlug.get("legacy-project-root").sourceRoot, legacyDirectRoot);
});

test("managed publication implementation is internal and acyclic", async () => {
  assert.equal(typeof createPublicationService, "function");
  assert.equal("createPublicationService" in packageBoundary, false);
  assert.equal("createPublicationService" in serverBoundary, false);

  const serviceSource = await fs.readFile(
    new URL("../src/publication-service.js", import.meta.url),
    "utf8"
  );
  const serverSource = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const packageSource = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");

  assert.doesNotMatch(serviceSource, /from\s+["']\.\/server\.js["']/);
  assert.match(serviceSource, /legacy v3 mutable root/);
  assert.doesNotMatch(serverSource, /legacy v3 mutable root/);
  assert.doesNotMatch(packageSource, /publication-service/);
});
