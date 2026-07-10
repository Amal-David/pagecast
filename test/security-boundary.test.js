import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createConfigStore,
  getCloudflarePagesStatus,
  setupCloudflareFeedback,
  startServers
} from "../src/server.js";
import { PAGECAST_EXTENSION_ID } from "../src/admin-security.js";

const CSRF_HEADER = "X-Pagecast-CSRF";
const EXTENSION_HEADER = "X-Pagecast-Extension";
const EXTENSION_ORIGIN = `chrome-extension://${PAGECAST_EXTENSION_ID}`;
const FOREIGN_EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const FORBIDDEN_DTO_KEYS = new Set([
  "adminCapabilityToken",
  "adminToken",
  "authCookieSecret",
  "statsToken",
  "syncSecret",
  "telemetryId"
]);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-security-boundary-"));
}

function fakeWranglerSpawn(command, args) {
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
    const line = args.join(" ");
    let output = "";
    if (line.includes("kv namespace list")) {
      output = JSON.stringify([
        {
          id: "11111111111111111111111111111111",
          title: "pagecast-feedback-store"
        }
      ]);
    } else if (line.includes("deploy")) {
      output = "Uploaded\nhttps://pagecast-feedback.example.workers.dev";
    }
    if (output) {
      child.stdout.emit("data", Buffer.from(output));
    }
    child.exitCode = 0;
    child.emit("exit", 0, null);
  });

  return child;
}

async function startTestRuntime(dataDir) {
  return startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: fakeWranglerSpawn,
    cloudflareListTimeoutMs: 1000
  });
}

async function addPathReport(runtime, reportPath) {
  const response = await fetch(`${runtime.adminUrl}/api/reports/path`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pagecast-Capability": runtime.commandCapability
    },
    body: JSON.stringify({ path: reportPath })
  });
  assert.equal(response.status, 201);
  return (await response.json()).report;
}

async function makeRuntimeWithReport() {
  const tempDir = await makeTempDir();
  const reportDir = path.join(tempDir, "report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "index.html");
  await fs.writeFile(
    reportPath,
    '<link rel="stylesheet" href="style.css"><h1>Untrusted preview</h1>'
  );
  await fs.writeFile(path.join(reportDir, "style.css"), "body { color: purple; }");
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  const report = await addPathReport(runtime, reportPath);
  return { tempDir, runtime, report };
}

function findForbiddenKeys(value, prefix = "", found = []) {
  if (!value || typeof value !== "object") {
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    const location = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_DTO_KEYS.has(key)) {
      found.push(location);
    }
    findForbiddenKeys(nested, location, found);
  }
  return found;
}

function assertSecretFreeDto(value, secretValues = []) {
  assert.deepEqual(findForbiddenKeys(value), [], "DTO must not expose secret-bearing keys");
  const serialized = JSON.stringify(value);
  for (const secret of secretValues.filter(Boolean)) {
    assert.equal(serialized.includes(secret), false, `DTO exposed seeded secret value ${secret}`);
  }
}

async function seedSecrets(dataDir) {
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updateFeedback({
    url: "https://pagecast-feedback.example.workers.dev",
    statsToken: "seed-feedback-stats-token",
    workerName: "pagecast-feedback",
    kvId: "11111111111111111111111111111111"
  });
  const telemetryId = await configStore.ensureTelemetryId();
  const internal = configStore.get();
  return [
    internal.authCookieSecret,
    internal.syncSecret,
    telemetryId,
    internal.feedback.statsToken
  ];
}

function requestAdmin(runtime, { hostHeader, omitHost = false } = {}) {
  if (omitHost) {
    return new Promise((resolve, reject) => {
      const socket = connectSocket(
        { host: "127.0.0.1", port: runtime.adminServer.address().port },
        () => socket.write("GET /api/status HTTP/1.0\r\n\r\n")
      );
      let response = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.on("end", () => {
        const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(response)?.[1]);
        resolve(status);
      });
      socket.on("error", reject);
    });
  }

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: runtime.adminServer.address().port,
        path: "/api/status",
        method: "GET",
        setHost: true,
        headers: hostHeader === undefined ? {} : { Host: hostHeader }
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

