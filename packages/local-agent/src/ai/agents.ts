/**
 * Orquestrador dos 14 agentes especializados + AI Director (§18.1).
 *
 * Cada agente é uma função pura: recebe um contexto de dados já validado e devolve
 * uma recomendação no contrato de 10 campos (§29.2). O AI Director consolida,
 * expõe divergências e aplica a regra de prevalência financeira.
 *
 * Importante: nenhum agente aqui chama a API do Gemini diretamente — o Gemini é
 * usado como consultor (workspace de debate) e auditor, nunca como fonte de verdade.
 */

export const AGENT_KEYS = [
  'seo_demand',
  'ads',
  'competition',
  'conversion_cro',
  'finance',
  'inventory',
  'content_postpurchase',
  'pricing_offer',
  'performance_experiments',
  'market_category',
  'keyword_rank',
  'voice_of_customer',
  'forecast_planning',
  'growth_strategy',
] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const AGENT_LABEL: Record<AgentKey, string> = {
  seo_demand: 'Agente de SEO & Demanda',
  ads: 'Agente de Ads',
  competition: 'Agente de Concorrência',
  conversion_cro: 'Agente de Conversão (CRO)',
  finance: 'Agente Financeiro',
  inventory: 'Agente de Estoque',
  content_postpurchase: 'Agente de Conteúdo & Pós-Compra',
  pricing_offer: 'Agente de Precificação & Oferta',
  performance_experiments: 'Agente de Performance & Experimentação',
  market_category: 'Agente de Inteligência de Mercado & Categoria',
  keyword_rank: 'Agente de Keyword Intelligence & Rank Tracking',
  voice_of_customer: 'Agente de Voice of Customer',
  forecast_planning: 'Agente de Forecast & Planejamento',
  growth_strategy: 'Agente de Growth Strategy & Retenção',
};

/** Contrato de resposta obrigatório (§29.2). */
export interface AgentRecommendation {
  agentKey: AgentKey;
  diagnosis: string;
  evidence: Array<{ label: string; value: string; sourceClass: string; referenceAt?: string }>;
  window: string;
  sampleSize: number | null;
  facts: string[];
  hypotheses: string[];
  confidence: number;
  missingData: string[];
  impactRange: { lowCents: number; highCents: number; unit: 'BRL_PER_PERIOD' } | null;
  risk: string;
  guardrailMetric: string;
  actionProposed: string;
  alternative: string;
  requiresApproval: boolean;
  requiredPermission: string;
  verificationCriteria: string;
}

export interface AgentContext {
  accountId: string;
  marketplace: string;
  listingId: string;
  sku?: string;
  window: { start: string; end: string; days: number };
  metrics: {
    visits?: number | null;
    orders?: number | null;
    cvrPct?: number | null;
    cvrBenchmarkPct?: number | null;
    adSpendCents?: number | null;
    adRevenueCents?: number | null;
    adClicks?: number | null;
    adImpressions?: number | null;
    roas?: number | null;
    tacosPct?: number | null;
    organicImpressions?: number | null;
    avgPosition?: number | null;
    stockCoverageDays?: number | null;
    units?: number | null;
    dailySales?: number | null;
    contributionCents?: number | null;
    contributionMarginPct?: number | null;
    returnRatePct?: number | null;
    returnRateBaselinePct?: number | null;
    keywordCoveragePct?: number | null;
    attributeCompletenessPct?: number | null;
    competitorMedianPriceCents?: number | null;
    ownPriceCents?: number | null;
    reviewRating?: number | null;
    pendingQuestions?: number | null;
    imageQualityScore?: number | null;
  };
  competitorSignals?: {
    fasterShipping: boolean;
    lowerPricePct: number | null;
    moreReviews: boolean;
    betterCover: boolean;
    sponsoredPresence: boolean;
  };
  returnReasons?: string[];
  dataConfidence: number;
  missingData: string[];
}

