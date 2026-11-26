-- 002 — Inteligência competitiva assistida (§22 evoluído)
--
-- Fluxo: produto próprio → busca assistida → sugestões PENDENTES → revisão humana
-- (aprovar/rejeitar/editar/recategorizar/reanalisar) → monitoramento contínuo.
-- O aprendizado usa as decisões humanas como feedback explícito e auditável.

-- Produto próprio que serve de âncora para a busca de concorrentes.
CREATE TABLE IF NOT EXISTS own_products (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT REFERENCES listings(id),
  marketplace TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  title TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  category TEXT,
  attributes_json TEXT,
  variations_json TEXT,
  images_json TEXT,
  price_cents INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_own_products_account ON own_products(account_id, marketplace);

-- Anúncios candidatos encontrados na busca assistida (antes de virarem concorrente).
CREATE TABLE IF NOT EXISTS competitor_candidates (
  id TEXT PRIMARY KEY,
  own_product_id TEXT NOT NULL REFERENCES own_products(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  title TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  category TEXT,
  attributes_json TEXT,
  price_cents INTEGER,
  rating REAL,
  reviews INTEGER,
  seller TEXT,
  image_hash TEXT,
  /** Classe de origem: só A_PRIMARY_UI/B_PLATFORM_EXPORT são dados reais. */
  source_class TEXT NOT NULL,
  /** Como o anúncio foi encontrado (busca assistida, link informado, lista do vendedor). */
  discovery_method TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(own_product_id, marketplace, external_id)
);
CREATE INDEX IF NOT EXISTS idx_candidates_own ON competitor_candidates(own_product_id, last_seen_at DESC);

-- Relacionamento sugerido/decidido entre o produto próprio e um candidato.
CREATE TABLE IF NOT EXISTS competitor_relations (
  id TEXT PRIMARY KEY,
  own_product_id TEXT NOT NULL REFERENCES own_products(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES competitor_candidates(id) ON DELETE CASCADE,
  /** DIRETO = mesmo produto/modelo; SIMILAR = equivalente; INDIRETO = mesma categoria. */
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('DIRETO','SIMILAR','INDIRETO')),
  /** PENDENTE é o estado inicial obrigatório: nada entra em monitoramento sem revisão humana. */
  status TEXT NOT NULL CHECK (status IN ('PENDENTE','APROVADO','REJEITADO')),
  similarity_pct REAL NOT NULL,
  /** Justificativa legível, campo a campo (nunca só um número). */
  rationale_json TEXT NOT NULL,
  /** Motor que gerou a sugestão: regras locais, IA (Gemini) ou humano. */
  suggested_by TEXT NOT NULL,
  suggested_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  /** Motivo informado na rejeição — alimenta o aprendizado. */
  rejection_reason TEXT,
  /** Ajustes manuais feitos na revisão (rótulo, dados do anúncio). */
  manual_edits_json TEXT,
  /** Monitoramento contínuo só existe depois de aprovado. */
  monitoring_state TEXT NOT NULL DEFAULT 'PAUSADO' CHECK (monitoring_state IN ('ATIVO','PAUSADO','REMOVIDO')),
  last_reanalysis_at TEXT,
  UNIQUE(own_product_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_status ON competitor_relations(status, own_product_id);
CREATE INDEX IF NOT EXISTS idx_relations_monitoring ON competitor_relations(monitoring_state) WHERE status = 'APROVADO';

-- Feedback humano: cada decisão vira um registro explícito para o motor de aprendizado.
CREATE TABLE IF NOT EXISTS competitor_feedback (
  id TEXT PRIMARY KEY,
  relation_id TEXT REFERENCES competitor_relations(id) ON DELETE CASCADE,
  own_product_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APROVADO','REJEITADO','EDITADO','RECATEGORIZADO','REANALISADO')),
  from_kind TEXT,
  to_kind TEXT,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  /** Atributos do candidato no momento da decisão: base do aprendizado por padrão. */
  features_json TEXT NOT NULL,
  actor_user_id TEXT,
  actor_role TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_own ON competitor_feedback(own_product_id, created_at DESC);

-- Regras aprendidas: derivadas do histórico, aplicadas nas próximas buscas.
-- Não é "modelo treinado": é regra explícita, com contagem e evidência, revisável.
CREATE TABLE IF NOT EXISTS competitor_learning_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  /** Escopo da regra: marca, categoria, termo do título, atributo, vendedor. */
  scope TEXT NOT NULL CHECK (scope IN ('BRAND','CATEGORY','TITLE_TERM','ATTRIBUTE','SELLER','MODEL')),
  value TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('PREFERIR','EVITAR')),
  /** Quantas decisões humanas sustentam a regra. */
  support INTEGER NOT NULL,
  /** Contraexemplos: decisões no sentido oposto. */
  counter_support INTEGER NOT NULL DEFAULT 0,
  weight REAL NOT NULL,
  first_learned_at TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  UNIQUE(account_id, scope, value, direction)
);

-- Histórico de monitoramento de cada concorrente aprovado.
CREATE TABLE IF NOT EXISTS competitor_monitoring_points (
  id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL REFERENCES competitor_relations(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  price_cents INTEGER,
  position INTEGER,
  rating REAL,
  reviews INTEGER,
  stock_signal TEXT,
  title TEXT,
  variations_json TEXT,
  promotions_json TEXT,
  source_class TEXT NOT NULL,
  UNIQUE(relation_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_points ON competitor_monitoring_points(relation_id, captured_at DESC);

-- Execuções de busca: precisão das recomendações ao longo do tempo.
CREATE TABLE IF NOT EXISTS competitor_search_runs (
  id TEXT PRIMARY KEY,
  own_product_id TEXT NOT NULL REFERENCES own_products(id) ON DELETE CASCADE,
  marketplaces_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  candidates_found INTEGER NOT NULL DEFAULT 0,
  suggestions_created INTEGER NOT NULL DEFAULT 0,
  used_ai INTEGER NOT NULL DEFAULT 0,
  notes_json TEXT
);
