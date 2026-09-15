import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkerManifest,
  createWorkerClient,
  normalizeWorkerOrigin,
  readWorkerCredentials,
  WORKER_CREDENTIAL_FILE,
  workerCredentialPath,
  writeWorkerCredential
} from "../src/worker-client.js";
import { createConfigStore, publishReportSnapshot, rollbackWorkerPublication, startServers } from "../src/server.js";
import { materializeWorkerPublishRoot, publishWorkerSnapshotOneShot } from "../src/worker-publication-service.js";

test("Worker origins are HTTPS by default and allow explicit loopback development only", () => {
  assert.equal(normalizeWorkerOrigin("https://pagecast.example"), "https://pagecast.example");
  assert.throws(() => normalizeWorkerOrigin("http://pagecast.example"), /HTTPS/);
  assert.equal(normalizeWorkerOrigin("http://127.0.0.1:8787", { allowLoopbackHttp: true }), "http://127.0.0.1:8787");
  assert.throws(() => normalizeWorkerOrigin("https://pagecast.example:8443"), /non-default port/);
  assert.throws(() => normalizeWorkerOrigin("https://pagecast.example/control"), /without a path/);
});

test("Worker credentials have an isolated 0600 file and never enter connection metadata", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-"));
  try {
    await writeWorkerCredential({ dataDir, profileId: "profile_123", token: "pcat_secret" });
    assert.deepEqual(await readWorkerCredentials({ dataDir }), { profile_123: "pcat_secret" });
    assert.equal((await fs.stat(workerCredentialPath({ dataDir }))).mode & 0o777, 0o600);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("Worker manifest shares Pages safety rules and has stable sorted hashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-tree-"));
  try {
    await fs.mkdir(path.join(root, "assets"));
    await fs.writeFile(path.join(root, "index.html"), "ok");
    await fs.writeFile(path.join(root, "assets", "site.css"), "body{}");
    await fs.writeFile(path.join(root, ".secret"), "never public");
    const manifest = await buildWorkerManifest(root);
    assert.deepEqual(manifest.map((file) => file.path), ["assets/site.css", "index.html"]);
    assert.equal(manifest[1].sha256, createHash("sha256").update("ok").digest("hex"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Worker hashing is bounded to four concurrent files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-hash-"));
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => fs.writeFile(path.join(root, `file-${index}.txt`), `${index}`)));
    let active = 0;
    let peak = 0;
    await buildWorkerManifest(root, {
      hashFile: async (file) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return createHash("sha256").update(file).digest("hex");
      }
    });
    assert.equal(peak, 4);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Worker materialization isolates files, renders Markdown, and normalizes folder entries", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-materialize-"));
  try {
    const file = path.join(dataDir, "report.html");
    await fs.writeFile(file, "<p>only this</p>");
    await fs.writeFile(path.join(dataDir, "secret.txt"), "do not publish");
    let staged = await materializeWorkerPublishRoot({ dataDir, report: { kind: "path", rootDir: dataDir, entryFile: "report.html" } });
    assert.deepEqual(await fs.readdir(staged.rootDir), ["index.html"]);
    await staged.cleanup();
    await fs.writeFile(path.join(dataDir, "doc.md"), "# rendered");
    staged = await materializeWorkerPublishRoot({ dataDir, report: { kind: "path", rootDir: dataDir, entryFile: "doc.md" } });
    assert.match(await fs.readFile(path.join(staged.rootDir, "index.html"), "utf8"), /rendered/);
    await staged.cleanup();
    const folder = path.join(dataDir, "site");
    await fs.mkdir(path.join(folder, "assets"), { recursive: true });
    await fs.writeFile(path.join(folder, "report.html"), "<p>folder entry</p>");
    await fs.writeFile(path.join(folder, "assets", "site.css"), "body{}");
    staged = await materializeWorkerPublishRoot({ dataDir, report: { kind: "folder", rootDir: folder, entryFile: "report.html" } });
    assert.equal(await fs.readFile(path.join(staged.rootDir, "index.html"), "utf8"), "<p>folder entry</p>");
    assert.equal(await fs.readFile(path.join(staged.rootDir, "assets", "site.css"), "utf8"), "body{}");
    await staged.cleanup();
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("Worker materialization aborts before copying a 26th file", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-materialize-limit-"));
  try {
    const folder = path.join(dataDir, "site");
    await fs.mkdir(folder);
    await Promise.all(Array.from({ length: 26 }, (_, index) => fs.writeFile(path.join(folder, `file-${index}.html`), "ok")));
    await assert.rejects(
      materializeWorkerPublishRoot({ dataDir, report: { kind: "folder", rootDir: folder, entryFile: "file-0.html" } }),
      /at most 25 files/
    );
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("Worker materialization removes a partial staging directory after a copy failure", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-materialize-failure-"));
  try {
    const source = path.join(dataDir, "report.html");
    await fs.writeFile(source, "<h1>partial</h1>");
    await assert.rejects(
      materializeWorkerPublishRoot({
        dataDir,
        report: { kind: "path", rootDir: dataDir, entryFile: "report.html" },
        fs: { ...fs, copyFile: async () => { throw new Error("copy failed"); } }
      }),
      /copy failed/
    );
    assert.deepEqual(await fs.readdir(path.join(dataDir, "worker-staging")), []);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("a post-commit Worker staging cleanup failure does not turn success into a retry", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-cleanup-failure-"));
  try {
    const source = path.join(dataDir, "report.html");
    await fs.writeFile(source, "<h1>committed</h1>");
    const publication = { token: "local", slug: "local", label: "cleanup", publications: [] };
    let committed = 0;
    let cleared = 0;
    const store = {
      findPublishMatch: () => null,
      addPath: async () => ({ id: "report" }),
      get: () => ({ id: "report", kind: "path", rootDir: dataDir, entryFile: "report.html" }),
      listOperations: () => [],
      draftPublication: () => ({ publication }),
      beginOperations: async () => {},
      commitPublication: async () => { committed += 1; },
      clearOperation: async () => { cleared += 1; },
      recordOperationFailure: async () => { throw new Error("must not retry a committed success"); }
    };
    const configStore = {
      get: () => ({ defaultExpiry: "never" }),
      workerClient: async () => ({
        profile: { profileId: "profile_123", origin: "https://worker.example", ownerId: "owner" },
        client: {
          capabilities: async () => ({ apiVersion: 2 }),
          publish: async () => ({ publicationId: "remote", versionId: "version", slug: "remote-slug" })
        }
      })
    };
    const result = await publishWorkerSnapshotOneShot({ path: source, dataDir, store, configStore }, {
      createReportStore: () => { throw new Error("unexpected store"); },
      createConfigStore: () => { throw new Error("unexpected config"); },
      normalizePublishMode: () => ({ mode: "create" }),
      resolvePublicationContext: () => ({ contextKey: "context", contextHash: "context", itemHash: "item", workspaceHash: "workspace" }),
      resolveExpiresAt: () => null,
      appError: (message, statusCode) => Object.assign(new Error(message), { statusCode }),
      randomBytes,
      fs: { ...fs, rm: async () => { throw new Error("cleanup failed"); } }
    });
    assert.equal(result.versionId, "version");
    assert.equal(committed, 1);
    assert.equal(cleared, 1);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("Worker client rejects a reachable but incompatible capability surface", async () => {
  const client = createWorkerClient({ origin: "https://worker.example", ownerId: "owner", token: "token", fetchImpl: async () => Response.json({ service: "pagecast", status: "ok", apiVersion: 1, capabilities: [] }) });
  await assert.rejects(client.capabilities(), /does not support/);
});

test("Worker upload resumes a journaled session with stable file idempotency and activates last", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-upload-"));
  const requests = [];
  try {
    await fs.writeFile(path.join(root, "index.html"), "hello");
    const client = createWorkerClient({
      origin: "https://worker.example", ownerId: "owner", token: "token", retries: 0,
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, method: options.method, key: options.headers?.["Idempotency-Key"] });
        if (url.includes("/complete")) return Response.json({ status: "complete" });
        if (url.includes("/activate")) return Response.json({ publicationId: "pub", versionId: "ver", state: "published" });
        if (options.method === "PUT") return Response.json({ uploaded: true });
        throw new Error(`unexpected request ${url}`);
      }
    });
    const checkpoints = [];
    await client.publish({ rootDir: root, title: "Test", operation: { idempotencyKey: "stable-key", workerSessionId: "session", workerPublicationId: "pub", workerVersionId: "ver", uploadedPaths: [] }, checkpoint: async (value) => checkpoints.push(value), beforeActivate: async () => requests.push({ method: "policy" }) });
    assert.equal(requests.at(-1).method, "POST");
    assert.equal(requests.find((request) => request.method === "PUT").key, "stable-key:index.html");
    assert.equal(checkpoints[0].workerSessionId, "session");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Worker requests retry timed-out uploads and cancel retryable response bodies", async () => {
  let attempts = 0;
  const client = createWorkerClient({
    origin: "https://worker.example", ownerId: "owner", token: "token", retries: 1, timeoutMs: 5, sleep: async () => {},
    fetchImpl: async (_url, options = {}) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true }));
      }
      return Response.json({ versions: [] });
    }
  });
  await client.listVersions("publication");
  assert.equal(attempts, 2);

  let canceled = 0;
  attempts = 0;
  const retrying = createWorkerClient({
    origin: "https://worker.example", ownerId: "owner", token: "token", retries: 1, sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 503, headers: new Headers(), body: { cancel: async () => { canceled += 1; } }, json: async () => ({ error: "retry" }) };
      return Response.json({ versions: [] });
    }
  });
  await retrying.listVersions("publication");
  assert.equal(canceled, 1);
});

