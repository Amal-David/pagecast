import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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

test("one recovery leader cannot delete a replacement created by a poised contender", { timeout: 5000 }, async () => {
  const dataDir = await makeTempDir();
  const stalePid = 42101;
  const crashed = new WorkspaceLease(dataDir, {
    pid: stalePid,
    isPidAlive: async () => true
  });
  await crashed.acquire({ capability: "crashed-capability" });

  const contenderReady = deferred();
  const staleLeaseUnlinked = deferred();
  const contenderAcquired = deferred();
  let contenderPaused = false;
  const contender = new WorkspaceLease(dataDir, {
    pid: 42104,
    isPidAlive: async () => true,
    async onTransition(stage) {
      if (stage === "before-lease-create" && !contenderPaused) {
        contenderPaused = true;
        contenderReady.resolve();
        await staleLeaseUnlinked.promise;
      }
    }
  });
  const contenderAttempt = contender.acquire({ capability: "poised-contender" }).then(
    (descriptor) => {
      contenderAcquired.resolve(descriptor);
      return descriptor;
    },
    (error) => {
      contenderAcquired.reject(error);
      throw error;
    }
  );
  await contenderReady.promise;

  let staleUnlinks = 0;
  const recoveryOptions = (pid) => ({
    pid,
    isPidAlive: async (candidatePid) => candidatePid !== stalePid,
    async onTransition(stage) {
      if (stage === "stale-lease-unlinked") {
        staleUnlinks += 1;
        staleLeaseUnlinked.resolve();
        await contenderAcquired.promise;
      }
    }
  });
  const first = new WorkspaceLease(dataDir, recoveryOptions(42102));
  const second = new WorkspaceLease(dataDir, recoveryOptions(42103));
  const recoveryOutcomes = Promise.allSettled([
    first.acquire({ capability: "first-recoverer" }),
    second.acquire({ capability: "second-recoverer" })
  ]);

  const descriptor = await contenderAttempt;
  const outcomes = await recoveryOutcomes;
  assert.equal(staleUnlinks, 1, "one generation elects exactly one destructive recovery leader");
  assert.equal(descriptor.pid, contender.pid);
  assert.equal(descriptor.capability, "poised-contender");
  assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.reason.code, "PAGECAST_WORKSPACE_BUSY");
  }

  const savedLease = JSON.parse(
    await fs.readFile(path.join(dataDir, WORKSPACE_LEASE_FILENAME), "utf8")
  );
  assert.equal(savedLease.pid, descriptor.pid);
  assert.equal(savedLease.leaseId, descriptor.leaseId);
  assert.deepEqual(await readRuntimeDescriptor(dataDir), descriptor);
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".recovery.")),
    []
  );

  await contender.release();
});

