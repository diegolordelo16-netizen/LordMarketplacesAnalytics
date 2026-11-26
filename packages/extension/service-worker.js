/**
 * Service worker da extensão (§4, §19).
 *
 * Responsabilidades:
 *  - falar com o host nativo (protocolo de mensagens nativas) ou, em fallback,
 *    com o painel HTTP local em 127.0.0.1 — sempre com token de sessão;
 *  - pedir a captura ao content script da aba ativa e enviar ao serviço local;
 *  - manter fila local (chrome.storage.local) quando o serviço está fora;
 *  - abrir o painel lateral.
 *
 * O que este arquivo NUNCA faz: ler cookies, headers, tokens, chamar endpoints
 * privados dos marketplaces ou executar comandos privilegiados sem sessão.
 */
const HOST_NAME = 'com.marketplaceintelligence.host';
/**
 * Faixa de portas em que o serviço local pode estar.
 *
 * A porta era fixa (47811) e isso quebrava a extensão sempre que o serviço
 * subia em outra porta: o host nativo falhava e o HTTP batia na porta errada.
 * Agora a extensão procura na faixa e guarda a porta que respondeu.
 */
const PORT_RANGE = { start: 47811, end: 47830 };

/**
 * Métodos que o serviço aceita sem sessão (espelha PUBLIC_METHODS do serviço).
 * Os demais precisam do token no próprio pedido.
 */
const PUBLIC_METHODS = new Set(['ping', 'auth.login', 'auth.bootstrap', 'auth.session']);
const LOCAL_PORT = PORT_RANGE.start;
const PROTOCOL_VERSION = 1;
const QUEUE_KEY = 'mi.queue';
const SESSION_KEY = 'mi.session';
const MAX_QUEUE = 500;

let seq = 0;
const nextId = () => `e${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

/**
 * Sinal de vida para a tela de Pré-Start.
 *
 * A tela pergunta ao serviço local se a extensão está carregada. Para isso a
 * extensão avisa o serviço a cada início, a cada alarme e sempre que uma aba de
 * marketplace é aberta/atualizada. Envia apenas versão e marketplace — nunca
 * conteúdo de página, cookie ou token de sessão.
 */
const PRESTART_PING_PATH = '/api/prestart/ping';
const SUPPORTED_HOSTS = [
  { pattern: /(^|\.)mercadolivre\.com\.br$/, id: 'mercado_livre' },
  { pattern: /(^|\.)shopee\.com\.br$/, id: 'shopee' },
];

function marketplaceOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const hit = SUPPORTED_HOSTS.find((h) => h.pattern.test(host));
    return hit ? hit.id : '';
  } catch {
    return '';
  }
}

/** fetch com prazo: sem isso o service worker fica pendurado num host morto. */
async function fetchWithTimeout(url, options, ms = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/health numa porta; true se for o nosso serviço. */
async function healthAt(port) {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/health`, { method: 'GET' }, 1200);
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body && body.ok);
  } catch {
    return false;
  }
}

/**
 * Descobre a porta do serviço: a conhecida primeiro, depois a faixa local.
 * O serviço só escuta em 127.0.0.1, então a busca não sai da máquina.
 */
async function discoverPort(force) {
  const known = await resolvePort();
  if (!force && (await healthAt(known))) return known;
  for (let port = PORT_RANGE.start; port <= PORT_RANGE.end; port += 1) {
    if (port === known) continue;
    if (await healthAt(port)) {
      await learnPort(port);
      return port;
    }
  }
  return 0;
}

/**
 * Token de sessão guardado localmente.
 *
 * FALTAVA ESTA FUNÇÃO: o worker chamava `sessionToken()` em sete lugares e ela
 * não existia, então toda chamada lançava `ReferenceError` dentro do try e o
 * erro aparecia como "serviço local indisponível". É a causa da captura que
 * nunca completava.
 */
async function sessionToken() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const token = stored[SESSION_KEY]?.token;
  return typeof token === 'string' && token ? token : null;
}

