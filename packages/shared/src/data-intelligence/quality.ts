/**
 * Data Intelligence — validação de integridade antes de alimentar KPIs e IA (§7).
 * Detecta ausência, duplicidade, inconsistência, anomalia, obsolescência e divergência entre fontes.
 */
import type { DataQualityIssue, Provenance } from '../types/data-quality';
import { mean, round } from '../math/safe';

export interface RawRecord {
  id: string;
  fields: Record<string, number | string | null | undefined>;
  provenance: Provenance;
}

const MAX_AGE_HOURS_DEFAULT = 48;

/** Detecta registros duplicados por chave composta. */
export function findDuplicates(records: RawRecord[], keyFields: string[]): DataQualityIssue[] {
  const seen = new Map<string, string[]>();
  for (const rec of records) {
    const key = keyFields.map((k) => String(rec.fields[k] ?? '')).join('|');
    if (!key.trim()) continue;
    const list = seen.get(key) ?? [];
    list.push(rec.id);
    seen.set(key, list);
  }
  const issues: DataQualityIssue[] = [];
  for (const [key, ids] of seen) {
    if (ids.length > 1) {
      issues.push({
        kind: 'DUPLICATE',
        severity: 'WARN',
        field: keyFields.join(','),
        message: `${ids.length} registros com a mesma chave (${key}): ${ids.join(', ')}`,
        context: { count: ids.length, key },
      });
    }
  }
  return issues;
}

/** Campos obrigatórios ausentes por registro. */
export function findMissing(records: RawRecord[], requiredFields: string[]): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  for (const rec of records) {
    for (const f of requiredFields) {
      const v = rec.fields[f];
      if (v === undefined || v === null || v === '') {
        issues.push({
          kind: 'MISSING',
          severity: 'WARN',
          field: `${rec.id}.${f}`,
          message: `campo obrigatório ausente (${f})`,
        });
      }
    }
  }
  return issues;
}

/** Valores negativos em métricas que não podem ser negativas. */
export function findNegatives(records: RawRecord[], nonNegativeFields: string[]): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  for (const rec of records) {
    for (const f of nonNegativeFields) {
      const v = rec.fields[f];
      if (typeof v === 'number' && v < 0) {
        issues.push({
          kind: 'NEGATIVE_VALUE',
          severity: 'CRITICAL',
          field: `${rec.id}.${f}`,
          message: `valor negativo em métrica não negativa: ${v}`,
          context: { value: v },
        });
      }
    }
  }
  return issues;
}

/**
 * Anomalia por z-score robusto (MAD). Só sinaliza quando a amostra é suficiente (>= 8).
 */
export function findOutliers(
  records: RawRecord[],
  field: string,
  threshold = 3.5,
): DataQualityIssue[] {
  const values = records
    .map((r) => ({ id: r.id, v: r.fields[field] }))
    .filter((x): x is { id: string; v: number } => typeof x.v === 'number' && Number.isFinite(x.v));
  if (values.length < 8) return [];
  const med = medianOf(values.map((v) => v.v));
  const deviations = values.map((v) => Math.abs(v.v - med));
  const mad = medianOf(deviations);
  if (mad === 0) return [];
  const issues: DataQualityIssue[] = [];
  for (const { id, v } of values) {
    const z = (0.6745 * (v - med)) / mad;
    if (Math.abs(z) > threshold) {
      issues.push({
        kind: 'OUTLIER',
        severity: 'WARN',
        field: `${id}.${field}`,
        message: `valor ${v} fora do padrão (z robusto ${round(z, 2)}, mediana ${round(med, 2)})`,
        context: { value: v, median: med, mad, z: round(z, 2) },
      });
    }
  }
  return issues;
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[m - 1] as number) + (s[m] as number)) / 2 : (s[m] as number);
}

