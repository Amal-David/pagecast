import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUNTIME_DESCRIPTOR_FILENAME,
  WORKSPACE_LEASE_FILENAME,
  WorkspaceLease,
  atomicWriteJson,
  readRuntimeDescriptor,
  tryInvokeLiveCommand
} from "../src/state-coordinator.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-state-coordinator-"));
}

function permissions(mode) {
  return mode & 0o777;
}

test("atomicWriteJson replaces valid JSON atomically and restricts directory/file permissions", async () => {
  const root = await makeTempDir();
  const dataDir = path.join(root, "private-state");
  const file = path.join(dataDir, "state.json");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o755 });
  await fs.writeFile(file, '{"old":true}\n', { mode: 0o644 });

  await atomicWriteJson(file, { version: 2, reports: ["safe"] });

  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
    version: 2,
    reports: ["safe"]
  });
  if (process.platform !== "win32") {
    assert.equal(permissions((await fs.stat(dataDir)).mode), 0o700);
    assert.equal(permissions((await fs.stat(file)).mode), 0o600);
  }
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".tmp")),
    []
  );
});

test("concurrent atomic writes never expose corrupt JSON and failed serialization cleans temp files", async () => {
  const dataDir = await makeTempDir();
  const file = path.join(dataDir, "state.json");
  const candidates = Array.from({ length: 20 }, (_, index) => ({ index, body: `value-${index}` }));

  await Promise.all(candidates.map((candidate) => atomicWriteJson(file, candidate)));
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(candidates.some((candidate) => candidate.index === saved.index && candidate.body === saved.body));

  const circular = {};
  circular.self = circular;
  await assert.rejects(() => atomicWriteJson(file, circular), /circular|cyclic/i);
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".tmp")),
    []
  );
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), saved);
});

test("runtime descriptor corruption is visible while a missing descriptor means no daemon", async () => {
  const dataDir = await makeTempDir();
  assert.equal(await readRuntimeDescriptor(dataDir), null);

  await fs.writeFile(path.join(dataDir, RUNTIME_DESCRIPTOR_FILENAME), "{bad-json", "utf8");
  await assert.rejects(
    () => readRuntimeDescriptor(dataDir),
    (error) => error?.code === "PAGECAST_RUNTIME_CORRUPT"
  );
});

test("a corrupt lease is never guessed stale or removed", async () => {
  const dataDir = await makeTempDir();
  const leasePath = path.join(dataDir, WORKSPACE_LEASE_FILENAME);
  await fs.writeFile(leasePath, "{incomplete", "utf8");
  let livenessChecks = 0;
  const lease = new WorkspaceLease(dataDir, {
    pid: 40501,
    isPidAlive: async () => {
      livenessChecks += 1;
      return false;
    }
  });

  await assert.rejects(
    () => lease.acquire({ capability: "must-not-recover" }),
    (error) => error?.code === "PAGECAST_LEASE_CORRUPT"
  );
  assert.equal(livenessChecks, 0, "an unknown owner cannot be declared dead");
  assert.equal(await fs.readFile(leasePath, "utf8"), "{incomplete");
});

