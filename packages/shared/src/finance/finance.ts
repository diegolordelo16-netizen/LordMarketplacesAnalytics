/**
 * Motor financeiro avançado (§10, §23). Tudo em centavos inteiros.
 * Camadas obrigatórias: bruto → após descontos → líquido → contribuição → operacional → realizado.
 */
import { type Cents, mulCents, pctOf, subCents, toCents } from '../math/money';
import { ratio } from '../math/safe';

export interface MarketplaceFeeRule {
  /** Comissão percentual sobre o preço de venda (%). */
  commissionPct: number;
  /** Taxa fixa por item vendido (centavos). */
  fixedFeeCents: Cents;
  /** Percentual adicional por parcelamento/antecipação (%). */
  installmentPct?: number;
}

export interface SkuCosts {
  sku: string;
  /** Custo de compra/fabricação por unidade (centavos). */
  unitCostCents: Cents;
  /** Embalagem por unidade (centavos). */
  packagingCents: Cents;
  /** Frete pago pelo vendedor por unidade (centavos). */
  shippingCents: Cents;
  /** Impostos sobre a venda (%). */
  taxPct: number;
  /** Outros custos variáveis por unidade (centavos). */
  otherVariableCents: Cents;
  /** Margem mínima exigida (%) — piso de preço. */
  minMarginPct: number;
  /** Versão do custo: histórico preservado (§10). */
  version: number;
  validFrom: string;
}

export interface ScenarioInput {
  priceCents: Cents;
  quantity: number;
  fee: MarketplaceFeeRule;
  costs: SkuCosts;
  /** Desconto aplicado sobre o preço (%). */
  discountPct?: number;
  /** Cupom por unidade (centavos). */
  couponCents?: Cents;
  /** Gasto de Ads atribuído ao período (centavos). */
  adSpendCents?: Cents;
  /** Taxa esperada de devolução (%). */
  returnRatePct?: number;
  /** Taxa esperada de cancelamento (%). */
  cancellationRatePct?: number;
  /** Custo de logística reversa por devolução (centavos). */
  reverseLogisticsCents?: Cents;
  /** Taxa de conversão esperada (%) — usada para custo de aquisição por pedido. */
  expectedCvrPct?: number;
  /** Custo fixo alocado ao período (centavos). */
  fixedCostCents?: Cents;
}

export interface ScenarioResult {
  grossRevenueCents: Cents;
  discountCents: Cents;
  revenueAfterDiscountCents: Cents;
  commissionCents: Cents;
  fixedFeeCents: Cents;
  installmentCents: Cents;
  taxCents: Cents;
  netRevenueCents: Cents;
  productCostCents: Cents;
  packagingCents: Cents;
  shippingCents: Cents;
  otherVariableCents: Cents;
  couponCents: Cents;
  returnLossCents: Cents;
  cancellationLossCents: Cents;
  contributionCents: Cents;
  contributionMarginPct: number | null;
  adSpendCents: Cents;
  operatingProfitCents: Cents;
  operatingMarginPct: number | null;
  /** Resultado realizado só existe quando há liquidação/valores efetivos registrados. Simulação não é dado realizado. */
  realizedResultCents: Cents | null;
  unitContributionCents: Cents;
  breakEvenPriceCents: Cents | null;
  minPriceForMarginCents: Cents | null;
  /** Se o preço respeita a margem mínima configurada. */
  respectsMinMargin: boolean;
  formulaNotes: string[];
}

/**
 * Calcula o cenário completo de um SKU.
 *
 * Ordem: receita bruta → descontos → comissões/taxas/impostos → receita líquida →
 * custos variáveis → contribuição → Ads → lucro operacional → resultado realizado (após devoluções).
 */