test("Worker uploads run four at a time and checkpoint merged completed paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-parallel-upload-"));
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => fs.writeFile(path.join(root, `file-${index}.txt`), `${index}`)));
    let active = 0;
    let peak = 0;
    const checkpoints = [];
    const client = createWorkerClient({
      origin: "https://worker.example", ownerId: "owner", token: "token", retries: 0,
      fetchImpl: async (url, options = {}) => {
        if (options.method === "PUT") {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return Response.json({ uploaded: true });
        }
        if (url.includes("upload-sessions") && options.method === "POST" && !url.includes("complete")) return Response.json({ sessionId: "session", publicationId: "publication", versionId: "version", slug: "slug" });
        if (url.includes("/complete")) return Response.json({ status: "complete" });
        if (url.includes("/activate")) return Response.json({ state: "published" });
        throw new Error(`unexpected ${url}`);
      }
    });
    await client.publish({ rootDir: root, title: "parallel", checkpoint: async (value) => checkpoints.push(value) });
    assert.equal(peak, 4);
    assert.deepEqual(checkpoints.slice(1).map((checkpoint) => checkpoint.uploadedPaths.length), [4, 8]);
    assert.equal(new Set(checkpoints.at(-1).uploadedPaths).size, 8);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Worker upload resumes without re-uploading checkpointed paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-resume-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    await fs.writeFile(path.join(root, "b.txt"), "b");
    const uploaded = [];
    const client = createWorkerClient({
      origin: "https://worker.example", ownerId: "owner", token: "token", retries: 0,
      fetchImpl: async (url, options = {}) => {
        if (options.method === "PUT") { uploaded.push(decodeURIComponent(url.split("/").at(-1))); return Response.json({ uploaded: true }); }
        if (url.includes("/complete")) return Response.json({ status: "complete" });
        if (url.includes("/activate")) return Response.json({ state: "published" });
        throw new Error(`unexpected ${url}`);
      }
    });
    await client.publish({ rootDir: root, title: "resume", operation: { idempotencyKey: "resume", workerSessionId: "session", workerPublicationId: "publication", workerVersionId: "version", uploadedPaths: ["a.txt"] } });
    assert.deepEqual(uploaded, ["b.txt"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed access-policy step prevents activation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-policy-"));
  const requests = [];
  try {
    await fs.writeFile(path.join(root, "index.html"), "hello");
    const client = createWorkerClient({
      origin: "https://worker.example", ownerId: "owner", token: "token", retries: 0,
      fetchImpl: async (url, options = {}) => {
        requests.push(url);
        if (options.method === "PUT") return Response.json({ uploaded: true });
        if (url.includes("/complete")) return Response.json({ status: "complete" });
        throw new Error(`unexpected request ${url}`);
      }
    });
    await assert.rejects(client.publish({
      rootDir: root, title: "Test", operation: { idempotencyKey: "stable-key", workerSessionId: "session", workerPublicationId: "pub", workerVersionId: "ver" },
      beforeActivate: async () => { throw new Error("policy failed"); }
    }), /policy failed/);
    assert.equal(requests.some((url) => url.includes("/activate")), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("rollback keeps its journal and prior durable version when the local save fails, then replays", async () => {
  const publication = { token: "local", slug: "local", target: { backend: "workers", profileId: "profile_123", publicationId: "remote", activeVersionId: "old" } };
  const report = { id: "report" };
  const operations = [];
  let failSave = true;
  const keys = [];
  const store = {
    async init() {}, findPublication: () => ({ report, publication }),
    listOperations: () => operations,
    async beginOperations(entries) { operations.splice(0, operations.length, ...entries); },
    async syncSnapshot() { if (failSave) { publication.target.activeVersionId = "old"; throw new Error("save failed"); } },
    async clearOperation() { operations.splice(0); },
    async recordOperationFailure(entry) { operations.splice(0, operations.length, entry); }
  };
  const configStore = { async init() {}, workerClient: async () => ({ client: { rollback: async (_publication, _version, key) => { keys.push(key); return {}; } } }) };
  await assert.rejects(rollbackWorkerPublication({ token: "local", versionId: "new", store, configStore }), /save failed/);
  assert.equal(publication.target.activeVersionId, "old", "the prior durable version survives the failed local save");
  const firstKey = operations[0].idempotencyKey;
  failSave = false;
  await rollbackWorkerPublication({ token: "local", versionId: "new", store, configStore });
  assert.equal(publication.target.activeVersionId, "new");
  assert.deepEqual(keys, [firstKey, firstKey]);
  assert.equal(operations.length, 0);
});

test("Worker connect removes only its new credential when config persistence fails", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-connect-"));
  try {
    await fs.writeFile(path.join(dataDir, "config.json"), "{}");
    const store = createConfigStore({ dataDir, atomicWriteJsonImpl: async () => { throw new Error("config write failed"); } });
    await store.init({ persist: false });
    await assert.rejects(store.connectWorker({
      origin: "https://worker.example", ownerId: "owner", token: "new-secret",
      fetchImpl: async () => Response.json({ apiVersion: 2, capabilities: ["publications.upload", "publications.access", "publications.versions"] })
    }), /config write failed/);
    assert.deepEqual(await readWorkerCredentials({ dataDir }), {});
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("Worker create publish reaches activation without a temporal-dead-zone failure", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-create-"));
  const report = path.join(dataDir, "report.html");
  try {
    await fs.writeFile(report, "<title>worker</title>");
    await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ workers: { activeProfileId: "profile_123", profiles: [{ profileId: "profile_123", origin: "http://127.0.0.1:8787", ownerId: "owner", allowLoopbackHttp: true }] } }));
    await fs.writeFile(path.join(dataDir, WORKER_CREDENTIAL_FILE), JSON.stringify({ profile_123: "secret" }), { mode: 0o600 });
    const calls = [];
    const result = await publishReportSnapshot({
      backend: "workers", path: report, dataDir, routeToDaemon: false,
      workerFetchImpl: async (url, options = {}) => {
        calls.push(`${options.method || "GET"} ${url}`);
        if (url.endsWith("/v1/status")) return Response.json({ apiVersion: 2, capabilities: ["publications.upload", "publications.access", "publications.versions"] });
        if (url.includes("upload-sessions") && options.method === "POST" && !url.includes("complete")) return Response.json({ sessionId: "session", publicationId: "publication", versionId: "version", slug: "worker-abc" });
        if (options.method === "PUT") return Response.json({ uploaded: true });
        if (url.includes("/complete")) return Response.json({ status: "complete" });
        if (url.includes("/activate")) return Response.json({ publicationId: "publication", versionId: "version", state: "published" });
        throw new Error(`unexpected ${options.method} ${url}`);
      }
    });
    assert.equal(result.url, "http://127.0.0.1:8787/p/worker-abc/");
    assert.ok(calls.some((call) => call.includes("/activate")));
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("a live daemon owns a Worker folder publish instead of rejecting the held workspace lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-live-daemon-"));
  const dataDir = path.join(root, "data");
  const folder = path.join(root, "folder");
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "index.html"), "<h1>daemon</h1>");
    await fs.writeFile(path.join(folder, "asset.txt"), "asset");
    await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ workers: { activeProfileId: "profile_123", profiles: [{ profileId: "profile_123", origin: "http://127.0.0.1:8787", ownerId: "owner", allowLoopbackHttp: true }] } }));
    await fs.writeFile(path.join(dataDir, WORKER_CREDENTIAL_FILE), JSON.stringify({ profile_123: "secret" }), { mode: 0o600 });
    const requests = [];
    const workerFetchImpl = async (url, options = {}) => {
      requests.push(`${options.method || "GET"} ${url}`);
      if (url.endsWith("/v1/status")) return Response.json({ apiVersion: 2, capabilities: ["publications.upload", "publications.access", "publications.versions"] });
      if (url.includes("upload-sessions") && options.method === "POST" && !url.includes("complete")) return Response.json({ sessionId: "session", publicationId: "publication", versionId: "version", slug: "daemon-slug" });
      if (options.method === "PUT") return Response.json({ uploaded: true });
      if (url.includes("/complete")) return Response.json({ status: "complete" });
      if (url.includes("/activate")) return Response.json({ publicationId: "publication", versionId: "version", state: "published" });
      throw new Error(`unexpected ${options.method} ${url}`);
    };
    const runtime = await startServers({ adminPort: 0, publicPort: 0, dataDir, staticDir: path.resolve("public"), fetchImpl: workerFetchImpl });
    try {
      const result = await publishReportSnapshot({ path: folder, backend: "workers", dataDir });
      assert.equal(result.backend, "workers");
      assert.equal(result.url, "http://127.0.0.1:8787/p/daemon-slug/");
      assert.ok(runtime.store.findPublication(result.token));
      assert.ok(requests.some((request) => request.includes("upload-sessions")));
    } finally { await runtime.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
