/**
 * Estatística de experimentação (§15): tamanho de amostra, testes, intervalos,
 * análise sequencial e SRM. Nada aqui decide "vencedor" com amostra insuficiente.
 */

export interface TwoProportionResult {
  p1: number;
  p2: number;
  n1: number;
  n2: number;
  /** Diferença absoluta de proporções (p2 - p1). */
  diff: number;
  /** Diferença relativa (p2/p1 - 1) quando p1 > 0. */
  relativeDiff: number | null;
  zScore: number | null;
  pValue: number | null;
  /** Intervalo de confiança 95% para a diferença absoluta. */
  ci95: { low: number; high: number } | null;
  /** Verdadeiro somente se amostra mínima atingida e p abaixo do alfa. */
  significant: boolean;
  inconclusiveReason?: string;
}

/** Erro padrão da diferença entre duas proporções (pooled). */
function pooledSe(p1: number, p2: number, n1: number, n2: number): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const pPool = (p1 * n1 + p2 * n2) / (n1 + n2);
  return Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
}

function unpooledSe(p1: number, p2: number, n1: number, n2: number): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  return Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
}

/** Aproximação de Abramowitz-Stegun para a normal padrão acumulada (erro < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

/** p-valor bilateral a partir do z. */
export function twoSidedPValue(z: number): number {
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

/** z crítico para confiança de duas caudas (95% → 1.96). */
export function zCritical(confidence = 0.95): number {
  // Busca binária simples e determinística.
  let lo = 0;
  let hi = 6;
  const target = 1 - (1 - confidence) / 2;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Tamanho de amostra por grupo para detectar uma diferença absoluta `mde` (efeito mínimo relevante)
 * em proporção base `p`, com alfa e poder dados (fórmula padrão de duas proporções).
 */
export function sampleSizePerArm(p: number, mde: number, alpha = 0.05, power = 0.8): number {
  if (p <= 0 || p >= 1) throw new Error('proporção base deve estar em (0,1)');
  if (mde <= 0) throw new Error('MDE deve ser > 0');
  const p2 = Math.min(0.999999, Math.max(0.000001, p + mde));
  const za = zCritical(1 - alpha);
  const zb = zCritical(2 * power - 1);
  const pBar = (p + p2) / 2;
  const num = (za * Math.sqrt(2 * pBar * (1 - pBar)) + zb * Math.sqrt(p * (1 - p) + p2 * (1 - p2))) ** 2;
  return Math.ceil(num / mde ** 2);
}

export interface CompareOptions {
  alpha?: number;
  /** Amostra mínima por grupo exigida antes de qualquer veredito. */
  minSamplePerArm?: number;
  /** Número de métricas olhadas (correção de Bonferroni opcional). */
  metricsCount?: number;
  /** Se o teste foi interrompido antes do fim do período planejado. */
  stoppedEarly?: boolean;
}

export function compareProportions(
  s1: { successes: number; n: number },
  s2: { successes: number; n: number },
  opts: CompareOptions = {},
): TwoProportionResult {
  const alpha = opts.alpha ?? 0.05;
  const minSample = opts.minSamplePerArm ?? 100;
  const p1 = s1.n > 0 ? s1.successes / s1.n : 0;
  const p2 = s2.n > 0 ? s2.successes / s2.n : 0;
  const diff = p2 - p1;
  const relativeDiff = p1 > 0 ? p2 / p1 - 1 : null;
  const sePooled = pooledSe(p1, p2, s1.n, s2.n);
  const seUnpooled = unpooledSe(p1, p2, s1.n, s2.n);
  const z = sePooled && sePooled > 0 ? diff / sePooled : null;
  const pValue = z === null ? null : twoSidedPValue(z);
  const zc = zCritical(1 - alpha);
  const ci95 =
    seUnpooled && seUnpooled > 0
      ? { low: diff - zc * seUnpooled, high: diff + zc * seUnpooled }
      : null;

  const reasons: string[] = [];
  if (s1.n < minSample || s2.n < minSample) reasons.push(`amostra abaixo do mínimo (${minSample}/grupo)`);
  if (pValue === null) reasons.push('variância nula ou amostra vazia');
  if (opts.stoppedEarly) reasons.push('teste interrompido antes do período planejado');
  if (opts.metricsCount && opts.metricsCount > 1) {
    const corrected = alpha / opts.metricsCount;
    if (pValue !== null && pValue >= corrected) reasons.push(`p-valor não sobrevive à correção de Bonferroni (${corrected})`);
  }
  const significant = reasons.length === 0 && pValue !== null && pValue < alpha;

  return {
    p1,
    p2,
    n1: s1.n,
    n2: s2.n,
    diff,
    relativeDiff,
    zScore: z,
    pValue,
    ci95,
    significant,
    inconclusiveReason: significant ? undefined : reasons.join('; ') || 'diferença dentro do ruído esperado',
  };
}

/** Teste de Sample Ratio Mismatch (só faz sentido com alocação aleatória) — qui-quadrado 1 gl. */
export function detectSrm(
  observed: [number, number],
  expectedRatio = 0.5,
  alpha = 0.0001,
): { srm: boolean; pValue: number; observedRatio: number } {
  const total = observed[0] + observed[1];
  if (total === 0) return { srm: false, pValue: 1, observedRatio: 0 };
  const e1 = total * expectedRatio;
  const e2 = total * (1 - expectedRatio);
  const chi2 = (observed[0] - e1) ** 2 / e1 + (observed[1] - e2) ** 2 / e2;
  // p-valor da cauda de chi2 com 1 gl = 2*(1 - Φ(sqrt(chi2)))
  const pValue = Math.min(1, 2 * (1 - normalCdf(Math.sqrt(chi2))));
  return { srm: pValue < alpha, pValue, observedRatio: observed[0] / total };
}

/**
 * Alfa ajustado para análise sequencial (Pocock-like, aproximação conservadora):
 * com K olhares planejados, o alfa por olhar é alpha/K * fator. Exposto como função
 * para documentar a regra usada — não é um método exato de alpha-spending.
 */
export function sequentialAlphaPerLook(alpha: number, looks: number): number {
  if (looks < 1) throw new Error('looks deve ser >= 1');
  return alpha / looks;
}

/** Intervalo de credibilidade Bayesiano (Beta-Binomial) aproximado por quantis numéricos. */
export function betaCredibleInterval(
  successes: number,
  n: number,
  prior: { a: number; b: number } = { a: 1, b: 1 },
  level = 0.95,
): { low: number; high: number; mean: number } {
  const a = prior.a + successes;
  const b = prior.b + Math.max(0, n - successes);
  const mean = a / (a + b);
  const variance = (a * b) / ((a + b) ** 2 * (a + b + 1));
  const sd = Math.sqrt(variance);
  const z = zCritical(level);
  return { low: Math.max(0, mean - z * sd), high: Math.min(1, mean + z * sd), mean };
}
