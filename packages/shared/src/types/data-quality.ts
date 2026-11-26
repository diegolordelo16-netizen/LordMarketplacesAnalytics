/**
 * Data Intelligence — classificação de origem, estado do dado e confiabilidade.
 * Regra inegociável (§0.1.1, §7): nunca converter fonte de menor confiabilidade em dado confirmado.
 */

/** Hierarquia de fontes (ordem de confiabilidade decrescente para métricas da própria conta). */
export const DATA_SOURCE_CLASSES = [
  'A_PRIMARY_UI',
  'B_PLATFORM_EXPORT',
  'C_AUTHORIZED_CONNECTOR',
  'D_PUBLIC_OBSERVATION',
  'E_MODELLED_ESTIMATE',
  'F_USER_INPUT',
  'G_UNAVAILABLE',
] as const;
export type DataSourceClass = (typeof DATA_SOURCE_CLASSES)[number];

/** Peso de confiabilidade por classe (0..1). Usado no índice de confiabilidade e nos gates de IA. */
export const SOURCE_CLASS_TRUST: Record<DataSourceClass, number> = {
  A_PRIMARY_UI: 1.0,
  B_PLATFORM_EXPORT: 0.95,
  C_AUTHORIZED_CONNECTOR: 0.9,
  D_PUBLIC_OBSERVATION: 0.6,
  E_MODELLED_ESTIMATE: 0.35,
  F_USER_INPUT: 0.5,
  G_UNAVAILABLE: 0,
};

/** Estado semântico do valor. `ZERO` é diferente de `UNKNOWN` — nunca os colapsar. */
export const DATA_STATES = [
  'ZERO',
  'UNKNOWN',
  'NOT_COLLECTED',
  'UNAVAILABLE',
  'ESTIMATED',
  'CALCULATED',
  'VERIFIED',
] as const;
export type DataState = (typeof DATA_STATES)[number];

/** Estados que jamais podem ser somados/exibidos como número real. */
export const NON_NUMERIC_STATES: ReadonlySet<DataState> = new Set<DataState>([
  'UNKNOWN',
  'NOT_COLLECTED',
  'UNAVAILABLE',
]);

/** Estados em que o valor numérico existe mas não é medição direta. */
export const NON_MEASURED_STATES: ReadonlySet<DataState> = new Set<DataState>([
  'ESTIMATED',
  'CALCULATED',
]);

export type DataQualitySeverity = 'INFO' | 'WARN' | 'CRITICAL';

export const DATA_QUALITY_ISSUE_KINDS = [
  'MISSING',
  'DUPLICATE',
  'INCONSISTENT',
  'OUTLIER',
  'STALE',
  'CROSS_SOURCE_DIVERGENCE',
  'SCHEMA_VIOLATION',
  'NEGATIVE_VALUE',
  'RATIO_IMPLAUSIBLE',
  'REFERENTIAL_BREAK',
] as const;
export type DataQualityIssueKind = (typeof DATA_QUALITY_ISSUE_KINDS)[number];

export interface DataQualityIssue {
  kind: DataQualityIssueKind;
  severity: DataQualitySeverity;
  /** Caminho do campo (ex.: `listing.ml-1.visits`) para localizar a evidência. */
  field: string;
  message: string;
  /** Contexto numérico quando aplicável (valor observado, esperado, desvio). */
  context?: Record<string, number | string | null>;
}

/** Um valor medido carrega sempre sua proveniência (§7). */
export interface Provenance {
  sourceClass: DataSourceClass;
  /** Identificador da fonte: `mercado_livre`, `shopee`, `csv:relatorio-vendas.xlsx`, `gemini`, etc. */
  sourceId: string;
  marketplace?: string;
  accountId?: string;
  pageUrl?: string;
  /** Data de referência do dado (ISO-8601, UTC). */
  referenceAt: string;
  /** Data/hora em que o dado foi coletado (ISO-8601, UTC). */
  collectedAt: string;
  method: string;
  /** Confiança 0..1, derivada da classe e da qualidade observada. */
  confidence: number;
  sampleSize?: number;
  notes?: string;
}

