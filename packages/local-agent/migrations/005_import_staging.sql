-- Linhas importadas ficam em staging até mapeamento, validação e promoção explícita.
CREATE TABLE IF NOT EXISTS import_job_rows (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, row_number)
);
CREATE INDEX IF NOT EXISTS idx_import_job_rows ON import_job_rows(job_id, row_number);
