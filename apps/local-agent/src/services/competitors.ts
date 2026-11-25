/**
 * Monitoramento de concorrentes por link.
 *
 * Como funciona, e por que assim:
 *  1. O usuário cola o link de um anúncio concorrente.
 *  2. O serviço identifica o marketplace PELO LINK (sem chamar nada) e devolve
 *     o que ele sabe que o link é: marketplace, referência do anúncio, tipo.
 *  3. Para trazer os dados, o próprio navegador do usuário abre aquele link na
 *     sessão dele e manda o HTML capturado. O serviço só lê o que a página
 *     mostra — não existe chamada a endpoint privado, nem cookie, nem token.
 *  4. Cada leitura vira um SNAPSHOT datado. Nada sobrescreve: o histórico é
 *     justamente o produto.
 *
 * Honestidade de dado: campo que não foi legível fica NULL (nunca zero), e o
 * snapshot guarda a qualidade. A comparação com o próprio anúncio só acontece
 * quando existe vínculo — e vínculo sugerido por nome nunca é automático.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseMoneyToCents } from "../adapters/orders.js";

export type CompetitorStatus = "MONITORING" | "PAUSED" | "DELETED";
export type LinkConfidence = "EXATA" | "ALTA" | "PROVAVEL" | "MANUAL";

export interface ParsedLink {
  marketplace: string;
  externalRef: string;
  url: string;
  kind: "listing" | "product" | "unknown";
}

export interface CompetitorRow {
  id: string;
  marketplace: string;
  externalRef: string;
  url: string;
  title: string | null;
  seller: string | null;
  linkedEntityRef: string | null;
  linkConfidence: LinkConfidence | null;
  status: CompetitorStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  lastCollectedAt: string | null;
  snapshots: number;
  latest: SnapshotView | null;
  change: PriceChange | null;
}

export interface SnapshotView {
  id: string;
  collectedAt: string;
  priceCents: number | null;
  listPriceCents: number | null;
  soldCount: number | null;
  rating: number | null;
  reviewsCount: number | null;
  stockText: string | null;
  shippingText: string | null;
  position: number | null;
  quality: string;
  source: string;
  pageUrl: string;
}

export interface PriceChange {
  pricePct: number | null;
  soldDelta: number | null;
  ratingDelta: number | null;
  reviewsDelta: number | null;
  /** Primeira observação: não há comparação possível ainda. */
  firstObservation: boolean;
}

export interface CompetitorEvent {
  id: string;
  competitorId: string;
  kind: string;
  severity: "INFO" | "ATTENTION" | "CRITICAL";
  summary: string;
  evidence: string;
  detectedAt: string;
}

export class CompetitorValidationError extends Error {
  readonly code = "VALIDATION_FAILED";
}

// ------------------------------------------------------------------ links

const ML_HOSTS = ["mercadolivre.com.br", "mercadolivre.com", "mercadolibre.com"];
const SHOPEE_HOSTS = ["shopee.com.br"];

/**
 * Marketplaces que o usuário pode monitorar.
 *
 * `readable` diz a verdade sobre esta versão: só Mercado Livre e Shopee têm
 * leitura de página testada. Nos outros o cadastro funciona, o link fica
 * guardado e o snapshot é registrado como NOT_COLLECTED — nunca com número
 * inventado. Fingir que lê seria pior do que dizer que ainda não lê.
 */
export const MONITORED_PLATFORMS: { id: string; label: string; hosts: string[]; readable: boolean }[] = [
  { id: "mercadolivre", label: "Mercado Livre", hosts: ["mercadolivre.com.br", "mercadolivre.com", "mercadolibre.com"], readable: true },
  { id: "shopee", label: "Shopee", hosts: ["shopee.com.br"], readable: true },
  { id: "tiktokshop", label: "TikTok Shop", hosts: ["shop.tiktok.com", "tiktok.com"], readable: false },
  { id: "temu", label: "Temu", hosts: ["temu.com"], readable: false },
  { id: "shein", label: "Shein", hosts: ["shein.com", "shein.com.br"], readable: false },
  { id: "netshoes", label: "Netshoes", hosts: ["netshoes.com.br"], readable: false },
  { id: "amazon", label: "Amazon", hosts: ["amazon.com.br", "amazon.com"], readable: false },
];