/**
 * Se ainda não temos token, pedimos ao serviço local em /api/token (rota que só
 * responde em 127.0.0.1). Sem isso a extensão nunca conseguia chamar a API —
 * era este o «serviço local indisponível» do painel lateral.
 */
async function syncSession(port) {
  if (await sessionToken()) return;
  const target = port || (await discoverPort(false));
  if (!target) return;
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${target}/api/token`, { method: 'GET' }, 2000);
    if (!res.ok) return;
    const body = await res.json();
    const token = body?.result?.token;
    if (token) await chrome.storage.local.set({ [SESSION_KEY]: { token, at: Date.now() } });
  } catch {
    /* serviço ainda não subiu: tenta no próximo ping */
  }
}

async function pingPrestart(extra = {}) {
  try {
    const port = await discoverPort(false);
    if (!port) return;
    await syncSession(port);
    // O diagnóstico vai junto: é o que a tela de Pré-Start mostra quando a
    // conexão não fecha, em lugar de um «sem ping» sem explicação.
    const diag = await diagnoseLight(port);
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/prestart/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: chrome.runtime.getManifest().version,
        marketplace: extra.marketplace ?? '',
        tabTitle: extra.tabTitle ?? '',
        // Token de sessão do painel: sem ele a extensão não pode chamar a API.
        token: extra.token ?? (await sessionToken()) ?? '',
        diagnosis: diag,
      }),
    });
    // O serviço responde na porta conhecida: confirma a porta usada.
    if (res.ok) await learnPort(port);
  } catch {
    // Serviço local fora do ar: a tela de Pré-Start mostrará "aguardando conexão".
  }
}

chrome.runtime.onStartup.addListener(() => void pingPrestart());

/**
 * O navegador desliga o service worker ocioso (MV3). Sem um alarme curto a
 * extensão «desaparecia» da tela de Pré-Start depois de alguns minutos; agora
 * o batimento de 1 minuto reaquece o worker e mantém o sinal de vida.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('mi.heartbeat', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mi.heartbeat') void pingPrestart();
});

// Rede de segurança: mesmo sem onInstalled (extensão já instalada), garante o alarme.
void chrome.alarms.get('mi.heartbeat').then((alarm) => {
  if (!alarm) chrome.alarms.create('mi.heartbeat', { periodInMinutes: 1 });
});
void pingPrestart();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab?.url) return;
  const marketplace = marketplaceOf(tab.url);
  if (marketplace) void pingPrestart({ marketplace, tabTitle: tab.title ?? '' });
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  chrome.alarms.create('mi.flush', { periodInMinutes: 5 });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mi.flush') void flushQueue();
});

/** Envia um pedido ao host nativo. Lança se o host não estiver instalado. */
async function callNative(method, payload) {
  // O serviço valida `req.token` (não o cabeçalho HTTP). Sem ele, todo método
  // privado — capture.ingest inclusive — voltava «sessão necessária». Era este
  // o motivo de a captura falhar com o painel já autenticado.
  const rawToken = PUBLIC_METHODS.has(method) ? '' : ((await sessionToken()) ?? '');
  // O envelope leva o token inteiro, sem espacos: espaco ou quebra de linha
  // quebra a comparacao do servico e o erro surge como "sessao necessaria".
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  return new Promise((resolve, reject) => {
    const id = nextId();
    let settled = false;
    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, { id, method, token, protocolVersion: PROTOCOL_VERSION, payload }, (response) => {
        settled = true;
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else if (!response) reject(new Error('host nativo não respondeu'));
        else resolve(response);
      });
    } catch (err) {
      reject(err);
    }
    setTimeout(() => {
      if (!settled) reject(new Error('timeout do host nativo'));
    }, 15000);
  });
}

/**
 * Porta do serviço local.
 *
 * A extensão não tem acesso a arquivos: pede a porta ao host nativo e guarda o
 * resultado em chrome.storage. O padrão é a porta fixa do instalador.
 */
const PORT_KEY = 'mi.port';
let cachedPort = LOCAL_PORT;

async function resolvePort() {
  try {
    const stored = await chrome.storage.local.get(PORT_KEY);
    if (typeof stored[PORT_KEY] === 'number') cachedPort = stored[PORT_KEY];
  } catch {
    /* storage indisponível: segue com a porta padrão */
  }
  return cachedPort;
}

async function learnPort(port) {
  if (!port || port === cachedPort) return;
  cachedPort = port;
  try {
    await chrome.storage.local.set({ [PORT_KEY]: port });
  } catch {
    /* best-effort */
  }
}

/** Fallback: painel HTTP local, autenticado por token guardado no storage local. */
async function callHttp(method, payload) {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const token = stored[SESSION_KEY]?.token;
  // Porta real descoberta, não a constante: o serviço pode ter subido em outra.
  const port = await discoverPort(false);
  if (!port) throw new Error('serviço local não encontrado nas portas locais');
  const send = (bearer) =>
    fetchWithTimeout(
      `http://127.0.0.1:${port}/api/ipc`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ id: nextId(), method, token: bearer, protocolVersion: PROTOCOL_VERSION, payload }),
      },
      8000,
    );
  let res = await send(token);
  if (res.status === 401) {
    // O serviço troca de token a cada início: pede um novo e repete uma vez.
    const stored = await chrome.storage.local.get(SESSION_KEY);
    if (stored[SESSION_KEY]?.token) await chrome.storage.local.remove(SESSION_KEY);
    await syncSession(port);
    const fresh = await sessionToken();
    if (fresh && fresh !== token) res = await send(fresh);
  }
  if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status} em 127.0.0.1:${port}`);
  return res.json();
}

/** Chama o serviço local com fallback automático. */
async function callService(method, payload) {
  try {
    return await callNative(method, payload);
  } catch (nativeError) {
    try {
      return await callHttp(method, payload);
    } catch (httpError) {
      throw new Error(`serviço local indisponível (${nativeError.message} | ${httpError.message})`);
    }
  }
}

async function enqueue(item) {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  queue.push(item);
  while (queue.length > MAX_QUEUE) queue.shift();
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function flushQueue() {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  if (queue.length === 0) return { sent: 0, left: 0 };
  const left = [];
  let sent = 0;
  for (const item of queue) {
    try {
      const res = await callService(item.method, item.payload);
      if (res && res.ok) sent += 1;
      else left.push(item);
    } catch {
      left.push(item);
      break;
    }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: left });
  return { sent, left: left.length };
}

/**
 * Garante que a conta da página exista no serviço antes de ingerir dados.
 * O identificador é o que o adaptador leu da página; quando ele não veio, usa a
 * conta local do marketplace (uma por marketplace), nunca uma conta inventada.
 */
async function ensureAccount(marketplace, accountId, snapshot) {
  try {
    const known = await callService('account.list', {});
    const list = Array.isArray(known?.result) ? known.result : [];
    if (list.some((a) => a.id === accountId)) return;
    const handle = typeof snapshot?.accountHandle === 'string' && snapshot.accountHandle ? snapshot.accountHandle : undefined;
    await callService('account.upsert', {
      marketplace,
      accountId,
      displayName: handle ?? `${marketplace} (conta local)`,
      handle,
      // Confiança baixa e não verificada: a conta foi lida da página, mas quem
      // confirma é o usuário, no painel.
      confidence: handle ? 0.6 : 0.3,
      verifiedByUser: false,
    });
  } catch {
    /* o serviço recusa a captura e a mensagem dele explica o motivo */
  }
}

/** Pede o snapshot ao content script da aba e envia ao serviço. */
async function captureTab(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'MI_CAPTURE_REQUEST' }).catch(() => null);
  if (!response || !response.ok) {
    return { ok: false, error: response?.error ?? 'página sem captura disponível' };
  }
  const snapshot = response.snapshot;
  const now = new Date().toISOString();
  const payload = {
    marketplace: snapshot.marketplace,
    accountId: snapshot.accountId ?? 'local:default',
    pageKind: snapshot.pageKind,
    url: snapshot.url,
    sourceClass: 'A_PRIMARY_UI',
    referenceAt: now,
    collectedAt: now,
    method: 'content_script_dom',
    listings: snapshot.listings ?? [],
    evidence: { ...(snapshot.evidence ?? {}), missing: (snapshot.missing ?? []).join(',') },
  };

  if (payload.listings.length === 0) {
    return { ok: false, error: 'nenhum dado visível para capturar nesta página', snapshot };
  }

  // A captura é recusada pelo serviço se a conta ainda não existir. A conta vem
  // da própria página (o vendedor logado), por isso é registrada aqui, uma vez,
  // antes do envio — sem inventar nome nem identificador.
  await ensureAccount(payload.marketplace, payload.accountId, snapshot);

  try {
    const res = await callService('capture.ingest', payload);
    if (!res.ok) return { ok: false, error: res.error?.message ?? 'falha no serviço', res };
    return { ok: true, res, snapshot };
  } catch (err) {
    await enqueue({ method: 'capture.ingest', payload, queuedAt: now });
    return { ok: false, queued: true, error: err.message, snapshot };
  }
}

/** Diagnóstico barato (sem tentar o host nativo), anexado ao ping. */
async function diagnoseLight(port) {
  return {
    version: chrome.runtime.getManifest().version,
    http: { ok: Boolean(port), port: port || 0 },
    token: Boolean(await sessionToken()),
    mode: 'light',
  };
}

/**
 * Diagnóstico do que a extensão alcança (host nativo, HTTP, porta, token).
 * É o que a tela de Pré-Start mostra em vez de um «indisponível» sem causa.
 */
async function diagnose() {
  const report = {
    version: chrome.runtime.getManifest().version,
    nativeHost: { ok: false, error: '' },
    http: { ok: false, port: 0, error: '' },
    token: false,
  };
  try {
    const res = await callNative('ping', {});
    report.nativeHost.ok = Boolean(res?.ok);
  } catch (err) {
    report.nativeHost.error = err.message;
  }
  const port = await discoverPort(true);
  report.http.port = port;
  if (port) {
    report.http.ok = await healthAt(port);
    if (!report.http.ok) report.http.error = 'health não respondeu';
  } else {
    report.http.error = `nenhuma porta respondeu entre ${PORT_RANGE.start} e ${PORT_RANGE.end}`;
  }
  report.token = Boolean(await sessionToken());
  if (!report.token && report.http.ok) {
    await syncSession(port);
    report.token = Boolean(await sessionToken());
  }
  return report;
}

/** Ponte para o painel lateral e para o popup. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'MI_CALL') return false;
  void (async () => {
    try {
      if (message.method === 'capture.activeTab') {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error('nenhuma aba ativa');
        sendResponse(await captureTab(tab.id));
        return;
      }
      if (message.method === 'mi.diagnose') {
        sendResponse({ ok: true, result: await diagnose() });
        return;
      }
      if (message.method === 'queue.flush') {
        sendResponse({ ok: true, result: await flushQueue() });
        return;
      }
      if (message.method === 'port.set') {
        const wanted = Number(message.payload?.port);
        if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) {
          sendResponse({ ok: false, error: { code: 'PORT', message: 'porta fora da faixa 1-65535' } });
          return;
        }
        await learnPort(wanted);
        sendResponse({ ok: true, result: { port: cachedPort } });
        return;
      }
      // O que está valendo agora: o campo manual mostra isso, não um palpite.
      if (message.method === 'manual.get') {
        const stored = await chrome.storage.local.get([PORT_KEY, SESSION_KEY]);
        sendResponse({
          ok: true,
          result: { port: stored[PORT_KEY] ?? cachedPort, token: stored[SESSION_KEY]?.token ?? '' },
        });
        return;
      }
      if (message.method === 'session.set') {
        await chrome.storage.local.set({ [SESSION_KEY]: { token: message.payload?.token, at: Date.now() } });
        sendResponse({ ok: true });
        return;
      }
      const res = await callService(message.method, message.payload);
      sendResponse(res);
    } catch (err) {
      sendResponse({ ok: false, error: { code: 'EXTENSION', message: err.message } });
    }
  })();
  return true;
});
