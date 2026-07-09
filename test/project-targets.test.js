import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCloudflarePagesPublisher, createReportStore } from "../src/server.js";
import { encodeProjectOwnershipMarker } from "../src/project-ref.js";

const TARGET_A = {
  accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  projectName: "alpha-reports"
};
const TARGET_B = {
  accountId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  projectName: "beta-reports"
};

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-targets-"));
}

function pagesConfig(target, extra = {}) {
  return {
    ...target,
    baseUrl: `https://${target.projectName}.pages.dev`,
    adoptExisting: true,
    ...extra
  };
}

function tokenFilesystemKey(token) {
  return `token-${createHash("sha256").update(String(token), "utf8").digest("hex")}`;
}

function publication(slug, target) {
  return {
    token: slug,
    slug,
    label: slug,
    kind: "snapshot",
    publicUrl: `https://${target.projectName}.pages.dev/p/${slug}/`,
    pagesProjectName: target.projectName,
    pagesAccountId: target.accountId,
    pagesBaseUrl: `https://${target.projectName}.pages.dev`,
    projectRef: { ...target },
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    revokedAt: null
  };
}

async function addReport(dataDir, rootDir, name, html) {
  await fs.mkdir(rootDir, { recursive: true });
  const reportPath = path.join(rootDir, `${name}.html`);
  await fs.writeFile(reportPath, html, "utf8");
  const store = createReportStore({ dataDir });
  await store.init();
  return { report: await store.addPath(reportPath), reportPath };
}

async function readTree(root) {
  const files = {};

  async function visit(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files[relativePath] = await fs.readFile(absolutePath, "utf8");
      }
    }
  }

  await visit(root);
  return files;
}

function makeDeployFake(outcomes = []) {
  const captures = [];
  let callIndex = 0;

  function fakeDeploy(command, args, options) {
    const index = callIndex++;
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
      try {
        const projectFlag = args.indexOf("--project-name");
        const projectName = projectFlag >= 0 ? args[projectFlag + 1] : "unknown";
        captures.push({
          command,
          args,
          cwd: options.cwd,
          accountId: options.env.CLOUDFLARE_ACCOUNT_ID || "",
          files: await readTree(options.cwd)
        });

        const outcome = outcomes[index];
        if (outcome === "fail") {
          child.stderr.emit("data", Buffer.from(`deploy ${index + 1} failed`));
          child.exitCode = 1;
          child.emit("exit", 1, null);
          return;
        }

        const baseUrl =
          typeof outcome === "string" && outcome.startsWith("https://")
            ? outcome
            : `https://${projectName}.pages.dev`;
        child.stdout.emit(
          "data",
          Buffer.from(`Cloudflare Pages deploy complete ${baseUrl}`)
        );
        child.exitCode = 0;
        child.emit("exit", 0, null);
      } catch (error) {
        child.stderr.emit("data", Buffer.from(String(error?.stack || error)));
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }
    });

    return child;
  }

  return { fakeDeploy, captures };
}

function captureText(capture) {
  return Object.entries(capture.files)
    .map(([file, contents]) => `${file}\n${contents}`)
    .join("\n");
}

