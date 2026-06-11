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
  createCloudflareAuthManager,
  createConfigStore,
  createDeployQueue,
  createReportStore,
  findKvNamespaceId,
  getGoalStatus,
  injectBadge,
  injectFeedbackWidget,
  parseKvNamespaceId,
  parseWorkerDevUrl,
  publishGoalProgress,
  stopGoalProgress,
  deployCloudflarePagesSite,
  extractPublicUrl,
  isLoopbackHostHeader,
  listCloudflarePagesProjects,
  localHtmlPathCandidates,
  normalizeAssetRequestPath,
  normalizeLocalFolderPath,
  normalizeLocalHtmlPath,
  parseMultipartFiles,
  parseWranglerPagesProjects,
  parseWranglerWhoamiAccounts,
  parseMultipartUpload,
  publishReportSnapshot,
  setupCloudflarePages,
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
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-test-"));
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

test("sibling asset that is a symlink escaping the report root is rejected", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "index.html"), "<h1>Report</h1>");

  // A secret outside the report folder, and a symlink inside it pointing at the
  // secret. The lexical path of the symlink IS inside the root, so only a
  // realpath-based guard catches the escape.
  const secretPath = path.join(tempDir, "secret.txt");
  await fs.writeFile(secretPath, "TOP SECRET");
  const linkPath = path.join(reportDir, "leak.txt");
  try {
    await fs.symlink(secretPath, linkPath);
  } catch {
    return; // Platform without symlink support — nothing to assert.
  }

  const store = createReportStore({ dataDir });
  await store.init();
  const report = await store.addPath(path.join(reportDir, "index.html"));

  const leaked = await store.resolveAsset(report.id, "leak.txt");
  assert.equal(leaked.statusCode, 403, "symlink escaping the report root must be blocked");

  // A symlink that stays inside the root is still served.
  const innerTarget = path.join(reportDir, "real.css");
  await fs.writeFile(innerTarget, "body{}");
  await fs.symlink(innerTarget, path.join(reportDir, "alias.css"));
  const inner = await store.resolveAsset(report.id, "alias.css");
  assert.equal(inner.statusCode, 200, "in-root symlink should still resolve");
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

test("folder reports resolve static mini-app assets", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const appDir = path.join(tempDir, "mini-app");
  await fs.mkdir(path.join(appDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(appDir, "index.html"), '<script src="assets/app.js"></script><h1>Mini</h1>');
  await fs.writeFile(path.join(appDir, "assets", "app.js"), "window.ready = true;");
  await fs.writeFile(path.join(appDir, ".env"), "SECRET=1");

  assert.equal(await normalizeLocalFolderPath(appDir), appDir);

  const store = createReportStore({ dataDir });
  await store.init();
  const report = await store.addFolder({ folderPath: appDir });

  const entry = await store.resolveAsset(report.id, "");
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.filePath, path.join(appDir, "index.html"));

  const asset = await store.resolveAsset(report.id, "assets/app.js");
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.filePath, path.join(appDir, "assets", "app.js"));

  const hidden = await store.resolveAsset(report.id, ".env");
  assert.equal(hidden.statusCode, 403);
});

test("folder reports run build commands and publish detected output", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const appDir = path.join(tempDir, "source-app");
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(appDir, "build.sh"), "mkdir -p dist && printf '<h1>Built</h1>' > dist/index.html\n");

  const store = createReportStore({ dataDir });
  await store.init();
  const report = await store.addFolder({
    folderPath: appDir,
    buildCommand: "sh build.sh",
    buildOutputDir: "dist"
  });

  const built = await store.buildReport(report.id);
  assert.equal(built.buildStatus, "ready");
  assert.equal(built.buildOutputDir, "dist");

  const entry = await store.resolveAsset(report.id, "");
  assert.equal(entry.statusCode, 200);
  assert.match(await fs.readFile(entry.filePath, "utf8"), /Built/);
});

