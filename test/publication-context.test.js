import assert from "node:assert/strict";
import test from "node:test";

import {
  findPublicationForPublish,
  normalizePublishMode,
  resolvePublicationContext
} from "../src/publication-context.js";

test("agent context precedence is explicit, environment-backed, hashed, and never retained raw", () => {
  const explicit = resolvePublicationContext({
    contextId: "explicit-secret-context",
    workspaceId: "workspace-1",
    itemKey: "quarterly-report",
    env: {
      PAGECAST_CONTEXT_ID: "pagecast-context",
      CODEX_THREAD_ID: "codex-context",
      CLAUDE_SESSION_ID: "claude-context"
    }
  });
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.contextMatched, true);
  assert.match(explicit.contextHash, /^[a-f0-9]{64}$/);
  assert.match(explicit.contextKey, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(explicit).includes("explicit-secret-context"), false);

  const pagecast = resolvePublicationContext({
    workspaceId: "workspace-1",
    sourcePath: "/tmp/report.html",
    env: { PAGECAST_CONTEXT_ID: "pagecast-context", CODEX_THREAD_ID: "codex-context" }
  });
  assert.equal(pagecast.source, "PAGECAST_CONTEXT_ID");
  const codex = resolvePublicationContext({
    workspaceId: "workspace-1",
    sourcePath: "/tmp/report.html",
    env: { CODEX_THREAD_ID: "codex-context", CLAUDE_SESSION_ID: "claude-context" }
  });
  assert.equal(codex.source, "CODEX_THREAD_ID");
});

test("fallback context is stable for the same workspace and source", () => {
  const first = resolvePublicationContext({
    workspaceId: "workspace-1",
    sourcePath: "/tmp/report.html",
    env: {}
  });
  const second = resolvePublicationContext({
    workspaceId: "workspace-1",
    sourcePath: "/tmp/report.html",
    env: {}
  });
  assert.equal(first.source, "workspace-source");
  assert.equal(first.contextMatched, false);
  assert.equal(first.contextKey, second.contextKey);
});

test("publish mode validates mutually exclusive overrides", () => {
  assert.deepEqual(normalizePublishMode({}), { mode: "upsert", publication: "" });
  assert.deepEqual(normalizePublishMode({ newLink: true }), { mode: "new", publication: "" });
  assert.deepEqual(normalizePublishMode({ update: "https://home.pages.dev/p/report/" }), {
    mode: "update",
    publication: "https://home.pages.dev/p/report/"
  });
  assert.throws(
    () => normalizePublishMode({ newLink: true, update: "report" }),
    /either a new link or an existing publication/
  );
});

test("upsert matches context while explicit update accepts token, slug, or URL", () => {
  const reports = [
    {
      id: "report-1",
      publications: [
        {
          token: "token-1",
          slug: "report-one",
          publicUrl: "https://home.pages.dev/p/report-one/",
          contextKey: "context-key",
          revokedAt: null
        }
      ]
    }
  ];
  assert.equal(
    findPublicationForPublish(reports, { mode: "upsert", contextKey: "context-key" })
      .publication.token,
    "token-1"
  );
  for (const publication of [
    "token-1",
    "report-one",
    "https://home.pages.dev/p/report-one/"
  ]) {
    assert.equal(
      findPublicationForPublish(reports, { mode: "update", publication }).publication.token,
      "token-1"
    );
  }
  assert.equal(findPublicationForPublish(reports, { mode: "new", contextKey: "context-key" }), null);
  assert.throws(
    () => findPublicationForPublish(reports, { mode: "update", publication: "missing" }),
    /was not found/
  );
});
