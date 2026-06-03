import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  CLOUDFLARE_OAUTH_SCOPES,
  TunnelManager,
  chooseWranglerPagesProject,
  cloudflareCredentialStatus,
  createDeployQueue,
  createReportStore,
  extractPublicUrl,
  localHtmlPathCandidates,
  normalizeAssetRequestPath,
  normalizeLocalHtmlPath,
  parseWranglerPagesProjects,
  parseWranglerWhoamiAccounts,
  parseMultipartUpload,
  publishReportSnapshot,
  startServers
} from "../src/server.js";

import { markdownToHtml, renderMarkdownBody } from "../src/markdown.js";

// Builds a configurable Wrangler fake-spawn that answers whoami, project list,
// and project create from per-command handlers. Each handler returns
// { code = 0, output } and the captured command list is returned for assertions.
function makeWranglerFake(handlers) {
  const captured = [];
  function fakeSpawn(command, args, options) {
    captured.push({ command, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID || "" });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    setImmediate(() => {
      const result = handlers(args, captured) || { code: 0, output: "" };
      if (result.output) {
        const stream = result.stderr ? child.stderr : child.stdout;
        stream.emit("data", Buffer.from(result.output));
      }
      child.exitCode = result.code ?? 0;
      child.emit("exit", result.code ?? 0, null);
    });
    return child;
  }
  return { fakeSpawn, captured };
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "html-reporter-test-"));
}

test("path reports resolve entry and sibling assets with traversal guards", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "index.html");
  const cssPath = path.join(reportDir, "style.css");
  await fs.writeFile(reportPath, '<link rel="stylesheet" href="style.css"><h1>Report</h1>');
  await fs.writeFile(cssPath, "body { color: red; }");
  await fs.writeFile(path.join(reportDir, ".env"), "SECRET=1");

  const store = createReportStore({ dataDir });
  await store.init();
  const report = await store.addPath(reportPath);

  const entry = await store.resolveAsset(report.id, "");
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.filePath, reportPath);

  const css = await store.resolveAsset(report.id, "style.css");
  assert.equal(css.statusCode, 200);
  assert.equal(css.filePath, cssPath);

  const traversal = await store.resolveAsset(report.id, "../index.html");
  assert.equal(traversal.statusCode, 403);

  const hidden = await store.resolveAsset(report.id, ".env");
  assert.equal(hidden.statusCode, 403);
});

test("uploads are cached as report entries", async () => {
  const tempDir = await makeTempDir();
  const store = createReportStore({ dataDir: path.join(tempDir, "data") });
  await store.init();

  const report = await store.addUpload({
    filename: "dropped.html",
    content: Buffer.from("<h1>Uploaded</h1>")
  });

  const entry = await store.resolveAsset(report.id, "");
  assert.equal(entry.statusCode, 200);
  assert.equal(await fs.readFile(entry.filePath, "utf8"), "<h1>Uploaded</h1>");
});

test("local HTML path validation rejects unsafe inputs", async () => {
  const tempDir = await makeTempDir();
  const htmlPath = path.join(tempDir, "safe.html");
  await fs.writeFile(htmlPath, "<h1>Safe</h1>");

  assert.equal(await normalizeLocalHtmlPath(htmlPath), htmlPath);
  assert.equal(await normalizeLocalHtmlPath(`  "${htmlPath}"  `), htmlPath);
  await assert.rejects(() => normalizeLocalHtmlPath("safe.html"), /absolute/);
  await assert.rejects(() => normalizeLocalHtmlPath(path.join(tempDir, "safe.txt")), /Only .html/);
});

test("local HTML path validation accepts file URLs and pasted URL wrappers", async () => {
  const tempDir = await makeTempDir();
  const htmlPath = path.join(tempDir, "safe report.html");
  await fs.writeFile(htmlPath, "<h1>Safe URL</h1>");
  const fileUrl = pathToFileURL(htmlPath).href;

  assert.equal(await normalizeLocalHtmlPath(fileUrl), htmlPath);
  assert.equal(await normalizeLocalHtmlPath(` <${fileUrl}> `), htmlPath);
  assert.equal(await normalizeLocalHtmlPath(`${fileUrl},`), htmlPath);
  assert.deepEqual(localHtmlPathCandidates(`${fileUrl}.`), [`${htmlPath}.`, htmlPath]);
  await assert.rejects(() => normalizeLocalHtmlPath("https://example.com/report.html"), /file:\/\//);
});

test("asset request normalization rejects encoded traversal and dotfiles", () => {
  assert.equal(normalizeAssetRequestPath("assets/report.css"), path.join("assets", "report.css"));
  assert.equal(normalizeAssetRequestPath("..%2Fsecret.txt"), null);
  assert.equal(normalizeAssetRequestPath("assets/.secret"), null);
});

test("multipart upload parser extracts the uploaded HTML file", () => {
  const boundary = "boundary-test";
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="report"; filename="report.html"',
      "Content-Type: text/html",
      "",
      "<h1>Multipart</h1>",
      `--${boundary}--`,
      ""
    ].join("\r\n"),
    "utf8"
  );

  const upload = parseMultipartUpload(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(upload.fieldName, "report");
  assert.equal(upload.filename, "report.html");
  assert.equal(upload.content.toString("utf8"), "<h1>Multipart</h1>");
});

test("tunnel URL extraction handles Tailscale Funnel output", () => {
  assert.equal(
    extractPublicUrl(
      "Available on the internet:\n|-- https://html-reporter.example.ts.net\n|--> http://127.0.0.1:4174"
    ),
    "https://html-reporter.example.ts.net"
  );
  assert.equal(
    extractPublicUrl("Visit https://example.trycloudflare.com or https://quiet-bird.loca.lt"),
    null
  );
});

