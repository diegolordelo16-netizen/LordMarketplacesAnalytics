CREATE TABLE capture_chart_points (
  id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,chart_id TEXT NOT NULL,chart_title TEXT NOT NULL,series TEXT NOT NULL,
  dimension TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL CHECK(unit IN ('PERCENT','BRL','UNSPECIFIED')),
  raw_text TEXT NOT NULL,page_url TEXT NOT NULL,page_kind TEXT NOT NULL,filter_signature TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL,source_class TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES data_source_runs(id) ON DELETE CASCADE,
  UNIQUE(account_id,chart_id,series,dimension,page_url,filter_signature,captured_at)
);
CREATE INDEX idx_capture_chart_account ON capture_chart_points(account_id,captured_at DESC);
