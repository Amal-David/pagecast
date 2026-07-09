import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createCloudflarePagesPublisher,
  createConfigStore,
  createReportStore,
  parseDuration,
  resolveExpiresAt
} from "../src/server.js";
import { makePasswordHash, renderAuthMiddleware, renderRoutesJson } from "../src/crypto.js";

// --- parseDuration / resolveExpiresAt ---------------------------------------

test("parseDuration handles units, never, and rejects malformed input", () => {
  assert.equal(parseDuration("12h"), 12 * 3_600_000);
  assert.equal(parseDuration("7d"), 7 * 86_400_000);
  assert.equal(parseDuration("30d"), 30 * 86_400_000);
  assert.equal(parseDuration("90m"), 90 * 60_000);
  assert.equal(parseDuration("never"), null);
  assert.equal(parseDuration("permanent"), null);
  assert.equal(parseDuration(""), null);
  for (const bad of ["abc", "7", "7x", "-1d", "0d", "d"]) {
    assert.throws(() => parseDuration(bad), /Invalid duration/, `should reject "${bad}"`);
  }
});

test("resolveExpiresAt uses the explicit value, else the default, else never", () => {
  const near = (a, b) => Math.abs(a - b) < 5000;
  assert.ok(near(resolveExpiresAt({ expires: "1d" }), Date.now() + 86_400_000));
  assert.ok(near(resolveExpiresAt({ defaultExpiry: "30d" }), Date.now() + 30 * 86_400_000));
  assert.equal(resolveExpiresAt({ expires: "never", defaultExpiry: "30d" }), null);
  assert.equal(resolveExpiresAt({ defaultExpiry: "never" }), null);
  assert.equal(resolveExpiresAt({}), null);
});

// --- generated middleware: expiry enforcement -------------------------------

async function loadMiddleware(manifest, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-exp-"));
  const file = path.join(dir, "_middleware.mjs");
  await fs.writeFile(file, renderAuthMiddleware(manifest, options), "utf8");
  return import(pathToFileURL(file).href);
}
const ctx = (slug, headers = {}) => ({
  request: new Request(`https://x.pages.dev/p/${slug}/index.html`, { headers }),
  next: async () => new Response("OK", { status: 200 })
});
const basic = (pw) => "Basic " + Buffer.from(`u:${pw}`).toString("base64");

test("expiry-only slug: 410 once past expiresAt, 200 before", async () => {
  const past = await loadMiddleware([{ slug: "demo", expiresAt: Date.now() - 1000 }], { cookieSecret: "00".repeat(32) });
  assert.equal((await past.onRequest(ctx("demo"))).status, 410);

  const future = await loadMiddleware([{ slug: "demo", expiresAt: Date.now() + 3_600_000 }], { cookieSecret: "00".repeat(32) });
  let served = false;
  const res = await future.onRequest({ ...ctx("demo"), next: async () => { served = true; return new Response("OK", { status: 200 }); } });
  assert.equal(served, true);
  assert.equal(res.status, 200);
});

test("expiry beats auth: an expired protected link is 410 even with the right password", async () => {
  const entry = { slug: "demo", expiresAt: Date.now() - 1000, ...makePasswordHash("secret") };
  const { onRequest } = await loadMiddleware([entry], { cookieSecret: "00".repeat(32) });
  const res = await onRequest(ctx("demo", { Authorization: basic("secret") }));
  assert.equal(res.status, 410, "expired link must not be unlockable with the password");
});

test("not-yet-expired protected link still prompts for the password (401)", async () => {
  const entry = { slug: "demo", expiresAt: Date.now() + 3_600_000, ...makePasswordHash("secret") };
  const { onRequest } = await loadMiddleware([entry], { cookieSecret: "00".repeat(32) });
  assert.equal((await onRequest(ctx("demo"))).status, 401);
  assert.equal((await onRequest(ctx("demo", { Authorization: basic("secret") }))).status, 200);
});