test("tunnel manager starts, rotates, and stops Tailscale Funnel processes", async () => {
  const capturedCommands = [];
  let startedCount = 0;
  function fakeSpawn(command, args) {
    capturedCommands.push({ command, args });
    const isStatus = args[0] === "status";
    const isStop = args.includes("off");
    if (!isStatus && !isStop) {
      startedCount += 1;
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.killed = true;
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    setImmediate(() => {
      if (isStatus) {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              Self: {
                ID: "node123",
                Capabilities: ["https://tailscale.com/cap/funnel-ports?ports=443,8443,10000"]
              }
            })
          )
        );
      } else if (!isStop) {
        child.stdout.emit(
          "data",
          Buffer.from(`Available on the internet:\n|-- https://reporter-${startedCount}.example.ts.net`)
        );
      }
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return child;
  }

  const manager = new TunnelManager({
    localUrl: "http://127.0.0.1:4321",
    spawnImpl: fakeSpawn,
    timeoutMs: 1000
  });

  const started = await manager.start("auto");
  assert.equal(capturedCommands[0].command, "tailscale");
  assert.deepEqual(capturedCommands[0].args, ["status", "--json"]);
  assert.equal(capturedCommands[1].command, "tailscale");
  assert.deepEqual(capturedCommands[1].args, [
    "funnel",
    "--bg",
    "--yes",
    "--https=443",
    "http://127.0.0.1:4321"
  ]);
  assert.equal(started.publicUrl, "https://reporter-1.example.ts.net");
  assert.equal(started.running, true);

  const rotated = await manager.rotate("auto");
  assert.equal(capturedCommands[2].command, "tailscale");
  assert.deepEqual(capturedCommands[2].args, ["funnel", "--https=443", "off"]);
  assert.equal(capturedCommands[3].command, "tailscale");
  assert.deepEqual(capturedCommands[3].args, ["status", "--json"]);
  assert.equal(capturedCommands[4].command, "tailscale");
  assert.equal(rotated.publicUrl, "https://reporter-2.example.ts.net");
  assert.equal(rotated.running, true);

  const stopped = await manager.stop();
  assert.equal(capturedCommands[5].command, "tailscale");
  assert.deepEqual(capturedCommands[5].args, ["funnel", "--https=443", "off"]);
  assert.equal(stopped.running, false);
});

test("tunnel manager requires Tailscale Funnel capability before starting Funnel", async () => {
  const capturedCommands = [];
  function fakeSpawn(command, args) {
    capturedCommands.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ Self: { ID: "node123", Capabilities: [] } }))
      );
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return child;
  }

  const manager = new TunnelManager({
    localUrl: "http://127.0.0.1:4321",
    spawnImpl: fakeSpawn,
    timeoutMs: 1000
  });

  await assert.rejects(() => manager.start("auto"), /Tailscale Funnel is not enabled/);
  assert.deepEqual(capturedCommands.map((item) => item.args), [["status", "--json"]]);
});

test("Wrangler Pages project list parsing normalizes selectable projects", () => {
  const projects = parseWranglerPagesProjects(
    `Some log line\n${JSON.stringify({
      result: [
        {
          name: "team-reports",
          account_id: "0123456789abcdef0123456789abcdef",
          account_name: "Team"
        },
        {
          project_name: "html-reporter",
          account: { id: "abcdef0123456789abcdef0123456789", name: "Personal" }
        },
        {
          name: "../bad"
        }
      ]
    })}`
  );

  assert.deepEqual(projects, [
    {
      name: "html-reporter",
      accountId: "abcdef0123456789abcdef0123456789",
      accountName: "Personal",
      productionBranch: "",
      baseUrl: "https://html-reporter.pages.dev"
    },
    {
      name: "team-reports",
      accountId: "0123456789abcdef0123456789abcdef",
      accountName: "Team",
      productionBranch: "",
      baseUrl: "https://team-reports.pages.dev"
    }
  ]);
  assert.equal(chooseWranglerPagesProject(projects, { projectName: "team-reports" }).name, "team-reports");
  assert.equal(chooseWranglerPagesProject(projects, {}).name, "html-reporter");

  assert.deepEqual(
    parseWranglerPagesProjects(
      [
        "┌───────────────┬───────────────────┐",
        "│ Name          │ Production Branch │",
        "├───────────────┼───────────────────┤",
        "│ team-reports  │ main              │",
        "│ html-reporter │ production        │",
        "└───────────────┴───────────────────┘"
      ].join("\n")
    ),
    [
      {
        name: "html-reporter",
        accountId: "",
        accountName: "",
        productionBranch: "production",
        baseUrl: "https://html-reporter.pages.dev"
      },
      {
        name: "team-reports",
        accountId: "",
        accountName: "",
        productionBranch: "main",
        baseUrl: "https://team-reports.pages.dev"
      }
    ]
  );
});

test("Cloudflare credential status reports scoped token availability without exposing token", () => {
  assert.deepEqual(cloudflareCredentialStatus({}), {
    authMode: "scoped-oauth",
    tokenConfigured: false,
    accountIdConfigured: false,
    accountId: "",
    scopedOauthAvailable: true,
    oauthScopes: CLOUDFLARE_OAUTH_SCOPES
  });

  assert.deepEqual(
    cloudflareCredentialStatus({
      CLOUDFLARE_API_TOKEN: "secret-token",
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef"
    }),
    {
      authMode: "api-token",
      tokenConfigured: true,
      accountIdConfigured: true,
      accountId: "0123456789abcdef0123456789abcdef",
      scopedOauthAvailable: true,
      oauthScopes: CLOUDFLARE_OAUTH_SCOPES
    }
  );
});

