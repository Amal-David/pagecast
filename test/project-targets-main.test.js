import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCloudflarePagesPublisher } from "../src/server.js";

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
