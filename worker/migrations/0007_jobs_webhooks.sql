-- Durable, at-least-once work records. Queue messages are hints; D1 is source of truth.
-- These baseline tables have never been deployed, so replace them rather than preserve
-- incompatible copies without consumers.
DROP TABLE webhook_deliveries;
DROP TABLE job_attempts;
DROP TABLE jobs;
DROP TABLE webhooks;
DROP TABLE outbox;

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  secret_version INTEGER NOT NULL DEFAULT 1 CHECK (secret_version > 0),
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'dead_lettered')),
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processing_started_at TEXT,
  enqueue_lease_token TEXT,
  enqueue_lease_expires_at TEXT,
  last_enqueued_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  retention_until TEXT,
  UNIQUE (owner_id, dedupe_key),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE INDEX outbox_events_repair_idx ON outbox_events(status, available_at, enqueue_lease_expires_at, created_at);
CREATE INDEX outbox_events_retention_idx ON outbox_events(retention_until);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'retrying', 'delivered', 'dead_lettered')),
  response_status INTEGER,
  error_code TEXT,
  attempted_at TEXT,
  next_attempt_at TEXT,
  delivered_at TEXT,
  dead_lettered_at TEXT,
  sending_lease_expires_at TEXT,
  enqueue_lease_token TEXT,
  enqueue_lease_expires_at TEXT,
  last_enqueued_at TEXT,
  retention_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subscription_id, outbox_id),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE,
  FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  FOREIGN KEY (outbox_id) REFERENCES outbox_events(id) ON DELETE CASCADE
);

CREATE INDEX webhook_deliveries_retry_idx ON webhook_deliveries(status, next_attempt_at, enqueue_lease_expires_at, created_at);
CREATE INDEX webhook_deliveries_retention_idx ON webhook_deliveries(retention_until);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT,
  version_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('expire', 'cleanup', 'webhook', 'screenshot', 'pdf', 'accessibility_check', 'link_check', 'index')),
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'retrying', 'completed', 'failed', 'cancelled', 'dead_lettered')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_code TEXT,
  cancelled_at TEXT,
  artifact_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  lease_expires_at TEXT,
  enqueue_lease_token TEXT,
  enqueue_lease_expires_at TEXT,
  last_enqueued_at TEXT,
  retention_until TEXT,
  UNIQUE (owner_id, dedupe_key),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, version_id) REFERENCES publication_versions(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX jobs_ready_idx ON jobs(status, enqueue_lease_expires_at, created_at);
CREATE INDEX jobs_lease_recovery_idx ON jobs(status, lease_expires_at, created_at);
CREATE INDEX jobs_retention_idx ON jobs(retention_until);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  retention_until TEXT,
  UNIQUE (job_id, attempt),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE job_dead_letters (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  message_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until TEXT,
  UNIQUE (job_id),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE job_artifacts (
  job_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER,
  retention_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE INDEX job_attempts_retention_idx ON job_attempts(retention_until);
CREATE INDEX job_dead_letters_retention_idx ON job_dead_letters(retention_until);
CREATE INDEX job_artifacts_retention_idx ON job_artifacts(retention_until);
