/**
 * Score de oportunidade de palavra-chave (§12.9). Nunca produz nota final sem dados mínimos:
 * nesse caso devolve "dados insuficientes" com a lista do que falta.
 */

export const KEYWORD_INTENTS = [
  'PRODUTO_DIRETO',
  'MARCA',
  'MODELO_COMPATIBILIDADE',
  'BENEFICIO_USO',
  'KIT_ATACADO',
  'SAZONAL',
  'DUVIDA',
] as const;
export type KeywordIntent = (typeof KEYWORD_INTENTS)[number];

export const KEYWORD_INTENT_LABEL: Record<KeywordIntent, string> = {
  PRODUTO_DIRETO: 'Produto direto',
  MARCA: 'Marca',
  MODELO_COMPATIBILIDADE: 'Modelo/compatibilidade',
  BENEFICIO_USO: 'Benefício/uso',
  KIT_ATACADO: 'Kit/atacado',
  SAZONAL: 'Sazonal',
  DUVIDA: 'Dúvida',
};

/** Como o "volume" foi obtido — a palavra volume nunca aparece sem origem (§12.6). */
export const DEMAND_LABELS = [
  'SINAL_DE_DEMANDA',
  'FREQUENCIA_OBSERVADA',
  'INDICE_RELATIVO',
  'VOLUME_ESTIMADO',
  'VOLUME_PLATAFORMA',
] as const;
export type DemandLabel = (typeof DEMAND_LABELS)[number];

export interface KeywordOpportunityInput {
  term: string;
  intent: KeywordIntent;
  /** Valor de demanda conforme o rótulo. */
  demandValue?: number | null;
  demandLabel?: DemandLabel;
  /** Variação relativa de tendência (-1..+3). */
  trendDelta?: number | null;
  /** Aderência ao catálogo 0..1. */
  catalogFit?: number | null;
  /** Margem potencial (%) do SKU associado. */
  marginPct?: number | null;
  /** Lacuna competitiva 0..1 (1 = nenhum concorrente cobre). */
  competitiveGap?: number | null;
  /** Facilidade de ranqueamento 0..1 (proxy interno, não é dificuldade de ferramenta externa). */
  rankingFeasibility?: number | null;
  /** CVR observada para o termo (%), se houver. */
  observedCvrPct?: number | null;
  effortHours?: number | null;
}

export interface KeywordScoreWeights {
  demand: number;
  trend: number;
  intent: number;
  fit: number;
  margin: number;
  gap: number;
  feasibility: number;
  cvr: number;
  effort: number;
}

export const DEFAULT_KEYWORD_WEIGHTS: KeywordScoreWeights = {
  demand: 0.22,
  trend: 0.1,
  intent: 0.12,
  fit: 0.16,
  margin: 0.12,
  gap: 0.12,
  feasibility: 0.08,
  cvr: 0.05,
  effort: 0.03,
};

const INTENT_VALUE: Record<KeywordIntent, number> = {
  PRODUTO_DIRETO: 1,
  MODELO_COMPATIBILIDADE: 0.9,
  MARCA: 0.75,
  KIT_ATACADO: 0.8,
  BENEFICIO_USO: 0.6,
  SAZONAL: 0.55,
  DUVIDA: 0.3,
};

export interface KeywordScoreResult {
  term: string;
  score: number | null;
  insufficientData?: { missing: string[]; message: string };
  contributions: Record<string, { raw: number | null; normalized: number; weight: number; weighted: number }>;
  demandLabel?: DemandLabel;
  confidence: number;
  notes: string[];
}

/** Normaliza demanda em escala log; exige rótulo explícito. */
function normalizeDemand(value: number | null | undefined, label?: DemandLabel): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (!label) return null;
  if (label === 'INDICE_RELATIVO') return Math.min(1, value / 100);
  return Math.min(1, Math.log10(value + 1) / 3);
}