test("a live workspace lease fails visibly and concurrent acquisition has one winner", async () => {
  const dataDir = await makeTempDir();
  const first = new WorkspaceLease(dataDir, {
    pid: 41001,
    isPidAlive: async () => true
  });
  const second = new WorkspaceLease(dataDir, {
    pid: 41002,
    isPidAlive: async () => true
  });

  const outcomes = await Promise.allSettled([
    first.acquire({ capability: "first-capability" }),
    second.acquire({ capability: "second-capability" })
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = outcomes.find((entry) => entry.status === "rejected");
  assert.equal(rejected.reason.code, "PAGECAST_WORKSPACE_BUSY");

  const descriptor = await readRuntimeDescriptor(dataDir);
  assert.ok([41001, 41002].includes(descriptor.pid));
  assert.equal(descriptor.adminUrl, "", "acquisition may publish a pending runtime URL");
  if (process.platform !== "win32") {
    assert.equal(
      permissions((await fs.stat(path.join(dataDir, WORKSPACE_LEASE_FILENAME))).mode),
      0o600
    );
    assert.equal(
      permissions((await fs.stat(path.join(dataDir, RUNTIME_DESCRIPTOR_FILENAME))).mode),
      0o600
    );
    assert.equal(permissions((await fs.stat(dataDir)).mode), 0o700);
  }

  await first.release();
  await second.release();
});

test("stale lease recovery occurs only after its recorded PID is confirmed dead", async () => {
  const dataDir = await makeTempDir();
  const crashed = new WorkspaceLease(dataDir, {
    pid: 42001,
    isPidAlive: async () => true
  });
  await crashed.acquire({
    adminUrl: "http://127.0.0.1:4173",
    capability: "crashed-capability"
  });

  const uncertain = new WorkspaceLease(dataDir, {
    pid: 42002,
    isPidAlive: async () => {
      throw new Error("liveness unavailable");
    }
  });
  await assert.rejects(() => uncertain.acquire({ capability: "uncertain" }), /liveness unavailable/);
  assert.equal((await readRuntimeDescriptor(dataDir)).pid, 42001);

  const recovered = new WorkspaceLease(dataDir, {
    pid: 42003,
    isPidAlive: async (pid) => pid === 42003
  });
  const acquired = await recovered.acquire({ capability: "recovered-capability" });
  assert.equal(acquired.pid, 42003);
  assert.equal((await readRuntimeDescriptor(dataDir)).capability, "recovered-capability");

  await recovered.release();
  assert.equal(await readRuntimeDescriptor(dataDir), null);
});

test("the lease can atomically publish its actual bound URL after acquisition", async () => {
  const dataDir = await makeTempDir();
  const lease = new WorkspaceLease(dataDir, {
    pid: 43001,
    isPidAlive: async () => true
  });
  await lease.acquire({ capability: "initial-capability", role: "daemon" });

  await assert.rejects(
    () =>
      tryInvokeLiveCommand(dataDir, "reports.list", {}, {
        isPidAlive: async () => true,
        fetchImpl: async () => {
          throw new Error("pending runtime must not fetch");
        }
      }),
    (error) => error?.code === "PAGECAST_DAEMON_NOT_READY"
  );

  const updated = await lease.updateRuntime({
    adminUrl: "http://127.0.0.1:43123"
  });
  assert.equal(updated.adminUrl, "http://127.0.0.1:43123");
  assert.equal(updated.capability, "initial-capability");
  assert.deepEqual(await readRuntimeDescriptor(dataDir), updated);

  await assert.rejects(
    () => lease.updateRuntime({ adminUrl: "https://remote.example" }),
    /loopback|local/i
  );
  assert.deepEqual(await readRuntimeDescriptor(dataDir), updated);

  await assert.rejects(
    () =>
      new WorkspaceLease(dataDir, { pid: 43002 }).updateRuntime({
        adminUrl: "http://127.0.0.1:49999"
      }),
    (error) => error?.code === "PAGECAST_LEASE_NOT_HELD"
  );
  await lease.release();
});

test("tryInvokeLiveCommand routes authenticated JSON and returns null only without a live daemon", async () => {
  const dataDir = await makeTempDir();
  let fetchCalls = 0;
  assert.equal(
    await tryInvokeLiveCommand(dataDir, "reports.list", {}, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      }
    }),
    null
  );
  assert.equal(fetchCalls, 0);

  const lease = new WorkspaceLease(dataDir, {
    pid: 44001,
    isPidAlive: async () => true
  });
  await lease.acquire({
    adminUrl: "http://127.0.0.1:44001",
    capability: "private-command-capability"
  });

  const calls = [];
  const result = await tryInvokeLiveCommand(
    dataDir,
    "reports.publish",
    { reportId: "report-1" },
    {
      isPidAlive: async () => true,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ ok: true, publication: "link-1" });
      }
    }
  );
  assert.deepEqual(result, { ok: true, publication: "link-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:44001/api/command");
  assert.equal(
    new Headers(calls[0].init.headers).get("X-Pagecast-Capability"),
    "private-command-capability"
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    command: "reports.publish",
    payload: { reportId: "report-1" }
  });

  assert.equal(
    await tryInvokeLiveCommand(dataDir, "reports.list", {}, {
      isPidAlive: async () => false,
      fetchImpl: async () => {
        throw new Error("dead daemon must not be contacted");
      }
    }),
    null
  );

  await assert.rejects(
    () =>
      tryInvokeLiveCommand(dataDir, "reports.list", {}, {
        isPidAlive: async () => true,
        fetchImpl: async () => new Response("daemon rejected command", { status: 503 })
      }),
    (error) => error?.code === "PAGECAST_COMMAND_FAILED" && error?.statusCode === 503
  );
  await assert.rejects(
    () =>
      tryInvokeLiveCommand(dataDir, "reports.list", {}, {
        isPidAlive: async () => true,
        fetchImpl: async () => {
          throw new Error("connection refused");
        }
      }),
    (error) => error?.code === "PAGECAST_COMMAND_UNREACHABLE"
  );
  await lease.release();
});
