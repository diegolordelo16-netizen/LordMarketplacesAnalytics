/**
 * Content script do Mercado Livre / Mercado Libre (§4, §9).
 *
 * Lê APENAS o que a página já mostra ao vendedor logado:
 *  - página do anúncio público (título, preço, reputação, perguntas)
 *  - central de vendas: visitas, vendas, perguntas, estoque
 *  - lista de anúncios do vendedor
 *
 * Não faz requisições, não lê cookies nem storage de sessão, não acessa endpoints privados.
 * Quando o dado não está visível, ele NÃO é inventado: fica ausente (NOT_COLLECTED).
 */
(function () {
  'use strict';

  const MAX_LISTINGS = 100;
  // `location` pode não existir no contexto de teste; o adaptador nunca deve
  // quebrar por isso (a IIFE roda inteira no carregamento do content script).
  const pageKind = typeof location !== 'undefined' ? detectPageKind(location.href) : 'unknown';
  // Diagnóstico: o painel e os testes leem o tipo detectado sem tocar no DOM.
  if (typeof window !== 'undefined') window.MI_LAST_PAGE_KIND = pageKind;

  /**
   * Classifica a página pelas áreas REAIS do painel do vendedor.
   *
   * As páginas enviam apenas valores do enum compartilhado (`product_detail`,
   * `seller_dashboard`, `seller_listings`, etc.); qualquer outro valor seria
   * rejeitado pelo schema de captura.
   */
  function detectPageKind(url) {
    // Rotas editoriais do vendedor precedem o ID do anúncio. URLs públicas
    // /items/MLB... continuam sendo detalhe de produto, não lista do vendedor.
    if (/\/(moderador|mis-publicaciones)(\/|$)/i.test(url)) return 'seller_listings';
    if (/\/ML[A-Z]-?\d+/i.test(url)) return 'product_detail';
    if (/\/(itens|items)(\/|$)/i.test(url)) return 'seller_listings';
    // Painel do vendedor (vendedores./central de vendas).
    if (/\/(resumo|summary|dashboard|home)(\/|$|\?|#)/i.test(url)) return 'seller_dashboard';
    if (/\/(vendas|ventas|orders|pedidos)\b/i.test(url)) return 'seller_orders';
    if (/\/(metricas|métricas|stats|performance)\b/i.test(url)) return 'seller_dashboard';
    if (/\/(anuncios|publicaciones)(\/|$)/i.test(url) && /vendedores\.|seller/i.test(url)) return 'seller_listings';
    if (/\/(publicidade|product_ads|ads|promocoes|promociones)\b/i.test(url)) return 'seller_ads';
    if (/\/(perguntas|preguntas|questions)\b/i.test(url)) return 'seller_questions';
    if (/\/(reputacao|reputación|reputation)\b/i.test(url)) return 'seller_reputation';
    if (/\/(devolucoes|devoluciones|returns)\b/i.test(url)) return 'seller_returns';
    if (/\/(estoque|inventario|inventory|stock)\b/i.test(url)) return 'seller_inventory';
    if (/\/(produtos|productos)\b/i.test(url)) return 'seller_listings';
    if (/\/(login|sesion)\b/i.test(url)) return 'login';
    return 'unknown';
  }

  const LABELS = {
    visits: ['visitas', 'visitas al anuncio', 'visitas no anúncio'],
    orders: ['vendas', 'ventas', 'pedidos', 'unidades vendidas'],
    units: ['unidades vendidas', 'unidades'],
    gmv: ['faturamento', 'facturación', 'receita', 'ventas totales'],
    stock: ['estoque', 'stock', 'disponíveis', 'disponibles'],
    questions: ['perguntas', 'preguntas', 'perguntas pendentes'],
    rating: ['avaliação', 'calificación', 'nota'],
    reviews: ['avaliações', 'opiniones', 'total de avaliações'],
    organic: ['impressões orgânicas', 'impresiones orgánicas'],
    paid: ['impressões pagas', 'impresiones pagas'],
  };

  function pick(labelKey) {
    const found = window.MI_DOM.findValueByLabel(document.body, LABELS[labelKey]);
    if (!found) return null;
    const value = window.MI_DOM.parseNumberPtBr(found.text);
    return value === null ? null : { value, evidence: found.label };
  }

  function captureCurrentPage() {
    const evidence = {};
    const listing = {};

    const externalId = window.MI_DOM.extractExternalId(location.href);
    if (externalId) listing.listingId = externalId;

    const titleEl =
      document.querySelector('h1.ui-pdp-title') ??
      document.querySelector('[data-testid="product-title"]') ??
      document.querySelector('h1');
    if (titleEl && titleEl.textContent.trim()) listing.title = titleEl.textContent.trim().slice(0, 2000);

    const priceEl =
      document.querySelector('.andes-money-amount__fraction') ??
      document.querySelector('[data-testid="price-part"]') ??
      document.querySelector('.price-tag-fraction');
    if (priceEl) {
      const container = priceEl.closest('.andes-money-amount') ?? priceEl;
      const cents = container.querySelector('.andes-money-amount__cents');
      const raw = `${priceEl.textContent.trim()}${cents ? `,${cents.textContent.trim()}` : ''}`;
      const price = window.MI_DOM.parseNumberPtBr(raw);
      if (price !== null) {
        listing.price = price;
        evidence.price = raw;
      }
    }

    for (const [key, labelKey] of [
      ['visits', 'visits'],
      ['orders', 'orders'],
      ['units', 'units'],
      ['gmv', 'gmv'],
      ['stockAvailable', 'stock'],
      ['questionsPending', 'questions'],
      ['reviewRating', 'rating'],
      ['reviewCount', 'reviews'],
      ['organicImpressions', 'organic'],
      ['paidImpressions', 'paid'],
    ]) {
      const found = pick(labelKey);
      if (found) {
        listing[key] = found.value;
        evidence[key] = found.evidence;
      }
    }

    return {
      marketplace: 'mercado_livre',
      pageKind,
      url: typeof location !== 'undefined' ? location.href : '',
      listings: Object.keys(listing).length > 1 ? [listing] : [],
      evidence,
      missing: ['visits', 'orders', 'units', 'gmv', 'stockAvailable', 'questionsPending', 'reviewRating', 'reviewCount', 'organicImpressions', 'paidImpressions']
        .filter((field) => evidence[field] === undefined),
    };
  }

  /** Lista de anúncios do vendedor: lê cards visíveis, um por anúncio. */
  function captureListingList() {
    const rows = [];
    const candidates = document.querySelectorAll(
      '[data-testid="item-row"], .ui-search-layout__item, .andes-list__item, tr[data-item-id]',
    );
    for (const row of candidates) {
      if (rows.length >= MAX_LISTINGS) break;
      const id = window.MI_DOM.extractExternalId(row.innerHTML) ?? row.getAttribute('data-item-id');
      const title = row.querySelector('h2, .ui-search-item__title, a')?.textContent?.replace(/\s+/g, ' ').trim();
      const priceText = row.querySelector('.andes-money-amount__fraction')?.textContent ?? '';
      if (!id && !title) continue;
      const item = {};
      if (id) item.listingId = String(id).toUpperCase();
      if (title) item.title = title.slice(0, 2000);
      const price = window.MI_DOM.parseNumberPtBr(priceText);
      if (price !== null) item.price = price;
      rows.push(item);
    }
    return {
      marketplace: 'mercado_livre',
      pageKind: 'seller_listings',
      url: typeof location !== 'undefined' ? location.href : '',
      listings: rows,
      evidence: { rows: String(rows.length) },
      missing: [],
    };
  }

  function snapshot() {
    if (pageKind === 'seller_listings') return captureListingList();
    return captureCurrentPage();
  }

  // Responde à solicitação do service worker / painel lateral.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'MI_CAPTURE_REQUEST') {
      try {
        sendResponse({ ok: true, snapshot: snapshot() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
      return true;
    }
    return false;
  });
})();