async function proveCompositeTargetIsolation(firstTarget, secondTarget) {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const first = await addReport(
    dataDir,
    path.join(tempDir, "first-source"),
    "first",
    "<h1>FIRST_TARGET_ONLY</h1>"
  );
  const second = await addReport(
    dataDir,
    path.join(tempDir, "second-source"),
    "second",
    "<h1>SECOND_TARGET_ONLY</h1>"
  );
  const { fakeDeploy, captures } = makeDeployFake();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000,
    fetchImpl: async () => new Response("", { status: 404 })
  });

  try {
    await publisher.publish({
      report: first.report,
      publication: publication("first-target-only", firstTarget),
      pagesConfig: pagesConfig(firstTarget)
    });
    await publisher.publish({
      report: second.report,
      publication: publication("second-target-only", secondTarget),
      pagesConfig: pagesConfig(secondTarget)
    });
    await publisher.revoke([], pagesConfig(firstTarget));

    const firstDeploy = captures.at(-1);
    const secondDeploy = captures[1];
    assert.notEqual(firstDeploy.cwd, secondDeploy.cwd, "each canonical ProjectRef needs its own root");
    assert.equal(firstDeploy.accountId, firstTarget.accountId);
    assert.equal(secondDeploy.accountId, secondTarget.accountId);
    assert.match(captureText(firstDeploy), /FIRST_TARGET_ONLY/);
    assert.doesNotMatch(captureText(firstDeploy), /SECOND_TARGET_ONLY|second-target-only/);
    assert.match(captureText(secondDeploy), /SECOND_TARGET_ONLY/);
    assert.doesNotMatch(captureText(secondDeploy), /FIRST_TARGET_ONLY|first-target-only/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("ProjectRef isolates the same project name in two accounts", async () => {
  await proveCompositeTargetIsolation(
    { accountId: TARGET_A.accountId, projectName: "shared-project" },
    { accountId: TARGET_B.accountId, projectName: "shared-project" }
  );
});

test("ProjectRef isolates two project names in the same account", async () => {
  await proveCompositeTargetIsolation(
    { accountId: TARGET_A.accountId, projectName: "first-project" },
    { accountId: TARGET_A.accountId, projectName: "second-project" }
  );
});

test("deploy materialization isolates snapshots, redirects, and protection manifests by ProjectRef", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const alpha = await addReport(
    dataDir,
    path.join(tempDir, "alpha-source"),
    "alpha",
    "<h1>ALPHA_ONLY_CONTENT</h1>"
  );
  const beta = await addReport(
    dataDir,
    path.join(tempDir, "beta-source"),
    "beta",
    "<h1>BETA_ONLY_CONTENT</h1>"
  );
  const alphaPublication = publication("alpha-only", TARGET_A);
  const betaPublication = publication("beta-only", TARGET_B);
  const { fakeDeploy, captures } = makeDeployFake();

  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000,
    fetchImpl: async () => new Response("", { status: 404 }),
    getRedirects: () => [
      { from: "/p/old-alpha", to: "/p/alpha-only", projectRef: TARGET_A },
      { from: "/p/old-beta", to: "/p/beta-only", projectRef: TARGET_B }
    ],
    getProtectedPublications: () => [
      {
        slug: "alpha-only",
        salt: "aa",
        hash: "aa",
        iterations: 1,
        projectRef: TARGET_A
      },
      {
        slug: "beta-only",
        salt: "bb",
        hash: "bb",
        iterations: 1,
        projectRef: TARGET_B
      }
    ],
    getAuthCookieSecret: () => "target-isolation-cookie-secret",
    getSyncToken: () => "target-isolation-sync-token"
  });

  await publisher.publish({
    report: alpha.report,
    publication: alphaPublication,
    pagesConfig: pagesConfig(TARGET_A)
  });
  await publisher.publish({
    report: beta.report,
    publication: betaPublication,
    pagesConfig: pagesConfig(TARGET_B)
  });
  await publisher.syncPublication({
    report: alpha.report,
    publication: alphaPublication,
    pagesConfig: pagesConfig(TARGET_A)
  });

  assert.equal(captures.length, 3);
  const alphaDeploy = captures[2];
  const betaDeploy = captures[1];
  const alphaBytes = captureText(alphaDeploy);
  const betaBytes = captureText(betaDeploy);

  assert.equal(alphaDeploy.accountId, TARGET_A.accountId);
  assert.equal(betaDeploy.accountId, TARGET_B.accountId);
  assert.match(alphaBytes, /ALPHA_ONLY_CONTENT/);
  assert.doesNotMatch(alphaBytes, /BETA_ONLY_CONTENT|beta-only|old-beta/);
  assert.match(betaBytes, /BETA_ONLY_CONTENT/);
  assert.doesNotMatch(betaBytes, /ALPHA_ONLY_CONTENT|alpha-only|old-alpha/);

  const alphaOwnership = JSON.parse(alphaDeploy.files["__pagecast/ownership.json"]);
  const betaOwnership = JSON.parse(betaDeploy.files["__pagecast/ownership.json"]);
  assert.deepEqual(
    { accountId: alphaOwnership.accountId, projectName: alphaOwnership.projectName },
    TARGET_A
  );
  assert.deepEqual(
    { accountId: betaOwnership.accountId, projectName: betaOwnership.projectName },
    TARGET_B
  );
  const publisherOwner = JSON.parse(
    await fs.readFile(path.join(dataDir, "publisher-owner.json"), "utf8")
  );
  assert.notEqual(alphaOwnership.ownerId, betaOwnership.ownerId);
  assert.notEqual(alphaOwnership.ownerId, publisherOwner.ownerId);
  assert.notEqual(betaOwnership.ownerId, publisherOwner.ownerId);
  assert.equal(
    alphaOwnership.ownerId,
    createHmac("sha256", publisherOwner.markerSecret)
      .update(
        [
          "pagecast-project-owner-v2",
          "publications",
          TARGET_A.accountId,
          TARGET_A.projectName
        ].join("\0"),
        "utf8"
      )
      .digest("hex")
  );
  assert.notEqual(
    alphaOwnership.ownerId,
    createHmac("sha256", publisherOwner.ownerId)
      .update(
        [
          "pagecast-project-owner-v2",
          "publications",
          TARGET_A.accountId,
          TARGET_A.projectName
        ].join("\0"),
        "utf8"
      )
      .digest("hex")
  );
});