export function scoreKeyword(
  input: KeywordOpportunityInput,
  weights: KeywordScoreWeights = DEFAULT_KEYWORD_WEIGHTS,
): KeywordScoreResult {
  const missing: string[] = [];
  const notes: string[] = [];

  if (typeof input.demandValue !== 'number' || input.demandValue <= 0) missing.push('demanda');
  if (!input.demandLabel) missing.push('rótulo da fonte de demanda');
  if (typeof input.catalogFit !== 'number') missing.push('aderência ao catálogo');
  if (typeof input.marginPct !== 'number') missing.push('margem potencial');

  const demand = normalizeDemand(input.demandValue, input.demandLabel);
  const trend = typeof input.trendDelta === 'number' ? Math.min(1, Math.max(0, (input.trendDelta + 0.5) / 2.5)) : null;
  const intent = INTENT_VALUE[input.intent];
  const fit = input.catalogFit ?? null;
  const margin = typeof input.marginPct === 'number' ? Math.min(1, Math.max(0, input.marginPct / 60)) : null;
  const gap = input.competitiveGap ?? null;
  const feasibility = input.rankingFeasibility ?? null;
  const cvr = typeof input.observedCvrPct === 'number' ? Math.min(1, input.observedCvrPct / 10) : null;
  const effort = typeof input.effortHours === 'number' ? Math.min(1, Math.max(0, 1 / (1 + Math.log2(Math.max(0.25, input.effortHours))))) : null;

  const raw: Record<string, number | null> = {
    demand,
    trend,
    intent,
    fit,
    margin,
    gap,
    feasibility,
    cvr,
    effort,
  };

  if (missing.length > 0) {
    return {
      term: input.term,
      score: null,
      insufficientData: { missing, message: 'dados insuficientes para score de oportunidade' },
      contributions: Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [
          k,
          { raw: v, normalized: v ?? 0, weight: weights[k as keyof KeywordScoreWeights], weighted: 0 },
        ]),
      ),
      demandLabel: input.demandLabel,
      confidence: 0,
      notes: ['nenhuma nota final é gerada sem demanda, aderência e margem'],
    };
  }

  // Recalcula pesos apenas para os componentes disponíveis (normalização honesta).
  let totalWeight = 0;
  let weighted = 0;
  const contributions: KeywordScoreResult['contributions'] = {};
  for (const [k, v] of Object.entries(raw)) {
    const w = weights[k as keyof KeywordScoreWeights];
    if (v === null) {
      contributions[k] = { raw: null, normalized: 0, weight: w, weighted: 0 };
      continue;
    }
    totalWeight += w;
    weighted += v * w;
    contributions[k] = { raw: v, normalized: v, weight: w, weighted: Math.round(v * w * 1000) / 1000 };
  }
  const score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 1000) / 10 : null;

  const availableCount = Object.values(raw).filter((v) => v !== null).length;
  const confidence = Math.min(1, availableCount / Object.keys(raw).length);

  if (input.competitiveGap !== undefined && input.competitiveGap !== null) {
    notes.push('lacuna competitiva é proxy interno baseada em sinais observáveis, não em métricas de ferramentas externas');
  }
  if (input.demandLabel === 'INDICE_RELATIVO') notes.push('demanda expressa como índice relativo, não como volume absoluto');

  return {
    term: input.term,
    score,
    contributions,
    demandLabel: input.demandLabel,
    confidence: Math.round(confidence * 100) / 100,
    notes,
  };
}

/** Expansão de termos semente: sinônimos, variações e cauda longa — determinístico, sem IA. */
export function expandSeedTerm(
  seed: string,
  options: {
    synonyms?: string[];
    modifiers?: string[];
    longTailSuffixes?: string[];
    questions?: string[];
  } = {},
): string[] {
  const base = seed.trim().toLowerCase();
  if (!base) return [];
  const out = new Set<string>([base]);
  for (const syn of options.synonyms ?? []) out.add(`${syn.trim().toLowerCase()} ${base}`.trim());
  for (const mod of options.modifiers ?? []) {
    out.add(`${base} ${mod.trim().toLowerCase()}`);
    out.add(`${mod.trim().toLowerCase()} ${base}`);
  }
  for (const suffix of options.longTailSuffixes ?? []) out.add(`${base} ${suffix.trim().toLowerCase()}`);
  for (const q of options.questions ?? []) out.add(`${base} ${q.trim().toLowerCase()}`.replace(/\s+/g, ' '));
  return [...out].filter((t) => t.length <= 120);
}

/** Agrupamento semântico simples por raiz de tokens (sem IA, corrigível manualmente). */
export function clusterKeywords(terms: string[], stopwords: string[] = DEFAULT_STOPWORDS): Map<string, string[]> {
  const clusters = new Map<string, string[]>();
  for (const term of terms) {
    const tokens = term
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !stopwords.includes(t));
    const key = tokens[0] ?? 'outros';
    const list = clusters.get(key) ?? [];
    list.push(term);
    clusters.set(key, list);
  }
  return clusters;
}

export const DEFAULT_STOPWORDS = [
  'de',
  'da',
  'do',
  'para',
  'com',
  'sem',
  'em',
  'e',
  'o',
  'a',
  'os',
  'as',
  'um',
  'uma',
  'por',
  'the',
];