test("Cloudflare login runs Wrangler OAuth and saves the detected Pages project", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const capturedCommands = [];

  function fakeCloudflareAuth(command, args, options) {
    capturedCommands.push({ command, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID || "" });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };

    setImmediate(() => {
      if (args.includes("login")) {
        child.stdout.emit("data", Buffer.from("Successfully logged in"));
      } else {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify([
              {
                name: "team-reports",
                account_id: "0123456789abcdef0123456789abcdef",
                account_name: "Team"
              },
              {
                name: "html-reporter",
                account_id: "abcdef0123456789abcdef0123456789",
                account_name: "Personal"
              }
            ])
          )
        );
      }
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });

    return child;
  }

  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: fakeCloudflareAuth,
    cloudflareLoginTimeoutMs: 1000,
    cloudflareListTimeoutMs: 1000
  });

  try {
    const response = await fetch(`${runtime.adminUrl}/api/cloudflare/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(capturedCommands.map((item) => item.args), [
      [
        "--yes",
        "wrangler",
        "login",
        "--scopes",
        "account:read",
        "--scopes",
        "user:read",
        "--scopes",
        "pages:write"
      ],
      ["--yes", "wrangler", "pages", "project", "list", "--json"]
    ]);
    assert.equal(data.cloudflare.authenticated, true);
    assert.equal(data.cloudflare.projectCount, 2);
    assert.equal(data.cloudflare.selectedProject.name, "html-reporter");
    assert.equal(data.config.pages.projectName, "html-reporter");
    assert.equal(data.config.pages.accountId, "abcdef0123456789abcdef0123456789");
  } finally {
    await runtime.close();
  }
});

test("Cloudflare project refresh falls back when Wrangler does not support JSON output", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const capturedCommands = [];

  function fakeCloudflareAuth(command, args, options) {
    capturedCommands.push({ command, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID || "" });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };

    setImmediate(() => {
      if (args.includes("--json")) {
        child.stderr.emit("data", Buffer.from("Unknown argument: json"));
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return;
      }

      child.stdout.emit(
        "data",
        Buffer.from(
          [
            "┌───────────────┬───────────────────┐",
            "│ Name          │ Production Branch │",
            "├───────────────┼───────────────────┤",
            "│ team-reports  │ main              │",
            "│ html-reporter │ production        │",
            "└───────────────┴───────────────────┘"
          ].join("\n")
        )
      );
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });

    return child;
  }

  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: fakeCloudflareAuth,
    cloudflareListTimeoutMs: 1000
  });

  try {
    const configResponse = await fetch(`${runtime.adminUrl}/api/config/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName: "html-reporter",
        accountId: "0123456789abcdef0123456789abcdef"
      })
    });
    assert.equal(configResponse.status, 200);

    const response = await fetch(`${runtime.adminUrl}/api/cloudflare/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(capturedCommands, [
      {
        command: "npx",
        args: ["--yes", "wrangler", "pages", "project", "list", "--json"],
        accountId: "0123456789abcdef0123456789abcdef"
      },
      {
        command: "npx",
        args: ["--yes", "wrangler", "pages", "project", "list"],
        accountId: "0123456789abcdef0123456789abcdef"
      }
    ]);
    assert.equal(data.cloudflare.projectCount, 2);
    assert.equal(data.cloudflare.selectedProject.name, "html-reporter");
    assert.equal(data.config.pages.projectName, "html-reporter");
  } finally {
    await runtime.close();
  }
});

test("snapshot publications deploy to Cloudflare Pages and revoke from the staged site", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.mkdir(path.join(reportDir, "assets"), { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, '<link rel="stylesheet" href="style.css"><h1>Snapshot</h1>');
  await fs.writeFile(path.join(reportDir, "style.css"), "body { color: blue; }");
  await fs.writeFile(path.join(reportDir, "assets", "data.json"), "{}");
  await fs.writeFile(path.join(reportDir, ".env"), "SECRET=1");

  const deployCommands = [];
  function fakePagesDeploy(command, args) {
    deployCommands.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("Cloudflare Pages deploy complete"));
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return child;
  }

  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: fakePagesDeploy,
    pagesDeployTimeoutMs: 1000
  });

  try {
    const configResponse = await fetch(`${runtime.adminUrl}/api/config/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName: "team-reports",
        accountId: "0123456789abcdef0123456789abcdef"
      })
    });
    assert.equal(configResponse.status, 200);

    const addResponse = await fetch(`${runtime.adminUrl}/api/reports/path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: reportPath })
    });
    assert.equal(addResponse.status, 201);
    const addData = await addResponse.json();

    const publishResponse = await fetch(
      `${runtime.adminUrl}/api/reports/${addData.report.id}/publish-snapshot`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }
    );
    assert.equal(publishResponse.status, 201);
    const publishData = await publishResponse.json();
    assert.equal(publishData.publication.kind, "snapshot");
    assert.equal(
      publishData.publication.publicUrl,
      `https://team-reports.pages.dev/p/${publishData.publication.token}/`
    );
    assert.equal(publishData.report.publicUrl, publishData.publication.publicUrl);

    assert.equal(deployCommands[0].command, "npx");
    assert.deepEqual(deployCommands[0].args, [
      "--yes",
      "wrangler",
      "pages",
      "deploy",
      path.join(dataDir, "pages-site"),
      "--project-name",
      "team-reports",
      "--branch",
      "main",
      "--account-id",
      "0123456789abcdef0123456789abcdef"
    ]);

    const stagedDir = path.join(dataDir, "pages-site", "p", publishData.publication.token);
    await assert.rejects(() => fs.stat(path.join(dataDir, "pages-site", "index.html")), /ENOENT/);
    assert.match(await fs.readFile(path.join(dataDir, "pages-site", "404.html"), "utf8"), /Not found/);
    assert.match(await fs.readFile(path.join(dataDir, "pages-site", "_headers"), "utf8"), /no-store/);
    assert.match(await fs.readFile(path.join(stagedDir, "index.html"), "utf8"), /Snapshot/);
    assert.equal(await fs.readFile(path.join(stagedDir, "style.css"), "utf8"), "body { color: blue; }");
    assert.equal(await fs.readFile(path.join(stagedDir, "assets", "data.json"), "utf8"), "{}");
    await assert.rejects(() => fs.stat(path.join(stagedDir, ".env")), /ENOENT/);

    const revokeResponse = await fetch(
      `${runtime.adminUrl}/api/publications/${publishData.publication.token}/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }
    );
    assert.equal(revokeResponse.status, 200);
    const revokeData = await revokeResponse.json();
    assert.equal(revokeData.publication.active, false);
    assert.equal(deployCommands.length, 2);
    await assert.rejects(() => fs.stat(stagedDir), /ENOENT/);
  } finally {
    await runtime.close();
  }
});

test("draft reports preview locally and only published versions are public", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, '<link rel="stylesheet" href="style.css"><h1>HTTP Report</h1>');
  await fs.writeFile(path.join(reportDir, "style.css"), "body { color: green; }");

  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    tunnelTimeoutMs: 1000
  });

  try {
    const addResponse = await fetch(`${runtime.adminUrl}/api/reports/path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: reportPath })
    });
    assert.equal(addResponse.status, 201);

    const addData = await addResponse.json();
    assert.match(addData.report.localUrl, /^http:\/\/127\.0\.0\.1:\d+\/preview\/.+\/$/);
    assert.equal(addData.report.publications.length, 0);

    const reportResponse = await fetch(addData.report.localUrl);
    assert.equal(reportResponse.status, 200);
    assert.match(await reportResponse.text(), /HTTP Report/);

    const assetResponse = await fetch(new URL("style.css", addData.report.localUrl));
    assert.equal(assetResponse.status, 200);
    assert.equal(await assetResponse.text(), "body { color: green; }");

    const hiddenResponse = await fetch(new URL(".env", addData.report.localUrl));
    assert.equal(hiddenResponse.status, 403);

    const publicDraftResponse = await fetch(`${runtime.publicUrl}/r/${addData.report.id}/`);
    assert.equal(publicDraftResponse.status, 404);

    const publishV1Response = await fetch(`${runtime.adminUrl}/api/reports/${addData.report.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "v1" })
    });
    assert.equal(publishV1Response.status, 201);
    const publishV1Data = await publishV1Response.json();
    assert.equal(publishV1Data.publication.label, "v1");
    assert.match(publishV1Data.publication.localUrl, /^http:\/\/127\.0\.0\.1:\d+\/p\/v1-[a-f0-9]+\/$/);

    const publishV2Response = await fetch(`${runtime.adminUrl}/api/reports/${addData.report.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(publishV2Response.status, 201);
    const publishV2Data = await publishV2Response.json();
    assert.equal(publishV2Data.publication.label, "v2");
    assert.notEqual(publishV1Data.publication.localUrl, publishV2Data.publication.localUrl);

    const publicV1Response = await fetch(publishV1Data.publication.localUrl);
    assert.equal(publicV1Response.status, 200);
    assert.match(await publicV1Response.text(), /HTTP Report/);

    const publicV1AssetResponse = await fetch(new URL("style.css", publishV1Data.publication.localUrl));
    assert.equal(publicV1AssetResponse.status, 200);
    assert.equal(await publicV1AssetResponse.text(), "body { color: green; }");

    const revokeResponse = await fetch(
      `${runtime.adminUrl}/api/publications/${publishV1Data.publication.token}/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }
    );
    assert.equal(revokeResponse.status, 200);

    const revokedV1Response = await fetch(publishV1Data.publication.localUrl);
    assert.equal(revokedV1Response.status, 404);

    const stillActiveV2Response = await fetch(publishV2Data.publication.localUrl);
    assert.equal(stillActiveV2Response.status, 200);

    const revokeAllResponse = await fetch(`${runtime.adminUrl}/api/reports/${addData.report.id}/revoke-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(revokeAllResponse.status, 200);

    const revokedV2Response = await fetch(publishV2Data.publication.localUrl);
    assert.equal(revokedV2Response.status, 404);
  } finally {
    await runtime.close();
  }
});

