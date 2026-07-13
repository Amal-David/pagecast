import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigStore, startServers } from "../src/server.js";

async function tempWorkspace(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("report previews use the public origin and the admin origin never serves report bytes", async () => {
  const root = await tempWorkspace("pagecast-security-preview-");
  const dataDir = path.join(root, "data");
  const reportPath = path.join(root, "report.html");
  await fs.writeFile(reportPath, "<h1>untrusted-preview-marker</h1>");
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });

  try {
    const created = await fetch(`${runtime.adminUrl}/api/reports/path`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pagecast-Capability": runtime.commandCapability
      },
      body: JSON.stringify({ path: reportPath })
    });
    assert.equal(created.status, 201);
    const { report } = await created.json();
    const displayPreview = new URL(report.localUrl);
    assert.equal(displayPreview.origin, new URL(runtime.displayPublicUrl).origin);

    const publicPreview = await fetch(new URL(displayPreview.pathname, runtime.publicUrl));
    assert.equal(publicPreview.status, 200);
    assert.match(await publicPreview.text(), /untrusted-preview-marker/);

    const adminPreview = await fetch(
      `${runtime.adminUrl}/preview/${encodeURIComponent(report.id)}/`,
      { redirect: "manual" }
    );
    assert.ok([301, 302, 307, 308].includes(adminPreview.status));
    assert.equal(
      new URL(adminPreview.headers.get("location")).origin,
      new URL(runtime.displayPublicUrl).origin
    );
    assert.doesNotMatch(await adminPreview.text(), /untrusted-preview-marker/);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("browser-originated admin mutations require same origin and a CSRF session token", async () => {
  const root = await tempWorkspace("pagecast-security-csrf-");
  const dataDir = path.join(root, "data");
  const reportPath = path.join(root, "report.html");
  await fs.writeFile(reportPath, "<h1>safe</h1>");
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public")
  });
  const adminOrigin = new URL(runtime.adminUrl).origin;

  try {
    const foreign = await fetch(`${runtime.adminUrl}/api/reports/path`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ path: reportPath })
    });
    assert.equal(foreign.status, 403);

    const missingToken = await fetch(`${runtime.adminUrl}/api/reports/path`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: adminOrigin },
      body: JSON.stringify({ path: reportPath })
    });
    assert.equal(missingToken.status, 403);

    const sessionResponse = await fetch(`${runtime.adminUrl}/api/session`, {
      headers: { Origin: adminOrigin }
    });
    assert.equal(sessionResponse.status, 200);
    const { csrfToken } = await sessionResponse.json();
    assert.match(csrfToken, /^[A-Za-z0-9_-]{32,}$/);

    const accepted = await fetch(`${runtime.adminUrl}/api/reports/path`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
        "X-Pagecast-CSRF": csrfToken
      },
      body: JSON.stringify({ path: reportPath })
    });
    assert.equal(accepted.status, 201);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("public config is an allowlist and never exposes nested feedback or internal secrets", async () => {
  const root = await tempWorkspace("pagecast-security-config-");
  const store = createConfigStore({ dataDir: root });
  await store.init();
  await store.updateFeedback({
    url: "https://pagecast-feedback.example.workers.dev",
    workerName: "pagecast-feedback",
    statsToken: "stats-token-sentinel",
    visitorSecret: "visitor-secret-sentinel",
    kvId: "kv-id-sentinel",
    d1Id: "d1-id-sentinel"
  });

  const publicConfig = store.getPublicConfig();
  assert.deepEqual(Object.keys(publicConfig).sort(), [
    "badge",
    "cloudflareSyncEnabled",
    "defaultExpiry",
    "feedback",
    "local",
    "pages",
    "telemetryConsent"
  ]);
  assert.deepEqual(publicConfig.feedback, {
    url: "https://pagecast-feedback.example.workers.dev",
    workerName: "pagecast-feedback",
    analyticsEnabled: true,
    reactionsEnabled: false
  });
  const serialized = JSON.stringify(publicConfig);
  for (const forbidden of [
    "authCookieSecret",
    "syncSecret",
    "telemetryId",
    "statsToken",
    "visitorSecret",
    "kvId",
    "d1Id",
    "stats-token-sentinel",
    "visitor-secret-sentinel",
    "d1-id-sentinel",
    "kv-id-sentinel"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `public config leaked ${forbidden}`);
  }

  await fs.rm(root, { recursive: true, force: true });
});
