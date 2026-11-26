-- Marketplace Intelligence — migration 001 (schema inicial)
-- Regras: timestamps UTC (TEXT ISO-8601), escopo por conta/loja, sem cookies/tokens de marketplace.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin','operador','visualizador')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_user_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  account_id TEXT,
  before_json TEXT,
  after_json TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK (source_class IN ('A_PRIMARY_UI','B_PLATFORM_EXPORT','C_AUTHORIZED_CONNECTOR','D_PUBLIC_OBSERVATION','E_MODELLED_ESTIMATE','F_USER_INPUT','G_UNAVAILABLE')),
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS data_source_runs (
  id TEXT PRIMARY KEY,
  data_source_id TEXT NOT NULL REFERENCES data_sources(id),
  account_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  records_read INTEGER NOT NULL DEFAULT 0,
  records_written INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  method TEXT
);
CREATE INDEX IF NOT EXISTS idx_dsr_account ON data_source_runs(account_id, started_at DESC);

CREATE TABLE IF NOT EXISTS data_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  account_id TEXT,
  listing_id TEXT,
  source_class TEXT NOT NULL,
  source_id TEXT NOT NULL,
  page_url TEXT,
  reference_at TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence REAL NOT NULL,
  sample_size INTEGER,
  run_id TEXT,
  UNIQUE(entity, entity_id, field, collected_at)
);
CREATE INDEX IF NOT EXISTS idx_prov_entity ON data_provenance(entity, entity_id);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at TEXT NOT NULL,
  account_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARN','CRITICAL')),
  field TEXT NOT NULL,
  message TEXT NOT NULL,
  context_json TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dqi_severity ON data_quality_issues(severity, detected_at DESC);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  status TEXT NOT NULL,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_ok INTEGER NOT NULL DEFAULT 0,
  rows_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  report_json TEXT
);

CREATE TABLE IF NOT EXISTS marketplaces (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  external_ref TEXT,
  display_name TEXT NOT NULL,
  handle TEXT,
  detection_confidence REAL NOT NULL DEFAULT 0,
  verified_by_user INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(marketplace, external_ref)
);
CREATE INDEX IF NOT EXISTS idx_accounts_marketplace ON accounts(marketplace);

