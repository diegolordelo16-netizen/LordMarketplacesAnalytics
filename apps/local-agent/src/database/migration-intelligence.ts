/**
 * Terceira migração: inteligência competitiva, edição de descrição,
 * financeiro e missões do dia.
 *
 * Regras que o schema impõe:
 *  - Concorrente monitorado é um anúncio observado, não um palpite: guarda
 *    link, marketplace, e a cada coleta um snapshot datado (append-only).
 *  - Título é imutável no editor: a tabela de edições não tem coluna de
 *    título novo — só a descrição antes e depois, com o diff calculado.
 *  - Custo e taxa têm versão e data: margem calculada com custo de hoje não
 *    pode reescrever a margem do mês passado.
 */
export const MIGRATION_INTELLIGENCE = `

-- ---------------------------------------------------- concorrentes

CREATE TABLE IF NOT EXISTS competitors (
  id              TEXT PRIMARY KEY,
  -- Marketplace detectado a partir do próprio link (mercadolivre, shopee, ...).
  marketplace     TEXT NOT NULL,
  -- Identificador do anúncio dentro do marketplace (MLB123..., shopid:itemid).
  external_ref    TEXT NOT NULL,
  url             TEXT NOT NULL,
  -- Título e vendedor como apareceram na última coleta (podem mudar).
  title           TEXT,
  seller          TEXT,
  -- Produto próprio relacionado (SKU ou entity_ref) — ligação feita pelo
  -- usuário ou sugerida por similaridade; nunca automática sem confirmação.
  linked_entity_ref TEXT,
  link_confidence TEXT CHECK (link_confidence IN ('EXATA','ALTA','PROVAVEL','MANUAL')),
  status          TEXT NOT NULL CHECK (status IN ('MONITORING','PAUSED','DELETED')) DEFAULT 'MONITORING',
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_collected_at TEXT,
  UNIQUE (marketplace, external_ref)
);

CREATE INDEX IF NOT EXISTS ix_competitors_status ON competitors(status, marketplace);

-- Cada coleta é uma linha. Nunca sobrescreve: histórico é a razão de existir.
CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id             TEXT PRIMARY KEY,
  competitor_id  TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  collected_at   TEXT NOT NULL,
  -- Valores podem ser NULL: nulo é "não legível", diferente de zero.
  price_cents    INTEGER,
  list_price_cents INTEGER,
  sold_count     INTEGER,
  rating         REAL,
  reviews_count  INTEGER,
  stock_text     TEXT,
  shipping_text  TEXT,
  position       INTEGER,
  title          TEXT,
  description_len INTEGER,
  -- Qualidade por campo: mesmo vocabulário do resto do produto.
  quality        TEXT NOT NULL,
  source         TEXT NOT NULL,
  page_url       TEXT NOT NULL,
  method         TEXT NOT NULL,
  raw_json       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS ix_competitor_snapshots ON competitor_snapshots(competitor_id, collected_at DESC);

-- Eventos derivados das coletas (preço caiu, saiu do ar, vendas aceleraram).
CREATE TABLE IF NOT EXISTS competitor_events (
  id             TEXT PRIMARY KEY,
  competitor_id  TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('INFO','ATTENTION','CRITICAL')),
  summary        TEXT NOT NULL,
  evidence       TEXT NOT NULL,
  detected_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_competitor_events ON competitor_events(detected_at DESC);

-- ---------------------------------------------------- edição de descrição

CREATE TABLE IF NOT EXISTS description_edits (
  id             TEXT PRIMARY KEY,
  marketplace    TEXT NOT NULL,
  entity_ref     TEXT NOT NULL,
  -- O título ORIGINAL fica gravado aqui só para provar que não mudou.
  title_original TEXT NOT NULL,
  description_before TEXT NOT NULL,
  description_after  TEXT NOT NULL,
  -- Trechos acrescentados, em JSON: [{ text, reason, source }].
  additions      TEXT NOT NULL DEFAULT '[]',
  -- Rascunho gerado, aguardando aprovação do proprietário.
  status         TEXT NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','APPLIED')),
  generated_by   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  decided_at     TEXT,
  decision_note  TEXT
);

CREATE INDEX IF NOT EXISTS ix_description_edits ON description_edits(status, created_at DESC);

-- ---------------------------------------------------- financeiro

-- Custo e parâmetros por SKU, versionados por data de vigência.
CREATE TABLE IF NOT EXISTS sku_costs (
  id             TEXT PRIMARY KEY,
  entity_ref     TEXT NOT NULL,
  marketplace    TEXT,
  -- Centavos. NULL = não informado (nunca vira zero).
  cost_cents     INTEGER,
  packaging_cents INTEGER,
  -- Percentuais em pontos-base (1000 = 10%) para não perder precisão.
  commission_bp  INTEGER,
  tax_bp         INTEGER,
  fixed_fee_cents INTEGER,
  freight_cents  INTEGER,
  min_margin_bp  INTEGER,
  effective_from TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sku_costs ON sku_costs(entity_ref, effective_from DESC);

-- ---------------------------------------------------- missões do dia

CREATE TABLE IF NOT EXISTS daily_missions (
  id             TEXT PRIMARY KEY,
  day            TEXT NOT NULL,
  entity_ref     TEXT,
  marketplace    TEXT,
  pillar         TEXT NOT NULL,
  bottleneck     TEXT NOT NULL,
  hypothesis     TEXT NOT NULL,
  evidence       TEXT NOT NULL,
  impact_cents   INTEGER,
  impact_pct     REAL,
  effort         INTEGER NOT NULL CHECK (effort BETWEEN 1 AND 5),
  urgency        INTEGER NOT NULL CHECK (urgency BETWEEN 1 AND 5),
  risk           TEXT NOT NULL,
  score          REAL NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('OPEN','DONE','DISMISSED')) DEFAULT 'OPEN',
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_daily_missions ON daily_missions(day, score DESC);

`;
