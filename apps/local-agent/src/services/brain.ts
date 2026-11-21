/**
 * IA interna — o cérebro do produto, e ele é local e determinístico.
 *
 * Por que não um LLM aqui: as recomendações precisam ser auditáveis, custar
 * zero e funcionar sem internet. Uma regra que diz "estoque 0 em anúncio com
 * vendas" pode ser explicada e revisada. Um texto gerado não pode.
 *
 * A IA interna produz: priorização, diagnóstico por regra, plano de ação.
 * O Gemini (services/gemini.ts) entra depois, opcional, para revisar o plano —
 * nunca para inventar dado.
 */
import type { Alert, ListingOverview, MetricSummary } from "./analytics.js";

export interface Recommendation {
  id: string;
  priority: number; // 1 = mais urgente
  area: "estoque" | "preco" | "conteudo" | "dados" | "operacao";
  title: string;
  rationale: string;
  /** O que fazer, em passos concretos. */
  actions: string[];
  /** Quais dados sustentam isso — e quais faltam. */
  evidence: string[];
  confidence: "alta" | "media" | "baixa";
  entityRef: string | null;
}

export interface BrainReport {
  generatedAt: string;
  listingsAnalyzed: number;
  dataCompleteness: { metric: string; complete: boolean; note: string }[];
  recommendations: Recommendation[];
  /** O que o cérebro NÃO consegue concluir e por quê. Honestidade explícita. */
  blindSpots: string[];
}

function metricOf(list: MetricSummary[], name: string): MetricSummary | undefined {
  return list.find((m) => m.metric === name);
}

/**
 * Gera o relatório do cérebro. Determinístico: mesmo dado, mesmo resultado.
 * `now` entra por parâmetro para os testes não dependerem do relógio.
 */