test("Wrangler whoami parsing reads accounts from JSON and table output", () => {
  assert.deepEqual(
    parseWranglerWhoamiAccounts(
      JSON.stringify({
        email: "user@example.com",
        accounts: [
          { name: "Personal", id: "abcdef0123456789abcdef0123456789" },
          { name: "Team", account_id: "0123456789abcdef0123456789abcdef" }
        ]
      })
    ),
    [
      { id: "abcdef0123456789abcdef0123456789", name: "Personal" },
      { id: "0123456789abcdef0123456789abcdef", name: "Team" }
    ]
  );

  assert.deepEqual(
    parseWranglerWhoamiAccounts(
      [
        "┌──────────────────┬──────────────────────────────────┐",
        "│ Account Name     │ Account ID                       │",
        "├──────────────────┼──────────────────────────────────┤",
        "│ Personal Account │ abcdef0123456789abcdef0123456789 │",
        "└──────────────────┴──────────────────────────────────┘"
      ].join("\n")
    ),
    [{ id: "abcdef0123456789abcdef0123456789", name: "Personal Account" }]
  );

  assert.deepEqual(parseWranglerWhoamiAccounts("You are not authenticated."), []);
});

test("Cloudflare connect auto-detects one account and auto-creates the Pages project", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  let created = false;

  const { fakeSpawn, captured } = makeWranglerFake((args) => {
    if (args.includes("login")) {
      return { code: 0, output: "Successfully logged in" };
    }
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({
          accounts: [{ name: "Personal", id: "abcdef0123456789abcdef0123456789" }]
        })
      };
    }
    if (args.includes("create")) {
      created = true;
      return { code: 0, output: "✨ Successfully created the 'html-reporter' project." };
    }
    if (args.includes("list")) {
      return {
        code: 0,
        output: created
          ? JSON.stringify([
              { name: "html-reporter", account_id: "abcdef0123456789abcdef0123456789" }
            ])
          : JSON.stringify([])
      };
    }
    return { code: 0, output: "" };
  });

  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: fakeSpawn,
    cloudflareLoginTimeoutMs: 1000,
    cloudflareListTimeoutMs: 1000
  });

  try {
    const response = await fetch(`${runtime.adminUrl}/api/cloudflare/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.cloudflare.authenticated, true);
    assert.equal(data.cloudflare.needsAccountChoice, false);
    assert.equal(data.cloudflare.autoCreated, true);
    assert.equal(data.cloudflare.account.id, "abcdef0123456789abcdef0123456789");
    assert.equal(data.cloudflare.selectedProject.name, "html-reporter");
    assert.equal(data.config.pages.accountId, "abcdef0123456789abcdef0123456789");

    // The project create command actually ran with the resolved account.
    const createCall = captured.find((item) => item.args.includes("create"));
    assert.ok(createCall, "expected a pages project create call");
    assert.equal(createCall.accountId, "abcdef0123456789abcdef0123456789");

    // /api/status now reflects the logged-in session without re-spawning.
    const statusResponse = await fetch(`${runtime.adminUrl}/api/status`);
    const status = await statusResponse.json();
    assert.equal(status.cloudflare.loggedIn, true);
    assert.equal(status.cloudflare.accountName, "Personal");
    assert.equal(status.cloudflare.projectName, "html-reporter");
  } finally {
    await runtime.close();
  }
});

test("Headless publishReportSnapshot auto-provisions and returns a public URL", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, "<h1>Headless</h1>");

  const { fakeSpawn: authSpawn } = makeWranglerFake((args) => {
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({
          accounts: [{ name: "Personal", id: "abcdef0123456789abcdef0123456789" }]
        })
      };
    }
    if (args.includes("list")) {
      return {
        code: 0,
        output: JSON.stringify([
          { name: "html-reporter", account_id: "abcdef0123456789abcdef0123456789" }
        ])
      };
    }
    return { code: 0, output: "" };
  });

  const deployCommands = [];
  function fakeDeploy(command, args) {
    deployCommands.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("deploy complete"));
      child.emit("exit", 0, null);
    });
    return child;
  }

  const result = await publishReportSnapshot({
    path: reportPath,
    dataDir,
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: fakeDeploy,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  });

  assert.match(result.url, /^https:\/\/html-reporter\.pages\.dev\/p\/.+\/$/);
  assert.equal(result.projectName, "html-reporter");
  assert.ok(deployCommands.length >= 1, "expected a Pages deploy");
});

test("Headless publishReportSnapshot fails clearly when not signed in", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportPath = path.join(tempDir, "report.html");
  await fs.writeFile(reportPath, "<h1>Headless</h1>");

  const { fakeSpawn: authSpawn } = makeWranglerFake((args) => {
    if (args.includes("whoami")) {
      return { code: 0, output: "You are not authenticated." };
    }
    return { code: 0, output: "" };
  });

  await assert.rejects(
    () =>
      publishReportSnapshot({
        path: reportPath,
        dataDir,
        cloudflareAuthSpawnImpl: authSpawn,
        cloudflareListTimeoutMs: 1000
      }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.match(error.message, /Not signed in to Cloudflare/);
      return true;
    }
  );
});

test("Cloudflare connect surfaces an account choice when multiple accounts exist", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");

  const { fakeSpawn } = makeWranglerFake((args) => {
    if (args.includes("login")) {
      return { code: 0, output: "Successfully logged in" };
    }
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({
          accounts: [
            { name: "Personal", id: "abcdef0123456789abcdef0123456789" },
            { name: "Team", id: "0123456789abcdef0123456789abcdef" }
          ]
        })
      };
    }
    return { code: 0, output: "[]" };
  });

  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: fakeSpawn,
    cloudflareLoginTimeoutMs: 1000,
    cloudflareListTimeoutMs: 1000
  });

  try {
    const response = await fetch(`${runtime.adminUrl}/api/cloudflare/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.cloudflare.authenticated, true);
    assert.equal(data.cloudflare.needsAccountChoice, true);
    assert.equal(data.cloudflare.accounts.length, 2);
    assert.equal(data.cloudflare.selectedProject, null);
  } finally {
    await runtime.close();
  }
});