test("folder multipart uploads preserve relative paths and reject unsafe files", async () => {
  const boundary = "folder-boundary";
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="mini/index.html"',
      "Content-Type: text/html",
      "",
      "<h1>Folder</h1>",
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="mini/assets/app.js"',
      "Content-Type: text/javascript",
      "",
      "window.ready = true;",
      `--${boundary}--`,
      ""
    ].join("\r\n"),
    "utf8"
  );

  const files = parseMultipartFiles(body, `multipart/form-data; boundary=${boundary}`);
  const tempDir = await makeTempDir();
  const store = createReportStore({ dataDir: path.join(tempDir, "data") });
  await store.init();
  const report = await store.addFolderUpload({ files, name: "mini" });

  const asset = await store.resolveAsset(report.id, "assets/app.js");
  assert.equal(asset.statusCode, 200);

  await assert.rejects(
    () =>
      store.addFolderUpload({
        files: [{ filename: "../secret.html", content: Buffer.from("nope") }]
      }),
    /unsafe/
  );
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
      "Available on the internet:\n|-- https://pagecast.example.ts.net\n|--> http://127.0.0.1:4174"
    ),
    "https://pagecast.example.ts.net"
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
          project_name: "pagecast",
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
      name: "pagecast",
      accountId: "abcdef0123456789abcdef0123456789",
      accountName: "Personal",
      productionBranch: "",
      baseUrl: "https://pagecast.pages.dev"
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
  assert.equal(chooseWranglerPagesProject(projects, {}).name, "pagecast");

  assert.deepEqual(
    parseWranglerPagesProjects(
      [
        "┌───────────────┬───────────────────┐",
        "│ Name          │ Production Branch │",
        "├───────────────┼───────────────────┤",
        "│ team-reports  │ main              │",
        "│ pagecast │ production        │",
        "└───────────────┴───────────────────┘"
      ].join("\n")
    ),
    [
      {
        name: "pagecast",
        accountId: "",
        accountName: "",
        productionBranch: "production",
        baseUrl: "https://pagecast.pages.dev"
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
                name: "pagecast",
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
    assert.equal(data.cloudflare.selectedProject.name, "pagecast");
    assert.equal(data.config.pages.projectName, "pagecast");
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
            "│ pagecast │ production        │",
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
        projectName: "pagecast",
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
    assert.equal(data.cloudflare.selectedProject.name, "pagecast");
    assert.equal(data.config.pages.projectName, "pagecast");
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
  function fakePagesDeploy(command, args, options) {
    deployCommands.push({ command, args, accountId: options?.env?.CLOUDFLARE_ACCOUNT_ID || "" });
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
      "main"
    ]);
    // The account is passed via CLOUDFLARE_ACCOUNT_ID env, not an --account-id
    // flag (which `wrangler pages deploy` does not accept).
    assert.equal(deployCommands[0].accountId, "0123456789abcdef0123456789abcdef");

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
    assert.equal(publishV1Response.status, 410);
    assert.match(await publishV1Response.text(), /Local live publishing has been removed/);
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
      return { code: 0, output: "✨ Successfully created the 'pagecast' project." };
    }
    if (args.includes("list")) {
      return {
        code: 0,
        output: created
          ? JSON.stringify([
              { name: "pagecast", account_id: "abcdef0123456789abcdef0123456789" }
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
    assert.equal(data.cloudflare.account.name, "Personal");
    assert.equal(data.cloudflare.selectedProject.name, "pagecast");
    assert.equal(data.config.pages.accountId, "abcdef0123456789abcdef0123456789");
    assert.equal(data.config.pages.accountName, "Personal");

    // The project create command actually ran with the resolved account.
    const createCall = captured.find((item) => item.args.includes("create"));
    assert.ok(createCall, "expected a pages project create call");
    assert.equal(createCall.accountId, "abcdef0123456789abcdef0123456789");

    // /api/status now reflects the logged-in session without re-spawning.
    const statusResponse = await fetch(`${runtime.adminUrl}/api/status`);
    const status = await statusResponse.json();
    assert.equal(status.cloudflare.loggedIn, true);
    assert.equal(status.cloudflare.accountName, "Personal");
    assert.equal(status.cloudflare.projectName, "pagecast");
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
          { name: "pagecast", account_id: "abcdef0123456789abcdef0123456789" }
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

  assert.match(result.url, /^https:\/\/pagecast\.pages\.dev\/p\/.+\/$/);
  assert.equal(result.projectName, "pagecast");
  assert.ok(deployCommands.length >= 1, "expected a Pages deploy");
});

test("Headless Pages site deploy wraps Wrangler with project, branch, and account env", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const siteDir = path.join(tempDir, "site");
  await fs.mkdir(path.join(siteDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(siteDir, "index.html"), "<h1>Site</h1>");
  await fs.writeFile(path.join(siteDir, "assets", "app.js"), "window.ok = true;");
  await fs.writeFile(path.join(siteDir, ".env"), "SECRET=1");

  const accountId = "90e4c638bea527f464ec6fa7caebfd4e";
  const { fakeSpawn: authSpawn } = makeWranglerFake((args) => {
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({
          accounts: [{ name: "Pagecast", id: accountId }]
        })
      };
    }
    if (args.includes("list")) {
      return {
        code: 0,
        output: JSON.stringify([
          { name: "pagecasthq", account_id: accountId, production_branch: "main" }
        ])
      };
    }
    return { code: 0, output: "" };
  });

  const deployCommands = [];
  function fakeDeploy(command, args, options) {
    deployCommands.push({ command, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID || "" });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from("Deployment complete: https://7a52d6ea.pagecasthq.pages.dev")
      );
      child.emit("exit", 0, null);
    });
    return child;
  }

  const result = await deployCloudflarePagesSite({
    sourceDir: siteDir,
    projectName: "pagecasthq",
    accountId,
    branch: "main",
    dataDir,
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: fakeDeploy,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  });

  const stagingRoot = path.join(dataDir, "pages-deploy", "pagecasthq");
  assert.equal(result.url, "https://pagecasthq.pages.dev");
  assert.equal(result.deploymentUrl, "https://7a52d6ea.pagecasthq.pages.dev");
  assert.equal(result.projectName, "pagecasthq");
  assert.equal(result.accountId, accountId);
  assert.equal(result.branch, "main");
  assert.deepEqual(deployCommands, [
    {
      command: "npx",
      args: [
        "--yes",
        "wrangler",
        "pages",
        "deploy",
        stagingRoot,
        "--project-name",
        "pagecasthq",
        "--branch",
        "main"
      ],
      accountId
    }
  ]);
  assert.equal(await fs.readFile(path.join(stagingRoot, "index.html"), "utf8"), "<h1>Site</h1>");
  assert.equal(await fs.readFile(path.join(stagingRoot, "assets", "app.js"), "utf8"), "window.ok = true;");
  await assert.rejects(() => fs.stat(path.join(stagingRoot, ".env")), /ENOENT/);
});

