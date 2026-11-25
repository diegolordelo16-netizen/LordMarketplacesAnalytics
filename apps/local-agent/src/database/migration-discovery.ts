/**
 * Quarta migração: descoberta assistida de concorrentes.
 *
 * O que o schema garante:
 *  - Nenhuma sugestão é concorrente monitorado até uma decisão humana. São
 *    tabelas separadas: `competitor_candidates` (sugestão) e `competitors`
 *    (monitorado). Aprovar é o único caminho de uma para a outra.
 *  - A rejeição guarda o motivo e não some: é o histórico que alimenta as
 *    próximas buscas. Rejeitar não apaga — muda o status.
 *  - Toda sugestão registra como foi pontuada (componentes da similaridade),
 *    para que a nota possa ser explicada e auditada depois.
 */
export const MIGRATION_DISCOVERY = `

-- Produto meu que serve de base para a busca.
CREATE TABLE IF NOT EXISTS product_profiles (
  id              TEXT PRIMARY KEY,
  entity_ref      TEXT NOT NULL UNIQUE,
  marketplace     TEXT NOT NULL,
  title           TEXT NOT NULL,
  brand           TEXT,
  model           TEXT,
  category        TEXT,
  -- JSON: { "tipo": "capacete fechado", ... } — só o que o usuário confirmou.
  attributes      TEXT,
  variations      TEXT,
  image_url       TEXT,
  price_cents     INTEGER,
  url             TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Sugestão da IA aguardando revisão humana.
CREATE TABLE IF NOT EXISTS competitor_candidates (
  id                TEXT PRIMARY KEY,
  product_id        TEXT NOT NULL REFERENCES product_profiles(id) ON DELETE CASCADE,
  marketplace       TEXT NOT NULL,
  external_ref      TEXT NOT NULL,
  url               TEXT NOT NULL,
  title             TEXT,
  seller            TEXT,
  price_cents       INTEGER,
  image_url         TEXT,
  description       TEXT,
  -- DIRETO (mesmo modelo), SIMILAR (equivalente), INDIRETO (mesma categoria).
  relation          TEXT NOT NULL CHECK (relation IN ('DIRETO','SIMILAR','INDIRETO')),
  -- Similaridade de 0 a 10000 (centésimos de %), inteira: sem float.
  similarity_bp     INTEGER NOT NULL,
  -- JSON com o que puxou a nota para cima e para baixo.
  components        TEXT NOT NULL,
  justification     TEXT NOT NULL,
  -- PENDENTE é o estado inicial de toda sugestão. Nunca nasce aprovada.
  status            TEXT NOT NULL CHECK (status IN ('PENDENTE','APROVADO','REJEITADO','DESCARTADO')) DEFAULT 'PENDENTE',
  origin            TEXT NOT NULL DEFAULT 'IA',
  rejection_reason  TEXT,
  reviewed_at       TEXT,
  competitor_id     TEXT REFERENCES competitors(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- A mesma sugestão não se repete para o mesmo produto.
  UNIQUE (product_id, marketplace, external_ref)
);

CREATE INDEX IF NOT EXISTS ix_candidates_status ON competitor_candidates(status, product_id);

-- Decisão humana: registro imutável do que o dono decidiu e por quê.
-- É a matéria-prima do aprendizado — nunca é reescrita.
CREATE TABLE IF NOT EXISTS review_feedback (
  id               TEXT PRIMARY KEY,
  candidate_id     TEXT NOT NULL,
  product_id       TEXT NOT NULL,
  marketplace      TEXT NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('APROVADO','REJEITADO','EDITADO')),
  relation_before  TEXT,
  relation_after   TEXT,
  similarity_bp    INTEGER,
  reason           TEXT,
  -- Assinatura do produto próprio no momento da decisão (marca, categoria,
  -- modelo), para o aprendizado saber a que tipo de produto se aplica.
  product_signature TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_feedback_product ON review_feedback(product_id, created_at);
`;
