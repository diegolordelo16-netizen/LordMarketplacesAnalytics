/**
 * Captura de PEDIDOS — Mercado Livre e Shopee.
 *
 * Um pedido é o dado que fecha o ciclo: sem ele, o estoque é um número solto e
 * a recomendação de reposição é palpite. Com ele, dá para cruzar venda real
 * com estoque e com preço praticado.
 *
 * Regras (as mesmas de sempre):
 *  - lê o que a página já exibiu, nada de endpoint privado;
 *  - pedido sem valor legível vira UNKNOWN, nunca zero;
 *  - pedido sem id é contado, não descartado em silêncio;
 *  - data de referência é a da coleta, não a do pedido (essa vai como métrica).
 */
import type { ObservationInput } from "../database/collection-repository.js";

export const ORDERS_ADAPTER_VERSION = "0.1.0";

export interface CapturedOrder {
  externalRef: string;
  observations: ObservationInput[];
}

export interface OrdersCaptureResult {
  orders: CapturedOrder[];
  rowsSeen: number;
  rowsParsed: number;
  rowsWithoutId: number;
}

/** Valor monetário brasileiro em centavos; null quando não há número. */
export function parseMoneyToCents(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,]/g, "").trim();
  if (!cleaned) return null;
  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Data no formato dd/mm/aaaa ou aaaa-mm-dd → ISO (meia-noite UTC). Null se inválida. */
export function parseBrazilianDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const br = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) {
    const [, d, m, y] = br;
    const iso = `${y}-${m}-${d}T00:00:00.000Z`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const iso = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00.000Z`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  return null;
}

function textOf(el: Element | null): string | null {
  const v = el?.textContent?.trim();
  return v ? v : null;
}

function obs(
  orderRef: string,
  metric: string,
  raw: string | null,
  parse: (v: string) => number | string | null,
  unit: string | null,
): ObservationInput {
  if (raw === null) {
    return { entityType: "order", entityRef: orderRef, metric, valueRaw: null, valueNum: null, unit, quality: "NOT_COLLECTED" };
  }
  const parsed = parse(raw);
  if (parsed === null) {
    return { entityType: "order", entityRef: orderRef, metric, valueRaw: raw, valueNum: null, unit, quality: "UNKNOWN" };
  }
  return {
    entityType: "order",
    entityRef: orderRef,
    metric,
    valueRaw: raw,
    valueNum: typeof parsed === "number" ? parsed : null,
    unit,
    quality: "VERIFIED",
  };
}

/**
 * Id do pedido: sequência longa de dígitos (ML: 2000012345678901, Shopee: 240101ABCDEF).
 * Aceita letras maiúsculas no caso da Shopee, exige ao menos 8 caracteres.
 */
export function extractOrderRef(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\b(\d{10,20}|[0-9A-Z]{10,20})\b/);
  return match ? match[1] : null;
}

/**
 * Lê a lista de pedidos. Ancoragem: linhas de tabela que contenham um id de
 * pedido e algum valor em R$. O parser é o mesmo para os dois marketplaces
 * porque a estrutura de tabela é equivalente — o que muda é o rótulo.
 */
export function parseOrderList(doc: Document, marketplace: string): OrdersCaptureResult {
  const rows = Array.from(doc.querySelectorAll("tr, [class*='order-item'], [class*='order-card'], li"));
  const orders: CapturedOrder[] = [];
  const seen = new Set<string>();
  let rowsWithoutId = 0;
  let rowsWithMoney = 0;

  for (const row of rows) {
    const text = row.textContent ?? "";
    if (!/R\$\s*\d/.test(text)) continue; // linha sem valor não é pedido
    rowsWithMoney += 1;

    const ref = extractOrderRef(text);
    if (!ref || seen.has(ref)) {
      if (!ref) rowsWithoutId += 1;
      continue;
    }
    seen.add(ref);

    const cells = Array.from(row.querySelectorAll("td, span, div"))
      .map((el) => textOf(el))
      .filter((v): v is string => v !== null);

    const totalText = cells.find((c) => /R\$\s*\d/.test(c)) ?? null;
    const dateText = cells.find((c) => /\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}/.test(c)) ?? null;
    const statusText =
      cells.find((c) =>
        /(enviado|entregue|a enviar|pendente|processando|cancelado|em trânsito|shipped|delivered|pending|cancelled)/i.test(c),
      ) ?? null;

    orders.push({
      externalRef: ref,
      observations: [
        obs(ref, "order_total_cents", totalText, (v) => parseMoneyToCents(v), "centavos"),
        obs(ref, "order_date", dateText, (v) => parseBrazilianDate(v), null),
        obs(ref, "order_status", statusText, (v) => v, null),
        obs(ref, "order_marketplace", marketplace, (v) => v, null),
      ],
    });
  }

  return {
    orders,
    rowsSeen: rowsWithMoney,
    rowsParsed: orders.length,
    rowsWithoutId,
  };
}
