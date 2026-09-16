import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createWorkerClient } from "../src/worker-client.js";

const workerDir = fileURLToPath(new URL("../worker/", import.meta.url));
const wrangler = path.join(workerDir, "node_modules/wrangler/bin/wrangler.js");
const scratch = await mkdtemp(path.join(tmpdir(), "pagecast-real-worker-"));
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
const bootstrap = randomBytes(32).toString("hex");
const secrets = ["TOKEN_HASH_KEY", "COOKIE_SIGNING_KEY", "ANALYTICS_HMAC_KEY", "WEBHOOK_SIGNING_KEY"];
let child;
try {
  const migration = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", scratch], { cwd: workerDir, env, encoding: "utf8" });
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  const args = [wrangler, "dev", "--ip", "127.0.0.1", "--port", "8793", "--persist-to", scratch, "--var", `ADMIN_TOKEN:${bootstrap}`];
  for (const name of secrets) args.push("--var", `${name}:${randomBytes(32).toString("hex")}`);
  child = spawn(process.execPath, args, { cwd: workerDir, env, stdio: ["ignore", "pipe", "pipe"] });
  // Drain output without printing generated credentials in Wrangler's binding table.
  child.stdout.resume();
  child.stderr.resume();
  const origin = "http://127.0.0.1:8793";
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Worker development server exited before readiness");
    try {
      const response = await fetch(`${origin}/v1/status`, { headers: { Authorization: `Bearer ${bootstrap}` }, signal: AbortSignal.timeout(1000) });
      ready = response.ok;
      await response.body?.cancel();
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, "local Worker must authenticate this run's bootstrap credential");
  const response = await fetch(`${origin}/v1/owners/client-integration/tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrap}`, "Content-Type": "application/json", "Idempotency-Key": "integration-token" },
    body: JSON.stringify({ label: "Integration", scopes: ["status:read", "publications:read", "publications:write"], expiresAt: new Date(Date.now() + 3600_000).toISOString() })
  });
  assert.equal(response.status, 201);
  const { token } = await response.json();
  const site = path.join(scratch, "site");
  await mkdir(site);
  await writeFile(path.join(site, "index.html"), '<!doctype html><html><body><h1 id="result">waiting</h1><script type="module" src="./app.mjs"></script></body></html>');
  await writeFile(path.join(site, "app.mjs"), 'document.querySelector("#result").textContent="module executed";');
  await writeFile(path.join(site, "manifest.json"), '{"name":"Application manifest"}');
  await writeFile(path.join(site, "Q3 résumé.txt"), "unicode asset");
  const client = createWorkerClient({ origin, ownerId: "client-integration", token });
  const result = await client.publish({ rootDir: site, title: "Real client app", slug: "integration", mode: "new-link", linkKind: "unlisted" });
  const base = `${origin}/p/${result.slug}/`;
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /app\.mjs/);
  const script = await fetch(`${base}app.mjs`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^(text|application)\/javascript/);
  assert.equal(script.headers.get("x-content-type-options"), "nosniff");
  assert.doesNotMatch(script.headers.get("content-disposition") || "", /attachment/);
  assert.match(await script.text(), /module executed/);
  const manifest = await fetch(`${base}manifest.json`);
  assert.deepEqual(await manifest.json(), { name: "Application manifest" });
  const asset = await fetch(`${base}${encodeURIComponent("Q3 résumé.txt")}`);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "unicode asset");
  console.log("Real local client → Worker upload → activation → HTML/module/manifest/Unicode delivery passed.");
  if (process.argv.includes("--browser")) {
    console.log(`Browser fixture: ${base}`);
    console.log("Press Enter after inspecting the browser fixture to stop the server.");
    process.stdin.resume();
    await once(process.stdin, "data");
    process.stdin.pause();
  }
} finally {
  if (child && child.exitCode === null) {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await closed;
  }
  await rm(scratch, { recursive: true, force: true });
}
