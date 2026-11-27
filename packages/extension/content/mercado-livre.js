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
    if (/\/vendas\/(anuncios|publicaciones)\/editar\/ML[A-Z]-?\d+/i.test(url)) return 'seller_listing_edit';
    if (/\/ML[A-Z]-?\d+/i.test(url) && /(editar|edit|modificar|modify)(\/|\?|#|$)/i.test(url)) return 'seller_listing_edit';
    if (/\/(anuncios|publicaciones)\/[^/?#]+\/(editar|edit|modificar|modify)(\/|\?|#|$)/i.test(url)) return 'seller_listing_edit';
    if (/\/ML[A-Z]-?\d+/i.test(url)) return 'product_detail';
    if (/\/(itens|items)(\/|$)/i.test(url)) return 'seller_listings';
    // Painel do vendedor (vendedores./central de vendas).
    if (/\/(resumo|summary|dashboard|home)(\/|$|\?|#)/i.test(url)) return 'seller_dashboard';
    if (/\/(metricas|métricas|stats|performance)\b/i.test(url)) return 'seller_dashboard';
    if (/\/(anuncios|publicaciones)(\/|$)/i.test(url) && /vendedores\.|seller/i.test(url)) return 'seller_listings';
    if (/\/(publicidade|product_ads|ads|promocoes|promociones)\b/i.test(url)) return 'seller_ads';
    if (/\/(perguntas|preguntas|questions)\b/i.test(url)) return 'seller_questions';
    if (/\/(reputacao|reputación|reputation|avaliacoes|reviews|opiniones)\b/i.test(url)) return 'seller_reputation';
    if (/\/(reclamacoes|reclamaciones|reclamos|claims|complaints|disputas|mediacoes|mediaciones)\b/i.test(url)) return 'seller_complaints';
    if (/\/(devolucoes|devoluciones|returns)\b/i.test(url)) return 'seller_returns';
    if (/\/(estoque|inventario|inventory|stock)\b/i.test(url)) return 'seller_inventory';
    if (/\/(produtos|productos)\b/i.test(url)) return 'seller_listings';
    if (/\/(vendas|ventas|orders|pedidos)\b/i.test(url)) return 'seller_orders';
    if (/\/(login|sesion)\b/i.test(url)) return 'login';
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

  function visibleAccountIdentity() {
    const selectors = [
      'header [data-testid*="user"]', 'header [data-testid*="account"]',
      'header .nav-header-user', '.nav-header-user', '#nav-header-menu-button',
      'button[aria-label*="conta" i]', 'button[aria-label*="perfil" i]',
      '[class*="user-menu"] [class*="name"]', '[class*="account-menu"] [class*="name"]',
    ];
    let handle = '';
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element || !window.MI_DOM.isVisible(element)) continue;
      const value = String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (value.length >= 2 && value.length <= 100 && !/^(conta|perfil|menu|vendedor|seller|minha conta)$/i.test(value)) { handle = value; break; }
    }
    if (!handle) return {};
    const normalized = handle.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) return {};
    let h1 = 2166136261, h2 = 0x9e3779b9;
    for (let index = 0; index < normalized.length; index += 1) { const code = normalized.charCodeAt(index); h1 = Math.imul(h1 ^ code, 16777619) >>> 0; h2 = Math.imul(h2 ^ (code + index), 2246822519) >>> 0; }
    return { accountHandle: handle.slice(0, 100), accountId: `mercado_livre:ui:${h1.toString(16)}${h2.toString(16)}` };
  }

  function visibleCustomerVoice(pageKind) {
    return window.MI_DOM.visibleCustomerVoice(document, pageKind, 'mercado_livre');
  }

  const LABELS = {
    visits: ['visitas', 'visitas al anuncio', 'visitas no anúncio'],
    orders: ['pedidos', 'pedidos confirmados', 'orders', 'sales orders'],
    units: ['unidades vendidas', 'unidades'],
    gmv: ['faturamento bruto', 'facturación bruta', 'receita bruta', 'ventas totales'],
    netRevenue: ['receita líquida', 'faturamento líquido', 'valor líquido recebido', 'net revenue', 'net sales'],
    commission: ['comissão', 'comissões', 'commission'],
    fixedFee: ['tarifa fixa', 'taxa fixa por venda', 'fixed fee'],
    shippingFee: ['frete pago pelo vendedor', 'custo de envio', 'shipping fee'],
    tax: ['impostos', 'tributos', 'taxes'],
    marketplaceFee: ['tarifas do marketplace', 'taxas do marketplace', 'marketplace fees'],
    stock: ['estoque', 'stock', 'disponíveis', 'disponibles'],
    questions: ['perguntas', 'preguntas', 'perguntas pendentes'],
    rating: ['avaliação', 'calificación', 'nota'],
    reviews: ['avaliações', 'opiniones', 'total de avaliações'],
    organic: ['impressões orgânicas', 'impresiones orgánicas'],
    paid: ['impressões pagas', 'impresiones pagas'],
    adSpend: ['investimento em publicidade', 'gasto com publicidade', 'gasto ads', 'inversión en publicidad'],
    adClicks: ['cliques em anúncios', 'clics en anuncios'],
    adRevenue: ['vendas atribuídas', 'receita atribuída', 'vendas via publicidade', 'ventas atribuidas'],
    adOrders: ['pedidos atribuídos', 'órdenes atribuidas'],
    returns: ['devoluções', 'devoluciones'],
    returnValue: ['valor devolvido', 'valor de devoluções'],
    cancellations: ['cancelamentos', 'cancelaciones'],
    discounts: ['descontos concedidos', 'descuentos'],
    addToCart: ['adicionaram ao carrinho', 'adicionar ao carrinho'],
    favorites: ['favoritaram', 'adicionados aos favoritos'],
    answered: ['perguntas respondidas', 'preguntas respondidas'],
  };

  function pick(labelKey) {
    const found = window.MI_DOM.findValueByLabel(document.body, LABELS[labelKey]);
    if (!found) return null;
    const value = window.MI_DOM.parseNumberPtBr(found.text);
    return value === null ? null : { value, evidence: found.label };
  }

  function visibleFilterPeriodContext() {
    const selectors = 'select, input[type="date"], input[type="month"], input[type="week"], [role="tab"][aria-selected="true"], button[aria-pressed="true"]';
    const nodes = Array.from(document.querySelectorAll(selectors)).slice(0, 30);
    const entries = [];
    for (const element of nodes) {
      if (element.disabled || element.getAttribute('aria-hidden') === 'true') continue;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
      const tag = String(element.tagName || '').toUpperCase();
      const type = String(element.type || '').toLowerCase();
      const label = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('name') || element.closest('label')?.textContent?.trim() || '';
      let value = '';
      if (tag === 'SELECT') {
        value = element.selectedOptions?.[0]?.textContent?.trim() || element.value || '';
      } else if (['date','month','week'].includes(type)) {
        value = String(element.value || '');
      } else {
        value = String(element.textContent || '').replace(/\s+/g, ' ').trim();
      }
      if (label || value) entries.push(`${String(label || tag).slice(0, 80)}=${String(value).slice(0, 120)}`);
    }
    return entries.length ? JSON.stringify(entries).slice(0, 1500) : '';
  }

  /** Evidência de oferta apenas quando o rótulo/valor está visível no DOM. */
  function collectVisibleOfferEvidence(listing, evidence) {
    const visibleTexts = Array.from(document.querySelectorAll('span,small,p,div,[aria-label],[title]'))
      .filter((element) => window.MI_DOM.isVisible(element))
      .map((element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 0 && text.length <= 80);
    const sponsored = visibleTexts.find((text) => /^(patrocinado|publicidade|sponsored|ad)$/i.test(text) || /\b(patrocinado|sponsored)\b/i.test(text));
    if (sponsored) { listing.sponsored = true; evidence.sponsored = sponsored.slice(0, 200); }

    const shippingLine = visibleTexts.find((text) => /frete|envio|shipping/i.test(text) && /(gr[aá]tis|R\$|US\$|\d)/i.test(text));
    if (shippingLine) {
      evidence.shipping = shippingLine.slice(0, 200);
      if (/frete\s+gr[aá]tis|envio\s+gr[aá]tis/i.test(shippingLine)) listing.shippingCents = 0;
      else {
        const money = shippingLine.match(/(?:R\$|US\$)\s*([\d.]+(?:,\d{1,2})?)/i);
        const amount = money ? window.MI_DOM.parseNumberPtBr(money[1]) : null;
        if (amount !== null && amount !== undefined) listing.shippingCents = Math.round(amount * 100);
      }
    }
    const deliveryLine = visibleTexts.find((text) => /(entrega|chega|prazo).{0,60}\b(dias?|day)/i.test(text));
    if (deliveryLine) {
      const range = deliveryLine.match(/(\d{1,2})\s*(?:a|até|-)\s*(\d{1,2})\s*dias?/i);
      const single = deliveryLine.match(/(\d{1,2})\s*dias?/i);
      if (range) { listing.deliveryDaysMin = Number(range[1]); listing.deliveryDaysMax = Number(range[2]); }
      else if (single) { listing.deliveryDaysMin = Number(single[1]); listing.deliveryDaysMax = Number(single[1]); }
      if (listing.deliveryDaysMin !== undefined) evidence.delivery = deliveryLine.slice(0, 200);
    }
    const imageUrls = Array.from(document.querySelectorAll('img'))
      .filter((img) => window.MI_DOM.isVisible(img) && Number(img.naturalWidth || img.width || 0) >= 80)
      .map((img) => { try { const url = new URL(img.currentSrc || img.src, location.href); return url.protocol === 'https:' ? `${url.origin}${url.pathname}` : ''; } catch { return ''; } })
      .filter(Boolean);
    listing.visibleImageUrls = [...new Set(imageUrls)].slice(0, 10);
    if (listing.visibleImageUrls.length) evidence.visibleImages = String(listing.visibleImageUrls.length);
  }

  function captureCurrentPage() {
    const evidence = {};
    const listing = {};
    const currentKind = currentPageKind();
    collectVisibleOfferEvidence(listing, evidence);
    const filterContext = visibleFilterPeriodContext();
    if (filterContext) evidence.filtersAndPeriod = filterContext;
    const accountPage = ['seller_dashboard', 'seller_ads', 'seller_orders', 'seller_questions', 'seller_reputation', 'seller_returns', 'seller_complaints', 'seller_inventory'].includes(currentKind);
    const accountMetrics = {};

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
      const money=window.MI_DOM.visibleMoneyParts?.(priceEl);
      if(money){listing.price=money.value;evidence.price=money.text;}
    }

    for (const [key, labelKey] of [
      ['visits', 'visits'],
      ['orders', 'orders'],
      ['units', 'units'],
      ['gmv', 'gmv'],
      ['netRevenue', 'netRevenue'],
      ['commission', 'commission'],
      ['fixedFee', 'fixedFee'],
      ['shippingFee', 'shippingFee'],
      ['tax', 'tax'],
      ['marketplaceFee', 'marketplaceFee'],
      ['stockAvailable', 'stock'],
      ['questionsPending', 'questions'],
      ['reviewRating', 'rating'],
      ['reviewCount', 'reviews'],
      ['organicImpressions', 'organic'],
      ['paidImpressions', 'paid'],
      ['adSpend', 'adSpend'],
      ['adClicks', 'adClicks'],
      ['adAttributedRevenue', 'adRevenue'],
      ['adAttributedOrders', 'adOrders'],
      ['returnsCount', 'returns'],
      ['returnsValue', 'returnValue'],
      ['cancellations', 'cancellations'],
      ['discounts', 'discounts'],
      ['addToCart', 'addToCart'],
      ['favorites', 'favorites'],
      ['questionsAnswered', 'answered'],
    ]) {
      const found = pick(labelKey);
      if (found) {
        if (accountPage) accountMetrics[key] = found.value;
        else listing[key] = found.value;
        evidence[key] = found.evidence;
      }
    }

    const extra=window.MI_DOM.observedExtraMetrics?.(document.body,!accountPage);
    if(extra){Object.assign(accountPage?accountMetrics:listing,extra.metrics);Object.assign(evidence,extra.evidence);}
    return {
      marketplace: 'mercado_livre',
      pageKind: currentKind,
      ...visibleAccountIdentity(),
      customerVoice: visibleCustomerVoice(currentKind),
      url: typeof location !== 'undefined' ? location.href : '',
      listings: listing.listingId ? [listing] : [],
      ...(Object.keys(accountMetrics).length ? { accountMetrics } : {}),
      evidence,
      missing: ['visits', 'orders', 'units', 'gmv', 'netRevenue', 'stockAvailable', 'questionsPending', 'reviewRating', 'reviewCount', 'organicImpressions', 'paidImpressions']
        .filter((field) => evidence[field] === undefined),
    };
  }

  /** Lista de anúncios do vendedor: lê cards visíveis, um por anúncio. */
  function captureListingList() {
    const rows = [];
    const filterContext = visibleFilterPeriodContext();
    const candidates = document.querySelectorAll(
      '[data-testid="item-row"], .ui-search-layout__item, .andes-list__item, tr[data-item-id]',
    );
    for (const row of candidates) {
      if (rows.length >= MAX_LISTINGS) break;
      if (!window.MI_DOM.isVisible(row)) continue;
      const link = Array.from(row.querySelectorAll('a[href]')).find(el => window.MI_DOM.isVisible(el) && window.MI_DOM.extractExternalId(el.href));
      const id = window.MI_DOM.extractExternalId(row.getAttribute('data-item-id') || '') || (link && window.MI_DOM.extractExternalId(link.href));
      if (!id || rows.some(item => item.listingId === String(id).toUpperCase())) continue;
      const titleNode = row.querySelector('h2, .ui-search-item__title, a');
      const priceNode = row.querySelector('.andes-money-amount__fraction');
      const title = titleNode && window.MI_DOM.isVisible(titleNode) ? titleNode.textContent?.replace(/\s+/g, ' ').trim() : '';
      const priceText = priceNode && window.MI_DOM.isVisible(priceNode) ? priceNode.textContent : '';
      const item = { listingId: String(id).toUpperCase() };
      if (title) item.title = title.slice(0, 2000);
      const money=window.MI_DOM.visibleMoneyParts?.(priceNode);
      const price = typeof window.MI_DOM.visibleMoneyParts==='function' ? money?.value??null : priceText ? window.MI_DOM.parseNumberPtBr(priceText) : null;
      if (price !== null && price >= 0) item.price = price;
      for (const [field, key] of [['stockAvailable','stock'],['units','units'],['visits','visits'],['orders','orders']]) {
        const found = window.MI_DOM.findValueByLabel(row, LABELS[key]);
        const value = found && window.MI_DOM.parseNumberPtBr(found.text);
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) item[field] = value;
      }
      const extraRow=window.MI_DOM.observedExtraMetrics?.(row,true);
      if(extraRow) Object.assign(item,extraRow.metrics);
      rows.push(item);
    }
    return {
      marketplace: 'mercado_livre',
      pageKind: 'seller_listings',
      ...visibleAccountIdentity(),
      url: typeof location !== 'undefined' ? location.href : '',
      listings: rows,
      evidence: { rows: String(rows.length), ...(filterContext ? { filtersAndPeriod: filterContext } : {}) },
      missing: [],
    };
  }

  function snapshot() {
    if (currentPageKind() === 'seller_listings') return captureListingList();
    return captureCurrentPage();
  }

  function currentPageKind() {
    return typeof location !== 'undefined' ? detectPageKind(location.href) : 'unknown';
  }

  function currentExternalListingId() {
    return window.MI_DOM.extractExternalId(location.href) ?? null;
  }

  function hasAuthenticatedSellerEditForm() {
    if (currentPageKind() !== 'seller_listing_edit') return false;
    if (document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')) return false;
    const title = document.querySelector('input[name="title"], input#title, [data-testid="title-input"]');
    const description = document.querySelector('textarea[name="description"], .andes-textarea textarea, div[contenteditable="true"]');
    return Boolean((isEditableVisible(title) || isEditableVisible(description)) && currentExternalListingId());
  }

  function isEditableVisible(el) {
    if (!el || el.disabled || el.readOnly || el.getAttribute('aria-hidden') === 'true') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  }

  async function setDraftField(selectors, value, append, charDelayMs = 0) {
    const el = selectors.map((selector) => document.querySelector(selector)).find(isEditableVisible);
    if (!el) throw new Error(`campo não localizado: ${selectors[0]}`);
    const current = 'value' in el ? String(el.value ?? '') : String(el.textContent ?? '');
    if (append && current.includes(value)) return;
    const prefix = append ? `${current.trim()}${current.trim() ? '\n\n' : ''}` : '';
    const write = (text, paragraph = null, commit = false) => {
      if (paragraph) paragraph.textContent = text;
      else if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, text); else el.value = text;
      } else el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (commit) el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    let paragraph = null;
    if (append && !('value' in el)) {
      paragraph = document.createElement('p');
      el.appendChild(paragraph);
    }
    if (charDelayMs > 0) {
      let typed = '';
      for (const character of value) {
        typed += character;
        write(append && 'value' in el ? `${prefix}${typed}` : typed, paragraph, false);
        if (charDelayMs) await new Promise((resolve) => setTimeout(resolve, charDelayMs));
      }
      write(append && 'value' in el ? `${prefix}${typed}` : typed, paragraph, true);
    } else if (append && paragraph) {
      write(value, paragraph, true);
    } else {
      write(append ? `${prefix}${value}` : value, null, true);
    }
    const actual = 'value' in el ? String(el.value ?? '') : String(el.textContent ?? '');
    if (append ? !actual.includes(value) : actual !== value) throw new Error('verificação do campo falhou após preenchimento');
  }

  async function applyDraft(message) {
    const { task, item, externalListingId } = message ?? {};
    if (task?.mode !== 'DRAFT') throw new Error('somente tarefas DRAFT são permitidas');
    if (!['edit_title', 'edit_description'].includes(task.kind)) throw new Error('tipo de tarefa sem executor seguro');
    if (task.kind === 'edit_title' && item?.description_additions) throw new Error('tarefa de título não pode alterar a descrição');
    if (task.kind === 'edit_description' && item?.title) throw new Error('tarefa de descrição não pode alterar o título');
    if (!hasAuthenticatedSellerEditForm()) throw new Error('abra a tela de edição autenticada do anúncio; o formulário do vendedor não foi confirmado');
    if (!item || currentExternalListingId() !== externalListingId) {
      throw new Error('o anúncio aberto não corresponde ao item da tarefa');
    }
    if (Number(item.copies ?? 1) !== 1 || item.cover_image_id) {
      throw new Error('duplicação e troca de imagem ainda exigem fluxo manual');
    }
    const typing = JSON.parse(task.typing_json || '{}');
    if (typing.mode && typing.mode !== 'set_value') throw new Error('modo de digitação não suportado com segurança; use set_value');
    const charDelayMs = Number.isInteger(typing.charDelayMs) && typing.charDelayMs >= 0 && typing.charDelayMs <= 250 ? typing.charDelayMs : 0;
    const settleDelayMs = Number.isInteger(typing.settleDelayMs) && typing.settleDelayMs >= 0 && typing.settleDelayMs <= 5000 ? typing.settleDelayMs : 0;
    if (typing.verifyAfterTyping !== true) throw new Error('a verificação após digitação é obrigatória');
    const baseline = { title: readTaskField(['input[name="title"]', 'input#title', '[data-testid="title-input"]']), description: readTaskField(['textarea[name="description"]', '.andes-textarea textarea', 'div[contenteditable="true"]']) };
    if ((task.kind === 'edit_title' && baseline.title === null) || (task.kind === 'edit_description' && baseline.description === null)) throw new Error('não foi possível ler o valor original do campo antes do rascunho');
    const characters = String(item.title ?? '').length + String(item.description_additions ?? '').length;
    if (characters * charDelayMs > 60000) throw new Error('a velocidade escolhida excede o limite seguro de 60 segundos; reduza o intervalo entre caracteres');
    const fields = [];
    if (item.title) {
      await setDraftField(['input[name="title"]', 'input#title', '[data-testid="title-input"]'], String(item.title), false, charDelayMs);
      fields.push('título');
    }
    if (item.description_additions) {
      await setDraftField(['textarea[name="description"]', '.andes-textarea textarea', 'div[contenteditable="true"]'], String(item.description_additions), true, charDelayMs);
      fields.push('descrição');
    }
    if (!fields.length) throw new Error('nenhuma alteração de rascunho suportada foi informada');
    if (settleDelayMs) await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
    if (currentExternalListingId() !== externalListingId) throw new Error('o anúncio mudou durante o preenchimento; verificação interrompida');
    return { ok: true, fields, charDelayMs, baseline, sourceUrl: location.href, externalListingId, saved: false, published: false, note: 'campos preenchidos e verificados; snapshot anterior capturado; ainda não foram salvos nem publicados' };
  }

  /** Leitura do formulário para publicação assistida: somente campos visíveis na tela. */
  function findVisibleTaskElement(selectors) {
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((candidate) => window.MI_DOM.isVisible(candidate));
      if (element) return element;
    }
    return null;
  }

  function readTaskField(selectors) {
    const element = findVisibleTaskElement(selectors);
    if (!element) return null;
    return 'value' in element ? String(element.value ?? '') : String(element.textContent ?? '');
  }

  function findExplicitSaveControl() {
    const titleElement = findVisibleTaskElement(['input[name="title"]', 'input#title', '[data-testid="title-input"]']);
    const descriptionElement = findVisibleTaskElement(['textarea[name="description"]', '.andes-textarea textarea', 'div[contenteditable="true"]']);
    const form = (titleElement && titleElement.closest('form')) || (descriptionElement && descriptionElement.closest('form'));
    if (!form) return null;
    const allowed = new Set([
      'salvar', 'salvar alterações', 'salvar e publicar', 'publicar alterações', 'publicar', 'atualizar',
      'save', 'save changes', 'save and publish', 'publish changes', 'update',
    ]);
    const candidates = Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .filter((element) => window.MI_DOM.isVisible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
      .map((element) => ({
        element,
        label: String(element.getAttribute('aria-label') || element.value || element.textContent || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((entry) => allowed.has(entry.label.toLowerCase()));
    if (candidates.length !== 1) return null;
    return candidates[0];
  }

  function waitForSaveConfirmation(timeoutMs = 5000, existingMessages = new Set()) {
    // Conservador de propósito: palavras soltas como "publicado" ou "sucesso"
    // podem aparecer em alertas que descrevem uma tentativa recusada.
    const successPattern = /\b(salvo com sucesso|salva com sucesso|salvos com sucesso|salvas com sucesso|alterações salvas|alteração salva|anúncio atualizado|anuncio atualizado|atualizado com sucesso|publicado com sucesso|publicação concluída|successfully saved|changes saved|listing updated|saved successfully|updated successfully)\b/i;
    const errorPattern = /\b(erro|falha|error|failed|n[aã]o|not|rejeitad[oa]|cancelad[oa]|unable|could not)\b/i;
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        const candidates = Array.from(document.querySelectorAll('[role="alert"], [aria-live="polite"], [class*="snackbar"], [class*="toast"], [data-testid*="success"]'));
        for (const element of candidates) {
          if (!window.MI_DOM.isVisible(element)) continue;
          const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
          if (text && !existingMessages.has(text) && successPattern.test(text) && !errorPattern.test(text)) return resolve(text.slice(0, 500));
        }
        if (Date.now() - started >= timeoutMs) return resolve(null);
        setTimeout(check, 250);
      };
      check();
    });
  }

  /**
   * Publicação assistida: aprovação administrativa prévia + aba ativa + confirmação
   * nativa por anúncio. Sem formulário inequívoco ou mensagem positiva, não declara sucesso.
   */
  let budgetDocumentNonce=null;
  const consumedBudgetGrants=new Set();
  function campaignBudgetContext(campaignRef){
    if(location.origin!=='https://vendedores.mercadolivre.com.br'||currentPageKind()!=='seller_ads'||window.MI_DOM.hasChallenge(document)||document.querySelector('input[type="password"],form[action*="login"],form[action*="signin"]'))throw Error('abra a publicidade autenticada sem desafio');
    const identity=visibleAccountIdentity();
    if(!identity.accountId||!campaignRef||!/^[A-Za-z0-9_.:-]{1,200}$/.test(campaignRef))throw Error('identidade ou campanha não comprovada');
    const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
    const rows=Array.from(document.querySelectorAll('[data-campaign-id]')).filter(el=>window.MI_DOM.isVisible(el)&&el.getAttribute('data-campaign-id')===campaignRef);
    if(rows.length!==1)throw Error('campanha visível ambígua ou ausente');
    const row=rows[0];
    const fields=Array.from(row.querySelectorAll('input[type="number"]')).filter(el=>{
      const label=norm(el.getAttribute('aria-label')||Array.from(el.labels||[]).map(l=>l.textContent).join(' '));
      return window.MI_DOM.isVisible(el)&&isEditableVisible(el)&&/^(orcamento diario|daily budget)( \(r\$\)| r\$)?$/.test(label)&&!el.getAttribute('form');
    });
    if(fields.length!==1)throw Error('orçamento diário numérico explícito não encontrado');
    const field=fields[0],form=field.closest('form');
    if(!form||!row.contains(form)||field.form!==form||new URL(form.action||location.href,location.href).origin!==location.origin||!['_self',''].includes(form.target)||form.querySelector('[contenteditable]:not([contenteditable="false"])'))throw Error('formulário dedicado de orçamento não comprovado');
    const fieldsInForm=Array.from(form.elements).filter(el=>!['hidden','button','submit','reset'].includes(el.type));
    if(fieldsInForm.length!==1||fieldsInForm[0]!==field)throw Error('formulário dedicado de orçamento não comprovado');
    const buttons=Array.from(form.querySelectorAll('button[type="submit"],button[type="button"]')).filter(el=>window.MI_DOM.isVisible(el)&&el.form===form&&!['formaction','form','formtarget','formmethod'].some(attr=>el.hasAttribute(attr))&&/^(salvar|salvar alteracoes|atualizar orcamento|save|save changes|update budget)$/.test(norm(el.getAttribute('aria-label')||el.textContent)));
    if(buttons.length!==1)throw Error('botão exclusivo de salvar orçamento não localizado');
    const raw=String(field.value);
    if(!/^\d+(?:\.\d{1,2})?$/.test(raw)||!Number.isSafeInteger(Math.round(Number(raw)*100)))throw Error('orçamento monetário inválido');
    budgetDocumentNonce??=crypto.randomUUID();
    return {field,button:buttons[0],accountId:identity.accountId,campaignRef,sourcePath:location.origin+location.pathname,documentNonce:budgetDocumentNonce,budgetCents:Math.round(Number(raw)*100)};
  }
  function budgetPublicContext(campaignRef){
    const {field,button,...ctx}=campaignBudgetContext(campaignRef);return ctx;
  }
  async function applyCampaignBudget(grant){
    let touched=false;
    try{
      if(!grant||typeof grant.id!=='string'||consumedBudgetGrants.has(grant.id)||consumedBudgetGrants.size>=100)throw Error('autorização já utilizada ou limite atingido');
      consumedBudgetGrants.add(grant.id);
      const ctx=campaignBudgetContext(grant.campaignRef);
      const same=c=>c.accountId===grant.accountId&&c.sourcePath===grant.sourcePath&&c.documentNonce===grant.documentNonce&&Date.parse(grant.expiresAt)>Date.now()&&document.visibilityState==='visible';
      if(!same(ctx)||ctx.budgetCents!==grant.beforeCents||!Number.isSafeInteger(grant.targetCents)||grant.targetCents<=0||grant.targetCents>100000000||grant.beforeCents===grant.targetCents)throw Error('contexto ou orçamento mudou');
      if(!window.confirm('Campanha '+grant.campaignRef+'\nOrçamento diário atual: R$ '+(grant.beforeCents/100).toFixed(2)+'\nNovo orçamento diário: R$ '+(grant.targetCents/100).toFixed(2)+'\nConfirma alterar e salvar agora?'))return {outcome:'CANCELLED',message:'cancelado antes de editar'};
      const again=campaignBudgetContext(grant.campaignRef);
      if(!same(again)||again.field!==ctx.field||again.button!==ctx.button||again.budgetCents!==grant.beforeCents)throw Error('contexto mudou antes da edição');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
      if(!setter)throw Error('campo não oferece setter nativo');
      touched=true;
      setter.call(again.field,(grant.targetCents/100).toFixed(2));
      again.field.dispatchEvent(new Event('input',{bubbles:true}));again.field.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,300));
      const ready=campaignBudgetContext(grant.campaignRef);
      if(!same(ready)||ready.field!==again.field||ready.button!==again.button||ready.budgetCents!==grant.targetCents||!ready.field.checkValidity()||ready.button.disabled||ready.button.getAttribute('aria-disabled')==='true')throw Error('valor ou controle não permaneceu verificável; revise manualmente');
      ready.button.click();
      return {outcome:'NEEDS_VERIFICATION',clicked:true,message:'controle de salvar acionado. Confira o orçamento antes de qualquer nova tentativa.'};
    }catch(error){return {outcome:touched?'NEEDS_VERIFICATION':'FAILED',message:String(error?.message||error).slice(0,1000)};}
  }

  const consumedListingGrants=new Set();
  function operationLabel(el){
    return String(el.getAttribute('aria-label')||Array.from(el.labels||[]).map(l=>l.textContent).join(' ')||el.textContent||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  }
  function listingOperationContext(action,externalListingId,variationId,allowFilled=false){
    if(location.origin!=='https://vendedores.mercadolivre.com.br'||window.MI_DOM.hasChallenge(document)||document.querySelector('input[type="password"],form[action*="login"],form[action*="signin"]')||!/^(MLB-?\d{5,})$/i.test(externalListingId))throw Error('sessão ou anúncio não reconhecido');
    const accountId=visibleAccountIdentity().accountId;
    if(!accountId)throw Error('conta não comprovada');
    budgetDocumentNonce??=crypto.randomUUID();
    const base={accountId,externalListingId,action,sourcePath:location.origin+location.pathname,documentNonce:budgetDocumentNonce};
    const unique=(items,message)=>{if(items.length!==1)throw Error(message);return items[0];};
    const visible=el=>window.MI_DOM.isVisible(el);
    const safeButton=el=>visible(el)&&!el.getAttribute('formaction')&&!el.getAttribute('form')&&!el.getAttribute('href')&&!el.getAttribute('formmethod')&&!el.getAttribute('formtarget');
    const listingIds=el=>['data-item-id','data-listing-id'].map(k=>el.getAttribute(k)).filter(Boolean);
    if(action==='DUPLICATE'){
      if(currentPageKind()!=='seller_listings'||variationId)throw Error('abra a lista de anúncios');
      const row=unique(Array.from(document.querySelectorAll('[data-item-id],[data-listing-id]')).filter(el=>visible(el)&&listingIds(el).length>0&&listingIds(el).every(id=>id===externalListingId)),'linha explícita e única do anúncio necessária');
      const button=unique(Array.from(row.querySelectorAll('button[type="button"]')).filter(el=>safeButton(el)&&el.closest('[data-item-id],[data-listing-id]')===row&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&!el.form&&!el.closest('form')&&/^(duplicar anuncio|duplicar publicacao|duplicate listing)$/.test(operationLabel(el))),'controle explícito de duplicação não encontrado');
      return {base,fields:{},button,values:{}};
    }
    if(!['CREATE_VARIATION','EDIT_VARIATION'].includes(action)||currentPageKind()!=='seller_listing_edit'||currentExternalListingId()!==externalListingId)throw Error('abra o editor do anúncio aprovado');
    let region=document;
    if(action==='EDIT_VARIATION'){
      if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(variationId||''))throw Error('ID explícito da variação necessário');
      region=unique(Array.from(document.querySelectorAll('[data-variation-id]')).filter(el=>visible(el)&&el.getAttribute('data-variation-id')===variationId),'variação ambígua ou ausente');
      const parent=region.closest('[data-item-id],[data-listing-id]');
      if(parent&&listingIds(parent).some(id=>id!==externalListingId))throw Error('variação pertence a outro anúncio');
      const label=unique(Array.from(region.querySelectorAll('[data-testid="variation-name"]')).filter(visible),'nome explícito da variação necessário');
      const name=String(label.textContent||'').trim();
      if(!name||name.length>120)throw Error('nome da variação não verificável');
      base.variationId=variationId;base.variationLabel=name;
    }else if(variationId)throw Error('formulário de nova variação necessário');
    const savePattern=action==='CREATE_VARIATION'?/^(criar variacao|adicionar variacao|salvar nova variacao|create variation|add variation)$/:/^(salvar variacao|atualizar variacao|save variation|update variation)$/;
    const candidates=Array.from(region.querySelectorAll('form')).filter(form=>visible(form)&&(action!=='EDIT_VARIATION'||form.closest('[data-variation-id]')===region)&&Array.from(form.querySelectorAll('button[type="submit"],button[type="button"]')).some(el=>el.form===form&&safeButton(el)&&savePattern.test(operationLabel(el))));
    const form=unique(candidates,'formulário dedicado de variação ausente ou ambíguo');
    if(new URL(form.action||location.href,location.href).origin!==location.origin||form.getAttribute('target')&&!['_self',''].includes(form.getAttribute('target')))throw Error('destino do formulário não autorizado');
    const button=unique(Array.from(form.querySelectorAll('button[type="submit"],button[type="button"]')).filter(el=>el.form===form&&safeButton(el)&&savePattern.test(operationLabel(el))),'controle de salvar ambíguo');
    const definitions=action==='CREATE_VARIATION'?{
      name:['text',/^(nome da variacao|variation name)$/],option:['text',/^(opcao da variacao|valor da variacao|variation option|variation value)$/],
      priceCents:['number',/^(preco|price)( \(r\$\)| r\$)?$/],stock:['number',/^(estoque|stock|quantidade disponivel|available quantity)$/]
    }:{priceCents:['number',/^(preco|price)( \(r\$\)| r\$)?$/],stock:['number',/^(estoque|stock|quantidade disponivel|available quantity)$/]};
    const controls=Array.from(form.elements||[]).filter(el=>!['hidden','button','submit','reset'].includes(String(el.type||'').toLowerCase()));
    if(controls.length!==Object.keys(definitions).length||form.querySelector('[contenteditable="true"]'))throw Error('formulário contém outros campos; revise manualmente');
    const fields={},values={};
    for(const [key,[type,pattern]] of Object.entries(definitions)){
      const field=unique(controls.filter(el=>el.tagName==='INPUT'&&el.type===type&&el.form===form&&visible(el)&&isEditableVisible(el)&&!el.getAttribute('form')&&pattern.test(operationLabel(el))),'campo '+key+' não comprovado');
      fields[key]=field;const raw=String(field.value??'');
      if(key==='priceCents'){
        if(raw===''&&action==='CREATE_VARIATION')values[key]=null;
        else if(/^\d+(?:\.\d{1,2})?$/.test(raw)&&Number.isSafeInteger(Math.round(Number(raw)*100)))values[key]=Math.round(Number(raw)*100);
        else throw Error('preço inválido');
      }else if(key==='stock'){
        if(raw===''&&action==='CREATE_VARIATION')values[key]=null;
        else if(/^\d+$/.test(raw)&&Number.isSafeInteger(Number(raw)))values[key]=Number(raw);
        else throw Error('estoque inválido');
      }else values[key]=raw.trim();
    }
    if(action==='CREATE_VARIATION'&&!allowFilled&&(values.name!==''||values.option!==''||values.priceCents!==null||!(values.stock===null||values.stock===0)))throw Error('formulário de criação deve estar vazio antes da autorização');
    if(action==='EDIT_VARIATION'){base.beforePriceCents=values.priceCents;base.beforeStock=values.stock;}
    return {base,fields,button,values};
  }
  function listingOperationPublicContext(message){
    return listingOperationContext(message.action,message.externalListingId,message.variationId).base;
  }
  async function applyListingOperation(grant){
    let touched=false;
    try{
      if(!grant||typeof grant.id!=='string'||consumedListingGrants.has(grant.id)||consumedListingGrants.size>=100)throw Error('autorização já utilizada ou limite atingido');
      consumedListingGrants.add(grant.id);
      const g=grant.context,p=grant.plan;
      const initial=listingOperationContext(g.action,g.externalListingId,g.variationId);
      const contextMatches=c=>['accountId','externalListingId','action','sourcePath','documentNonce','variationId','variationLabel'].every(k=>c.base[k]===g[k])&&Date.parse(grant.expiresAt)>Date.now()&&document.visibilityState==='visible';
      const baselineMatches=c=>contextMatches(c)&&c.base.beforePriceCents===g.beforePriceCents&&c.base.beforeStock===g.beforeStock;
      if(!baselineMatches(initial))throw Error('contexto mudou');
      if(g.action!=='DUPLICATE'&&(!Number.isSafeInteger(p.priceCents)||p.priceCents<=0||p.priceCents>100000000||!Number.isSafeInteger(p.stock)||p.stock<0||p.stock>1000000))throw Error('valores da proposta inválidos');
      const summary=g.action==='DUPLICATE'?'Duplicar anúncio '+g.externalListingId+' — '+p.originalTitle:'Variação de '+g.externalListingId+' — '+p.name+(p.option?' / '+p.option:'')+'\nPreço: R$ '+(p.priceCents/100).toFixed(2)+'\nEstoque: '+p.stock;
      if(!window.confirm('Loja: '+g.accountId+'\n'+summary+'\nConfirma acionar o controle desta proposta agora? A operação pode alterar ou criar uma oferta.'))return {outcome:'CANCELLED',message:'cancelado antes da edição'};
      const again=listingOperationContext(g.action,g.externalListingId,g.variationId);
      if(!baselineMatches(again)||again.button!==initial.button||Object.keys(initial.fields).some(k=>again.fields[k]!==initial.fields[k]))throw Error('formulário mudou antes da ação');
      if(g.action==='DUPLICATE'){
        touched=true;again.button.click();
        return {outcome:'NEEDS_VERIFICATION',message:'controle de duplicação acionado; revise eventual diálogo e capture o novo anúncio. Não repetir automaticamente.'};
      }
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
      if(!setter)throw Error('setter nativo ausente');
      const wanted=g.action==='CREATE_VARIATION'?{name:p.name,option:p.option,priceCents:p.priceCents,stock:p.stock}:{priceCents:p.priceCents,stock:p.stock};
      const expected={...again.values};
      for(const [key,value] of Object.entries(wanted)){
        const now=listingOperationContext(g.action,g.externalListingId,g.variationId,touched);
        if(!contextMatches(now)||now.button!==again.button||Object.keys(again.fields).some(k=>now.fields[k]!==again.fields[k]||now.values[k]!==expected[k]))throw Error('contexto mudou durante o preenchimento');
        touched=true;setter.call(now.fields[key],key==='priceCents'?(Number(value)/100).toFixed(2):String(value));
        expected[key]=value;
        now.fields[key].dispatchEvent(new Event('input',{bubbles:true}));now.fields[key].dispatchEvent(new Event('change',{bubbles:true}));
      }
      await new Promise(resolve=>setTimeout(resolve,300));
      const ready=listingOperationContext(g.action,g.externalListingId,g.variationId,true);
      if(!contextMatches(ready)||ready.button!==again.button||Object.entries(wanted).some(([k,v])=>ready.fields[k]!==again.fields[k]||ready.values[k]!==v||!ready.fields[k].checkValidity())||ready.button.disabled||ready.button.getAttribute('aria-disabled')==='true')throw Error('dados finais ou controle de salvar divergiram; revise manualmente');
      ready.button.click();
      return {outcome:'NEEDS_VERIFICATION',clicked:true,message:'controle de variação acionado. Confira o resultado antes de qualquer nova tentativa.'};
    }catch(error){return {outcome:touched?'NEEDS_VERIFICATION':'FAILED',message:String(error?.message||error).slice(0,1000)};}
  }

  async function publishApprovedChange(message) {
    const { task, item, externalListingId } = message ?? {};
    if (task?.mode !== 'PUBLISH') throw new Error('tarefa não possui autorização de publicação');
    if (!['edit_title', 'edit_description'].includes(task.kind)) throw new Error('tipo de alteração não permitido para publicação');
    if (!hasAuthenticatedSellerEditForm() || !item || currentExternalListingId() !== externalListingId) throw new Error('sessão ou anúncio não corresponde à aprovação');
    if (Number(item.copies ?? 1) !== 1 || item.cover_image_id) throw new Error('duplicação e troca de imagem não são permitidas neste fluxo');
    const titleSelectors = ['input[name="title"]', 'input#title', '[data-testid="title-input"]'];
    const descriptionSelectors = ['textarea[name="description"]', '.andes-textarea textarea', 'div[contenteditable="true"]'];
    const current = { title: readTaskField(titleSelectors), description: readTaskField(descriptionSelectors) };
    const before = { title: item.baselineTitle ?? null, description: item.baselineDescription ?? null };
    if (task.kind === 'edit_title' && (!item.title || current.title !== item.title || before.title === null || before.title === item.title)) throw new Error('o título visível ou o snapshot original não corresponde à alteração aprovada');
    if (task.kind === 'edit_description' && (!item.description_additions || !String(current.description ?? '').includes(item.description_additions) || before.description === null || String(before.description).includes(item.description_additions))) throw new Error('a descrição visível ou o snapshot original não corresponde ao acréscimo aprovado');
    const control = findExplicitSaveControl();
    if (!control) throw new Error('não foi encontrado exatamente um botão Salvar/Atualizar dentro do formulário do anúncio; nada foi enviado');
    const summary = task.kind === 'edit_title' ? `novo título: ${item.title}` : `acréscimo à descrição: ${item.description_additions}`;
    const prompt = `PUBLICAÇÃO AUTORIZADA\nAnúncio: ${externalListingId}\nMarketplace: mercado_livre\nAção: ${summary}\nBotão: ${control.label}\n\nConfirma que deseja clicar neste botão e salvar a alteração agora?`;
    if (typeof window.confirm !== 'function' || !window.confirm(prompt)) return { ok: false, cancelled: true, externalListingId, message: 'publicação cancelada pelo usuário', clicked: false };
    if (currentExternalListingId() !== externalListingId) throw new Error('o anúncio mudou antes do clique final');
    const existingMessages = new Set(Array.from(document.querySelectorAll('[role="alert"], [aria-live="polite"], [class*="snackbar"], [class*="toast"], [data-testid*="success"]'))
      .filter((element) => window.MI_DOM.isVisible(element))
      .map((element) => String(element.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
    control.element.click();
    const successText = await waitForSaveConfirmation(5000, existingMessages);
    const after = { title: readTaskField(titleSelectors), description: readTaskField(descriptionSelectors) };
    if (!successText) return { ok: false, uncertain: true, clicked: true, externalListingId, after, sourceUrl: location.href, saveButtonLabel: control.label, message: 'botão acionado, mas a interface não exibiu confirmação positiva; não retentar automaticamente' };
    if (task.kind === 'edit_title' && after.title !== item.title) return { ok: false, uncertain: true, clicked: true, externalListingId, after, sourceUrl: location.href, successText, saveButtonLabel: control.label, message: 'a interface exibiu sucesso, mas o título observado não corresponde ao aprovado' };
    if (task.kind === 'edit_description' && !String(after.description ?? '').includes(item.description_additions)) return { ok: false, uncertain: true, clicked: true, externalListingId, after, sourceUrl: location.href, successText, saveButtonLabel: control.label, message: 'a interface exibiu sucesso, mas a descrição observada não contém o trecho aprovado' };
    return { ok: true, published: true, verified: true, externalListingId, after, sourceUrl: location.href, successText, saveButtonLabel: control.label, message: 'alteração enviada após confirmação humana e confirmação positiva visível' };
  }

  // Responde à captura, ao executor de rascunhos e à publicação assistida explicitamente autorizada.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'MI_CAPTURE_REQUEST') {
      if (window.MI_DOM.hasChallenge(document) || document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')) {
        sendResponse({ ok: false, error: 'login/CAPTCHA: captura interrompida para verificação manual' });
        return true;
      }
      const readObserved=()=>{
        const observed=snapshot();
        observed.details=window.MI_DOM.visibleDetailRows?.(document,observed.pageKind)??[];
        if(['seller_dashboard','seller_orders','seller_ads','seller_reputation','seller_returns','seller_complaints','seller_inventory'].includes(observed.pageKind)) observed.chartPoints=window.MI_DOM.visibleChartPoints?.(document)?.points??[];
        if(observed.pageKind==='seller_reputation'){
          const rep=window.MI_DOM.observedReputation?.(document.body,'mercado_livre');
          if(rep&&Object.keys(rep.metrics).length){observed.accountMetrics={...observed.accountMetrics,...rep.metrics};observed.evidence={...observed.evidence,...rep.evidence};}
        }
        const filters=window.MI_DOM.collectionFilterState?.(document)??{signature:'',warnings:[]};
        observed.filterSignature=filters.signature;
        observed.spaPage=['seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory'].includes(observed.pageKind)?window.MI_DOM.spaPaginationState?.(document)?.page:undefined;
        observed.coverageWarnings=[...new Set([...filters.warnings,...(window.MI_DOM.collectionCoverage?.(document)??[])])];
        if(filters.signature) observed.evidence={...observed.evidence,filtersAndPeriod:filters.signature};
        return observed;
      };
      try {
        const observed=readObserved();
        if(message.virtualized===true&&observed.pageKind==='seller_listings'&&window.MI_DOM.collectVirtualizedListings){
          if(observed.accountId!==message.accountId||observed.url!==message.url||observed.filterSignature!==message.filterSignature||observed.spaPage!==message.spaPage)throw Error('contexto da rolagem não corresponde à aba verificada');
          window.MI_DOM.collectVirtualizedListings(document,observed,readObserved).then(result=>sendResponse({ok:true,snapshot:result})).catch(error=>sendResponse({ok:false,error:String(error?.message??error)}));
          return true;
        }
        if(message.virtualized===true&&['seller_questions','seller_reputation','seller_returns','seller_complaints'].includes(observed.pageKind)&&window.MI_DOM.collectVirtualizedFeedback){
          if(observed.accountId!==message.accountId||observed.url!==message.url||observed.filterSignature!==message.filterSignature||observed.spaPage!==message.spaPage)throw Error('contexto da rolagem não corresponde à aba verificada');
          window.MI_DOM.collectVirtualizedFeedback(document,observed,readObserved).then(result=>sendResponse({ok:true,snapshot:result})).catch(error=>sendResponse({ok:false,error:String(error?.message??error)}));
          return true;
        }
        sendResponse({ok:true,snapshot:observed});
      }
      catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); }
      return true;
    }
    if(message?.type==='MI_CAPTURE_REAPPLY_FILTERS'){
      const verify=()=>['seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory'].includes(currentPageKind())&&(currentPageKind()===message.pageKind||(!message.pageKind&&currentPageKind()==='seller_listings'))&&visibleAccountIdentity().accountId===message.accountId&&location.href===message.url&&!window.MI_DOM.hasChallenge(document)&&!document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]');
      const ok=Boolean(window.MI_DOM.restoreVisibleFilters?.(document,message.currentSignature,message.targetSignature,verify));
      sendResponse({ok});return false;
    }
    if(message?.type==='MI_CAPTURE_ADVANCE_SPA'){
      const kind=currentPageKind();
      const identity=visibleAccountIdentity();
      const filters=window.MI_DOM.collectionFilterState?.(document)??{signature:'',warnings:[]};
      const ok=['seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory'].includes(kind)&&(message.pageKind===kind||(!message.pageKind&&kind==='seller_listings'))&&identity.accountId===message.accountId&&location.href===message.url&&filters.signature===message.filterSignature&&!filters.warnings.length;
      if(ok&&message.reactive===true){
        window.MI_DOM.advanceSpaPageReactive(document,message.page).then(advanced=>sendResponse({ok:advanced})).catch(()=>sendResponse({ok:false}));return true;
      }
      sendResponse({ok:ok&&Boolean(window.MI_DOM.advanceSpaPage?.(document,message.page))});return false;
    }
    if (message?.type === 'MI_CAPTURE_PAGE_INFO') {
      const currentKind = currentPageKind();
      const filters=window.MI_DOM.collectionFilterState?.(document)??{signature:'',warnings:[]};
      sendResponse({
        filterSignature:filters.signature,
        spaPagination: (()=>{const state=['seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory'].includes(currentKind)?window.MI_DOM.spaPaginationState?.(document):null;return state?{page:state.page,canAdvance:state.canAdvance}:null;})(),
        coverageWarnings:[...new Set([...filters.warnings,...(window.MI_DOM.collectionCoverage?.(document)??[])])],
        ok: true,
        marketplace: 'mercado_livre',
        pageKind: currentKind,
        ...visibleAccountIdentity(),
        url: location.href,
        loginRequired: currentKind === 'login' || Boolean(document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')),
        challenge: window.MI_DOM.hasChallenge(document),
        nextPageUrl: currentKind.startsWith('seller_') && currentKind !== 'seller_listing_edit' ? window.MI_DOM.paginationInfo(document, location.href, 'mercado_livre') : null,
        paginationUnsupported: currentKind.startsWith('seller_') && Boolean(window.MI_DOM.paginationUnsupported?.(document,location.href,'mercado_livre')),
        authorizedAreaLinks: visibleAuthorizedAreaLinks(),
      });
      return false;
    }
    if(message?.type==='MI_LISTING_OPERATION_CONTEXT'){
      try{sendResponse({ok:true,...listingOperationPublicContext(message)});}catch(error){sendResponse({ok:false,error:String(error?.message||error)});}
      return false;
    }
    if(message?.type==='MI_LISTING_OPERATION_APPLY'){
      applyListingOperation(message.grant).then(sendResponse).catch(error=>sendResponse({outcome:'NEEDS_VERIFICATION',message:String(error?.message||error)}));return true;
    }
    if(message?.type==='MI_CAMPAIGN_BUDGET_CONTEXT'){
      try{sendResponse({ok:true,...budgetPublicContext(message.campaignRef)});}catch(error){sendResponse({ok:false,error:String(error?.message||error)});}
      return false;
    }
    if(message?.type==='MI_CAMPAIGN_BUDGET_APPLY'){
      applyCampaignBudget(message.grant).then(sendResponse).catch(error=>sendResponse({outcome:'NEEDS_VERIFICATION',message:String(error?.message||error)}));return true;
    }
    if (message?.type === 'MI_TASK_CONTEXT') {
      const current = currentPageKind();
      if (typeof window !== 'undefined') window.MI_LAST_PAGE_KIND = current;
      sendResponse({ ok: true, marketplace: 'mercado_livre', pageKind: current, externalListingId: currentExternalListingId(), ...visibleAccountIdentity(), sessionAuthenticated: hasAuthenticatedSellerEditForm() });
      return false;
    }
    if (message?.type === 'MI_TASK_APPLY_DRAFT') {
      applyDraft(message).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true;
    }
    if (message?.type === 'MI_TASK_PUBLISH_APPROVED') {
      publishApprovedChange(message).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err), clicked: false }));
      return true;
    }
    return false;
  });
})();