const guard = (action: string, permission: string) => ({
  requiresApproval: true,
  requiredPermission: permission,
  verificationCriteria: `confirmar no marketplace que ${action} foi salvo e comparar KPIs de 7 dias antes/depois`,
});

function impact(contributionCents: number | null | undefined, liftPct: number): AgentRecommendation['impactRange'] {
  if (typeof contributionCents !== 'number' || contributionCents <= 0) return null;
  const base = contributionCents * (liftPct / 100);
  return {
    lowCents: Math.round(base * 0.4),
    highCents: Math.round(base * 1.2),
    unit: 'BRL_PER_PERIOD',
  };
}

type AgentFn = (ctx: AgentContext) => AgentRecommendation[];

const seoDemand: AgentFn = (ctx) => {
  // `metrics` pode vir vazio quando nada foi coletado: os agentes leem os
  // campos como opcionais e declaram o dado ausente, nunca quebram.
  const m = ctx.metrics ?? {};
  const recs: AgentRecommendation[] = [];
  if (m.keywordCoveragePct !== null && m.keywordCoveragePct !== undefined && m.keywordCoveragePct < 60) {
    recs.push({
      agentKey: 'seo_demand',
      diagnosis: `Cobertura de palavras-chave baixa (${m.keywordCoveragePct.toFixed(0)}%) para a intenção principal do anúncio.`,
      evidence: [
        { label: 'Cobertura de keywords', value: `${m.keywordCoveragePct.toFixed(0)}%`, sourceClass: 'A_PRIMARY_UI', referenceAt: ctx.window.end },
        { label: 'Impressões orgânicas', value: String(m.organicImpressions ?? 'não coletado'), sourceClass: 'A_PRIMARY_UI' },
      ],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.organicImpressions ?? null,
      facts: [`posição média observada: ${m.avgPosition ?? 'não coletado'}`],
      hypotheses: ['termos de cauda longa relevantes estão ausentes do título/ficha'],
      confidence: ctx.dataConfidence,
      missingData: ctx.missingData.filter((d) => /keyword|posi/i.test(d)),
      impactRange: impact(m.contributionCents, 8),
      risk: 'keyword stuffing viola políticas do marketplace e reduz conversão',
      guardrailMetric: 'margem de contribuição e CVR',
      actionProposed: 'Reescrever título com termos de maior intenção respeitando o limite de caracteres',
      alternative: 'Completar atributos da ficha técnica antes de mexer no título',
      ...guard('a alteração de título', 'edit_listing'),
    });
  }
  if (m.attributeCompletenessPct !== null && m.attributeCompletenessPct !== undefined && m.attributeCompletenessPct < 70) {
    recs.push({
      agentKey: 'seo_demand',
      diagnosis: `Ficha técnica incompleta (${m.attributeCompletenessPct.toFixed(0)}% dos atributos preenchidos).`,
      evidence: [{ label: 'Atributos preenchidos', value: `${m.attributeCompletenessPct.toFixed(0)}%`, sourceClass: 'A_PRIMARY_UI' }],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: null,
      facts: [],
      hypotheses: ['filtros de busca deixam de exibir o anúncio'],
      confidence: ctx.dataConfidence,
      missingData: [],
      impactRange: impact(m.contributionCents, 5),
      risk: 'preencher atributo com dado não confirmado gera devolução',
      guardrailMetric: 'taxa de devolução por expectativa',
      actionProposed: 'Preencher apenas atributos com dado confirmado do fabricante',
      alternative: 'Solicitar ficha técnica ao fornecedor antes de editar',
      ...guard('a ficha técnica', 'edit_listing'),
    });
  }
  return recs;
};

