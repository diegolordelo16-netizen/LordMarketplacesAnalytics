ALTER TABLE own_products ADD COLUMN universal_code TEXT;
ALTER TABLE competitor_public_search_observations ADD COLUMN brand TEXT;
ALTER TABLE competitor_public_search_observations ADD COLUMN universal_code TEXT;

CREATE TABLE competitor_radar_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  own_product_id TEXT NOT NULL REFERENCES own_products(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('PRODUCT_BRAND','GTIN')),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED')),
  lease_hash TEXT,
  outcomes_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_competitor_radar_product ON competitor_radar_requests(account_id,own_product_id,created_at DESC);
CREATE UNIQUE INDEX idx_competitor_radar_pending ON competitor_radar_requests(own_product_id) WHERE status IN ('QUEUED','RUNNING');
