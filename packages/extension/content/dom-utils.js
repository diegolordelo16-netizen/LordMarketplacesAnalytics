/**
 * Utilitários do DOM usados pelos content scripts.
 *
 * Este arquivo é injetado ANTES do content script de cada marketplace e publica
 * `window.MI_DOM`. Ele é declarado no manifest como primeiro arquivo da lista.
 *
 * Regras inegociáveis (§0.2, §13.2):
 *  - Só se lê o que está RENDERIZADO e visível para o usuário logado.
 *  - Nunca se lê cookie, localStorage de sessão, header ou token.
 *  - Nunca se chama endpoint privado: nenhum fetch/XHR aqui.
 *  - Todo número vem com a evidência textual (rótulo → texto lido) para auditoria.
 */
(function () {
  'use strict';

  /** Lê um número pt-BR ("1.234,56", "12,5%", "R$ 1.234"). null se não houver número. */
  function parseNumberPtBr(text) {
    if (text === null || text === undefined) return null;
    const raw = String(text).replace(/\u00a0/g, ' ').trim();
    const match = raw.match(/^(?:R\$\s*)?(-?\d[\d.,]*)(?:\s*(?:%|unidades?|vendidos?|pedidos?|visitas?|cliques?|impressões?))?$/i);
    if (!match) return null;
    const cleaned = match[1];
    if (!cleaned || !/\d/.test(cleaned)) return null;

    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    let normalized = cleaned;

    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
      else normalized = cleaned.replace(/,/g, '');
    } else if (lastComma > -1) {
      const decimals = cleaned.length - lastComma - 1;
      normalized = decimals === 3 ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
    } else if (lastDot > -1) {
      const decimals = cleaned.length - lastDot - 1;
      normalized = decimals === 3 ? cleaned.replace(/\./g, '') : cleaned;
    }

    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function normalizeLabel(text) {
    return String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/[.:]$/, '');
  }

  /** Procura o valor associado a um rótulo visível. Devolve { text, label, node } ou null. */
  function findValueByLabel(root, labels) {
    if (!root) return null;
    const wanted = labels.map(normalizeLabel);
    const nodes = root.querySelectorAll('div, span, td, th, dt, dd, li, p, label, strong, b');
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const raw = String(node.innerText ?? node.textContent ?? '').trim();
      const text = normalizeLabel(raw);
      if (!text || text.length > 80) continue;
      if (!wanted.some((w) => text === w || text.startsWith(w + ':') || text.startsWith(w + ' - '))) continue;
      const inline = raw.match(/[:\-]\s*(.+)$/);
      if (inline && parseNumberPtBr(inline[1]) !== null) return { text: inline[1].trim(), label: raw, node };
      const sibling = node.nextElementSibling;
      const siblingText = sibling && isVisible(sibling) ? String(sibling.innerText ?? sibling.textContent ?? '').trim() : '';
      if (siblingText && parseNumberPtBr(siblingText) !== null) return { text: siblingText, label: raw, node };
      const parent = node.parentElement;
      if (parent && isVisible(parent)) {
        const rest = String(parent.innerText ?? '').replace(raw, '').replace(/^\s*[:\-]\s*/, '').trim();
        if (rest && parseNumberPtBr(rest) !== null) return { text: rest, label: raw, node };
      }
    }
    return null;
  }

  /** Extrai o ID externo do anúncio a partir da URL (MLB123456, etc.). */
  function extractExternalId(url) {
    const m = String(url).match(/\b(ML[A-Z]?-?\d{5,})\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
  }

  /** Só aceita links seguintes HTTPS, same-origin e dentro dos hosts suportados. */
  function safeNextPageUrl(rawHref, currentUrl, marketplace) {
    try {
      const current = new URL(currentUrl);
      const next = new URL(rawHref, current);
      const hostAllowed = marketplace === 'mercado_livre'
        ? /(^|\.)mercadolivre\.com\.br$|(^|\.)mercadolibre\.com$/i.test(next.hostname)
        : marketplace === 'shopee'
          ? /(^|\.)shopee\.com\.br$/i.test(next.hostname)
          : marketplace === 'amazon' && next.hostname === 'sellercentral.amazon.com.br';
      if (!hostAllowed || current.protocol !== 'https:' || next.protocol !== 'https:') return null;
      if (next.origin !== current.origin || next.username || next.password) return null;
      if (next.pathname !== current.pathname) return null;
      return next.href;
    } catch {
      return null;
    }
  }

  function paginationInfo(root, currentUrl, marketplace) {
    const candidates = Array.from(root.querySelectorAll('a[rel="next"], a[aria-label], a[title], a[data-testid], a.pagination__next, a.next'));
    const labels = /\b(next|próxima|proxima|seguinte|siguiente|próximo|proximo|next page)\b/i;
    for (const anchor of candidates) {
      const label = normalizeLabel([anchor.getAttribute('aria-label'), anchor.getAttribute('title'), anchor.getAttribute('data-testid'), anchor.textContent].filter(Boolean).join(' '));
      const isNext = anchor.rel === 'next' || labels.test(label) || /pagination[-_ ]?next|next[-_ ]?page/i.test(label);
      if (!isNext || anchor.getAttribute('aria-disabled') === 'true' || anchor.hasAttribute('disabled')) continue;
      const href = safeNextPageUrl(anchor.href || anchor.getAttribute('href') || '', currentUrl, marketplace);
      if (href && isVisible(anchor)) return href;
    }
    return null;
  }

  function hasChallenge(root) {
    if (root.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [data-testid*="captcha" i], .g-recaptcha')) return true;
    const text = normalizeLabel(root.body?.innerText || '').slice(0, 12000);
    return /verify you are human|verifique que voce e humano|verifique se voce e humano|confirme que voce nao e um robo|complete o captcha|security check|human verification/.test(text);
  }

  /** Only explicit, visible text fields. Never use a static test-id as an item identity. */
  function visibleCustomerVoice(root, pageKind) {
    const spec = {
      seller_questions: ['QUESTION','question-text','question-content','question-description'],
      seller_reputation: ['REVIEW','review-text','review-content','feedback-comment'],
      seller_complaints: ['COMPLAINT','claim-description','complaint-description','dispute-description'],
      seller_returns: ['RETURN_REASON','return-reason','refund-reason','devolution-reason','motivo-devolucao'],
    }[pageKind];
    if (!spec) return [];
    const [kind, ...names] = spec;
    const selectors = names.flatMap(name => ['[data-testid*="' + name + '"]','[class*="' + name + '"]']).join(', ');
    const attrs = { QUESTION:['data-question-id'], REVIEW:['data-review-id','data-feedback-id'], COMPLAINT:['data-claim-id','data-dispute-id'], RETURN_REASON:['data-return-id','data-refund-id'] }[kind];
    const items = [], seen = new Set();
    for (const element of root.querySelectorAll(selectors)) {
      if (items.length >= 50 || !isVisible(element)) continue;
      const text = String(element.innerText ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 3 || text.length > 5000) continue;
      const row = element.closest([...attrs.map(attr => '[' + attr + ']'),'[data-id]'].join(', '));
      const ref = row && [...attrs,'data-id'].map(attr => row.getAttribute(attr)).find(value => value && /^[A-Za-z0-9_.:-]{1,150}$/.test(value));
      const key = ref ? 'id:' + ref : 'text:' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ kind, text, ...(ref ? { externalRef: ref } : {}) });
    }
    return items;
  }

  function paginationUnsupported(root,currentUrl,marketplace) {
    if (paginationInfo(root,currentUrl,marketplace)) return false;
    const selector='button[aria-label],button[title],button[data-testid],button.next,button.pagination__next,[role="button"][aria-label],a[rel="next"],a[aria-label],a[title],a[data-testid],a.next';
    for (const el of root.querySelectorAll(selector)) {
      if (!isVisible(el) || el.disabled || el.getAttribute('aria-disabled')==='true' || el.hasAttribute('disabled')) continue;
      const names=[el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-testid'),el.innerText ?? el.textContent].filter(Boolean).map(normalizeLabel);
      if (el.rel==='next' || names.some(name=>/^(next|próxima|proxima|seguinte|siguiente|próximo|proximo)(?:\s+(?:page|página|pagina))?$|pagination[-_ ]?next|next[-_ ]?page/i.test(name))) return true;
    }
    return false;
  }
  function explicitPercent(root, labels) {
    const found=findValueByLabel(root,labels);
    if (!found || !/%\s*$/.test(found.text)) return null;
    const value=parseNumberPtBr(found.text);
    return value!==null && value>=0 && value<=100 ? {value,evidence:String(found.label+': '+found.text).slice(0,200)} : null;
  }
  function observedExtraMetrics(root, listing=false) {
    const metrics={}, evidence={};
    const percentages={conversionRatePct:['taxa de conversão','conversion rate','tasa de conversión'],adConversionRatePct:['taxa de conversão de anúncios','ad conversion rate','taxa de conversão ads']};
    if (listing) percentages.promotionDiscountPct=['desconto promocional','percentual de desconto','promotion discount','discount percentage'];
    for (const [field,labels] of Object.entries(percentages)) {
      const found=explicitPercent(root,labels);
      if(found){metrics[field]=found.value;evidence[field]=found.evidence;}
    }
    const found=findValueByLabel(root,['cliques orgânicos','organic clicks']), clicks=found&&parseNumberPtBr(found.text);
    if(typeof clicks==='number'&&Number.isInteger(clicks)&&clicks>=0){metrics.organicClicks=clicks;evidence.organicClicks=String(found.label+': '+found.text).slice(0,200);}
    if(listing){
      const found=findValueByLabel(root,['preço original','preço anterior','original price','previous price']);
      const value=found&&parseNumberPtBr(found.text);
      if(typeof value==='number'&&value>=0){metrics.originalPrice=value;evidence.originalPrice=String(found.label+': '+found.text).slice(0,200);}
    }
    return {metrics,evidence};
  }
  window.MI_DOM = { paginationUnsupported, observedExtraMetrics, explicitPercent, visibleCustomerVoice, parseNumberPtBr, findValueByLabel, extractExternalId, isVisible, normalizeLabel, safeNextPageUrl, paginationInfo, hasChallenge };
})();
