import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import test from "node:test";

import {
  ADMIN_MUTATION_METHODS,
  DEFAULT_HOST,
  DEFAULT_LOCAL_HOSTNAME,
  EXTENSION_API_ROUTES,
  PAGECAST_EXTENSION_ID,
  PAGECAST_EXTENSION_ID_OVERRIDE_ENV,
  assertSafeAdminBind,
  extensionCorsOrigin,
  isLoopbackBindHost,
  isLoopbackHostHeader,
  isWildcardBindHost,
  requestOrigin,
  tokensMatch
} from "../src/admin-security.js";
import {
  DEFAULT_HOST as legacyDefaultHost,
  DEFAULT_LOCAL_HOSTNAME as legacyDefaultLocalHostname,
  assertSafeAdminBind as legacyAssertSafeAdminBind,
  extensionCorsOrigin as legacyExtensionCorsOrigin,
  isLoopbackBindHost as legacyIsLoopbackBindHost,
  isLoopbackHostHeader as legacyIsLoopbackHostHeader,
  isWildcardBindHost as legacyIsWildcardBindHost
} from "../src/server.js";

test("admin security stays acyclic and server.js preserves its public boundary", async () => {
  const source = await fs.readFile(new URL("../src/admin-security.js", import.meta.url), "utf8");
  const dependencies = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(
    dependencies,
    ["node:crypto", "node:net"],
    "admin security must depend only on Node built-ins"
  );

  assert.equal(legacyDefaultHost, DEFAULT_HOST);
  assert.equal(legacyDefaultLocalHostname, DEFAULT_LOCAL_HOSTNAME);
  assert.equal(legacyAssertSafeAdminBind, assertSafeAdminBind);
  assert.equal(legacyExtensionCorsOrigin, extensionCorsOrigin);
  assert.equal(legacyIsLoopbackBindHost, isLoopbackBindHost);
  assert.equal(legacyIsLoopbackHostHeader, isLoopbackHostHeader);
  assert.equal(legacyIsWildcardBindHost, isWildcardBindHost);
});

test("admin bind and Host policies accept only loopback or explicit proxy boundaries", () => {
  for (const host of ["127.0.0.1", "127.255.255.255", "localhost", "[::1]"]) {
    assert.equal(isLoopbackBindHost(host), true, `${host} should be a loopback bind`);
  }
  assert.equal(isWildcardBindHost("0.0.0.0"), true);
  assert.equal(isWildcardBindHost("::"), true);
  assert.throws(() => assertSafeAdminBind("0.0.0.0"), /explicit loopback-proxy mode/);
  assert.doesNotThrow(() => assertSafeAdminBind("0.0.0.0", { allowLoopbackProxy: true }));
  assert.throws(() => assertSafeAdminBind("192.0.2.1"), /non-loopback host/);

  assert.equal(isLoopbackHostHeader("127.0.0.2:4173", DEFAULT_HOST), true);
  assert.equal(isLoopbackHostHeader("[::1]:4173", DEFAULT_HOST), true);
  assert.equal(
    isLoopbackHostHeader("team.pagecast.localhost:4173", DEFAULT_HOST, ["team.pagecast.localhost"]),
    true
  );
  assert.equal(isLoopbackHostHeader("attacker.example", DEFAULT_HOST, ["attacker.example"]), false);
  assert.equal(isLoopbackHostHeader("attacker.example", DEFAULT_HOST), false);
  assert.equal(isLoopbackHostHeader(undefined, DEFAULT_HOST), false);
});

test("admin Origin, extension, and token helpers keep the constrained policy", () => {
  const extensionOrigin = `chrome-extension://${PAGECAST_EXTENSION_ID}`;
  const foreignExtensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  assert.equal(extensionCorsOrigin(extensionOrigin), extensionOrigin);
  assert.equal(extensionCorsOrigin(foreignExtensionOrigin), null);
  assert.equal(
    extensionCorsOrigin(foreignExtensionOrigin, {
      env: { [PAGECAST_EXTENSION_ID_OVERRIDE_ENV]: "abcdefghijklmnopabcdefghijklmnop" }
    }),
    foreignExtensionOrigin
  );
  assert.equal(extensionCorsOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmn0p"), null);
  assert.equal(extensionCorsOrigin("https://attacker.example"), null);

  assert.equal(requestOrigin({ headers: { host: "127.0.0.1:4173" } }), "http://127.0.0.1:4173");
  assert.equal(requestOrigin({ headers: { host: "[::1]:4173" } }), "http://[::1]:4173");
  assert.equal(requestOrigin({ headers: { host: "bad host" } }), "");

  assert.equal(tokensMatch("same-token", "same-token"), true);
  assert.equal(tokensMatch("same-token", "other-token"), false);
  assert.equal(tokensMatch("short", "longer"), false);
  assert.equal(tokensMatch("", ""), false);
  assert.equal(tokensMatch(undefined, "token"), false);

  assert.deepEqual([...ADMIN_MUTATION_METHODS], ["POST", "PUT", "PATCH", "DELETE"]);
  assert.deepEqual([...EXTENSION_API_ROUTES], [
    "/api/session",
    "/api/status",
    "/api/publish-local"
  ]);
});

test("the manifest key derives the server-allowlisted stable extension ID", async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")
  );
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
  const derivedId = digest
    .slice(0, 32)
    .split("")
    .map((digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16)))
    .join("");

  assert.equal(derivedId, PAGECAST_EXTENSION_ID);
  assert.ok(manifest.permissions.includes("storage"));
});
