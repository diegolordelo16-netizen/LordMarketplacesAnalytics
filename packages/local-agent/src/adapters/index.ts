/**
 * Adapter interface + implementações Mercado Livre e Shopee (§5, §4).
 *
 * Regras invioláveis:
 *  - Somente leitura de DOM e observação passiva da navegação normal do usuário.
 *  - Nenhuma chamada a endpoint privado, nenhum replay de requisição, nenhum cookie/token.
 *  - Ao encontrar CAPTCHA/desafio: pausar e pedir intervenção humana.
 *  - Cada capacidade é declarada honestamente na matriz de compatibilidade.
 */
import type {
  AdapterCapability,
  AdapterDiagnostics,
  CapabilityMatrix,
  MarketplaceId,
  PageContext,
  PageKind,
  SelectorRecord,
  SessionProbe,
} from '@mi/shared';

export interface AdapterDefinition {
  id: MarketplaceId;
  label: string;
  version: string;
  domains: string[];
  capabilities: CapabilityMatrix;
  selectors: SelectorRecord[];
  /** Função pura de detecção de página a partir de URL + sinais de DOM. */
  detectPage(url: string, domSignals: string[]): PageContext | null;
  /** Função pura de detecção de sessão a partir de sinais observáveis. */
  detectSession(url: string, domSignals: string[]): SessionProbe;
  /** Diagnóstico de saúde dos seletores (detecta mudança de layout). */
  diagnose(observed: Record<string, number>): AdapterDiagnostics;
}

const CAP = (overrides: Partial<CapabilityMatrix> = {}): CapabilityMatrix => ({
  session_detection: 'SUPORTADO',
  account_detection: 'SUPORTADO',
  listing_capture: 'SUPORTADO',
  sales_capture: 'SUPORTADO',
  visits_capture: 'SUPORTADO',
  impressions_capture: 'SUPORTADO',
  ads_capture: 'SUPORTADO',
  questions_capture: 'SUPORTADO',
  reputation_capture: 'SUPORTADO',
  returns_capture: 'PARCIALMENTE_SUPORTADO',
  inventory_capture: 'SUPORTADO',
  search_results_capture: 'SUPORTADO',
  autocomplete_capture: 'PARCIALMENTE_SUPORTADO',
  competitor_observation: 'SUPORTADO',
  title_edit: 'SUPORTADO',
  description_edit: 'SUPORTADO',
  image_upload: 'SUPORTADO',
  price_edit: 'SUPORTADO',
  listing_duplicate: 'SUPORTADO',
  draft_mode: 'SUPORTADO',
  ...overrides,
});

