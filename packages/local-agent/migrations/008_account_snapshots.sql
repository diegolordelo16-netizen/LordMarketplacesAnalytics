-- 008 — Snapshots de métricas agregadas da conta, independentes de listingId.
CREATE TABLE account_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  page_kind TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  reference_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  source_class TEXT NOT NULL,
  page_url TEXT NOT NULL,
  evidence_json TEXT,
  quality_score REAL,
  UNIQUE(account_id, page_kind, captured_at, page_url)
);
CREATE INDEX idx_account_snapshots_account_time ON account_snapshots(account_id, captured_at DESC);
CREATE INDEX idx_account_snapshots_marketplace_kind ON account_snapshots(marketplace, page_kind, captured_at DESC);
