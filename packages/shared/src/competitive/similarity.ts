/**
 * Motor de similaridade competitiva (§22 evoluído).
 *
 * Regras de projeto:
 *  - NUNCA se limita à igualdade de títulos: marca, modelo, categoria, atributos,
 *    variações, faixa de preço e termos de intenção entram no cálculo.
 *  - Todo resultado traz justificativa legível, campo a campo.
 *  - Classificação: DIRETO (mesmo produto/modelo), SIMILAR (equivalente),
 *    INDIRETO (mesma categoria, mesmo público).
 *  - Sem dados suficientes o score é baixo e a justificativa diz o que faltou —
 *    nunca se inventa semelhança.
 */

export type RelationKind = 'DIRETO' | 'SIMILAR' | 'INDIRETO';

export interface ProductFeatures {
  title: string;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  attributes?: Record<string, string> | null;
  variations?: string[] | null;
  priceCents?: number | null;
  seller?: string | null;
}

export interface SimilarityFactor {
  factor: 'brand' | 'model' | 'category' | 'title_terms' | 'attributes' | 'variations' | 'price_band' | 'seller';
  /** Contribuição em pontos percentuais (pode ser negativa quando afasta). */
  points: number;
  detail: string;
}

export interface SimilarityResult {
  similarityPct: number;
  kind: RelationKind;
  factors: SimilarityFactor[];
  /** Explicação curta para a tela de revisão. */
  summary: string;
  /** O que faltou para decidir melhor. */
  missing: string[];
}

const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'para', 'com', 'sem', 'e', 'em', 'no', 'na', 'nos', 'nas',
  'por', 'a', 'o', 'as', 'os', 'um', 'uma', 'kit', 'novo', 'nova', 'original', 'promocao',
  'frete', 'gratis', 'envio', 'imediato', 'unidade', 'unidades',
]);