function detectByUrl(url: string): PageKind | null {
  const u = url.toLowerCase();
  if (/(login|signin|entrar)/.test(u)) return 'login';
  if (/(captcha|challenge|desafio)/.test(u)) return 'challenge';
  if (/\/(p|produto|product)\//.test(u)) return 'product_detail';
  if (/(busca|search|listado|\/jm\/|search=)/.test(u)) return 'search_results';
  if (/(vendas|seller|painel|dashboard|central-vendedor)/.test(u)) {
    if (/(editar|edit)/.test(u)) return 'seller_listing_edit';
    if (/(anuncios|publicacoes|listings)/.test(u)) return 'seller_listings';
    if (/(pedidos|orders)/.test(u)) return 'seller_orders';
    if (/(publicidade|ads|product-ads)/.test(u)) return 'seller_ads';
    if (/(perguntas|questions)/.test(u)) return 'seller_questions';
    if (/(reputacao|reputation)/.test(u)) return 'seller_reputation';
    if (/(devolucoes|returns)/.test(u)) return 'seller_returns';
    if (/(estoque|inventory)/.test(u)) return 'seller_inventory';
    return 'seller_dashboard';
  }
  return null;
}

function diagnoseFrom(
  selectors: SelectorRecord[],
  observed: Record<string, number>,
  layoutVersion: string,
): AdapterDiagnostics {
  const selectorHealth = selectors.map((s) => {
    const matched = observed[s.key] ?? 0;
    const hitRate = s.hitRate ?? 1;
    return { key: s.key, ok: matched > 0, matched, hitRate };
  });
  const broken = selectorHealth.filter((s) => !s.ok);
  return {
    layoutVersion,
    selectorHealth,
    layoutChangedSuspected: broken.length >= Math.max(2, Math.ceil(selectors.length * 0.3)),
    messages:
      broken.length === 0
        ? ['todos os seletores resolveram elementos']
        : broken.map((b) => `seletor "${b.key}" não encontrou elemento — possível mudança de layout`),
  };
}

// ---------------------------------------------------------------- Mercado Livre
export const mercadoLivreAdapter: AdapterDefinition = {
  id: 'mercado_livre',
  label: 'Mercado Livre',
  version: '1.0.0',
  domains: ['mercadolivre.com.br', 'mercadolivre.com', 'mercadopago.com.br'],
  capabilities: CAP({
    returns_capture: 'PARCIALMENTE_SUPORTADO',
    autocomplete_capture: 'PARCIALMENTE_SUPORTADO',
    draft_mode: 'SUPORTADO',
  }),
  selectors: [
    { key: 'listing_title_input', selectors: ['input[name="title"]', 'input#title', '[data-testid="title-input"]'], layoutVersion: '2026-11', hitRate: 0.96 },
    { key: 'listing_description_editor', selectors: ['textarea[name="description"]', '.andes-textarea textarea', 'div[contenteditable="true"]'], layoutVersion: '2026-11', hitRate: 0.9 },
    { key: 'listing_price_input', selectors: ['input[name="price"]', 'input#price'], layoutVersion: '2026-11', hitRate: 0.95 },
    { key: 'listing_stock_input', selectors: ['input[name="available_quantity"]'], layoutVersion: '2026-11', hitRate: 0.94 },
    { key: 'seller_nickname', selectors: ['.nav-header-nickname', '[data-testid="user-nick"]'], layoutVersion: '2026-11', hitRate: 0.88 },
    { key: 'search_result_item', selectors: ['li.ui-search-layout__item', '.ui-search-result'], layoutVersion: '2026-11', hitRate: 0.92 },
    { key: 'autocomplete_suggestion', selectors: ['.andes-list__item', '[role="option"]'], layoutVersion: '2026-11', hitRate: 0.7 },
  ],
  detectPage(url, domSignals) {
    const kind = detectByUrl(url);
    if (!kind) return null;
    const itemMatch = /ML[A-Z]?-?\d{6,}/i.exec(url);
    return {
      marketplace: 'mercado_livre',
      kind,
      url,
      itemId: itemMatch?.[0],
      detectedAt: new Date().toISOString(),
      signals: [`url:${kind}`, ...domSignals.slice(0, 5)],
    };
  },
  detectSession(url, domSignals) {
    const has = (s: string) => domSignals.some((d) => d.toLowerCase().includes(s));
    const state = has('captcha')
      ? 'CHALLENGE_REQUIRED'
      : has('login-form') || /login/i.test(url)
        ? 'LOGIN_PAGE'
        : has('session-expired')
          ? 'EXPIRED'
          : has('seller-nav') || has('nickname')
            ? 'AUTHENTICATED'
            : 'UNKNOWN';
    const nicknameSignal = domSignals.find((d) => d.startsWith('nickname:'))?.slice('nickname:'.length);
    return {
      marketplace: 'mercado_livre',
      state,
      url,
      checkedAt: new Date().toISOString(),
      evidence: domSignals.slice(0, 10),
      account: nicknameSignal
        ? {
            marketplace: 'mercado_livre',
            accountId: `ml:${nicknameSignal}`,
            displayName: nicknameSignal,
            handle: nicknameSignal,
            confidence: 0.9,
            verifiedByUser: false,
            detectedAt: new Date().toISOString(),
          }
        : undefined,
    };
  },
  diagnose(observed) {
    return diagnoseFrom(this.selectors, observed, '2026-11');
  },
};

// ---------------------------------------------------------------- Shopee
export const shopeeAdapter: AdapterDefinition = {
  id: 'shopee',
  label: 'Shopee',
  version: '1.0.0',
  domains: ['shopee.com.br', 'seller.shopee.com.br', 'banhang.shopee.com.br'],
  capabilities: CAP({
    returns_capture: 'PARCIALMENTE_SUPORTADO',
    autocomplete_capture: 'NAO_TESTADO',
    draft_mode: 'PARCIALMENTE_SUPORTADO',
    listing_duplicate: 'PARCIALMENTE_SUPORTADO',
  }),
  selectors: [
    { key: 'listing_title_input', selectors: ['input[name="name"]', 'input.product-name', '.product-name input'], layoutVersion: '2026-11', hitRate: 0.9 },
    { key: 'listing_description_editor', selectors: ['.ql-editor', 'div[contenteditable="true"]', 'textarea[name="description"]'], layoutVersion: '2026-11', hitRate: 0.86 },
    { key: 'listing_price_input', selectors: ['input[name="price"]', '.price-input input'], layoutVersion: '2026-11', hitRate: 0.88 },
    { key: 'listing_stock_input', selectors: ['input[name="stock"]'], layoutVersion: '2026-11', hitRate: 0.87 },
    { key: 'seller_shop_name', selectors: ['.shop-name', '[data-testid="shop-name"]'], layoutVersion: '2026-11', hitRate: 0.8 },
    { key: 'search_result_item', selectors: ['.shopee-search-item-result__item', '[data-sqe="item"]'], layoutVersion: '2026-11', hitRate: 0.85 },
  ],
  detectPage(url, domSignals) {
    const kind = detectByUrl(url);
    if (!kind) return null;
    return {
      marketplace: 'shopee',
      kind,
      url,
      detectedAt: new Date().toISOString(),
      signals: [`url:${kind}`, ...domSignals.slice(0, 5)],
    };
  },
  detectSession(url, domSignals) {
    const has = (s: string) => domSignals.some((d) => d.toLowerCase().includes(s));
    const state = has('captcha')
      ? 'CHALLENGE_REQUIRED'
      : has('login-form') || /login/i.test(url)
        ? 'LOGIN_PAGE'
        : has('shop-name')
          ? 'AUTHENTICATED'
          : 'UNKNOWN';
    const shop = domSignals.find((d) => d.startsWith('shopname:'))?.slice('shopname:'.length);
    return {
      marketplace: 'shopee',
      state,
      url,
      checkedAt: new Date().toISOString(),
      evidence: domSignals.slice(0, 10),
      account: shop
        ? {
            marketplace: 'shopee',
            accountId: `sh:${shop}`,
            displayName: shop,
            handle: shop,
            confidence: 0.85,
            verifiedByUser: false,
            detectedAt: new Date().toISOString(),
          }
        : undefined,
    };
  },
  diagnose(observed) {
    return diagnoseFrom(this.selectors, observed, '2026-11');
  },
};

/** Adapters declarados como NÃO IMPLEMENTADOS ainda — o produto os expõe como planejados. */
export const PLANNED_ADAPTERS: Array<{ id: MarketplaceId; label: string; status: 'PLANEJADO'; domains: string[] }> = [
  { id: 'amazon', label: 'Amazon', status: 'PLANEJADO', domains: ['amazon.com.br'] },
  { id: 'tiktok_shop', label: 'TikTok Shop', status: 'PLANEJADO', domains: ['seller-br.tiktok.com'] },
  { id: 'shein', label: 'Shein', status: 'PLANEJADO', domains: ['br.shein.com'] },
  { id: 'netshoes', label: 'Netshoes', status: 'PLANEJADO', domains: ['netshoes.com.br'] },
];

export const IMPLEMENTED_ADAPTERS: AdapterDefinition[] = [mercadoLivreAdapter, shopeeAdapter];

export function adapterForUrl(url: string): AdapterDefinition | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return IMPLEMENTED_ADAPTERS.find((a) => a.domains.some((d) => host === d || host.endsWith(`.${d}`))) ?? null;
}

/** Capacidades que o adapter declara como indisponíveis — usado pela UI e pelo Guard. */
export function unsupportedCapabilities(adapter: AdapterDefinition): AdapterCapability[] {
  return (Object.entries(adapter.capabilities) as Array<[AdapterCapability, string]>)
    .filter(([, level]) => level === 'NAO_DISPONIVEL' || level === 'EM_DESENVOLVIMENTO')
    .map(([cap]) => cap);
}