test("renderAuthMiddleware bakes expiring-only slugs; renderRoutesJson scopes them", () => {
  const mw = renderAuthMiddleware([{ slug: "exp1", expiresAt: 1893456000000 }], { cookieSecret: "00".repeat(32) });
  assert.match(mw, /"exp1":\{"expiresAt":1893456000000\}/);
  assert.deepEqual(JSON.parse(renderRoutesJson(["exp1"])).include, ["/p/exp1/*"]);
});

// --- store: formatPublication + manifest ------------------------------------

async function storeWithReport() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-exp-store-"));
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "index.html"), "<h1>R</h1>");
  const store = createReportStore({ dataDir: path.join(tempDir, "data") });
  await store.init();
  const report = await store.addPath(path.join(reportDir, "index.html"));
  return { store, reportId: report.id };
}

test("formatPublication exposes expiresAt/expired and flips active when expired", async () => {
  const { store, reportId } = await storeWithReport();
  const draft = store.draftPublication(reportId, { kind: "snapshot", expiresAt: Date.now() - 1000 });
  await store.commitPublication(reportId, draft.publication);
  const fmt = store.formatPublication(draft.publication, {});
  assert.equal(fmt.expired, true);
  assert.equal(fmt.active, false);
  assert.ok(typeof fmt.expiresAt === "number");
});

test("manifest includes an expiring-only (unprotected) slug", async () => {
  const { store, reportId } = await storeWithReport();
  const draft = store.draftPublication(reportId, { kind: "snapshot", expiresAt: Date.now() + 3_600_000 });
  await store.commitPublication(reportId, draft.publication);
  const manifest = store.protectedPublicationManifest();
  const entry = manifest.find((m) => m.slug === draft.publication.slug);
  assert.ok(entry, "expiring slug should be in the edge manifest");
  assert.equal(entry.expiresAt, draft.publication.expiresAt);
  assert.equal(entry.hash, undefined, "no password → no hash, expiry only");
});

// --- integration: a published expiring report bakes expiresAt into the gate -

function fakeDeploySpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("exit", null, "SIGTERM");
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from("https://abcdef123456.pagecast.pages.dev/"));
    child.emit("exit", 0, null);
  });
  return child;
}

test("publishing an expiring report writes a middleware that gates the slug by expiry", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-exp-pub-"));
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "index.html"), "<h1>Soon gone</h1>");

  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    adoptExisting: true
  });
  const store = createReportStore({ dataDir });
  await store.init();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploySpawn,
    timeoutMs: 5000,
    getProtectedPublications: () => store.protectedPublicationManifest(),
    getAuthCookieSecret: () => configStore.get().authCookieSecret,
    getOwnerId: () => configStore.getOwnerId(),
    isTargetManaged: (projectRef) => configStore.isTargetManaged(projectRef),
    claimTargetManaged: (projectRef) => configStore.claimManagedTarget(projectRef)
  });

  const report = await store.addPath(path.join(reportDir, "index.html"));
  const expiresAt = Date.now() + 3_600_000;
  const draft = store.draftPublication(report.id, { kind: "snapshot", expiresAt });
  Object.assign(draft.publication, {
    pagesProjectName: configStore.get().pages.projectName,
    pagesAccountId: configStore.get().pages.accountId,
    pagesBaseUrl: configStore.get().pages.baseUrl,
    projectRef: configStore.get().pages
  });
  // Commit before deploying so the edge manifest (built from committed snapshots)
  // includes this expiring slug when the middleware is generated.
  await store.commitPublication(report.id, draft.publication);
  draft.publication.publicUrl = await publisher.syncPublication({
    report: draft.report,
    publication: draft.publication,
    pagesConfig: configStore.get().pages
  });

  const slug = draft.publication.slug;
  const middleware = await fs.readFile(path.join(publisher.siteRoot, "functions", "_middleware.js"), "utf8");
  assert.ok(middleware.includes(`"${slug}":{"expiresAt":${expiresAt}}`), "gate carries the slug's expiry");
  const routes = JSON.parse(await fs.readFile(path.join(publisher.siteRoot, "_routes.json"), "utf8"));
  assert.deepEqual(routes.include, [`/p/${slug}/*`]);
});
