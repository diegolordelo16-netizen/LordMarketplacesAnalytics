ALTER TABLE sync_batches ADD COLUMN browser_request INTEGER NOT NULL DEFAULT 0 CHECK(browser_request IN (0,1));
ALTER TABLE sync_batches ADD COLUMN browser_claimed_at TEXT;

CREATE INDEX idx_sync_browser_requests ON sync_batches(browser_request, status, requested_at);
