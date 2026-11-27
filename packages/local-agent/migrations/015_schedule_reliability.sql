-- 015 — agendamento configurável, histórico de análises e retentativa com backoff.
-- interval_minutes NULL mantém as cadências fixas legadas; valor presente usa cadence='1h' como fallback compatível.
ALTER TABLE analysis_schedules ADD COLUMN interval_minutes INTEGER
  CHECK(interval_minutes IS NULL OR interval_minutes BETWEEN 15 AND 43200);
ALTER TABLE analysis_schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
  CHECK(consecutive_failures BETWEEN 0 AND 3);

ALTER TABLE report_schedules ADD COLUMN interval_minutes INTEGER
  CHECK(interval_minutes IS NULL OR interval_minutes BETWEEN 15 AND 43200);
ALTER TABLE report_schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
  CHECK(consecutive_failures BETWEEN 0 AND 3);

CREATE TABLE IF NOT EXISTS analysis_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES analysis_schedules(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('COMPLETED','RETRYING','FAILED')),
  result_json TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0)
);
CREATE INDEX IF NOT EXISTS idx_analysis_schedule_runs
  ON analysis_schedule_runs(schedule_id, started_at DESC);
