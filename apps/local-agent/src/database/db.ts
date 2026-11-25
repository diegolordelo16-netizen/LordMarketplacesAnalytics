/**
 * Banco local (SQLite) — fonte de verdade do serviço local.
 *
 * Usa o módulo nativo `node:sqlite` do Node 22: WAL, foreign keys e zero
 * dependência binária para compilar. Isso importa para o instalador final:
 * nada de node-gyp, nada de .node extra para assinar.
 *
 * Regra de integridade que este arquivo impõe no schema:
 *   nenhum dado entra sem proveniência completa (fonte, marketplace, conta,
 *   página, data de referência, data de coleta, método, status de qualidade).
 *   Não é validação de aplicação: é NOT NULL no banco.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATION_INTELLIGENCE } from "./migration-intelligence.js";
import { MIGRATION_DISCOVERY } from "./migration-discovery.js";

export const QUALITY_STATUSES = [
  "ZERO",
  "UNKNOWN",
  "NOT_COLLECTED",
  "UNAVAILABLE",
  "ESTIMATED",
  "CALCULATED",
  "VERIFIED",
] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

/** Migrations aplicadas em ordem, cada uma transacional. Imutáveis depois. */
const MIGRATIONS: { id: string; sql: string }[] = [
  { id: "0003_intelligence", sql: MIGRATION_INTELLIGENCE },
  { id: "0004_discovery", sql: MIGRATION_DISCOVERY },
  {
    id: "0001_core",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TEXT NOT NULL
      );

      -- Contas locais: o primeiro registro é o OWNER_PRINCIPAL.
      CREATE TABLE IF NOT EXISTS accounts (
        id             TEXT PRIMARY KEY,
        display_name   TEXT NOT NULL,
        is_owner       INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1)),
        password_hash  TEXT,
        created_at     TEXT NOT NULL
      );
      -- Só pode existir um OWNER_PRINCIPAL.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_single_owner
        ON accounts(is_owner) WHERE is_owner = 1;

      -- Conta/loja identificada dentro de um marketplace.
      CREATE TABLE IF NOT EXISTS marketplace_accounts (
        id              TEXT PRIMARY KEY,
        marketplace     TEXT NOT NULL,
        external_ref    TEXT NOT NULL,
        label           TEXT NOT NULL,
        identified_at   TEXT NOT NULL,
        UNIQUE (marketplace, external_ref)
      );

      -- Execução de coleta: uma passada sobre uma página reconhecida.
      CREATE TABLE IF NOT EXISTS collection_runs (
        id             TEXT PRIMARY KEY,
        marketplace    TEXT NOT NULL,
        account_id     TEXT REFERENCES marketplace_accounts(id) ON DELETE RESTRICT,
        page_kind      TEXT NOT NULL,
        page_url       TEXT NOT NULL,
        started_at     TEXT NOT NULL,
        finished_at    TEXT,
        outcome        TEXT NOT NULL CHECK (outcome IN ('RUNNING','COMPLETED','PARTIAL','FAILED')),
        failure_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_collection_runs_time
        ON collection_runs(marketplace, started_at);

      -- Um dado observado, sempre com proveniência completa.
      CREATE TABLE IF NOT EXISTS data_points (
        id               TEXT PRIMARY KEY,
        run_id           TEXT NOT NULL REFERENCES collection_runs(id) ON DELETE RESTRICT,
        entity_type      TEXT NOT NULL,
        entity_ref       TEXT NOT NULL,
        metric           TEXT NOT NULL,
        -- valor em texto: ZERO e NULL são coisas diferentes e precisam coexistir
        value_raw        TEXT,
        value_num        INTEGER,
        unit             TEXT,
        quality          TEXT NOT NULL CHECK (quality IN
          ('ZERO','UNKNOWN','NOT_COLLECTED','UNAVAILABLE','ESTIMATED','CALCULATED','VERIFIED')),
        source           TEXT NOT NULL,
        marketplace      TEXT NOT NULL,
        account_ref      TEXT,
        page_kind        TEXT NOT NULL,
        page_url         TEXT NOT NULL,
        reference_date   TEXT NOT NULL,
        collected_at     TEXT NOT NULL,
        method           TEXT NOT NULL,
        adapter_version  TEXT NOT NULL,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_data_points_series
        ON data_points(entity_type, entity_ref, metric, reference_date, collected_at);
      CREATE INDEX IF NOT EXISTS ix_data_points_run ON data_points(run_id);
      -- Recaptura não sobrescreve: nunca há chave única por (entidade, métrica, data).
      -- Uma segunda leitura idêntica é uma nova observação, não uma correção silenciosa.

      -- Uso do Gemini: contado no banco para a cota sobreviver a reinícios.
      CREATE TABLE IF NOT EXISTS gemini_calls (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        day          TEXT NOT NULL,
        at           TEXT NOT NULL,
        kind         TEXT NOT NULL,
        prompt_chars INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_gemini_calls_day ON gemini_calls(day);

      -- Consultas extraordinárias autorizadas pelo proprietário.
      CREATE TABLE IF NOT EXISTS gemini_grants (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        day      TEXT NOT NULL,
        at       TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0)
      );

      -- Central de Melhorias: propostas que só o OWNER_PRINCIPAL aprova.
      CREATE TABLE IF NOT EXISTS improvements (
        id            TEXT PRIMARY KEY,
        created_at    TEXT NOT NULL,
        title         TEXT NOT NULL,
        rationale     TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('rule','adapter','metric','ui','prompt')),
        payload       TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','APPLIED')),
        decided_by    TEXT,
        decided_at    TEXT,
        decision_note TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_improvements_status ON improvements(status, created_at);

      -- Trilha de auditoria com encadeamento de hash (append-only na aplicação).
      CREATE TABLE IF NOT EXISTS audit_log (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        at         TEXT NOT NULL,
        kind       TEXT NOT NULL,
        detail     TEXT NOT NULL,
        prev_hash  TEXT NOT NULL,
        hash       TEXT NOT NULL
      );
    `,
  },
];

export interface OpenOptions {
  /** Caminho do arquivo .db; ":memory:" para testes. */
  path: string;
  now?: () => number;
}

export class LocalDatabase {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: OpenOptions) {
    this.now = options.now ?? Date.now;
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  /** Migrations idempotentes e transacionais. Aplicada = imutável. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (this.db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date(this.now()).toISOString());
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw new Error(`migration ${migration.id} falhou: ${String(err)}`);
      }
    }
  }

  /** Versões de migration aplicadas (para o painel de saúde). */
  migrations(): string[] {
    return (this.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[]).map(
      (r) => r.id,
    );
  }

  close(): void {
    this.db.close();
  }

  /** Acesso direto para repositórios (não expor à extensão). */
  raw(): DatabaseSync {
    return this.db;
  }
}
