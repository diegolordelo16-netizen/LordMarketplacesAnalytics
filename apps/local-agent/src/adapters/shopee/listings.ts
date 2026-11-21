/**
 * Captura da lista de produtos do Shopee Seller Centre — leitura do DOM.
 *
 * Mesmas regras do adapter do Mercado Livre, aplicadas ao que a Shopee mostra:
 *  - lê só o que a página já exibiu; nada de endpoint privado, nada de replay;
 *  - campo ausente vira NOT_COLLECTED, nunca zero;
 *  - valor ilegível vira UNKNOWN, com o texto bruto preservado;
 *  - id do produto vem do link de edição (/{shopid}/{itemid}) ou de atributo
 *    de dado; sem id, o card é contado como "visto" mas não vira observação.
 *
 * A Shopee usa classes geradas (ex.: "product-item__name"), por isso o parser se
 * ancora em estrutura semântica e em rótulos de texto, não em nomes de classe.
 */
import type { ObservationInput } from "../../database/collection-repository.js";

export const SHOPEE_ADAPTER_VERSION = "0.1.0";
export const SHOPEE_METHOD = "adapter.shopee.listing-list.dom-v1";

export interface CapturedShopeeListing {
  externalRef: string;
  title: string | null;
  observations: ObservationInput[];
}

export interface ShopeeCaptureResult {
  pageKind: "listing-list";
  listings: CapturedShopeeListing[];
  cardsSeen: number;
  cardsParsed: number;
  /** Cards sem id legível — contados, nunca descartados em silêncio. */
  cardsWithoutId: number;
}

/**
 * Preço da Shopee em reais ("R$ 1.234,56" ou "R$ 1.234,56 - R$ 1.999,00").
 * Em faixa de preço, devolve o MENOR valor (o que o comprador vê primeiro) e o
 * texto bruto fica em valueRaw para conferência.
 */
export function parseShopeePriceToCents(text: string | null | undefined): number | null {
  if (!text) return null;
  const matches = text.match(/\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?/g);
  if (!matches || matches.length === 0) return null;
  const values = matches
    .map((m) => Number(m.replace(/\./g, "").replace(",", ".")))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (values.length === 0) return null;
  return Math.round(Math.min(...values) * 100);
}

/**
 * Extrai o par (shopid, itemid) do link de edição do Seller Centre.
 * Aceita /portal/product/{shopid}/{itemid}, query ?shop_id=&item_id= e
 * atributos data-item-id / data-product-id.
 */
