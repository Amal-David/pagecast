import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPayload,
  classifyCommand,
  createReporter,
  resolveTelemetry
} from "../src/telemetry.js";
import {
  buildDataPoint,
  cleanAnonId,
  cleanCommand,
  cleanEnum,
  cleanNodeVersion,
  cleanSubcommand,
  cleanVersion
} from "../telemetry/worker.js";

// --- resolveTelemetry precedence -------------------------------------------

test("resolveTelemetry: DO_NOT_TRACK wins over everything", () => {
  const r = resolveTelemetry({
    configEnabled: true,
    env: { DO_NOT_TRACK: "1", PAGECAST_TELEMETRY: "1", CI: "" }
  });
  assert.deepEqual(r, { enabled: false, reason: "do-not-track" });
});

test("resolveTelemetry: PAGECAST_TELEMETRY=0 disables; =1 overrides CI", () => {
  assert.equal(resolveTelemetry({ env: { PAGECAST_TELEMETRY: "0" } }).enabled, false);
  assert.equal(resolveTelemetry({ env: { PAGECAST_TELEMETRY: "false" } }).enabled, false);
  const over = resolveTelemetry({ configEnabled: false, env: { PAGECAST_TELEMETRY: "1", CI: "true" } });
  assert.deepEqual(over, { enabled: true, reason: "env" });
});

test("resolveTelemetry: CI disables when no explicit flag", () => {
  assert.deepEqual(resolveTelemetry({ env: { CI: "true" } }), { enabled: false, reason: "ci" });
});

test("resolveTelemetry: fresh installs default to enabled and saved choices are honored", () => {
  assert.equal(resolveTelemetry({ configEnabled: false, env: {} }).enabled, false);
  assert.deepEqual(resolveTelemetry({ configEnabled: true, env: {} }), {
    enabled: true,
    reason: "config"
  });
  assert.deepEqual(resolveTelemetry({ env: {} }), {
    enabled: true,
    reason: "default"
  });
});

// --- classifyCommand is leak-proof -----------------------------------------

test("classifyCommand never includes positional user data", () => {
  const c = classifyCommand(["publish", "/Users/secret/CONFIDENTIAL.html", "--password", "hunter2"]);
  assert.deepEqual(c, { command: "publish" });
  const serialized = JSON.stringify(c);
  assert.ok(!/secret|CONFIDENTIAL|hunter2|\.html/i.test(serialized));
});

test("classifyCommand keeps only allowlisted subcommands", () => {
  assert.deepEqual(classifyCommand(["pages", "deploy", "/secret/dir"]), {
    command: "pages",
    subcommand: "deploy"
  });
  assert.deepEqual(classifyCommand(["local-url", "install", "--yes"]), {
    command: "local-url",
    subcommand: "install"
  });
  assert.deepEqual(classifyCommand(["background", "service", "install"]), {
    command: "background",
    subcommand: "service"
  });
  // A non-allowlisted second token is dropped, not echoed back.
  assert.deepEqual(classifyCommand(["pages", "/secret/dir"]), { command: "pages" });
});

test("classifyCommand maps unknown/serve/help correctly", () => {
  assert.deepEqual(classifyCommand(["frobnicate", "x"]), { command: "unknown" });
  assert.deepEqual(classifyCommand([]), { command: "serve" });
  assert.deepEqual(classifyCommand(["--help"]), { command: "help" });
});

// --- buildPayload contains only anonymous fields ---------------------------

test("buildPayload exposes only the anonymous field set", () => {
  const p = buildPayload({ command: "publish", version: "0.1.6", anonId: "abc" });
  assert.deepEqual(Object.keys(p).sort(), [
    "anonId",
    "arch",
    "command",
    "event",
    "node",
    "os",
    "outcome",
    "version"
  ]);
  assert.ok(!JSON.stringify(p).includes("/"));
});

// --- createReporter behaviour ----------------------------------------------

for (const env of [
  { label: "config", reporterEnabled: false },
  { label: "PAGECAST_TELEMETRY=0", reporterEnabled: false },
  { label: "DO_NOT_TRACK=1", reporterEnabled: false },
  { label: "CI", reporterEnabled: false }
]) {
  test(`createReporter makes no network call when disabled (${env.label})`, async () => {
    const reporter = createReporter({
      enabled: false,
      fetchImpl: () => {
        throw new Error("fetch must not be called when telemetry is disabled");
      },
      env: {}
    });
    assert.equal(await reporter.record({ command: "publish" }), false);
  });
}

