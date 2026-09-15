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

test("collaboration migration is forward-only, owner-scoped, and stores credentials only as digests", async () => {
  const migration = await readFile(new URL("../migrations/0005_collaboration.sql", import.meta.url), "utf8");

  for (const table of ["organizations", "collaboration_actors", "collaboration_memberships", "collaboration_grants", "collaboration_comments", "collaboration_review_decisions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /credential_digest TEXT NOT NULL UNIQUE/);
  assert.match(migration, /invite_digest TEXT/);
  assert.match(migration, /ALTER TABLE api_tokens ADD COLUMN actor_id TEXT/);
  assert.doesNotMatch(migration, /DROP TABLE/i);
});

test("analytics V2 migration replaces the unshipped baseline cleanly and makes duplicate rollups durable", async () => {
  const migration = await readFile(new URL("../migrations/0006_analytics_v2.sql", import.meta.url), "utf8");

  assert.match(migration, /DROP TABLE analytics_events/);
  assert.match(migration, /DROP TABLE analytics_aggregates/);
  assert.match(migration, /CREATE TABLE analytics_uniques/);
  assert.match(migration, /CREATE TABLE analytics_ingest_counters/);
  assert.match(migration, /CREATE TABLE analytics_global_ingest_counters/);
  assert.match(migration, /CREATE TRIGGER analytics_events_quota BEFORE INSERT/);
  assert.match(migration, /CREATE TRIGGER analytics_events_rollup AFTER INSERT/);
  assert.match(migration, /RAISE\(ABORT, 'analytics_global_quota_exceeded'\)/);
  assert.match(migration, /owner_quota_limit INTEGER NOT NULL CHECK \(owner_quota_limit BETWEEN 1 AND 1000\)/);
  assert.match(migration, /global_quota_limit INTEGER NOT NULL CHECK \(global_quota_limit BETWEEN 1 AND 2000\)/);
  assert.match(migration, /DEFAULT \(strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)\)/);
  assert.match(migration, /INSERT OR IGNORE INTO analytics_uniques/);
  assert.match(migration, /address_hmac TEXT NOT NULL/);
  assert.match(migration, /CREATE INDEX analytics_events_expiry_idx/);
  assert.match(migration, /CREATE INDEX analytics_uniques_expiry_idx/);
  assert.match(migration, /FOREIGN KEY \(owner_id, publication_id\) REFERENCES publications\(owner_id, id\) ON DELETE CASCADE/);
  assert.match(migration, /PRIMARY KEY \(owner_id, id\)/);
  assert.doesNotMatch(migration, /legacy_/i);
  assert.doesNotMatch(migration, /CF-Connecting-IP|raw_ip|ip_address/i);
});

test("jobs V2 replaces the unshipped baseline with leased, bounded durable work", async () => {
  const migration = await readFile(new URL("../migrations/0007_jobs_webhooks.sql", import.meta.url), "utf8");

  for (const table of ["webhook_subscriptions", "outbox_events", "webhook_deliveries", "jobs", "job_attempts", "job_dead_letters", "job_artifacts"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /DROP TABLE webhook_deliveries/);
  assert.match(migration, /DROP TABLE jobs/);
  assert.match(migration, /enqueue_lease_expires_at TEXT/);
  assert.match(migration, /enqueue_lease_token TEXT/);
  assert.match(migration, /last_enqueued_at TEXT/);
  assert.match(migration, /retention_until TEXT/);
  assert.match(migration, /CREATE INDEX jobs_retention_idx/);
  assert.doesNotMatch(migration, /legacy_/i);
  assert.doesNotMatch(migration, /ALTER TABLE/i);
});
