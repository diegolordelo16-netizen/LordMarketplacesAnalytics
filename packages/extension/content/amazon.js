/**
 * Captura de inventário do Amazon Seller Central (Brasil).
 * Somente leitura da interface renderizada; sem cookies, fetch, XHR ou APIs privadas.
 * Não edita nem publica anúncios. Se os seletores não reconhecerem a tela, a captura fica vazia.
 */
(function () {
  'use strict';

  function detectPageKind(url) {
    if (/\/(ap\/)?signin|\/login/i.test(url)) return 'login';
    if (/\/(edit|update|delete|remove)(\/|\?|#|$)/i.test(url)) return 'unknown';
    if (/myinventory|manageinventory|inventory/i.test(url)) return 'seller_listings';
    if (/return|refund/i.test(url)) return 'seller_returns';
    if (/\/(questions|question)(\/|\?|#|$)/i.test(url)) return 'seller_questions';
    if (/feedback|reputation|reviews/i.test(url)) return 'seller_reputation';
    if (/claims|complaints|disputes/i.test(url)) return 'seller_complaints';
    if (/orders-v3|\/orders/i.test(url)) return 'seller_orders';
    if (/advertising|campaignmanager|\/ads/i.test(url)) return 'seller_ads';
    if (/dashboard|home/i.test(url)) return 'seller_dashboard';
    return 'unknown';
  }


  /** Apenas links de áreas do vendedor visíveis, HTTPS e da mesma origem. */
  function visibleAuthorizedAreaLinks() {
    const allowed = new Set([
      'seller_dashboard', 'seller_orders', 'seller_listings', 'seller_ads',
      'seller_questions', 'seller_reputation', 'seller_returns', 'seller_complaints', 'seller_inventory',
    ]);
    const current = new URL(location.href);
    const found = new Map();
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      if (!window.MI_DOM.isVisible(anchor)) continue;
      let target;
      try { target = new URL(anchor.href, current.href); } catch { continue; }
      if (target.protocol !== 'https:' || target.origin !== current.origin) continue;
      const kind = detectPageKind(target.href);
      if (!allowed.has(kind)) continue;
      target.hash = '';
      const key = `${target.origin}${target.pathname}`;
      if (key === `${current.origin}${current.pathname}` || found.has(key)) continue;
      found.set(key, {
        url: target.href,
        pageKind: kind,
        label: String(anchor.getAttribute('aria-label') || anchor.textContent || kind).replace(/\s+/g, ' ').trim().slice(0, 80),
      });
      if (found.size >= 20) break;
    }
    return [...found.values()];
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if(!el || !window.MI_DOM.isVisible(el)) continue;
      const value = String(el.textContent ?? el.value ?? '').replace(/\s+/g, ' ').trim();
      if (value) return value;
    }
    return '';
  }

  function numeric(root, selectors) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if(!el||!window.MI_DOM.isVisible(el))continue;
      const raw = el.value ?? el.textContent;
      const value = window.MI_DOM.parseNumberPtBr(raw);
      if (value !== null) return value;
    }
    return null;
  }

  function challengeDetected() {
    return window.MI_DOM.hasChallenge(document) || Boolean(document.querySelector('input[type="password"], form[action*="signin"]'));
  }

  function visibleAccountIdentity() {
    const selectors = ['#nav-link-accountList-nav-line-1', '[data-testid*="seller-name"]', '[data-testid*="account-name"]', '#sc-mkt-current-account', '[class*="merchant-name"]'];
    let handle = '';
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element || !window.MI_DOM.isVisible(element)) continue;
      const value = String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (value.length >= 2 && value.length <= 100 && !/^(hello|olá|account|conta)$/i.test(value)) { handle = value; break; }
    }
    if (!handle) return {};
    const normalized = handle.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) return {};
    let h1 = 2166136261, h2 = 0x9e3779b9;
    for (let index = 0; index < normalized.length; index += 1) { const code = normalized.charCodeAt(index); h1 = Math.imul(h1 ^ code, 16777619) >>> 0; h2 = Math.imul(h2 ^ (code + index), 2246822519) >>> 0; }
    return { accountHandle: handle.slice(0, 100), accountId: `amazon:ui:${h1.toString(16)}${h2.toString(16)}` };
  }

  function capture() {
    const pageKind = detectPageKind(location.href);
    const evidence = {};
    const listings = [], accountMetrics = {};
    if (pageKind === 'seller_listings') {
      const rows = document.querySelectorAll('#myitable tbody tr, table tbody tr[data-asin], tr[data-row-key], [data-testid="inventory-row"]');
      for (const row of rows) {
        if (listings.length >= 100 || !window.MI_DOM.isVisible(row)) continue;
        const asin = row.getAttribute('data-asin') || row.querySelector('[data-asin]')?.getAttribute('data-asin') || (row.innerText.match(/\bB0[A-Z0-9]{8}\b/) || [])[0] || '';
        const sku = row.getAttribute('data-sku') || firstText(row, ['[data-column="sku"]', '[data-testid*="sku"]', '.sku']);
        const id = sku ? `SKU:${sku}` : asin ? `ASIN:${asin}` : '';
        if (!id) continue;
        const title = firstText(row, ['.product-title', '[data-column="title"]', 'a[href*="/dp/"]', 'a.a-link-normal']);
        const price = numeric(row, ['input[name*="price"]', '[data-column="price"]', '.price']);
        const stock = numeric(row, ['[data-column="available"]', '[data-testid*="available"]', '.fulfillable-quantity']);
        const listing = { listingId: id };
        if (sku) listing.sku = sku.slice(0, 200);
        if (title) listing.title = title.slice(0, 2000);
        if (price !== null) listing.price = price;
        if (stock !== null) listing.stockAvailable = stock;
        const extraRow=window.MI_DOM.observedExtraMetrics?.(row,true);
        if(extraRow) Object.assign(listing,extraRow.metrics);
        listings.push(listing);
      }
      evidence.visibleInventoryRows = String(rows.length);
      evidence.capturedListings = String(listings.length);
    }
    if (['seller_dashboard','seller_orders','seller_ads','seller_reputation','seller_returns','seller_complaints'].includes(pageKind)) {
      const fields = {
        orders:['pedidos','orders'], units:['unidades vendidas','units ordered','units sold'],
        gmv:['vendas de produtos pedidos','ordered product sales','faturamento bruto','gross sales'], netRevenue:['receita líquida','net revenue','net sales'],
        visits:['visitas','visits'], organicImpressions:['impressões orgânicas','organic impressions'], paidImpressions:['impressões pagas','ad impressions'],
        adSpend:['gasto com anúncios','ad spend','advertising cost'], adClicks:['cliques em anúncios','ad clicks'],
        adAttributedRevenue:['vendas atribuídas','ad-attributed sales'], adAttributedOrders:['pedidos atribuídos','ad-attributed orders'],
        returnsCount:['devoluções','returns'], returnsValue:['valor devolvido','refund amount'], cancellations:['cancelamentos','cancellations'],
        discounts:['descontos concedidos','discount amount'], commission:['comissões','referral fees'],
        marketplaceFee:['taxas do marketplace','marketplace fees'], reviewCount:['total de avaliações','total reviews'], reviewRating:['nota média','average rating'],
      };
      for (const [field, labels] of Object.entries(fields)) {
        const found = window.MI_DOM.findValueByLabel(document.body,labels);
        const value = found && window.MI_DOM.parseNumberPtBr(found.text);
        if (typeof value === 'number' && value >= 0 && (field !== 'reviewRating' || value <= 5)) {
          accountMetrics[field] = value; evidence[field] = String(found.label + ': ' + found.text).slice(0,200);
        }
      }
    }
    if(pageKind!=='seller_listings'){
      const extra=window.MI_DOM.observedExtraMetrics?.(document.body,false);
      if(extra){Object.assign(accountMetrics,extra.metrics);Object.assign(evidence,extra.evidence);}
    }
    return {
      marketplace: 'amazon',
      pageKind,
      ...(Object.keys(accountMetrics).length ? { accountMetrics } : {}),
      ...visibleAccountIdentity(),
      url: location.href,
      listings,
      customerVoice: window.MI_DOM.visibleCustomerVoice(document, pageKind, 'amazon'),
      evidence,
      missing: pageKind === 'seller_listings' ? ['sku_or_asin', 'title', 'price', 'stockAvailable'].filter((key) => {
        if (key === 'sku_or_asin') return listings.length === 0;
        const field = key === 'stockAvailable' ? key : key;
        return listings.length > 0 && listings.every((row) => row[field] === undefined);
      }) : ['orders','units','gmv','netRevenue','visits','adSpend','adClicks','adAttributedRevenue','returnsCount','cancellations'].filter(field => accountMetrics[field] === undefined),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'MI_CAPTURE_REQUEST') {
      if (window.MI_DOM.hasChallenge(document) || document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')) {
        sendResponse({ ok: false, error: 'login/CAPTCHA: captura interrompida para verificação manual' });
        return true;
      }
      try {
        const observed=capture();
        observed.details=window.MI_DOM.visibleDetailRows?.(document,observed.pageKind)??[];
        const filters=window.MI_DOM.collectionFilterState?.(document)??{signature:'',warnings:[]};
        observed.filterSignature=filters.signature;
        observed.coverageWarnings=[...new Set([...filters.warnings,...(window.MI_DOM.collectionCoverage?.(document)??[])])];
        if(filters.signature) observed.evidence={...observed.evidence,filtersAndPeriod:filters.signature};
        sendResponse({ok:true,snapshot:observed});
      }
      catch (err) { sendResponse({ ok: false, error: String(err?.message ?? err) }); }
      return true;
    }
    if (message?.type === 'MI_CAPTURE_PAGE_INFO') {
      const pageKind = detectPageKind(location.href);
      const filters=window.MI_DOM.collectionFilterState?.(document)??{signature:'',warnings:[]};
      sendResponse({
        filterSignature:filters.signature,
        coverageWarnings:[...new Set([...filters.warnings,...(window.MI_DOM.collectionCoverage?.(document)??[])])],
        ok: true,
        marketplace: 'amazon',
        pageKind,
        ...visibleAccountIdentity(),
        url: location.href,
        loginRequired: challengeDetected() || pageKind === 'login',
        challenge: window.MI_DOM.hasChallenge(document),
        nextPageUrl: pageKind.startsWith('seller_') && pageKind !== 'seller_listing_edit' ? window.MI_DOM.paginationInfo(document, location.href, 'amazon') : null,
        paginationUnsupported: pageKind.startsWith('seller_') && Boolean(window.MI_DOM.paginationUnsupported?.(document,location.href,'amazon')),
        authorizedAreaLinks: visibleAuthorizedAreaLinks(),
      });
      return false;
    }
    if (message?.type === 'MI_TASK_CONTEXT') {
      sendResponse({ ok: true, marketplace: 'amazon', pageKind: detectPageKind(location.href), externalListingId: null, sessionAuthenticated: false });
      return false;
    }
    return false;
  });
})();