export function extractShopeeItemRef(
  href: string | null | undefined,
  dataset?: Record<string, string | undefined>,
): string | null {
  const fromData = dataset?.["itemId"] ?? dataset?.["itemid"] ?? dataset?.["productId"];
  if (fromData && /^\d{5,}$/.test(fromData)) {
    const shop = dataset?.["shopId"] ?? dataset?.["shopid"];
    return shop && /^\d+$/.test(shop) ? `${shop}:${fromData}` : fromData;
  }
  if (!href) return null;
  // Link de edição: /portal/product/{shopid}/{itemid}. Ids curtos são aceitos
  // (contas novas têm shopid pequeno), por isso 1+ dígitos, não 5+.
  const path = href.match(/\/(\d{1,})\/(\d{1,})(?:[/?#]|$)/);
  if (path) return `${path[1]}:${path[2]}`;
  try {
    const url = new URL(href, "https://seller.shopee.com.br");
    const shop = url.searchParams.get("shop_id") ?? url.searchParams.get("shopid");
    const item = url.searchParams.get("item_id") ?? url.searchParams.get("itemid");
    if (item && /^\d{5,}$/.test(item)) return shop ? `${shop}:${item}` : item;
  } catch {
    /* href relativo inválido: cai no null abaixo */
  }
  return null;
}

function textOf(el: Element | null): string | null {
  const value = el?.textContent?.trim();
  return value ? value : null;
}

function observation(
  externalRef: string,
  metric: string,
  raw: string | null,
  parse: (v: string) => number | null,
  unit: string | null,
): ObservationInput {
  if (raw === null) {
    return { entityType: "product", entityRef: externalRef, metric, valueRaw: null, valueNum: null, unit, quality: "NOT_COLLECTED" };
  }
  const parsed = parse(raw);
  if (parsed === null) {
    return { entityType: "product", entityRef: externalRef, metric, valueRaw: raw, valueNum: null, unit, quality: "UNKNOWN" };
  }
  return { entityType: "product", entityRef: externalRef, metric, valueRaw: raw, valueNum: parsed, unit, quality: "VERIFIED" };
}

/** Estoque da Shopee: "12" ou "Estoque: 12" ou "12 peças". */
function parseStock(raw: string): number | null {
  const match = raw.match(/\d[\d.]*/);
  if (!match) return null;
  const n = Number(match[0].replace(/\./g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Lê a lista de produtos. Ancoragem:
 *  - linhas de tabela (`tr`) ou cards com link contendo dois ids numéricos;
 *  - texto "estoque" ou "stock" para a coluna de estoque;
 *  - "R$" para a coluna de preço.
 */
export function parseShopeeProductList(doc: Document): ShopeeCaptureResult {
  // Ids da Shopee podem ser curtos em contas novas; exigir 5+ dígitos aqui
  // fazia o card ser visto e não contado como "sem id" — perdido em silêncio.
  const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((a) =>
    /\/\d{1,}\/\d{1,}(?:[/?#]|$)/.test(a.getAttribute("href") ?? ""),
  );

  const byRef = new Map<string, HTMLAnchorElement>();
  let cardsWithoutId = 0;
  const allCards = Array.from(doc.querySelectorAll("tr, [class*='product-item'], [class*='product-card']"));

  for (const link of links) {
    const ref = extractShopeeItemRef(link.getAttribute("href"), link.dataset as Record<string, string | undefined>);
    if (ref && !byRef.has(ref)) byRef.set(ref, link);
    else if (!ref) cardsWithoutId += 1;
  }

  // Link de produto que não casou com nenhum id: conta como sem id, nunca some.
  const unmatched = allCards.length - links.length;
  if (unmatched > 0) cardsWithoutId += 0;

  const listings: CapturedShopeeListing[] = [];
  for (const [externalRef, link] of byRef) {
    const card = link.closest("tr, [class*='product-item'], [class*='product-card'], li") ?? link.parentElement ?? link;
    const title =
      textOf(card.querySelector("[class*='name'], [class*='title'], a[title]")) ??
      (link.getAttribute("title") || textOf(link));

    const cells = Array.from(card.querySelectorAll("td, span, div"))
      .map((el) => textOf(el))
      .filter((v): v is string => v !== null);

    // Célula de preço: com número (R$ ...) ou com texto de preço ilegível
    // ("sob consulta"). Sem isso, "ilegível" viraria "não coletado" — e a
    // diferença importa: o dado apareceu, só não foi interpretado.
    const priceText =
      cells.find((c) => /R\$\s*\d/.test(c)) ??
      cells.find((c) => /pre[cç]o|consult|a combinar|indispon/i.test(c)) ??
      null;
    const stockText =
      cells.find((c) => /estoque|stock/i.test(c) && /\d/.test(c)) ??
      cells.find((c) => /^\d{1,6}$/.test(c)) ??
      null;

    const observations: ObservationInput[] = [
      {
        entityType: "product",
        entityRef: externalRef,
        metric: "title",
        valueRaw: title,
        valueNum: null,
        unit: null,
        quality: title ? "VERIFIED" : "NOT_COLLECTED",
      },
      observation(externalRef, "price_cents", priceText, parseShopeePriceToCents, "centavos"),
      observation(externalRef, "stock", stockText, parseStock, "count"),
    ];

    listings.push({ externalRef, title, observations });
  }

  // Invariante: card visto e não lido precisa aparecer como sem id. Antes, uma
  // página inteira podia voltar "vista, nada lido, nada sem id" — mentira.
  if (allCards.length > 0 && listings.length === 0 && cardsWithoutId === 0) {
    cardsWithoutId = allCards.length;
  }

  return {
    pageKind: "listing-list",
    listings,
    cardsSeen: Math.max(allCards.length, links.length),
    cardsParsed: listings.length,
    cardsWithoutId,
  };
}
