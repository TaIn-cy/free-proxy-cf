CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol TEXT NOT NULL DEFAULT 'unknown' CHECK (protocol IN ('unknown', 'http', 'socks5')),
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'alive', 'dead')),
  latency_ms INTEGER,
  last_checked_at TEXT,
  last_success_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proxies_status_checked ON proxies(status, last_checked_at);
CREATE INDEX IF NOT EXISTS idx_proxies_success ON proxies(last_success_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  checked_count INTEGER NOT NULL DEFAULT 0,
  alive_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS runtime_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_until INTEGER NOT NULL DEFAULT 0,
  owner TEXT
);
INSERT OR IGNORE INTO runtime_lock (id, locked_until, owner) VALUES (1, 0, NULL);
