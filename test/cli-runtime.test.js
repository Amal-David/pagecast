import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configuredLocalUrls,
  isPagecastAdminStatus,
  waitForDashboard
} from "../src/cli.js";
import { WorkspaceLease } from "../src/state-coordinator.js";

test("CLI readiness accepts only the Pagecast protocol marker", () => {
  assert.equal(
    isPagecastAdminStatus({
      admin: { ok: true, product: "pagecast", protocolVersion: 1 }
    }),
    true
  );
  assert.equal(isPagecastAdminStatus({ admin: { ok: true } }), false);
  assert.equal(
    isPagecastAdminStatus({
      admin: { ok: true, product: "another-service", protocolVersion: 1 }
    }),
    false
  );
  assert.equal(
    isPagecastAdminStatus({
      admin: { ok: true, product: "pagecast", protocolVersion: 2 }
    }),
    false
  );
});

test("CLI startup polling follows a runtime URL that changes after port fallback", async () => {
  const attempts = [];
  const urls = ["http://127.0.0.1:4173", "http://127.0.0.1:4175"];
  const ready = await waitForDashboard(
    async () => urls[Math.min(attempts.length, urls.length - 1)],
    {
      timeoutMs: 100,
      intervalMs: 0,
      dashboardReadyImpl: async (url) => {
        attempts.push(url);
        return url.endsWith(":4175");
      }
    }
  );

  assert.equal(ready, true);
  assert.deepEqual(attempts, ["http://127.0.0.1:4173", "http://127.0.0.1:4175"]);
});

test("CLI direct-invocation guard follows npm-style bin symlinks", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-cli-bin-"));
  const binPath = path.join(tempDir, "pagecast");
  const cliPath = path.resolve("src/cli.js");
  await fs.symlink(cliPath, binPath);
  try {
    const result = spawnSync(process.execPath, [binPath, "--help"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, CI: "1" }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pagecast publish/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI display reconstruction preserves an explicit IPv6 daemon bind", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-cli-ipv6-"));
  const lease = new WorkspaceLease(dataDir);
  await lease.acquire({ capability: "ipv6-test-capability", role: "daemon" });
  await lease.updateRuntime({ adminUrl: "http://[::1]:43123" });
  try {
    const urls = await configuredLocalUrls({ workspaceDataDir: dataDir, env: {} });
    assert.equal(urls.adminUrl, "http://[::1]:43123");
    assert.equal(urls.displayAdminUrl, "http://[::1]:43123");
    assert.equal(urls.publicUrl, "http://[::1]:4174");
    assert.equal(urls.displayPublicUrl, "http://[::1]:4174");
  } finally {
    await lease.release();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
