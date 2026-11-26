/**
 * Ranking de prioridade: Impacto × Esforço × Urgência (§11).
 * Score é explicável: cada componente e seu peso aparecem no resultado.
 */
import type { GrowthPillar } from '../types/kpi';
import type { Cents } from '../math/money';
import { round } from '../math/safe';

export const MISSION_CLASSES = ['CRITICAL_ALERT', 'QUICK_WIN', 'ZOMBIE', 'NORMAL'] as const;
export type MissionClass = (typeof MISSION_CLASSES)[number];

export const MISSION_CLASS_LABEL: Record<MissionClass, string> = {
  CRITICAL_ALERT: 'Alerta Crítico',
  QUICK_WIN: 'Oportunidade Quente (Quick Win)',
  ZOMBIE: 'Estagnado/Zumbi',
  NORMAL: 'Normal',
};

export interface PriorityWeights {
  impact: number;
  effort: number;
  urgency: number;
}

export const DEFAULT_WEIGHTS: PriorityWeights = { impact: 0.55, effort: 0.25, urgency: 0.2 };

export interface PriorityInput {
  listingId: string;
  sku?: string;
  marketplace: string;
  accountId: string;
  pillar: GrowthPillar;
  /** Impacto financeiro potencial estimado (centavos) na janela avaliada. */
  potentialImpactCents: Cents;
  /** Esforço em horas estimadas (1..40). */
  effortHours: number;
  /** Urgência 0..1 (1 = hoje). */
  urgency: number;
  /** Sinais objetivos que classificam o item. */
  signals: {
    stockCoverageDays?: number | null;
    contributionMarginPct?: number | null;
    cvr?: number | null;
    cvrBenchmark?: number | null;
    visits?: number | null;
    adSpendCents?: number | null;
    adRevenueCents?: number | null;
    returnRatePct?: number | null;
    returnRateBaselinePct?: number | null;
    revenueDropPct?: number | null;
    competitorPriceGapPct?: number | null;
  };
  /** Confiança 0..1 dos dados que sustentam o impacto. */
  confidence: number;
}

export interface PriorityResult {
  listingId: string;
  sku?: string;
  marketplace: string;
  accountId: string;
  pillar: GrowthPillar;
  missionClass: MissionClass;
  score: number;
  components: { impact: number; effort: number; urgency: number; confidenceFactor: number };
  evidence: string[];
  reasons: string[];
  blocked?: string;
}

/** Normaliza impacto em escala logarítmica: R$ 1 → ~0.3; R$ 100 → ~0.5; R$ 10.000 → ~0.8. */
export function normalizeImpact(cents: Cents): number {
  const reais = Math.max(0, cents) / 100;
  if (reais <= 0) return 0;
  const norm = Math.log10(reais + 1) / 4.2; // 10^4.2 ≈ R$ 15.8k → ~1
  return Math.min(1, Math.max(0, norm));
}

/** Esforço invertido: 1h → ~0.95; 8h → ~0.55; 40h → ~0.1. */
export function normalizeEffort(hours: number): number {
  const h = Math.max(0.25, hours);
  return Math.min(1, Math.max(0, 1 / (1 + Math.log2(h))));
}

export function classifyMission(signals: PriorityInput['signals']): MissionClass {
  const {
    stockCoverageDays,
    contributionMarginPct,
    adSpendCents,
    adRevenueCents,
    cvr,
    cvrBenchmark,
    visits,
    returnRatePct,
    returnRateBaselinePct,
    revenueDropPct,
  } = signals;

  if (stockCoverageDays !== null && stockCoverageDays !== undefined && stockCoverageDays < 3) return 'CRITICAL_ALERT';
  if (contributionMarginPct !== null && contributionMarginPct !== undefined && contributionMarginPct < 0) return 'CRITICAL_ALERT';
  if (
    adSpendCents !== null &&
    adSpendCents !== undefined &&
    adSpendCents > 0 &&
    adRevenueCents !== null &&
    adRevenueCents !== undefined &&
    adRevenueCents < adSpendCents
  )
    return 'CRITICAL_ALERT';
  if (revenueDropPct !== null && revenueDropPct !== undefined && revenueDropPct <= -30) return 'CRITICAL_ALERT';
  if (
    returnRatePct !== null &&
    returnRatePct !== undefined &&
    returnRateBaselinePct !== null &&
    returnRateBaselinePct !== undefined &&
    returnRateBaselinePct > 0 &&
    returnRatePct > returnRateBaselinePct * 1.5
  )
    return 'CRITICAL_ALERT';

  if (
    cvr !== null &&
    cvr !== undefined &&
    cvrBenchmark !== null &&
    cvrBenchmark !== undefined &&
    cvr > cvrBenchmark * 1.2 &&
    (visits ?? 0) < 200
  )
    return 'QUICK_WIN';
  if (
    visits !== null &&
    visits !== undefined &&
    visits > 500 &&
    cvr !== null &&
    cvr !== undefined &&
    cvrBenchmark !== null &&
    cvrBenchmark !== undefined &&
    cvr < cvrBenchmark * 0.7
  )
    return 'QUICK_WIN';
  // CVR é armazenada em PERCENTUAL (§9): 0,5% = 0.5.
  if (visits !== null && visits !== undefined && visits > 100 && cvr !== null && cvr !== undefined && cvr < 0.5)
    return 'ZOMBIE';
  if (adSpendCents !== null && adSpendCents !== undefined && adSpendCents > 0 && (adRevenueCents ?? 0) === 0)
    return 'ZOMBIE';
  return 'NORMAL';
}