/** Registros mais antigos que o limite configurado. */
export function findStale(
  records: RawRecord[],
  now: Date,
  maxAgeHours = MAX_AGE_HOURS_DEFAULT,
): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  for (const rec of records) {
    const t = Date.parse(rec.provenance.collectedAt);
    if (!Number.isFinite(t)) {
      issues.push({
        kind: 'SCHEMA_VIOLATION',
        severity: 'CRITICAL',
        field: `${rec.id}.collectedAt`,
        message: 'data de coleta inválida',
      });
      continue;
    }
    const ageHours = (now.getTime() - t) / 3_600_000;
    if (ageHours > maxAgeHours) {
      issues.push({
        kind: 'STALE',
        severity: 'INFO',
        field: `${rec.id}.collectedAt`,
        message: `dado com ${round(ageHours, 1)}h (limite ${maxAgeHours}h)`,
        context: { ageHours: round(ageHours, 1) },
      });
    }
  }
  return issues;
}

/**
 * Divergência entre duas fontes para a mesma chave (ex.: UI vs. exportação).
 * Tolerância relativa padrão de 2%.
 */
export function findCrossSourceDivergence(
  a: RawRecord[],
  b: RawRecord[],
  keyField: string,
  compareFields: string[],
  tolerancePct = 2,
): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const mapB = new Map(b.map((r) => [String(r.fields[keyField]), r]));
  for (const recA of a) {
    const key = String(recA.fields[keyField]);
    const recB = mapB.get(key);
    if (!recB) continue;
    for (const f of compareFields) {
      const va = recA.fields[f];
      const vb = recB.fields[f];
      if (typeof va !== 'number' || typeof vb !== 'number') continue;
      const base = Math.max(Math.abs(va), Math.abs(vb), 1);
      const diffPct = (Math.abs(va - vb) / base) * 100;
      if (diffPct > tolerancePct) {
        issues.push({
          kind: 'CROSS_SOURCE_DIVERGENCE',
          severity: diffPct > 10 ? 'CRITICAL' : 'WARN',
          field: `${key}.${f}`,
          message: `${f} diverge entre fontes: ${va} vs ${vb} (${round(diffPct, 1)}%)`,
          context: { a: va, b: vb, diffPct: round(diffPct, 1), sourceA: recA.provenance.sourceId, sourceB: recB.provenance.sourceId },
        });
      }
    }
  }
  return issues;
}

/** Sanidade de razões: CVR/CTR fora de [0, 100]% indica erro de captura. */
export function checkRatioSanity(
  value: number | null | undefined,
  field: string,
  bounds: { min: number; max: number } = { min: 0, max: 100 },
): DataQualityIssue | null {
  if (value === null || value === undefined) return null;
  if (value < bounds.min || value > bounds.max) {
    return {
      kind: 'RATIO_IMPLAUSIBLE',
      severity: 'CRITICAL',
      field,
      message: `razão fora dos limites plausíveis (${value} ∉ [${bounds.min}, ${bounds.max}])`,
      context: { value },
    };
  }
  return null;
}

export interface QualityReport {
  issues: DataQualityIssue[];
  counts: Record<string, number>;
  criticalCount: number;
  /** Score 0..1: 1 = sem problemas. Penaliza críticos mais que avisos. */
  score: number;
  /** Se false, a IA não deve emitir diagnóstico conclusivo. */
  aiAllowed: boolean;
}

export function buildQualityReport(issues: DataQualityIssue[], recordCount: number): QualityReport {
  const counts: Record<string, number> = {};
  let critical = 0;
  let warn = 0;
  for (const i of issues) {
    counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    if (i.severity === 'CRITICAL') critical += 1;
    if (i.severity === 'WARN') warn += 1;
  }
  const denom = Math.max(1, recordCount);
  const penalty = (critical * 3 + warn) / denom;
  const score = Math.max(0, Math.min(1, 1 - penalty / 3));
  return {
    issues,
    counts,
    criticalCount: critical,
    score: round(score, 3),
    aiAllowed: critical === 0 && score >= 0.5,
  };
}

/** Média de confiança ponderada por amostra, usada em relatórios de proveniência. */
export function averageConfidence(provenances: Provenance[]): number | null {
  const values = provenances.map((p) => p.confidence).filter((c) => Number.isFinite(c));
  const m = mean(values);
  return m === null ? null : round(m, 3);
}