// --- Helpers for the v3 feature tests -------------------------------------

// An instrumented Pages-deploy fake that records every deploy invocation and
// tracks concurrency so tests can assert that deploys never overlap. `delayMs`
// keeps each deploy "in flight" long enough for an overlap to be observable if
// the serialization were broken.
function makeInstrumentedDeploy({ delayMs = 15 } = {}) {
  const state = {
    deployCount: 0,
    inFlight: 0,
    maxConcurrent: 0,
    args: []
  };
  function fakeDeploy(command, args) {
    state.deployCount += 1;
    state.inFlight += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
    state.args.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    setTimeout(() => {
      child.stdout.emit("data", Buffer.from("Cloudflare Pages deploy complete"));
      state.inFlight -= 1;
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }, delayMs);
    return child;
  }
  return { fakeDeploy, state };
}

async function pollUntil(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function configurePages(adminUrl, projectName = "team-reports") {
  const response = await fetch(`${adminUrl}/api/config/pages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectName,
      accountId: "0123456789abcdef0123456789abcdef"
    })
  });
  assert.equal(response.status, 200);
}

async function addPathReport(adminUrl, reportPath) {
  const response = await fetch(`${adminUrl}/api/reports/path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: reportPath })
  });
  assert.equal(response.status, 201);
  return (await response.json()).report;
}

async function publishSnapshot(adminUrl, reportId) {
  const response = await fetch(`${adminUrl}/api/reports/${reportId}/publish-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(response.status, 201);
  return (await response.json()).publication;
}

// --- createDeployQueue unit behavior --------------------------------------

test("deploy queue serializes tasks and survives a failing task", async () => {
  const queue = createDeployQueue();
  const events = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  function task(label, { fail = false } = {}) {
    return queue.enqueue(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      events.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${label}`);
      inFlight -= 1;
      if (fail) {
        throw new Error(`boom:${label}`);
      }
      return label;
    });
  }

  const a = task("a");
  const b = task("b", { fail: true });
  const c = task("c");

  assert.equal(await a, "a");
  // A failing task rejects to its own caller but must not wedge the chain.
  await assert.rejects(() => b, /boom:b/);
  assert.equal(await c, "c");

  assert.equal(maxConcurrent, 1, "tasks must never overlap");
  assert.deepEqual(events, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
    "start:c",
    "end:c"
  ]);
});

// --- 1d: live sync updates the same URL in place --------------------------

test("snapshot sync updates the same URL in place without a new publication", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, "<h1>Before sync</h1>");

  const { fakeDeploy, state } = makeInstrumentedDeploy();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: fakeDeploy,
    pagesDeployTimeoutMs: 1000
  });

  try {
    await configurePages(runtime.adminUrl);
    const report = await addPathReport(runtime.adminUrl, reportPath);
    const publication = await publishSnapshot(runtime.adminUrl, report.id);
    assert.equal(state.deployCount, 1);

    const stagedIndex = path.join(dataDir, "pages-site", "p", publication.slug, "index.html");
    assert.match(await fs.readFile(stagedIndex, "utf8"), /Before sync/);

    // Mutate the source, then sync the SAME publication.
    await fs.writeFile(reportPath, "<h1>After sync</h1>");
    const syncResponse = await fetch(
      `${runtime.adminUrl}/api/publications/${publication.token}/sync`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    );
    assert.equal(syncResponse.status, 200);
    const syncData = await syncResponse.json();

    // URL is stable, no new publication record, updatedAt advances.
    assert.equal(syncData.publication.token, publication.token);
    assert.equal(syncData.publication.publicUrl, publication.publicUrl);
    assert.equal(syncData.report.publications.length, 1);
    assert.ok(
      syncData.publication.updatedAt > publication.updatedAt,
      "updatedAt should advance after sync"
    );
    assert.equal(state.deployCount, 2, "sync should trigger a second deploy");
    assert.match(await fs.readFile(stagedIndex, "utf8"), /After sync/);
  } finally {
    await runtime.close();
  }
});

// --- 1e: custom slug + 301 redirect ---------------------------------------

