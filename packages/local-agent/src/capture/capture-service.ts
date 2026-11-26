/**
 * Serviço de captura: transforma dados lidos na UI autenticada em registros com proveniência,
 * aplica validação de integridade (§7) e grava snapshots datados (§8).
 */
import { randomUUID } from 'node:crypto';
import {
  buildQualityReport,
  computeListingKpis,
  type DataQualityIssue,
  type ListingPeriodInput,
  type Provenance,
  captureIngestSchema,
} from '@mi/shared';
import type { LocalDatabase } from '../db/database';

export interface IngestResult {
  ok: boolean;
  listingsIngested: number;
  quality: ReturnType<typeof buildQualityReport>;
  errors: string[];
}

export class CaptureService {
  constructor(private readonly db: LocalDatabase) {}

  /** Valida o payload do content script (schema + tamanho) e grava snapshots. */
  ingest(raw: unknown): IngestResult {
    const parsed = captureIngestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        listingsIngested: 0,
        quality: buildQualityReport([], 0),
        errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }
    const data = parsed.data;
    const issues: DataQualityIssue[] = [];
    let written = 0;

    this.db.transaction(() => {
      // Conta precisa existir (isolamento por conta, §6).
      const account = this.db.db.prepare('SELECT id FROM accounts WHERE id = ?').get(data.accountId);
      if (!account) {
        issues.push({
          kind: 'REFERENTIAL_BREAK',
          severity: 'CRITICAL',
          field: 'accountId',
          message: `conta ${data.accountId} não cadastrada; captura rejeitada`,
        });
        return;
      }

      // A fonte precisa existir antes da execução (FK). Declarada com sua classe real.
      this.db.db
        .prepare(
          `INSERT INTO data_sources (id, label, source_class, kind, enabled, notes)
           VALUES (?, ?, ?, 'BROWSER_UI', 1, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          `ui:${data.marketplace}`,
          `UI autenticada — ${data.marketplace}`,
          data.sourceClass,
          'leitura de DOM na sessão autenticada do usuário',
        );

      const runId = randomUUID();
      this.db.db
        .prepare(
          `INSERT INTO data_source_runs (id, data_source_id, account_id, started_at, finished_at, status, records_read, records_written, method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          `ui:${data.marketplace}`,
          data.accountId,
          data.collectedAt,
          new Date().toISOString(),
          'OK',
          data.listings.length,
          0,
          data.method,
        );

      for (const listing of data.listings) {
        const listingRow = this.db.db
          .prepare('SELECT id FROM listings WHERE account_id = ? AND external_id = ?')
          .get(data.accountId, listing.listingId) as { id: string } | undefined;

        let listingId = listingRow?.id;
        if (!listingId) {
          listingId = randomUUID();
          this.db.db
            .prepare(
              `INSERT INTO listings (id, account_id, marketplace, external_id, title, status, url, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
            )
            .run(
              listingId,
              data.accountId,
              data.marketplace,
              listing.listingId,
              listing.title ?? null,
              data.url,
              new Date().toISOString(),
              new Date().toISOString(),
            );
        }

        // Snapshot é imutável: histórico nunca é sobrescrito (§8).
        const snapshotId = randomUUID();
        const metrics = {
          visits: listing.visits,
          orders: listing.orders,
          units: listing.units,
          gmv: listing.gmv,
          organicImpressions: listing.organicImpressions,
          paidImpressions: listing.paidImpressions,
          adSpend: listing.adSpend,
          adClicks: listing.adClicks,
          adAttributedRevenue: listing.adAttributedRevenue,
          returnsCount: listing.returnsCount,
          returnsValue: listing.returnsValue,
          stockAvailable: listing.stockAvailable,
          questionsPending: listing.questionsPending,
          reviewRating: listing.reviewRating,
          reviewCount: listing.reviewCount,
        };
        this.db.db
          .prepare(
            `INSERT OR IGNORE INTO listing_snapshots (id, listing_id, account_id, captured_at, reference_at, metrics_json, source_class, quality_score)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshotId,
            listingId,
            data.accountId,
            data.collectedAt,
            data.referenceAt,
            JSON.stringify(metrics),
            data.sourceClass,
            null,
          );

        const provenance: Provenance = {
          sourceClass: data.sourceClass,
          sourceId: `ui:${data.marketplace}`,
          marketplace: data.marketplace,
          accountId: data.accountId,
          pageUrl: data.url,
          referenceAt: data.referenceAt,
          collectedAt: data.collectedAt,
          method: data.method,
          confidence: data.sourceClass === 'A_PRIMARY_UI' ? 0.95 : 0.9,
        };
        for (const [field, value] of Object.entries(metrics)) {
          if (value === undefined) continue;
          this.db.db
            .prepare(
              `INSERT OR IGNORE INTO data_provenance (entity, entity_id, field, account_id, listing_id, source_class, source_id, page_url, reference_at, collected_at, method, confidence, run_id)
               VALUES ('listing_snapshot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              snapshotId,
              field,
              data.accountId,
              listingId,
              provenance.sourceClass,
              provenance.sourceId,
              provenance.pageUrl ?? null,
              provenance.referenceAt,
              provenance.collectedAt,
              provenance.method,
              provenance.confidence,
              runId,
            );
        }
        written += 1;
      }

      this.db.db
        .prepare('UPDATE data_source_runs SET records_written = ? WHERE id = ?')
        .run(written, runId);
    });

    for (const issue of issues) {
      this.db.db
        .prepare(
          'INSERT INTO data_quality_issues (detected_at, account_id, kind, severity, field, message) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(new Date().toISOString(), data.accountId, issue.kind, issue.severity, issue.field, issue.message);
    }

    const quality = buildQualityReport(issues, data.listings.length);
    return { ok: quality.criticalCount === 0, listingsIngested: written, quality, errors: issues.map((i) => i.message) };
  }

  /** KPIs calculados a partir do snapshot mais recente do anúncio. */
  kpisForListing(listingId: string, periodDays = 30): ReturnType<typeof computeListingKpis> | null {
    const row = this.db.db
      .prepare('SELECT * FROM listing_snapshots WHERE listing_id = ? ORDER BY captured_at DESC LIMIT 1')
      .get(listingId) as
      | { captured_at: string; reference_at: string; metrics_json: string; account_id: string }
      | undefined;
    if (!row) return null;
    const metrics = JSON.parse(row.metrics_json) as Record<string, number | undefined>;
    const listing = this.db.db
      .prepare('SELECT marketplace, sku_id FROM listings WHERE id = ?')
      .get(listingId) as { marketplace: string; sku_id: string | null } | undefined;

    const end = new Date(row.reference_at);
    const start = new Date(end.getTime() - periodDays * 86_400_000);
    const input: ListingPeriodInput = {
      listingId,
      sku: listing?.sku_id ?? undefined,
      marketplace: listing?.marketplace ?? 'unknown',
      accountId: row.account_id,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      daysInPeriod: periodDays,
      visits: metrics.visits,
      orders: metrics.orders,
      units: metrics.units,
      gmv: metrics.gmv,
      grossRevenue: metrics.gmv,
      organicImpressions: metrics.organicImpressions,
      paidImpressions: metrics.paidImpressions,
      adSpend: metrics.adSpend,
      adClicks: metrics.adClicks,
      adAttributedRevenue: metrics.adAttributedRevenue,
      returnsCount: metrics.returnsCount,
      returnsValue: metrics.returnsValue,
      stockAvailable: metrics.stockAvailable,
      questionsReceived: metrics.questionsPending,
      reviewCount: metrics.reviewCount,
      reviewRating: metrics.reviewRating,
    };
    return computeListingKpis(input);
  }

  /** Comparação Hoje / Ontem / 7d / 30d / 90d (§8). */
  trend(listingId: string): Array<{ window: string; visits: number | null; orders: number | null; gmv: number | null; capturedAt: string }> {
    const rows = this.db.rows<{ captured_at: string; metrics_json: string }>(
      'SELECT captured_at, metrics_json FROM listing_snapshots WHERE listing_id = ? ORDER BY captured_at ASC',
      listingId,
    );
    const windows = [1, 2, 7, 30, 90];
    const latest = rows[rows.length - 1];
    if (!latest) return [];
    const latestDate = new Date(latest.captured_at).getTime();
    return windows.map((d) => {
      const target = latestDate - d * 86_400_000;
      let best = rows[0];
      let bestDiff = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        const diff = Math.abs(new Date(r.captured_at).getTime() - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = r;
        }
      }
      const m = JSON.parse(best!.metrics_json) as Record<string, number | undefined>;
      return {
        window: `${d}d`,
        visits: m.visits ?? null,
        orders: m.orders ?? null,
        gmv: m.gmv ?? null,
        capturedAt: best!.captured_at,
      };
    });
  }
}
