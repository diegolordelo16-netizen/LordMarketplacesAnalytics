CREATE TABLE report_rollback_links (change_set_id TEXT PRIMARY KEY REFERENCES change_sets(id),task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),created_at TEXT NOT NULL,verified_at TEXT);
CREATE INDEX idx_report_rollback_task ON report_rollback_links(task_id);