const ads: AgentFn = (ctx) => {
  const m = ctx.metrics;
  const recs: AgentRecommendation[] = [];
  const spend = m.adSpendCents ?? 0;
  const revenue = m.adRevenueCents ?? 0;
  if (spend > 0 && revenue < spend) {
    recs.push({
      agentKey: 'ads',
      diagnosis: 'Ads consumindo mais do que gera: campanha deficitária.',
      evidence: [
        { label: 'Gasto Ads', value: (spend / 100).toFixed(2), sourceClass: 'A_PRIMARY_UI' },
        { label: 'Receita atribuída', value: (revenue / 100).toFixed(2), sourceClass: 'A_PRIMARY_UI' },
      ],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.adClicks ?? null,
      facts: [`ROAS ${m.roas?.toFixed(2) ?? 'não calculável'}`],
      hypotheses: ['lances acima do necessário ou público fora do perfil'],
      confidence: ctx.dataConfidence,
      missingData: ctx.missingData.filter((d) => /ads|cliques/i.test(d)),
      impactRange: { lowCents: Math.round(spend * 0.3), highCents: spend, unit: 'BRL_PER_PERIOD' },
      risk: 'pausar Ads pode reduzir vendas orgânicas dependentes de histórico',
      guardrailMetric: 'receita total e TACoS',
      actionProposed: 'Reduzir orçamento/lance ou pausar termos com ACoS acima do alvo',
      alternative: 'Revisar capa e preço antes de pausar (conversão pode explicar)',
      ...guard('a mudança de Ads', 'manage_financial_limits'),
    });
  }
  if (spend > 0 && (m.stockCoverageDays ?? 99) < 7) {
    recs.push({
      agentKey: 'ads',
      diagnosis: 'Ads ativos com estoque prestes a acabar.',
      evidence: [
        { label: 'Cobertura de estoque', value: `${m.stockCoverageDays?.toFixed(1)} dias`, sourceClass: 'A_PRIMARY_UI' },
        { label: 'Gasto Ads', value: (spend / 100).toFixed(2), sourceClass: 'A_PRIMARY_UI' },
      ],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.units ?? null,
      facts: [],
      hypotheses: ['gasto será desperdiçado em tráfego sem conversão'],
      confidence: ctx.dataConfidence,
      missingData: [],
      impactRange: { lowCents: Math.round(spend * 0.2), highCents: Math.round(spend * 0.6), unit: 'BRL_PER_PERIOD' },
      risk: 'perda de posição orgânica durante a pausa',
      guardrailMetric: 'cobertura de estoque',
      actionProposed: 'Pausar Ads até a reposição',
      alternative: 'Reduzir lance mantendo presença mínima',
      ...guard('a pausa de Ads', 'manage_financial_limits'),
    });
  }
  return recs;
};

const conversionCro: AgentFn = (ctx) => {
  const m = ctx.metrics;
  const recs: AgentRecommendation[] = [];
  if (m.visits && m.cvrPct !== null && m.cvrPct !== undefined && m.cvrBenchmarkPct && m.cvrPct < m.cvrBenchmarkPct * 0.7) {
    recs.push({
      agentKey: 'conversion_cro',
      diagnosis: `CVR ${m.cvrPct.toFixed(2)}% muito abaixo da referência ${m.cvrBenchmarkPct.toFixed(2)}% com tráfego relevante.`,
      evidence: [
        { label: 'Visitas', value: String(m.visits), sourceClass: 'A_PRIMARY_UI' },
        { label: 'CVR', value: `${m.cvrPct.toFixed(2)}%`, sourceClass: 'CALCULATED' },
      ],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.visits,
      facts: [`pedidos: ${m.orders ?? 'não coletado'}`],
      hypotheses: ['capa não responde à intenção de busca', 'frete/prazo pior que o concorrente', 'ficha técnica deixa dúvidas'],
      confidence: ctx.dataConfidence,
      missingData: ctx.missingData.filter((d) => /visita|pedido/i.test(d)),
      impactRange: impact(m.contributionCents, 12),
      risk: 'alterar capa e título juntos impede isolar a causa',
      guardrailMetric: 'CTR e margem',
      actionProposed: 'Testar nova capa (imagem principal) com medição antes/depois de 7 dias',
      alternative: 'Melhorar bloco anti-devolução na descrição primeiro',
      ...guard('a troca de capa', 'edit_listing'),
    });
  }
  if (m.pendingQuestions && m.pendingQuestions > 0) {
    recs.push({
      agentKey: 'conversion_cro',
      diagnosis: `${m.pendingQuestions} perguntas pré-venda sem resposta.`,
      evidence: [{ label: 'Perguntas pendentes', value: String(m.pendingQuestions), sourceClass: 'A_PRIMARY_UI' }],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.pendingQuestions,
      facts: [],
      hypotheses: ['compradores com dúvida abandonam a compra'],
      confidence: ctx.dataConfidence,
      missingData: [],
      impactRange: impact(m.contributionCents, 4),
      risk: 'resposta incorreta gera devolução',
      guardrailMetric: 'taxa de devolução',
      actionProposed: 'Responder as perguntas e transformar as dúvidas recorrentes em bloco na descrição',
      alternative: 'Criar FAQ na descrição com base nos temas',
      ...guard('as respostas', 'edit_listing'),
    });
  }
  return recs;
};

