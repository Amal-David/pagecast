-- Forward-only access-policy state. Session and grant credentials are never stored directly.
ALTER TABLE access_policies ADD COLUMN password_salt TEXT;
ALTER TABLE access_policies ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 100000 CHECK (password_iterations BETWEEN 100000 AND 1000000);
ALTER TABLE access_policies ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0);
ALTER TABLE access_policies ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'approved' CHECK (approval_state IN ('approved', 'pending', 'rejected'));
ALTER TABLE publication_versions ADD COLUMN storage_purged_at TEXT;

CREATE TABLE password_attempts (
  publication_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  blocked_until TEXT,
  PRIMARY KEY (publication_id, fingerprint),
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
);

CREATE INDEX redirects_source_path_idx ON redirects(source_path, created_at DESC);
CREATE INDEX password_attempts_cleanup_idx ON password_attempts(window_started_at);
CREATE INDEX publication_versions_retention_cleanup_idx ON publication_versions(retention_until, publication_id) WHERE deleted_at IS NOT NULL AND storage_purged_at IS NULL;
