/** Divisão e aritmética seguras: divisão por zero nunca vira Infinity/NaN silencioso. */

export interface SafeRatio {
  value: number | null;
  reason?: string;
}

export function ratio(numerator: number | undefined | null, denominator: number | undefined | null): SafeRatio {
  if (numerator === undefined || numerator === null) return { value: null, reason: 'numerador ausente' };
  if (denominator === undefined || denominator === null) return { value: null, reason: 'denominador ausente' };
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return { value: null, reason: 'valor não finito' };
  if (denominator === 0) return { value: null, reason: 'divisão por zero' };
  return { value: numerator / denominator };
}

export function percent(numerator: number | undefined | null, denominator: number | undefined | null): SafeRatio {
  const r = ratio(numerator, denominator);
  return r.value === null ? r : { value: r.value * 100 };
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function safeDiv(a: number, b: number, fallback = 0): number {
  return b === 0 || !Number.isFinite(b) ? fallback : a / b;
}

export function mean(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

export function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 0 ? ((clean[mid - 1] as number) + (clean[mid] as number)) / 2 : (clean[mid] as number);
}

/** Quartis por interpolação linear (método R-7), devolvidos com min/max. */
export function quantiles(values: number[]): {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  n: number;
} | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const at = (p: number): number => {
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const a = v[lo] as number;
    const b = v[hi] as number;
    return a + (b - a) * (idx - lo);
  };
  return { min: v[0] as number, q1: at(0.25), median: at(0.5), q3: at(0.75), max: v[v.length - 1] as number, n: v.length };
}

/** Herfindahl-Hirschman Index (0..1) — concentração de vendedores em categoria (§21.1). */
export function hhi(shares: number[]): number | null {
  const clean = shares.filter((s) => Number.isFinite(s) && s >= 0);
  const total = clean.reduce((a, b) => a + b, 0);
  if (clean.length === 0 || total === 0) return null;
  return clean.reduce((acc, s) => acc + (s / total) ** 2, 0);
}