const finance: AgentFn = (ctx) => {
  const m = ctx.metrics;
  const recs: AgentRecommendation[] = [];
  if (m.contributionMarginPct !== null && m.contributionMarginPct !== undefined && m.contributionMarginPct < 0) {
    recs.push({
      agentKey: 'finance',
      diagnosis: `Margem de contribuição negativa (${m.contributionMarginPct.toFixed(1)}%).`,
      evidence: [
        { label: 'Contribuição', value: ((m.contributionCents ?? 0) / 100).toFixed(2), sourceClass: 'CALCULATED' },
        { label: 'Margem', value: `${m.contributionMarginPct.toFixed(1)}%`, sourceClass: 'CALCULATED' },
      ],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.units ?? null,
      facts: [],
      hypotheses: ['preço abaixo do piso', 'custo de produto desatualizado', 'frete absorvido'],
      confidence: ctx.dataConfidence,
      missingData: ctx.missingData.filter((d) => /custo|frete|taxa/i.test(d)),
      impactRange: { lowCents: Math.abs(m.contributionCents ?? 0), highCents: Math.abs(m.contributionCents ?? 0) * 2, unit: 'BRL_PER_PERIOD' },
      risk: 'aumento de preço pode reduzir volume',
      guardrailMetric: 'volume de pedidos',
      actionProposed: 'Simular novo preço no corredor de margem e propor aprovação',
      alternative: 'Renegociar custo/frete com fornecedor antes de mexer no preço',
      ...guard('a mudança de preço', 'manage_financial_limits'),
    });
  }
  if ((m.tacosPct ?? 0) > 15) {
    recs.push({
      agentKey: 'finance',
      diagnosis: `TACoS de ${m.tacosPct?.toFixed(1)}% acima do saudável para a categoria.`,
      evidence: [{ label: 'TACoS', value: `${m.tacosPct?.toFixed(1)}%`, sourceClass: 'CALCULATED' }],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.adClicks ?? null,
      facts: [],
      hypotheses: ['dependência de mídia paga'],
      confidence: ctx.dataConfidence,
      missingData: [],
      impactRange: impact(m.contributionCents, 6),
      risk: 'cortar mídia reduz receita no curto prazo',
      guardrailMetric: 'receita total',
      actionProposed: 'Reduzir gasto em termos de menor retorno e reinvestir em orgânico',
      alternative: 'Melhorar CVR para diluir o custo de mídia',
      ...guard('a mudança de orçamento', 'manage_financial_limits'),
    });
  }
  return recs;
};

