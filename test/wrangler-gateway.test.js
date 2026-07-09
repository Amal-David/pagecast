import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as packageApi from "../src/index.js";
import * as serverApi from "../src/server.js";
import * as gateway from "../src/wrangler-gateway.js";

const HISTORICAL_GATEWAY_EXPORTS = [
  "CLOUDFLARE_OAUTH_SCOPES",
  "DEFAULT_CLOUDFLARE_LIST_TIMEOUT_MS",
  "DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS",
  "DEFAULT_PAGES_BRANCH",
  "DEFAULT_PAGES_PROJECT_NAME",
  "FEEDBACK_OAUTH_SCOPES",
  "chooseWranglerPagesProject",
  "cloudflareCredentialStatus",
  "createCloudflareAuthManager",
  "findKvNamespaceId",
  "flagLiveDeployment",
  "parseKvNamespaceId",
  "parseWorkerDevUrl",
  "parseWranglerPagesDeployments",
  "parseWranglerPagesProjects",
  "parseWranglerWhoamiAccounts",
  "selectDeploymentsToPrune"
];

test("server and package facades preserve the Wrangler gateway export identities", () => {
  for (const name of HISTORICAL_GATEWAY_EXPORTS) {
    assert.equal(serverApi[name], gateway[name], `${name} must be the gateway binding`);
    assert.equal(packageApi[name], gateway[name], `${name} must keep its package identity`);
  }
});

test("Wrangler gateway stays acyclic and server contains no second implementation", async () => {
  const [gatewaySource, serverSource] = await Promise.all([
    readFile(new URL("../src/wrangler-gateway.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(gatewaySource, /from\s+["']\.\/server\.js["']/);
  assert.match(serverSource, /from\s+["']\.\/wrangler-gateway\.js["']/);
  assert.doesNotMatch(serverSource, /function\s+createCloudflareAuthManager\s*\(/);
  assert.doesNotMatch(serverSource, /function\s+parseWranglerPagesProjects\s*\(/);
  assert.doesNotMatch(serverSource, /function\s+parseWranglerWhoamiAccounts\s*\(/);
});

test("gateway command runner terminates a timed-out Wrangler child", async () => {
  let killedWith = "";
  const keepAlive = setInterval(() => {}, 20);
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      killedWith = signal;
      child.signalCode = signal;
      return true;
    };
    return child;
  };

  try {
    await assert.rejects(
      gateway.runSpawnCommand({
        spawnImpl,
        command: "npx",
        args: ["wrangler", "whoami"],
        timeoutMs: 5
      }),
      (error) => error.statusCode === 504 && /did not finish/.test(error.message)
    );
    assert.equal(killedWith, "SIGTERM");
  } finally {
    clearInterval(keepAlive);
  }
});

test("gateway normalizers reject unsafe command-line identifiers before spawn", async () => {
  let spawnCount = 0;
  const manager = gateway.createCloudflareAuthManager({
    spawnImpl() {
      spawnCount += 1;
      throw new Error("spawn should not be reached");
    }
  });

  await assert.rejects(
    manager.listDeployments({ projectName: "../marketing" }),
    (error) => error.statusCode === 400
  );
  assert.equal(spawnCount, 0);
});
