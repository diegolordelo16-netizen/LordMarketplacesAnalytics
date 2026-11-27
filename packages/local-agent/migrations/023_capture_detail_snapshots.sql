-- Observações detalhadas não são agregadas automaticamente aos KPIs.
CREATE TABLE capture_detail_snapshots (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 marketplace TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('AD_CAMPAIGN','AD','LISTING_VARIANT','WAREHOUSE_STOCK')),
 external_id TEXT NOT NULL,parent_external_id TEXT NOT NULL DEFAULT '',label TEXT,
 metrics_json TEXT NOT NULL,evidence_json TEXT NOT NULL,context_json TEXT NOT NULL,page_url TEXT NOT NULL,
 captured_at TEXT NOT NULL,reference_at TEXT NOT NULL,source_class TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES data_source_runs(id) ON DELETE CASCADE,
 UNIQUE(account_id,kind,external_id,parent_external_id,captured_at)
);
CREATE INDEX idx_capture_detail_account ON capture_detail_snapshots(account_id,kind,captured_at DESC);