test("Headless Pages site deploy defaults to the main branch when omitted", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const siteDir = path.join(tempDir, "site");
  await fs.mkdir(siteDir, { recursive: true });
  await fs.writeFile(path.join(siteDir, "index.html"), "<h1>No branch</h1>");

  const accountId = "90e4c638bea527f464ec6fa7caebfd4e";
  const { fakeSpawn: authSpawn } = makeWranglerFake((args) => {
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({ accounts: [{ name: "Pagecast", id: accountId }] })
      };
    }
    if (args.includes("list")) {
      return {
        code: 0,
        output: JSON.stringify([{ name: "pagecasthq", account_id: accountId }])
      };
    }
    return { code: 0, output: "" };
  });

  const deployCommands = [];
  function fakeDeploy(command, args, options) {
    deployCommands.push({ command, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID || "" });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("Deployment complete"));
      child.emit("exit", 0, null);
    });
    return child;
  }

  const result = await deployCloudflarePagesSite({
    sourceDir: siteDir,
    projectName: "pagecasthq",
    accountId,
    dataDir,
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: fakeDeploy,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  });

  assert.equal(result.branch, "main");
  assert.deepEqual(deployCommands[0].args.slice(-2), ["--branch", "main"]);
});

test("Headless Pages setup logs in and creates the requested Pages project", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const accountId = "90e4c638bea527f464ec6fa7caebfd4e";
  let loggedIn = false;
  let created = false;

  const { fakeSpawn, captured } = makeWranglerFake((args) => {
    if (args.includes("login")) {
      loggedIn = true;
      return { code: 0, output: "Successfully logged in" };
    }
    if (args.includes("whoami")) {
      return loggedIn
        ? {
            code: 0,
            output: JSON.stringify({ accounts: [{ name: "Pagecast", id: accountId }] })
          }
        : { code: 0, output: "You are not authenticated." };
    }
    if (args.includes("create")) {
      created = true;
      return { code: 0, output: "Created pagecasthq" };
    }
    if (args.includes("list")) {
      return {
        code: 0,
        output: created
          ? JSON.stringify([{ name: "pagecasthq", account_id: accountId }])
          : JSON.stringify([])
      };
    }
    return { code: 0, output: "" };
  });

  const result = await setupCloudflarePages({
    projectName: "pagecasthq",
    accountId,
    branch: "production",
    dataDir,
    cloudflareAuthSpawnImpl: fakeSpawn,
    cloudflareListTimeoutMs: 1000
  });

  assert.equal(result.cloudflare.authenticated, true);
  assert.equal(result.cloudflare.autoCreated, true);
  assert.equal(result.config.pages.projectName, "pagecasthq");
  assert.equal(result.config.pages.accountId, accountId);

  const createCall = captured.find((item) => item.args.includes("create"));
  assert.ok(createCall, "expected setup to create the requested Pages project");
  assert.equal(createCall.accountId, accountId);
  assert.deepEqual(createCall.args, [
    "--yes",
    "wrangler",
    "pages",
    "project",
    "create",
    "pagecasthq",
    "--production-branch",
    "production"
  ]);
});

