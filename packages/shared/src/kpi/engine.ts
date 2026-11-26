/**
 * Motor de KPIs centralizado (§9). Funções puras, documentadas e testáveis.
 * Regra: campo ausente → `null` + razão da indisponibilidade. Nunca zero por omissão.
 */
import type { ListingKpis, ListingPeriodInput, PilarKpis, RatioKpi } from '../types/kpi';
import { percent, ratio } from '../math/safe';

const R = (num?: number, den?: number, formula = ''): RatioKpi => {
  const r = ratio(num, den);
  return r.value === null
    ? { value: null, formula, unavailableReason: r.reason }
    : { value: r.value, formula };
};

const P = (num?: number, den?: number, formula = ''): RatioKpi => {
  const r = percent(num, den);
  return r.value === null
    ? { value: null, formula, unavailableReason: r.reason }
    : { value: r.value, formula };
};

const n = (v?: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const KPI_FORMULAS = {
  ctr: 'CTR = Cliques Ads / Impressões Ads × 100',
  roas: 'ROAS = Receita Ads / Gasto Ads',
  acos: 'ACoS = Gasto Ads / Receita Ads × 100',
  tacos: 'TACoS = Gasto Ads / Faturamento Total × 100',
  cvr: 'CVR = Pedidos / Visitas × 100',
  stockCoverage: 'Cobertura = Estoque disponível / Média diária de vendas',
  organicShare: 'Share orgânico = Impressões orgânicas / (orgânicas + pagas) × 100',
  returnRate: 'Taxa de devolução = Devoluções / Pedidos × 100',
  cancellationRate: 'Taxa de cancelamento = Cancelamentos / Pedidos × 100',
  avgTicket: 'Ticket médio = Faturamento bruto / Pedidos',
  dailyTurnover: 'Giro diário = Unidades / Dias do período',
  adsRevenueShare: 'Participação Ads = Receita Ads / Faturamento bruto × 100',
  costPerOrder: 'Custo por pedido Ads = Gasto Ads / Pedidos atribuídos',
  addToCartRate: 'Adições ao carrinho / Visitas × 100',
  favoriteRate: 'Favoritos / Visitas × 100',
  questionResponseRate: 'Perguntas respondidas / Perguntas recebidas × 100',
  returningCustomerRate: 'Clientes recorrentes / (novos + recorrentes) × 100',
} as const;

const REQUIRED_INPUTS: Array<keyof ListingPeriodInput> = [
  'visits',
  'orders',
  'units',
  'grossRevenue',
  'netRevenue',
  'adSpend',
  'organicImpressions',
  'paidImpressions',
  'stockAvailable',
];

/**
 * Calcula KPIs de um anúncio/período. `daysInPeriod` pode ser informado ou derivado das datas.
 */
export function computeListingKpis(input: ListingPeriodInput): ListingKpis {
  const days = input.daysInPeriod ?? daysBetween(input.periodStart, input.periodEnd);
  const adsImpressions =
    input.paidImpressions !== undefined
      ? input.paidImpressions
      : undefined; // nunca derivar impressões pagas de cliques

  const grossRevenue = input.grossRevenue ?? input.gmv;
  const totalImpressions =
    input.organicImpressions !== undefined && input.paidImpressions !== undefined
      ? input.organicImpressions + input.paidImpressions
      : undefined;

  const dailySalesAvg = days && input.units !== undefined ? ratio(input.units, days).value : null;
  const coverage =
    dailySalesAvg !== null && dailySalesAvg > 0 && input.stockAvailable !== undefined
      ? input.stockAvailable / dailySalesAvg
      : null;

  const pendingQuestions =
    input.questionsReceived !== undefined && input.questionsAnswered !== undefined
      ? Math.max(0, input.questionsReceived - input.questionsAnswered)
      : undefined;

  const stockoutRisk: PilarKpis['operational_health']['stockoutRisk'] =
    coverage === null
      ? 'UNKNOWN'
      : coverage < 3
        ? 'CRITICAL'
        : coverage < 7
          ? 'HIGH'
          : coverage < 14
            ? 'MEDIUM'
            : 'LOW';

  const newC = input.newCustomers;
  const retC = input.returningCustomers;
  const customers = newC !== undefined && retC !== undefined ? newC + retC : undefined;

  const pillars: PilarKpis = {
    discovery_seo: {
      organicImpressions: n(input.organicImpressions),
      paidImpressions: n(input.paidImpressions),
      organicShare: P(input.organicImpressions, totalImpressions, KPI_FORMULAS.organicShare),
      avgSearchPosition: n(input.avgSearchPosition),
      keywordCoverage: n(input.keywordCoverage),
      attributeCompleteness: n(input.attributeCompleteness),
    },
    acquisition_ads: {
      adSpend: n(input.adSpend),
      adClicks: n(input.adClicks),
      adAttributedRevenue: n(input.adAttributedRevenue),
      ctr: P(input.adClicks, adsImpressions, KPI_FORMULAS.ctr),
      roas: R(input.adAttributedRevenue, input.adSpend, KPI_FORMULAS.roas),
      acos: P(input.adSpend, input.adAttributedRevenue, KPI_FORMULAS.acos),
      tacos: P(input.adSpend, grossRevenue, KPI_FORMULAS.tacos),
      costPerOrder: R(input.adSpend, input.adAttributedOrders, KPI_FORMULAS.costPerOrder),
      adsRevenueShare: P(input.adAttributedRevenue, grossRevenue, KPI_FORMULAS.adsRevenueShare),
    },
    conversion_cro: {
      visits: n(input.visits),
      orders: n(input.orders),
      units: n(input.units),
      cvr: P(input.orders, input.visits, KPI_FORMULAS.cvr),
      addToCartRate: P(input.addToCart, input.visits, KPI_FORMULAS.addToCartRate),
      favoriteRate: P(input.favorites, input.visits, KPI_FORMULAS.favoriteRate),
      questionResponseRate: P(
        input.questionsAnswered,
        input.questionsReceived,
        KPI_FORMULAS.questionResponseRate,
      ),
    },
    revenue_profit: {
      gmv: n(input.gmv),
      // Receita líquida é uma métrica distinta; sem fonte explícita permanece indisponível.
      netRevenue: n(input.netRevenue),
      avgTicket: R(grossRevenue, input.orders, KPI_FORMULAS.avgTicket),
      dailyTurnover: R(input.units, days, KPI_FORMULAS.dailyTurnover),
      returnRate: P(input.returnsCount, input.orders, KPI_FORMULAS.returnRate),
      cancellationRate: P(input.cancellations, input.orders, KPI_FORMULAS.cancellationRate),
      reviewRating: n(input.reviewRating),
      returningCustomerRate: P(retC, customers, KPI_FORMULAS.returningCustomerRate),
    },
    post_purchase_retention: {
      returnsCount: n(input.returnsCount),
      returnsValue: n(input.returnsValue),
      cancellationCount: n(input.cancellations),
      returnRateValue: P(input.returnsCount, input.orders, KPI_FORMULAS.returnRate),
      reviewCount: n(input.reviewCount),
      reviewRating: n(input.reviewRating),
    },
    operational_health: {
      stockAvailable: n(input.stockAvailable),
      dailySalesAvg: { value: dailySalesAvg, formula: KPI_FORMULAS.dailyTurnover },
      stockCoverageDays: {
        value: coverage,
        formula: KPI_FORMULAS.stockCoverage,
        unavailableReason:
          coverage === null
            ? input.stockAvailable === undefined
              ? 'estoque ausente'
              : 'sem vendas no período'
            : undefined,
      },
      stockoutRisk,
      pendingQuestions: pendingQuestions ?? null,
    },
  };

  const missingInputs = REQUIRED_INPUTS.filter((k) => input[k] === undefined).map(String);

  return {
    listingId: input.listingId,
    sku: input.sku,
    marketplace: input.marketplace,
    accountId: input.accountId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    pillars,
    missingInputs,
  };
}

export function daysBetween(startIso: string, endIso: string): number {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const days = Math.round((b - a) / 86_400_000);
  return days > 0 ? days : 1;
}

/**
 * Métricas de mídia e rentabilidade (§26.1). Profit ROAS usa contribuição atribuída à mídia.
 */
export function computeMediaMetrics(input: {
  adSpend?: number;
  adAttributedRevenue?: number;
  totalRevenue?: number;
  adAttributedContribution?: number;
  totalMediaSpend?: number;
  adAttributedOrders?: number;
  newBuyersFromAds?: number;
}): {
  roas: RatioKpi;
  mer: RatioKpi;
  profitRoas: RatioKpi;
  costPerAttributedOrder: RatioKpi;
  costPerNewBuyer: RatioKpi;
} {
  return {
    roas: R(input.adAttributedRevenue, input.adSpend, 'ROAS atribuído (não prova incrementalidade)'),
    mer: R(input.totalRevenue, input.totalMediaSpend, 'MER = receita total / gasto total em mídia'),
    profitRoas: R(
      input.adAttributedContribution,
      input.adSpend,
      'Profit ROAS = contribuição atribuída à mídia / gasto de mídia',
    ),
    costPerAttributedOrder: R(input.adSpend, input.adAttributedOrders, 'Custo por pedido atribuído'),
    costPerNewBuyer: R(input.adSpend, input.newBuyersFromAds, 'Custo por novo comprador via Ads'),
  };
}
