import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Wrangler config declares the Worker-owned storage and runtime bindings", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  for (const binding of ["DB", "PUBLICATIONS", "PUBLICATION_OWNER", "JOBS", "ASSETS"]) {
    assert.match(config, new RegExp(`\\\"${binding}\\\"`));
  }
  assert.match(config, /dead_letter_queue/);
  assert.match(config, /\"crons\"/);
  assert.match(config, /\"observability\"/);
  assert.match(config, /\"exports\"/);
  assert.doesNotMatch(config, /00000000-0000-0000-0000-000000000000/);
  assert.doesNotMatch(config, /\"bucket_name\"/);
});

test("Worker package stays isolated from the parent repository", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");

  for (const version of Object.values(manifest.devDependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  }
  assert.equal(JSON.stringify(manifest).includes("../"), false);
  assert.match(ignore, /^\.dev\.vars$/m);
});

test("package scripts and secret template support deploy-button provisioning", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const secrets = await readFile(new URL("../.dev.vars.example", import.meta.url), "utf8");

  assert.match(manifest.scripts["db:migrate:local"], /migrations apply DB --local/);
  assert.match(manifest.scripts["db:migrate:remote"], /migrations apply DB --remote/);
  assert.match(manifest.scripts.deploy, /db:migrate:remote/);
  for (const name of [
    "ADMIN_TOKEN",
    "TOKEN_HASH_KEY",
    "ANALYTICS_HMAC_KEY",
    "COOKIE_SIGNING_KEY",
    "WEBHOOK_SIGNING_KEY",
  ]) {
    assert.match(secrets, new RegExp(`^${name}=`, "m"));
  }
});
