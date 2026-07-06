import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  PAGECAST_SYNC_MANIFEST_PATH,
  PBKDF2_ITERATIONS,
  isValidPasswordHash,
  makePasswordHash,
  passwordHashMatches,
  renderAuthMiddleware,
  renderRoutesJson
} from "../src/crypto.js";

// Write the generated middleware to a temp .mjs and import it so onRequest can
// be driven directly — Node 20 exposes crypto.subtle, atob, Request/Response,
// the same runtime surface the Cloudflare middleware relies on.
async function loadMiddleware(manifest, options) {
  const source = renderAuthMiddleware(manifest, options);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecast-mw-"));
  const file = path.join(dir, "_middleware.mjs");
  await fs.writeFile(file, source, "utf8");
  return import(pathToFileURL(file).href);
}

function basic(password, user = "user") {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

test("makePasswordHash is deterministic for a fixed salt and varies by salt", () => {
  const a = makePasswordHash("hunter2", { salt: "00112233445566778899aabbccddeeff" });
  const b = makePasswordHash("hunter2", { salt: "00112233445566778899aabbccddeeff" });
  assert.equal(a.hash, b.hash);
  assert.equal(a.iterations, PBKDF2_ITERATIONS);

  const c = makePasswordHash("hunter2"); // random salt
  const d = makePasswordHash("hunter2"); // random salt
  assert.notEqual(c.salt, d.salt);
  assert.notEqual(c.hash, d.hash);
});

test("makePasswordHash rejects an empty password", () => {
  assert.throws(() => makePasswordHash(""), /non-empty password/);
  assert.throws(() => makePasswordHash(null), /non-empty password/);
});

test("passwordHashMatches accepts the right password and rejects others", () => {
  const entry = makePasswordHash("correct horse");
  assert.equal(passwordHashMatches("correct horse", entry), true);
  assert.equal(passwordHashMatches("wrong", entry), false);
  assert.equal(passwordHashMatches("", entry), false);
  assert.equal(passwordHashMatches("correct horse", null), false);
  assert.equal(passwordHashMatches("correct horse", { salt: "zz", hash: "zz", iterations: 1 }), false);
});

test("isValidPasswordHash guards corrupt/legacy shapes", () => {
  assert.equal(isValidPasswordHash(makePasswordHash("x")), true);
  assert.equal(isValidPasswordHash(null), false);
  assert.equal(isValidPasswordHash({ salt: "ab", hash: "cd" }), false); // no iterations
  assert.equal(isValidPasswordHash({ salt: "xy", hash: "ab", iterations: 10 }), false); // non-hex salt
});

// The middleware hashes the incoming password with WebCrypto PBKDF2; this must
// produce the exact hex makePasswordHash produces in Node, or no password would
// ever validate at the edge.
test("WebCrypto PBKDF2 in the edge runtime matches the Node hash", async () => {
  const entry = makePasswordHash("parity-check", { salt: "0123456789abcdef0123456789abcdef" });
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode("parity-check"), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: Uint8Array.from(Buffer.from(entry.salt, "hex")), iterations: entry.iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const webHash = Buffer.from(new Uint8Array(bits)).toString("hex");
  assert.equal(webHash, entry.hash);
});

test("renderRoutesJson scopes Functions to protected prefixes only", () => {
  assert.deepEqual(JSON.parse(renderRoutesJson([])), { version: 1, include: [], exclude: [] });
  assert.deepEqual(JSON.parse(renderRoutesJson(["a", "b", "a"])), {
    version: 1,
    include: ["/p/a/*", "/p/b/*"],
    exclude: []
  });
  assert.deepEqual(JSON.parse(renderRoutesJson([], { includeSyncEndpoint: true })), {
    version: 1,
    include: [PAGECAST_SYNC_MANIFEST_PATH],
    exclude: []
  });
  const many = Array.from({ length: 150 }, (_, i) => `s${i}`);
  assert.deepEqual(JSON.parse(renderRoutesJson(many)).include, ["/p/*"]);
});

test("middleware passes through unprotected paths without auth", async () => {
  const entry = makePasswordHash("secret", { salt: "0123456789abcdef0123456789abcdef" });
  const { onRequest } = await loadMiddleware([{ slug: "demo", ...entry }], {
    cookieSecret: "00".repeat(32)
  });
  let nexted = false;
  const res = await onRequest({
    request: new Request("https://x.pages.dev/p/other/index.html"),
    next: async () => {
      nexted = true;
      return new Response("OTHER", { status: 200 });
    }
  });
  assert.equal(nexted, true);
  assert.equal(res.status, 200);
});

test("middleware blocks a protected path without a password (401 + WWW-Authenticate)", async () => {
  const entry = makePasswordHash("secret", { salt: "0123456789abcdef0123456789abcdef" });
  const { onRequest } = await loadMiddleware([{ slug: "demo", ...entry }], {
    cookieSecret: "00".repeat(32)
  });
  let nexted = false;
  const res = await onRequest({
    request: new Request("https://x.pages.dev/p/demo/index.html"),
    next: async () => {
      nexted = true;
      return new Response("SECRET", { status: 200 });
    }
  });
  assert.equal(nexted, false);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate") || "", /^Basic realm=/);
});

test("middleware rejects a wrong password and accepts the right one (with Set-Cookie)", async () => {
  const entry = makePasswordHash("secret", { salt: "0123456789abcdef0123456789abcdef" });
  const { onRequest } = await loadMiddleware([{ slug: "demo", ...entry }], {
    cookieSecret: "00".repeat(32)
  });

  const wrong = await onRequest({
    request: new Request("https://x.pages.dev/p/demo/index.html", {
      headers: { Authorization: basic("nope") }
    }),
    next: async () => new Response("SECRET", { status: 200 })
  });
  assert.equal(wrong.status, 401);

  let served = false;
  const ok = await onRequest({
    request: new Request("https://x.pages.dev/p/demo/index.html", {
      headers: { Authorization: basic("secret") }
    }),
    next: async () => {
      served = true;
      return new Response("SECRET", { status: 200 });
    }
  });
  assert.equal(served, true);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("Set-Cookie") || "", /^pc_demo=.*HttpOnly/);
});