export function computePriority(input: PriorityInput, weights: PriorityWeights = DEFAULT_WEIGHTS): PriorityResult {
  const impact = normalizeImpact(input.potentialImpactCents);
  const effort = normalizeEffort(input.effortHours);
  const urgency = Math.min(1, Math.max(0, input.urgency));
  const confidenceFactor = Math.min(1, Math.max(0, input.confidence));

  const raw = impact * weights.impact + effort * weights.effort + urgency * weights.urgency;
  const score = round(raw * confidenceFactor * 100, 1);

  const missionClass = classifyMission(input.signals);
  const evidence: string[] = [];
  const s = input.signals;
  if (s.stockCoverageDays !== undefined && s.stockCoverageDays !== null)
    evidence.push(`cobertura de estoque: ${round(s.stockCoverageDays, 1)} dias`);
  if (s.contributionMarginPct !== undefined && s.contributionMarginPct !== null)
    evidence.push(`margem de contribuição: ${round(s.contributionMarginPct, 1)}%`);
  if (s.cvr !== undefined && s.cvr !== null) evidence.push(`CVR: ${round(s.cvr, 2)}%`);
  if (s.visits !== undefined && s.visits !== null) evidence.push(`visitas: ${s.visits}`);
  if (s.adSpendCents !== undefined && s.adSpendCents !== null)
    evidence.push(`gasto Ads: ${(s.adSpendCents / 100).toFixed(2)}`);
  if (s.adRevenueCents !== undefined && s.adRevenueCents !== null)
    evidence.push(`receita Ads: ${(s.adRevenueCents / 100).toFixed(2)}`);
  if (s.returnRatePct !== undefined && s.returnRatePct !== null) evidence.push(`taxa de devolução: ${round(s.returnRatePct, 2)}%`);
  if (s.revenueDropPct !== undefined && s.revenueDropPct !== null) evidence.push(`variação de receita: ${round(s.revenueDropPct, 1)}%`);

  const reasons = [
    `impacto normalizado ${round(impact, 3)} × peso ${weights.impact}`,
    `esforço normalizado ${round(effort, 3)} × peso ${weights.effort}`,
    `urgência ${round(urgency, 2)} × peso ${weights.urgency}`,
    `fator de confiança ${round(confidenceFactor, 2)}`,
  ];

  const result: PriorityResult = {
    listingId: input.listingId,
    sku: input.sku,
    marketplace: input.marketplace,
    accountId: input.accountId,
    pillar: input.pillar,
    missionClass,
    score,
    components: { impact, effort, urgency, confidenceFactor },
    evidence,
    reasons,
  };

  if (confidenceFactor < 0.5) {
    result.blocked = 'dados com confiança insuficiente para ação automática; requer coleta/validação';
  }
  return result;
}

/** Ordena por score decrescente e prioriza alertas críticos em caso de empate. */
export function rankPriorities(results: PriorityResult[]): PriorityResult[] {
  const order: Record<MissionClass, number> = { CRITICAL_ALERT: 0, QUICK_WIN: 1, NORMAL: 2, ZOMBIE: 3 };
  return [...results].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return order[a.missionClass] - order[b.missionClass];
  });
}

/** Missões do dia: 3 a 5 ações prioritárias (§11). */
export function buildDailyMissions(results: PriorityResult[], min = 3, max = 5): PriorityResult[] {
  const ranked = rankPriorities(results).filter((r) => r.score > 0);
  const critical = ranked.filter((r) => r.missionClass === 'CRITICAL_ALERT');
  const rest = ranked.filter((r) => r.missionClass !== 'CRITICAL_ALERT');
  const picked = [...critical, ...rest].slice(0, max);
  return picked.length >= min ? picked : picked;
}