test("a dead recovery leader has exactly one append-only takeover", async () => {
  const dataDir = await makeTempDir();
  const crashed = new WorkspaceLease(dataDir, {
    pid: 42201,
    isPidAlive: async () => true
  });
  await crashed.acquire({ capability: "crashed-capability" });
  const leasePath = path.join(dataDir, WORKSPACE_LEASE_FILENAME);
  const staleLease = JSON.parse(await fs.readFile(leasePath, "utf8"));
  const generation = createHash("sha256").update(staleLease.leaseId).digest("hex");
  const orphanPath = `${leasePath}.recovery.${generation}.root`;
  await fs.writeFile(
    orphanPath,
    `${JSON.stringify(
      {
        version: 1,
        leaseId: staleLease.leaseId,
        predecessorId: null,
        pid: 42202,
        abandoned: false,
        recoveryId: "a".repeat(32)
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  const recovered = new WorkspaceLease(dataDir, {
    pid: 42203,
    isPidAlive: async (pid) => pid === 42203
  });
  const descriptor = await recovered.acquire({ capability: "orphan-recovered" });

  assert.equal(descriptor.pid, 42203);
  assert.equal((await readRuntimeDescriptor(dataDir)).capability, "orphan-recovered");
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".recovery.")),
    []
  );
  await recovered.release();
});

test("a failed recovery keeps its claim immutable until one child takes over", { timeout: 5000 }, async () => {
  const dataDir = await makeTempDir();
  const stalePid = 42301;
  const failedRecoveryPid = 42302;
  const delayedRecoveryPid = 42303;
  const takeoverPid = 42304;
  const crashed = new WorkspaceLease(dataDir, {
    pid: stalePid,
    isPidAlive: async () => true
  });
  await crashed.acquire({ capability: "crashed-capability" });

  const rootClaimPublished = deferred();
  const delayedReadRoot = deferred();
  const resumeDelayed = deferred();
  const failedRecovery = new WorkspaceLease(dataDir, {
    pid: failedRecoveryPid,
    isPidAlive: async (pid) => pid === failedRecoveryPid,
    async onTransition(stage) {
      if (stage === "before-stale-lease-cleanup") {
        rootClaimPublished.resolve();
        await delayedReadRoot.promise;
        throw new Error("simulated pre-unlink recovery failure");
      }
    }
  });
  const failedOutcome = Promise.allSettled([
    failedRecovery.acquire({ capability: "failed-recovery" })
  ]);
  await rootClaimPublished.promise;

  const delayedRecovery = new WorkspaceLease(dataDir, {
    pid: delayedRecoveryPid,
    isPidAlive: async (pid) => {
      if (pid === stalePid) {
        return false;
      }
      if (pid === failedRecoveryPid) {
        delayedReadRoot.resolve();
        await resumeDelayed.promise;
        return false;
      }
      return true;
    }
  });
  const delayedOutcome = Promise.allSettled([
    delayedRecovery.acquire({ capability: "delayed-recovery" })
  ]);
  await delayedReadRoot.promise;
  const [failed] = await failedOutcome;
  assert.equal(failed.status, "rejected");
  assert.match(failed.reason.message, /simulated pre-unlink recovery failure/);
  assert.equal(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".recovery.")).length,
    2,
    "a failed root claim survives and publishes one immutable abandonment marker"
  );

  const takeoverReady = deferred();
  const resumeTakeover = deferred();
  const takeover = new WorkspaceLease(dataDir, {
    pid: takeoverPid,
    isPidAlive: async (pid) => ![stalePid, failedRecoveryPid].includes(pid),
    async onTransition(stage) {
      if (stage === "before-stale-lease-cleanup") {
        takeoverReady.resolve();
        await resumeTakeover.promise;
      }
    }
  });
  const takeoverAttempt = takeover.acquire({ capability: "takeover-recovery" });
  await takeoverReady.promise;
  assert.equal(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".recovery.")).length,
    3,
    "the takeover appends after the marker instead of reopening either earlier slot"
  );

  resumeDelayed.resolve();
  const [delayed] = await delayedOutcome;
  assert.equal(delayed.status, "rejected");
  assert.equal(delayed.reason.code, "PAGECAST_WORKSPACE_BUSY");
  resumeTakeover.resolve();

  const descriptor = await takeoverAttempt;
  assert.equal(descriptor.pid, takeoverPid);
  assert.deepEqual(await readRuntimeDescriptor(dataDir), descriptor);
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".recovery.")),
    []
  );
  await takeover.release();
});

test("a post-link claim failure hands off so the same process can retry", async () => {
  const dataDir = await makeTempDir();
  const stalePid = 42401;
  const recoveryPid = 42402;
  const crashed = new WorkspaceLease(dataDir, {
    pid: stalePid,
    isPidAlive: async () => true
  });
  await crashed.acquire({ capability: "crashed-capability" });

  const failedRecovery = new WorkspaceLease(dataDir, {
    pid: recoveryPid,
    isPidAlive: async (pid) => pid === recoveryPid,
    async onTransition(stage) {
      if (stage === "recovery-claim-linked") {
        throw Object.freeze(new Error("simulated post-link claim failure"));
      }
    }
  });
  await assert.rejects(
    () => failedRecovery.acquire({ capability: "failed-recovery" }),
    /simulated post-link claim failure/
  );

  const retry = new WorkspaceLease(dataDir, {
    pid: recoveryPid,
    isPidAlive: async (pid) => pid === recoveryPid
  });
  const descriptor = await retry.acquire({ capability: "same-process-retry" });

  assert.equal(descriptor.pid, recoveryPid);
  assert.equal(descriptor.capability, "same-process-retry");
  assert.deepEqual(await readRuntimeDescriptor(dataDir), descriptor);
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".recovery.")),
    []
  );
  await retry.release();
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
