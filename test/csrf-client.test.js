import assert from "node:assert/strict";
import test from "node:test";

import {
  STALE_CSRF_RESPONSE,
  createCsrfRecovery
} from "../web/src/lib/csrf-recovery.js";

function headerValue(init, name) {
  return new Headers(init.headers).get(name);
}

test("a mutation recovers once after a server restart invalidates its cached CSRF token", async () => {
  const calls = [];
  let sessionCount = 0;
  let mutationCount = 0;
  const client = createCsrfRecovery({
    fetchImpl: async (path, init = {}) => {
      calls.push({ path: String(path), csrf: headerValue(init, "X-Pagecast-CSRF") });
      if (path === "/api/session") {
        sessionCount += 1;
        return Response.json({ csrfToken: sessionCount === 1 ? "before-restart" : "after-restart" });
      }

      mutationCount += 1;
      if (mutationCount === 1) {
        return new Response(STALE_CSRF_RESPONSE, { status: 403 });
      }
      return Response.json({ ok: true });
    }
  });

  const response = await client.fetch("/api/reports/path", {
    method: "POST",
    body: "{}"
  });

  assert.equal(response.status, 200);
  assert.equal(sessionCount, 2, "the stale cached token must be invalidated and refetched");
  assert.equal(mutationCount, 2, "the rejected mutation must be retried exactly once");
  assert.deepEqual(
    calls.filter((call) => call.path === "/api/reports/path").map((call) => call.csrf),
    ["before-restart", "after-restart"]
  );
});

test("a second stale-token rejection is returned without a retry loop", async () => {
  let sessionCount = 0;
  let mutationCount = 0;
  const client = createCsrfRecovery({
    fetchImpl: async (path) => {
      if (path === "/api/session") {
        sessionCount += 1;
        return Response.json({ csrfToken: `session-${sessionCount}` });
      }
      mutationCount += 1;
      return new Response(STALE_CSRF_RESPONSE, { status: 403 });
    }
  });

  const response = await client.fetch("/api/reports/path", { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal(sessionCount, 2);
  assert.equal(mutationCount, 2);
});

test("an unrelated 403 is never retried as a stale CSRF session", async () => {
  let sessionCount = 0;
  let mutationCount = 0;
  const client = createCsrfRecovery({
    fetchImpl: async (path) => {
      if (path === "/api/session") {
        sessionCount += 1;
        return Response.json({ csrfToken: "valid-session" });
      }
      mutationCount += 1;
      return new Response("Forbidden: this browser origin cannot access the admin API.", {
        status: 403
      });
    }
  });

  const response = await client.fetch("/api/reports/path", { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal(sessionCount, 1);
  assert.equal(mutationCount, 1);
});