export function platformById(id: string): { id: string; label: string; readable: boolean } | null {
  const found = MONITORED_PLATFORMS.find((p) => p.id === id);
  return found ? { id: found.id, label: found.label, readable: found.readable } : null;
}

/** Marketplace dono do host do link, se for um dos que monitoramos. */
function platformByHost(host: string): { id: string; label: string; readable: boolean } | null {
  const found = MONITORED_PLATFORMS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  return found ? { id: found.id, label: found.label, readable: found.readable } : null;
}

/**
 * Identifica marketplace e referência a partir do link colado.
 *
 * Reconhece os formatos que o usuário realmente copia do navegador, inclusive
 * os com parâmetro de rastreio e os links curtos de compartilhamento.
 */
export function parseListingLink(rawUrl: string): ParsedLink {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) throw new CompetitorValidationError("cole o link do anúncio");
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new CompetitorValidationError("isso não parece um link válido");
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname;

  // Mercado Livre: /MLB-1234567890-... , /p/MLB123456 , /anuncios/MLB123
  if (ML_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    const direct = path.match(/\b(ML[A-Z]-?\d{6,})/i);
    const product = path.match(/\/p\/(ML[A-Z]\d{6,})/i);
    const ref = (product?.[1] ?? direct?.[1] ?? "").toUpperCase().replace("-", "");
    if (!ref) throw new CompetitorValidationError("não encontrei o código do anúncio neste link do Mercado Livre");
    return { marketplace: "mercadolivre", externalRef: ref, url: url.toString(), kind: "listing" };
  }

  // Shopee: /product/123456/987654321 e /{shop}/{item}
  if (SHOPEE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    const prod = path.match(/-i\.(\d+)\.(\d+)/);
    const classic = path.match(/\/product\/(\d+)\/(\d+)/);
    const shop = prod?.[1] ?? classic?.[1];
    const item = prod?.[2] ?? classic?.[2];
    if (!shop || !item) throw new CompetitorValidationError("não encontrei os códigos do produto neste link da Shopee");
    return { marketplace: "shopee", externalRef: `${shop}:${item}`, url: url.toString(), kind: "product" };
  }

  // Plataformas monitoradas sem leitor próprio: o link é guardado com o id
  // estável do marketplace e a referência que o próprio link traz.
  const platform = platformByHost(host);
  if (platform) {
    const ref =
      url.searchParams.get("id") ??
      url.searchParams.get("item_id") ??
      path.match(/\/(?:dp|product|p|item)\/([A-Za-z0-9_-]{5,})/)?.[1] ??
      `${host}${path}`;
    return { marketplace: platform.id, externalRef: ref, url: url.toString(), kind: "unknown" };
  }

  // Fora da lista: guarda o link, mas diz honestamente que não sabe ler.
  return {
    marketplace: host.split(".").slice(-2).join("."),
    externalRef: `${host}${path}`,
    url: url.toString(),
    kind: "unknown",
  };
}