export type MetricValue =
  | { state: 'ZERO'; value: 0; provenance: Provenance }
  | { state: 'VERIFIED'; value: number; provenance: Provenance }
  | { state: 'ESTIMATED'; value: number; provenance: Provenance; interval?: { low: number; high: number } }
  | { state: 'CALCULATED'; value: number; provenance: Provenance }
  | { state: 'UNKNOWN' | 'NOT_COLLECTED' | 'UNAVAILABLE'; value: null; provenance: Provenance };

export function isNumericMetric(m: MetricValue): m is Extract<MetricValue, { value: number }> {
  return typeof m.value === 'number';
}

/** `ZERO` é confirmado; `UNKNOWN` não é zero. */
export function isConfirmedZero(m: MetricValue): boolean {
  return m.state === 'ZERO';
}

/**
 * Confiança efetiva de uma métrica considerando a classe de origem, o estado e a amostra.
 * Estimativas nunca passam de 0.6; indisponíveis são 0.
 */
export function effectiveConfidence(m: MetricValue): number {
  if (m.state === 'UNAVAILABLE' || m.state === 'UNKNOWN' || m.state === 'NOT_COLLECTED') return 0;
  const base = SOURCE_CLASS_TRUST[m.provenance.sourceClass] * clamp01(m.provenance.confidence);
  const sampleFactor =
    typeof m.provenance.sampleSize === 'number' ? Math.min(1, Math.sqrt(Math.max(0, m.provenance.sampleSize) / 30)) : 1;
  let conf = base * sampleFactor;
  if (m.state === 'ESTIMATED') conf = Math.min(conf, 0.6);
  if (m.state === 'ZERO') conf = Math.min(conf, 0.95);
  return round(conf, 4);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Gate de qualidade para diagnósticos de IA (§7): a IA não emite diagnóstico conclusivo
 * quando a qualidade dos dados é insuficiente.
 */
export const AI_QUALITY_GATE = {
  /** Confiança mínima de cada métrica obrigatória. */
  minMetricConfidence: 0.7,
  /** Fração mínima de métricas obrigatórias presentes e numéricas. */
  minCoverage: 0.8,
  /** Estimativas sozinhas nunca sustentam diagnóstico crítico financeiro. */
  allowEstimateOnlyForCritical: false,
} as const;

export interface QualityGateResult {
  ok: boolean;
  coverage: number;
  reasons: string[];
  missing: string[];
  weak: string[];
}

export function evaluateQualityGate(
  metrics: Record<string, MetricValue | undefined>,
  required: string[],
  opts: Partial<typeof AI_QUALITY_GATE> = {},
): QualityGateResult {
  const cfg = { ...AI_QUALITY_GATE, ...opts };
  const missing: string[] = [];
  const weak: string[] = [];
  let present = 0;
  for (const key of required) {
    const m = metrics[key];
    if (!m || !isNumericMetric(m)) {
      missing.push(key);
      continue;
    }
    present += 1;
    const conf = effectiveConfidence(m);
    if (conf < cfg.minMetricConfidence) weak.push(key);
    if (!cfg.allowEstimateOnlyForCritical && m.state === 'ESTIMATED' && conf < cfg.minMetricConfidence) {
      weak.push(key);
    }
  }
  const coverage = required.length === 0 ? 1 : present / required.length;
  const reasons: string[] = [];
  if (coverage < cfg.minCoverage) reasons.push(`cobertura ${(coverage * 100).toFixed(0)}% < ${(cfg.minCoverage * 100).toFixed(0)}%`);
  if (weak.length > 0) reasons.push(`métricas com confiança insuficiente: ${weak.join(', ')}`);
  return { ok: reasons.length === 0, coverage, reasons, missing, weak };
}
