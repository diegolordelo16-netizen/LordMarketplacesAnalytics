/**
 * Service worker da extensão (MV3).
 *
 * Responsabilidades: abrir o Side Panel, guardar o pareamento, retomar a
 * conexão quando o worker acorda, e responder ao Side Panel. Não guarda
 * estado de negócio — o worker pode ser suspenso a qualquer momento.
 */
import { channel } from "../messaging/channel.js";

/**
 * Abre o dashboard em aba inteira, reaproveitando uma aba já aberta.
 *
 * Reaproveitar evita encher o navegador de dashboards a cada clique, e faz o
 * painel lateral e o serviço local levarem sempre para a MESMA tela.
 */
async function openDashboard(): Promise<void> {
  const url = chrome.runtime.getURL("dashboard.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url === url || t.url?.startsWith(url));
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  // Na primeira instalação, abre o dashboard: é a tela principal do produto.
  void openDashboard();
});

// Rede de segurança: se o service worker acordar e o dashboard não existir,
// nada quebra — o botão do painel sempre tem para onde ir.
chrome.runtime.onStartup.addListener(() => {
  void channel.resume();
});

// O dashboard em aba inteira pede para ser aberto (a partir do painel lateral).
chrome.runtime.onMessage.addListener((message: { kind?: string }, _sender, sendResponse) => {
  if (message.kind === "open.dashboard") {
    void openDashboard()
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  return undefined;
});

// Retoma o pareamento salvo quando o worker acorda.
void channel.resume();

interface SidePanelRequest {
  kind: "channel.status" | "channel.connect" | "channel.disconnect" | "channel.request";
  url?: string;
  token?: string;
  namespace?: string;
  payload?: unknown;
}

chrome.runtime.onMessage.addListener((message: SidePanelRequest, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message.kind) {
        case "channel.status":
          sendResponse({ ok: true, status: channel.getStatus() });
          return;
        case "channel.connect": {
          if (!message.url || !message.token) {
            sendResponse({ ok: false, error: "URL e token são obrigatórios" });
            return;
          }
          const status = await channel.connect(message.url, message.token);
          sendResponse({ ok: true, status });
          return;
        }
        case "channel.disconnect":
          channel.disconnect();
          sendResponse({ ok: true, status: channel.getStatus() });
          return;
        case "channel.request": {
          const result = await channel.request(
            (message.namespace ?? "system") as Parameters<typeof channel.request>[0],
            message.payload,
          );
          sendResponse({ ok: true, result });
          return;
        }
        default:
          sendResponse({ ok: false, error: `kind desconhecido: ${String(message.kind)}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // resposta assíncrona
});