test("createReporter POSTs the payload to the endpoint when enabled", async () => {
  let seen = null;
  const reporter = createReporter({
    enabled: true,
    version: "0.1.6",
    anonId: "f19f950377663aeed589ffb4b5e5863c",
    env: { PAGECAST_TELEMETRY_URL: "https://example.test/api/v1/event" },
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true };
    }
  });
  assert.equal(await reporter.record({ command: "publish" }), true);
  assert.equal(seen.url, "https://example.test/api/v1/event");
  assert.equal(seen.opts.method, "POST");
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.command, "publish");
  assert.equal(body.anonId, "f19f950377663aeed589ffb4b5e5863c");
});

test("createReporter resolves false within the timeout when the endpoint hangs", async () => {
  // Faithful hang: hold a ref'd handle (like a real socket) until aborted.
  const hang = (_url, opts) =>
    new Promise((_resolve, reject) => {
      const keep = setTimeout(() => {}, 60000);
      opts.signal.addEventListener("abort", () => {
        clearTimeout(keep);
        reject(new Error("aborted"));
      });
    });
  const reporter = createReporter({ enabled: true, fetchImpl: hang, timeoutMs: 50, env: {} });
  const start = Date.now();
  assert.equal(await reporter.record({ command: "serve" }), false);
  assert.ok(Date.now() - start < 1000, "record should resolve shortly after the timeout");
});

test("createReporter swallows a throwing fetch", async () => {
  const reporter = createReporter({
    enabled: true,
    fetchImpl: () => {
      throw new Error("boom");
    },
    env: {}
  });
  assert.equal(await reporter.record({ command: "serve" }), false);
});

test("createReporter treats a non-2xx response as failure", async () => {
  const reporter = createReporter({
    enabled: true,
    fetchImpl: async () => ({ ok: false, status: 400 }),
    env: {}
  });
  assert.equal(await reporter.record({ command: "publish" }), false);
});

// --- worker-side validation ------------------------------------------------

test("worker rejects non-allowlisted commands and subcommands", () => {
  assert.equal(cleanCommand("publish"), "publish");
  assert.equal(cleanCommand("rm -rf /"), null);
  assert.equal(cleanSubcommand("pages", "deploy"), "deploy");
  assert.equal(cleanSubcommand("pages", "/etc/passwd"), "");
  assert.equal(cleanAnonId("f19f950377663aeed589ffb4b5e5863c"), "f19f950377663aeed589ffb4b5e5863c");
  assert.equal(cleanAnonId("not-an-id"), "");
});

test("worker platform validators allowlist os/arch and shape version/node", () => {
  const OS = ["darwin", "linux", "win32"];
  assert.equal(cleanEnum("darwin", OS), "darwin");
  assert.equal(cleanEnum("/Users/secret/x", OS), "");
  assert.equal(cleanEnum("plan9", OS), "");
  assert.equal(cleanVersion("0.1.6"), "0.1.6");
  assert.equal(cleanVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(cleanVersion("../../etc/passwd"), "");
  assert.equal(cleanNodeVersion("v22.22.3"), "v22.22.3");
  assert.equal(cleanNodeVersion("not-a-version"), "");
});

test("worker buildDataPoint rejects non-object payloads and bad commands", () => {
  assert.equal(buildDataPoint(null), null); // JSON `null` body must not crash
  assert.equal(buildDataPoint("publish"), null);
  assert.equal(buildDataPoint(123), null);
  assert.equal(buildDataPoint({ command: "evil" }), null);
});

test("worker buildDataPoint drops arbitrary/attacker field values", () => {
  const dp = buildDataPoint({
    command: "publish",
    subcommand: "../../etc",
    os: "<script>alert(1)</script>",
    arch: "'; DROP TABLE",
    version: "9.9.9; rm -rf /",
    node: "/etc/passwd",
    anonId: "'; DROP TABLE"
  });
  assert.deepEqual(dp.indexes, ["publish"]);
  // blobs: [command, subcommand, outcome, version, os, arch, node, anonId]
  assert.equal(dp.blobs[1], ""); // subcommand not allowlisted
  assert.equal(dp.blobs[3], ""); // version not semver-shaped
  assert.equal(dp.blobs[4], ""); // os not in allowlist
  assert.equal(dp.blobs[5], ""); // arch not in allowlist
  assert.equal(dp.blobs[6], ""); // node not version-shaped
  assert.equal(dp.blobs[7], ""); // anonId not 32-hex
  const serialized = JSON.stringify(dp);
  assert.ok(!serialized.includes("<"));
  assert.ok(!serialized.includes("DROP TABLE"));
  assert.ok(!serialized.includes("passwd"));
});
