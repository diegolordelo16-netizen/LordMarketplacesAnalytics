/**
 * Content script — roda no ISOLATED world.
 *
 * Papel na POC: reconhecer a página e a conta do marketplace e entregar ao
 * Side Panel um contexto honesto (o que foi reconhecido, o que não foi).
 * Não escreve na página, não chama endpoints privados, não lê cookies.
 */
import { detectPage, type PageContext } from "../adapters/detect-page.js";

function collect(): PageContext {
  return detectPage(window.location.href, document.title, document.body?.innerText ?? "");
}

// Responde a pedidos do Side Panel sobre a aba atual.
chrome.runtime.onMessage.addListener((message: { kind?: string }, _sender, sendResponse) => {
  if (message?.kind === "context.get") {
    sendResponse({ ok: true, context: collect() });
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