const inventory: AgentFn = (ctx) => {
  const m = ctx.metrics;
  const recs: AgentRecommendation[] = [];
  if (m.stockCoverageDays !== null && m.stockCoverageDays !== undefined && m.stockCoverageDays < 7) {
    recs.push({
      agentKey: 'inventory',
      diagnosis: `Cobertura de estoque de ${m.stockCoverageDays.toFixed(1)} dias: risco de ruptura.`,
      evidence: [
        { label: 'Cobertura', value: `${m.stockCoverageDays.toFixed(1)} dias`, sourceClass: 'CALCULATED' },
        { label: 'Vendas diárias', value: String(m.dailySales ?? 'não coletado'), sourceClass: 'CALCULATED' },
      ],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.units ?? null,
      facts: [],
      hypotheses: ['reposição chegará após a ruptura'],
      confidence: ctx.dataConfidence,
      missingData: [],
      impactRange: impact(m.contributionCents, 10),
      risk: 'perda de ranking por indisponibilidade',
      guardrailMetric: 'receita e posição',
      actionProposed: 'Priorizar reposição e pausar Ads do SKU',
      alternative: 'Ajustar prazo de envio para manter vendas',
      ...guard('a pausa de Ads e a reposição', 'manage_financial_limits'),
    });
  }
  return recs;
};

const contentPostpurchase: AgentFn = (ctx) => {
  const m = ctx.metrics;
  const recs: AgentRecommendation[] = [];
  const reasons = ctx.returnReasons ?? [];
  if ((m.returnRatePct ?? 0) > 0 && reasons.length > 0) {
    recs.push({
      agentKey: 'content_postpurchase',
      diagnosis: `Taxa de devolução ${m.returnRatePct?.toFixed(1)}% com motivos recorrentes identificados.`,
      evidence: reasons.slice(0, 5).map((r) => ({ label: 'Motivo de devolução', value: r, sourceClass: 'A_PRIMARY_UI' })),
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: null,
      facts: [],
      hypotheses: ['expectativa criada pelo anúncio difere do produto recebido'],
      confidence: ctx.dataConfidence,
      missingData: [],
      impactRange: impact(m.contributionCents, 7),
      risk: 'bloco adicional pode alongar a descrição e reduzir leitura',
      guardrailMetric: 'CVR e taxa de devolução',
      actionProposed: 'Anexar bloco anti-devolução à descrição preservando 100% do texto original',
      alternative: 'Incluir infográfico de medidas nas imagens',
      ...guard('a descrição', 'edit_listing'),
    });
  }
  return recs;
};

const pricingOffer: AgentFn = (ctx) => {
  const m = ctx.metrics;
  const recs: AgentRecommendation[] = [];
  if (
    m.competitorMedianPriceCents &&
    m.ownPriceCents &&
    m.ownPriceCents > m.competitorMedianPriceCents * 1.1 &&
    (m.contributionMarginPct ?? 0) > 20
  ) {
    recs.push({
      agentKey: 'pricing_offer',
      diagnosis: 'Preço acima da mediana competitiva com margem saudável: espaço para engenharia de oferta.',
      evidence: [
        { label: 'Preço próprio', value: (m.ownPriceCents / 100).toFixed(2), sourceClass: 'A_PRIMARY_UI' },
        { label: 'Mediana concorrentes', value: (m.competitorMedianPriceCents / 100).toFixed(2), sourceClass: 'D_PUBLIC_OBSERVATION' },
      ],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: null,
      facts: [],
      hypotheses: ['kits aumentam ticket e diluem taxa fixa'],
      confidence: Math.min(ctx.dataConfidence, 0.85),
      missingData: [],
      impactRange: impact(m.contributionCents, 6),
      risk: 'canibalização do anúncio unitário',
      guardrailMetric: 'contribuição unitária',
      actionProposed: 'Simular kit/multipack no motor financeiro antes de criar o anúncio',
      alternative: 'Atacar palavras-chave de cauda longa com menor concorrência',
      ...guard('o novo anúncio/kit', 'edit_listing'),
    });
  }
  return recs;
};