CREATE TABLE IF NOT EXISTS catalog_products (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  category TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skus (
  id TEXT PRIMARY KEY,
  catalog_product_id TEXT REFERENCES catalog_products(id),
  sku_code TEXT NOT NULL,
  ean TEXT,
  gtin TEXT,
  upc TEXT,
  attributes_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(sku_code)
);
CREATE INDEX IF NOT EXISTS idx_skus_ean ON skus(ean);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  marketplace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  sku_id TEXT REFERENCES skus(id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  url TEXT,
  category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_listings_sku ON listings(sku_id);

CREATE TABLE IF NOT EXISTS listing_variations (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  external_id TEXT,
  attributes_json TEXT,
  stock INTEGER,
  price_cents INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listing_snapshots (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  reference_at TEXT NOT NULL,
  period_days INTEGER,
  metrics_json TEXT NOT NULL,
  state_json TEXT,
  source_class TEXT NOT NULL,
  quality_score REAL,
  UNIQUE(listing_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_snap_listing_time ON listing_snapshots(listing_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS sku_costs (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  version INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  packaging_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  other_variable_cents INTEGER NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  min_margin_pct REAL NOT NULL DEFAULT 20,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(sku_id, version)
);

CREATE TABLE IF NOT EXISTS marketplace_fees (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  category TEXT,
  commission_pct REAL NOT NULL,
  fixed_fee_cents INTEGER NOT NULL DEFAULT 0,
  installment_pct REAL NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  valid_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_fees_mk ON marketplace_fees(marketplace, category);

CREATE TABLE IF NOT EXISTS price_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT REFERENCES listings(id),
  competitor_listing_id TEXT,
  observed_at TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  shipping_cents INTEGER,
  discount_pct REAL,
  source_class TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_obs ON price_observations(listing_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS price_scenarios (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  created_at TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS price_rules (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  max_reduction_pct REAL NOT NULL DEFAULT 5,
  max_increase_pct REAL NOT NULL DEFAULT 5,
  min_margin_pct REAL NOT NULL DEFAULT 20,
  cooldown_days INTEGER NOT NULL DEFAULT 7,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_change_approvals (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  requested_price_cents INTEGER NOT NULL,
  approved INTEGER NOT NULL,
  approved_by TEXT,
  decided_at TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS keywords (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  normalized TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'pt-BR',
  intent TEXT NOT NULL,
  cluster_id TEXT,
  marketplace TEXT NOT NULL,
  region TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(marketplace, normalized)
);
CREATE INDEX IF NOT EXISTS idx_keywords_intent ON keywords(marketplace, intent);

CREATE TABLE IF NOT EXISTS keyword_clusters (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  label TEXT NOT NULL,
  method TEXT NOT NULL,
  corrected_manually INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  account_id TEXT,
  source_id TEXT NOT NULL,
  source_class TEXT NOT NULL,
  demand_label TEXT NOT NULL,
  demand_value REAL,
  trend_delta REAL,
  cpc_cents INTEGER,
  conversions INTEGER,
  ad_cost_cents INTEGER,
  observed_at TEXT NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kwobs_kw ON keyword_observations(keyword_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS keyword_competitor_gaps (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  keyword_id TEXT NOT NULL REFERENCES keywords(id),
  listing_id TEXT,
  competitor_listing_id TEXT,
  relation TEXT NOT NULL CHECK (relation IN ('GAP','OVERLAP')),
  computed_at TEXT NOT NULL,
  evidence_json TEXT
);

CREATE TABLE IF NOT EXISTS search_snapshots (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  account_id TEXT,
  term TEXT NOT NULL,
  category TEXT,
  device TEXT,
  location TEXT,
  captured_at TEXT NOT NULL,
  results_count INTEGER NOT NULL,
  context_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_searchsnap ON search_snapshots(marketplace, term, captured_at DESC);

CREATE TABLE IF NOT EXISTS search_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT NOT NULL REFERENCES search_snapshots(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  external_id TEXT,
  title TEXT,
  seller TEXT,
  price_cents INTEGER,
  is_sponsored INTEGER NOT NULL DEFAULT 0,
  is_own INTEGER NOT NULL DEFAULT 0,
  shipping_label TEXT,
  rating REAL,
  reviews INTEGER
);
CREATE INDEX IF NOT EXISTS idx_searchres ON search_results(snapshot_id, position);

CREATE TABLE IF NOT EXISTS rank_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  keyword_id TEXT REFERENCES keywords(id),
  snapshot_id TEXT REFERENCES search_snapshots(id),
  position INTEGER,
  is_sponsored INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  context_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rank_listing ON rank_observations(listing_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS visibility_share_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  term TEXT,
  captured_at TEXT NOT NULL,
  top3_presence REAL,
  top10_presence REAL,
  top20_presence REAL,
  own_share REAL,
  sample_json TEXT
);

CREATE TABLE IF NOT EXISTS competitors (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  marketplace TEXT NOT NULL,
  name TEXT NOT NULL,
  handle TEXT,
  group_kind TEXT NOT NULL CHECK (group_kind IN ('EQUIVALENT','SUBSTITUTE','BRAND','SELLER','CATEGORY')),
  created_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS competitor_listings (
  id TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  own_listing_id TEXT REFERENCES listings(id),
  match_level TEXT NOT NULL CHECK (match_level IN ('EXATA','ALTA','PROVAVEL','NAO_CORRESPONDE')),
  match_evidence_json TEXT,
  url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id TEXT PRIMARY KEY,
  competitor_listing_id TEXT NOT NULL REFERENCES competitor_listings(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  price_cents INTEGER,
  shipping_cents INTEGER,
  shipping_label TEXT,
  position INTEGER,
  is_sponsored INTEGER,
  title TEXT,
  rating REAL,
  reviews INTEGER,
  stock_signal TEXT,
  image_hash TEXT,
  attributes_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_compsnap ON competitor_snapshots(competitor_listing_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS competitor_events (
  id TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  impact_hypothesis TEXT,
  source_class TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitor_alerts (
  id TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  rule_json TEXT NOT NULL,
  severity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  muted_until TEXT
);

CREATE TABLE IF NOT EXISTS category_snapshots (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  account_id TEXT,
  category TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  source_class TEXT NOT NULL,
  sample_size INTEGER
);
CREATE INDEX IF NOT EXISTS idx_catsnap ON category_snapshots(marketplace, category, captured_at DESC);

CREATE TABLE IF NOT EXISTS category_trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  category TEXT,
  term TEXT,
  captured_at TEXT NOT NULL,
  relative_index REAL,
  source_class TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_opportunities (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  account_id TEXT,
  title TEXT NOT NULL,
  category TEXT,
  term TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ABERTA',
  validation_plan_json TEXT
);

CREATE TABLE IF NOT EXISTS opportunity_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_opportunity_id TEXT NOT NULL REFERENCES product_opportunities(id) ON DELETE CASCADE,
  computed_at TEXT NOT NULL,
  score REAL,
  components_json TEXT NOT NULL,
  confidence REAL,
  data_gaps_json TEXT
);

CREATE TABLE IF NOT EXISTS customer_voice_items (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  listing_id TEXT REFERENCES listings(id),
  kind TEXT NOT NULL CHECK (kind IN ('REVIEW','QUESTION','COMPLAINT','RETURN_REASON','MESSAGE')),
  source_class TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  text_redacted TEXT NOT NULL,
  rating INTEGER,
  verified_purchase INTEGER,
  external_ref TEXT,
  topic_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_cv_items ON customer_voice_items(account_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS customer_voice_topics (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  taxonomy TEXT NOT NULL,
  severity TEXT,
  sentiment REAL,
  frequency INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  evidence_json TEXT,
  financial_impact_cents INTEGER
);

CREATE TABLE IF NOT EXISTS return_reason_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT REFERENCES listings(id),
  observed_at TEXT NOT NULL,
  reason_code TEXT,
  reason_text_redacted TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  value_cents INTEGER
);

CREATE TABLE IF NOT EXISTS review_insights (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  listing_id TEXT,
  computed_at TEXT NOT NULL,
  promised_json TEXT,
  received_json TEXT,
  insight TEXT NOT NULL,
  confidence REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_definitions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  formula TEXT NOT NULL,
  unit TEXT NOT NULL,
  pillar TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS metric_tree_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  formula TEXT,
  is_north_star INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS growth_initiatives (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  pillar TEXT NOT NULL,
  rice_reach REAL,
  rice_impact REAL,
  rice_confidence REAL,
  rice_effort REAL,
  ice_impact REAL,
  ice_confidence REAL,
  ice_ease REAL,
  urgency REAL,
  risk TEXT,
  owner TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'BACKLOG',
  dependencies_json TEXT,
  cost_cents INTEGER,
  result_json TEXT,
  learning TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS growth_hypotheses (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  listing_id TEXT,
  bottleneck TEXT NOT NULL,
  statement TEXT NOT NULL,
  falsifiable_test TEXT,
  priority_score REAL,
  status TEXT NOT NULL DEFAULT 'ABERTA',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  hypothesis_id TEXT REFERENCES growth_hypotheses(id),
  title TEXT NOT NULL,
  design TEXT NOT NULL,
  variable TEXT NOT NULL,
  primary_metric TEXT NOT NULL,
  guardrail_metrics_json TEXT NOT NULL,
  baseline_rate REAL,
  mde REAL,
  planned_days INTEGER,
  min_sample_per_arm INTEGER,
  started_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'PLANEJADO',
  limitations_json TEXT,
  approved_by TEXT
);

CREATE TABLE IF NOT EXISTS experiment_variants (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_control INTEGER NOT NULL DEFAULT 0,
  change_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES experiment_variants(id),
  observed_at TEXT NOT NULL,
  exposures INTEGER NOT NULL,
  successes INTEGER NOT NULL,
  guardrails_json TEXT
);

CREATE TABLE IF NOT EXISTS experiment_results (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  computed_at TEXT NOT NULL,
  verdict TEXT NOT NULL,
  statistics_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  learning TEXT
);

CREATE TABLE IF NOT EXISTS cohorts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cohort_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort_id TEXT NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  period_index INTEGER NOT NULL,
  customers INTEGER,
  orders INTEGER,
  revenue_cents INTEGER,
  repurchase_rate REAL
);

CREATE TABLE IF NOT EXISTS attribution_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  attributed_revenue_cents INTEGER,
  attributed_orders INTEGER,
  spend_cents INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SCHEDULED','WAITING_BROWSER','RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED')),
  mode TEXT NOT NULL CHECK (mode IN ('DRAFT','PUBLISH')),
  schedule_at TEXT,
  recurrence TEXT,
  typing_json TEXT NOT NULL,
  options_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, schedule_at);

CREATE TABLE IF NOT EXISTS task_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  account_id TEXT NOT NULL,
  copies INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  description_additions TEXT,
  cover_image_id TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_taskitems ON task_items(task_id, order_index);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  items_total INTEGER NOT NULL,
  items_done INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  log_json TEXT
);

CREATE TABLE IF NOT EXISTS automation_guard_decisions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  action TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  blocked_reasons_json TEXT,
  decided_at TEXT NOT NULL,
  actor_user_id TEXT
);

CREATE TABLE IF NOT EXISTS change_sets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  field TEXT NOT NULL,
  before_text TEXT,
  after_text TEXT,
  diff_json TEXT,
  preservation_ok INTEGER,
  verified_after_save INTEGER,
  applied_at TEXT NOT NULL,
  rolled_back_at TEXT,
  actor_user_id TEXT,
  task_id TEXT
);

CREATE TABLE IF NOT EXISTS image_library (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  sku_id TEXT,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  format TEXT,
  validated INTEGER NOT NULL DEFAULT 0,
  validation_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS description_learnings (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  category TEXT NOT NULL,
  product_type TEXT,
  pattern_json TEXT NOT NULL,
  validations INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  last_validated_at TEXT,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS typing_profiles (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  editor_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  char_delay_ms INTEGER NOT NULL,
  settle_delay_ms INTEGER NOT NULL,
  needs_events INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE(marketplace, editor_key)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  account_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT,
  trigger TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_agentruns ON agent_runs(agent_key, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  excerpt TEXT
);

CREATE TABLE IF NOT EXISTS agent_recommendations (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  account_id TEXT,
  listing_id TEXT,
  diagnosis TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  window TEXT,
  facts_json TEXT,
  hypotheses_json TEXT,
  confidence REAL NOT NULL,
  missing_data_json TEXT,
  impact_range_json TEXT,
  risk TEXT,
  guardrail_metric TEXT,
  action_proposed TEXT,
  alternative TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  required_permission TEXT,
  verification_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'PROPOSTA',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_feedback (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT REFERENCES agent_recommendations(id),
  user_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  marketplace TEXT,
  account_id TEXT,
  category TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  validations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge_items(scope, marketplace, category);

CREATE TABLE IF NOT EXISTS validated_playbooks (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  category TEXT,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  evidence_json TEXT,
  success_rate REAL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gemini_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT,
  at TEXT NOT NULL,
  agent_key TEXT,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_gemini_at ON gemini_usage(at DESC);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(agent_key, version)
);

CREATE TABLE IF NOT EXISTS debate_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT,
  topic TEXT NOT NULL,
  context_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  decision TEXT
);

CREATE TABLE IF NOT EXISTS auto_upgrade_proposals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  module TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  diff_text TEXT NOT NULL,
  risk TEXT NOT NULL,
  tests_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('PROPOSTO','TESTANDO','APROVADO','APLICADO','REJEITADO','REVERTIDO')),
  approved_by TEXT,
  applied_at TEXT,
  rolled_back_at TEXT,
  backup_path TEXT
);

CREATE TABLE IF NOT EXISTS connector_registry (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  data_available TEXT,
  marketplaces_json TEXT,
  regions_json TEXT,
  limits TEXT,
  cost_note TEXT,
  refresh_policy TEXT,
  missing_fields TEXT,
  status TEXT NOT NULL DEFAULT 'NAO_CONECTADO',
  requires_credentials INTEGER NOT NULL DEFAULT 1,
  docs_url TEXT
);

CREATE TABLE IF NOT EXISTS connector_credentials_metadata (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connector_registry(id),
  label TEXT NOT NULL,
  masked_hint TEXT,
  stored_in TEXT NOT NULL DEFAULT 'secrets',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS connector_usage_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL REFERENCES connector_registry(id),
  at TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 1,
  estimated_cost_usd REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS forecast_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  mape REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS forecast_scenarios (
  id TEXT PRIMARY KEY,
  forecast_run_id TEXT NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  points_json TEXT NOT NULL,
  interval_low_json TEXT,
  interval_high_json TEXT
);

CREATE TABLE IF NOT EXISTS anomaly_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  baseline REAL,
  observed REAL,
  severity TEXT NOT NULL,
  rule TEXT NOT NULL,
  confidence REAL,
  evidence_json TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARN','CRITICAL')),
  title TEXT NOT NULL,
  rule TEXT NOT NULL,
  baseline_json TEXT,
  evidence_json TEXT,
  potential_impact_cents INTEGER,
  confidence REAL,
  recommendation TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  muted_until TEXT,
  false_positive INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts ON alerts(severity, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  kind TEXT NOT NULL,
  checksum TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);
