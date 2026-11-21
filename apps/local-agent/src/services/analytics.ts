/**
 * Serviços de negócio do Lord Marketplaces Analytics.
 *
 * Cada serviço é uma função pura sobre o banco (ou quase pura: o relógio e o
 * Gemini entram por parâmetro). Nada aqui fala WebSocket nem HTTP — isso é
 * responsabilidade do transporte, em main.ts. Separar assim é o que permite
 * testar a inteligência sem subir servidor.
 */
import type { LocalDatabase } from "../database/db.js";
import { CollectionRepository, type DataPointRow } from "../database/collection-repository.js";

// ------------------------------------------------------------------ métricas

export interface MetricSummary {
  metric: string;
  latest: number | null;
  latestQuality: string | null;
  latestAt: string | null;
  /** Série completa, mais recente primeiro. */
  series: { at: string; value: number | null; quality: string }[];
  /** Variação percentual entre a primeira e a última leitura numérica. */
  changePct: number | null;
  /** true quando há menos de 2 leituras numéricas — não há tendência. */
  insufficientHistory: boolean;
}

/** Calcula resumo de uma métrica SEM inventar tendência quando falta dado. */
export function summarizeSeries(rows: DataPointRow[]): MetricSummary | null {
  if (rows.length === 0) return null;
  const metric = rows[0].metric;
  const numeric = rows.filter((r) => r.valueNum !== null);
  const series = rows.map((r) => ({ at: r.collectedAt, value: r.valueNum, quality: r.quality }));
  const latest = numeric[0] ?? null;
  const oldest = numeric[numeric.length - 1] ?? null;

  let changePct: number | null = null;
  if (numeric.length >= 2 && oldest && latest && oldest.valueNum !== 0) {
    changePct = ((latest.valueNum! - oldest.valueNum!) / Math.abs(oldest.valueNum!)) * 100;
  }

  return {
    metric,
    latest: latest?.valueNum ?? null,
    latestQuality: latest?.quality ?? rows[0].quality,
    latestAt: latest?.collectedAt ?? rows[0].collectedAt,
    series,
    changePct,
    insufficientHistory: numeric.length < 2,
  };
}

// ------------------------------------------------------------------ listagem

export interface ListingOverview {
  entityRef: string;
  title: string | null;
  priceCents: number | null;
  stock: number | null;
  metrics: MetricSummary[];
}

export class AnalyticsService {
  constructor(private readonly db: LocalDatabase) {}

  /** Visão geral dos anúncios que já foram capturados ao menos uma vez. */
  listings(limit = 100): ListingOverview[] {
    const rows = this.db
      .raw()
      .prepare(
        `SELECT entity_ref, metric, COUNT(*) AS n FROM data_points
         WHERE entity_type = 'listing'
         GROUP BY entity_ref, metric`,
      )
      .all() as { entity_ref: string; metric: string; n: number }[];

    const byListing = new Map<string, string[]>();
    for (const r of rows) {
      const list = byListing.get(r.entity_ref) ?? [];
      list.push(r.metric);
      byListing.set(r.entity_ref, list);
    }

    const result: ListingOverview[] = [];
    for (const [entityRef, metrics] of byListing) {
      const summaries: MetricSummary[] = [];
      for (const metric of metrics) {
        const series = this.seriesFor("listing", entityRef, metric);
        const summary = summarizeSeries(series);
        if (summary) summaries.push(summary);
      }
      const title = series_of(summaries, "title")?.series[0]?.value ?? null;
      const titleRaw = this.db
        .raw()
        .prepare(
          `SELECT value_raw FROM data_points
           WHERE entity_type='listing' AND entity_ref=? AND metric='title'
           ORDER BY collected_at DESC LIMIT 1`,
        )
        .get(entityRef) as { value_raw: string | null } | undefined;

      result.push({
        entityRef,
        title: titleRaw?.value_raw ?? (title === null ? null : String(title)),
        priceCents: series_of(summaries, "price_cents")?.latest ?? null,
        stock: series_of(summaries, "stock")?.latest ?? null,
        metrics: summaries,
      });
      if (result.length >= limit) break;
    }
    return result;
  }

  seriesFor(entityType: string, entityRef: string, metric: string, limit = 200): DataPointRow[] {
    const repo = new CollectionRepository(this.db);
    return repo.history(entityType, entityRef, metric, limit);
  }

