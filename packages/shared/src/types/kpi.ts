/**
 * Tipos do motor de KPIs — 6 pilares de Growth (§9) e métricas de mídia/rentabilidade (§26.1).
 */

export const GROWTH_PILLARS = [
  'discovery_seo',
  'acquisition_ads',
  'conversion_cro',
  'revenue_profit',
  'post_purchase_retention',
  'operational_health',
] as const;
export type GrowthPillar = (typeof GROWTH_PILLARS)[number];

export const PILLAR_LABEL: Record<GrowthPillar, string> = {
  discovery_seo: 'Descoberta & SEO Orgânico',
  acquisition_ads: 'Aquisição & Mídia Paga',
  conversion_cro: 'Conversão & CRO da PDP',
  revenue_profit: 'Receita & Lucratividade Real',
  post_purchase_retention: 'Pós-Compra, Retenção & Qualidade',
  operational_health: 'Saúde Operacional & Estoque',
};

/** Entrada bruta de um período por anúncio/SKU. Todos os campos são opcionais: ausência ≠ zero. */
export interface ListingPeriodInput {
  listingId: string;
  sku?: string;
  marketplace: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;

  // Descoberta
  organicImpressions?: number;
  paidImpressions?: number;
  avgSearchPosition?: number;
  keywordCoverage?: number;
  attributeCompleteness?: number;

  // Aquisição / Ads
  adSpend?: number;
  adClicks?: number;
  adAttributedRevenue?: number;
  adAttributedOrders?: number;

  // Conversão
  visits?: number;
  orders?: number;
  units?: number;
  addToCart?: number;
  favorites?: number;
  questionsReceived?: number;
  questionsAnswered?: number;

  // Receita
  gmv?: number;
  grossRevenue?: number;
  discounts?: number;
  cancellations?: number;
  cancellationValue?: number;
  returnsCount?: number;
  returnsValue?: number;

  // Operacional
  stockAvailable?: number;
  daysInPeriod?: number;

  // Pós-compra
  reviewCount?: number;
  reviewRating?: number;
  newCustomers?: number;
  returningCustomers?: number;
}

export interface RatioKpi {
  value: number | null;
  /** Nome da fórmula, exibido na UI (§31). */
  formula: string;
  /** Por que é null, quando for. */
  unavailableReason?: string;
}

export interface PilarKpis {
  discovery_seo: {
    organicImpressions: number | null;
    paidImpressions: number | null;
    organicShare: RatioKpi;
    avgSearchPosition: number | null;
    keywordCoverage: number | null;
    attributeCompleteness: number | null;
  };
  acquisition_ads: {
    adSpend: number | null;
    adClicks: number | null;
    adAttributedRevenue: number | null;
    ctr: RatioKpi;
    roas: RatioKpi;
    acos: RatioKpi;
    tacos: RatioKpi;
    costPerOrder: RatioKpi;
    adsRevenueShare: RatioKpi;
  };
  conversion_cro: {
    visits: number | null;
    orders: number | null;
    units: number | null;
    cvr: RatioKpi;
    addToCartRate: RatioKpi;
    favoriteRate: RatioKpi;
    questionResponseRate: RatioKpi;
  };
  revenue_profit: {
    gmv: number | null;
    netRevenue: number | null;
    avgTicket: RatioKpi;
    dailyTurnover: RatioKpi;
    returnRate: RatioKpi;
    cancellationRate: RatioKpi;
    reviewRating: number | null;
    returningCustomerRate: RatioKpi;
  };
  post_purchase_retention: {
    returnsCount: number | null;
    returnsValue: number | null;
    cancellationCount: number | null;
    returnRateValue: RatioKpi;
    reviewCount: number | null;
    reviewRating: number | null;
  };
  operational_health: {
    stockAvailable: number | null;
    dailySalesAvg: RatioKpi;
    stockCoverageDays: RatioKpi;
    stockoutRisk: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    pendingQuestions: number | null;
  };
}

export interface ListingKpis {
  listingId: string;
  sku?: string;
  marketplace: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  pillars: PilarKpis;
  /** Contagem de campos brutos ausentes — alimenta o gate de qualidade. */
  missingInputs: string[];
}
