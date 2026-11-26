/**
 * Marketplaces, adapters e matriz de compatibilidade (§5, §0.4).
 * Nenhuma funcionalidade pode ser silenciosamente desativada: cada adapter declara o que suporta.
 */

export const MARKETPLACE_IDS = [
  'mercado_livre',
  'shopee',
  'amazon',
  'tiktok_shop',
  'shein',
  'netshoes',
] as const;
export type MarketplaceId = (typeof MARKETPLACE_IDS)[number];

export const MARKETPLACE_LABEL: Record<MarketplaceId, string> = {
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
  amazon: 'Amazon',
  tiktok_shop: 'TikTok Shop',
  shein: 'Shein',
  netshoes: 'Netshoes',
};

/** Status de um módulo conforme §0.4. */
export const MODULE_STATUS = [
  'PLANEJADO',
  'EM_DESENVOLVIMENTO',
  'IMPLEMENTADO',
  'TESTADO',
  'PARCIAL',
  'BLOQUEADO',
  'NAO_SUPORTADO',
] as const;
export type ModuleStatus = (typeof MODULE_STATUS)[number];

/** Matriz de compatibilidade por funcionalidade (§5). */
export const COMPAT_LEVELS = [
  'SUPORTADO',
  'PARCIALMENTE_SUPORTADO',
  'NAO_DISPONIVEL',
  'EM_DESENVOLVIMENTO',
  'EM_MANUTENCAO',
  'NAO_TESTADO',
] as const;
export type CompatLevel = (typeof COMPAT_LEVELS)[number];

/** Capacidades que todo adapter deve declarar. */
export const ADAPTER_CAPABILITIES = [
  'session_detection',
  'account_detection',
  'listing_capture',
  'sales_capture',
  'visits_capture',
  'impressions_capture',
  'ads_capture',
  'questions_capture',
  'reputation_capture',
  'returns_capture',
  'inventory_capture',
  'search_results_capture',
  'autocomplete_capture',
  'competitor_observation',
  'title_edit',
  'description_edit',
  'image_upload',
  'price_edit',
  'listing_duplicate',
  'draft_mode',
] as const;
export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

export type CapabilityMatrix = Record<AdapterCapability, CompatLevel>;

export interface SelectorRecord {
  /** Nome lógico do seletor (`title_input`, `description_editor`, ...). */
  key: string;
  /** Seletores em cascata, do mais específico ao mais genérico. */
  selectors: string[];
  /** Versão do layout em que foi validado. */
  layoutVersion: string;
  /** Última vez em que resolveu elementos com sucesso (ISO-8601). */
  lastVerifiedAt?: string;
  /** Taxa histórica de acerto (0..1) — alimenta o diagnóstico de mudança de layout. */
  hitRate?: number;
}

export interface AdapterDiagnostics {
  layoutVersion: string;
  selectorHealth: Array<{ key: string; ok: boolean; matched: number; hitRate: number }>;
  layoutChangedSuspected: boolean;
  messages: string[];
}

export interface AccountRef {
  marketplace: MarketplaceId;
  /** Identificador estável da conta no escopo local. */
  accountId: string;
  /** Nome/loja exibido na UI (não é credencial). */
  displayName: string;
  /** Slug/nick observado na página, quando visível. */
  handle?: string;
  /** Confiança da identificação automática (0..1). Abaixo do limite → validação humana. */
  confidence: number;
  verifiedByUser: boolean;
  detectedAt: string;
}

/** Limite abaixo do qual a associação automática é bloqueada (§4.1). */
export const ACCOUNT_AUTO_BIND_MIN_CONFIDENCE = 0.85;

export const SESSION_STATES = [
  'AUTHENTICATED',
  'LOGGED_OUT',
  'EXPIRED',
  'LOGIN_PAGE',
  'CHALLENGE_REQUIRED',
  'UNKNOWN',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface SessionProbe {
  marketplace: MarketplaceId;
  state: SessionState;
  account?: AccountRef;
  /** URL observada no momento da checagem. */
  url: string;
  checkedAt: string;
  evidence: string[];
}

export const PAGE_KINDS = [
  'home',
  'search_results',
  'product_detail',
  'seller_dashboard',
  'seller_listings',
  'seller_listing_edit',
  'seller_orders',
  'seller_ads',
  'seller_questions',
  'seller_reputation',
  'seller_returns',
  'seller_inventory',
  'login',
  'challenge',
  'unknown',
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export interface PageContext {
  marketplace: MarketplaceId;
  kind: PageKind;
  url: string;
  /** Item/listing id quando aplicável. */
  itemId?: string;
  accountId?: string;
  detectedAt: string;
  /** Sinais usados na detecção, para auditoria. */
  signals: string[];
}

/** Modo de digitação controlada (§13.3). */
export const TYPING_MODES = ['set_value', 'keyboard_simulated', 'virtual_keyboard'] as const;
export type TypingMode = (typeof TYPING_MODES)[number];

export interface TypingOptions {
  mode: TypingMode;
  /** Intervalo entre caracteres em ms (ritmo). Nunca aleatório para evasão. */
  charDelayMs: number;
  /** Pausa técnica após eventos de foco/blur e antes de salvar. */
  settleDelayMs: number;
  /** Se true, valida o conteúdo final contra o esperado e aborta se divergir. */
  verifyAfterTyping: boolean;
}