test("failed snapshot sync leaves the last-known-good committed materialization intact", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "sync",
    "<h1>LAST_GOOD_SYNC</h1>"
  );
  const link = publication("sync-rollback", TARGET_A);
  const { fakeDeploy, captures } = makeDeployFake(["ok", "fail", "ok"]);
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000,
    fetchImpl: async () => new Response("", { status: 404 })
  });

  await publisher.publish({
    report: source.report,
    publication: link,
    pagesConfig: pagesConfig(TARGET_A)
  });
  await fs.writeFile(source.reportPath, "<h1>FAILED_SYNC_CANDIDATE</h1>", "utf8");
  await assert.rejects(
    () =>
      publisher.syncPublication({
        report: source.report,
        publication: link,
        pagesConfig: pagesConfig(TARGET_A)
      }),
    /deploy 2 failed/
  );

  await publisher.revoke([], pagesConfig(TARGET_A));
  const rematerialized = captureText(captures[2]);
  assert.match(rematerialized, /LAST_GOOD_SYNC/);
  assert.doesNotMatch(rematerialized, /FAILED_SYNC_CANDIDATE/);
});

test("a failed canonical-origin correction preserves and reports the first successful deploy", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "canonical",
    "<h1>LAST_GOOD_CANONICAL</h1>"
  );
  const link = publication("canonical-rollback", TARGET_A);
  const { fakeDeploy, captures } = makeDeployFake([
    "https://alpha-reports.pages.dev",
    "https://abcdef12.assigned-collision.pages.dev",
    "fail"
  ]);
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000
  });
  const config = pagesConfig(TARGET_A);

  await publisher.publish({ report: source.report, publication: link, pagesConfig: config });
  await fs.writeFile(source.reportPath, "<h1>FIRST_CANONICAL_SUCCESS</h1>", "utf8");
  const publishedUrl = await publisher.publish({
    report: source.report,
    publication: link,
    pagesConfig: config
  });

  assert.equal(
    publishedUrl,
    "https://assigned-collision.pages.dev/p/canonical-rollback/"
  );

  assert.equal(captures.length, 3);
  assert.match(
    await fs.readFile(path.join(publisher.publicationDir(link.token, config), "index.html"), "utf8"),
    /FIRST_CANONICAL_SUCCESS/
  );
  const paths = publisher.targetPaths(config);
  assert.match(
    await fs.readFile(path.join(paths.lastDeployedRoot, "p", link.slug, "index.html"), "utf8"),
    /FIRST_CANONICAL_SUCCESS/
  );
  assert.deepEqual(
    await readTree(paths.lastDeployedRoot),
    captures[1].files,
    "local last-deployed must represent the first successful remote deploy"
  );
  assert.deepEqual(await fs.readdir(paths.operationsRoot), []);
});