const competition: AgentFn = (ctx) => {
  const s = ctx.competitorSignals;
  if (!s) return [];
  const drivers: string[] = [];
  if (s.fasterShipping) drivers.push('frete mais rápido');
  if ((s.lowerPricePct ?? 0) > 0) drivers.push(`preço ${s.lowerPricePct?.toFixed(1)}% menor`);
  if (s.moreReviews) drivers.push('mais avaliações');
  if (s.betterCover) drivers.push('capa mais clara');
  if (s.sponsoredPresence) drivers.push('presença patrocinada');
  if (drivers.length === 0) return [];
  return [
    {
      agentKey: 'competition',
      diagnosis: `Concorrente do mesmo produto leva vantagem por: ${drivers.join(', ')}.`,
      evidence: drivers.map((d) => ({ label: 'Sinal observado', value: d, sourceClass: 'D_PUBLIC_OBSERVATION' })),
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: null,
      facts: drivers,
      hypotheses: ['parte da diferença de vendas pode ser sazonal ou de posição, não do fator observado'],
      confidence: Math.min(ctx.dataConfidence, 0.75),
      missingData: ['vendas reais do concorrente (não observáveis)'],
      impactRange: impact(ctx.metrics.contributionCents, 8),
      risk: 'guerra de preço destrói margem sem ganho sustentável',
      guardrailMetric: 'margem de contribuição',
      actionProposed: 'Diferenciação: capa com infográfico de medidas, prova social e garantia destacada',
      alternative: 'Kit exclusivo para reduzir peso do frete e da taxa fixa',
      requiresApproval: true,
      requiredPermission: 'edit_listing',
      verificationCriteria: 'medir CVR e posição por 7 dias antes/depois da mudança',
    },
  ];
};

const keywordRank: AgentFn = (ctx) => {
  const m = ctx.metrics;
  if (m.avgPosition !== null && m.avgPosition !== undefined && m.avgPosition > 20) {
    return [
      {
        agentKey: 'keyword_rank',
        diagnosis: `Posição média ${m.avgPosition.toFixed(1)}: fora do Top 20 para termos relevantes.`,
        evidence: [{ label: 'Posição média', value: m.avgPosition.toFixed(1), sourceClass: 'A_PRIMARY_UI' }],
        window: `${ctx.window.start} → ${ctx.window.end}`,
        sampleSize: null,
        facts: [],
        hypotheses: ['relevância do título/ficha abaixo dos líderes'],
        confidence: ctx.dataConfidence,
        missingData: [],
        impactRange: impact(m.contributionCents, 5),
        risk: 'ranking é personalizado por contexto: não é universal',
        guardrailMetric: 'CVR',
        actionProposed: 'Priorizar termos onde o anúncio já converte melhor',
        alternative: 'Aumentar visibilidade via Ads em termos de cauda longa',
        ...guard('a alteração de conteúdo', 'edit_listing'),
      },
    ];
  }
  return [];
};

const voiceOfCustomer: AgentFn = (ctx) => {
  const reasons = ctx.returnReasons ?? [];
  if (reasons.length === 0) return [];
  return [
    {
      agentKey: 'voice_of_customer',
      diagnosis: `Temas recorrentes nas devoluções: ${reasons.slice(0, 3).join(', ')}.`,
      evidence: reasons.map((r) => ({ label: 'Tema', value: r, sourceClass: 'A_PRIMARY_UI' })),
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: reasons.length,
      facts: [],
      hypotheses: ['objeções não respondidas antes da compra'],
      confidence: ctx.dataConfidence,
      missingData: [],
      impactRange: impact(ctx.metrics.contributionCents, 4),
      risk: 'generalização a partir de amostra pequena',
      guardrailMetric: 'taxa de devolução',
      actionProposed: 'Corrigir anúncio, imagem e embalagem para os temas mais frequentes',
      alternative: 'Adicionar guia de medidas',
      ...guard('as correções de conteúdo', 'edit_listing'),
    },
  ];
};