test("report localUrl uses the public preview origin", async () => {
  const { tempDir, runtime, report } = await makeRuntimeWithReport();
  try {
    const localUrl = new URL(report.localUrl);
    assert.equal(localUrl.origin, new URL(runtime.displayPublicUrl).origin);
    assert.match(localUrl.pathname, new RegExp(`^/preview/${report.id}/$`));
    assert.notEqual(localUrl.origin, new URL(runtime.adminUrl).origin);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("the public handler serves preview entrypoints and sibling assets", async () => {
  const { tempDir, runtime, report } = await makeRuntimeWithReport();
  try {
    const previewUrl = `${runtime.publicUrl}/preview/${report.id}/`;
    const entry = await fetch(previewUrl);
    assert.equal(entry.status, 200);
    assert.match(await entry.text(), /Untrusted preview/);

    const asset = await fetch(new URL("style.css", previewUrl));
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "body { color: purple; }");
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("the admin origin never serves raw preview bytes", async () => {
  const { tempDir, runtime, report } = await makeRuntimeWithReport();
  try {
    const response = await fetch(`${runtime.adminUrl}/preview/${report.id}/`, {
      redirect: "manual"
    });
    assert.notEqual(response.status, 200);
    if (response.status >= 300 && response.status < 400) {
      const destination = new URL(response.headers.get("location"), runtime.adminUrl);
      assert.equal(destination.origin, new URL(runtime.displayPublicUrl).origin);
    }
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("foreign browser origins cannot mutate the admin API", async () => {
  const tempDir = await makeTempDir();
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  try {
    const response = await fetch(`${runtime.adminUrl}/api/config/badge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
        [CSRF_HEADER]: "attacker-controlled-token"
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(response.status, 403);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("same-origin browser mutations require the /api/session CSRF token", async () => {
  const tempDir = await makeTempDir();
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  const mutate = (csrfToken) =>
    fetch(`${runtime.adminUrl}/api/config/badge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: runtime.adminUrl,
        ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {})
      },
      body: JSON.stringify({ enabled: false })
    });

  try {
    assert.equal((await mutate()).status, 403);

    const sessionResponse = await fetch(`${runtime.adminUrl}/api/session`, {
      headers: { Origin: runtime.adminUrl }
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.match(session.csrfToken, /^[A-Za-z0-9_-]{32,}$/);

    assert.equal((await mutate(session.csrfToken)).status, 200);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("no-Origin automation mutations require the private workspace capability", async () => {
  const tempDir = await makeTempDir();
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  const mutate = (capability) =>
    fetch(`${runtime.adminUrl}/api/config/badge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(capability ? { "X-Pagecast-Capability": capability } : {})
      },
      body: JSON.stringify({ enabled: false })
    });

  try {
    assert.equal((await mutate()).status, 403);
    assert.equal((await mutate("stale-workspace-capability")).status, 403);
    assert.equal((await mutate(runtime.commandCapability)).status, 200);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const unauthenticated = await fetch(`${runtime.adminUrl}/api/not-found`, { method });
      assert.equal(unauthenticated.status, 403, `${method} must reject a missing capability`);
      const authenticated = await fetch(`${runtime.adminUrl}/api/not-found`, {
        method,
        headers: { "X-Pagecast-Capability": runtime.commandCapability }
      });
      assert.equal(authenticated.status, 404, `${method} must reach routing with the capability`);
    }
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a workspace capability never substitutes for browser CSRF", async () => {
  const tempDir = await makeTempDir();
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  try {
    const missingCsrf = await fetch(`${runtime.adminUrl}/api/config/badge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: runtime.adminUrl,
        "X-Pagecast-Capability": runtime.commandCapability
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(missingCsrf.status, 403);

    const session = await fetch(`${runtime.adminUrl}/api/session`, {
      headers: { Origin: runtime.adminUrl }
    });
    const { csrfToken } = await session.json();
    const authenticated = await fetch(`${runtime.adminUrl}/api/config/badge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: runtime.adminUrl,
        [CSRF_HEADER]: csrfToken,
        "X-Pagecast-Capability": "intentionally-wrong"
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(authenticated.status, 200);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a CSRF token from a previous server session is rejected", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  let runtime = await startTestRuntime(dataDir);
  try {
    const sessionResponse = await fetch(`${runtime.adminUrl}/api/session`, {
      headers: { Origin: runtime.adminUrl }
    });
    assert.equal(sessionResponse.status, 200);
    const staleToken = (await sessionResponse.json()).csrfToken;
    await runtime.close();

    runtime = await startTestRuntime(dataDir);
    const response = await fetch(`${runtime.adminUrl}/api/config/badge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: runtime.adminUrl,
        [CSRF_HEADER]: staleToken
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(response.status, 403);
  } finally {
    await runtime.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("an identified extension can access only session, status, and publish-local", async () => {
  const tempDir = await makeTempDir();
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  const extensionHeaders = {
    Origin: EXTENSION_ORIGIN,
    [EXTENSION_HEADER]: "1"
  };
  try {
    const sessionResponse = await fetch(`${runtime.adminUrl}/api/session`, {
      headers: extensionHeaders
    });
    assert.equal(sessionResponse.status, 200, "/api/session should remain available to the extension");
    assert.equal(sessionResponse.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN);
    const { csrfToken } = await sessionResponse.json();

    const statusResponse = await fetch(`${runtime.adminUrl}/api/status`, {
      headers: extensionHeaders
    });
    assert.equal(statusResponse.status, 200, "/api/status should remain available to the extension");
    assert.equal(statusResponse.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN);

    const publish = await fetch(`${runtime.adminUrl}/api/publish-local`, {
      method: "POST",
      headers: {
        ...extensionHeaders,
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrfToken
      },
      body: "{}"
    });
    assert.notEqual(publish.status, 403, "publish-local should reach input validation");
    assert.equal(publish.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN);

    const privileged = await fetch(`${runtime.adminUrl}/api/config/badge`, {
      method: "POST",
      headers: {
        ...extensionHeaders,
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrfToken
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(privileged.status, 403);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("an extension Origin without the extension request marker is rejected", async () => {
  const tempDir = await makeTempDir();
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  try {
    const response = await fetch(`${runtime.adminUrl}/api/status`, {
      headers: { Origin: EXTENSION_ORIGIN }
    });
    assert.equal(response.status, 403);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a different valid Chrome extension ID cannot access any extension adapter route", async () => {
  const tempDir = await makeTempDir();
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  const headers = {
    Origin: FOREIGN_EXTENSION_ORIGIN,
    [EXTENSION_HEADER]: "1"
  };
  try {
    const session = await fetch(`${runtime.adminUrl}/api/session`, { headers });
    assert.equal(session.status, 403);
    assert.equal(session.headers.get("access-control-allow-origin"), null);

    const status = await fetch(`${runtime.adminUrl}/api/status`, { headers });
    assert.equal(status.status, 403);
    assert.equal(status.headers.get("access-control-allow-origin"), null);

    const publish = await fetch(`${runtime.adminUrl}/api/publish-local`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        [CSRF_HEADER]: "foreign-extension-token"
      },
      body: JSON.stringify({ path: "/tmp/foreign-extension.html" })
    });
    assert.equal(publish.status, 403);
    assert.equal(publish.headers.get("access-control-allow-origin"), null);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("admin requests with missing or unsafe Host headers are rejected", async () => {
  const tempDir = await makeTempDir();
  const runtime = await startTestRuntime(path.join(tempDir, "data"));
  try {
    assert.equal(await requestAdmin(runtime, { omitHost: true }), 403);
    assert.equal(await requestAdmin(runtime, { hostHeader: "attacker.example" }), 403);
    assert.notEqual(await requestAdmin(runtime, { hostHeader: "127.0.0.1" }), 403);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("public config and status DTOs recursively redact seeded secrets", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const secretValues = await seedSecrets(dataDir);
  const runtime = await startTestRuntime(dataDir);
  try {
    for (const route of ["/api/config", "/api/status"]) {
      const response = await fetch(`${runtime.adminUrl}${route}`);
      assert.equal(response.status, 200);
      assertSecretFreeDto(await response.json(), secretValues);
    }
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("feedback API and headless DTOs never serialize internal secrets", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const secretValues = await seedSecrets(dataDir);
  try {
    const runtime = await startTestRuntime(dataDir);
    try {
      const apiResponse = await fetch(`${runtime.adminUrl}/api/feedback/setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pagecast-Capability": runtime.commandCapability
        },
        body: "{}"
      });
      assert.equal(apiResponse.status, 200);
      assertSecretFreeDto(await apiResponse.json(), secretValues);
    } finally {
      await runtime.close();
    }

    const feedbackResult = await setupCloudflareFeedback({
      dataDir,
      cloudflareAuthSpawnImpl: fakeWranglerSpawn,
      cloudflareListTimeoutMs: 1000
    });
    assertSecretFreeDto(feedbackResult, secretValues);

    const statusResult = await getCloudflarePagesStatus({
      dataDir,
      cloudflareAuthSpawnImpl: fakeWranglerSpawn,
      cloudflareListTimeoutMs: 1000
    });
    assertSecretFreeDto(statusResult, secretValues);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("one-shot status reports the same target adoption state as the daemon", async () => {
  const tempDir = await makeTempDir();
  const dataDir = path.join(tempDir, "data");
  const pages = {
    accountId: "abcdef0123456789abcdef0123456789",
    projectName: "adopt-status",
    baseUrl: "https://adopt-status.pages.dev"
  };
  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages(pages);

  try {
    const unmanaged = await getCloudflarePagesStatus({
      dataDir,
      routeToDaemon: false,
      cloudflareAuthSpawnImpl: fakeWranglerSpawn,
      cloudflareListTimeoutMs: 1000
    });
    assert.equal(unmanaged.cloudflare.managed, false);
    assert.equal(unmanaged.cloudflare.requiresAdoption, true);

    await configStore.claimManagedTarget(pages);
    const managed = await getCloudflarePagesStatus({
      dataDir,
      routeToDaemon: false,
      cloudflareAuthSpawnImpl: fakeWranglerSpawn,
      cloudflareListTimeoutMs: 1000
    });
    assert.equal(managed.cloudflare.managed, true);
    assert.equal(managed.cloudflare.requiresAdoption, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