test("a failed complete-generation switch restores snapshots and last-deployed together", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "generation",
    "<h1>GENERATION_ONE</h1>"
  );
  const link = publication("generation-swap", TARGET_A);
  const { fakeDeploy, captures } = makeDeployFake();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000
  });
  const config = pagesConfig(TARGET_A);

  try {
    await publisher.publish({ report: source.report, publication: link, pagesConfig: config });
    const paths = publisher.targetPaths(config);
    const before = await readTree(paths.targetRoot);
    await fs.writeFile(source.reportPath, "<h1>GENERATION_TWO</h1>", "utf8");

    const originalRename = fs.rename;
    let injected = false;
    fs.rename = async (from, to) => {
      if (
        !injected &&
        path.resolve(to) === path.resolve(paths.targetRoot) &&
        path.resolve(from).startsWith(`${path.resolve(paths.operationsRoot)}${path.sep}`)
      ) {
        injected = true;
        const error = new Error("simulated generation switch failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(from, to);
    };
    try {
      await assert.rejects(
        () =>
          publisher.syncPublication({
            report: source.report,
            publication: link,
            pagesConfig: config
          }),
        /simulated generation switch failure/
      );
    } finally {
      fs.rename = originalRename;
    }

    assert.equal(injected, true);
    assert.equal(captures.length, 2, "remote success reaches the generation switch");
    assert.deepEqual(await readTree(paths.targetRoot), before);
    assert.match(
      await fs.readFile(path.join(paths.snapshotsRoot, tokenFilesystemKey(link.token), "content", "index.html"), "utf8"),
      /GENERATION_ONE/
    );
    assert.match(
      await fs.readFile(path.join(paths.lastDeployedRoot, "p", link.slug, "index.html"), "utf8"),
      /GENERATION_ONE/
    );
    assert.deepEqual(await fs.readdir(paths.operationsRoot), []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("unsafe dot-segment publication tokens fail before deploy without mutating target state", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "token-safety",
    "<h1>SAFE_TOKEN_STATE</h1>"
  );
  const { fakeDeploy, captures } = makeDeployFake();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000
  });
  const config = pagesConfig(TARGET_A);
  await publisher.publish({
    report: source.report,
    publication: publication("safe-token", TARGET_A),
    pagesConfig: config
  });
  const before = await readTree(publisher.targetPaths(config).targetRoot);

  for (const token of [".", ".."]) {
    await assert.rejects(
      () =>
        publisher.publish({
          report: source.report,
          publication: { ...publication("unsafe-token", TARGET_A), token },
          pagesConfig: config
        }),
      /URL-safe identifier/
    );
  }

  assert.equal(captures.length, 1, "unsafe tokens must fail before invoking Wrangler");
  assert.deepEqual(await readTree(publisher.targetPaths(config).targetRoot), before);
});

test("failed revoke preserves the committed snapshot for retry", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "revoke",
    "<h1>KEEP_AFTER_FAILED_REVOKE</h1>"
  );
  const link = publication("revoke-rollback", TARGET_A);
  const { fakeDeploy, captures } = makeDeployFake(["ok", "fail", "ok"]);
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000,
    fetchImpl: async () => new Response("", { status: 404 })
  });

  await publisher.publish({
    report: source.report,
    publication: link,
    pagesConfig: pagesConfig(TARGET_A)
  });
  await assert.rejects(
    () => publisher.revoke([link.slug], pagesConfig(TARGET_A)),
    /deploy 2 failed/
  );

  await publisher.revoke([], pagesConfig(TARGET_A));
  const rematerialized = captureText(captures[2]);
  assert.match(rematerialized, /KEEP_AFTER_FAILED_REVOKE/);
  assert.ok(rematerialized.includes(`p/${link.slug}/index.html`));
});

test("successful revoke removes stale password and expiry routes from the deployed site", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "protected-revoke",
    "<h1>PROTECTED_REVOKE</h1>"
  );
  const link = publication("protected-revoke", TARGET_A);
  const { fakeDeploy, captures } = makeDeployFake();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000,
    getProtectedPublications: () => [
      { slug: link.slug, expiresAt: Date.now() + 60_000, projectRef: TARGET_A }
    ],
    getAuthCookieSecret: () => "revoke-cookie-secret"
  });

  await publisher.publish({
    report: source.report,
    publication: link,
    pagesConfig: pagesConfig(TARGET_A)
  });
  assert.ok(captures[0].files["functions/_middleware.js"]);

  await publisher.revoke([link.slug], pagesConfig(TARGET_A));
  assert.equal(captures[1].files["functions/_middleware.js"], undefined);
  assert.equal(captures[1].files["_routes.json"], undefined);
  assert.equal(captures[1].files[`p/${link.slug}/index.html`], undefined);
});