test("Headless Pages project list uses the selected Cloudflare account", async () => {
  const tempDir = await makeTempDir();
  const accountId = "90e4c638bea527f464ec6fa7caebfd4e";
  const { fakeSpawn, captured } = makeWranglerFake((args) => {
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({ accounts: [{ name: "Pagecast", id: accountId }] })
      };
    }
    if (args.includes("list")) {
      return {
        code: 0,
        output: JSON.stringify([
          { name: "pagecasthq", account_id: accountId, production_branch: "main" }
        ])
      };
    }
    return { code: 0, output: "" };
  });

  const result = await listCloudflarePagesProjects({
    accountId,
    dataDir: path.join(tempDir, "data"),
    cloudflareAuthSpawnImpl: fakeSpawn,
    cloudflareListTimeoutMs: 1000
  });

  assert.equal(result.accountId, accountId);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].name, "pagecasthq");
  assert.equal(captured.find((item) => item.args.includes("list")).accountId, accountId);
});

test("Publish uses the REAL Cloudflare subdomain from the deploy output (name collision)", async () => {
  // When the <project>.pages.dev subdomain is globally taken, Cloudflare assigns
  // a suffixed one (e.g. pagecast-6cv.pages.dev). The published URL must use the
  // real subdomain from the deploy output, not the assumed <project>.pages.dev.
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await fs.writeFile(reportPath, "<h1>Collision</h1>");

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
          { name: "pagecast", account_id: "abcdef0123456789abcdef0123456789" }
        ])
      };
    }
    return { code: 0, output: "" };
  });

  function fakeDeploy() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          "✨ Deployment complete! Take a peek over at https://7a52d6ea.pagecast-6cv.pages.dev"
        )
      );
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

  assert.match(result.url, /^https:\/\/pagecast-6cv\.pages\.dev\/p\/.+\/$/);
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

