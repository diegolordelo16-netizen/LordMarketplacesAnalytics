-- 010 — Base persistente para os requisitos que estavam sem implementação.
-- Dados ausentes permanecem NULL; propostas e sincronizações não publicam sem autorização.

ALTER TABLE competitor_candidates ADD COLUMN shipping_cents INTEGER;
ALTER TABLE competitor_candidates ADD COLUMN delivery_days_min REAL;
ALTER TABLE competitor_candidates ADD COLUMN delivery_days_max REAL;
ALTER TABLE competitor_candidates ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE competitor_candidates ADD COLUMN sponsored INTEGER;
ALTER TABLE competitor_monitoring_points ADD COLUMN shipping_cents INTEGER;
ALTER TABLE competitor_monitoring_points ADD COLUMN delivery_days_min REAL;
ALTER TABLE competitor_monitoring_points ADD COLUMN delivery_days_max REAL;
ALTER TABLE competitor_monitoring_points ADD COLUMN sponsored INTEGER;
ALTER TABLE own_products ADD COLUMN shipping_cents INTEGER;
ALTER TABLE own_products ADD COLUMN delivery_days_min REAL;
ALTER TABLE own_products ADD COLUMN delivery_days_max REAL;

CREATE TABLE IF NOT EXISTS sync_batches (
  id TEXT PRIMARY KEY,
  requested_by TEXT,
  scope TEXT NOT NULL CHECK(scope IN ('ALL_ACTIVE_ACCOUNTS','ALL_ENABLED_MARKETPLACES','ACCOUNT')),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','PARTIAL','COMPLETED','FAILED','CANCELLED')),
  requested_at TEXT NOT NULL,
  finished_at TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sync_batch_accounts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  marketplace TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('WAITING_BROWSER','RUNNING','COMPLETED','PARTIAL','FAILED','SKIPPED')),
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  pages_succeeded INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(batch_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_batch_status ON sync_batch_accounts(batch_id,status);

CREATE TABLE IF NOT EXISTS operation_profiles (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('AUTO_PILOT','AUTO_ASSISTED','MANUAL_GUIDED')),
  policy_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_schedules (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('RAPIDA','PADRAO','FORENSE','360')),
  days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 365),
  cadence TEXT NOT NULL CHECK(cadence IN ('1h','6h','daily','weekly')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_schedules_due ON analysis_schedules(enabled,next_run_at);

CREATE TABLE IF NOT EXISTS report_schedules (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK(report_type IN ('EXECUTIVO','KPIS','CONCORRENCIA','FINANCEIRO','EXPERIMENTOS','AUDITORIA')),
  format TEXT NOT NULL CHECK(format IN ('json','csv','xlsx')),
  cadence TEXT NOT NULL CHECK(cadence IN ('1h','6h','daily','weekly')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_due ON report_schedules(enabled,next_run_at);
CREATE TABLE IF NOT EXISTS report_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('COMPLETED','FAILED')),
  report_json TEXT,
  error TEXT,
  row_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_report_schedule_runs ON report_schedule_runs(schedule_id,generated_at DESC);

CREATE TABLE IF NOT EXISTS realized_profit_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  net_revenue_cents INTEGER NOT NULL CHECK(net_revenue_cents >= 0),
  product_cost_cents INTEGER NOT NULL CHECK(product_cost_cents >= 0),
  packaging_cents INTEGER NOT NULL CHECK(packaging_cents >= 0),
  shipping_cents INTEGER NOT NULL CHECK(shipping_cents >= 0),
  marketplace_fees_cents INTEGER NOT NULL CHECK(marketplace_fees_cents >= 0),
  taxes_cents INTEGER NOT NULL CHECK(taxes_cents >= 0),
  ad_spend_cents INTEGER NOT NULL CHECK(ad_spend_cents >= 0),
  refunds_cents INTEGER NOT NULL CHECK(refunds_cents >= 0),
  return_logistics_cents INTEGER NOT NULL CHECK(return_logistics_cents >= 0),
  cancellation_loss_cents INTEGER NOT NULL CHECK(cancellation_loss_cents >= 0),
  other_costs_cents INTEGER NOT NULL CHECK(other_costs_cents >= 0),
  source_class TEXT NOT NULL CHECK(source_class IN ('A_PRIMARY_UI','B_PLATFORM_EXPORT','F_USER_INPUT')),
  evidence_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE(account_id,listing_id,period_start,period_end,source_class)
);
CREATE INDEX IF NOT EXISTS idx_realized_profit_period ON realized_profit_snapshots(account_id,period_end DESC);

CREATE TABLE IF NOT EXISTS campaign_change_proposals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','APPROVED','REJECTED','BLOCKED','EXECUTED','FAILED')),
  approved_by TEXT,
  approved_at TEXT,
  execution_ref TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_proposals ON campaign_change_proposals(account_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS offer_variation_proposals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  variation_name TEXT NOT NULL,
  options_json TEXT NOT NULL,
  proposed_price_cents INTEGER CHECK(proposed_price_cents IS NULL OR proposed_price_cents >= 0),
  proposed_stock INTEGER CHECK(proposed_stock IS NULL OR proposed_stock >= 0),
  status TEXT NOT NULL CHECK(status IN ('DRAFT','APPROVED','REJECTED','PUBLISHED','BLOCKED')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_verifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  observed_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','VERIFIED','MISMATCH','NOT_VERIFIABLE')),
  verified_at TEXT,
  source_url TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_verifications_item ON change_verifications(item_id,verified_at DESC);

CREATE TABLE IF NOT EXISTS connector_runtime_config (
  connector_id TEXT PRIMARY KEY REFERENCES connector_registry(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  public_config_json TEXT NOT NULL DEFAULT '{}',
  secret_namespace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIGURACAO_PENDENTE',
  last_test_at TEXT,
  last_test_status TEXT,
  last_test_message TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_oauth_states (
  state_hash TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connector_registry(id) ON DELETE CASCADE,
  verifier_secret_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