test("an unrelated existing project requires explicit adoption and emits an ownership marker", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "adoption",
    "<h1>Adoption</h1>"
  );
  const link = publication("adoption", TARGET_A);
  const { fakeDeploy, captures } = makeDeployFake();
  const events = [];
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: (...args) => {
      events.push("deploy");
      return fakeDeploy(...args);
    },
    timeoutMs: 1000,
    claimTargetManaged: async () => {
      events.push("claim");
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/__pagecast/ownership.json")) {
        return new Response("Not found", { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  await assert.rejects(
    () =>
      publisher.publish({
        report: source.report,
        publication: link,
        pagesConfig: pagesConfig(TARGET_A, { adoptExisting: false })
      }),
    /adopt|ownership|managed/i
  );
  assert.equal(captures.length, 0, "unowned projects must be rejected before Wrangler deploys");

  await publisher.publish({
    report: source.report,
    publication: link,
    pagesConfig: pagesConfig(TARGET_A, { adoptExisting: true })
  });
  assert.equal(captures.length, 1);
  assert.deepEqual(events, ["claim", "deploy"]);
  const marker = JSON.parse(captures[0].files["__pagecast/ownership.json"]);
  assert.equal(marker.accountId, TARGET_A.accountId);
  assert.equal(marker.projectName, TARGET_A.projectName);
});

test("a matching ownership marker is accepted without a new adoption", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "owned",
    "<h1>Already owned</h1>"
  );
  const ownerId = "workspace-owner-a";
  const targetConfig = pagesConfig(TARGET_A, { adoptExisting: false });
  const remoteMarker = encodeProjectOwnershipMarker({
    ownerId,
    mode: "publications",
    projectRef: targetConfig
  });
  const requestedUrls = [];
  const { fakeDeploy, captures } = makeDeployFake();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000,
    getOwnerId: () => ownerId,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return new Response(remoteMarker, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  try {
    await publisher.publish({
      report: source.report,
      publication: publication("already-owned", TARGET_A),
      pagesConfig: targetConfig
    });

    assert.equal(captures.length, 1);
    assert.deepEqual(requestedUrls, [
      `${targetConfig.baseUrl}/__pagecast/ownership.json`
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a target-derived ownership marker is reusable only for its target and is claimed before deploy", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const firstSource = await addReport(
    dataDir,
    path.join(tempDir, "first-source"),
    "derived-owner-first",
    "<h1>Derived owner first</h1>"
  );
  const ownerId = "workspace-owner-derived";
  const firstDeploy = makeDeployFake();
  const firstPublisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: firstDeploy.fakeDeploy,
    timeoutMs: 1000,
    getOwnerId: () => ownerId
  });
  const adoptedConfig = pagesConfig(TARGET_A, { adoptExisting: true });

  try {
    await firstPublisher.publish({
      report: firstSource.report,
      publication: publication("derived-owner-first", TARGET_A),
      pagesConfig: adoptedConfig
    });
    const remoteMarker = firstDeploy.captures[0].files["__pagecast/ownership.json"];
    assert.notEqual(JSON.parse(remoteMarker).ownerId, ownerId);

    const secondSource = await addReport(
      dataDir,
      path.join(tempDir, "second-source"),
      "derived-owner-second",
      "<h1>Derived owner second</h1>"
    );
    const events = [];
    const secondDeploy = makeDeployFake();
    const secondPublisher = createCloudflarePagesPublisher({
      dataDir,
      spawnImpl: (...args) => {
        events.push("deploy");
        return secondDeploy.fakeDeploy(...args);
      },
      timeoutMs: 1000,
      getOwnerId: () => ownerId,
      isTargetManaged: () => false,
      claimTargetManaged: async () => {
        events.push("claim");
      },
      fetchImpl: async () =>
        new Response(remoteMarker, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    });

    await secondPublisher.publish({
      report: secondSource.report,
      publication: publication("derived-owner-second", TARGET_A),
      pagesConfig: pagesConfig(TARGET_A, { adoptExisting: false })
    });
    assert.deepEqual(events, ["claim", "deploy"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ownership markers with the wrong owner, mode, or project are rejected", async (t) => {
  const cases = [
    {
      name: "owner",
      marker: { ownerId: "another-owner", mode: "publications", projectRef: TARGET_A }
    },
    {
      name: "mode",
      marker: { ownerId: "workspace-owner-a", mode: "direct", projectRef: TARGET_A }
    },
    {
      name: "project",
      marker: { ownerId: "workspace-owner-a", mode: "publications", projectRef: TARGET_B }
    }
  ];

  for (const mismatch of cases) {
    await t.test(`wrong ${mismatch.name}`, async () => {
      const tempDir = await makeTempDir();
      const dataDir = path.join(tempDir, "data");
      const source = await addReport(
        dataDir,
        path.join(tempDir, "source"),
        `wrong-${mismatch.name}`,
        `<h1>Wrong ${mismatch.name}</h1>`
      );
      const { fakeDeploy, captures } = makeDeployFake();
      const publisher = createCloudflarePagesPublisher({
        dataDir,
        spawnImpl: fakeDeploy,
        timeoutMs: 1000,
        getOwnerId: () => "workspace-owner-a",
        fetchImpl: async () =>
          new Response(encodeProjectOwnershipMarker(mismatch.marker), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
      });

      try {
        await assert.rejects(
          () =>
            publisher.publish({
              report: source.report,
              publication: publication(`wrong-${mismatch.name}`, TARGET_A),
              pagesConfig: pagesConfig(TARGET_A, { adoptExisting: false })
            }),
          /adopt|ownership|managed/i
        );
        assert.equal(captures.length, 0, "a mismatched marker must fail before Wrangler runs");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  }
});

test("unscoped redirect and auth records are excluded from every target", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "scoped",
    "<h1>Scoped records</h1>"
  );
  const { fakeDeploy, captures } = makeDeployFake();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000,
    getRedirects: () => [
      { from: "/p/scoped-old", to: "/p/scoped", projectRef: TARGET_A },
      { from: "/p/unscoped-old", to: "/p/unscoped" }
    ],
    getProtectedPublications: () => [
      {
        slug: "scoped",
        expiresAt: Date.now() + 60_000,
        projectRef: TARGET_A
      },
      { slug: "unscoped-protected", expiresAt: Date.now() + 60_000 }
    ],
    getAuthCookieSecret: () => "scoped-cookie-secret"
  });

  try {
    await publisher.publish({
      report: source.report,
      publication: publication("scoped", TARGET_A),
      pagesConfig: pagesConfig(TARGET_A)
    });

    const files = captures[0].files;
    assert.match(files._redirects, /scoped-old/);
    assert.doesNotMatch(files._redirects, /unscoped-old/);
    assert.match(files["functions/_middleware.js"], /scoped/);
    assert.doesNotMatch(files["functions/_middleware.js"], /unscoped-protected/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("legacy staging migrates only explicitly targeted publications and quarantines ambiguous URLs", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const legacyRoot = path.join(dataDir, "pages-site", "p");
  const explicitSlug = "explicit-target";
  const ambiguousSlug = "hostname-collision";
  await fs.mkdir(path.join(legacyRoot, explicitSlug), { recursive: true });
  await fs.mkdir(path.join(legacyRoot, ambiguousSlug), { recursive: true });
  await fs.writeFile(
    path.join(legacyRoot, explicitSlug, "index.html"),
    "<h1>EXPLICIT_LEGACY</h1>",
    "utf8"
  );
  await fs.writeFile(
    path.join(legacyRoot, ambiguousSlug, "index.html"),
    "<h1>AMBIGUOUS_LEGACY</h1>",
    "utf8"
  );

  const explicit = publication(explicitSlug, TARGET_A);
  delete explicit.projectRef;
  const ambiguous = {
    token: ambiguousSlug,
    slug: ambiguousSlug,
    kind: "snapshot",
    publicUrl: `https://assigned-collision.pages.dev/p/${ambiguousSlug}/`,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    revokedAt: null
  };
  const attributableRedirect = {
    from: "/p/explicit-old/",
    to: `/p/${explicitSlug}/`
  };
  const ambiguousRedirect = {
    from: "/p/ambiguous-old/",
    to: `/p/${ambiguousSlug}/`
  };
  const publisher = createCloudflarePagesPublisher({ dataDir });
  const beforeExplicit = await fs.readFile(
    path.join(legacyRoot, explicitSlug, "index.html"),
    "utf8"
  );
  const beforeAmbiguous = await fs.readFile(
    path.join(legacyRoot, ambiguousSlug, "index.html"),
    "utf8"
  );

  const first = await publisher.migrateLegacyStaging({
    publications: [explicit, ambiguous],
    redirects: [attributableRedirect, ambiguousRedirect],
    currentPagesConfig: pagesConfig(TARGET_B)
  });
  const migrated = (first.migrated || []).map((entry) => entry.slug || entry);
  const quarantined = (first.quarantined || []).map((entry) => entry.slug || entry);
  assert.deepEqual(migrated, [explicitSlug]);
  assert.deepEqual(quarantined, [ambiguousSlug]);
  assert.deepEqual(first.migratedRedirects, [
    {
      ...attributableRedirect,
      projectRef: { ...TARGET_A, baseUrl: "https://alpha-reports.pages.dev" }
    }
  ]);
  assert.deepEqual(first.quarantinedRedirects, [ambiguousRedirect]);

  const alphaManifest = await publisher.buildSyncManifest(pagesConfig(TARGET_A));
  const betaManifest = await publisher.buildSyncManifest(pagesConfig(TARGET_B));
  assert.deepEqual(alphaManifest.publications.map((entry) => entry.slug), [explicitSlug]);
  assert.deepEqual(betaManifest.publications.map((entry) => entry.slug), []);

  const second = await publisher.migrateLegacyStaging({
    publications: [explicit, ambiguous],
    redirects: [attributableRedirect, ambiguousRedirect],
    currentPagesConfig: pagesConfig(TARGET_B)
  });
  assert.deepEqual(second.quarantinedRedirects, [ambiguousRedirect]);
  assert.equal(
    await fs.readFile(path.join(legacyRoot, explicitSlug, "index.html"), "utf8"),
    beforeExplicit,
    "legacy evidence must remain read-only"
  );
  assert.equal(
    await fs.readFile(path.join(legacyRoot, ambiguousSlug, "index.html"), "utf8"),
    beforeAmbiguous,
    "quarantined legacy evidence must remain available for recovery"
  );
});

test("legacy migration quarantines a shared slug attributed to distinct ProjectRefs", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const slug = "shared-legacy-slug";
  const legacyContentRoot = path.join(dataDir, "pages-site", "p", slug);
  await fs.mkdir(legacyContentRoot, { recursive: true });
  await fs.writeFile(
    path.join(legacyContentRoot, "index.html"),
    "<h1>AMBIGUOUS_SHARED_BYTES</h1>",
    "utf8"
  );
  const alpha = { ...publication(slug, TARGET_A), token: "token-alpha" };
  const beta = { ...publication(slug, TARGET_B), token: "token-beta" };
  const publisher = createCloudflarePagesPublisher({ dataDir });

  try {
    const result = await publisher.migrateLegacyStaging({ publications: [alpha, beta] });
    assert.deepEqual(result.migrated, []);
    assert.deepEqual(
      result.quarantined.map((entry) => entry.token).sort(),
      ["token-alpha", "token-beta"]
    );
    assert.deepEqual(
      (await publisher.buildSyncManifest(pagesConfig(TARGET_A))).publications,
      []
    );
    assert.deepEqual(
      (await publisher.buildSyncManifest(pagesConfig(TARGET_B))).publications,
      []
    );
    assert.match(
      await fs.readFile(path.join(legacyContentRoot, "index.html"), "utf8"),
      /AMBIGUOUS_SHARED_BYTES/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("v3 redirects inherit one explicit destination publication target and persist on migration", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const explicit = publication("v3-destination", TARGET_A);
  delete explicit.projectRef;
  await fs.writeFile(
    path.join(dataDir, "reports.json"),
    `${JSON.stringify(
      {
        version: 3,
        redirects: [{ from: "/p/v3-old/", to: "/p/v3-destination/" }],
        reports: [
          {
            id: "v3-report",
            kind: "path",
            name: "V3 report",
            sourcePath: "/tmp/v3-report.html",
            rootDir: "/tmp",
            entryFile: "v3-report.html",
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z",
            publications: [explicit]
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const store = createReportStore({ dataDir });
  await store.init();
  const expectedProjectRef = { ...TARGET_A, baseUrl: "https://alpha-reports.pages.dev" };
  assert.deepEqual(store.listRedirects(pagesConfig(TARGET_A)), [
    {
      from: "/p/v3-old/",
      to: "/p/v3-destination/",
      projectRef: expectedProjectRef
    }
  ]);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"));
  assert.deepEqual(persisted.redirects[0].projectRef, expectedProjectRef);
});

test("legacy migration repairs a partial target snapshot from read-only evidence", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const slug = "partial-snapshot";
  const legacyContentRoot = path.join(dataDir, "pages-site", "p", slug);
  await fs.mkdir(legacyContentRoot, { recursive: true });
  await fs.writeFile(
    path.join(legacyContentRoot, "index.html"),
    "<h1>PARTIAL_SNAPSHOT_REPAIRED</h1>",
    "utf8"
  );

  const link = publication(slug, TARGET_A);
  const publisher = createCloudflarePagesPublisher({ dataDir });
  const snapshotRoot = path.join(
    publisher.targetPaths(pagesConfig(TARGET_A)).snapshotsRoot,
    tokenFilesystemKey(link.token)
  );
  await fs.mkdir(path.join(snapshotRoot, "content"), { recursive: true });
  await fs.writeFile(
    path.join(snapshotRoot, "snapshot.json"),
    `${JSON.stringify(
      { token: link.token, slug: link.slug, updatedAt: link.updatedAt },
      null,
      2
    )}\n`,
    "utf8"
  );

  try {
    const result = await publisher.migrateLegacyStaging({ publications: [link] });
    assert.deepEqual(result.migrated.map((entry) => entry.slug), [slug]);
    assert.match(
      await fs.readFile(path.join(snapshotRoot, "content", "index.html"), "utf8"),
      /PARTIAL_SNAPSHOT_REPAIRED/
    );
    assert.match(
      await fs.readFile(path.join(legacyContentRoot, "index.html"), "utf8"),
      /PARTIAL_SNAPSHOT_REPAIRED/,
      "repair must copy legacy evidence instead of moving or mutating it"
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("interrupted snapshot and last-deployed swaps recover the last committed bytes", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const source = await addReport(
    dataDir,
    path.join(tempDir, "source"),
    "swap",
    "<h1>SWAP_LAST_COMMITTED</h1>"
  );
  const link = publication("swap-recovery", TARGET_A);
  const targetConfig = pagesConfig(TARGET_A);
  const { fakeDeploy, captures } = makeDeployFake();
  const publisher = createCloudflarePagesPublisher({
    dataDir,
    spawnImpl: fakeDeploy,
    timeoutMs: 1000,
    fetchImpl: async () => new Response("", { status: 404 })
  });

  try {
    await publisher.publish({ report: source.report, publication: link, pagesConfig: targetConfig });
    const paths = publisher.targetPaths(targetConfig);
    const snapshotRoot = path.join(paths.snapshotsRoot, tokenFilesystemKey(link.token));
    const snapshotPrevious = `${snapshotRoot}.previous`;
    const snapshotNext = `${snapshotRoot}.next-crash`;
    const deployedPrevious = `${paths.lastDeployedRoot}.previous`;
    const deployedNext = `${paths.lastDeployedRoot}.next-crash`;

    await fs.rename(snapshotRoot, snapshotPrevious);
    await fs.cp(snapshotPrevious, snapshotNext, { recursive: true });
    await fs.writeFile(
      path.join(snapshotNext, "content", "index.html"),
      "<h1>UNCOMMITTED_SNAPSHOT</h1>",
      "utf8"
    );
    await fs.rename(paths.lastDeployedRoot, deployedPrevious);
    await fs.cp(deployedPrevious, deployedNext, { recursive: true });
    await fs.writeFile(
      path.join(deployedNext, "p", link.slug, "index.html"),
      "<h1>UNCOMMITTED_SITE</h1>",
      "utf8"
    );

    await publisher.revoke([], targetConfig);

    assert.equal(captures.length, 2);
    const recoveredDeploy = captureText(captures[1]);
    assert.match(recoveredDeploy, /SWAP_LAST_COMMITTED/);
    assert.doesNotMatch(recoveredDeploy, /UNCOMMITTED_SNAPSHOT|UNCOMMITTED_SITE/);
    assert.match(
      await fs.readFile(path.join(snapshotRoot, "content", "index.html"), "utf8"),
      /SWAP_LAST_COMMITTED/
    );
    assert.match(
      await fs.readFile(path.join(paths.lastDeployedRoot, "p", link.slug, "index.html"), "utf8"),
      /SWAP_LAST_COMMITTED/
    );
    await assert.rejects(fs.access(snapshotPrevious), { code: "ENOENT" });
    await assert.rejects(fs.access(snapshotNext), { code: "ENOENT" });
    await assert.rejects(fs.access(deployedPrevious), { code: "ENOENT" });
    await assert.rejects(fs.access(deployedNext), { code: "ENOENT" });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
