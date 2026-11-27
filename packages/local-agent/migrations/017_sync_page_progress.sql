-- 017 — progresso por página e retomada idempotente da navegação de coleta.
-- Guarda apenas URLs da allowlist do marketplace, estado da fila e metadados da página; sem conteúdo privado bruto.
ALTER TABLE sync_batch_accounts ADD COLUMN current_page_no INTEGER CHECK(current_page_no IS NULL OR current_page_no BETWEEN 1 AND 12);
ALTER TABLE sync_batch_accounts ADD COLUMN current_url TEXT;
ALTER TABLE sync_batch_accounts ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sync_batch_accounts ADD COLUMN progress_updated_at TEXT;

CREATE TABLE IF NOT EXISTS sync_batch_page_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL CHECK(page_no BETWEEN 1 AND 12),
  page_url TEXT NOT NULL,
  page_kind TEXT NOT NULL CHECK(page_kind IN ('seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory')),
  status TEXT NOT NULL CHECK(status IN ('COMPLETED','FAILED','QUEUED')),
  error TEXT,
  queued INTEGER NOT NULL DEFAULT 0 CHECK(queued IN (0,1)),
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id,account_id,page_no)
);
CREATE INDEX IF NOT EXISTS idx_sync_page_runs_batch ON sync_batch_page_runs(batch_id,account_id,page_no);