test("custom slug rename moves the folder, writes a 301 redirect, and validates", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, "<h1>Slugged</h1>");

  const { fakeDeploy } = makeInstrumentedDeploy();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: fakeDeploy,
    pagesDeployTimeoutMs: 1000
  });

  try {
    await configurePages(runtime.adminUrl);
    const report = await addPathReport(runtime.adminUrl, reportPath);
    const publication = await publishSnapshot(runtime.adminUrl, report.id);
    const oldSlug = publication.slug;

    const renameResponse = await fetch(
      `${runtime.adminUrl}/api/publications/${publication.token}/slug`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "quarterly-review" })
      }
    );
    assert.equal(renameResponse.status, 200);
    const renameData = await renameResponse.json();
    assert.equal(renameData.publication.slug, "quarterly-review");
    assert.match(renameData.publication.publicUrl, /\/p\/quarterly-review\/$/);

    const siteRoot = path.join(dataDir, "pages-site");
    assert.ok(await fs.stat(path.join(siteRoot, "p", "quarterly-review", "index.html")));
    await assert.rejects(() => fs.stat(path.join(siteRoot, "p", oldSlug)), /ENOENT/);

    const redirects = await fs.readFile(path.join(siteRoot, "_redirects"), "utf8");
    assert.match(
      redirects,
      new RegExp(`/p/${oldSlug}/\\* /p/quarterly-review/:splat 301`)
    );

    // Old local URL on the public server returns a 301 to the new slug.
    const oldUrlResponse = await fetch(`${runtime.publicUrl}/p/${oldSlug}/`, {
      redirect: "manual"
    });
    assert.equal(oldUrlResponse.status, 301);
    assert.equal(oldUrlResponse.headers.get("location"), `/p/quarterly-review/`);

    // The new slug serves the content locally.
    const newUrlResponse = await fetch(`${runtime.publicUrl}/p/quarterly-review/`);
    assert.equal(newUrlResponse.status, 200);
    assert.match(await newUrlResponse.text(), /Slugged/);

    // Duplicate slug -> 409.
    const dupResponse = await fetch(
      `${runtime.adminUrl}/api/publications/${publication.token}/slug`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "quarterly-review" })
      }
    );
    // Renaming to its own current slug is a no-op success; use a second
    // publication to prove collision. Publish another snapshot and collide.
    assert.equal(dupResponse.status, 200);

    const second = await publishSnapshot(runtime.adminUrl, report.id);
    const collideResponse = await fetch(
      `${runtime.adminUrl}/api/publications/${second.token}/slug`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "quarterly-review" })
      }
    );
    assert.equal(collideResponse.status, 409);

    // Invalid slug -> 400.
    const invalidResponse = await fetch(
      `${runtime.adminUrl}/api/publications/${second.token}/slug`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "Bad Slug" })
      }
    );
    assert.equal(invalidResponse.status, 400);
  } finally {
    await runtime.close();
  }
});

// --- 1f: working copy editor ----------------------------------------------

test("editing a path report writes a working copy and leaves the source untouched", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  const originalHtml = "<h1>Original source</h1>";
  await fs.writeFile(reportPath, originalHtml);

  const { fakeDeploy } = makeInstrumentedDeploy();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: fakeDeploy,
    pagesDeployTimeoutMs: 1000
  });

  try {
    await configurePages(runtime.adminUrl);
    const report = await addPathReport(runtime.adminUrl, reportPath);

    // GET content reads the source before any edit.
    const getResponse = await fetch(`${runtime.adminUrl}/api/reports/${report.id}/content`);
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).html, originalHtml);

    // PUT content edits in place via a working copy.
    const editedHtml = "<h1>Edited in Pagecast</h1>";
    const putResponse = await fetch(`${runtime.adminUrl}/api/reports/${report.id}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: editedHtml })
    });
    assert.equal(putResponse.status, 200);
    const putData = await putResponse.json();
    assert.equal(putData.report.sourceMode, "edited-in-pagecast");

    // Original source file is byte-for-byte unchanged.
    assert.equal(await fs.readFile(reportPath, "utf8"), originalHtml);
    // Working copy reflects the edit.
    const workingIndex = path.join(dataDir, "working", report.id, "index.html");
    assert.equal(await fs.readFile(workingIndex, "utf8"), editedHtml);

    // A subsequent snapshot stages from the working copy.
    const publication = await publishSnapshot(runtime.adminUrl, report.id);
    const stagedIndex = path.join(dataDir, "pages-site", "p", publication.slug, "index.html");
    assert.equal(await fs.readFile(stagedIndex, "utf8"), editedHtml);
  } finally {
    await runtime.close();
  }
});

test("editing content with an active snapshot pushes the edit live via the same URL", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, "<h1>v0</h1>");

  const { fakeDeploy, state } = makeInstrumentedDeploy();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: fakeDeploy,
    pagesDeployTimeoutMs: 1000
  });

  try {
    await configurePages(runtime.adminUrl);
    const report = await addPathReport(runtime.adminUrl, reportPath);
    const publication = await publishSnapshot(runtime.adminUrl, report.id);
    assert.equal(state.deployCount, 1);

    const putResponse = await fetch(`${runtime.adminUrl}/api/reports/${report.id}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<h1>v1 edited</h1>" })
    });
    assert.equal(putResponse.status, 200);
    assert.equal(state.deployCount, 2, "editing with an active snapshot redeploys");

    const stagedIndex = path.join(dataDir, "pages-site", "p", publication.slug, "index.html");
    assert.match(await fs.readFile(stagedIndex, "utf8"), /v1 edited/);
  } finally {
    await runtime.close();
  }
});

// --- 1g: auto-sync watcher (real fs.watch) --------------------------------