const performanceExperiments: AgentFn = (ctx) => {
  const recs = [...conversionCro(ctx)];
  return recs.map((r) => ({
    ...r,
    agentKey: 'performance_experiments' as AgentKey,
    actionProposed: `Desenhar experimento (antes/depois ou SKU pareado) para: ${r.actionProposed}`,
    verificationCriteria: 'amostra mínima calculada, MDE definido, métricas de proteção ativas',
  }));
};

const marketCategory: AgentFn = (ctx) => {
  const m = ctx.metrics;
  if (m.competitorMedianPriceCents && m.ownPriceCents) {
    return [
      {
        agentKey: 'market_category',
        diagnosis: 'Posicionamento de preço mapeado dentro da categoria.',
        evidence: [
          { label: 'Preço próprio', value: (m.ownPriceCents / 100).toFixed(2), sourceClass: 'A_PRIMARY_UI' },
          { label: 'Mediana da categoria', value: (m.competitorMedianPriceCents / 100).toFixed(2), sourceClass: 'D_PUBLIC_OBSERVATION' },
        ],
        window: `${ctx.window.start} → ${ctx.window.end}`,
        sampleSize: null,
        facts: [],
        hypotheses: ['nicho com menor concorrência pode ter margem melhor'],
        confidence: Math.min(ctx.dataConfidence, 0.8),
        missingData: ['demanda reprimida só com sinais convergentes'],
        impactRange: null,
        risk: 'concluir demanda sem sinais convergentes',
        guardrailMetric: 'margem mínima',
        actionProposed: 'Validar nicho com amostra de busca e plano de teste de baixo risco',
        alternative: 'Manter foco no produto atual',
        ...guard('a criação de novos anúncios', 'edit_listing'),
      },
    ];
  }
  return [];
};

const forecastPlanning: AgentFn = (ctx) => {
  const m = ctx.metrics;
  if (!m.dailySales || m.dailySales <= 0) return [];
  return [
    {
      agentKey: 'forecast_planning',
      diagnosis: `Vendas diárias de ${m.dailySales.toFixed(1)} unidades projetam demanda futura estimada.`,
      evidence: [{ label: 'Vendas/dia', value: m.dailySales.toFixed(1), sourceClass: 'CALCULATED' }],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.units ?? null,
      facts: [],
      hypotheses: ['sazonalidade pode alterar a projeção'],
      confidence: Math.min(ctx.dataConfidence, 0.7),
      missingData: ['histórico sazonal suficiente'],
      impactRange: null,
      risk: 'projeção tratada como certeza',
      guardrailMetric: 'cobertura de estoque',
      actionProposed: 'Planejar reposição com intervalo de incerteza',
      alternative: 'Aguardar mais semanas de histórico',
      requiresApproval: false,
      requiredPermission: 'view_reports',
      verificationCriteria: 'comparar previsão com realizado na próxima semana (MAPE)',
    },
  ];
};

const growthStrategy: AgentFn = (ctx) => {
  const m = ctx.metrics;
  const parts: string[] = [];
  if ((m.cvrPct ?? 0) > 0) parts.push('conversão');
  if ((m.contributionMarginPct ?? 0) > 0) parts.push('margem');
  if ((m.returnRatePct ?? 0) > 0) parts.push('devolução');
  return [
    {
      agentKey: 'growth_strategy',
      diagnosis: `North Star (contribuição líquida) depende hoje de: ${parts.join(', ') || 'dados insuficientes'}.`,
      evidence: [
        { label: 'Contribuição', value: ((m.contributionCents ?? 0) / 100).toFixed(2), sourceClass: 'CALCULATED' },
        { label: 'CVR', value: m.cvrPct === null || m.cvrPct === undefined ? 'não coletado' : `${m.cvrPct.toFixed(2)}%`, sourceClass: 'CALCULATED' },
      ],
      window: `${ctx.window.start} → ${ctx.window.end}`,
      sampleSize: m.visits ?? null,
      facts: [],
      hypotheses: ['aumentar tráfego sem resolver conversão apenas amplifica o gargalo'],
      confidence: ctx.dataConfidence,
      missingData: ctx.missingData,
      impactRange: null,
      risk: 'otimizar métrica isolada às custas da margem',
      guardrailMetric: 'contribuição líquida',
      actionProposed: 'Priorizar a iniciativa de maior impacto × esforço na árvore de métricas',
      alternative: 'Coletar dados faltantes antes de decidir',
      requiresApproval: false,
      requiredPermission: 'view_reports',
      verificationCriteria: 'evolução da contribuição líquida em 30 dias',
    },
  ];
};

