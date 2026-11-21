/**
 * Repositório de coleta e de dados observados.
 *
 * Duas garantias que este arquivo sustenta:
 *  1. Um dado só entra com proveniência completa — validação explícita, não
 *     confiança no chamador.
 *  2. Recaptura nunca sobrescreve: cada leitura vira uma nova observação.
 *     O histórico é a memória do produto; apagar é perder a inteligência.
 */
import type { LocalDatabase, QualityStatus } from "../database/db.js";
import { QUALITY_STATUSES } from "../database/db.js";

export interface Provenance {
  source: string;
  marketplace: string;
  accountRef: string | null;
  pageKind: string;
  pageUrl: string;
  referenceDate: string;
  collectedAt: string;
  method: string;
  adapterVersion: string;
}

export interface ObservationInput {
  entityType: string;
  entityRef: string;
  metric: string;
  valueRaw: string | null;
  valueNum: number | null;
  unit: string | null;
  quality: QualityStatus;
}

export interface DataPointRow extends Provenance, ObservationInput {
  id: string;
  runId: string;
  createdAt: string;
}

const REQUIRED_PROVENANCE: (keyof Provenance)[] = [
  "source",
  "marketplace",
  "pageKind",
  "pageUrl",
  "referenceDate",
  "collectedAt",
  "method",
  "adapterVersion",
];

function assertProvenance(p: Provenance): void {
  for (const key of REQUIRED_PROVENANCE) {
    const value = p[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`PROVENANCE_INCOMPLETE: campo obrigatório ausente (${key})`);
    }
  }
  if (Number.isNaN(Date.parse(p.collectedAt))) {
    throw new Error("PROVENANCE_INCOMPLETE: collectedAt não é uma data válida");
  }
  if (Number.isNaN(Date.parse(p.referenceDate))) {
    throw new Error("PROVENANCE_INCOMPLETE: referenceDate não é uma data válida");
  }
}

function assertObservation(o: ObservationInput): void {
  if (!QUALITY_STATUSES.includes(o.quality)) {
    throw new Error(`QUALITY_INVALID: ${String(o.quality)}`);
  }
  // ZERO exige valor numérico zero explícito; UNKNOWN/NOT_COLLECTED não podem ter valor.
  if (o.quality === "ZERO" && o.valueNum !== 0) {
    throw new Error("QUALITY_INCONSISTENT: ZERO exige valueNum = 0");
  }
  if ((o.quality === "UNKNOWN" || o.quality === "NOT_COLLECTED" || o.quality === "UNAVAILABLE") &&
      (o.valueRaw !== null || o.valueNum !== null)) {
    throw new Error(`QUALITY_INCONSISTENT: ${o.quality} não pode carregar valor`);
  }
}

export class CollectionRepository {
  constructor(private readonly database: LocalDatabase) {}

  startRun(input: {
    marketplace: string;
    accountId: string | null;
    pageKind: string;
    pageUrl: string;
    startedAt: string;
  }): string {
    const id = crypto.randomUUID();
    this.database
      .raw()
      .prepare(
        `INSERT INTO collection_runs (id, marketplace, account_id, page_kind, page_url, started_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, 'RUNNING')`,
      )
      .run(id, input.marketplace, input.accountId, input.pageKind, input.pageUrl, input.startedAt);
    return id;
  }

  finishRun(runId: string, outcome: "COMPLETED" | "PARTIAL" | "FAILED", finishedAt: string, reason?: string): void {
    this.database
      .raw()
      .prepare("UPDATE collection_runs SET outcome = ?, finished_at = ?, failure_reason = ? WHERE id = ?")
      .run(outcome, finishedAt, reason ?? null, runId);
  }

  /** Grava uma observação. Falha alto e cedo se a proveniência estiver incompleta. */
  record(runId: string, provenance: Provenance, observation: ObservationInput): string {
    assertProvenance(provenance);
    assertObservation(observation);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.database
      .raw()
      .prepare(
        `INSERT INTO data_points (
           id, run_id, entity_type, entity_ref, metric, value_raw, value_num, unit, quality,
           source, marketplace, account_ref, page_kind, page_url, reference_date, collected_at,
           method, adapter_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        observation.entityType,
        observation.entityRef,
        observation.metric,
        observation.valueRaw,
        observation.valueNum,
        observation.unit,
        observation.quality,
        provenance.source,
        provenance.marketplace,
        provenance.accountRef,
        provenance.pageKind,
        provenance.pageUrl,
        provenance.referenceDate,
        provenance.collectedAt,
        provenance.method,
        provenance.adapterVersion,
        createdAt,
      );
    return id;
  }

  /** Histórico de uma métrica, mais recente primeiro. Nunca sobrescreve. */
  history(entityType: string, entityRef: string, metric: string, limit = 50): DataPointRow[] {
    const rows = this.database
      .raw()
      .prepare(
        `SELECT * FROM data_points
         WHERE entity_type = ? AND entity_ref = ? AND metric = ?
         ORDER BY collected_at DESC, created_at DESC
         LIMIT ?`,
      )
      .all(entityType, entityRef, metric, limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  countByRun(runId: string): number {
    const row = this.database
      .raw()
      .prepare("SELECT COUNT(*) AS c FROM data_points WHERE run_id = ?")
      .get(runId) as { c: number };
    return row.c;
  }
}

function mapRow(r: Record<string, unknown>): DataPointRow {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    entityType: String(r.entity_type),
    entityRef: String(r.entity_ref),
    metric: String(r.metric),
    valueRaw: r.value_raw === null ? null : String(r.value_raw),
    valueNum: r.value_num === null ? null : Number(r.value_num),
    unit: r.unit === null ? null : String(r.unit),
    quality: String(r.quality) as QualityStatus,
    source: String(r.source),
    marketplace: String(r.marketplace),
    accountRef: r.account_ref === null ? null : String(r.account_ref),
    pageKind: String(r.page_kind),
    pageUrl: String(r.page_url),
    referenceDate: String(r.reference_date),
    collectedAt: String(r.collected_at),
    method: String(r.method),
    adapterVersion: String(r.adapter_version),
    createdAt: String(r.created_at),
  };
}
