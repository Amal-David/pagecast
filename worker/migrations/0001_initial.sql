PRAGMA foreign_keys = ON;

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE owner_settings (
  owner_id TEXT PRIMARY KEY,
  analytics_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (analytics_retention_days BETWEEN 1 AND 365),
  default_expiry_days INTEGER CHECK (default_expiry_days IS NULL OR default_expiry_days BETWEEN 1 AND 3650),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'revoked', 'expired', 'archived')),
  active_version_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, slug),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE TABLE publication_versions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  manifest_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'published', 'superseded', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  UNIQUE (owner_id, id),
  UNIQUE (publication_id, version_number),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT,
  idempotency_key TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  expected_sha256 TEXT,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'aborted', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, idempotency_key),
  UNIQUE (r2_key),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE RESTRICT
);

CREATE TABLE idempotency_keys (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);

CREATE TABLE access_policies (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'unlisted' CHECK (mode IN ('public', 'unlisted', 'password', 'allowlist')),
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  UNIQUE (publication_id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('email', 'token', 'team')),
  principal_value TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'comment', 'edit')),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, publication_id, principal_type, principal_value),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX access_grants_expiry_idx ON access_grants(expires_at);

CREATE TABLE collaboration_members (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'approver')),
  invited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT,
  removed_at TEXT,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, publication_id, member_id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  version_id TEXT,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, version_id) REFERENCES publication_versions(owner_id, id) ON DELETE RESTRICT
);

CREATE TABLE redirects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 302 CHECK (status_code IN (301, 302, 307, 308)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  UNIQUE (publication_id, source_path),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE custom_domains (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  publication_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed', 'removed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  UNIQUE (hostname),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE RESTRICT
);

CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  version_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'download', 'share', 'access_denied')),
  address_hmac TEXT,
  country_code TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, version_id) REFERENCES publication_versions(owner_id, id) ON DELETE RESTRICT
);

CREATE INDEX analytics_events_expiry_idx ON analytics_events(expires_at);
CREATE INDEX analytics_events_publication_idx ON analytics_events(owner_id, publication_id, occurred_at);

CREATE TABLE analytics_aggregates (
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  PRIMARY KEY (owner_id, publication_id, bucket_start, event_type),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE INDEX audit_events_owner_idx ON audit_events(owner_id, occurred_at);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  event_type TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, url, event_type),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  outbox_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),
  response_code INTEGER,
  next_attempt_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, webhook_id) REFERENCES webhooks(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE INDEX outbox_dispatch_idx ON outbox(dispatched_at, available_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('expire', 'index', 'notify', 'webhook', 'render_preview', 'accessibility_check', 'link_check')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  run_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE RESTRICT
);

CREATE INDEX jobs_ready_idx ON jobs(status, run_after);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, job_id, attempt_number),
  FOREIGN KEY (owner_id, job_id) REFERENCES jobs(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);
