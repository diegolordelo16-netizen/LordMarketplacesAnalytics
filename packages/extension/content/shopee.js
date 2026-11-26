/**
 * Content script do Shopee Seller Centre.
 *
 * Mesma política do Mercado Livre: só lê o que está visível, sem requisições,
 * sem cookies, sem endpoints privados. Ausente = não coletado (nunca zero).
 */
(function () {
  'use strict';

  function detectPageKind(url) {
    if (/\/portal\/product\/(list|manage)/i.test(url)) return 'seller_listings';
    if (/\/product\//i.test(url)) return 'product_detail';
    if (/\/datacenter|\/business-insights/i.test(url)) return 'seller_dashboard';
    if (/\/order/i.test(url)) return 'seller_orders';
    if (/\/marketing\/ads|\/ads\//i.test(url)) return 'seller_ads';
    return 'unknown';
  }

  const LABELS = {
    visits: ['visitas', 'page views', 'visualizações'],
    orders: ['pedidos', 'orders', 'vendas'],
    units: ['unidades vendidas', 'unidades'],
    gmv: ['vendas (brl)', 'receita', 'gmv'],
    stock: ['estoque', 'stock'],
    rating: ['avaliação', 'rating'],
    reviews: ['avaliações', 'reviews'],
    organic: ['impressões orgânicas', 'organic impressions'],
    adSpend: ['gasto com anúncios', 'ad spend'],
    adClicks: ['cliques', 'clicks'],
  };

  function pick(key) {
    const found = window.MI_DOM.findValueByLabel(document.body, LABELS[key]);
    if (!found) return null;
    const value = window.MI_DOM.parseNumberPtBr(found.text);
    return value === null ? null : { value, evidence: found.label };
  }

  function capture() {
    const pageKind = detectPageKind(location.href);
    const evidence = {};
    const listing = {};

    const idMatch = location.href.match(/i\.(\d{6,})\.(\d{6,})/);
    if (idMatch) listing.listingId = `${idMatch[1]}.${idMatch[2]}`;

    const titleEl = document.querySelector('[class*="page-product__title"], h1');
    if (titleEl?.textContent?.trim()) listing.title = titleEl.textContent.trim().slice(0, 2000);

    for (const [key, labelKey] of [
      ['visits', 'visits'],
      ['orders', 'orders'],
      ['units', 'units'],
      ['gmv', 'gmv'],
      ['stockAvailable', 'stock'],
      ['reviewRating', 'rating'],
      ['reviewCount', 'reviews'],
      ['organicImpressions', 'organic'],
      ['adSpend', 'adSpend'],
      ['adClicks', 'adClicks'],
    ]) {
      const found = pick(labelKey);
      if (found) {
        listing[key] = found.value;
        evidence[key] = found.evidence;
      }
    }

    return {
      marketplace: 'shopee',
      pageKind,
      url: location.href,
      listings: Object.keys(listing).length > 1 ? [listing] : [],
      evidence,
      missing: ['visits', 'orders', 'units', 'gmv', 'stockAvailable', 'reviewRating', 'reviewCount', 'organicImpressions', 'adSpend', 'adClicks']
        .filter((field) => evidence[field] === undefined),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'MI_CAPTURE_REQUEST') {
      try {
        sendResponse({ ok: true, snapshot: capture() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
      return true;
    }
    return false;
  });
})();
