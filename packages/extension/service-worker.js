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
  { pattern: /^sellercentral\.amazon\.com\.br$/, id: 'amazon' },
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
async function discoverPort() {
  const known = await resolvePort();
  if (await healthAt(known)) return known;
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
  const target = port || (await discoverPort());
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
    const port = await discoverPort();
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

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('mi.sync', { periodInMinutes: 1 });
  void pingPrestart();
  void processScheduledSyncs();
});

/**
 * O navegador desliga o service worker ocioso (MV3). Sem um alarme curto a
 * extensão «desaparecia» da tela de Pré-Start depois de alguns minutos; agora
 * o batimento de 1 minuto reaquece o worker e mantém o sinal de vida.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('mi.heartbeat', { periodInMinutes: 1 });
  chrome.alarms.create('mi.tasks', { periodInMinutes: 1 });
  chrome.alarms.create('mi.sync', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mi.heartbeat') void pingPrestart();
  if (alarm.name === 'mi.tasks') { void processDraftTasks(); void processPublishTasks(); }
  if (alarm.name === 'mi.sync') void processScheduledSyncs();
});

// Rede de segurança: mesmo sem onInstalled (extensão já instalada), garante o alarme.
void chrome.alarms.get('mi.heartbeat').then((alarm) => {
  if (!alarm) chrome.alarms.create('mi.heartbeat', { periodInMinutes: 1 });
  chrome.alarms.get('mi.tasks').then((taskAlarm) => {
    if (!taskAlarm) chrome.alarms.create('mi.tasks', { periodInMinutes: 1 });
  });
  chrome.alarms.get('mi.sync').then((syncAlarm) => {
    if (!syncAlarm) chrome.alarms.create('mi.sync', { periodInMinutes: 1 });
  });
  chrome.alarms.get('mi.flush').then((alarm) => {
    if (!alarm) chrome.alarms.create('mi.flush', { periodInMinutes: 5 });
  });
});
void pingPrestart();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab?.url) return;
  const marketplace = marketplaceOf(tab.url);
  if (marketplace) {
    void pingPrestart({ marketplace, tabTitle: tab.title ?? '' });
    void processDraftTasks();
    void processPublishTasks();
    void processScheduledSyncs();
  }
});

chrome.tabs.onActivated.addListener(() => {
  void processPublishTasks();
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
  const port = await discoverPort();
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

let queueWork = Promise.resolve();
function withQueue(operation) {
  const result = queueWork.then(operation);
  queueWork = result.catch(() => undefined);
  return result;
}

function enqueue(items) {
  return withQueue(async () => {
    const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
    if (queue.length + items.length > MAX_QUEUE) throw new Error('fila local cheia; envie as capturas pendentes');
    await chrome.storage.local.set({ [QUEUE_KEY]: [...queue, ...items] });
  });
}

function captureAccepted(response) {
  return response?.ok === true && response.result?.ok !== false;
}

function flushQueue() {
  return withQueue(async () => {
    const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
    let sent = 0;
    for (let index = 0; index < queue.length;) {
      const item = queue[index];
      try {
        if (item.method === 'account.upsert') {
          await ensureAccount(item.payload.marketplace, item.payload.accountId, { accountHandle: item.payload.handle });
        } else {
          if (item.account) await ensureAccount(item.account.marketplace, item.payload.accountId, item.account);
          if (!captureAccepted(await callService(item.method, item.payload))) {
            index += 1;
            continue;
          }
        }
      } catch {
        break;
      }
      queue.splice(index, 1);
      await chrome.storage.local.set({ [QUEUE_KEY]: queue });
      sent += 1;
    }
    return { sent, left: queue.length };
  });
}

/**
 * Garante que a conta da página exista no serviço antes de ingerir dados.
 * O identificador é derivado de um nome de conta visível no painel autenticado.
 * Sem identidade estável, a captura é interrompida: nunca agrupa vendedores diferentes.
 */
async function ensureAccount(marketplace, accountId, snapshot) {
  if (!accountId || accountId === 'local:default') throw new Error('identidade da conta do vendedor não foi encontrada na interface; capture foi interrompida para não misturar contas');
  try {
    const known = await callService('account.list', {});
    if (!known?.ok || !Array.isArray(known.result)) throw new Error('consulta de contas indisponível');
    const account = known.result.find((item) => item.id === accountId);
    if (account) {
      if (account.marketplace !== marketplace || account.is_active !== 1) throw new Error('conta inativa ou de outro marketplace');
      return;
    }
    const handle = typeof snapshot?.accountHandle === 'string' && snapshot.accountHandle ? snapshot.accountHandle : undefined;
    const created = await callService('account.upsert', {
      marketplace,
      accountId,
      displayName: handle ?? `${marketplace} (conta local)`,
      handle,
      // Confiança baixa e não verificada: a conta foi lida da página, mas quem
      // confirma é o usuário, no painel.
      confidence: handle ? 0.6 : 0.3,
      verifiedByUser: false,
    });
    if (!captureAccepted(created)) throw new Error(created?.error?.message ?? 'cadastro da conta recusado');
  } catch {
    throw new Error('não foi possível registrar a identidade da conta; confirme a conta no painel antes de capturar');
  }
}