test("Cloudflare connect detects an existing session when wrangler lacks --json (exits 1 with help)", async () => {
  // Regression: wrangler 4.63.0 exits 1 and prints a help screen for
  // `whoami --json` / `pages project list --json` (no clean "Unknown argument").
  // The app must fall back to the text commands and NOT trigger a re-login.
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const HELP = "wrangler whoami\nList your stuff\nGLOBAL FLAGS\n  -h, --help  Show help  [boolean]\n";
  const whoamiTable = [
    "👋 You are logged in with an OAuth Token.",
    "┌──────────────┬──────────────────────────────────┐",
    "│ Account Name │ Account ID                       │",
    "├──────────────┼──────────────────────────────────┤",
    "│ Personal     │ abcdef0123456789abcdef0123456789 │",
    "└──────────────┴──────────────────────────────────┘"
  ].join("\n");
  const projectTable = [
    "┌───────────────┬───────────────────┐",
    "│ Name          │ Production Branch │",
    "├───────────────┼───────────────────┤",
    "│ pagecast │ main              │",
    "└───────────────┴───────────────────┘"
  ].join("\n");

  const { fakeSpawn, captured } = makeWranglerFake((args) => {
    if (args.includes("login")) {
      return { code: 0, output: "Successfully logged in" };
    }
    if (args.includes("whoami")) {
      return args.includes("--json")
        ? { code: 1, output: HELP, stderr: true }
        : { code: 0, output: whoamiTable };
    }
    if (args.includes("list")) {
      return args.includes("--json")
        ? { code: 1, output: HELP, stderr: true }
        : { code: 0, output: projectTable };
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
    assert.equal(data.cloudflare.account.id, "abcdef0123456789abcdef0123456789");
    assert.equal(data.cloudflare.selectedProject.name, "pagecast");
    // The critical regression assertion: no re-login was attempted.
    assert.ok(
      !captured.some((item) => item.args.includes("login")),
      "expected NO wrangler login call when already signed in"
    );
  } finally {
    await runtime.close();
  }
});

test("Cloudflare logout clears selected account and session cache", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const { fakeSpawn, captured } = makeWranglerFake((args) => {
    if (args.includes("logout")) {
      return { code: 0, output: "Logged out" };
    }
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({
          accounts: [
            {
              id: "abcdef0123456789abcdef0123456789",
              name: "Personal"
            }
          ]
        })
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
    cloudflareListTimeoutMs: 1000
  });

  try {
    const configResponse = await fetch(`${runtime.adminUrl}/api/config/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName: "pagecast",
        accountId: "abcdef0123456789abcdef0123456789"
      })
    });
    assert.equal(configResponse.status, 200);

    const logoutResponse = await fetch(`${runtime.adminUrl}/api/cloudflare/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(logoutResponse.status, 200);
    assert.ok(captured.some((item) => item.args.includes("logout")));

    const statusResponse = await fetch(`${runtime.adminUrl}/api/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.config.pages.accountId, "");
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

    // A subsequent snapshot stages from the working copy (plus the injected badge).
    const publication = await publishSnapshot(runtime.adminUrl, report.id);
    const stagedIndex = path.join(dataDir, "pages-site", "p", publication.slug, "index.html");
    const staged = await fs.readFile(stagedIndex, "utf8");
    assert.ok(staged.includes(editedHtml), "staged content reflects the working-copy edit");
    assert.match(staged, /data-pagecast-badge/);
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

    // A newly added (distinct) report appends last.
    const extraDir = path.join(tempDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    const extraPath = path.join(extraDir, "extra.html");
    await fs.writeFile(extraPath, "<h1>extra</h1>");
    const newReport = await addPathReport(runtime.adminUrl, extraPath);
    const listResponse = await fetch(`${runtime.adminUrl}/api/reports`);
    const listIds = (await listResponse.json()).reports.map((r) => r.id);
    assert.equal(listIds[listIds.length - 1], newReport.id);

    // Re-adding an already-tracked path reuses the existing report — no duplicate.
    const dup = await addPathReport(runtime.adminUrl, paths[0]);
    assert.equal(dup.id, a.id);
    const afterDup = (await (await fetch(`${runtime.adminUrl}/api/reports`)).json()).reports;
    assert.equal(afterDup.length, listIds.length, "re-adding a path must not add a row");

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

test("markdown renderer never passes raw author HTML through as live markup", () => {
  // Regression for the raw-<img>/<a> passthrough XSS: literal HTML typed in the
  // source must be escaped, never emitted as an executable tag, in every block
  // context (paragraph, heading, list item). Published markdown pages are PUBLIC.
  const vectors = [
    "<img src=x onerror=alert(document.domain)>",
    "# <img src=x onerror=alert(1)>",
    "- <img src=x onerror=alert(1)>",
    "> <img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    "<svg onload=alert(1)>",
    "<iframe src=javascript:alert(1)>"
  ];
  for (const vector of vectors) {
    const out = renderMarkdownBody(vector);
    // No live HTML tag may appear: the author's literal "<" must be escaped to
    // "&lt;". (The escaped text may still contain inert substrings like
    // "onerror=" — that is harmless; what matters is it is not a real tag.)
    assert.doesNotMatch(out, /<(?:img|svg|iframe|script|a )/i, `live tag survived for: ${vector}`);
    assert.match(out, /&lt;/, `expected escaped output for: ${vector}`);
  }

  // Emphasis must still apply across a link (previously dropped).
  assert.match(
    renderMarkdownBody("**a [b](https://x) c**"),
    /<strong>a <a href="https:\/\/x">b<\/a> c<\/strong>/
  );

  // The full document carries a script-blocking CSP as defense in depth.
  assert.match(
    markdownToHtml("# hi"),
    /<meta http-equiv="Content-Security-Policy"[^>]*script/i
  );
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

test("isLoopbackHostHeader allows loopback and rejects rebound foreign hosts", () => {
  // Allowed: the real admin UI and CLI talk to loopback names/IPs.
  for (const ok of [
    "127.0.0.1:4173",
    "127.0.0.1",
    "localhost:4173",
    "localhost",
    "[::1]:4173",
    "::1",
    "127.5.5.5:80",
    undefined,
    ""
  ]) {
    assert.equal(isLoopbackHostHeader(ok, "127.0.0.1"), true, `expected allow: ${ok}`);
  }
  // Rejected: a DNS-rebinding page sends its own domain as Host.
  for (const bad of [
    "evil.example",
    "evil.example:4173",
    "attacker.com",
    "169.254.169.254",
    "192.168.1.50:4173"
  ]) {
    assert.equal(isLoopbackHostHeader(bad, "127.0.0.1"), false, `expected reject: ${bad}`);
  }
  // An explicitly configured bind host is trusted.
  assert.equal(isLoopbackHostHeader("0.0.0.0:4173", "0.0.0.0"), true);
});

test("admin server rejects requests with a non-loopback Host header (DNS rebinding)", async () => {
  const { request } = await import("node:http");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-host-"));
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });

  const callWithHost = (hostHeader) =>
    new Promise((resolve, reject) => {
      const port = runtime.adminServer.address().port;
      const req = request(
        { host: "127.0.0.1", port, path: "/api/status", method: "GET", headers: { Host: hostHeader } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });

  try {
    // A rebound attacker domain is blocked before reaching any handler.
    assert.equal(await callWithHost("evil.example"), 403);
    // The legitimate loopback Host is served normally.
    assert.notEqual(await callWithHost("127.0.0.1"), 403);
  } finally {
    await runtime.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("injectFeedbackWidget adds the widget script before </body> exactly once", () => {
  const html = "<!doctype html><html><head></head><body><h1>Report</h1></body></html>";
  const out = injectFeedbackWidget(html, { url: "https://fb.example.workers.dev", slug: "q3" });
  assert.match(
    out,
    /<script src="https:\/\/fb\.example\.workers\.dev\/widget\.js" data-slug="q3" defer><\/script>\s*<\/body>/
  );
  // Idempotent: re-injecting the same widget does not duplicate it.
  const twice = injectFeedbackWidget(out, { url: "https://fb.example.workers.dev", slug: "q3" });
  assert.equal((twice.match(/widget\.js/g) || []).length, 1);
});

test("injectFeedbackWidget appends when there is no </body>, and is a no-op without config", () => {
  const fragment = "<h1>Bare</h1>";
  assert.match(
    injectFeedbackWidget(fragment, { url: "https://fb.workers.dev", slug: "x" }),
    /<h1>Bare<\/h1>\s*<script[^>]*\/widget\.js[^>]*><\/script>/
  );
  // No url or no slug -> unchanged.
  assert.equal(injectFeedbackWidget(fragment, { url: "", slug: "x" }), fragment);
  assert.equal(injectFeedbackWidget(fragment, { url: "https://fb.workers.dev", slug: "" }), fragment);
  assert.equal(injectFeedbackWidget(fragment, {}), fragment);
});

test("injectFeedbackWidget escapes url/slug into the attributes", () => {
  const out = injectFeedbackWidget("<body></body>", {
    url: 'https://e.dev/"><img onerror=1>',
    slug: 'a"b'
  });
  assert.doesNotMatch(out, /onerror=1>/); // the raw breakout is escaped
  assert.match(out, /&quot;/);
});

test("config store persists and clears feedback settings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-cfg-"));
  const store = createConfigStore({ dataDir: dir });
  await store.init();

  assert.equal(store.get().feedback, null);

  const updated = await store.updateFeedback({
    url: "https://pagecast-feedback.acme.workers.dev/",
    statsToken: "secret",
    workerName: "pagecast-feedback",
    kvId: "abc123"
  });
  // Trailing slash is normalized away.
  assert.equal(updated.feedback.url, "https://pagecast-feedback.acme.workers.dev");
  assert.equal(updated.feedback.statsToken, "secret");

  // Reloading from disk keeps it.
  const reopened = createConfigStore({ dataDir: dir });
  await reopened.init();
  assert.equal(reopened.get().feedback.url, "https://pagecast-feedback.acme.workers.dev");

  // A non-https url is rejected (feature stays off).
  const bad = await reopened.updateFeedback({ url: "http://insecure.example" });
  assert.equal(bad.feedback, null);

  await fs.rm(dir, { recursive: true, force: true });
});

test("feedback wrangler-output parsers extract ids and urls", () => {
  assert.equal(
    parseKvNamespaceId('[[kv_namespaces]]\nbinding = "PAGECAST_FEEDBACK"\nid = "0123456789abcdef0123456789abcdef"'),
    "0123456789abcdef0123456789abcdef"
  );
  assert.equal(parseKvNamespaceId('"id": "ABCDEF0123456789ABCDEF0123456789"'), "abcdef0123456789abcdef0123456789");
  assert.equal(parseKvNamespaceId("no id here"), "");

  const list = JSON.stringify([
    { id: "11111111111111111111111111111111", title: "other" },
    { id: "22222222222222222222222222222222", title: "pagecast-feedback-store" }
  ]);
  assert.equal(findKvNamespaceId(list, "pagecast-feedback-store"), "22222222222222222222222222222222");
  assert.equal(findKvNamespaceId(list, "missing"), "");

  assert.equal(
    parseWorkerDevUrl("Published pagecast-feedback\n  https://pagecast-feedback.acme.workers.dev (3.2 sec)"),
    "https://pagecast-feedback.acme.workers.dev"
  );
  assert.equal(parseWorkerDevUrl("no url"), "");
});

test("setupFeedback creates KV, deploys the worker, and returns the url", async () => {
  const calls = [];
  const { fakeSpawn } = makeWranglerFake((args) => {
    const line = args.join(" ");
    calls.push(line);
    if (line.includes("kv namespace list")) {
      return { code: 0, output: "[]" }; // none yet -> must create
    }
    if (line.includes("kv namespace create")) {
      return { code: 0, output: 'id = "0123456789abcdef0123456789abcdef"' };
    }
    if (line.includes("deploy")) {
      return { code: 0, output: "Uploaded\nhttps://pagecast-feedback.acme.workers.dev" };
    }
    return { code: 0, output: "" };
  });

  const manager = createCloudflareAuthManager({ spawnImpl: fakeSpawn });
  const deployDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-fb-"));

  const result = await manager.setupFeedback({
    accountId: "90e4c638bea527f464ec6fa7caebfd4e",
    workerName: "pagecast-feedback",
    workerSource: "export default { fetch(){} }",
    statsToken: "tok-123",
    deployDir
  });

  assert.equal(result.url, "https://pagecast-feedback.acme.workers.dev");
  assert.equal(result.kvId, "0123456789abcdef0123456789abcdef");
  assert.equal(result.statsToken, "tok-123");

  // The generated wrangler.toml binds the KV namespace and the stats token.
  const toml = await fs.readFile(path.join(deployDir, "wrangler.toml"), "utf8");
  assert.match(toml, /binding = "PAGECAST_FEEDBACK"/);
  assert.match(toml, /id = "0123456789abcdef0123456789abcdef"/);
  assert.match(toml, /PAGECAST_STATS_TOKEN = "tok-123"/);
  // The worker source was staged next to it.
  assert.match(await fs.readFile(path.join(deployDir, "worker.js"), "utf8"), /export default/);

  // It actually created (not just listed) because the list was empty.
  assert.ok(calls.some((c) => c.includes("kv namespace create")));
  assert.ok(calls.some((c) => c.includes("deploy")));

  await fs.rm(deployDir, { recursive: true, force: true });
});

test("setupFeedback reuses an existing KV namespace by title", async () => {
  const calls = [];
  const { fakeSpawn } = makeWranglerFake((args) => {
    const line = args.join(" ");
    calls.push(line);
    if (line.includes("kv namespace list")) {
      return {
        code: 0,
        output: JSON.stringify([{ id: "dddddddddddddddddddddddddddddddd", title: "pagecast-feedback-store" }])
      };
    }
    if (line.includes("deploy")) {
      return { code: 0, output: "https://pagecast-feedback.acme.workers.dev" };
    }
    return { code: 0, output: "" };
  });

  const manager = createCloudflareAuthManager({ spawnImpl: fakeSpawn });
  const deployDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-fb2-"));
  const result = await manager.setupFeedback({
    workerSource: "export default {}",
    statsToken: "t",
    deployDir
  });

  assert.equal(result.kvId, "dddddddddddddddddddddddddddddddd");
  assert.ok(!calls.some((c) => c.includes("kv namespace create")), "should not create when one exists");
  await fs.rm(deployDir, { recursive: true, force: true });
});

test("updatePages preserves an already-provisioned feedback config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-cfg2-"));
  const store = createConfigStore({ dataDir: dir });
  await store.init();

  await store.updateFeedback({
    url: "https://pagecast-feedback.acme.workers.dev",
    statsToken: "tok",
    workerName: "pagecast-feedback",
    kvId: "ffffffffffffffffffffffffffffffff"
  });

  // Persisting a pages/account selection (as publish does) must NOT wipe feedback.
  const after = await store.updatePages({ projectName: "myproj", accountId: "0".repeat(32) });
  assert.equal(after.pages.projectName, "myproj");
  assert.equal(after.feedback?.url, "https://pagecast-feedback.acme.workers.dev");

  await fs.rm(dir, { recursive: true, force: true });
});

test("status auto-detects an existing Wrangler login on the first poll", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");

  // Wrangler is already authenticated from a prior session: whoami returns an
  // account. No connect/login happens in this test.
  function authedWrangler() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify([
            { name: "pagecast", account_id: "0123456789abcdef0123456789abcdef", account_name: "Personal" }
          ])
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
    cloudflareAuthSpawnImpl: authedWrangler,
    cloudflareListTimeoutMs: 1000
  });

  try {
    // The very first status call must reflect the existing login — not report
    // "not connected" until the user clicks Connect again.
    const data = await (await fetch(`${runtime.adminUrl}/api/status`)).json();
    assert.equal(data.cloudflare.loggedIn, true);
    assert.equal(data.cloudflare.accounts.length, 1);
  } finally {
    await runtime.close();
  }
});

test("injectBadge adds a removable Pagecast badge once", () => {
  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  const out = injectBadge(html);
  assert.match(out, /data-pagecast-badge/);
  assert.match(out, /Published with/);
  assert.match(out, /pagecasthq\.pages\.dev/);
  // Idempotent.
  assert.equal((injectBadge(out).match(/data-pagecast-badge/g) || []).length, 1);
  // Appends when there is no </body>.
  assert.match(injectBadge("<h1>bare</h1>"), /<h1>bare<\/h1>\s*<a data-pagecast-badge/);
});

test("config badge defaults on, persists when toggled off, and survives a pages update", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-badge-"));
  const store = createConfigStore({ dataDir: dir });
  await store.init();
  assert.equal(store.get().badge, true);

  await store.setBadge(false);
  assert.equal(store.get().badge, false);

  // A pages update (as publish does) must not silently re-enable the badge.
  const after = await store.updatePages({ projectName: "proj" });
  assert.equal(after.badge, false);

  // Reload from disk keeps it off.
  const reopened = createConfigStore({ dataDir: dir });
  await reopened.init();
  assert.equal(reopened.get().badge, false);

  await fs.rm(dir, { recursive: true, force: true });
});

// Headless Cloudflare fakes for goal-page tests: an authenticated whoami + a
// project list, and a deploy spawn that always succeeds.
function makeHeadlessFakes() {
  const { fakeSpawn: authSpawn } = makeWranglerFake((args) => {
    if (args.includes("whoami")) {
      return {
        code: 0,
        output: JSON.stringify({ accounts: [{ name: "Personal", id: "abcdef0123456789abcdef0123456789" }] })
      };
    }
    if (args.includes("list")) {
      return { code: 0, output: JSON.stringify([{ name: "pagecast", account_id: "abcdef0123456789abcdef0123456789" }]) };
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
  return { authSpawn, fakeDeploy, deployCommands };
}

test("goal publish is idempotent: update re-syncs the SAME url, never a new link", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const goalFile = path.join(tempDir, "pagecast-goal.md");
  await fs.writeFile(goalFile, "# Goal\n\nStatus: started\n");
  const { authSpawn, fakeDeploy } = makeHeadlessFakes();
  const opts = {
    file: goalFile,
    dataDir,
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: fakeDeploy,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  };

  // First call: starts the page at the vanity /p/goal/ URL.
  const first = await publishGoalProgress(opts);
  assert.equal(first.started, true);
  assert.equal(first.slug, "goal");
  assert.match(first.url, /\/p\/goal\/$/);
  const stagedIndex = path.join(dataDir, "pages-site", "p", "goal", "index.html");
  assert.match(await fs.readFile(stagedIndex, "utf8"), /Status: started/);

  // config.goal recorded the page.
  const status = await getGoalStatus({ dataDir });
  assert.equal(status.goal.url, first.url);
  assert.equal(status.goal.slug, "goal");

  // Edit the file, then call again — SAME url/token, fresh content, no new link.
  await fs.writeFile(goalFile, "# Goal\n\nStatus: 80% done\n");
  const second = await publishGoalProgress(opts);
  assert.equal(second.started, false);
  assert.equal(second.url, first.url);
  assert.equal(second.token, first.token);
  assert.match(await fs.readFile(stagedIndex, "utf8"), /80% done/);

  // The shared-page badge is present on the goal page too.
  assert.match(await fs.readFile(stagedIndex, "utf8"), /data-pagecast-badge/);
});

test("goal stop revokes the page and clears config.goal", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const goalFile = path.join(tempDir, "pagecast-goal.md");
  await fs.writeFile(goalFile, "# Goal\n");
  const { authSpawn, fakeDeploy } = makeHeadlessFakes();
  const opts = {
    file: goalFile,
    dataDir,
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: fakeDeploy,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  };
  await publishGoalProgress(opts);
  assert.ok((await getGoalStatus({ dataDir })).goal);

  const stopped = await stopGoalProgress({
    dataDir,
    cloudflareAuthSpawnImpl: authSpawn,
    pagesDeploySpawnImpl: fakeDeploy,
    cloudflareListTimeoutMs: 1000,
    pagesDeployTimeoutMs: 1000
  });
  assert.equal(stopped.stopped, true);
  assert.equal((await getGoalStatus({ dataDir })).goal, null);
});

test("config.goal persists and survives pages/feedback updates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-goalcfg-"));
  const store = createConfigStore({ dataDir: dir });
  await store.init();
  assert.equal(store.get().goal, null);

  await store.setGoal({
    token: "goal-abc",
    slug: "goal",
    url: "https://pagecast.pages.dev/p/goal/",
    file: "/tmp/pagecast-goal.md",
    startedAt: "2026-06-11T00:00:00.000Z"
  });
  assert.equal(store.get().goal.slug, "goal");

  // A pages update (publish persists the account) must not wipe the goal.
  const after = await store.updatePages({ projectName: "proj" });
  assert.equal(after.goal?.url, "https://pagecast.pages.dev/p/goal/");
  // A feedback update must not wipe it either.
  const after2 = await store.updateFeedback(null);
  assert.equal(after2.goal?.url, "https://pagecast.pages.dev/p/goal/");

  await fs.rm(dir, { recursive: true, force: true });
});
