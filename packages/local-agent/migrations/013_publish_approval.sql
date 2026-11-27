-- 013 — Publicação assistida, individual e explicitamente autorizada.
-- Uma aprovação é vinculada a um item/anúncio/conta, expira e só pode ser consumida uma vez.
CREATE TABLE IF NOT EXISTS task_publish_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  external_listing_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('APPROVED','EXECUTING','PUBLISHED','CANCELLED','FAILED','NEEDS_VERIFICATION','EXPIRED')),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  execution_started_at TEXT,
  execution_finished_at TEXT,
  result_json TEXT,
  reason TEXT NOT NULL,
  UNIQUE(item_id)
);
CREATE INDEX IF NOT EXISTS idx_task_publish_queue
  ON task_publish_approvals(status, marketplace, external_listing_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_task_publish_account
  ON task_publish_approvals(account_id, approved_at DESC);
