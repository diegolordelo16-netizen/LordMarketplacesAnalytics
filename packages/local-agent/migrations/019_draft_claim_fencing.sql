-- 019 — Reserva exclusiva de rascunho e recuperação manual sem aceitar resultados atrasados.
ALTER TABLE task_items ADD COLUMN draft_claim_token TEXT;
ALTER TABLE task_items ADD COLUMN draft_claimed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_taskitem_draft_claim ON task_items(account_id, listing_id, status);