/** Cadastro sem link (a plataforma escolhida na tela). */
export function parseManualRef(marketplace: string, ref: string): ParsedLink {
  const platform = platformById(marketplace);
  if (!platform) throw new CompetitorValidationError("escolha uma plataforma da lista");
  const clean = (ref ?? "").trim();
  if (clean.length < 2) throw new CompetitorValidationError("informe o código ou o link do anúncio");
  if (/^https?:\/\//i.test(clean) || clean.includes(".")) return parseListingLink(clean);
  return { marketplace: platform.id, externalRef: clean, url: "", kind: "unknown" };
}

// ------------------------------------------------------------- leitura de página

/**
 * Lê do HTML o que a página mostra. Cada campo é opcional: o que não aparece
 * fica NULL, e é assim que o painel sabe que não leu.
 *
 * Isto é leitura de tela, não API: os seletores mudam quando o marketplace
 * muda o layout, e o snapshot registra a qualidade para o painel avisar.
 */
export function parseListingPage(html: string): {
  title: string | null;
  seller: string | null;
  priceCents: number | null;
  listPriceCents: number | null;
  soldCount: number | null;
  rating: number | null;
  reviewsCount: number | null;
  stockText: string | null;
  shippingText: string | null;
  quality: "VERIFIED" | "UNKNOWN" | "NOT_COLLECTED";
} {
  const text = (re: RegExp): string | null => {
    const m = html.match(re);
    return m?.[1] ? m[1].replace(/\s+/g, " ").trim() : null;
  };

  const title =
    text(/<h1[^>]*>([\s\S]{3,200}?)<\/h1>/i) ??
    text(/<title>([^<]{3,200})<\/title>/i);

  // Preço: prefere o bloco de preço da PDP; cai para o primeiro R$ da página.
  const priceBlock =
    text(/andes-money-amount__fraction[^>]*>([\d.]+)</i) ??
    text(/class="[^"]*price[^"]*"[^>]*>\s*R\$\s*([\d.,]+)/i) ??
    text(/R\$\s*([\d.]+,\d{2})/);
  const priceCents = priceBlock ? parseMoneyToCents(`R$ ${priceBlock}`) : null;

  const listBlock = text(/andes-money-amount--previous[\s\S]{0,200}?__fraction[^>]*>([\d.]+)</i);
  const listPriceCents = listBlock ? parseMoneyToCents(`R$ ${listBlock}`) : null;

  // Vendas: "1.234 vendidos" / "+100 vendidos" / "mil vendidos"
  const soldRaw = text(/([\d.]+)\s*(?:mil\s*)?vendidos/i);
  let soldCount: number | null = null;
  if (soldRaw) {
    const mil = /mil\s*vendidos/i.test(html);
    const n = Number(soldRaw.replace(/\./g, ""));
    soldCount = Number.isFinite(n) ? (mil ? n * 1000 : n) : null;
  }

  const ratingRaw = text(/(\d[.,]\d)\s*(?:de\s*5|estrelas)/i) ?? text(/"ratingValue"\s*:\s*([\d.]+)/i);
  const rating = ratingRaw ? Number(ratingRaw.replace(",", ".")) : null;

  const reviewsRaw = text(/\(([\d.]+)\s*avaliaç(?:ão|ões)\)/i) ?? text(/([\d.]+)\s*avaliaç(?:ão|ões)/i);
  const reviewsCount = reviewsRaw ? Number(reviewsRaw.replace(/\./g, "")) : null;

  const stockText = text(/(últim[oa]s?\s*\d+\s*(?:unidades?|disponíveis?)|estoque\s*:?\s*\d+|\b\d+\s*disponíveis?\b|sem estoque|esgotado)/i);
  const shippingText = text(/(chega\s*(?:grátis|amanhã|em)[^<.]{0,60}|frete\s*grátis|full\b|envio\s*rápido)/i);
  const seller = text(/vendedor[^<]{0,40}<[^>]*>([^<]{2,60})</i) ?? text(/"sellerName"\s*:\s*"([^"]{2,60})"/i);

  const anything = priceCents !== null || title !== null || soldCount !== null;
  const quality = anything ? "VERIFIED" : "NOT_COLLECTED";

  return { title, seller, priceCents, listPriceCents, soldCount, rating, reviewsCount, stockText, shippingText, quality };
}

// ------------------------------------------------------------------ serviço