export function simulateScenario(input: ScenarioInput): ScenarioResult {
  const q = Math.max(0, Math.floor(input.quantity));
  const grossRevenueCents = input.priceCents * q;
  const discountCents = pctOf(grossRevenueCents, input.discountPct ?? 0);
  const revenueAfterDiscountCents = subCents(grossRevenueCents, discountCents);

  const commissionCents = pctOf(revenueAfterDiscountCents, input.fee.commissionPct);
  const installmentCents = pctOf(revenueAfterDiscountCents, input.fee.installmentPct ?? 0);
  const fixedFeeCents = input.fee.fixedFeeCents * q;
  const taxCents = pctOf(revenueAfterDiscountCents, input.costs.taxPct);

  const netRevenueCents = subCents(
    revenueAfterDiscountCents,
    commissionCents + installmentCents + fixedFeeCents + taxCents,
  );

  const productCostCents = input.costs.unitCostCents * q;
  const packagingCents = input.costs.packagingCents * q;
  const shippingCents = input.costs.shippingCents * q;
  const otherVariableCents = input.costs.otherVariableCents * q;
  const couponCents = (input.couponCents ?? 0) * q;

  // Perdas esperadas por devolução/cancelamento (fração dos pedidos, não das unidades).
  const returnRate = (input.returnRatePct ?? 0) / 100;
  const cancelRate = (input.cancellationRatePct ?? 0) / 100;
  const unitRevenue = q > 0 ? revenueAfterDiscountCents / q : 0;
  const unitVariable = q > 0 ? (productCostCents + packagingCents + shippingCents) / q : 0;
  const returnLossCents = Math.round(
    returnRate * q * (unitVariable + (input.reverseLogisticsCents ?? 0)),
  );
  const cancellationLossCents = Math.round(cancelRate * q * Math.max(0, unitVariable * 0.5));

  const contributionCents = subCents(
    netRevenueCents,
    productCostCents +
      packagingCents +
      shippingCents +
      otherVariableCents +
      couponCents +
      returnLossCents +
      cancellationLossCents,
  );

  const adSpendCents = input.adSpendCents ?? 0;
  const operatingProfitCents = subCents(contributionCents, adSpendCents + (input.fixedCostCents ?? 0));
  const realizedResultCents = null;

  const contributionMargin = ratio(contributionCents, revenueAfterDiscountCents).value;
  const operatingMargin = ratio(operatingProfitCents, revenueAfterDiscountCents).value;

  // Piso de preço: menor preço por unidade em que a contribuição unitária cobre a margem mínima.
  const baseVariablePerUnit =
    input.costs.unitCostCents +
    input.costs.packagingCents +
    input.costs.shippingCents +
    input.costs.otherVariableCents +
    (input.couponCents ?? 0);
  const returnFraction = (input.returnRatePct ?? 0) / 100;
  const cancellationFraction = (input.cancellationRatePct ?? 0) / 100;
  const returnLossPerUnit = returnFraction * (
    input.costs.unitCostCents + input.costs.packagingCents + input.costs.shippingCents + (input.reverseLogisticsCents ?? 0)
  );
  const cancellationLossPerUnit = cancellationFraction * (
    (input.costs.unitCostCents + input.costs.packagingCents + input.costs.shippingCents) * 0.5
  );
  const variablePerUnit = baseVariablePerUnit + returnLossPerUnit + cancellationLossPerUnit;
  const feePctFraction =
    (input.fee.commissionPct + (input.fee.installmentPct ?? 0) + input.costs.taxPct) / 100;
  const discountMultiplier = 1 - (input.discountPct ?? 0) / 100;
  // O ponto de equilíbrio não inclui lucro; o piso acrescenta a margem mínima.
  // Ambos consideram desconto médio, taxas, custos e perdas esperadas por unidade.
  const breakEvenDenominator = discountMultiplier * (1 - feePctFraction);
  const minMarginDenominator = discountMultiplier * (1 - feePctFraction - input.costs.minMarginPct / 100);
  const breakEvenPriceCents =
    breakEvenDenominator > 0
      ? Math.ceil((variablePerUnit + input.fee.fixedFeeCents) / breakEvenDenominator)
      : null;
  const minPriceForMarginCents =
    minMarginDenominator > 0
      ? Math.ceil((variablePerUnit + input.fee.fixedFeeCents) / minMarginDenominator)
      : null;

  const unitContributionCents = q > 0 ? Math.round(contributionCents / q) : 0;
  const effectiveUnitPrice = input.priceCents * (1 - (input.discountPct ?? 0) / 100);
  const unitMarginPct =
    effectiveUnitPrice > 0
      ? ((effectiveUnitPrice * (1 - feePctFraction) - input.fee.fixedFeeCents - variablePerUnit) / effectiveUnitPrice) * 100
      : null;

  return {
    grossRevenueCents,
    discountCents,
    revenueAfterDiscountCents,
    commissionCents,
    fixedFeeCents,
    installmentCents,
    taxCents,
    netRevenueCents,
    productCostCents,
    packagingCents,
    shippingCents,
    otherVariableCents,
    couponCents,
    returnLossCents,
    cancellationLossCents,
    contributionCents,
    contributionMarginPct: contributionMargin === null ? null : contributionMargin * 100,
    adSpendCents,
    operatingProfitCents,
    operatingMarginPct: operatingMargin === null ? null : operatingMargin * 100,
    realizedResultCents,
    unitContributionCents,
    breakEvenPriceCents,
    minPriceForMarginCents,
    respectsMinMargin: unitMarginPct !== null && unitMarginPct >= input.costs.minMarginPct,
    formulaNotes: [
      'Receita líquida = receita após descontos − comissão − parcelamento − taxa fixa − impostos',
      'Contribuição = receita líquida − produto − embalagem − frete − outros variáveis − cupom − perdas de devolução/cancelamento',
      'Lucro operacional = contribuição − Ads − custos fixos alocados',
    'Resultado realizado = NOT_COLLECTED nesta simulação; exige liquidação e custos efetivos registrados',
      'Ponto de equilíbrio = (custos variáveis + taxa fixa) / (1 − taxas%)',
      'Piso de margem = (custos variáveis + taxa fixa) / (1 − taxas% − margem mínima%)',
    ],
  };
}

/** Converte valores em reais para o formato interno. */
export function brl(value: number): Cents {
  return toCents(value);
}

