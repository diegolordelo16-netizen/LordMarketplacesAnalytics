CREATE TABLE campaign_profit_observations (
 snapshot_id TEXT PRIMARY KEY REFERENCES capture_detail_snapshots(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 net_attributed_revenue_cents INTEGER NOT NULL CHECK(net_attributed_revenue_cents>=0),
 costs_json TEXT NOT NULL,
 source_reference TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 created_by TEXT NOT NULL
);
CREATE INDEX idx_campaign_profit_account ON campaign_profit_observations(account_id,observed_at DESC);
