-- Forward-only collaboration state. Credentials are digested before persistence.
ALTER TABLE api_tokens ADD COLUMN actor_id TEXT;

CREATE TABLE organizations (
  owner_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE TABLE collaboration_actors (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  external_subject TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, email),
  UNIQUE (owner_id, external_subject),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE TABLE collaboration_memberships (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'approver', 'owner')),
  invited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT,
  removed_at TEXT,
  invite_digest TEXT,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, actor_id),
  FOREIGN KEY (owner_id, actor_id) REFERENCES collaboration_actors(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE collaboration_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  version_id TEXT,
  actions_json TEXT NOT NULL,
  credential_digest TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, version_id) REFERENCES publication_versions(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX collaboration_grants_expiry_idx ON collaboration_grants(expires_at);

CREATE TABLE collaboration_comments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  version_id TEXT,
  author_actor_id TEXT NOT NULL,
  body TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_actor_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, version_id) REFERENCES publication_versions(owner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, author_actor_id) REFERENCES collaboration_actors(owner_id, id) ON DELETE RESTRICT
);

CREATE INDEX collaboration_comments_visibility_idx ON collaboration_comments(owner_id, publication_id, version_id, deleted_at);

CREATE TABLE collaboration_review_decisions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, version_id, actor_id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, version_id) REFERENCES publication_versions(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, actor_id) REFERENCES collaboration_actors(owner_id, id) ON DELETE RESTRICT
);

CREATE INDEX collaboration_decisions_current_idx ON collaboration_review_decisions(owner_id, version_id, decision, superseded_at);

-- A review program is opt-in per publication. It gates only future activation
-- of the selected version; it never changes delivery of the active version.
CREATE TABLE publication_review_policies (
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, publication_id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);
