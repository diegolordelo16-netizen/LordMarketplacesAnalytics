-- @requires_foreign_keys_off
-- Rebuild only the parent; foreign_key_check runs inside the migration transaction.
CREATE TABLE report_schedules_v2 (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK(report_type IN ('EXECUTIVO','KPIS','ANUNCIO','CONCORRENCIA','FINANCEIRO','EXPERIMENTOS','AUDITORIA')),
  format TEXT NOT NULL CHECK(format IN ('json','csv','xlsx')),
  cadence TEXT NOT NULL CHECK(cadence IN ('1h','6h','daily','weekly')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  interval_minutes INTEGER CHECK(interval_minutes IS NULL OR interval_minutes BETWEEN 15 AND 43200),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures BETWEEN 0 AND 3)
);
INSERT INTO report_schedules_v2 (id,account_id,report_type,format,cadence,enabled,next_run_at,last_run_at,last_status,last_error,created_by,created_at,updated_at,interval_minutes,consecutive_failures)
SELECT id,account_id,report_type,format,cadence,enabled,next_run_at,last_run_at,last_status,last_error,created_by,created_at,updated_at,interval_minutes,consecutive_failures FROM report_schedules;
DROP TABLE report_schedules;
ALTER TABLE report_schedules_v2 RENAME TO report_schedules;
CREATE INDEX idx_report_schedules_due ON report_schedules(enabled,next_run_at);