export function think(
  listings: ListingOverview[],
  alerts: Alert[],
  now: Date = new Date(),
): BrainReport {
  const recommendations: Recommendation[] = [];
  const blindSpots: string[] = [];
  let priority = 1;

  // ---------------------------------------------------------- estoque
  for (const listing of listings) {
    const stock = metricOf(listing.metrics, "stock");
    if (!stock) {
      blindSpots.push(
        `Anúncio ${listing.entityRef}: nenhuma leitura de estoque. Sem isso, não é possível recomendar reposição.`,
      );
      continue;
    }
    if (stock.latestQuality === "NOT_COLLECTED" || stock.latestQuality === "UNKNOWN") {
      recommendations.push({
        id: `rec-stock-blind-${listing.entityRef}`,
        priority: priority++,
        area: "dados",
        title: "Estoque não legível neste anúncio",
        rationale:
          "A última captura não conseguiu ler o estoque. Tratar como zero faria o sistema sugerir reposição de um produto que pode estar cheio.",
        actions: [
          "Abrir o anúncio no marketplace e conferir o campo de estoque",
          "Recapturar a página; se persistir, revisar o seletor do adapter",
        ],
        evidence: [`métrica stock com status ${stock.latestQuality}`],
        confidence: "alta",
        entityRef: listing.entityRef,
      });
      continue;
    }
    if (stock.latest === 0) {
      recommendations.push({
        id: `rec-stock-zero-${listing.entityRef}`,
        priority: priority++,
        area: "estoque",
        title: "Repor estoque — anúncio parado",
        rationale:
          "Estoque zero confirmado. Cada dia assim é perda de exposição no marketplace, que penaliza anúncios sem disponibilidade.",
        actions: ["Confirmar estoque físico", "Repor ou pausar o anúncio até ter estoque"],
        evidence: ["métrica stock VERIFIED = 0"],
        confidence: "alta",
        entityRef: listing.entityRef,
      });
    } else if (stock.latest !== null && stock.latest <= 3) {
      recommendations.push({
        id: `rec-stock-low-${listing.entityRef}`,
        priority: priority++,
        area: "estoque",
        title: "Estoque no limite",
        rationale: `Restam ${stock.latest} unidades. Com a velocidade de venda atual pode zerar antes da próxima reposição.`,
        actions: ["Repor antes de zerar", "Verificar prazo do fornecedor"],
        evidence: [`métrica stock VERIFIED = ${stock.latest}`],
        confidence: "alta",
        entityRef: listing.entityRef,
      });
    }
  }

  // ---------------------------------------------------------- preço
  for (const listing of listings) {
    const price = metricOf(listing.metrics, "price_cents");
    if (!price) continue;
    if (price.insufficientHistory) {
      blindSpots.push(
        `Anúncio ${listing.entityRef}: só ${price.series.length} leitura de preço. Sem histórico não há tendência — nenhuma recomendação de preço seria honesta.`,
      );
      continue;
    }
    if (price.changePct !== null && price.changePct <= -10) {
      recommendations.push({
        id: `rec-price-drop-${listing.entityRef}`,
        priority: priority++,
        area: "preco",
        title: "Preço caiu mais de 10%",
        rationale: `Variação de ${price.changePct.toFixed(1)}% entre as leituras registradas.`,
        actions: [
          "Confirmar se a queda foi sua ou de uma promoção automática do marketplace",
          "Revisar margem antes de manter o preço",
        ],
        evidence: [`${price.series.length} leituras de price_cents`, "comparação primeira vs. última"],
        confidence: "media",
        entityRef: listing.entityRef,
      });
    }
  }

  // ---------------------------------------------------------- operação
  const zeroAlerts = alerts.filter((a) => a.id.startsWith("stock-zero-"));
  if (zeroAlerts.length >= 3) {
    recommendations.push({
      id: "rec-op-batch-stock",
      priority: priority++,
      area: "operacao",
      title: "Padrão sistêmico de estoque zerado",
      rationale: `${zeroAlerts.length} anúncios zerados ao mesmo tempo sugere falha de sincronização de estoque, não vendas independentes.`,
      actions: ["Verificar a integração de estoque entre sistemas", "Conferir se houve venda em lote"],
      evidence: [`${zeroAlerts.length} alertas stock-zero no mesmo ciclo`],
      confidence: "media",
      entityRef: null,
    });
  }

  // ------------------------------------------------ completude dos dados
  const allMetrics = new Set<string>();
  for (const l of listings) for (const m of l.metrics) allMetrics.add(m.metric);
  const dataCompleteness = [...allMetrics].map((metric) => {
    const total = listings.length;
    const withValue = listings.filter((l) => {
      const m = metricOf(l.metrics, metric);
      return m && m.latest !== null;
    }).length;
    return {
      metric,
      complete: withValue === total && total > 0,
      note: `${withValue} de ${total} anúncios com valor legível`,
    };
  });

  if (listings.length === 0) {
    blindSpots.push(
      "Nenhum anúncio capturado ainda. Abra a lista de anúncios do Mercado Livre com a extensão ativa e capture.",
    );
  }

  return {
    generatedAt: now.toISOString(),
    listingsAnalyzed: listings.length,
    dataCompleteness,
    recommendations: recommendations.sort((a, b) => a.priority - b.priority),
    blindSpots,
  };
}

/** Prompt para o Gemini revisar o plano. Não pede dado novo, só crítica. */
export function buildAuditPrompt(report: BrainReport): string {
  return [
    "Você é auditor externo de um sistema de gestão de marketplaces.",
    "Sua tarefa é revisar o plano abaixo e apontar: (1) recomendações mal fundamentadas,",
    "(2) conclusões que os dados não sustentam, (3) o que falta para decidir melhor.",
    "Não invente números. Não repita o plano. Responda em português, em no máximo 8 linhas.",
    "",
    "PLANO:",
    JSON.stringify(report, null, 2).slice(0, 6000),
  ].join("\n");
}
