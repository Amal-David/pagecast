// The custom-domain HTTP surface, exercised through a real listening admin
// server rather than by calling the service functions directly.
//
// The service tests in custom-domain.test.js cover the reconcile logic. What
// they cannot see is the route layer: whether the three routes are wired to it
// at all, and whether the reconcile is treated as the write it is. It persists
// config and re-hosts every stored link, and the dashboard polls it every 15s
// while a domain is pending, so overlapping an in-flight mutation is routine
// rather than theoretical.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigStore, startServers } from "../src/server.js";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const PROJECT_NAME = "alpha-reports";
const ASSIGNED_ORIGIN = `https://${PROJECT_NAME}.pages.dev`;
// api.cloudflare.com paths carry the /client/v4 prefix the client builds in.
const DOMAINS_PATH = `/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}/domains`;

// startServers touches Wrangler during boot; nothing here needs a real one.
function inertSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => child.emit("exit", 0, null));
  return child;
}

/**
 * A stand-in for api.cloudflare.com's Pages Domains endpoints.
 *
 * `gate`, when set, is awaited before the GET answers, which is how the
 * serialization test holds a reconcile open while it fires a second request.
 */
function fakeCloudflareApi({ domains = [], gate = null } = {}) {
  const calls = [];
  const state = { domains };
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    calls.push({ method, pathname: url.pathname });
    assert.equal(init.headers.Authorization, "Bearer test-token");

    const json = (result) =>
      new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });

    if (url.pathname === DOMAINS_PATH && method === "GET") {
      if (gate) await gate;
      return json(state.domains);
    }
    if (url.pathname === DOMAINS_PATH && method === "POST") {
      const record = { name: JSON.parse(init.body).name, status: "pending" };
      state.domains.push(record);
      return json(record);
    }
    if (url.pathname.startsWith(`${DOMAINS_PATH}/`) && method === "DELETE") {
      const name = decodeURIComponent(url.pathname.slice(DOMAINS_PATH.length + 1));
      state.domains = state.domains.filter((entry) => entry.name !== name);
      return json(null);
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: "unrouted" }] }), {
      status: 404
    });
  }
  return { fetchImpl, calls, state };
}

