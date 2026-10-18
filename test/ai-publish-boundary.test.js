import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfigStore, createReportStore, publishReportSnapshot } from "../src/server.js";
import { WorkspaceLease } from "../src/state-coordinator.js";
import { createPagecastTools } from "../src/ai/index.js";

const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function mockSpawn(calls, output) {
  return (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(output));
      child.exitCode = 0; child.emit("exit", 0, null);
    });
    return child;
  };
}
async function fixture(t, { configured = true, adopted = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-ai-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "home");
  const file = path.join(root, "report.html");
  await fs.writeFile(file, "<h1>Synthetic fixture</h1>");
  let config;
  if (configured) {
    config = createConfigStore({ dataDir }); await config.init();
    await config.updatePages({ accountId, projectName: "ai-fixture", adoptExisting: adopted });
  }
  return { root, dataDir, file, config };
}
function withoutToken(t) {
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  t.after(() => { if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = saved; });
}

for (const configured of [false, true]) test(`restricted publisher refuses ${configured ? "unadopted" : "missing"} target before auth, daemon routing or report state changes`, async (t) => {
  const { dataDir, file } = await fixture(t, { configured, adopted: false });
  const configBefore = configured ? await fs.readFile(path.join(dataDir, "config.json"), "utf8") : null;
  let effects = 0;
  const unexpected = () => { effects++; throw new Error("unexpected side effect"); };
  await assert.rejects(publishReportSnapshot({ dataDir, path: file, configuredTargetOnly: true,
    commandFetchImpl: unexpected, cloudflareAuthSpawnImpl: unexpected, pagesDeploySpawnImpl: unexpected }), /already configured and adopted/);
  assert.equal(effects, 0);
  await assert.rejects(fs.access(path.join(dataDir, "reports.json")), { code: "ENOENT" });
  if (configured) assert.equal(await fs.readFile(path.join(dataDir, "config.json"), "utf8"), configBefore);
  else await assert.rejects(fs.access(path.join(dataDir, "config.json")), { code: "ENOENT" });
});

test("restricted publisher never starts login when the configured account is signed out", async (t) => {
  withoutToken(t);
  const { dataDir, file } = await fixture(t);
  const calls = [];
  await assert.rejects(publishReportSnapshot({ dataDir, path: file, configuredTargetOnly: true,
    cloudflareAuthSpawnImpl: mockSpawn(calls, '{"accounts":[]}'), pagesDeploySpawnImpl: () => assert.fail("deploy must not run") }), /Not signed in/);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((args) => args.includes("whoami")));
});

test("restricted publisher deploys to the adopted target without project discovery or creation", async (t) => {
  withoutToken(t);
  const { dataDir, file } = await fixture(t);
  const auth = [], deploy = [];
  const result = await publishReportSnapshot({ dataDir, path: file, configuredTargetOnly: true,
    cloudflareAuthSpawnImpl: mockSpawn(auth, JSON.stringify({ accounts: [{ id: accountId, name: "Synthetic" }] })),
    pagesDeploySpawnImpl: mockSpawn(deploy, "https://ai-fixture.pages.dev") });
  assert.equal(result.projectName, "ai-fixture");
  assert.equal(deploy.length, 1);
  assert.ok(auth.every((args) => args.includes("whoami")));
  assert.ok(deploy.every((args) => args.includes("deploy") && args.includes("ai-fixture")));
});

test("restricted publisher cannot update a publication on a different target", async (t) => {
  withoutToken(t);
  const { dataDir, file } = await fixture(t);
  const store = createReportStore({ dataDir }); await store.init();
  const report = await store.addPath(file);
  const draft = store.draftPublication(report.id, { kind: "snapshot" });
  draft.publication.projectRef = { accountId, projectName: "other-fixture", baseUrl: "https://other-fixture.pages.dev" };
  draft.publication.publicUrl = `https://other-fixture.pages.dev/p/${draft.publication.token}`;
  await store.commitPublication(report.id, draft.publication);
  const before = await fs.readFile(path.join(dataDir, "reports.json"), "utf8");
  await assert.rejects(publishReportSnapshot({ dataDir, path: file, mode: "update", update: draft.publication.token, configuredTargetOnly: true,
    cloudflareAuthSpawnImpl: mockSpawn([], JSON.stringify({ accounts: [{ id: accountId }] })),
    pagesDeploySpawnImpl: () => assert.fail("deploy must not run") }), /different Pages target/);
  assert.equal(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"), before);
});

test("restricted publishing fails closed on a live writer lease without daemon fallback", async (t) => {
  const { dataDir, file } = await fixture(t);
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: "synthetic-existing-writer-capability" });
  try {
    await assert.rejects(publishReportSnapshot({ dataDir, path: file, configuredTargetOnly: true,
      commandFetchImpl: () => assert.fail("daemon routing must not run") }), /already in use/i);
  } finally { await lease.release(); }
});

test("default AI engine uses the restricted publisher rather than the interactive legacy route", async (t) => {
  const { dataDir } = await fixture(t, { configured: false });
  const core = createPagecastTools({ dataDir, allowMutations: true, authorize: async () => true });
  const result = await core.execute("pagecast_publish_content", { content: "# Synthetic", filename: "report.md" });
  assert.equal(result.error.code, "operation_failed");
  await assert.rejects(fs.access(path.join(dataDir, "config.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(dataDir, "reports.json")), { code: "ENOENT" });
});
