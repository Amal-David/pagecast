-- Forward-only lifecycle metadata. Existing immutable objects remain untouched.
ALTER TABLE publications ADD COLUMN link_kind TEXT NOT NULL DEFAULT 'unlisted' CHECK (link_kind IN ('public', 'unlisted'));
ALTER TABLE publications ADD COLUMN context_key TEXT;
ALTER TABLE publications ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);
ALTER TABLE publications ADD COLUMN revoked_version_id TEXT;
ALTER TABLE publications ADD COLUMN retention_until TEXT;
ALTER TABLE publications ADD COLUMN deleted_at TEXT;

ALTER TABLE publication_versions ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1));
ALTER TABLE publication_versions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);
ALTER TABLE publication_versions ADD COLUMN retention_until TEXT;
ALTER TABLE publication_versions ADD COLUMN deleted_at TEXT;
ALTER TABLE idempotency_keys ADD COLUMN operation_type TEXT;

CREATE UNIQUE INDEX publications_slug_global_idx ON publications(slug);
CREATE UNIQUE INDEX publications_owner_context_idx ON publications(owner_id, context_key) WHERE context_key IS NOT NULL;

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('create', 'context-upsert', 'new-link', 'explicit-update')),
  manifest_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'aborted', 'expired')),
  expires_at TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE (owner_id, operation_id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, version_id) REFERENCES publication_versions(owner_id, id) ON DELETE RESTRICT
);

CREATE INDEX upload_sessions_expiry_idx ON upload_sessions(status, expires_at);

CREATE TABLE upload_session_files (
  session_id TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0),
  expected_sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  received_bytes INTEGER,
  received_sha256 TEXT,
  uploaded_at TEXT,
  PRIMARY KEY (session_id, normalized_path),
  FOREIGN KEY (session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE
);

CREATE TABLE version_files (
  version_id TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version_id, normalized_path),
  FOREIGN KEY (version_id) REFERENCES publication_versions(id) ON DELETE RESTRICT
);