async function startDomainServer({ domains = [], gate = null } = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-domain-routes-"));
  const dataDir = path.join(tempDir, "data");

  const configStore = createConfigStore({ dataDir });
  await configStore.init();
  await configStore.updatePages({
    accountId: ACCOUNT_ID,
    projectName: PROJECT_NAME,
    baseUrl: ASSIGNED_ORIGIN,
    adoptExisting: true
  });

  const cloudflare = fakeCloudflareApi({ domains, gate });
  const runtime = await startServers({
    adminPort: 0,
    publicPort: 0,
    dataDir,
    staticDir: path.resolve("public"),
    cloudflareAuthSpawnImpl: inertSpawn,
    cloudflareApiFetchImpl: cloudflare.fetchImpl
  });

  // Mutating admin routes need the workspace capability that a no-Origin CLI
  // client would send.
  const call = (pathname, init = {}) =>
    fetch(`${runtime.adminUrl}${pathname}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Pagecast-Capability": runtime.commandCapability,
        ...(init.headers || {})
      }
    });

  return {
    runtime,
    cloudflare,
    call,
    dataDir,
    async close() {
      await runtime.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

// Credential resolution is covered in custom-domain.test.js; here the env token
// keeps the routes off Wrangler's config entirely.
function withApiToken() {
  const previous = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  return () => {
    if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previous;
  };
}

test("the custom-domain routes add, reconcile, and detach through the admin API", async () => {
  const restoreToken = withApiToken();
  const server = await startDomainServer();
  try {
    // POST attaches and reports the record the operator still has to create.
    const added = await server.call("/api/pages/domain", {
      method: "POST",
      body: JSON.stringify({ domain: "docs.example.com" })
    });
    assert.equal(added.status, 200);
    const addedBody = await added.json();
    assert.equal(addedBody.customDomain.name, "docs.example.com");
    assert.equal(addedBody.customDomain.status, "pending");
    // Pending means links have not moved, and the response has to say so.
    assert.equal(addedBody.publicBaseUrl, ASSIGNED_ORIGIN);
    assert.equal(addedBody.dns.record.type, "CNAME");
    assert.equal(addedBody.dns.record.value, `${PROJECT_NAME}.pages.dev`);

    // The reconcile asks Cloudflare rather than echoing what the add just stored.
    server.cloudflare.state.domains = [{ name: "docs.example.com", status: "active" }];
    const status = await server.call("/api/pages/domain/status", {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.customDomain.status, "active");
    assert.equal(statusBody.publicBaseUrl, "https://docs.example.com");
    assert.equal(statusBody.originChanged, true);

    // DELETE detaches at Cloudflare and reverts the public origin.
    const removed = await server.call(
      "/api/pages/domain?domain=docs.example.com",
      { method: "DELETE" }
    );
    assert.equal(removed.status, 200);
    const removedBody = await removed.json();
    assert.equal(removedBody.removed, "docs.example.com");
    assert.equal(removedBody.customDomain, null);
    assert.equal(removedBody.publicBaseUrl, ASSIGNED_ORIGIN);
    assert.deepEqual(server.cloudflare.state.domains, []);

    // The stored config agrees with what the last response reported.
    const reloaded = createConfigStore({ dataDir: server.dataDir });
    await reloaded.init();
    assert.equal(reloaded.get().pages.customDomain, null);
    // Through all of it the canonical origin never moved.
    assert.equal(reloaded.get().pages.baseUrl, ASSIGNED_ORIGIN);
  } finally {
    await server.close();
    restoreToken();
  }
});

test("a domain reconcile holds the mutation queue like any other write", async () => {
  const restoreToken = withApiToken();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = await startDomainServer({ gate });
  try {
    const order = [];

    // Blocks inside Cloudflare's list call, holding the reconcile open.
    const reconcile = server
      .call("/api/pages/domain/status", { method: "POST", body: JSON.stringify({}) })
      .then((response) => {
        order.push("reconcile");
        return response;
      });

    // A plain mutation fired while the reconcile is stuck. If the reconcile
    // were shaped as a read it would run outside the queue, this would answer
    // immediately, and the two would interleave over the same config file.
    const mutation = new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
      server
        .call("/api/config/expiry", { method: "POST", body: JSON.stringify({ default: "7d" }) })
        .then((response) => {
          order.push("mutation");
          return response;
        })
    );

    let settledEarly = false;
    await Promise.race([
      mutation.then(() => {
        settledEarly = true;
      }),
      new Promise((resolve) => setTimeout(resolve, 250))
    ]);
    assert.equal(settledEarly, false, "the mutation ran while a reconcile held the queue");

    release();
    const [reconcileResponse, mutationResponse] = await Promise.all([reconcile, mutation]);
    assert.equal(reconcileResponse.status, 200);
    assert.equal(mutationResponse.status, 200);
    // Queued behind, not merely slow.
    assert.deepEqual(order, ["reconcile", "mutation"]);
  } finally {
    release();
    await server.close();
    restoreToken();
  }
});

test("the reconcile route refuses a caller without the workspace capability", async () => {
  const restoreToken = withApiToken();
  const server = await startDomainServer();
  try {
    // Shaped as a GET this answered anyone who could reach the port: the
    // credential check keys off the HTTP method, so a route that persists
    // config and rewrites every stored link was exempt from it.
    const response = await fetch(`${server.runtime.adminUrl}/api/pages/domain/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /command capability/);
    // Nothing reconciled, so nothing was written.
    assert.deepEqual(server.cloudflare.calls, []);
  } finally {
    await server.close();
    restoreToken();
  }
});