  /** Contagem por status de qualidade — o "quanto disso é confiável". */
  qualityCensus(): Record<string, number> {
    const rows = this.db
      .raw()
      .prepare("SELECT quality, COUNT(*) AS n FROM data_points GROUP BY quality")
      .all() as { quality: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.quality, r.n]));
  }

  /** Execuções recentes, para a tela de proveniência. */
  recentRuns(limit = 20) {
    return this.db
      .raw()
      .prepare(
        `SELECT id, marketplace, page_kind, page_url, started_at, finished_at, outcome, failure_reason
         FROM collection_runs ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit);
  }
}

function series_of(list: MetricSummary[], metric: string): MetricSummary | undefined {
  return list.find((m) => m.metric === metric);
}

// ------------------------------------------------------------------ alertas

export interface Alert {
  id: string;
  severity: "info" | "attention" | "critical";
  title: string;
  detail: string;
  /** De onde veio a conclusão: sempre rastreável. */
  evidence: string;
  entityRef: string | null;
}

/**
 * Motor de alertas: regras determinísticas sobre dados já capturados.
 * Não chama IA — o que é regra não precisa de modelo, e regra é auditável.
 */
export function computeAlerts(listings: ListingOverview[]): Alert[] {
  const alerts: Alert[] = [];
  for (const listing of listings) {
    if (listing.stock === null) {
      alerts.push({
        id: `stock-unknown-${listing.entityRef}`,
        severity: "attention",
        title: "Estoque não legível",
        detail: `O anúncio ${listing.entityRef} foi capturado sem estoque legível. Isso não significa estoque zero.`,
        evidence: "métrica stock com status NOT_COLLECTED ou UNKNOWN",
        entityRef: listing.entityRef,
      });
    } else if (listing.stock === 0) {
      alerts.push({
        id: `stock-zero-${listing.entityRef}`,
        severity: "critical",
        title: "Estoque zerado",
        detail: `O anúncio ${listing.entityRef} está com estoque zero na última leitura.`,
        evidence: "métrica stock VERIFIED com valor 0",
        entityRef: listing.entityRef,
      });
    } else if (listing.stock > 0 && listing.stock <= 3) {
      alerts.push({
        id: `stock-low-${listing.entityRef}`,
        severity: "attention",
        title: "Estoque baixo",
        detail: `Restam ${listing.stock} unidades do anúncio ${listing.entityRef}.`,
        evidence: "métrica stock VERIFIED com valor <= 3",
        entityRef: listing.entityRef,
      });
    }

    const price = series_of(listing.metrics, "price_cents");
    if (price && !price.insufficientHistory && price.changePct !== null && Math.abs(price.changePct) >= 10) {
      alerts.push({
        id: `price-change-${listing.entityRef}`,
        severity: price.changePct < 0 ? "attention" : "info",
        title: price.changePct < 0 ? "Preço caiu" : "Preço subiu",
        detail: `Variação de ${price.changePct.toFixed(1)}% no anúncio ${listing.entityRef}.`,
        evidence: `comparação entre ${price.series.length} leituras de price_cents`,
        entityRef: listing.entityRef,
      });
    }
  }
  return alerts;
}

// ------------------------------------------------------- auditoria encadeada

export interface AuditEntry {
  seq: number;
  at: string;
  kind: string;
  detail: string;
  hash: string;
}

/**
 * Trilha de auditoria com encadeamento de hash: cada entrada carrega o hash da
 * anterior. Alterar uma linha antiga quebra toda a cadeia a partir dela, o que
 * torna a adulteração detectável.
 */
export class AuditService {
  constructor(private readonly db: LocalDatabase) {}

  append(kind: string, detail: Record<string, unknown>, now: Date = new Date()): AuditEntry {
    const prev = this.db
      .raw()
      .prepare("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1")
      .get() as { hash: string } | undefined;
    const prevHash = prev?.hash ?? "GENESIS";
    const at = now.toISOString();
    const body = JSON.stringify({ kind, detail });
    const hash = hashOf(prevHash + at + body);
    this.db
      .raw()
      .prepare("INSERT INTO audit_log (at, kind, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?)")
      .run(at, kind, body, prevHash, hash);
    return { seq: 0, at, kind, detail: body, hash };
  }

  /** Verifica a cadeia inteira. Devolve a primeira entrada quebrada, se houver. */
  verify(): { ok: boolean; brokenAtSeq: number | null; total: number } {
    const rows = this.db
      .raw()
      .prepare("SELECT seq, at, kind, detail, prev_hash, hash FROM audit_log ORDER BY seq ASC")
      .all() as { seq: number; at: string; kind: string; detail: string; prev_hash: string; hash: string }[];
    let prevHash = "GENESIS";
    for (const row of rows) {
      const expected = hashOf(prevHash + row.at + row.detail);
      if (row.prev_hash !== prevHash || row.hash !== expected) {
        return { ok: false, brokenAtSeq: row.seq, total: rows.length };
      }
      prevHash = row.hash;
    }
    return { ok: true, brokenAtSeq: null, total: rows.length };
  }
}

/** FNV-1a de 128 bits aproximado por dois hashes de 64 bits — sem dependência. */
function hashOf(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