export const AGENT_IMPLEMENTATIONS: Record<AgentKey, AgentFn> = {
  seo_demand: seoDemand,
  ads,
  competition,
  conversion_cro: conversionCro,
  finance,
  inventory,
  content_postpurchase: contentPostpurchase,
  pricing_offer: pricingOffer,
  performance_experiments: performanceExperiments,
  market_category: marketCategory,
  keyword_rank: keywordRank,
  voice_of_customer: voiceOfCustomer,
  forecast_planning: forecastPlanning,
  growth_strategy: growthStrategy,
};

export interface DirectorSynthesis {
  recommendations: AgentRecommendation[];
  conflicts: Array<{ topic: string; agents: AgentKey[]; resolution: string }>;
  finalAction: AgentRecommendation | null;
  notes: string[];
}

/**
 * AI Director: consolida, expõe divergências e aplica prevalência financeira (§29.4).
 * Regra: se o agente financeiro aponta margem negativa, nenhuma ação que aumente tráfego
 * é recomendada como final até nova simulação.
 */
export function runAgents(agents: AgentKey[], ctx: AgentContext): AgentRecommendation[] {
  const out: AgentRecommendation[] = [];
  for (const key of agents) {
    const fn = AGENT_IMPLEMENTATIONS[key];
    if (!fn) continue;
    for (const rec of fn(ctx)) out.push(rec);
  }
  return out;
}

export function synthesize(
  recommendations: AgentRecommendation[],
  ctx: AgentContext,
): DirectorSynthesis {
  const notes: string[] = [];
  const conflicts: DirectorSynthesis['conflicts'] = [];

  const marginNegative = (ctx.metrics.contributionMarginPct ?? 0) < 0;
  const marginUnknown=ctx.metrics.contributionMarginPct==null;
  const trafficIncreasing = recommendations.filter((r) =>
    ['seo_demand', 'keyword_rank', 'ads', 'market_category'].includes(r.agentKey),
  );

  let filtered = recommendations;
  if (marginNegative && trafficIncreasing.length > 0) {
    conflicts.push({
      topic: 'aumento de tráfego vs. margem negativa',
      agents: ['seo_demand', 'keyword_rank', 'finance'],
      resolution: 'prevalece a proteção financeira: ações de tráfego suspensas até nova simulação de margem',
    });
    filtered = recommendations.filter((r) => !trafficIncreasing.includes(r));
    notes.push('margem negativa detectada: recomendações de aumento de tráfego foram bloqueadas');
  }

  if(marginUnknown&&trafficIncreasing.length){notes.push('margem não confirmada: recomendações de tráfego exigem validação financeira antes de priorizar investimento');}
  if (ctx.dataConfidence < 0.7) {
    notes.push(`confiança dos dados ${(ctx.dataConfidence * 100).toFixed(0)}% abaixo de 70%: diagnóstico não é conclusivo`);
  }

  const ranked = [...filtered].sort((a, b) => {
    const ai = a.impactRange ? a.impactRange.highCents : 0;
    const bi = b.impactRange ? b.impactRange.highCents : 0;
    return bi - ai || b.confidence - a.confidence;
  });

  return {
    recommendations: filtered,
    conflicts,
    finalAction: ctx.dataConfidence<0.7?null:ranked.find(r=>!marginUnknown||!trafficIncreasing.includes(r))??null,
    notes,
  };
}
