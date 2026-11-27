-- 016 — agendamento persistente de coletas via extensão em navegador ativo.
-- A agenda cria lotes locais; a extensão só coleta quando encontra abas autenticadas
-- com identidade visível exatamente igual à conta agendada.
CREATE TABLE IF NOT EXISTS sync_schedules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('ALL_ACTIVE_ACCOUNTS','ALL_ENABLED_MARKETPLACES','ACCOUNT')),
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  cadence TEXT NOT NULL CHECK(cadence IN ('1h','6h','daily','weekly')),
  interval_minutes INTEGER CHECK(interval_minutes IS NULL OR interval_minutes BETWEEN 15 AND 43200),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((scope='ACCOUNT' AND account_id IS NOT NULL) OR (scope<>'ACCOUNT' AND account_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_sync_schedules_due ON sync_schedules(enabled,next_run_at);

CREATE TABLE IF NOT EXISTS sync_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES sync_schedules(id) ON DELETE CASCADE,
  batch_id TEXT UNIQUE REFERENCES sync_batches(id) ON DELETE SET NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_schedule_runs ON sync_schedule_runs(schedule_id,scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_schedule_runs_pending ON sync_schedule_runs(status,scheduled_at);
