
CREATE TABLE seo_external_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  query TEXT NOT NULL,
  device TEXT NOT NULL CHECK(device IN ('desktop','mobile')),
  location_name TEXT,
  scope TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  captured_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('DISPATCHED','OK','EMPTY','PROVIDER_ERROR','HTTP_ERROR','TRANSPORT_UNKNOWN','INVALID_RESPONSE','LOCAL_ERROR')),
  cost_usd REAL CHECK(cost_usd IS NULL OR cost_usd>=0),
  total_count INTEGER CHECK(total_count IS NULL OR total_count>=0),
  provider_code INTEGER,
  result_json TEXT NOT NULL DEFAULT '[]',
  schedule_id TEXT
);
CREATE INDEX idx_seo_external_history ON seo_external_runs(account_id,requested_at DESC,id);
CREATE INDEX idx_seo_external_rank ON seo_external_runs(account_id,mode,query,device,location_name,captured_at);
CREATE TABLE seo_rank_watches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  domain TEXT NOT NULL,
  device TEXT NOT NULL CHECK(device IN ('desktop','mobile')),
  location_name TEXT NOT NULL DEFAULT '',
  interval_days INTEGER NOT NULL CHECK(interval_days BETWEEN 1 AND 30),
  remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND 30),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_status TEXT,
  UNIQUE(account_id,keyword,domain,device,location_name)
);
CREATE INDEX idx_seo_rank_due ON seo_rank_watches(enabled,next_run_at);
