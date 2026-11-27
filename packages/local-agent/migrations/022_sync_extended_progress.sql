CREATE TABLE sync_batch_accounts_new (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  marketplace TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('WAITING_BROWSER','RUNNING','COMPLETED','PARTIAL','FAILED','SKIPPED')),
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  pages_succeeded INTEGER NOT NULL DEFAULT 0,
  error TEXT, started_at TEXT, finished_at TEXT,
  current_page_no INTEGER CHECK(current_page_no IS NULL OR current_page_no BETWEEN 1 AND 500),
  current_url TEXT, progress_json TEXT NOT NULL DEFAULT '{}', progress_updated_at TEXT,
  lease_hash TEXT, lease_expires_at TEXT,
  UNIQUE(batch_id, account_id)
);
INSERT INTO sync_batch_accounts_new SELECT id,batch_id,account_id,marketplace,status,pages_scanned,pages_succeeded,error,started_at,finished_at,current_page_no,current_url,progress_json,progress_updated_at,lease_hash,lease_expires_at FROM sync_batch_accounts;
DROP TABLE sync_batch_accounts;
ALTER TABLE sync_batch_accounts_new RENAME TO sync_batch_accounts;
CREATE INDEX idx_sync_batch_status ON sync_batch_accounts(batch_id,status);
CREATE TABLE sync_batch_page_runs_new (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL CHECK(page_no BETWEEN 1 AND 500),
  page_url TEXT NOT NULL,
  page_kind TEXT NOT NULL CHECK(page_kind IN ('seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory')),
  status TEXT NOT NULL CHECK(status IN ('COMPLETED','FAILED','QUEUED')),
  error TEXT, queued INTEGER NOT NULL DEFAULT 0 CHECK(queued IN (0,1)), updated_at TEXT NOT NULL,
  UNIQUE(batch_id,account_id,page_no)
);
INSERT INTO sync_batch_page_runs_new SELECT id,batch_id,account_id,page_no,page_url,page_kind,status,error,queued,updated_at FROM sync_batch_page_runs;
DROP TABLE sync_batch_page_runs;
ALTER TABLE sync_batch_page_runs_new RENAME TO sync_batch_page_runs;
CREATE INDEX idx_sync_page_runs_batch ON sync_batch_page_runs(batch_id,account_id,page_no);
CREATE INDEX idx_sync_account_lease ON sync_batch_accounts(account_id,status,lease_expires_at);