/** Pede o snapshot ao content script da aba e envia ao serviço. */
async function captureTab(tabId, expected = {}) {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'MI_CAPTURE_REQUEST', ...(expected.virtualized?{virtualized:true,accountId:expected.accountId,url:expected.url,filterSignature:expected.filterSignature,spaPage:expected.spaPage}:{}) }).catch(() => null);
  if (!response || !response.ok) {
    return { ok: false, error: response?.error ?? 'página sem captura disponível' };
  }
  const snapshot = response.snapshot;
  const listingFingerprint=JSON.stringify((snapshot.initialListingIds??(snapshot.listings??[]).map(row=>String(row.listingId))).sort());
  if(expected.excludedListingIds&&(snapshot.listings??[]).some(row=>expected.excludedListingIds.has(String(row.listingId))))return {ok:false,error:'anúncios já capturados nesta varredura'};
  if ((expected.spaPage!==undefined&&snapshot.spaPage!==expected.spaPage)||(expected.listingFingerprint!==undefined&&listingFingerprint!==expected.listingFingerprint)||(expected.accountId && snapshot.accountId !== expected.accountId) ||
      (expected.url && snapshot.url !== expected.url) || (expected.filterSignature!==undefined && snapshot.filterSignature!==expected.filterSignature)) {
    return { ok: false, error: 'a conta, página ou filtros mudaram antes da captura' };
  }
  const now = new Date().toISOString();
  const payload = {
    marketplace: snapshot.marketplace,
    accountId: snapshot.accountId ?? null,
    pageKind: snapshot.pageKind,
    url: snapshot.url,
    sourceClass: 'A_PRIMARY_UI',
    referenceAt: now,
    collectedAt: now,
    method: 'content_script_dom',
    ...(expected.captureKey ? { captureKey: expected.captureKey } : {}),
    ...(typeof snapshot.filterSignature==='string'?{filterSignature:snapshot.filterSignature}:{}),
    listings: snapshot.listings ?? [],
    details: Array.isArray(snapshot.details) ? snapshot.details.slice(0,100) : [],
    ...(snapshot.accountMetrics ? { accountMetrics: snapshot.accountMetrics } : {}),
    evidence: { ...(snapshot.evidence ?? {}), missing: (snapshot.missing ?? []).join(','), ...(snapshot.coverageWarnings?.length?{coverageWarnings:snapshot.coverageWarnings.join(',')}: {}) },
  };

  const customerVoice = Array.isArray(snapshot.customerVoice) ? snapshot.customerVoice.slice(0, 200) : [];
  if (payload.listings.length === 0 && !payload.accountMetrics && payload.details.length===0 && customerVoice.length === 0) {
    return { ok: false, error: 'nenhum dado visível para capturar nesta página', snapshot };
  }
  if (!payload.accountId) return { ok: false, error: 'identidade da conta não identificada; abra uma área do vendedor que mostre o nome da conta', snapshot };

  // A captura é recusada pelo serviço se a conta ainda não existir. A conta vem
  // da própria página (o vendedor logado), por isso é registrada aqui, uma vez,
  // antes do envio — sem inventar nome nem identificador.
  const account = { marketplace: payload.marketplace, accountHandle: snapshot.accountHandle };
  const pending = [];
  if (payload.listings.length || payload.accountMetrics || payload.details.length) pending.push({ method: 'capture.ingest', payload, account, queuedAt: now });
  if (customerVoice.length) pending.push({
    method: 'voc.ingestBatch',
    payload: { accountId: payload.accountId, sourceClass: 'A_PRIMARY_UI', items: customerVoice, ...(expected.captureKey ? { captureKey: expected.captureKey, sourceUrl: payload.url, filterSignature:payload.filterSignature } : {}) },
    account, queuedAt: now,
  });
  try {
    await ensureAccount(payload.marketplace, payload.accountId, snapshot);
    let captureResult = null;
    if (payload.listings.length || payload.accountMetrics || payload.details.length) {
      captureResult = await callService('capture.ingest', payload);
      if (!captureAccepted(captureResult)) return { ok: false, error: captureResult.error?.message ?? captureResult.result?.errors?.[0] ?? 'falha no serviço', res: captureResult };
      pending.shift();
    }
    let voiceResult = null;
    if (customerVoice.length) {
      voiceResult = await callService('voc.ingestBatch', { accountId: payload.accountId, sourceClass: 'A_PRIMARY_UI', items: customerVoice, ...(expected.captureKey ? { captureKey: expected.captureKey, sourceUrl: payload.url, filterSignature:payload.filterSignature } : {}) });
      if (!captureAccepted(voiceResult)) return { ok: false, error: voiceResult.error?.message ?? 'falha ao registrar avaliações/reclamações', res: voiceResult };
      pending.shift();
    }
    return { ok: true, res: captureResult, voice: voiceResult, snapshot };
  } catch (err) {
    try { await enqueue(pending); }
    catch (error) { return { ok: false, error: error.message, snapshot }; }
    return { ok: false, queued: true, error: err.message, snapshot };
  }
}

/** Espera uma navegação completa sem depender de endpoints privados. */
function waitForTabComplete(tabId, expectedUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error); else resolve(tab);
    };
    const onUpdated = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId || changeInfo.status !== 'complete') return;
      if (tab?.url && tab.url === expectedUrl) finish(null, tab);
    };
    const timer = setTimeout(() => finish(new Error('tempo esgotado aguardando a próxima página')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && tab.url === expectedUrl) finish(null, tab);
    }).catch((err) => finish(err));
  });
}

async function readCapturePageInfo(tabId) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const info = await chrome.tabs.sendMessage(tabId, { type: 'MI_CAPTURE_PAGE_INFO' }).catch(() => null);
    if (info?.ok) return info;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

/**
 * Coleta paginada, iniciada pelo usuário, em uma aba temporária inativa.
 * Só segue links next visíveis, no mesmo origin e na rota atual de anúncios.
 * Limite rígido de cinco páginas; CAPTCHA/login interrompem a operação.
 */
