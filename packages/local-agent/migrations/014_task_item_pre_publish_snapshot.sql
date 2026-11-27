-- 014 — Snapshot original do anúncio, capturado antes do preenchimento do rascunho.
ALTER TABLE task_items ADD COLUMN before_title TEXT;
ALTER TABLE task_items ADD COLUMN before_description TEXT;
ALTER TABLE task_items ADD COLUMN baseline_source_url TEXT;
ALTER TABLE task_items ADD COLUMN baseline_captured_at TEXT;
CREATE INDEX IF NOT EXISTS idx_task_item_baseline ON task_items(task_id,baseline_captured_at);
