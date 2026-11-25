/**
 * Motor financeiro e Missões do Dia.
 *
 * Por que estes dois juntos: uma missão só é honesta se souber quanto dinheiro
 * está em jogo. Sem custo, comissão, frete e imposto, "aumente o preço" ou
 * "escale o Ads" é palpite. Aqui a conta vem primeiro, a priorização depois.
 *
 * Regras que o código impõe:
 *  - centavos inteiros e pontos-base para não perder precisão;
 *  - custo ausente NÃO vira zero: sem custo não há margem, só "dado ausente";
 *  - margem negativa nunca é "oportunidade" — é alerta crítico;
 *  - todo cálculo expõe a fórmula, para o painel poder mostrar de onde veio.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SkuCostInput {
  entityRef: string;
  marketplace?: string | null;
  costCents: number | null;
  packagingCents?: number | null;
  commissionBp?: number | null;
  taxBp?: number | null;
  fixedFeeCents?: number | null;
  freightCents?: number | null;
  minMarginBp?: number | null;
  effectiveFrom?: string;
}

export interface MarginBreakdown {
  entityRef: string;
  priceCents: number;
  costCents: number | null;
  packagingCents: number;
  commissionCents: number;
  taxCents: number;
  fixedFeeCents: number;
  freightCents: number;
  contributionCents: number | null;
  marginBp: number | null;
  minMarginBp: number;
  /** Faltando custo, não existe margem — só a certeza de que não se sabe. */
  status: "CALCULATED" | "NOT_COLLECTED";
  missing: string[];
  formula: string;
}

export interface PriceScenario {
  priceCents: number;
  contributionCents: number | null;
  marginBp: number | null;
  belowFloor: boolean;
}

export interface DailyMission {
  id: string;
  day: string;
  entityRef: string | null;
  marketplace: string | null;
  pillar: string;
  bottleneck: string;
  hypothesis: string;
  evidence: string;
  impactCents: number | null;
  impactPct: number | null;
  effort: number;
  urgency: number;
  risk: string;
  score: number;
  status: "OPEN" | "DONE" | "DISMISSED";
  createdAt: string;
}

const DEFAULT_MIN_MARGIN_BP = 1500; // 15%

export class FinanceService {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now?: () => Date) {
    this.db = db;
    this.now = now ?? (() => new Date());
  }

  saveCost(input: SkuCostInput): { entityRef: string; effectiveFrom: string } {
    const effectiveFrom = input.effectiveFrom ?? this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO sku_costs
           (id, entity_ref, marketplace, cost_cents, packaging_cents, commission_bp, tax_bp,
            fixed_fee_cents, freight_cents, min_margin_bp, effective_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.entityRef,
        input.marketplace ?? null,
        input.costCents,
        input.packagingCents ?? null,
        input.commissionBp ?? null,
        input.taxBp ?? null,
        input.fixedFeeCents ?? null,
        input.freightCents ?? null,
        input.minMarginBp ?? DEFAULT_MIN_MARGIN_BP,
        effectiveFrom,
        this.now().toISOString(),
      );
    return { entityRef: input.entityRef, effectiveFrom };
  }

  /** Custo vigente na data: o mais recente que já valia. Nunca "média". */
  currentCost(entityRef: string): SkuCostInput | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sku_costs WHERE entity_ref = ? AND effective_from <= ?
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(entityRef, this.now().toISOString()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      entityRef: String(row.entity_ref),
      marketplace: row.marketplace === null ? null : String(row.marketplace),
      costCents: row.cost_cents === null ? null : Number(row.cost_cents),
      packagingCents: row.packaging_cents === null ? null : Number(row.packaging_cents),
      commissionBp: row.commission_bp === null ? null : Number(row.commission_bp),
      taxBp: row.tax_bp === null ? null : Number(row.tax_bp),
      fixedFeeCents: row.fixed_fee_cents === null ? null : Number(row.fixed_fee_cents),
      freightCents: row.freight_cents === null ? null : Number(row.freight_cents),
      minMarginBp: row.min_margin_bp === null ? null : Number(row.min_margin_bp),
      effectiveFrom: String(row.effective_from),
    };
  }

  /**
   * Margem de contribuição: preço − (custo + embalagem + comissão + imposto +
   * taxa fixa + frete). É o que sobra antes do Ads, que é decisão separada.
   */
  margin(entityRef: string, priceCents: number): MarginBreakdown {
    const cost = this.currentCost(entityRef);
    const minMarginBp = cost?.minMarginBp ?? DEFAULT_MIN_MARGIN_BP;
    const packaging = cost?.packagingCents ?? 0;
    const commission = Math.round((priceCents * (cost?.commissionBp ?? 0)) / 10_000);
    const tax = Math.round((priceCents * (cost?.taxBp ?? 0)) / 10_000);
    const fixedFee = cost?.fixedFeeCents ?? 0;
    const freight = cost?.freightCents ?? 0;

    const missing: string[] = [];
    if (!cost || cost.costCents === null) missing.push("custo do produto");
    if (cost?.commissionBp === null || cost?.commissionBp === undefined) missing.push("comissão do marketplace");

    const contribution =
      cost?.costCents === null || cost?.costCents === undefined
        ? null
        : priceCents - (cost.costCents + packaging + commission + tax + fixedFee + freight);

    const marginBp = contribution === null || priceCents === 0 ? null : Math.round((contribution / priceCents) * 10_000);

    return {
      entityRef,
      priceCents,
      costCents: cost?.costCents ?? null,
      packagingCents: packaging,
      commissionCents: commission,
      taxCents: tax,
      fixedFeeCents: fixedFee,
      freightCents: freight,
      contributionCents: contribution,
      marginBp,
      minMarginBp,
      status: contribution === null ? "NOT_COLLECTED" : "CALCULATED",
      missing,
      formula: "contribuição = preço − (custo + embalagem + comissão + imposto + taxa fixa + frete)",
    };
  }

  /** Cenários de preço: mostra onde a margem mínima é respeitada. */
  scenarios(entityRef: string, priceCents: number, steps = [-10, -5, 0, 5, 10]): PriceScenario[] {
    return steps.map((pct) => {
      const p = Math.round(priceCents * (1 + pct / 100));
      const m = this.margin(entityRef, p);
      return {
        priceCents: p,
        contributionCents: m.contributionCents,
        marginBp: m.marginBp,
        belowFloor: m.marginBp !== null && m.marginBp < m.minMarginBp,
      };
    });
  }
}

