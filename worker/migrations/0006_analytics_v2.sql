-- This Worker has not shipped. Replace the baseline analytics tables rather
-- than copying address-derived legacy rows into V2.
DROP TABLE analytics_events;
DROP TABLE analytics_aggregates;

CREATE TABLE analytics_events (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'download', 'share', 'access_denied', 'reaction')),
  reaction TEXT CHECK (reaction IS NULL OR reaction IN ('like', 'love', 'insightful', 'celebrate')),
  address_hmac TEXT NOT NULL,
  country_code TEXT,
  referrer_host TEXT,
  device_class TEXT NOT NULL CHECK (device_class IN ('desktop', 'mobile', 'tablet', 'unknown')),
  owner_quota_limit INTEGER NOT NULL CHECK (owner_quota_limit BETWEEN 1 AND 1000),
  global_quota_limit INTEGER NOT NULL CHECK (global_quota_limit BETWEEN 1 AND 2000),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE analytics_aggregates (
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('hour', 'day')),
  bucket_start TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'download', 'share', 'access_denied', 'reaction')),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  unique_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_count >= 0),
  PRIMARY KEY (owner_id, publication_id, granularity, bucket_start, event_type),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE analytics_uniques (
  owner_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('hour', 'day')),
  bucket_start TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'download', 'share', 'access_denied', 'reaction')),
  address_hmac TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, publication_id, granularity, bucket_start, event_type, address_hmac),
  FOREIGN KEY (owner_id, publication_id) REFERENCES publications(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE analytics_ingest_counters (
  owner_id TEXT NOT NULL,
  bucket_day TEXT NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  limit_count INTEGER NOT NULL CHECK (limit_count BETWEEN 1 AND 1000),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, bucket_day),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
);

CREATE TABLE analytics_global_ingest_counters (
  bucket_day TEXT PRIMARY KEY,
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  limit_count INTEGER NOT NULL CHECK (limit_count BETWEEN 1 AND 2000),
  expires_at TEXT NOT NULL
);

CREATE INDEX analytics_events_expiry_idx ON analytics_events(expires_at);
CREATE INDEX analytics_events_owner_publication_idx ON analytics_events(owner_id, publication_id, occurred_at, id);
CREATE INDEX analytics_uniques_expiry_idx ON analytics_uniques(expires_at);
CREATE INDEX analytics_ingest_counters_expiry_idx ON analytics_ingest_counters(expires_at);
CREATE INDEX analytics_global_ingest_counters_expiry_idx ON analytics_global_ingest_counters(expires_at);

-- Quotas live in the same statement as insertion. RAISE(ABORT) rolls back both
-- counter updates when either cap rejects a write; duplicate event IDs skip this
-- trigger entirely and therefore never consume quota.
CREATE TRIGGER analytics_events_quota BEFORE INSERT ON analytics_events
WHEN NOT EXISTS (SELECT 1 FROM analytics_events WHERE owner_id = NEW.owner_id AND id = NEW.id)
BEGIN
  INSERT INTO analytics_global_ingest_counters (bucket_day, accepted_count, limit_count, expires_at)
  VALUES (date('now'), 1, NEW.global_quota_limit, datetime('now', '+30 days'))
  ON CONFLICT(bucket_day) DO UPDATE SET
    accepted_count = accepted_count + 1,
    limit_count = MIN(analytics_global_ingest_counters.limit_count, NEW.global_quota_limit)
  WHERE accepted_count < MIN(analytics_global_ingest_counters.limit_count, NEW.global_quota_limit);
  SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, 'analytics_global_quota_exceeded') END;

  INSERT INTO analytics_ingest_counters (owner_id, bucket_day, accepted_count, limit_count, expires_at)
  VALUES (NEW.owner_id, date('now'), 1, NEW.owner_quota_limit, datetime('now', '+30 days'))
  ON CONFLICT(owner_id, bucket_day) DO UPDATE SET
    accepted_count = accepted_count + 1,
    limit_count = MIN(analytics_ingest_counters.limit_count, NEW.owner_quota_limit)
  WHERE accepted_count < MIN(analytics_ingest_counters.limit_count, NEW.owner_quota_limit);
  SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, 'analytics_owner_quota_exceeded') END;
END;

CREATE TRIGGER analytics_events_rollup AFTER INSERT ON analytics_events BEGIN
  INSERT OR IGNORE INTO analytics_uniques (owner_id, publication_id, granularity, bucket_start, event_type, address_hmac, expires_at)
  VALUES (NEW.owner_id, NEW.publication_id, 'hour', strftime('%Y-%m-%dT%H:00:00Z', NEW.occurred_at), NEW.event_type, NEW.address_hmac, NEW.expires_at);
  INSERT INTO analytics_aggregates (owner_id, publication_id, granularity, bucket_start, event_type, event_count, unique_count)
  VALUES (NEW.owner_id, NEW.publication_id, 'hour', strftime('%Y-%m-%dT%H:00:00Z', NEW.occurred_at), NEW.event_type, 1, changes())
  ON CONFLICT(owner_id, publication_id, granularity, bucket_start, event_type) DO UPDATE SET event_count = event_count + 1, unique_count = unique_count + excluded.unique_count;
  INSERT OR IGNORE INTO analytics_uniques (owner_id, publication_id, granularity, bucket_start, event_type, address_hmac, expires_at)
  VALUES (NEW.owner_id, NEW.publication_id, 'day', strftime('%Y-%m-%dT00:00:00Z', NEW.occurred_at), NEW.event_type, NEW.address_hmac, NEW.expires_at);
  INSERT INTO analytics_aggregates (owner_id, publication_id, granularity, bucket_start, event_type, event_count, unique_count)
  VALUES (NEW.owner_id, NEW.publication_id, 'day', strftime('%Y-%m-%dT00:00:00Z', NEW.occurred_at), NEW.event_type, 1, changes())
  ON CONFLICT(owner_id, publication_id, granularity, bucket_start, event_type) DO UPDATE SET event_count = event_count + 1, unique_count = unique_count + excluded.unique_count;
END;
