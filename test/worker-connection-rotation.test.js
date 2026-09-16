import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigStore } from "../src/server.js";
import { readWorkerCredentials } from "../src/worker-client.js";

const capabilities = ["publications.upload", "publications.access", "publications.versions"];

function workerStatus(token) {
  return async (_url, options = {}) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return Response.json({ apiVersion: 2, capabilities, actor: "token", ownerId: "owner" });
  };
}

async function configure(dataDir, token = "old-credential") {
  const store = createConfigStore({ dataDir });
  await store.init();
  await store.connectWorker({
    origin: "https://worker.example",
    ownerId: "owner",
    token,
    fetchImpl: workerStatus(token)
  });
  return store;
}

test("credential rotation preserves the matching Worker profile used by existing publications", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-rotation-"));
  try {
    const store = await configure(dataDir);
    const before = store.get().workers;
    const profileId = before.activeProfileId;

    await store.connectWorker({
      origin: "https://worker.example",
      ownerId: "owner",
      token: "new-credential",
      fetchImpl: workerStatus("new-credential")
    });

    const after = store.get().workers;
    assert.equal(after.activeProfileId, profileId);
    assert.equal(after.profiles.length, 1);
    assert.equal(after.profiles[0].profileId, profileId);
    assert.deepEqual(await readWorkerCredentials({ dataDir }), { [profileId]: "new-credential" });
    const { client } = await store.workerClient(profileId, { fetchImpl: workerStatus("new-credential") });
    await client.capabilities();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("failed verification keeps the prior credential and profile usable", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-rotation-"));
  try {
    const store = await configure(dataDir);
    const profileId = store.get().workers.activeProfileId;

    await assert.rejects(
      store.connectWorker({
        origin: "https://worker.example",
        ownerId: "owner",
        token: "bad-credential",
        fetchImpl: async () => { throw new Error("credential rejected"); }
      }),
      /credential rejected/
    );

    assert.equal(store.get().workers.activeProfileId, profileId);
    assert.deepEqual(await readWorkerCredentials({ dataDir }), { [profileId]: "old-credential" });
    const { client } = await store.workerClient(profileId, { fetchImpl: workerStatus("old-credential") });
    await client.capabilities();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("rotation rejects another owner's token and bootstrap credentials before replacing the existing token", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-owner-"));
  try {
    const store = await configure(dataDir);
    const profileId = store.get().workers.activeProfileId;
    for (const identity of [{ actor: "token", ownerId: "other-owner" }, { actor: "bootstrap", ownerId: null }]) {
      await assert.rejects(store.connectWorker({
        origin: "https://worker.example", ownerId: "owner", token: "wrong-credential",
        fetchImpl: async () => Response.json({ apiVersion: 2, capabilities, ...identity })
      }), /scoped Worker token/);
      assert.deepEqual(await readWorkerCredentials({ dataDir }), { [profileId]: "old-credential" });
    }
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("failed profile persistence restores the prior usable credential", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-worker-rotation-"));
  try {
    const initial = await configure(dataDir);
    const profileId = initial.get().workers.activeProfileId;
    const failing = createConfigStore({ dataDir, atomicWriteJsonImpl: async () => { throw new Error("config write failed"); } });
    await failing.init({ persist: false });

    await assert.rejects(
      failing.connectWorker({
        origin: "https://worker.example",
        ownerId: "owner",
        token: "new-credential",
        fetchImpl: workerStatus("new-credential")
      }),
      /config write failed/
    );

    assert.equal(failing.get().workers.activeProfileId, profileId);
    assert.deepEqual(await readWorkerCredentials({ dataDir }), { [profileId]: "old-credential" });
    const { client } = await failing.workerClient(profileId, { fetchImpl: workerStatus("old-credential") });
    await client.capabilities();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
