import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pagecast-plugin-hooks-"));
}

function runNode(script, { args = [], cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, script), ...args], {
      cwd,
      env: { ...process.env, PAGECAST_TELEMETRY: "0" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function commandToken(message) {
  const match = message.match(/--path-token ([A-Za-z0-9._-]+)/);
  assert.ok(match, "hook output uses the opaque --path-token handoff");
  assert.match(match[1], /^pcp1\.[A-Za-z0-9_-]+$/);
  return match[1];
}

async function decodeToken(token) {
  const { decodePathToken } = await import("../src/path-token.js");
  return decodePathToken(token);
}

test("path tokens round-trip untrusted paths while positional paths remain supported", async () => {
  const { decodePathToken, encodePathToken, resolvePathArgument } = await import(
    "../src/path-token.js"
  );
  const untrustedPath = '/tmp/RAW_SENTINEL-$(touch owned)-`id`-"quote".html';
  const token = encodePathToken(untrustedPath);

  assert.match(token, /^pcp1\.[A-Za-z0-9_-]+$/);
  assert.equal(token.includes("RAW_SENTINEL"), false);
  assert.equal(decodePathToken(token), untrustedPath);
  assert.equal(resolvePathArgument({ positionalPath: untrustedPath }), untrustedPath);
  assert.equal(resolvePathArgument({ pathToken: token }), untrustedPath);
  assert.throws(
    () => resolvePathArgument({ positionalPath: untrustedPath, pathToken: token }),
    /either a positional path or --path-token/i
  );
  assert.throws(() => decodePathToken("not-a-pagecast-token"), /invalid path token/i);
});

test("PostToolUse hook emits no raw filename or shell-interpolated path", async (t) => {
  const cwd = await makeTempDir();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const basename = "report-RAW_SENTINEL-$(touch hook-owned)-`id`.html";
  const filePath = path.join(cwd, basename);
  await fs.writeFile(filePath, "<h1>Shareable report</h1>");

  const result = await runNode("plugin/hooks/detect-report.mjs", {
    cwd,
    input: {
      session_id: `post-${crypto.randomUUID()}`,
      cwd,
      tool_name: "Write",
      tool_input: { file_path: filePath }
    }
  });

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const message = payload.hookSpecificOutput.additionalContext;
  assert.equal(message.includes("RAW_SENTINEL"), false);
  assert.equal(message.includes("$(touch"), false);
  assert.equal(message.includes("`id`"), false);
  assert.equal(await decodeToken(commandToken(message)), filePath);
});

test("Stop hook reports fresh artifacts without emitting their names", async (t) => {
  const cwd = await makeTempDir();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const basename = "report-RAW_SENTINEL-$(touch stop-owned)-`id`.html";
  const filePath = path.join(cwd, basename);
  await fs.writeFile(filePath, `<h1>Shareable report</h1>${"x".repeat(220)}`);

  const result = await runNode("plugin/hooks/detect-artifacts-on-stop.mjs", {
    cwd,
    input: {
      session_id: `stop-${crypto.randomUUID()}`,
      cwd,
      stop_hook_active: false
    }
  });

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const message = payload.hookSpecificOutput.systemMessage;
  assert.equal(message.includes("RAW_SENTINEL"), false);
  assert.equal(message.includes("$(touch"), false);
  assert.equal(message.includes("`id`"), false);
  assert.equal(await decodeToken(commandToken(message)), filePath);
});

test("stale-goal Stop hook uses an opaque token instead of the configured path", async (t) => {
  const cwd = await makeTempDir();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const basename = "goal-RAW_SENTINEL-$(touch goal-owned)-`id`.md";
  const filePath = path.join(cwd, basename);
  await fs.mkdir(path.join(cwd, ".pagecast"), { recursive: true });
  await fs.writeFile(filePath, `# Goal\n${"x".repeat(220)}`);
  await fs.writeFile(
    path.join(cwd, ".pagecast", "config.json"),
    JSON.stringify({ goal: { file: filePath } })
  );
  const stale = new Date(Date.now() - 5 * 60 * 1000);
  await fs.utimes(filePath, stale, stale);

  const result = await runNode("plugin/hooks/detect-artifacts-on-stop.mjs", {
    cwd,
    input: {
      session_id: `goal-${crypto.randomUUID()}`,
      cwd,
      stop_hook_active: false
    }
  });

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const message = payload.hookSpecificOutput.systemMessage;
  assert.equal(message.includes("RAW_SENTINEL"), false);
  assert.equal(message.includes("$(touch"), false);
  assert.equal(message.includes("`id`"), false);
  assert.match(message, /goal publish --path-token/);
  assert.equal(await decodeToken(commandToken(message)), filePath);
});

test("CLI rejects a malformed --path-token before publishing", async (t) => {
  const cwd = await makeTempDir();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const result = await runNode("src/cli.js", {
    cwd,
    input: undefined,
    args: ["publish", "--path-token", "not-a-pagecast-token", "--json"]
  });

  assert.equal(result.code, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.code, "usage_error");
  assert.match(payload.error, /invalid path token/i);
});