/**
 * Corredor de preço competitivo (§23.2): piso (margem), teto (competitividade) e recomendação.
 */
export function priceCorridor(params: {
  costs: SkuCosts;
  fee: MarketplaceFeeRule;
  competitorPricesCents: Cents[];
  currentPriceCents: Cents;
  /** Limite de redução aceito pelo usuário (%) — trava de segurança. */
  maxReductionPct: number;
  /** Limite de aumento aceito pelo usuário (%). */
  maxIncreasePct: number;
  /** Fração do mercado abaixo da qual não se recomenda descer (ex.: 0.25 → quartil 1). */
  targetPercentile?: number;
}): {
  floorCents: Cents | null;
  ceilingCents: Cents | null;
  recommendedCents: Cents | null;
  blockedBy: string[];
  positionVsMedian: number | null;
  scenarioAtRecommended: ScenarioResult | null;
} {
  const sorted = [...params.competitorPricesCents].filter((c) => c > 0).sort((a, b) => a - b);
  const blockedBy: string[] = [];
  const probe = simulateScenario({ priceCents: params.currentPriceCents, quantity: 1, fee: params.fee, costs: params.costs });
  const floorCents = probe.minPriceForMarginCents;

  const median = sorted.length
    ? sorted.length % 2 === 1
      ? (sorted[Math.floor(sorted.length / 2)] as Cents)
      : Math.round(((sorted[sorted.length / 2 - 1] as Cents) + (sorted[sorted.length / 2] as Cents)) / 2)
    : null;

  const targetPct = params.targetPercentile ?? 0.35;
  const targetIdx = sorted.length ? Math.floor((sorted.length - 1) * targetPct) : -1;
  const marketTarget = targetIdx >= 0 ? (sorted[targetIdx] as Cents) : null;

  let recommended: Cents | null = null;
  const maxReductionPct = Math.min(100, Math.max(0, Number.isFinite(params.maxReductionPct) ? params.maxReductionPct : 0));
  const maxIncreasePct = Math.max(0, Number.isFinite(params.maxIncreasePct) ? params.maxIncreasePct : 0);
  const minAllowed = Math.round(params.currentPriceCents * (1 - maxReductionPct / 100));
  const maxAllowed = Math.round(params.currentPriceCents * (1 + maxIncreasePct / 100));

  if (floorCents === null) {
    blockedBy.push('piso de margem indisponível: recomendação de preço bloqueada');
  } else if (maxAllowed < floorCents) {
    blockedBy.push('piso de margem acima do limite máximo autorizado: recomendação bloqueada');
  } else {
    recommended = marketTarget ?? floorCents;
    if (recommended < floorCents) {
      recommended = floorCents;
      blockedBy.push('preço competitivo abaixo do piso de margem: mantido o piso');
    }
    if (recommended < minAllowed) {
      recommended = Math.max(minAllowed, floorCents);
      blockedBy.push(`redução limitada a ${maxReductionPct}% pelo usuário`);
    }
    if (recommended > maxAllowed) {
      // maxAllowed só pode ficar abaixo do piso caso os limites sejam incoerentes;
      // a condição anterior já bloqueia esse cenário.
      recommended = Math.max(floorCents, maxAllowed);
      blockedBy.push(`aumento limitado a ${maxIncreasePct}% pelo usuário`);
    }
  }

  const ceilingCents = median !== null ? Math.round(median * 1.15) : null;

  return {
    floorCents,
    ceilingCents,
    recommendedCents: recommended,
    blockedBy,
    positionVsMedian: median && median > 0 ? params.currentPriceCents / median : null,
    scenarioAtRecommended:
      recommended === null
        ? null
        : simulateScenario({ priceCents: recommended, quantity: 1, fee: params.fee, costs: params.costs }),
  };
}

/**
 * Elasticidade-preço estimada por regressão log-log simples.
 * Devolve null quando não há variação suficiente — correlação não é causalidade (§23.3).
 */
export function estimateElasticity(points: Array<{ price: number; units: number }>): {
  elasticity: number | null;
  r2: number | null;
  n: number;
  warning: string;
} {
  const clean = points.filter((p) => p.price > 0 && p.units >= 0);
  const n = clean.length;
  if (n < 8) {
    return { elasticity: null, r2: null, n, warning: 'histórico insuficiente (mínimo 8 observações com variação de preço)' };
  }
  const xs = clean.map((p) => Math.log(p.price));
  const ys = clean.map((p) => Math.log(Math.max(p.units, 0.5)));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return { elasticity: null, r2: null, n, warning: 'sem variação de preço no período' };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? null : (sxy * sxy) / (sxx * syy);
  return {
    elasticity: slope,
    r2,
    n,
    warning:
      'correlação histórica; promoções, estoque, frete, Ads e sazonalidade podem explicar a variação. Não é efeito causal.',
  };
}

/** Aplica uma taxa percentual já arredondada (utilitário para relatórios). */
export function pct(cents: Cents, percentage: number): Cents {
  return mulCents(cents, percentage / 100);
}