async function captureListingPages(sourceTabId, requestedMaxPages = 5) {
  const source=await chrome.tabs.get(sourceTabId);
  const marketplace=marketplaceOf(source.url||'');
  if(!marketplace)return {ok:false,error:'aba não pertence a marketplace suportado'};
  const origin=new URL(source.url).origin;
  const initialInfo=await chrome.tabs.sendMessage(sourceTabId,{type:'MI_CAPTURE_PAGE_INFO'}).catch(()=>null);
  if(!initialInfo?.ok||initialInfo.pageKind!=='seller_listings'||!initialInfo.accountId||initialInfo.loginRequired||initialInfo.challenge)return {ok:false,error:'abra uma lista de anúncios autenticada com conta identificada'};
  const valid=info=>info?.ok&&info.marketplace===marketplace&&info.pageKind==='seller_listings'&&info.accountId===initialInfo.accountId&&info.filterSignature===initialInfo.filterSignature&&!info.loginRequired&&!info.challenge&&!info.coverageWarnings?.includes('FILTRO_NAO_RECONHECIDO');
  const maxPages=Math.max(1,Math.min(5,Number.isInteger(requestedMaxPages)?requestedMaxPages:5));
  const temporary=await chrome.tabs.create({url:source.url,active:false,windowId:source.windowId});
  const pages=[],seenIds=new Set(),seenPages=new Set();
  let stoppedReason='limite de páginas atingido',complete=false;
  const filterQuery=url=>JSON.stringify([...new URL(url).searchParams.entries()].filter(([key])=>!/^(page|page_number|p|offset|limit)$/i.test(key)).sort());
  try{
    let expectedPage=initialInfo.spaPagination?.page,previousFingerprint=null;
    for(let index=0;index<maxPages;index++){
      let info,preview,fingerprint;
      // Wait until page marker and rendered listing identities agree twice.
      for(let attempt=0;attempt<12;attempt++){
        info=await readCapturePageInfo(temporary.id);
        if(!valid(info)){stoppedReason='conta, filtros, login ou área divergentes';break;}
        const url=normalizeAuthorizedAreaUrl(info.url,origin,marketplace);
        if(!url||filterQuery(url.href)!==filterQuery(source.url)){stoppedReason='URL ou filtros divergentes';break;}
        if(expectedPage!==undefined&&info.spaPagination?.page!==expectedPage){await new Promise(resolve=>setTimeout(resolve,400));continue;}
        const response=await chrome.tabs.sendMessage(temporary.id,{type:'MI_CAPTURE_REQUEST'}).catch(()=>null);
        preview=response?.ok?response.snapshot:null;
        const ids=(preview?.listings??[]).map(row=>String(row.listingId));
        const candidate=JSON.stringify(ids.sort());
        if(preview?.accountId!==info.accountId||preview?.url!==info.url||preview?.filterSignature!==info.filterSignature||!ids.length||candidate===previousFingerprint||new Set(ids).size!==ids.length){await new Promise(resolve=>setTimeout(resolve,400));continue;}
        if(fingerprint===candidate)break;
        fingerprint=candidate;preview=null;
        await new Promise(resolve=>setTimeout(resolve,400));
      }
      if(!preview||!valid(info)||JSON.stringify(preview.listings.map(row=>String(row.listingId)).sort())!==fingerprint){stoppedReason='não foi possível confirmar uma página estável da mesma loja e filtro';break;}
      const ids=preview.listings.map(row=>String(row.listingId));
      const key=JSON.stringify([info.url,info.spaPagination?.page??null,fingerprint]);
      if(seenPages.has(key)||ids.some(id=>seenIds.has(id))){stoppedReason='ciclo ou anúncios repetidos: coleta interrompida';break;}
      const captured=await captureTab(temporary.id,{accountId:info.accountId,url:info.url,filterSignature:info.filterSignature,spaPage:info.spaPagination?.page,listingFingerprint:fingerprint,virtualized:true,excludedListingIds:seenIds});
      pages.push({page:index+1,url:info.url,spaPage:info.spaPagination?.page,ok:Boolean(captured.ok),listings:captured.snapshot?.listings?.length??0,error:captured.error});
      if(!captured.ok){stoppedReason='captura não confirmada: '+(captured.error??'erro');break;}
      seenPages.add(key);(captured.snapshot?.listings??preview.listings).forEach(row=>seenIds.add(String(row.listingId)));previousFingerprint=fingerprint;
      if((captured.snapshot?.coverageWarnings??info.coverageWarnings)?.length){stoppedReason='cobertura parcial da interface';break;}
      if(info.nextPageUrl){
        const next=normalizeAuthorizedAreaUrl(info.nextPageUrl,origin,marketplace);
        if(!next||next.pathname!==new URL(info.url).pathname||filterQuery(next.href)!==filterQuery(info.url)||next.href===info.url){stoppedReason='link de próxima página ou filtro divergente';break;}
        if(index+1>=maxPages)break;
        expectedPage=undefined;
        const loaded=waitForTabComplete(temporary.id,next.href);
        await Promise.all([loaded,chrome.tabs.update(temporary.id,{url:next.href})]);
      }else if(info.spaPagination?.canAdvance){
        if(index+1>=maxPages)break;
        const moved=await chrome.tabs.sendMessage(temporary.id,{type:'MI_CAPTURE_ADVANCE_SPA',accountId:info.accountId,url:info.url,filterSignature:info.filterSignature,page:info.spaPagination.page}).catch(()=>null);
        if(!moved?.ok){stoppedReason='controle de paginação não confirmado';break;}
        expectedPage=info.spaPagination.page+1;
      }else{
        complete=Boolean(info.spaPagination&&!info.spaPagination.canAdvance)||!info.paginationUnsupported;
        stoppedReason=complete?'fim dos controles de paginação reconhecidos':'paginação não reconhecida; revisão manual necessária';
        break;
      }
    }
  }catch(error){stoppedReason=String(error?.message??error).slice(0,300);}
  finally{await chrome.tabs.remove(temporary.id).catch(()=>undefined);}
  return {ok:pages.some(page=>page.ok),complete,marketplace,pagesScanned:pages.length,pagesSucceeded:pages.filter(page=>page.ok).length,totalListings:seenIds.size,stoppedReason,pages};
}

/**
 * Navegação de leitura iniciada pelo vendedor, seguindo apenas links visíveis
 * de áreas reconhecidas no mesmo origin. Nunca abre outro domínio, formulário
 * de edição, anúncio público ou página que não pertença à allowlist.
 */
const AUTHORIZED_AREA_KINDS = new Set([
  'seller_dashboard', 'seller_orders', 'seller_listings', 'seller_ads',
  'seller_questions', 'seller_reputation', 'seller_returns', 'seller_complaints', 'seller_inventory',
]);

