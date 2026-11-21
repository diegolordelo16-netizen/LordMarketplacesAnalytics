/**
 * Reconhecimento de página e de conta, por marketplace.
 *
 * Regra de integridade: este módulo NUNCA adivinha. Se não reconhece, devolve
 * "unknown" com o motivo — o painel mostra ausência, não um valor inventado.
 * Toda leitura vem do que a página já exibiu; nada de endpoint privado.
 */

export type Marketplace = "mercadolivre" | "shopee" | "unknown";

export type PageKind =
  | "dashboard"
  | "listing-list"
  | "listing-detail"
  | "listing-edit"
  | "inventory"
  | "ads"
  | "orders"
  | "public-search"
  | "public-listing"
  | "login"
  | "unknown";

export interface PageContext {
  url: string;
  title: string;
  marketplace: Marketplace;
  pageKind: PageKind;
  /** Nome da loja/conta quando legível na página; null quando não legível. */
  account: string | null;
  /** Por que account é null — para o painel não fingir que identificou. */
  accountSource: "page-header" | "url-slug" | "not-readable";
  confidence: "high" | "medium" | "low";
  detectedAt: string;
}

const ML_HOSTS = /(^|\.)mercadolivre\.com(\.br)?$/i;
const SHOPEE_HOSTS = /(^|\.)shopee\.com\.br$/i;

export function detectMarketplace(url: string): Marketplace {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "unknown";
  }
  if (ML_HOSTS.test(host)) return "mercadolivre";
  if (SHOPEE_HOSTS.test(host)) return "shopee";
  return "unknown";
}

/**
 * Classifica a página. Ordem importa: login antes de dashboard, público antes
 * de listagem do vendedor.
 */
export function detectPageKind(url: string, marketplace: Marketplace): PageKind {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return "unknown";
  }

  if (/\/login|\/jms\/login|\/signin/.test(path)) return "login";

  if (marketplace === "mercadolivre") {
    if (/^\/vendas/.test(path)) return "listing-list";
    if (/^\/anuncios|\/listing/.test(path)) return "listing-detail";
    if (/^\/estoque|\/inventory/.test(path)) return "inventory";
    if (/^\/publicidade|\/product-ads|\/ads/.test(path)) return "ads";
    if (/^\/vendas\/pedidos|^\/pedidos/.test(path)) return "orders";
    if (/^\/perfil|\/dashboard|^\/$/.test(path)) return "dashboard";
    if (/^\/jm\/|\/mlb-|^\/p\//.test(path)) return "public-listing";
    if (/^\/lista|\/busca|\/search/.test(path)) return "public-search";
  }

  if (marketplace === "shopee") {
    // Lista de produtos do Seller Centre: /portal/product/list, /portal/product,
    // e também /portal/product/{shopid}/{itemid} é edição, não lista.
    if (/^\/portal\/product\/list/.test(path)) return "listing-list";
    if (/^\/portal\/product\/\d+\/\d+/.test(path)) return "listing-edit";
    if (/^\/portal\/(product|product-list)\/?$/.test(path)) return "listing-list";
    if (/^\/portal\/product\/edit/.test(path)) return "listing-edit";
    if (/^\/portal\/(stock|inventory)/.test(path)) return "inventory";
    if (/^\/portal\/marketing|\/ads/.test(path)) return "ads";
    if (/^\/portal\/order/.test(path)) return "orders";
    if (/^\/portal/.test(path)) return "dashboard";
    if (/^\/product\/|\/i\./.test(path)) return "public-listing";
    if (/^\/search/.test(path)) return "public-search";
  }

  return "unknown";
}

/**
 * Identifica a conta/loja. Preferência: cabeçalho do painel do vendedor
 * (fonte confiável) → slug na URL (fonte média) → não legível.
 */
export function detectAccount(
  url: string,
  marketplace: Marketplace,
  pageText: string,
): { account: string | null; source: PageContext["accountSource"] } {
  // 1. Cabeçalho do painel: linhas curtas logo após "Vender"/"Minha conta".
  const headerMatch = pageText.match(
    /(?:minha conta|vender|minha loja|seller center|central do vendedor)\s*\n+\s*([\p{L}0-9][\p{L}0-9 .,&'-]{2,40})/iu,
  );
  if (headerMatch) {
    return { account: headerMatch[1].trim(), source: "page-header" };
  }

  // 2. Slug de loja na URL pública do Mercado Livre: /perfil/<slug> ou loja.
  try {
    const u = new URL(url);
    const perfil = u.pathname.match(/\/perfil\/([^/?#]+)/i);
    if (perfil) return { account: perfil[1], source: "url-slug" };
    if (marketplace === "shopee") {
      const shop = u.searchParams.get("shopid") ?? u.searchParams.get("shop_id");
      if (shop) return { account: `shop:${shop}`, source: "url-slug" };
    }
  } catch {
    /* URL inválida já foi tratada em detectMarketplace */
  }

  return { account: null, source: "not-readable" };
}

export function detectPage(url: string, title: string, pageText: string): PageContext {
  const marketplace = detectMarketplace(url);
  const pageKind = detectPageKind(url, marketplace);
  const { account, source } = detectAccount(url, marketplace, pageText);

  let confidence: PageContext["confidence"] = "low";
  if (marketplace !== "unknown" && pageKind !== "unknown") confidence = "high";
  else if (marketplace !== "unknown") confidence = "medium";

  return {
    url,
    title,
    marketplace,
    pageKind,
    account,
    accountSource: source,
    confidence,
    detectedAt: new Date().toISOString(),
  };
}

/** Nome legível para a interface. */
export const MARKETPLACE_LABEL: Record<Marketplace, string> = {
  mercadolivre: "Mercado Livre",
  shopee: "Shopee",
  unknown: "Não reconhecido",
};

export const PAGE_KIND_LABEL: Record<PageKind, string> = {
  dashboard: "Painel do vendedor",
  "listing-list": "Lista de anúncios",
  "listing-detail": "Detalhe de anúncio",
  "listing-edit": "Edição de anúncio",
  inventory: "Estoque",
  ads: "Publicidade",
  orders: "Pedidos",
  "public-search": "Busca pública",
  "public-listing": "Anúncio público",
  login: "Página de login",
  unknown: "Não reconhecida",
};
