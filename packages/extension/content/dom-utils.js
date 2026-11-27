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
    const cleaned = String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/[^\d.,-]/g, '')
      .trim();
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
      const text = normalizeLabel(node.textContent ?? '');
      if (!text || text.length > 80) continue;
      if (!wanted.some((w) => text === w || text.startsWith(w + ' ') || text.startsWith(w + ':'))) continue;

      const siblingText = node.nextElementSibling && node.nextElementSibling.textContent
        ? node.nextElementSibling.textContent.trim()
        : '';
      if (siblingText && siblingText.length <= 120 && /\d/.test(siblingText)) {
        return { text: siblingText, label: node.textContent.trim(), node };
      }

      const inline = (node.textContent || '').match(/[:\-]\s*(.+)$/);
      if (inline && /\d/.test(inline[1])) {
        return { text: inline[1].trim(), label: node.textContent.trim(), node };
      }

      const parentText = node.parentElement && node.parentElement.textContent
        ? node.parentElement.textContent.trim()
        : '';
      if (parentText && parentText.length <= 160 && parentText !== node.textContent.trim()) {
        const rest = parentText.replace(node.textContent, '').replace(/[:\-]/g, '').trim();
        if (rest && /\d/.test(rest)) return { text: rest, label: node.textContent.trim(), node };
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

  window.MI_DOM = { parseNumberPtBr, findValueByLabel, extractExternalId, isVisible, normalizeLabel, safeNextPageUrl, paginationInfo, hasChallenge };
})();