function normalizeAuthorizedAreaUrl(raw, expectedOrigin, marketplace) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.origin !== expectedOrigin || marketplaceOf(url.href) !== marketplace || url.username || url.password) return null;
    if (/(?:^|\/)(?:edit|editar|update|delete|remove|logout|signout|checkout)(?:\/|$)/i.test(url.pathname)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

async function captureAuthorizedAreas(sourceTabId, requestedMaxPages = 8, options = {}) {
  const source = await chrome.tabs.get(sourceTabId);
  const marketplace = marketplaceOf(source.url || '');
  if (!marketplace) return { ok: false, error: 'aba não pertence a um marketplace suportado' };
  const origin = new URL(source.url).origin;
  const initialInfo = await chrome.tabs.sendMessage(sourceTabId, { type: 'MI_CAPTURE_PAGE_INFO' }).catch(() => null);
  if (!initialInfo?.ok || !AUTHORIZED_AREA_KINDS.has(initialInfo.pageKind)) {
    return { ok: false, error: 'abra uma área reconhecida do painel do vendedor antes de iniciar a varredura' };
  }
  if (initialInfo.loginRequired || initialInfo.challenge) {
    return { ok: false, error: 'login, CAPTCHA ou verificação de segurança detectado; faça a verificação manual antes de continuar' };
  }

  const expectedAccountId = options.expectedAccountId ?? initialInfo.accountId;
  if (!expectedAccountId || initialInfo.accountId !== expectedAccountId) {
    return { ok: false, error: 'a identificação da loja não corresponde à coleta' };
  }
  const saved = options.resumeState && typeof options.resumeState === 'object' ? options.resumeState : {};
  const requested = Math.max(1, Math.min(500, Number.isInteger(requestedMaxPages) ? requestedMaxPages : 50));
  const savedMax = Number.isInteger(saved.maxPages) ? Math.max(1, Math.min(500, saved.maxPages)) : requested;
  const maxPages = Math.min(500, Math.max(requested, savedMax, Array.isArray(saved.pages) && saved.pages.length >= savedMax && saved.pages.every((p) => p.ok) ? savedMax + requested : savedMax));
  const keyOf = (url) => {
    const params = [...url.searchParams.entries()].filter(([key]) => /^(page|page_number|p|offset|limit|sort|order|start_date|end_date|date_from|date_to|from|to|period|status|startDate|endDate|dateFrom|dateTo)$/i.test(key)).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    const query = new URLSearchParams(params).toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  };
  const seen = new Set();
  for (const raw of Array.isArray(saved.seenUrls) ? saved.seenUrls.slice(0, 500) : []) {
    const safe = normalizeAuthorizedAreaUrl(raw, origin, marketplace);
    if (safe) seen.add(keyOf(safe));
  }
  const pages = (Array.isArray(saved.pages) ? saved.pages : []).slice(0, 500).map((page, index) => ({
    page: index + 1,
    url: String(page.url || '').slice(0, 2048),
    pageKind: AUTHORIZED_AREA_KINDS.has(page.pageKind) ? page.pageKind : 'seller_dashboard',
    ok: Boolean(page.ok),
    ...(page.error ? { error: String(page.error).slice(0, 500) } : {}),
    queued: Boolean(page.queued),
    ...(typeof page.filterSignature==='string'?{filterSignature:page.filterSignature}:{}),
    ...(Array.isArray(page.coverageWarnings)?{coverageWarnings:page.coverageWarnings.slice(0,10)}:{})
  }));
  // Uma tentativa falha continua ocupando o mesmo registro de página, não uma
  // nova posição a cada retomada. Páginas entregues ou enfileiradas não são refeitas.
  const legacyQueued = !saved.receiptProtocol && pages.some((page) => page.queued && !page.ok);
  const keyForCapture = async (url) => {
    if (!options.logicalBatchId) return undefined;
    const bytes = new TextEncoder().encode(JSON.stringify([options.logicalBatchId, expectedAccountId, keyOf(url)]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  const failedIndex = (url) => pages.findIndex((page) => {
    const target = normalizeAuthorizedAreaUrl(page.url, origin, marketplace);
    return target && keyOf(target) === keyOf(url) && !page.ok && (!page.queued || Boolean(saved.receiptProtocol));
  });
  const canCapture = (url) => pages.length < maxPages || failedIndex(url) >= 0;
  const recordPage = (url, data) => {
    const existing = failedIndex(url);
    if (existing >= 0) pages[existing] = { ...data, page: existing + 1 };
    else pages.push({ ...data, page: pages.length + 1 });
  };
  const queue = [];
  let unsupportedLinks = Boolean(saved.unsupportedLinks) || legacyQueued;
  const supportedQuery = (url) => [...url.searchParams.entries()].every(([key, value]) => /^(page|page_number|p|offset|limit|sort|order|start_date|end_date|date_from|date_to|from|to|period|status|startDate|endDate|dateFrom|dateTo)$/i.test(key) && /^[A-Za-z0-9_.:-]{1,80}$/.test(value));
  const enqueueLinks = (links) => {
    for (const link of Array.isArray(links) ? links : []) {
      const target = normalizeAuthorizedAreaUrl(link?.url, origin, marketplace);
      if (!target || !AUTHORIZED_AREA_KINDS.has(link?.pageKind)) continue;
      if (!supportedQuery(target)) { unsupportedLinks = true; continue; }
      const key = keyOf(target);
      if (!seen.has(key) && !queue.some((item) => item.key === key)) {
        if (queue.length >= 500) { unsupportedLinks = true; continue; }
        queue.push({ key, url: target.href, label: String(link.label || link.pageKind).slice(0, 80), ...(typeof link.filterSignature==='string'?{filterSignature:link.filterSignature}:{}) });
      }
    }
  };
  const enqueuePageLinks = (info, current) => {
    enqueueLinks(info.authorizedAreaLinks);
    if (info.paginationUnsupported || info.coverageWarnings?.length) unsupportedLinks = true;
    const next = normalizeAuthorizedAreaUrl(info.nextPageUrl, origin, marketplace);
    if (next && current && next.pathname === current.pathname && keyOf(next) !== keyOf(current)) {
      const filterQuery=url=>JSON.stringify([...url.searchParams.entries()].filter(([key])=>!/^(page|page_number|p|offset|limit)$/i.test(key)).sort());
      if(filterQuery(next)!==filterQuery(current)){unsupportedLinks=true;return;}
      enqueueLinks([{url:next.href,pageKind:info.pageKind,label:'próxima página',filterSignature:info.filterSignature}]);
    } else if (info.nextPageUrl) unsupportedLinks = true;
  };
  for (const item of Array.isArray(saved.pendingLinks) ? saved.pendingLinks.slice(0, 500) : []) {
    const target = normalizeAuthorizedAreaUrl(item?.url, origin, marketplace);
    if (!target || seen.has(keyOf(target))) continue;
    if (!supportedQuery(target)) { unsupportedLinks = true; continue; }
    if (!queue.some((queued) => queued.key === keyOf(target))) {
      queue.push({ key: keyOf(target), url: target.href, label: String(item.label || 'área autorizada').slice(0, 80), ...(typeof item.filterSignature==='string'?{filterSignature:item.filterSignature}:{}) });
    }
  }
  // A fila de versões antigas não tem recibo idempotente: nunca recapture seus itens às cegas.
  if (saved.receiptProtocol) for (const page of pages.filter((p) => !p.ok)) {
    const target = normalizeAuthorizedAreaUrl(page.url, origin, marketplace);
    if (target) seen.delete(keyOf(target));
    if (target && supportedQuery(target) && !queue.some((item) => item.key === keyOf(target))) queue.unshift({ key: keyOf(target), url: target.href, label: 'retomada', ...(typeof page.filterSignature==='string'?{filterSignature:page.filterSignature}:{}) });
  }
  const currentUrl = normalizeAuthorizedAreaUrl(source.url, origin, marketplace);
  if (!currentUrl || !supportedQuery(currentUrl)) return { ok: false, error: 'filtros da URL inicial não podem ser retomados com segurança; abra uma área sem parâmetros opacos' };
  const prior=pages.find(page=>{const url=normalizeAuthorizedAreaUrl(page.url,origin,marketplace);return url&&keyOf(url)===keyOf(currentUrl);});
  const pending=queue.find(item=>item.key===keyOf(currentUrl));
  const priorFilter=prior?.filterSignature??pending?.filterSignature;
  if(priorFilter!==undefined&&priorFilter!==initialInfo.filterSignature)return {ok:false,error:'filtros da página inicial divergem do histórico; restaure os filtros antes de retomar'};
  if (!seen.has(keyOf(currentUrl))) enqueuePageLinks(initialInfo, currentUrl);

  let stoppedReason = 'não foram encontrados outros links autorizados visíveis';
  let progressError = null;
  const persistProgress = async () => {
    if (typeof options.onProgress !== 'function') return true;
    const state = {
      pagesScanned: pages.length,
      pagesSucceeded: pages.filter((page) => page.ok).length,
      pages: pages.map((page, index) => ({ ...page, page: index + 1 })),
      seenUrls: [...seen].slice(0, 500),
      pendingLinks: queue.slice(0, 500).map(({ url, label, filterSignature }) => ({ url, label, ...(typeof filterSignature==='string'?{filterSignature}:{}) })),
      maxPages,
      unsupportedLinks,
      receiptProtocol: options.logicalBatchId && !legacyQueued ? 1 : 0,
      stoppedReason,
    };
    try {
      await options.onProgress(state);
      return true;
    } catch (error) {
      progressError = error instanceof Error ? error.message : 'falha ao persistir progresso da navegação';
      stoppedReason = 'coleta pausada porque não foi possível persistir o progresso; retome após reconectar o serviço local';
      return false;
    }
  };

  // Na retomada, a página raiz e as áreas concluídas não são capturadas de novo.
  if (currentUrl && !seen.has(keyOf(currentUrl)) && canCapture(currentUrl)) {
    if (options.beforeCapture) await options.beforeCapture();
    const firstCapture = await captureTab(sourceTabId, { accountId: expectedAccountId, url: initialInfo.url, filterSignature:initialInfo.filterSignature, ...(options.logicalBatchId ? { captureKey: await keyForCapture(currentUrl) } : {}) });
    recordPage(currentUrl, { url: source.url, pageKind: initialInfo.pageKind, ok: Boolean(firstCapture.ok), error: firstCapture.ok ? undefined : firstCapture.error, queued: Boolean(firstCapture.queued), filterSignature:initialInfo.filterSignature, coverageWarnings:firstCapture.snapshot?.coverageWarnings??initialInfo.coverageWarnings });
    if(firstCapture.snapshot?.coverageWarnings?.length)unsupportedLinks=true;
    if (firstCapture.ok || (firstCapture.queued && !options.logicalBatchId)) {
      seen.add(keyOf(currentUrl));
      const duplicate = queue.findIndex((item) => item.key === keyOf(currentUrl));
      if (duplicate >= 0) queue.splice(duplicate, 1);
    } else {
      if (!queue.some((item) => item.key === keyOf(currentUrl))) {
        if (queue.length >= 500) queue.pop();
        queue.unshift({ key: keyOf(currentUrl), url: currentUrl.href, label: 'página inicial', filterSignature:initialInfo.filterSignature });
      }
      stoppedReason = 'captura da página inicial falhou; retome antes de navegar para outras áreas';
    }
    enqueuePageLinks(initialInfo, currentUrl);
    if (!(await persistProgress()) || (!firstCapture.ok && (!firstCapture.queued || options.logicalBatchId))) {
      return { ok: pages.some((page) => page.ok), marketplace, pagesScanned: pages.length, pagesSucceeded: pages.filter((page) => page.ok).length, pagesQueued: pages.filter((page) => page.queued).length, pendingPages: queue.length, areas: [...new Set(pages.map((page) => page.pageKind))], stoppedReason, progressError, pages };
    }
  } else {
    enqueuePageLinks(initialInfo, currentUrl);
  }

  let temporary = null;
  try {
    if (queue.length && canCapture(new URL(queue[0].url))) {
      temporary = await chrome.tabs.create({ url: source.url, active: false, windowId: source.windowId });
      await readCapturePageInfo(temporary.id);
    }
    while (queue.length && canCapture(new URL(queue[0].url)) && temporary?.id) {
      const item = queue[0];
      const target = normalizeAuthorizedAreaUrl(item.url, origin, marketplace);
      if (!target) { queue.shift(); continue; }
      try {
        const loaded = waitForTabComplete(temporary.id, target.href);
        await Promise.all([loaded, chrome.tabs.update(temporary.id, { url: target.href })]);
      } catch (error) {
        stoppedReason = error instanceof Error ? error.message : 'falha ao abrir uma área autorizada';
        break; // o link fica persistido na fila para a próxima retomada
      }
      const info = await readCapturePageInfo(temporary.id);
      const current = await chrome.tabs.get(temporary.id);
      const currentTarget = normalizeAuthorizedAreaUrl(current.url || '', origin, marketplace);
      if (!currentTarget || !info?.ok) {
        stoppedReason = 'a página não permaneceu no mesmo origin ou não respondeu ao content script';
        break;
      }
      if (info.loginRequired || info.challenge || info.pageKind === 'login') {
        stoppedReason = 'login/CAPTCHA ou verificação de segurança detectado; varredura pausada para ação manual';
        break;
      }
      if (info.accountId !== expectedAccountId || keyOf(currentTarget) !== item.key || !AUTHORIZED_AREA_KINDS.has(info.pageKind)) {
        stoppedReason = 'a área ou a conta da loja mudou durante a navegação';
        break;
      }
      if(item.filterSignature!==undefined&&item.filterSignature!==info.filterSignature){stoppedReason='filtros da próxima página diferem da página anterior; confirme manualmente';break;}
      if (options.beforeCapture) await options.beforeCapture();
      const captured = await captureTab(temporary.id, { accountId: expectedAccountId, url: info.url, filterSignature:info.filterSignature, ...(options.logicalBatchId ? { captureKey: await keyForCapture(target) } : {}) });
      recordPage(target, { url: current.url, label: item.label, pageKind: info.pageKind, ok: Boolean(captured.ok), error: captured.ok ? undefined : captured.error, queued: Boolean(captured.queued), filterSignature:info.filterSignature, coverageWarnings:captured.snapshot?.coverageWarnings??info.coverageWarnings });
      if(captured.snapshot?.coverageWarnings?.length)unsupportedLinks=true;
      if (captured.ok || (captured.queued && !options.logicalBatchId)) {
        seen.add(item.key);
        queue.shift();
        enqueuePageLinks(info, currentTarget);
        stoppedReason = queue.length ? 'há mais áreas autorizadas visíveis ou o limite de páginas foi atingido' : 'todas as áreas autorizadas visíveis foram percorridas';
      } else {
        stoppedReason = 'captura da página falhou; a URL permaneceu na fila para nova tentativa';
      }
      if (!(await persistProgress())) break;
      if (!captured.ok && (!captured.queued || options.logicalBatchId)) break;
      if (queue.length && canCapture(new URL(queue[0].url))) await new Promise((resolve) => setTimeout(resolve, 900));
    }
    if (queue.length && !canCapture(new URL(queue[0].url))) stoppedReason = `limite de segurança de ${maxPages} páginas atingido`;
  } finally {
    if (temporary?.id) await chrome.tabs.remove(temporary.id).catch(() => undefined);
  }
  if (unsupportedLinks && queue.length === 0) stoppedReason = ('cobertura parcial: links, filtros ou visualizações exigem verificação manual '+[...new Set(pages.flatMap(p=>p.coverageWarnings??[]))].join(',')).slice(0,300);
  // Persiste a fila remanescente e o motivo mesmo quando a navegação foi pausada.
  if (!progressError) await persistProgress();
  return {
    ok: pages.some((page) => page.ok),
    marketplace,
    pagesScanned: pages.length,
    pagesSucceeded: pages.filter((page) => page.ok).length,
    pagesQueued: pages.filter((page) => page.queued).length,
    pendingPages: queue.length,
    unsupportedLinks,
    areas: [...new Set(pages.map((page) => page.pageKind))],
    stoppedReason,
    ...(progressError ? { progressError } : {}),
    pages,
  };
}

/**
 * Executor DRAFT apenas preenche campos; PUBLISH é separado e exige aprovação
 * de super_admin, aba ativa, ID/conta exatos e confirmação nativa por anúncio.
 */
let processingDraftTasks = false;
async function processDraftTasks() {
  if (processingDraftTasks) return;
  processingDraftTasks = true;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const marketplace = marketplaceOf(tab.url);
      if (!marketplace) continue;
      const context = await chrome.tabs.sendMessage(tab.id, { type: 'MI_TASK_CONTEXT' }).catch(() => null);
      if (!context?.ok || context.sessionAuthenticated !== true || context.pageKind !== 'seller_listing_edit' || !context.externalListingId || !context.accountId) continue;
      const claim = await callService('task.claimNext', { marketplace, accountId: context.accountId, externalListingId: context.externalListingId }).catch(() => null);
      if (!claim?.ok || !claim.result || claim.result.ambiguous) continue;
      const claimed = claim.result;
      const applied = await chrome.tabs.sendMessage(tab.id, {
        type: 'MI_TASK_APPLY_DRAFT', task: claimed.task, item: claimed.item,
        externalListingId: claimed.externalListingId,
      }).catch((err) => ({ ok: false, error: err?.message ?? 'aba indisponível' }));
      await callService('task.itemResult', {
        itemId: claimed.item.id, claimToken: claimed.claimToken, ok: Boolean(applied?.ok), accountId: context.accountId,
        externalListingId: applied?.externalListingId ?? claimed.externalListingId,
        message: applied?.ok ? `rascunho preenchido: ${(applied.fields ?? []).join(', ')}` : (applied?.error ?? 'não foi possível aplicar rascunho'),
        ...(applied?.baseline ? { baseline: applied.baseline } : {}),
        ...(applied?.sourceUrl ? { sourceUrl: applied.sourceUrl } : {}),
      }).catch(() => undefined);
    }
  } finally {
    processingDraftTasks = false;
  }
}


/** Publicação autorizada: exclusivamente na aba ativa, com aprovação vigente e confirmação por anúncio. */
let processingPublishTasks = false;
async function processPublishTasks() {
  if (processingPublishTasks) return;
  processingPublishTasks = true;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    for (const tab of tabs) {
      if (!tab.id || !tab.url || tab.active !== true) continue;
      const marketplace = marketplaceOf(tab.url);
      if (!['mercado_livre', 'shopee'].includes(marketplace)) continue;
      const context = await chrome.tabs.sendMessage(tab.id, { type: 'MI_TASK_CONTEXT' }).catch(() => null);
      if (!context?.ok || context.sessionAuthenticated !== true || context.pageKind !== 'seller_listing_edit' || !context.externalListingId || !context.accountId) continue;
      const claim = await callService('task.claimNextPublish', {
        marketplace, accountId: context.accountId, externalListingId: context.externalListingId,
      }).catch(() => null);
      if (!claim?.ok || !claim.result || claim.result.ambiguous) continue;
      const claimed = claim.result;
      let applied;
      try {
        applied = await chrome.tabs.sendMessage(tab.id, {
          type: 'MI_TASK_PUBLISH_APPROVED', task: claimed.task, item: claimed.item,
          externalListingId: claimed.externalListingId,
        });
      } catch (error) {
        // A navegação pode ter ocorrido depois do clique. Estado incerto e sem retentativa automática.
        applied = { ok: false, uncertain: true, clicked: true, message: error?.message ?? 'aba navegou ou deixou de responder durante o envio' };
      }
      const outcome = applied?.cancelled ? 'CANCELLED'
        : applied?.ok && applied?.published === true && applied?.verified === true ? 'PUBLISHED'
          : applied?.uncertain || applied?.clicked ? 'UNCERTAIN' : 'FAILED';
      await callService('task.publishResult', {
        approvalId: claimed.approvalId, externalListingId: applied?.externalListingId ?? claimed.externalListingId, outcome, message: applied?.message ?? applied?.error ?? outcome,
        ...(applied?.after ? { after: applied.after } : {}),
        ...(applied?.sourceUrl ? { sourceUrl: applied.sourceUrl } : {}),
        ...(applied?.successText ? { successText: applied.successText } : {}),
        ...(applied?.saveButtonLabel ? { saveButtonLabel: applied.saveButtonLabel } : {}),
      }).catch(() => undefined);
    }
  } finally {
    processingPublishTasks = false;
  }
}

let lastNativeProbe = null;
let nativeProbeWork = null;
function probeNativeHost() {
  if (nativeProbeWork) return nativeProbeWork;
  nativeProbeWork = callNative('ping', {})
    .then((response) => ({ ok: response?.ok === true, error: response?.error?.message ?? '' }))
    .catch((error) => ({ ok: false, error: error.message }))
    .then((result) => {
      lastNativeProbe = { result, at: Date.now() };
      return result;
    }).finally(() => { nativeProbeWork = null; });
  return nativeProbeWork;
}

async function diagnoseLight(port) {
  const nativeHost = lastNativeProbe && Date.now() - lastNativeProbe.at < 5 * 60_000
    ? lastNativeProbe.result : await probeNativeHost();
  return {
    version: chrome.runtime.getManifest().version,
    http: { ok: Boolean(port), port: port || 0 },
    nativeHost: { ok: nativeHost.ok },
    token: Boolean(await sessionToken()),
    mode: 'light',
  };
}

/**
 * Diagnóstico do que a extensão alcança (host nativo, HTTP, porta, token).
 * É o que a tela de Pré-Start mostra em vez de um «indisponível» sem causa.
 */

/** Sincroniza apenas abas de vendedor já abertas e conta cuja identidade visível coincide com o lote. */
async function syncAllOpenSellerTabs(batchId, requestedMaxPages = 6) {
  if (typeof batchId !== 'string' || !batchId) throw new Error('batchId obrigatório');
  const batch = await callService('sync.list', { batchId, compact:true });
  const accounts = batch?.result?.accounts;
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('lote sem contas pendentes');
  const tabs = await chrome.tabs.query({});
  const outcomes = [];
  const notifyProgress = (detail) => {
    try { chrome.runtime.sendMessage({ type: 'MI_SYNC_PROGRESS', batchId, ...detail }, () => void chrome.runtime.lastError); } catch { /* painel pode estar fechado */ }
  };
  notifyProgress({ current: 0, total: accounts.length, phase: 'STARTED', message: 'Lote de coleta iniciado; conferindo abas e identidades.' });
  for (const account of accounts) {
    if (['COMPLETED','PARTIAL','FAILED','SKIPPED'].includes(account.status)) continue;
    let resumeState = {};
    let resumeOrigin = null;
    try {
      const detail = await callService('sync.list', { batchId, accountId:account.account_id,includePageRuns:false });
      if (!detail?.ok || !detail.result?.accounts?.[0]) throw new Error('histórico da conta indisponível');
      resumeState = JSON.parse(detail.result.accounts[0].progress_json || '{}');
      const savedUrl = resumeState.pendingLinks?.[0]?.url ?? resumeState.pages?.[0]?.url;
      if (savedUrl) resumeOrigin = new URL(savedUrl).origin;
    } catch (error) { throw new Error('não foi possível recuperar progresso: '+error.message); }
    const candidates = tabs.filter((tab) => tab.id && marketplaceOf(tab.url || '') === account.marketplace &&
      (!resumeOrigin || new URL(tab.url).origin === resumeOrigin));
    let matched = null;
    for (const tab of candidates) {
      const info = await chrome.tabs.sendMessage(tab.id, { type: 'MI_CAPTURE_PAGE_INFO' }).catch(() => null);
      if (info?.ok && info.accountId === account.account_id && !info.loginRequired && !info.challenge && AUTHORIZED_AREA_KINDS.has(info.pageKind)) {
        matched = { tab, info }; break;
      }
    }
    const claim = await callService('sync.claimAccount',{batchId,accountId:account.account_id});
    if (!captureAccepted(claim)) throw new Error(claim?.error?.message ?? 'reserva de coleta não confirmada');
    if (!claim.result.claimed) { notifyProgress({current:outcomes.length,total:accounts.length,accountId:account.account_id,marketplace:account.marketplace,status:'RUNNING',message:claim.result.reason}); continue; }
    const leaseToken=claim.result.leaseToken;
    if (!matched) {
      const pagesScanned = Number(account.pages_scanned ?? 0);
      const pagesSucceeded = Number(account.pages_succeeded ?? 0);
      const status = pagesSucceeded > 0 ? 'PARTIAL' : 'SKIPPED';
      const result = await callService('sync.completeAccount', { batchId, accountId: account.account_id, leaseToken, status, pagesScanned, pagesSucceeded, error: 'nenhuma aba autenticada aberta com a identidade desta conta; abra o painel do vendedor e refaça a sincronização' });
      if (!captureAccepted(result)) throw new Error(result?.error?.message ?? 'resultado da conta não confirmado');
      outcomes.push({ accountId: account.account_id, marketplace: account.marketplace, status, result });
      notifyProgress({ current: outcomes.length, total: accounts.length, accountId: account.account_id, marketplace: account.marketplace, status, message: 'Não há aba autenticada correspondente.' });
      continue;
    }
    const scan = await captureAuthorizedAreas(matched.tab.id, requestedMaxPages, {
      resumeState,
      logicalBatchId: batch.result.batch?.logical_batch_id || batchId,
      expectedAccountId: account.account_id,
      beforeCapture: async () => {
        const renewed=await callService('sync.claimAccount',{batchId,accountId:account.account_id,leaseToken});
        if (!captureAccepted(renewed) || !renewed.result.claimed) throw new Error('reserva da coleta perdida; interrompida antes da próxima página');
      },
      onProgress: async (progress) => {
        const saved = await callService('sync.accountProgress', { batchId, accountId: account.account_id, leaseToken, ...progress });
        if (!saved?.ok) throw new Error(saved?.error?.message ?? 'serviço não confirmou a gravação do progresso');
        const latest = progress.pages?.at(-1);
        notifyProgress({ current: outcomes.length, total: accounts.length, accountId: account.account_id, marketplace: account.marketplace, phase: 'PAGE', pagesScanned: progress.pagesScanned, pagesSucceeded: progress.pagesSucceeded, currentPage: latest?.page ?? 0, pendingPages: progress.pendingLinks.length, message: `Coletando página ${latest?.page ?? 0}; ${progress.pendingLinks.length} área(s) restantes.` });
      },
    });
    if (scan.progressError) throw new Error(scan.stoppedReason);
    const pages = Math.max(Number(account.pages_scanned ?? 0),Number(scan.pagesScanned ?? scan.pages?.length ?? 0));
    const succeeded = Math.max(Number(account.pages_succeeded ?? 0),Number(scan.pagesSucceeded ?? scan.pages?.filter((page) => page.ok).length ?? 0));
    const status = !scan.ok ? (succeeded>0?'PARTIAL':'FAILED') : succeeded === pages && Number(scan.pendingPages ?? 0) === 0 && !scan.unsupportedLinks ? 'COMPLETED' : succeeded > 0 ? 'PARTIAL' : 'FAILED';
    const result = await callService('sync.completeAccount', { batchId, accountId: account.account_id, leaseToken, status, pagesScanned: pages, pagesSucceeded: succeeded, ...(status === 'COMPLETED' ? {} : { error: scan.error ?? scan.stoppedReason }) });
    if (!captureAccepted(result)) throw new Error(result?.error?.message ?? 'resultado da coleta não confirmado');
    outcomes.push({ accountId: account.account_id, marketplace: account.marketplace, status, scan, result });
    notifyProgress({ current: outcomes.length, total: accounts.length, accountId: account.account_id, marketplace: account.marketplace, status, pagesScanned: pages, pagesSucceeded: succeeded, message: `Conta processada: ${status}.` });
  }
  const result = { ok: outcomes.some((outcome) => outcome.status === 'COMPLETED' || outcome.status === 'PARTIAL'), batchId, outcomes, accountSwitching: false, note: 'nenhuma sessão foi trocada; contas sem aba correspondente foram puladas' };
  notifyProgress({ current: outcomes.length, total: accounts.length, phase: 'FINISHED', message: `Lote finalizado: ${outcomes.length}/${accounts.length} conta(s) processada(s).` });
  return result;
}

let processingScheduledSyncs = false;
async function processScheduledSyncs() {
  if (processingScheduledSyncs) return;
  processingScheduledSyncs = true;
  try {
    const manual = await callService('sync.claimBrowserRequest', {});
    const claimed = manual?.result?.claimed ? manual : await callService('sync.claimScheduled', {});
    if (!claimed?.ok || !claimed.result?.claimed || !claimed.result?.batchId) return;
    const batchId = claimed.result.batchId;
    await syncAllOpenSellerTabs(batchId, 50);
  } catch {
    // A coleta pode ser retomada após expiração da reserva.
  } finally {
    processingScheduledSyncs = false;
  }
}

async function diagnose() {
  const report = {
    version: chrome.runtime.getManifest().version,
    nativeHost: { ok: false, error: '' },
    http: { ok: false, port: 0, error: '' },
    token: false,
  };
  report.nativeHost = await probeNativeHost();
  const port = await discoverPort();
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'MI_CALL') return false;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}/`;
  if (
    sender.id !== chrome.runtime.id ||
    typeof sender.url !== 'string' ||
    !sender.url.startsWith(extensionOrigin)
  ) {
    sendResponse({ ok: false, error: { code: 'SENDER', message: 'origem não autorizada' } });
    return false;
  }
  void (async () => {
    try {
      if (message.method === 'capture.activeTab') {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error('nenhuma aba ativa');
        sendResponse(await captureTab(tab.id));
        return;
      }
      if (message.method === 'capture.scanAuthorizedAreas') {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error('nenhuma aba ativa');
        sendResponse({ ok: true, result: await captureAuthorizedAreas(tab.id, message.payload?.maxPages ?? 50) });
        return;
      }
      if (message.method === 'capture.syncAllOpenTabs') {
        sendResponse({ ok: true, result: await syncAllOpenSellerTabs(message.payload?.batchId, message.payload?.maxPages ?? 6) });
        return;
      }
      if (message.method === 'capture.scanListingPages') {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error('nenhuma aba ativa');
        sendResponse({ ok: true, result: await captureListingPages(tab.id, message.payload?.maxPages ?? 5) });
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
