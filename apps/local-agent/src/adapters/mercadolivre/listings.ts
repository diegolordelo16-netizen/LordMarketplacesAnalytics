/**
 * Captura de anúncios na lista do Mercado Livre — leitura do DOM.
 *
 * Regras que este adapter respeita:
 *  - lê só o que a página já exibiu; nada de endpoint privado, nada de replay;
 *  - campo ausente NÃO vira zero nem string vazia: vira NOT_COLLECTED;
 *  - valor ilegível (preço que não é número) vira UNKNOWN, com o texto bruto
 *    preservado em valueRaw para conferência;
 *  - devolve dados crus + proveniência; a gravação é do repositório.
 *
 * O parser recebe o documento como parâmetro para poder ser testado com
 * fixtures reais sem navegador.
 */
import type { ObservationInput } from "../database/collection-repository.js";

export const ADAPTER_VERSION = "0.1.0";
export const METHOD = "adapter.mercadolivre.listing-list.dom-v1";

export interface CapturedListing {
  externalRef: string;
  title: string | null;
  observations: ObservationInput[];
}

export interface CaptureResult {
  pageKind: "listing-list";
  listings: CapturedListing[];
  /** Quantos cards a página tinha e quantos foram lidos com sucesso. */
  cardsSeen: number;
  cardsParsed: number;
}

/**
 * Converte preço no formato brasileiro ("R$ 1.234,56") em centavos inteiros.
 * Devolve null quando não é um preço legível — nunca 0 por falta de dado.
 */
export function parsePriceToCents(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,]/g, "").trim();
  if (!cleaned) return null;
  // Formato BR: ponto é milhar, vírgula é decimal.
  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Extrai o id do anúncio de um href do Mercado Livre (MLB123456). */
export function extractListingId(href: string | null | undefined): string | null {
  if (!href) return null;
  const match = href.match(/(MLB-?\d{6,})/i);
  return match ? match[1].replace("-", "").toUpperCase() : null;
}

function textOf(el: Element | null): string | null {
  const value = el?.textContent?.trim();
  return value ? value : null;
}

/** Métrica com valor legível → VERIFIED; ilegível → UNKNOWN; ausente → NOT_COLLECTED. */
function metric(
  name: string,
  raw: string | null,
  parse: (v: string) => number | null,
  unit: string | null,
): ObservationInput {
  if (raw === null) {
    return { entityType: "listing", entityRef: "", metric: name, valueRaw: null, valueNum: null, unit, quality: "NOT_COLLECTED" };
  }
  const parsed = parse(raw);
  if (parsed === null) {
    return { entityType: "listing", entityRef: "", metric: name, valueRaw: raw, valueNum: null, unit, quality: "UNKNOWN" };
  }
  return { entityType: "listing", entityRef: "", metric: name, valueRaw: raw, valueNum: parsed, unit, quality: "VERIFIED" };
}

/**
 * Lê a lista de anúncios do painel do vendedor.
 *
 * Seletores: o Mercado Livre usa nomes de classe voláteis, então o adapter se
 * ancora em estrutura semântica (links com id MLB) e em rótulos de texto.
 * Se a estrutura mudar, o resultado é cardsSeen > 0 com cardsParsed = 0 —
 * falha visível, nunca captura parcial silenciosa.
 */
export function parseListingList(doc: Document): CaptureResult {
  const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((a) =>
    /MLB-?\d{6,}/i.test(a.getAttribute("href") ?? ""),
  );

  const byId = new Map<string, HTMLAnchorElement>();
  for (const link of links) {
    const id = extractListingId(link.getAttribute("href"));
    if (id && !byId.has(id)) byId.set(id, link);
  }

  const listings: CapturedListing[] = [];
  for (const [externalRef, link] of byId) {
    const card = link.closest("li, article, div") ?? link;
    const title = textOf(card.querySelector("h2, h3, .title, [class*='title']")) ?? textOf(link);

    const priceEl =
      card.querySelector("[class*='price']") ??
      Array.from(card.querySelectorAll("span")).find((s) => /R\$\s*\d/.test(s.textContent ?? "")) ??
      null;
    const stockEl =
      card.querySelector("[class*='stock']") ??
      Array.from(card.querySelectorAll("span")).find((s) => /unidade|estoque/i.test(s.textContent ?? "")) ??
      null;

    const observations: ObservationInput[] = [
      { ...metric("title", title, () => null, null), valueNum: null, quality: title ? "VERIFIED" : "NOT_COLLECTED" },
      metric("price_cents", textOf(priceEl), parsePriceToCents, "centavos"),
      metric(
        "stock",
        textOf(stockEl),
        (v) => {
          const n = Number(v.replace(/[^\d]/g, ""));
          return Number.isFinite(n) && v.match(/\d/) ? n : null;
        },
        "count",
      ),
    ].map((o) => ({ ...o, entityRef: externalRef }));

    listings.push({ externalRef, title, observations });
  }

  return {
    pageKind: "listing-list",
    listings,
    cardsSeen: links.length,
    cardsParsed: listings.length,
  };
}