test("auto-sync redeploys on source change and stops when toggled off", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, "<h1>watch-0</h1>");

  const { fakeDeploy, state } = makeInstrumentedDeploy();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: fakeDeploy,
    pagesDeployTimeoutMs: 1000
  });

  try {
    await configurePages(runtime.adminUrl);
    const report = await addPathReport(runtime.adminUrl, reportPath);
    await publishSnapshot(runtime.adminUrl, report.id);
    const baseline = state.deployCount;

    const enableResponse = await fetch(`${runtime.adminUrl}/api/reports/${report.id}/auto-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(enableResponse.status, 200);
    assert.equal((await enableResponse.json()).report.autoSync, true);

    // Write the source; poll until the watcher fires a deploy.
    await fs.writeFile(reportPath, "<h1>watch-1</h1>");
    const fired = await pollUntil(() => state.deployCount > baseline, { timeoutMs: 6000 });
    assert.ok(fired, "auto-sync should redeploy after a source change");
    const afterFirstChange = state.deployCount;

    // Toggle off; further changes must not deploy.
    const disableResponse = await fetch(`${runtime.adminUrl}/api/reports/${report.id}/auto-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disableResponse.status, 200);
    assert.equal((await disableResponse.json()).report.autoSync, false);

    await fs.writeFile(reportPath, "<h1>watch-2</h1>");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(state.deployCount, afterFirstChange, "no deploy should fire after disabling");

    // Deleting the source must not crash the server.
    await fs.rm(reportPath, { force: true });
    const healthz = await fetch(`${runtime.publicUrl}/healthz`);
    assert.equal(healthz.status, 200);
  } finally {
    await runtime.close();
  }
});

test("two auto-sync reports never deploy concurrently", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const dirA = path.join(tempDir, "a");
  const dirB = path.join(tempDir, "b");
  await fs.mkdir(dirA, { recursive: true });
  await fs.mkdir(dirB, { recursive: true });
  const pathA = path.join(dirA, "a.html");
  const pathB = path.join(dirB, "b.html");
  await fs.writeFile(pathA, "<h1>a0</h1>");
  await fs.writeFile(pathB, "<h1>b0</h1>");

  const { fakeDeploy, state } = makeInstrumentedDeploy({ delayMs: 40 });
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: fakeDeploy,
    pagesDeployTimeoutMs: 2000
  });

  try {
    await configurePages(runtime.adminUrl);
    const reportA = await addPathReport(runtime.adminUrl, pathA);
    const reportB = await addPathReport(runtime.adminUrl, pathB);
    await publishSnapshot(runtime.adminUrl, reportA.id);
    await publishSnapshot(runtime.adminUrl, reportB.id);

    for (const id of [reportA.id, reportB.id]) {
      const response = await fetch(`${runtime.adminUrl}/api/reports/${id}/auto-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true })
      });
      assert.equal(response.status, 200);
    }

    const baseline = state.deployCount;
    // Mutate both sources nearly simultaneously.
    await fs.writeFile(pathA, "<h1>a1</h1>");
    await fs.writeFile(pathB, "<h1>b1</h1>");

    const fired = await pollUntil(() => state.deployCount >= baseline + 2, { timeoutMs: 8000 });
    assert.ok(fired, "both watchers should have deployed");
    assert.equal(state.maxConcurrent, 1, "deploys must never overlap");
  } finally {
    await runtime.close();
  }
});

// --- 1h: drag reorder -----------------------------------------------------

test("reorder respects ids, appends new reports, and rejects unknown ids", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });

  try {
    const paths = [];
    for (let i = 0; i < 3; i += 1) {
      const dir = path.join(tempDir, `r${i}`);
      await fs.mkdir(dir, { recursive: true });
      const p = path.join(dir, `r${i}.html`);
      await fs.writeFile(p, `<h1>r${i}</h1>`);
      paths.push(p);
    }
    const reports = [];
    for (const p of paths) {
      reports.push(await addPathReport(runtime.adminUrl, p));
    }
    const [a, b, c] = reports;

    // Reorder to [c, a] -> b should trail after the listed ones.
    const reorderResponse = await fetch(`${runtime.adminUrl}/api/reports/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [c.id, a.id] })
    });
    assert.equal(reorderResponse.status, 200);
    const ordered = (await reorderResponse.json()).reports.map((r) => r.id);
    assert.deepEqual(ordered, [c.id, a.id, b.id]);

    // A newly added report appends last.
    const newReport = await addPathReport(runtime.adminUrl, paths[0]);
    const listResponse = await fetch(`${runtime.adminUrl}/api/reports`);
    const listIds = (await listResponse.json()).reports.map((r) => r.id);
    assert.equal(listIds[listIds.length - 1], newReport.id);

    // Unknown id -> 400.
    const badResponse = await fetch(`${runtime.adminUrl}/api/reports/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["does-not-exist"] })
    });
    assert.equal(badResponse.status, 400);
  } finally {
    await runtime.close();
  }
});

// --- 1a: v2 -> v3 migration -----------------------------------------------

test("legacy version-2 reports.json migrates to v3 with backfilled fields", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "legacy");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "legacy.html");
  await fs.writeFile(reportPath, "<h1>Legacy</h1>");
  await fs.mkdir(dataDir, { recursive: true });

  const legacyToken = "legacy-aaaaaaaa";
  const legacyState = {
    version: 2,
    reports: [
      {
        id: "legacy-report-1",
        kind: "path",
        name: "legacy.html",
        sourcePath: reportPath,
        rootDir: reportDir,
        entryFile: "legacy.html",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        publications: [
          {
            token: legacyToken,
            label: "legacy",
            kind: "snapshot",
            publicUrl: `https://team-reports.pages.dev/p/${legacyToken}/`,
            createdAt: "2020-01-02T00:00:00.000Z",
            revokedAt: null
          }
        ]
      }
    ]
  };
  await fs.writeFile(
    path.join(dataDir, "reports.json"),
    `${JSON.stringify(legacyState, null, 2)}\n`,
    "utf8"
  );

  const store = createReportStore({ dataDir });
  await store.init();

  const reports = store.list();
  assert.equal(reports.length, 1);
  const report = reports[0];
  // Backfilled report fields.
  assert.equal(report.autoSync, false);
  assert.equal(report.sourceMode, "source-tracked");
  assert.equal(typeof report.order, "number");

  const publication = report.publications[0];
  // slug backfills to token.
  assert.equal(publication.slug, legacyToken);
  assert.equal(publication.updatedAt, publication.createdAt);

  // Force a save via a no-op mutation to confirm v3 is written to disk.
  await store.reorder([report.id]);
  const reSaved = JSON.parse(await fs.readFile(path.join(dataDir, "reports.json"), "utf8"));
  assert.equal(reSaved.version, 3);
  assert.ok(Array.isArray(reSaved.redirects));

  // The slug (== token) still resolves through the public asset resolver.
  const resolved = await store.resolvePublishedAsset(legacyToken, "");
  assert.equal(resolved.statusCode, 200);
});