/** Normaliza texto para comparação: sem acento, minúsculo, sem pontuação. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Termos relevantes do título (sem stopwords, sem tokens de 1 caractere). */
export function titleTerms(title: string): string[] {
  return normalize(title)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Detecta o modelo no texto (ex.: "FF302", "X11", "A54"). */
export function detectModel(text: string): string | null {
  const normalized = normalize(text);
  const match = normalized.match(/\b([a-z]{1,3}\s?-?\s?\d{2,5}[a-z]?)\b/);
  if (!match || !match[1]) return null;
  return match[1].replace(/\s/g, '');
}

function sameValue(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
}

function priceBand(current?: number | null, other?: number | null): number | null {
  if (typeof current !== 'number' || typeof other !== 'number' || current <= 0 || other <= 0) return null;
  return Math.abs(other - current) / current;
}

/**
 * Calcula similaridade entre o produto próprio e um candidato.
 * Pesos: marca 20, modelo 25, categoria 15, termos do título 20,
 * atributos 12, variações 4, faixa de preço 4 (ajuste ±).
 */
export function scoreSimilarity(own: ProductFeatures, candidate: ProductFeatures): SimilarityResult {
  const factors: SimilarityFactor[] = [];
  const missing: string[] = [];
  let score = 0;

  const ownBrand = own.brand ?? null;
  const candBrand = candidate.brand ?? null;
  if (ownBrand && candBrand) {
    if (sameValue(ownBrand, candBrand)) {
      score += 20;
      factors.push({ factor: 'brand', points: 20, detail: `mesma marca (${candBrand})` });
    } else {
      score -= 15;
      factors.push({ factor: 'brand', points: -15, detail: `marca diferente (${candBrand} ≠ ${ownBrand})` });
    }
  } else {
    missing.push('marca de um dos anúncios');
  }

  const ownModel = own.model ?? detectModel(own.title);
  const candModel = candidate.model ?? detectModel(candidate.title);
  if (ownModel && candModel) {
    const a = normalize(ownModel);
    const b = normalize(candModel);
    if (a === b) {
      score += 25;
      factors.push({ factor: 'model', points: 25, detail: `mesmo modelo (${candModel})` });
    } else if (a.includes(b) || b.includes(a)) {
      score += 14;
      factors.push({ factor: 'model', points: 14, detail: `modelo semelhante (${candModel} ≈ ${ownModel})` });
    } else {
      factors.push({ factor: 'model', points: 0, detail: `modelos distintos (${candModel} ≠ ${ownModel})` });
    }
  } else {
    missing.push('modelo identificável no título');
  }

  if (own.category && candidate.category) {
    if (sameValue(own.category, candidate.category)) {
      score += 15;
      factors.push({ factor: 'category', points: 15, detail: `mesma categoria (${candidate.category})` });
    } else {
      factors.push({ factor: 'category', points: 0, detail: `categoria diferente (${candidate.category})` });
    }
  } else {
    missing.push('categoria de um dos anúncios');
  }

  // Termos do título: interseção ponderada (Jaccard suave). Título diferente
  // ainda pode gerar alta similaridade quando os termos técnicos coincidem.
  const ownTerms = new Set(titleTerms(own.title));
  const candTerms = titleTerms(candidate.title);
  const overlap = candTerms.filter((t) => ownTerms.has(t));
  const union = new Set([...ownTerms, ...candTerms]);
  const jaccard = union.size > 0 ? overlap.length / union.size : 0;
  const titlePoints = Math.round(jaccard * 20);
  score += titlePoints;
  factors.push({
    factor: 'title_terms',
    points: titlePoints,
    detail: overlap.length
      ? `termos em comum: ${overlap.slice(0, 8).join(', ')}`
      : 'nenhum termo relevante em comum no título',
  });

  const ownAttrs = own.attributes ?? {};
  const candAttrs = candidate.attributes ?? {};
  const ownKeys = Object.keys(ownAttrs);
  if (ownKeys.length > 0) {
    const compared = ownKeys.filter((k) => candAttrs[k] !== undefined);
    const matched = compared.filter((k) => normalize(String(ownAttrs[k])) === normalize(String(candAttrs[k])));
    if (compared.length > 0) {
      const ratio = matched.length / ownKeys.length;
      const points = Math.round(ratio * 12);
      score += points;
      factors.push({
        factor: 'attributes',
        points,
        detail: `${matched.length} de ${ownKeys.length} atributos coincidem${matched.length ? ` (${matched.slice(0, 4).join(', ')})` : ''}`,
      });
    } else {
      missing.push('atributos técnicos comparáveis');
    }
  } else {
    missing.push('atributos técnicos do produto próprio');
  }

  if (own.variations?.length && candidate.variations?.length) {
    const ownV = new Set(own.variations.map(normalize));
    const shared = candidate.variations.filter((v) => ownV.has(normalize(v)));
    if (shared.length > 0) {
      score += 4;
      factors.push({ factor: 'variations', points: 4, detail: `variações em comum (${shared.slice(0, 3).join(', ')})` });
    } else {
      factors.push({ factor: 'variations', points: 0, detail: 'variações diferentes' });
    }
  }

  const band = priceBand(own.priceCents, candidate.priceCents);
  if (band !== null) {
    if (band <= 0.15) {
      score += 4;
      factors.push({ factor: 'price_band', points: 4, detail: `preço próximo (${(band * 100).toFixed(0)}% de diferença)` });
    } else if (band <= 0.4) {
      score += 1;
      factors.push({ factor: 'price_band', points: 1, detail: `faixa de preço vizinha (${(band * 100).toFixed(0)}%)` });
    } else {
      score -= 3;
      factors.push({ factor: 'price_band', points: -3, detail: `preço distante (${(band * 100).toFixed(0)}%)` });
    }
  } else {
    missing.push('preço de um dos anúncios');
  }

  // Mesmo vendedor: não é concorrente, mesmo com título e modelo idênticos.
  const sameSeller = Boolean(own.seller && candidate.seller && sameValue(own.seller, candidate.seller));
  if (sameSeller) {
    score -= 40;
    factors.push({ factor: 'seller', points: -40, detail: 'mesmo vendedor (não é concorrente)' });
  }

  const similarityPct = Math.max(0, Math.min(100, Math.round(score)));

  let kind: RelationKind;
  if (sameSeller) kind = 'INDIRETO';
  else if (similarityPct >= 70 && (factors.find((f) => f.factor === 'model')?.points ?? 0) >= 14) kind = 'DIRETO';
  else if (similarityPct >= 45) kind = 'SIMILAR';
  else kind = 'INDIRETO';

  const summary =
    similarityPct >= 70
      ? `${similarityPct}% — provável concorrente ${kind.toLowerCase()} (${factors.filter((f) => f.points > 0).slice(0, 3).map((f) => f.detail).join('; ')})`
      : similarityPct >= 45
        ? `${similarityPct}% — concorrente similar, revisar antes de aprovar (${factors.filter((f) => f.points > 0).slice(0, 2).map((f) => f.detail).join('; ') || 'poucos sinais'})`
        : `${similarityPct}% — relação fraca: só disputa a mesma categoria`;

  return { similarityPct, kind, factors, summary, missing };
}

export interface LearningRule {
  scope: 'BRAND' | 'CATEGORY' | 'TITLE_TERM' | 'ATTRIBUTE' | 'SELLER' | 'MODEL';
  value: string;
  direction: 'PREFERIR' | 'EVITAR';
  weight: number;
}

export interface FeedbackSample {
  decision: 'APROVADO' | 'REJEITADO';
  features: ProductFeatures;
  reason?: string | null;
}

/**
 * Deriva regras explícitas do histórico de decisões humanas.
 * Só cria regra com pelo menos `minSupport` decisões no mesmo sentido, e o peso
 * é a proporção de concordância — nada de "modelo treinado" fictício.
 */
export function deriveLearningRules(samples: FeedbackSample[], minSupport = 2): LearningRule[] {
  type Bucket = { approved: number; rejected: number };
  const buckets = new Map<string, Bucket>();
  const add = (scope: LearningRule['scope'], value: string | null | undefined, decision: FeedbackSample['decision']) => {
    if (!value) return;
    const key = `${scope}::${normalize(value)}`;
    const bucket = buckets.get(key) ?? { approved: 0, rejected: 0 };
    if (decision === 'APROVADO') bucket.approved += 1;
    else bucket.rejected += 1;
    buckets.set(key, bucket);
  };

  for (const sample of samples) {
    add('BRAND', sample.features.brand, sample.decision);
    add('CATEGORY', sample.features.category, sample.decision);
    add('MODEL', sample.features.model ?? detectModel(sample.features.title), sample.decision);
    add('SELLER', sample.features.seller, sample.decision);
    for (const term of titleTerms(sample.features.title)) add('TITLE_TERM', term, sample.decision);
  }

  const rules: LearningRule[] = [];
  for (const [key, bucket] of buckets) {
    const [scope, rawValue] = key.split('::') as [LearningRule['scope'], string];
    const total = bucket.approved + bucket.rejected;
    if (total < minSupport) continue;
    if (scope === 'TITLE_TERM' && rawValue.length < 3) continue;
    const ratio = bucket.approved / total;
    if (ratio >= 0.75) {
      rules.push({ scope, value: rawValue, direction: 'PREFERIR', weight: Number(ratio.toFixed(3)) });
    } else if (ratio <= 0.25) {
      rules.push({ scope, value: rawValue, direction: 'EVITAR', weight: Number((1 - ratio).toFixed(3)) });
    }
  }
  return rules.sort((a, b) => b.weight - a.weight);
}

export interface LearningAdjustment {
  points: number;
  applied: Array<{ rule: LearningRule; detail: string }>;
}

/** Aplica as regras aprendidas ao score de um candidato. */
export function applyLearning(
  candidate: ProductFeatures,
  base: SimilarityResult,
  rules: LearningRule[],
): LearningAdjustment {
  const applied: LearningAdjustment['applied'] = [];
  let points = 0;
  const terms = new Set(titleTerms(candidate.title));
  const normalizedTitle = normalize(candidate.title);

  for (const rule of rules) {
    let hit = false;
    switch (rule.scope) {
      case 'BRAND':
        hit = Boolean(candidate.brand) && normalize(candidate.brand!) === rule.value;
        break;
      case 'CATEGORY':
        hit = Boolean(candidate.category) && normalize(candidate.category!) === rule.value;
        break;
      case 'MODEL': {
        const model = candidate.model ?? detectModel(candidate.title);
        hit = Boolean(model) && normalize(model!) === rule.value;
        break;
      }
      case 'SELLER':
        hit = Boolean(candidate.seller) && normalize(candidate.seller!) === rule.value;
        break;
      case 'TITLE_TERM':
        hit = terms.has(rule.value) || normalizedTitle.includes(rule.value);
        break;
      case 'ATTRIBUTE':
        hit = Boolean(candidate.attributes) && normalize(JSON.stringify(candidate.attributes)).includes(rule.value);
        break;
    }
    if (!hit) continue;
    const delta = Math.round((rule.direction === 'PREFERIR' ? 1 : -1) * rule.weight * 8);
    points += delta;
    applied.push({
      rule,
      detail: `${rule.direction === 'PREFERIR' ? 'aprendido: prefere' : 'aprendido: evita'} ${rule.scope.toLowerCase()} "${rule.value}" (${delta > 0 ? '+' : ''}${delta})`,
    });
  }

  // Evitar termo recorrentemente rejeitado é mais forte que preferir.
  const hasAvoid = applied.some((a) => a.rule.direction === 'EVITAR');
  if (hasAvoid && base.similarityPct >= 45) points -= 10;

  return { points, applied };
}

/** Ajusta o resultado base com o aprendizado, mantendo-o dentro de 0..100. */
export function withLearning(base: SimilarityResult, adjustment: LearningAdjustment): SimilarityResult {
  const similarityPct = Math.max(0, Math.min(100, base.similarityPct + adjustment.points));
  const factors: SimilarityFactor[] = [
    ...base.factors,
    ...adjustment.applied.map((a) => ({
      factor: 'attributes' as const,
      points: 0,
      detail: a.detail,
    })),
  ];
  let kind: RelationKind = base.kind;
  if (adjustment.applied.length > 0) {
    if (similarityPct >= 70 && (base.factors.find((f) => f.factor === 'model')?.points ?? 0) >= 14) kind = 'DIRETO';
    else if (similarityPct >= 45) kind = 'SIMILAR';
    else kind = 'INDIRETO';
  }
  return {
    similarityPct,
    kind,
    factors,
    summary:
      adjustment.applied.length > 0
        ? `${base.summary} · ${adjustment.applied.length} regra(s) de aprendizado aplicada(s) (${adjustment.points > 0 ? '+' : ''}${adjustment.points})`
        : base.summary,
    missing: base.missing,
  };
}
