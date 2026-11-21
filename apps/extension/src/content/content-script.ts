/**
 * Content script — roda no ISOLATED world.
 *
 * Papel: reconhecer a página e a conta, e entregar ao Side Panel o HTML que a
 * página JÁ renderizou quando ele pedir para capturar.
 *
 * Limites que este arquivo respeita:
 *  - não escreve na página, não clica em nada, não chama endpoint privado;
 *  - não lê cookie, localStorage nem sessionStorage;
 *  - só devolve HTML de página reconhecida; fora dela, recusa com motivo.
 */
import { detectPage, type PageContext } from "../adapters/detect-page.js";

/** Tamanho máximo do HTML entregue (o protocolo também tem limite próprio). */
const MAX_HTML_BYTES = 512 * 1024;

function collect(): PageContext {
  return detectPage(window.location.href, document.title, document.body?.innerText ?? "");
}

/** Serializa a página sem scripts: nada de código executável vai junto. */
function serializePage(): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll("script, noscript")) el.remove();
  for (const el of clone.querySelectorAll("*")) {
    // remove handlers inline; o serviço só precisa de estrutura e texto
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
    }
  }
  return `<!doctype html>${clone.outerHTML}`;
}

chrome.runtime.onMessage.addListener((message: { kind?: string }, _sender, sendResponse) => {
  if (message?.kind === "context.get") {
    sendResponse({ ok: true, context: collect() });
    return false;
  }

  if (message?.kind === "capture.html") {
    const context = collect();
    if (context.marketplace === "unknown" || context.pageKind === "unknown") {
      sendResponse({
        ok: false,
        error: "Esta aba não é uma página de marketplace reconhecida.",
        context,
      });
      return false;
    }
    const html = serializePage();
    const bytes = new TextEncoder().encode(html).length;
    if (bytes > MAX_HTML_BYTES) {
      sendResponse({
        ok: false,
        error: `Página grande demais para captura (${Math.round(bytes / 1024)} KB). Role até os anúncios e tente de novo.`,
        context,
      });
      return false;
    }
    sendResponse({ ok: true, html, context });
    return false;
  }

  return false;
});

// Avisa o Side Panel quando a URL muda (SPA sem recarregar página).
let lastUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    void chrome.runtime.sendMessage({ kind: "context.changed", context: collect() }).catch(() => undefined);
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });
