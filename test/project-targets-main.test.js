import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCloudflarePagesPublisher } from "../src/server.js";
import { WorkspaceLease } from "../src/state-coordinator.js";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function makeReport(root, name, html) {
  const reportRoot = path.join(root, name);
  await fs.mkdir(reportRoot, { recursive: true });
  await fs.writeFile(path.join(reportRoot, "index.html"), html);
  return {
    id: name,
    name,
    kind: "path",
    rootDir: reportRoot,
    entryFile: "index.html",
    publications: []
  };
}

function captureDeploys() {
  const captures = [];
  let failNext = false;
  function spawnImpl(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    setImmediate(async () => {
      const projectIndex = args.indexOf("--project-name");
      const projectName = projectIndex >= 0 ? args[projectIndex + 1] : "unknown";
      const pRoot = path.join(options.cwd, "p");
      const slugs = await fs.readdir(pRoot).catch(() => []);
      const htmlBySlug = {};
      for (const slug of slugs) {
        htmlBySlug[slug] = await fs
          .readFile(path.join(pRoot, slug, "index.html"), "utf8")
          .catch(() => "");
      }
      captures.push({
        accountId: options.env.CLOUDFLARE_ACCOUNT_ID || "",
        projectName,
        cwd: options.cwd,
        slugs: slugs.sort(),
        htmlBySlug
      });
      if (failNext) {
        failNext = false;
        child.stderr.emit("data", Buffer.from("simulated deploy failure"));
        child.exitCode = 1;
        child.emit("exit", 1, null);
      } else {
        child.stdout.emit("data", Buffer.from(`https://${projectName}.pages.dev`));
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }
    });
    return child;
  }
  return {
    captures,
    spawnImpl,
    failNext() {
      failNext = true;
    }
  };
}

test("managed publication deployments are isolated by account and project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-target-isolation-"));
  const fake = captureDeploys();
  const publisher = createCloudflarePagesPublisher({
    dataDir: path.join(root, "data"),
    spawnImpl: fake.spawnImpl
  });
  const targetA = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "project-a", baseUrl: "https://project-a.pages.dev", adoptExisting: true };
  const targetB = { accountId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", projectName: "project-b", baseUrl: "https://project-b.pages.dev", adoptExisting: true };
  const reportA = await makeReport(root, "report-a", "<h1>only-a</h1>");
  const reportB = await makeReport(root, "report-b", "<h1>only-b</h1>");

  try {
    await publisher.publish({
      report: reportA,
      publication: { token: "alpha", slug: "alpha" },
      pagesConfig: targetA
    });
    await publisher.publish({
      report: reportB,
      publication: { token: "bravo", slug: "bravo" },
      pagesConfig: targetB
    });

    assert.deepEqual(fake.captures[0].slugs, ["alpha"]);
    assert.deepEqual(fake.captures[1].slugs, ["bravo"]);
    assert.notEqual(fake.captures[0].cwd, fake.captures[1].cwd);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed sync and revoke preserve the previously committed local snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-target-rollback-"));
  const fake = captureDeploys();
  const dataDir = path.join(root, "data");
  const publisher = createCloudflarePagesPublisher({ dataDir, spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "project-a", baseUrl: "https://project-a.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "report", "<h1>last-good</h1>");
  const publication = { token: "alpha", slug: "alpha" };

  try {
    await publisher.publish({ report, publication, pagesConfig });
    const committed = publisher.publicationDir("alpha", pagesConfig);
    assert.match(await fs.readFile(path.join(committed, "index.html"), "utf8"), /last-good/);

    await fs.writeFile(path.join(report.rootDir, "index.html"), "<h1>failed-update</h1>");
    fake.failNext();
    await assert.rejects(
      () => publisher.syncPublication({ report, publication, pagesConfig }),
      /deploy failed/i
    );
    assert.match(await fs.readFile(path.join(committed, "index.html"), "utf8"), /last-good/);

    fake.failNext();
    await assert.rejects(() => publisher.revoke(["alpha"], pagesConfig), /deploy failed/i);
    assert.equal(await exists(path.join(committed, "index.html")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace sources are rejected without changing saved publications", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-workspace-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = captureDeploys();
  const dataDir = path.join(root, "data");
  const publisher = createCloudflarePagesPublisher({ dataDir, spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "source-guard", baseUrl: "https://source-guard.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "report", "<h1>last-good</h1>");
  const publication = { token: "alpha", slug: "alpha" };
  await publisher.publish({ report, publication, pagesConfig });
  const committed = publisher.publicationDir("alpha", pagesConfig);
  const before = await fs.readFile(path.join(committed, "index.html"));
  await fs.mkdir(path.join(report.rootDir, "node_modules"));
  await fs.writeFile(path.join(report.rootDir, "node_modules", "dependency.js"), "unrelated");
  await assert.rejects(publisher.syncPublication({ report, publication, pagesConfig }), /static.*output|workspace/i);
  assert.deepEqual(await fs.readFile(path.join(committed, "index.html")), before);
  assert.equal(fake.captures.length, 1, "rejected workspaces must not reach the deploy subprocess");
});

test("oversized source files are rejected before copying their bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-source-budget-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = captureDeploys();
  const publisher = createCloudflarePagesPublisher({ dataDir: path.join(root, "data"), spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "source-budget", baseUrl: "https://source-budget.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "report", "<h1>bounded</h1>");
  const oversized = path.join(report.rootDir, "large.bin");
  const handle = await fs.open(oversized, "w");
  await handle.truncate(512 * 1024 * 1024 + 1);
  await handle.close();
  const copyFile = fs.copyFile.bind(fs);
  t.mock.method(fs, "copyFile", async (source, ...args) => {
    assert.notEqual(source, oversized, "oversized files must not reach copyFile");
    return copyFile(source, ...args);
  });
  await assert.rejects(publisher.publish({ report, publication: { token: "alpha", slug: "alpha" }, pagesConfig }), /512 MiB|source.*limit/i);
  assert.equal(fake.captures.length, 0);
});

test("leased staging recovery preserves active operations and canonical publication copies", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-staging-recovery-"));
  const dataDir = path.join(root, "data");
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: "test-staging-recovery" });
  t.after(async () => {
    await lease.release();
    await fs.rm(root, { recursive: true, force: true });
  });
  const fake = captureDeploys();
  const publisher = createCloudflarePagesPublisher({ dataDir, spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "staging-recovery", baseUrl: "https://staging-recovery.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "report", "<h1>keep-saved</h1>");
  await publisher.publish({ report, publication: { token: "alpha", slug: "alpha" }, pagesConfig });
  const committed = publisher.publicationDir("alpha", pagesConfig);
  const targetRoot = path.dirname(path.dirname(path.dirname(committed)));
  const deployed = path.join(targetRoot, "last-deployed", "p", "alpha", "index.html");
  const saved = await fs.readFile(path.join(committed, "index.html"));
  const savedDeployed = await fs.readFile(deployed);
  const operationRoot = path.join(dataDir, "targets", ".operations", path.basename(targetRoot));
  const abandoned = path.join(operationRoot, "deploy-abandoned");
  const active = path.join(operationRoot, "deploy-active");
  const fresh = path.join(operationRoot, "deploy-fresh");
  for (const p of [abandoned, active, fresh]) {
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(path.join(p, "payload"), "temporary");
  }
  await fs.writeFile(path.join(active, ".operation-owner.json"), JSON.stringify({ pid: process.pid, leaseId: lease.leaseId, cleanupPending: false }));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(abandoned, old, old);
  await fs.utimes(active, old, old);
  await publisher.recoverAbandonedStaging();
  assert.equal(await exists(abandoned), false);
  assert.equal(await exists(active), true);
  assert.equal(await exists(fresh), true);
  assert.deepEqual(await fs.readFile(path.join(committed, "index.html")), saved);
  assert.deepEqual(await fs.readFile(deployed), savedDeployed);
  for (const invalidOwner of [null, false, { pid: process.pid, leaseId: lease.leaseId, cleanupPending: "false" }]) {
    await fs.writeFile(path.join(active, ".operation-owner.json"), JSON.stringify(invalidOwner));
    await fs.utimes(active, old, old);
    await assert.rejects(publisher.recoverAbandonedStaging(), /invalid staging owner/i);
    assert.equal(await exists(active), true, "corrupt owner metadata must never authorize deletion");
  }
});

test("static assets and previously saved publication assets survive subsequent publishes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-static-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = captureDeploys();
  const dataDir = path.join(root, "data");
  const publisher = createCloudflarePagesPublisher({ dataDir, spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "static-assets", baseUrl: "https://static-assets.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "report", '<link rel="stylesheet" href="assets/style.css"><h1>assets</h1>');
  await fs.mkdir(path.join(report.rootDir, "assets"));
  await fs.writeFile(path.join(report.rootDir, "assets", "style.css"), "body { color: green; }");
  const binary = Buffer.alloc(129 * 1024, 7);
  await fs.writeFile(path.join(report.rootDir, "assets", "data.bin"), binary);
  await publisher.publish({ report, publication: { token: "alpha", slug: "alpha" }, pagesConfig });
  const committed = publisher.publicationDir("alpha", pagesConfig);
  assert.deepEqual(await fs.readFile(path.join(committed, "assets", "data.bin")), binary);
  assert.equal(await fs.readFile(path.join(committed, "assets", "style.css"), "utf8"), "body { color: green; }");
  // Existing saved assets are copied intact even if older versions included development files.
  await fs.mkdir(path.join(committed, "node_modules"));
  await fs.writeFile(path.join(committed, "node_modules", "legacy.js"), "saved legacy asset");
  const other = await makeReport(root, "other", "<h1>other</h1>");
  await publisher.publish({ report: other, publication: { token: "bravo", slug: "bravo" }, pagesConfig });
  assert.equal(await fs.readFile(path.join(publisher.publicationDir("alpha", pagesConfig), "node_modules", "legacy.js"), "utf8"), "saved legacy asset");
});

test("failed direct site copies and deployments retain the last deployed local copy", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-direct-preservation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = captureDeploys();
  const publisher = createCloudflarePagesPublisher({ dataDir: path.join(root, "data"), spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "direct-preservation", baseUrl: "https://direct-preservation.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "site", "<h1>last-good-direct</h1>");
  const before = await publisher.deploySite({ sourceDir: report.rootDir, pagesConfig });
  const saved = await fs.readFile(path.join(before.stagingRoot, "index.html"));
  await fs.writeFile(path.join(report.rootDir, "index.html"), "<h1>failed-direct-update</h1>");
  const open = fs.open.bind(fs);
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    if (file === path.join(report.rootDir, "index.html")) throw new Error("injected source copy failure");
    return open(file, ...args);
  });
  await assert.rejects(publisher.deploySite({ sourceDir: report.rootDir, pagesConfig }), /injected source copy failure/);
  assert.deepEqual(await fs.readFile(path.join(before.stagingRoot, "index.html")), saved);
  mock.mock.restore();
  fake.failNext();
  await assert.rejects(publisher.deploySite({ sourceDir: report.rootDir, pagesConfig }), /deploy failed/i);
  assert.deepEqual(await fs.readFile(path.join(before.stagingRoot, "index.html")), saved);
});

test("cleanup failures remain visible and block new staging until removal succeeds", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-cleanup-backpressure-"));
  const dataDir = path.join(root, "data");
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: "test-cleanup-backpressure" });
  t.after(async () => {
    await lease.release();
    await fs.rm(root, { recursive: true, force: true });
  });
  const fake = captureDeploys();
  const publisher = createCloudflarePagesPublisher({ dataDir, spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "cleanup-backpressure", baseUrl: "https://cleanup-backpressure.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "report", "<h1>committed-before-cleanup</h1>");
  const operations = path.join(dataDir, "targets", ".operations");
  const rm = fs.rm.bind(fs);
  const removal = t.mock.method(fs, "rm", async (file, options) => {
    if (String(file).startsWith(operations) && /^deploy-/.test(path.basename(String(file)))) {
      throw new Error("injected staging cleanup failure");
    }
    return rm(file, options);
  });
  const warnings = t.mock.method(console, "warn", () => {});
  await publisher.publish({ report, publication: { token: "alpha", slug: "alpha" }, pagesConfig });
  const committed = publisher.publicationDir("alpha", pagesConfig);
  const saved = await fs.readFile(path.join(committed, "index.html"));
  assert.ok(warnings.mock.callCount() > 0, "cleanup failure must be visible after a successful publication");
  const group = path.join(operations, (await fs.readdir(operations))[0]);
  const pending = (await fs.readdir(group)).sort();
  await assert.rejects(publisher.publish({ report, publication: { token: "bravo", slug: "bravo" }, pagesConfig }), /previous staging.*cleaned/i);
  assert.deepEqual((await fs.readdir(group)).sort(), pending, "a cleanup failure must not create another staging tree");
  const restarted = createCloudflarePagesPublisher({ dataDir, spawnImpl: fake.spawnImpl });
  await assert.rejects(restarted.recoverAbandonedStaging(), /injected staging cleanup failure/);
  assert.deepEqual(await fs.readFile(path.join(committed, "index.html")), saved);
  removal.mock.restore();
  await restarted.recoverAbandonedStaging();
  assert.deepEqual(await fs.readdir(group), []);
  assert.deepEqual(await fs.readFile(path.join(committed, "index.html")), saved);
});

test("source file-count limits are checked before any source file is opened for copying", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-source-file-count-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = captureDeploys();
  const publisher = createCloudflarePagesPublisher({ dataDir: path.join(root, "data"), spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "file-count", baseUrl: "https://file-count.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "report", "<h1>too many files</h1>");
  const assets = path.join(report.rootDir, "assets");
  await fs.mkdir(assets);
  for (let start = 0; start < 10000; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, offset) => fs.writeFile(path.join(assets, `${start + offset}.txt`), "")));
  }
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (file, ...args) => {
    assert.equal(String(file).startsWith(report.rootDir), false, "file limits must be checked before opening a source to copy");
    return open(file, ...args);
  });
  await assert.rejects(publisher.publish({ report, publication: { token: "alpha", slug: "alpha" }, pagesConfig }), /10,000-file limit/);
  assert.equal(fake.captures.length, 0);
});

test("source byte limits also stop files that grow after preflight", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-growing-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = captureDeploys();
  const publisher = createCloudflarePagesPublisher({ dataDir: path.join(root, "data"), spawnImpl: fake.spawnImpl });
  const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "growing-source", baseUrl: "https://growing-source.pages.dev", adoptExisting: true };
  const report = await makeReport(root, "report", "<h1>growing source</h1>");
  const growing = path.join(report.rootDir, "growing.bin");
  await fs.writeFile(growing, "x");
  const open = fs.open.bind(fs);
  let reads = 0;
  let written = 0;
  t.mock.method(fs, "open", async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (file === growing) {
      t.mock.method(handle, "read", async (buffer) => ({ bytesRead: ++reads <= 8193 ? buffer.length : 0, buffer }));
    } else if (path.basename(String(file)) === "growing.bin" && flags === "w") {
      t.mock.method(handle, "write", async (buffer, offset, length) => {
        written += length;
        return { bytesWritten: length, buffer };
      });
    }
    return handle;
  });
  await assert.rejects(publisher.publish({ report, publication: { token: "alpha", slug: "alpha" }, pagesConfig }), /512 MiB/);
  assert.ok(written <= 512 * 1024 * 1024, "late growth must never be written beyond the source budget");
  assert.equal(fake.captures.length, 0);
});

