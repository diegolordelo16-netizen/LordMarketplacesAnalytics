/**
 * Desenho de experimentos (§15). Registra o que é válido declarar em cada desenho.
 * Marketplaces quase nunca permitem randomização real: o desenho precisa ser nomeado com honestidade.
 */
import type { GrowthPillar } from '../types/kpi';

export const EXPERIMENT_DESIGNS = [
  'AB_RANDOMIZED',
  'SEQUENTIAL_BEFORE_AFTER',
  'PAIRED_SKU',
  'MATCHED_GROUP',
  'SWITCHBACK',
  'MULTI_ARM_BANDIT',
] as const;
export type ExperimentDesign = (typeof EXPERIMENT_DESIGNS)[number];

export interface DesignProfile {
  design: ExperimentDesign;
  label: string;
  requiresRandomization: boolean;
  supportsSrm: boolean;
  supportsCausalClaim: boolean;
  biases: string[];
  minDurationDays: number;
}

export const DESIGN_PROFILES: Record<ExperimentDesign, DesignProfile> = {
  AB_RANDOMIZED: {
    design: 'AB_RANDOMIZED',
    label: 'A/B randomizado',
    requiresRandomization: true,
    supportsSrm: true,
    supportsCausalClaim: true,
    biases: ['efeito de novidade', 'interferência entre variantes'],
    minDurationDays: 7,
  },
  SEQUENTIAL_BEFORE_AFTER: {
    design: 'SEQUENTIAL_BEFORE_AFTER',
    label: 'Antes/Depois sequencial',
    requiresRandomization: false,
    supportsSrm: false,
    supportsCausalClaim: false,
    biases: ['sazonalidade', 'campanhas simultâneas', 'mudança de concorrência', 'tendência'],
    minDurationDays: 14,
  },
  PAIRED_SKU: {
    design: 'PAIRED_SKU',
    label: 'SKU pareado',
    requiresRandomization: false,
    supportsSrm: false,
    supportsCausalClaim: false,
    biases: ['diferenças estruturais entre SKUs', 'canibalização'],
    minDurationDays: 14,
  },
  MATCHED_GROUP: {
    design: 'MATCHED_GROUP',
    label: 'Grupos comparáveis',
    requiresRandomization: false,
    supportsSrm: false,
    supportsCausalClaim: false,
    biases: ['pareamento imperfeito', 'variáveis omitidas'],
    minDurationDays: 14,
  },
  SWITCHBACK: {
    design: 'SWITCHBACK',
    label: 'Switchback temporal',
    requiresRandomization: true,
    supportsSrm: false,
    supportsCausalClaim: true,
    biases: ['carryover entre janelas', 'efeitos de calendário'],
    minDurationDays: 14,
  },
  MULTI_ARM_BANDIT: {
    design: 'MULTI_ARM_BANDIT',
    label: 'Multi-armed bandit',
    requiresRandomization: true,
    supportsSrm: false,
    supportsCausalClaim: false,
    biases: ['viés adaptativo', 'amostras desiguais', 'inferência clássica inválida'],
    minDurationDays: 14,
  },
};

export interface ExperimentPlanInput {
  hypothesis: string;
  design: ExperimentDesign;
  pillar: GrowthPillar;
  primaryMetric: string;
  guardrailMetrics: string[];
  baselineRate: number;
  mde: number;
  plannedDays: number;
  /** Variáveis que também mudam durante o teste — bloqueia veredito causal. */
  concurrentChanges?: string[];
}

export interface ExperimentPlanValidation {
  ok: boolean
  errors: string[];
  warnings: string[];
  profile: DesignProfile;
}

export function validateExperimentPlan(input: ExperimentPlanInput): ExperimentPlanValidation {
  const profile = DESIGN_PROFILES[input.design];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.hypothesis.trim()) errors.push('hipótese vazia');
  if (!/se .* então|hipótese|espera-se/i.test(input.hypothesis) && input.hypothesis.split(' ').length < 6) {
    warnings.push('hipótese curta: descreva variável, efeito esperado e métrica');
  }
  if (input.guardrailMetrics.length === 0) {
    errors.push('defina ao menos uma métrica de proteção (margem, devolução, reputação, estoque)');
  }
  if (input.mde <= 0) errors.push('MDE deve ser > 0');
  if (input.baselineRate <= 0 || input.baselineRate >= 1) errors.push('taxa base deve estar entre 0 e 1');
  if (input.plannedDays < profile.minDurationDays) {
    warnings.push(`duração ${input.plannedDays}d abaixo do mínimo sugerido ${profile.minDurationDays}d para ${profile.label}`);
  }
  if ((input.concurrentChanges?.length ?? 0) > 1) {
    warnings.push('várias mudanças simultâneas: resultado não isola a variável testada');
  }
  if (profile.requiresRandomization) {
    warnings.push(`${profile.label} exige alocação válida; confirme que a plataforma permite`);
  }
  if (!profile.supportsCausalClaim) {
    warnings.push(`${profile.label} NÃO autoriza afirmação causal; reportar como associação`);
  }
  return { ok: errors.length === 0, errors, warnings, profile };
}

export type ExperimentVerdict = 'VARIANT_WINS' | 'CONTROL_WINS' | 'INCONCLUSIVE' | 'HARMFUL';

export interface VerdictInput {
  design: ExperimentDesign;
  significant: boolean;
  diff: number;
  guardrailBreached: boolean;
  sampleAdequate: boolean;
  stoppedEarly: boolean;
  concurrentChanges: number;
}

/** Decisão do teste. Uma variante com mais cliques e pior lucro não é vencedora. */
export function decideVerdict(input: VerdictInput): { verdict: ExperimentVerdict; explanation: string } {
  if (input.guardrailBreached) {
    return {
      verdict: 'HARMFUL',
      explanation: 'métrica de proteção violada (ex.: margem, devolução ou reputação): variante descartada mesmo com ganho primário',
    };
  }
  if (!input.sampleAdequate || input.stoppedEarly || input.concurrentChanges > 1) {
    return {
      verdict: 'INCONCLUSIVE',
      explanation: !input.sampleAdequate
        ? 'amostra insuficiente para declarar vencedor'
        : input.stoppedEarly
          ? 'teste interrompido antes do período planejado'
          : 'múltiplas mudanças simultâneas impedem isolar o efeito',
    };
  }
  if (!input.significant) return { verdict: 'INCONCLUSIVE', explanation: 'diferença dentro do ruído estatístico' };
  return input.diff > 0
    ? { verdict: 'VARIANT_WINS', explanation: 'diferença positiva significativa com métricas de proteção preservadas' }
    : { verdict: 'CONTROL_WINS', explanation: 'variante pior que o controle com significância estatística' };
}
