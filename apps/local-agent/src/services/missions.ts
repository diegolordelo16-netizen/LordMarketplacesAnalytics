/**
 * Missões do Dia: transforma o que já foi coletado em 3 a 5 decisões.
 *
 * Cada missão nasce de um gargalo com número, não de uma ideia solta:
 *  - margem negativa ou abaixo do piso → alerta crítico, urgência máxima;
 *  - estoque cobrindo poucos dias → risco de ruptura (e de gastar Ads à toa);
 *  - visitas sem venda → gargalo de conversão na página;
 *  - preço acima do concorrente ligado ao mesmo produto → oportunidade de posicionamento.
 *
 * O que não tem dado não vira missão: sem visitas coletadas não se afirma
 * "conversão travada", e a missão diz qual número falta.
 */
import type { ListingOverview } from "./analytics.js";
import type { FinanceService, MissionInput } from "./finance.js";

interface MissionSource {
  listings: ListingOverview[];
  competitors?: { title: string | null; priceCents: number | null; linkedEntityRef: string | null }[];
}

function metricValue(listing: ListingOverview, metric: string): number | null {
  const m = listing.metrics.find((x) => x.metric === metric);
  if (!m) return null;
  const value = (m as unknown as { latest?: number | null }).latest;
  return typeof value === "number" ? value : null;
}

export function buildMissions(listings: ListingOverview[], finance: FinanceService, source: MissionSource = { listings }): MissionInput[] {
  const out: MissionInput[] = [];

  for (const listing of listings) {
    const price = listing.priceCents;
    const stock = listing.stock;
    const visits = metricValue(listing, "visits");
    const orders = metricValue(listing, "orders");
    const sold = metricValue(listing, "sold");

    // 1. Margem: só quando existe custo cadastrado — sem custo, não se afirma nada.
    if (price !== null && finance.currentCost(listing.entityRef)) {
      const m = finance.margin(listing.entityRef, price);
      if (m.contributionCents !== null && m.contributionCents < 0) {
        out.push({
          entityRef: listing.entityRef,
          marketplace: null,
          pillar: "lucratividade",
          bottleneck: "Margem de contribuição negativa",
          hypothesis: "O preço atual não cobre custo, comissão, imposto e frete — cada venda perde dinheiro.",
          evidence: `preço ${brl(price)}; contribuição ${brl(m.contributionCents)} por venda`,
          impactCents: Math.abs(m.contributionCents) * Math.max(1, sold ?? 1),
          impactPct: m.marginBp === null ? null : m.marginBp / 100,
          effort: 2,
          urgency: 5,
          risk: "Subir preço pode reduzir volume; revisar antes de aplicar.",
        });
      } else if (m.marginBp !== null && m.marginBp < m.minMarginBp) {
        out.push({
          entityRef: listing.entityRef,
          marketplace: null,
          pillar: "lucratividade",
          bottleneck: "Margem abaixo do mínimo definido",
          hypothesis: "Ajustar preço, frete ou kit devolve a margem sem perder competitividade.",
          evidence: `margem ${(m.marginBp / 100).toFixed(1)}% contra piso de ${(m.minMarginBp / 100).toFixed(1)}%`,
          impactCents: Math.round(((m.minMarginBp - m.marginBp) / 10_000) * price),
          impactPct: (m.minMarginBp - m.marginBp) / 100,
          effort: 3,
          urgency: 4,
          risk: "Alteração de preço exige aprovação e acompanhamento de conversão.",
        });
      }
    }

    // 2. Estoque: cobertura em dias, quando existe média de venda.
    if (stock !== null && sold !== null && sold > 0) {
      const daily = sold / 30;
      const coverage = daily > 0 ? stock / daily : null;
      if (coverage !== null && coverage < 10) {
        out.push({
          entityRef: listing.entityRef,
          marketplace: null,
          pillar: "operacional",
          bottleneck: "Risco de ruptura de estoque",
          hypothesis: "Repor antes de zerar evita perder posição e queimar verba de Ads em anúncio sem estoque.",
          evidence: `${stock} unidades, cobertura de ${coverage.toFixed(1)} dias (${sold} vendidos na base)`,
          impactCents: price !== null ? price * Math.max(0, Math.ceil(daily * 15) - stock) : null,
          impactPct: null,
          effort: 2,
          urgency: 5,
          risk: "Reposição depende de fornecedor e prazo de entrega.",
        });
      }
    }

    // 3. Conversão: visitas sem pedido é gargalo de página, não de tráfego.
    if (visits !== null && visits >= 50 && (orders === null || orders === 0)) {
      out.push({
        entityRef: listing.entityRef,
        marketplace: null,
        pillar: "conversão",
        bottleneck: "Visitas sem venda",
        hypothesis: "A página recebe gente e não converte: capa, preço, frete ou descrição não respondem à dúvida do comprador.",
        evidence: `${visits} visitas e ${orders ?? 0} pedidos na mesma janela`,
        impactCents: price !== null ? Math.round(visits * 0.01) * price : null,
        impactPct: null,
        effort: 3,
        urgency: 4,
        risk: "Mudar capa/título sem medir antes e depois impede saber o que funcionou.",
      });
    }
  }

  // 4. Concorrente ligado a um produto meu, com preço menor.
  for (const comp of source.competitors ?? []) {
    if (!comp.linkedEntityRef || comp.priceCents === null) continue;
    const own = listings.find((l) => l.entityRef === comp.linkedEntityRef);
    if (!own?.priceCents) continue;
    const diffPct = ((own.priceCents - comp.priceCents) / own.priceCents) * 100;
    if (diffPct >= 5) {
      out.push({
        entityRef: own.entityRef,
        marketplace: null,
        pillar: "concorrência",
        bottleneck: "Concorrente direto com preço menor",
        hypothesis: "Sem diferenciação visível (kit, frete, garantia), o comprador escolhe o mais barato.",
        evidence: `${comp.title ?? "concorrente"} a ${brl(comp.priceCents)} contra ${brl(own.priceCents)} — ${diffPct.toFixed(1)}% abaixo`,
        impactCents: Math.round((diffPct / 100) * own.priceCents),
        impactPct: -diffPct,
        effort: 4,
        urgency: 3,
        risk: "Baixar preço sem checar margem destrói lucro; preferir diferenciação.",
      });
    }
  }

  // Ordena pelo impacto e devolve no máximo 5: missão é o que cabe no dia.
  return out.sort((a, b) => (b.impactCents ?? 0) - (a.impactCents ?? 0)).slice(0, 5);
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