for (const entryFile of ["report.html", "notes.md"]) {
  test(`snapshot rendering uses the bounded ${entryFile} after source growth`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-snapshot-entry-growth-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const fake = captureDeploys();
    const publisher = createCloudflarePagesPublisher({ dataDir: path.join(root, "data"), spawnImpl: fake.spawnImpl });
    const report = await makeReport(root, "report", "unused");
    await fs.rename(path.join(report.rootDir, "index.html"), path.join(report.rootDir, entryFile));
    report.entryFile = entryFile;
    const source = path.join(report.rootDir, entryFile);
    await fs.writeFile(source, entryFile.endsWith(".md") ? "# Bounded entry" : "<h1>Bounded entry</h1>");
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === source) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          await close();
          await fs.truncate(source, 512 * 1024 * 1024 + 1);
        });
      }
      return handle;
    });
    const readFile = fs.readFile.bind(fs);
    t.mock.method(fs, "readFile", async (file, ...args) => {
      if (file === source) throw new Error("Entry reread bypassed the source budget");
      return readFile(file, ...args);
    });
    const pagesConfig = { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "entry-growth", baseUrl: "https://entry-growth.pages.dev", adoptExisting: true };
    await publisher.publish({ report, publication: { token: "alpha", slug: "alpha" }, pagesConfig });
    assert.equal((await fs.stat(source)).size, 512 * 1024 * 1024 + 1);
    const saved = await fs.readFile(path.join(publisher.publicationDir("alpha", pagesConfig), "index.html"), "utf8");
    assert.match(saved, /<h1>Bounded entry<\/h1>/);
    assert.equal(fake.captures.length, 1);
  });
}

test("staging recovery refuses unleased callers and symbolic operations roots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-recovery-boundary-"));
  const dataDir = path.join(root, "data");
  const publisher = createCloudflarePagesPublisher({ dataDir });
  await assert.rejects(publisher.recoverAbandonedStaging(), /workspace lease/);
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: "test-recovery-boundary" });
  t.after(async () => {
    await lease.release();
    await fs.rm(root, { recursive: true, force: true });
  });
  const saved = path.join(dataDir, "targets", "saved", "last-deployed", "p", "deploy-saved");
  await fs.mkdir(saved, { recursive: true });
  await fs.writeFile(path.join(saved, "index.html"), "keep deployed");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(saved, old, old);
  try {
    await fs.symlink(path.join(dataDir, "targets", "saved", "last-deployed"), path.join(dataDir, "targets", ".operations"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.diagnostic("Symbolic-root scenario unavailable on this platform; lease rejection was verified.");
      return;
    }
    throw error;
  }
  await assert.rejects(publisher.recoverAbandonedStaging(), /real operations directory/);
  assert.equal(await fs.readFile(path.join(saved, "index.html"), "utf8"), "keep deployed");
});