test("middleware accepts a non-ASCII password (UTF-8 byte parity with the Node hash)", async () => {
  const pw = "pÄsswörd—✓";
  const entry = makePasswordHash(pw, { salt: "0123456789abcdef0123456789abcdef" });
  const { onRequest } = await loadMiddleware([{ slug: "demo", ...entry }], {
    cookieSecret: "00".repeat(32)
  });
  let served = false;
  const ok = await onRequest({
    request: new Request("https://x.pages.dev/p/demo/index.html", {
      headers: { Authorization: basic(pw) }
    }),
    next: async () => {
      served = true;
      return new Response("SECRET", { status: 200 });
    }
  });
  assert.equal(served, true, "correct non-ASCII password should authenticate");
  assert.equal(ok.status, 200);
});

test("middleware honors a valid signed cookie and ignores a forged one", async () => {
  const entry = makePasswordHash("secret", { salt: "0123456789abcdef0123456789abcdef" });
  const { onRequest } = await loadMiddleware([{ slug: "demo", ...entry }], {
    cookieSecret: "00".repeat(32)
  });

  // Mint a real cookie by authenticating once, then replay it on a sub-asset
  // request that carries no Authorization header.
  const authed = await onRequest({
    request: new Request("https://x.pages.dev/p/demo/index.html", {
      headers: { Authorization: basic("secret") }
    }),
    next: async () => new Response("SECRET", { status: 200 })
  });
  const setCookie = authed.headers.get("Set-Cookie") || "";
  const cookie = setCookie.split(";")[0];

  let served = false;
  const replay = await onRequest({
    request: new Request("https://x.pages.dev/p/demo/app.css", { headers: { Cookie: cookie } }),
    next: async () => {
      served = true;
      return new Response("css", { status: 200 });
    }
  });
  assert.equal(served, true);
  assert.equal(replay.status, 200);

  const forged = await onRequest({
    request: new Request("https://x.pages.dev/p/demo/app.css", {
      headers: { Cookie: "pc_demo=9999999999999.deadbeef" }
    }),
    next: async () => new Response("css", { status: 200 })
  });
  assert.equal(forged.status, 401);
});

test("middleware serves the private sync manifest only with the sync token", async () => {
  const { onRequest } = await loadMiddleware([], {
    syncToken: "sync-secret",
    syncManifest: {
      version: 1,
      baseUrl: "https://team-reports.pages.dev",
      publications: [{ slug: "remote-only", files: ["index.html"] }]
    }
  });

  let nexted = false;
  const missing = await onRequest({
    request: new Request(`https://x.pages.dev${PAGECAST_SYNC_MANIFEST_PATH}`),
    next: async () => {
      nexted = true;
      return new Response("NEXT", { status: 200 });
    }
  });
  assert.equal(missing.status, 404);
  assert.equal(nexted, false);

  const ok = await onRequest({
    request: new Request(`https://x.pages.dev${PAGECAST_SYNC_MANIFEST_PATH}?token=sync-secret`),
    next: async () => new Response("NEXT", { status: 200 })
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  const manifest = await ok.json();
  assert.equal(manifest.publications[0].slug, "remote-only");
});
