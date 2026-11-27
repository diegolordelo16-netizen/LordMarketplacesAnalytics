-- 021: reservation fence for account collection.
ALTER TABLE sync_batch_accounts ADD COLUMN lease_hash TEXT;
ALTER TABLE sync_batch_accounts ADD COLUMN lease_expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sync_account_lease ON sync_batch_accounts(account_id,status,lease_expires_at);