export class CompetitorService {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now?: () => Date) {
    this.db = db;
    this.now = now ?? (() => new Date());
  }

  /** Cadastra a partir do link. Idempotente: o mesmo link não duplica. */
  add(
    url: string,
    options: {
      notes?: string | null;
      linkedEntityRef?: string | null;
      title?: string | null;
      /** Já interpretado pela tela (plataforma escolhida + código). */
      parsed?: ParsedLink;
    } = {},
  ): CompetitorRow {
    const parsed = options.parsed ?? parseListingLink(url);
    const now = this.now().toISOString();
    const existing = this.db
      .prepare(`SELECT id FROM competitors WHERE marketplace = ? AND external_ref = ?`)
      .get(parsed.marketplace, parsed.externalRef) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE competitors SET url = ?, status = 'MONITORING', updated_at = ?,
             notes = COALESCE(?, notes), linked_entity_ref = COALESCE(?, linked_entity_ref),
             link_confidence = CASE WHEN ? IS NULL THEN link_confidence ELSE 'MANUAL' END
           WHERE id = ?`,
        )
        .run(parsed.url, now, options.notes ?? null, options.linkedEntityRef ?? null, options.linkedEntityRef ?? null, existing.id);
      return this.get(existing.id) as CompetitorRow;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO competitors
           (id, marketplace, external_ref, url, title, seller, linked_entity_ref, link_confidence,
            status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'MONITORING', ?, ?, ?)`,
      )
      .run(
        id,
        parsed.marketplace,
        parsed.externalRef,
        parsed.url,
        options.title ?? null,
        options.linkedEntityRef ?? null,
        options.linkedEntityRef ? "MANUAL" : null,
        options.notes ?? null,
        now,
        now,
      );
    return this.get(id) as CompetitorRow;
  }

  list(filter: { status?: CompetitorStatus; marketplace?: string } = {}): CompetitorRow[] {
    const where: string[] = ["status != 'DELETED'"];
    const params: string[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.marketplace) {
      where.push("marketplace = ?");
      params.push(filter.marketplace);
    }
    const rows = this.db
      .prepare(`SELECT id FROM competitors WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`)
      .all(...params) as { id: string }[];
    return rows.map((r) => this.get(r.id)).filter((r): r is CompetitorRow => r !== null);
  }

  get(id: string): CompetitorRow | null {
    const row = this.db.prepare(`SELECT * FROM competitors WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const snaps = this.snapshots(id, 2);
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM competitor_snapshots WHERE competitor_id = ?`)
      .get(id) as { n: number };
    return {
      id: String(row.id),
      marketplace: String(row.marketplace),
      externalRef: String(row.external_ref),
      url: String(row.url),
      title: row.title === null ? null : String(row.title),
      seller: row.seller === null ? null : String(row.seller),
      linkedEntityRef: row.linked_entity_ref === null ? null : String(row.linked_entity_ref),
      linkConfidence: (row.link_confidence as LinkConfidence | null) ?? null,
      status: String(row.status) as CompetitorStatus,
      notes: row.notes === null ? null : String(row.notes),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastCollectedAt: row.last_collected_at === null ? null : String(row.last_collected_at),
      snapshots: total.n,
      latest: snaps[0] ?? null,
      change: compareSnapshots(snaps[0], snaps[1]),
    };
  }

  snapshots(competitorId: string, limit = 90): SnapshotView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM competitor_snapshots WHERE competitor_id = ? ORDER BY collected_at DESC LIMIT ?`,
      )
      .all(competitorId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      collectedAt: String(r.collected_at),
      priceCents: r.price_cents === null ? null : Number(r.price_cents),
      listPriceCents: r.list_price_cents === null ? null : Number(r.list_price_cents),
      soldCount: r.sold_count === null ? null : Number(r.sold_count),
      rating: r.rating === null ? null : Number(r.rating),
      reviewsCount: r.reviews_count === null ? null : Number(r.reviews_count),
      stockText: r.stock_text === null ? null : String(r.stock_text),
      shippingText: r.shipping_text === null ? null : String(r.shipping_text),
      position: r.position === null ? null : Number(r.position),
      quality: String(r.quality),
      source: String(r.source),
      pageUrl: String(r.page_url),
    }));
  }

  /**
   * Grava uma coleta. `html` vem do navegador do usuário, já autenticado.
   * Sem HTML não há coleta: não existe "coletar por conta própria" aqui.
   */
  recordSnapshot(competitorId: string, input: { html: string; pageUrl: string; method?: string }): {
    snapshot: SnapshotView;
    events: CompetitorEvent[];
  } {
    const comp = this.get(competitorId);
    if (!comp) throw new CompetitorValidationError("concorrente não encontrado");
    const parsed = parseListingPage(input.html);
    const now = this.now().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO competitor_snapshots
           (id, competitor_id, collected_at, price_cents, list_price_cents, sold_count, rating,
            reviews_count, stock_text, shipping_text, position, title, description_len, quality,
            source, page_url, method, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'UI_CAPTURE', ?, ?, '{}')`,
      )
      .run(
        id,
        competitorId,
        now,
        parsed.priceCents,
        parsed.listPriceCents,
        parsed.soldCount,
        parsed.rating,
        parsed.reviewsCount,
        parsed.stockText,
        parsed.shippingText,
        parsed.title,
        parsed.quality,
        input.pageUrl,
        input.method ?? "dom",
      );

    this.db
      .prepare(
        `UPDATE competitors SET last_collected_at = ?, updated_at = ?,
           title = COALESCE(?, title), seller = COALESCE(?, seller)
         WHERE id = ?`,
      )
      .run(now, now, parsed.title, parsed.seller, competitorId);

    const snaps = this.snapshots(competitorId, 2);
    const events = this.detectEvents(competitorId, snaps[0], snaps[1]);
    return { snapshot: snaps[0], events };
  }

  /** Eventos: só o que os números sustentam, com a evidência ao lado. */
  private detectEvents(competitorId: string, latest?: SnapshotView, previous?: SnapshotView): CompetitorEvent[] {
    if (!latest || !previous) return [];
    const found: { kind: string; severity: "INFO" | "ATTENTION" | "CRITICAL"; summary: string; evidence: string }[] = [];

    if (latest.priceCents !== null && previous.priceCents !== null && previous.priceCents > 0) {
      const pct = ((latest.priceCents - previous.priceCents) / previous.priceCents) * 100;
      if (Math.abs(pct) >= 3) {
        found.push({
          kind: pct < 0 ? "PRICE_DROP" : "PRICE_RISE",
          severity: Math.abs(pct) >= 10 ? "CRITICAL" : "ATTENTION",
          summary: `Concorrente ${pct < 0 ? "baixou" : "subiu"} o preço em ${Math.abs(pct).toFixed(1)}%`,
          evidence: `de ${fmt(previous.priceCents)} para ${fmt(latest.priceCents)}`,
        });
      }
    }

    if (latest.soldCount !== null && previous.soldCount !== null) {
      const delta = latest.soldCount - previous.soldCount;
      if (delta >= 10) {
        found.push({
          kind: "SALES_UP",
          severity: "ATTENTION",
          summary: `Concorrente vendeu +${delta} unidades entre as duas leituras`,
          evidence: `de ${previous.soldCount} para ${latest.soldCount} vendidos`,
        });
      }
    }

    if (latest.stockText && /esgotado|sem estoque/i.test(latest.stockText) && !/esgotado|sem estoque/i.test(previous.stockText ?? "")) {
      found.push({
        kind: "OUT_OF_STOCK",
        severity: "ATTENTION",
        summary: "Concorrente ficou sem estoque",
        evidence: `estoque: ${latest.stockText}`,
      });
    }

    const now = this.now().toISOString();
    const out: CompetitorEvent[] = [];
    for (const e of found) {
      const eventId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO competitor_events (id, competitor_id, kind, severity, summary, evidence, detected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(eventId, competitorId, e.kind, e.severity, e.summary, e.evidence, now);
      out.push({ id: eventId, competitorId, ...e, detectedAt: now });
    }
    return out;
  }

  events(limit = 40): CompetitorEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM competitor_events ORDER BY detected_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      competitorId: String(r.competitor_id),
      kind: String(r.kind),
      severity: String(r.severity) as CompetitorEvent["severity"],
      summary: String(r.summary),
      evidence: String(r.evidence),
      detectedAt: String(r.detected_at),
    }));
  }

  setStatus(id: string, status: CompetitorStatus): boolean {
    const r = this.db
      .prepare(`UPDATE competitors SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, this.now().toISOString(), id);
    return Number(r.changes) > 0;
  }

  link(id: string, entityRef: string | null): boolean {
    const r = this.db
      .prepare(
        `UPDATE competitors SET linked_entity_ref = ?, link_confidence = ?, updated_at = ? WHERE id = ?`,
      )
      .run(entityRef, entityRef ? "MANUAL" : null, this.now().toISOString(), id);
    return Number(r.changes) > 0;
  }
}

// ------------------------------------------------------------------ comparação

function fmt(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function compareSnapshots(latest?: SnapshotView, previous?: SnapshotView): PriceChange | null {
  if (!latest) return null;
  if (!previous) {
    return { pricePct: null, soldDelta: null, ratingDelta: null, reviewsDelta: null, firstObservation: true };
  }
  const pct =
    latest.priceCents !== null && previous.priceCents !== null && previous.priceCents > 0
      ? ((latest.priceCents - previous.priceCents) / previous.priceCents) * 100
      : null;
  return {
    pricePct: pct,
    soldDelta:
      latest.soldCount !== null && previous.soldCount !== null ? latest.soldCount - previous.soldCount : null,
    ratingDelta:
      latest.rating !== null && previous.rating !== null
        ? Number((latest.rating - previous.rating).toFixed(2))
        : null,
    reviewsDelta:
      latest.reviewsCount !== null && previous.reviewsCount !== null
        ? latest.reviewsCount - previous.reviewsCount
        : null,
    firstObservation: false,
  };
}