// ------------------------------------------------------------------ missões

export interface MissionInput {
  entityRef: string | null;
  marketplace: string | null;
  pillar: string;
  bottleneck: string;
  hypothesis: string;
  evidence: string;
  impactCents: number | null;
  impactPct: number | null;
  effort: number;
  urgency: number;
  risk: string;
}

/**
 * Score = impacto normalizado × urgência ÷ esforço.
 *
 * Impacto em reais é convertido para uma escala 0–5 comparando com o maior
 * impacto do dia — assim uma loja pequena e uma grande usam o mesmo score sem
 * a pequena ficar sempre no fim da fila.
 */
export function scoreMission(m: MissionInput, maxImpactCents: number): number {
  const impactScale =
    m.impactCents !== null && maxImpactCents > 0 ? Math.min(5, (m.impactCents / maxImpactCents) * 5) : m.impactPct !== null ? Math.min(5, Math.abs(m.impactPct) / 10) : 1;
  const effort = Math.max(1, Math.min(5, m.effort));
  const urgency = Math.max(1, Math.min(5, m.urgency));
  return Number(((impactScale * urgency) / effort).toFixed(2));
}

export class MissionService {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now?: () => Date) {
    this.db = db;
    this.now = now ?? (() => new Date());
  }

  /** Regrava as missões do dia. Missão já concluída não é apagada. */
  replaceForToday(missions: MissionInput[]): DailyMission[] {
    const day = this.now().toISOString().slice(0, 10);
    const maxImpact = Math.max(0, ...missions.map((m) => m.impactCents ?? 0));
    this.db.prepare(`DELETE FROM daily_missions WHERE day = ? AND status = 'OPEN'`).run(day);
    const createdAt = this.now().toISOString();
    for (const m of missions) {
      this.db
        .prepare(
          `INSERT INTO daily_missions
             (id, day, entity_ref, marketplace, pillar, bottleneck, hypothesis, evidence,
              impact_cents, impact_pct, effort, urgency, risk, score, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
        )
        .run(
          randomUUID(),
          day,
          m.entityRef,
          m.marketplace,
          m.pillar,
          m.bottleneck,
          m.hypothesis,
          m.evidence,
          m.impactCents,
          m.impactPct,
          m.effort,
          m.urgency,
          m.risk,
          scoreMission(m, maxImpact),
          createdAt,
        );
    }
    return this.today();
  }

  today(): DailyMission[] {
    const day = this.now().toISOString().slice(0, 10);
    return this.forDay(day);
  }

  forDay(day: string): DailyMission[] {
    const rows = this.db
      .prepare(`SELECT * FROM daily_missions WHERE day = ? ORDER BY score DESC, urgency DESC`)
      .all(day) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      day: String(r.day),
      entityRef: r.entity_ref === null ? null : String(r.entity_ref),
      marketplace: r.marketplace === null ? null : String(r.marketplace),
      pillar: String(r.pillar),
      bottleneck: String(r.bottleneck),
      hypothesis: String(r.hypothesis),
      evidence: String(r.evidence),
      impactCents: r.impact_cents === null ? null : Number(r.impact_cents),
      impactPct: r.impact_pct === null ? null : Number(r.impact_pct),
      effort: Number(r.effort),
      urgency: Number(r.urgency),
      risk: String(r.risk),
      score: Number(r.score),
      status: String(r.status) as DailyMission["status"],
      createdAt: String(r.created_at),
    }));
  }

  decide(id: string, status: "DONE" | "DISMISSED"): boolean {
    const r = this.db.prepare(`UPDATE daily_missions SET status = ? WHERE id = ?`).run(status, id);
    return Number(r.changes) > 0;
  }
}