// --- Markdown rendering (zero-dependency vendored renderer) ----------------

test("markdown renderer covers the common subset and is security-hardened", () => {
  // Headings.
  assert.match(renderMarkdownBody("# Title"), /<h1>Title<\/h1>/);
  assert.match(renderMarkdownBody("### Sub"), /<h3>Sub<\/h3>/);

  // Bold and italic.
  assert.match(renderMarkdownBody("**bold**"), /<strong>bold<\/strong>/);
  assert.match(renderMarkdownBody("__bold__"), /<strong>bold<\/strong>/);
  assert.match(renderMarkdownBody("*ital*"), /<em>ital<\/em>/);
  assert.match(renderMarkdownBody("_ital_"), /<em>ital<\/em>/);

  // Inline code (escaped).
  const inlineCode = renderMarkdownBody("Use `a < b` now");
  assert.match(inlineCode, /<code>a &lt; b<\/code>/);

  // Fenced code block with language class, contents escaped.
  const fenced = renderMarkdownBody("```js\nconst x = 1 < 2;\n```");
  assert.match(fenced, /<pre><code class="language-js">const x = 1 &lt; 2;<\/code><\/pre>/);

  // A list.
  const list = renderMarkdownBody("- one\n- two");
  assert.match(list, /<ul><li>one<\/li><li>two<\/li><\/ul>/);

  // A link.
  assert.match(
    renderMarkdownBody("[site](https://example.com)"),
    /<a href="https:\/\/example\.com">site<\/a>/
  );

  // An image.
  assert.match(
    renderMarkdownBody("![alt text](https://img.example/x.png)"),
    /<img src="https:\/\/img\.example\/x\.png" alt="alt text">/
  );

  // ESCAPING: a <script> in the source must appear escaped, NOT as a live tag.
  const escaped = renderMarkdownBody("Hello <script>alert(1)</script>");
  assert.match(escaped, /&lt;script&gt;/);
  assert.doesNotMatch(escaped, /<script>/);

  // SECURITY: a javascript: link is neutralized (never emitted as href).
  const jsLink = renderMarkdownBody("[click](javascript:alert(1))");
  assert.doesNotMatch(jsLink, /href="javascript:/);
  assert.match(jsLink, /<a href="#">click<\/a>/);
});

test("markdownToHtml wraps body in a complete self-contained document", () => {
  const doc = markdownToHtml("# Heading\n\nSome **text**.", { title: "My Report" });
  assert.match(doc, /^<!doctype html>/i);
  assert.match(doc, /<meta charset="utf-8">/);
  assert.match(doc, /<title>My Report<\/title>/);
  assert.match(doc, /<style>/);
  assert.match(doc, /<h1>Heading<\/h1>/);
  assert.match(doc, /<strong>text<\/strong>/);

  // Title is escaped to prevent markup injection via the report name.
  const injected = markdownToHtml("# x", { title: "A & B <script>" });
  assert.match(injected, /<title>A &amp; B &lt;script&gt;<\/title>/);
  assert.doesNotMatch(injected, /<title>A & B <script>/);

  // Never throws on malformed input.
  assert.equal(typeof markdownToHtml(null), "string");
  assert.equal(typeof markdownToHtml(undefined, {}), "string");
});

test("markdown path report previews as rendered HTML in memory", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "notes.md");
  await fs.writeFile(reportPath, "# Hello\n\nThis is **markdown**.\n");

  const store = createReportStore({ dataDir });
  await store.init();
  const report = await store.addPath(reportPath);
  assert.equal(report.entryFile, "notes.md");

  // The entry resolves as an in-memory rendered HTML body (not a streamed file).
  const entry = await store.resolveAsset(report.id, "");
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.contentType, "text/html; charset=utf-8");
  assert.equal(typeof entry.body, "string");
  assert.match(entry.body, /<h1>Hello<\/h1>/);
  assert.match(entry.body, /<strong>markdown<\/strong>/);
  assert.match(entry.body, /^<!doctype html>/i);
});

test("markdown path report previews as rendered HTML over HTTP", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "doc.markdown");
  await fs.writeFile(reportPath, "# Live Preview\n\nrendered via the route.\n");

  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });

  try {
    const report = await addPathReport(runtime.adminUrl, reportPath);
    const response = await fetch(`${runtime.adminUrl}/preview/${report.id}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    const html = await response.text();
    assert.match(html, /<h1>Live Preview<\/h1>/);
    assert.doesNotMatch(html, /^# Live Preview/);
  } finally {
    await runtime.close();
  }
});

test("publishing a markdown report stages rendered HTML, not raw markdown", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "release.md");
  await fs.writeFile(reportPath, "# Release Notes\n\nShipped **v2** today.\n");

  const { fakeDeploy } = makeInstrumentedDeploy();
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    pagesDeploySpawnImpl: fakeDeploy,
    pagesDeployTimeoutMs: 1000
  });

  try {
    await configurePages(runtime.adminUrl);
    const report = await addPathReport(runtime.adminUrl, reportPath);
    const publication = await publishSnapshot(runtime.adminUrl, report.id);

    const stagedIndex = path.join(dataDir, "pages-site", "p", publication.slug, "index.html");
    const staged = await fs.readFile(stagedIndex, "utf8");
    // Staged index.html is the RENDERED markdown, not the raw .md source.
    assert.match(staged, /^<!doctype html>/i);
    assert.match(staged, /<h1>Release Notes<\/h1>/);
    assert.match(staged, /<strong>v2<\/strong>/);
    assert.doesNotMatch(staged, /# Release Notes/);
  } finally {
    await runtime.close();
  }
});

test("markdown uploads are accepted and stored as raw markdown", async () => {
  const tempDir = await makeTempDir();
  const store = createReportStore({ dataDir: path.join(tempDir, "data") });
  await store.init();

  const report = await store.addUpload({
    filename: "dropped.md",
    content: Buffer.from("# Uploaded\n\nfrom a **drop**.\n")
  });
  // Markdown uploads keep a raw .md entry so rendering is driven by extension.
  assert.equal(report.entryFile, "index.md");

  const entry = await store.resolveAsset(report.id, "");
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.contentType, "text/html; charset=utf-8");
  assert.match(entry.body, /<h1>Uploaded<\/h1>/);
  assert.match(entry.body, /<strong>drop<\/strong>/);
});
