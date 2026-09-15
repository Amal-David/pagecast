import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("initial schema has the owner-scoped hybrid publishing data model", async () => {
  const schema = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");

  for (const table of [
    "owners", "publications", "publication_versions", "uploads", "idempotency_keys",
    "access_policies", "access_grants", "collaboration_members", "analytics_events",
    "analytics_aggregates", "audit_events", "webhooks", "outbox", "jobs",
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(schema, /FOREIGN KEY \(owner_id, publication_id\)/);
  assert.match(schema, /UNIQUE\s*\(owner_id, idempotency_key\)/);
  assert.match(schema, /UNIQUE\s*\(owner_id, slug\)/);
  assert.match(schema, /CREATE INDEX idempotency_keys_expiry_idx/);
  assert.match(schema, /CREATE INDEX access_grants_expiry_idx/);
  assert.doesNotMatch(schema, /ON DELETE SET NULL/);
});

test("control-plane quota migration is forward-only and owner-scoped", async () => {
  const migration = await readFile(new URL("../migrations/0002_control_plane.sql", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE owner_quotas/);
  assert.match(migration, /max_tokens INTEGER NOT NULL DEFAULT 10/);
  assert.match(migration, /FOREIGN KEY \(owner_id\) REFERENCES owners/);
  assert.doesNotMatch(migration, /DROP TABLE|ALTER TABLE/i);
});

test("public access migration makes session invalidation and throttling durable", async () => {
  const migration = await readFile(new URL("../migrations/0004_public_access.sql", import.meta.url), "utf8");

  assert.match(migration, /auth_version INTEGER NOT NULL DEFAULT 1/);
  assert.match(migration, /password_salt TEXT/);
  assert.match(migration, /password_iterations INTEGER NOT NULL DEFAULT 100000/);
  assert.match(migration, /approval_state TEXT NOT NULL DEFAULT 'approved'/);
  assert.match(migration, /CREATE TABLE password_attempts/);
  assert.doesNotMatch(migration, /DROP TABLE/i);
});
