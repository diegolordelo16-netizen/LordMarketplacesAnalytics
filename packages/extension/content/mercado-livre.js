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
    if (/\/(reputacao|reputación|reputation)\b/i.test(url)) return 'seller_reputation';
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
    const kind = pageKind === 'seller_complaints' ? 'COMPLAINT' : pageKind === 'seller_returns' ? 'RETURN_REASON' : null;
    if (!kind) return [];
    const selectors = kind === 'COMPLAINT'
      ? '[data-testid*="claim-description"], [data-testid*="complaint-description"], [class*="claim-description"], [class*="complaint-description"]'
      : '[data-testid*="return-reason"], [data-testid*="devolution-reason"], [class*="return-reason"], [class*="motivo-devolucao"]';
    const items = [];
    const seen = new Set();
    for (const element of Array.from(document.querySelectorAll(selectors))) {
      if (items.length >= 50 || !window.MI_DOM.isVisible(element)) continue;
      const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 3 || text.length > 5000 || seen.has(text)) continue;
      seen.add(text);
      const container = element.closest('[data-id], [data-testid*="claim"], [data-testid*="return"], tr');
      const externalRef = container?.getAttribute('data-id') || container?.getAttribute('data-testid') || undefined;
      items.push({ kind, text, ...(externalRef ? { externalRef: String(externalRef).slice(0, 200) } : {}) });
    }
    return items;
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
      try { sendResponse({ ok: true, snapshot: snapshot() }); }
      catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); }
      return true;
    }
    if (message?.type === 'MI_CAPTURE_PAGE_INFO') {
      const currentKind = currentPageKind();
      sendResponse({
        ok: true,
        marketplace: 'mercado_livre',
        pageKind: currentKind,
        ...visibleAccountIdentity(),
        url: location.href,
        loginRequired: currentKind === 'login' || Boolean(document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')),
        challenge: window.MI_DOM.hasChallenge(document),
        nextPageUrl: currentKind.startsWith('seller_') && currentKind !== 'seller_listing_edit' ? window.MI_DOM.paginationInfo(document, location.href, 'mercado_livre') : null,
        authorizedAreaLinks: visibleAuthorizedAreaLinks(),
      });
      return false;
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
