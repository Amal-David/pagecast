CREATE TABLE IF NOT EXISTS access_events (
  event_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'XX',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  asn INTEGER,
  organization TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT 'desktop',
  referrer_host TEXT NOT NULL DEFAULT 'direct'
);

CREATE INDEX IF NOT EXISTS access_events_publication_time
  ON access_events(publication_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS access_events_time
  ON access_events(occurred_at);

CREATE TABLE IF NOT EXISTS publication_totals (
  publication_id TEXT PRIMARY KEY,
  views INTEGER NOT NULL DEFAULT 0,
  last_access_at TEXT
);
