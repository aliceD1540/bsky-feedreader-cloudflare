CREATE TABLE IF NOT EXISTS feeds (
  feed_url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS posted_entries (
  entry_url TEXT PRIMARY KEY,
  feed_url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  thumbnail_url TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'posted')),
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(feed_url) REFERENCES feeds(feed_url)
);

CREATE INDEX IF NOT EXISTS idx_posted_entries_feed_url
  ON posted_entries(feed_url);

CREATE INDEX IF NOT EXISTS idx_posted_entries_state_claimed_at
  ON posted_entries(state, claimed_at);
