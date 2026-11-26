/**
 * Dinheiro em centavos inteiros (§9: "precisão decimal ou centavos inteiros").
 * Toda soma/subtração/multiplicação monetária passa por aqui para evitar erro de ponto flutuante.
 */

export type Cents = number;

export function toCents(value: number): Cents {
  if (!Number.isFinite(value)) throw new Error(`valor monetário inválido: ${value}`);
  return Math.round(value * 100);
}

export function fromCents(cents: Cents): number {
  return cents / 100;
}

export function addCents(...values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}

export function subCents(a: Cents, b: Cents): Cents {
  return a - b;
}

/** Multiplica centavos por um fator racional (ex.: taxa 0.14) arredondando uma única vez. */
export function mulCents(cents: Cents, factor: number): Cents {
  if (!Number.isFinite(factor)) throw new Error(`fator inválido: ${factor}`);
  return Math.round(cents * factor);
}

export function pctOf(cents: Cents, pct: number): Cents {
  return mulCents(cents, pct / 100);
}

export function clampCents(cents: Cents, min: Cents, max: Cents): Cents {
  return Math.min(max, Math.max(min, cents));
}

/** Formata para exibição BRL. Não usar para cálculo. */
export function formatBRL(cents: Cents, locale = 'pt-BR'): string {
  return (cents / 100).toLocaleString(locale, { style: 'currency', currency: 'BRL' });
}

/** Arredondamento monetário "banker's-free": half-up, como o varejo espera. */
export function roundCentsHalfUp(cents: number): Cents {
  return cents >= 0 ? Math.floor(cents + 0.5) : -Math.floor(-cents + 0.5);
}
