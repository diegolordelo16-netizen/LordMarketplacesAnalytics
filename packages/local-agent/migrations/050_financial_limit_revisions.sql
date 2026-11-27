CREATE TABLE financial_limit_revisions (id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL,restored_from TEXT REFERENCES financial_limit_revisions(id));
CREATE INDEX idx_financial_limit_revisions ON financial_limit_revisions(account_id,created_at DESC);
