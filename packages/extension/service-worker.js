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
  if (alarm.name === 'mi.sync') { void processScheduledSyncs(); void runDueCompetitorSchedule().catch(()=>{}); }
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
  if(expected.spaRecordIds!==undefined&&(JSON.stringify(spaRecordIds(snapshot))!==expected.spaRecordIds||snapshot.pageKind!==expected.pageKind))return {ok:false,error:'registros SPA mudaram antes da captura'};
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
    ...(expected.spaFingerprint?{capturePageIdentity:expected.spaFingerprint}:{}),
    ...(expected.bindPageIdentity?{capturePageIdentity:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([snapshot.spaPage??null,(snapshot.listings??[]).map(row=>String(row.listingId)).sort()]))))].map(v=>v.toString(16).padStart(2,'0')).join('')}:{}),
    ...(typeof snapshot.filterSignature==='string'?{filterSignature:snapshot.filterSignature}:{}),
    listings: snapshot.listings ?? [],
    details: Array.isArray(snapshot.details) ? snapshot.details.slice(0,100) : [],
    chartPoints: !expected.skipAreaTotals&&Array.isArray(snapshot.chartPoints) ? snapshot.chartPoints.slice(0,200) : [],
    ...(!expected.skipAreaTotals&&snapshot.accountMetrics ? { accountMetrics: snapshot.accountMetrics } : {}),
    evidence: { ...(snapshot.evidence ?? {}), missing: (snapshot.missing ?? []).join(','), ...(snapshot.coverageWarnings?.length?{coverageWarnings:snapshot.coverageWarnings.join(',')}: {}) },
  };

  const customerVoice = Array.isArray(snapshot.customerVoice) ? snapshot.customerVoice.slice(0, 200) : [];
  if (payload.listings.length === 0 && !payload.accountMetrics && payload.details.length===0 && payload.chartPoints.length===0 && customerVoice.length === 0) {
    return { ok: false, error: 'nenhum dado visível para capturar nesta página', snapshot };
  }
  if (!payload.accountId) return { ok: false, error: 'identidade da conta não identificada; abra uma área do vendedor que mostre o nome da conta', snapshot };

  // A captura é recusada pelo serviço se a conta ainda não existir. A conta vem
  // da própria página (o vendedor logado), por isso é registrada aqui, uma vez,
  // antes do envio — sem inventar nome nem identificador.
  const account = { marketplace: payload.marketplace, accountHandle: snapshot.accountHandle };
  const pending = [];
  if (payload.listings.length || payload.accountMetrics || payload.details.length || payload.chartPoints.length) pending.push({ method: 'capture.ingest', payload, account, queuedAt: now });
  if (customerVoice.length) pending.push({
    method: 'voc.ingestBatch',
    payload: { accountId: payload.accountId, sourceClass: 'A_PRIMARY_UI', items: customerVoice, ...(expected.captureKey ? { captureKey: expected.captureKey, sourceUrl: payload.url, filterSignature:payload.filterSignature, ...(expected.spaFingerprint?{capturePageIdentity:expected.spaFingerprint}:{}) } : {}) },
    account, queuedAt: now,
  });
  try {
    await ensureAccount(payload.marketplace, payload.accountId, snapshot);
    let captureResult = null;
    if (payload.listings.length || payload.accountMetrics || payload.details.length || payload.chartPoints.length) {
      captureResult = await callService('capture.ingest', payload);
      if (!captureAccepted(captureResult)) return { ok: false, error: captureResult.error?.message ?? captureResult.result?.errors?.[0] ?? 'falha no serviço', res: captureResult };
      pending.shift();
    }
    let voiceResult = null;
    if (customerVoice.length) {
      voiceResult = await callService('voc.ingestBatch', { accountId: payload.accountId, sourceClass: 'A_PRIMARY_UI', items: customerVoice, ...(expected.captureKey ? { captureKey: expected.captureKey, sourceUrl: payload.url, filterSignature:payload.filterSignature, ...(expected.spaFingerprint?{capturePageIdentity:expected.spaFingerprint}:{}) } : {}) });
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

async function verifyCampaignInFreshTab(tab, grant, proposalId) {
  let verificationTab;
  try {
    // Use the seller URL already validated at claim time. Only this new document is read.
    verificationTab = await chrome.tabs.create({url:tab.url,active:false,windowId:tab.windowId});
    if (!Number.isInteger(verificationTab.id)) return null;
    await waitForTabComplete(verificationTab.id,tab.url,8000);
    const info = await chrome.tabs.sendMessage(verificationTab.id,{type:'MI_CAMPAIGN_BUDGET_CONTEXT',campaignRef:grant.campaignRef,changeKind:grant.targetStatus?'STATUS':grant.targetRoas!==undefined?'ROAS':'BUDGET'});
    if (!info?.ok || info.accountId!==grant.accountId || info.campaignRef!==grant.campaignRef ||
        info.sourcePath!==grant.sourcePath || info.documentNonce===grant.documentNonce || info.budgetCents!==grant.targetCents || info.campaignStatus!==grant.targetStatus || info.roasTargetHundredths!==grant.targetRoas) return null;
    const {ok,...context}=info;
    const verified=await callService('campaign.budget.verify',{...context,proposalId});
    return verified?.ok && verified.result?.status==='UI_READBACK_MATCHED' ? verified : null;
  } catch {
    return null;
  } finally {
    if (Number.isInteger(verificationTab?.id)) await chrome.tabs.remove(verificationTab.id).catch(()=>{});
  }
}

async function verifyVariationInFreshTab(tab, grant, proposalId) {
  let verificationTab;
  try {
    const {accountId,externalListingId,variationId,sourcePath,documentNonce}=grant.context;
    const {name,priceCents,stock}=grant.plan;
    verificationTab=await chrome.tabs.create({url:tab.url,active:false,windowId:tab.windowId});
    if (!Number.isInteger(verificationTab.id)) return null;
    await waitForTabComplete(verificationTab.id,tab.url,8000);
    const creating=grant.context.action==='CREATE_VARIATION';
    let detail;
    if(creating){
      const response=await chrome.tabs.sendMessage(verificationTab.id,{type:'MI_CAPTURE_REQUEST'});
      const snapshot=response?.snapshot;
      if(!response?.ok||snapshot?.marketplace!=='mercado_livre'||snapshot.accountId!==accountId||
          snapshot.url!==tab.url||snapshot.pageKind!=='seller_listing_edit'||snapshot.coverageWarnings?.length||
          !Array.isArray(snapshot.details))return null;
      const matches=snapshot.details.filter(row=>row.kind==='LISTING_VARIANT'&&row.parentExternalId===externalListingId&&
        row.label===grant.plan.option&&typeof row.metrics?.price==='number'&&Math.round(row.metrics.price*100)===priceCents&&row.metrics.stockAvailable===stock);
      if(matches.length!==1)return null;
      detail=matches[0];
    }else{
      const observed=await chrome.tabs.sendMessage(verificationTab.id,{
        type:'MI_LISTING_OPERATION_CONTEXT',action:'EDIT_VARIATION',externalListingId,variationId,
      });
      if (!observed?.ok||observed.action!=='EDIT_VARIATION'||observed.accountId!==accountId||
          observed.externalListingId!==externalListingId||observed.variationId!==variationId||
          observed.sourcePath!==sourcePath||!observed.documentNonce||observed.documentNonce===documentNonce||
          observed.variationLabel!==name||observed.beforePriceCents!==priceCents||observed.beforeStock!==stock) return null;
      detail={kind:'LISTING_VARIANT',externalId:variationId,parentExternalId:externalListingId,label:observed.variationLabel,
        metrics:{price:observed.beforePriceCents/100,stockAvailable:observed.beforeStock},
        evidence:{price:'Preço no editor: R$ '+(observed.beforePriceCents/100).toFixed(2),stockAvailable:'Estoque no editor: '+observed.beforeStock}};
    }
    const now=new Date().toISOString();
    const capture=await callService('capture.ingest',{
      accountId,marketplace:'mercado_livre',pageKind:'seller_listing_edit',url:sourcePath,
      sourceClass:'A_PRIMARY_UI',referenceAt:now,collectedAt:now,method:'content_script_dom',listings:[],details:[detail],
    });
    if (!captureAccepted(capture)||capture.result?.detailRowsIngested!==1) return null;
    const verified=await callService('listing.browser.verify',{accountId,proposalId,observedExternalId:detail.externalId});
    return verified?.ok&&verified.result?.status===(creating?'CANDIDATE_OBSERVED':'UI_READBACK_MATCHED')?verified:null;
  } catch {
    return null;
  } finally {
    if (Number.isInteger(verificationTab?.id)) await chrome.tabs.remove(verificationTab.id).catch(()=>{});
  }
}

async function observeDuplicateInFreshTab(tab, grant, proposalId, baseline, duplicateReceipt) {
  const {accountId,sourcePath,externalListingId}=grant.context;
  const {originalTitle}=grant.plan;
  if(!baseline?.listingIds?.includes(externalListingId)||typeof baseline.filterSignature!=='string'||!originalTitle)return null;
  const before=new Set(baseline.listingIds);
  let verificationTab;
  try{
    verificationTab=await chrome.tabs.create({url:tab.url,active:false,windowId:tab.windowId});
    if(!Number.isInteger(verificationTab.id))return null;
    await waitForTabComplete(verificationTab.id,tab.url,8000);
    const response=await chrome.tabs.sendMessage(verificationTab.id,{type:'MI_CAPTURE_REQUEST'});
    const snapshot=response?.snapshot;
    if(!response?.ok||snapshot?.marketplace!=='mercado_livre'||snapshot.accountId!==accountId||
        snapshot.url!==tab.url||snapshot.pageKind!=='seller_listings'||snapshot.coverageWarnings?.length||
        snapshot.filterSignature!==baseline.filterSignature||snapshot.spaPage!==baseline.spaPage||
        !Array.isArray(snapshot.listings)||!snapshot.listings.some(row=>row.listingId===externalListingId&&row.title===originalTitle))return null;
    const candidates=snapshot.listings.filter(row=>/^MLB-?\d{5,}$/i.test(row.listingId)&&!before.has(row.listingId)&&row.title===originalTitle&&(!duplicateReceipt||row.listingId.replace('-','').toUpperCase()===duplicateReceipt.newId));
    if(candidates.length!==1)return null;
    const listing=candidates[0],now=new Date().toISOString();
    const capture=await callService('capture.ingest',{
      accountId,marketplace:'mercado_livre',pageKind:'seller_listings',url:sourcePath,sourceClass:'A_PRIMARY_UI',
      referenceAt:now,collectedAt:now,method:'content_script_dom',listings:[listing],
    });
    if(!captureAccepted(capture)||capture.result?.listingsIngested!==1)return null;
    const candidate=await callService('listing.browser.verify',{accountId,proposalId,observedExternalId:listing.listingId});
    return candidate?.ok&&['CANDIDATE_OBSERVED','UI_READBACK_MATCHED'].includes(candidate.result?.status)?candidate:null;
  }catch{
    return null;
  }finally{
    if(Number.isInteger(verificationTab?.id))await chrome.tabs.remove(verificationTab.id).catch(()=>{});
  }
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
async function captureListingPages(sourceTabId, requestedMaxPages = 5,options={}) {
  const source=await chrome.tabs.get(sourceTabId);
  const marketplace=marketplaceOf(source.url||'');
  if(!marketplace)return {ok:false,error:'aba não pertence a marketplace suportado'};
  const origin=new URL(source.url).origin;
  const initialInfo=await chrome.tabs.sendMessage(sourceTabId,{type:'MI_CAPTURE_PAGE_INFO'}).catch(()=>null);
  if(!initialInfo?.ok||initialInfo.pageKind!=='seller_listings'||!initialInfo.accountId||initialInfo.loginRequired||initialInfo.challenge)return {ok:false,error:'abra uma lista de anúncios autenticada com conta identificada'};
  if(!normalizeAuthorizedAreaUrl(source.url,origin,marketplace)||initialInfo.coverageWarnings?.includes('FILTRO_NAO_RECONHECIDO'))return {ok:false,error:'URL ou filtros iniciais não reconhecidos'};
  const validContext=info=>info?.ok&&info.marketplace===marketplace&&info.pageKind==='seller_listings'&&info.accountId===initialInfo.accountId&&!info.loginRequired&&!info.challenge&&!info.coverageWarnings?.includes('FILTRO_NAO_RECONHECIDO');
  const valid=info=>validContext(info)&&info.filterSignature===initialInfo.filterSignature;
  const maxPages=Math.max(1,Math.min(5,Number.isInteger(requestedMaxPages)?requestedMaxPages:5));
  const pages=Array.isArray(options.resumeState?.pages)?options.resumeState.pages.map(page=>({...page})):[];
  const sameUrl=(left,right)=>{const a=new URL(left),b=new URL(right);a.searchParams.sort();b.searchParams.sort();a.hash='';b.hash='';return a.href===b.href;};
  if(options.expectedAccountId&&options.expectedAccountId!==initialInfo.accountId)return {ok:false,error:'a loja não corresponde ao lote'};
  if(pages.length&&(!sameUrl(pages[0].url,source.url)||pages[0].spaPage!==initialInfo.spaPagination?.page||pages[0].filterSignature!==initialInfo.filterSignature))return {ok:false,error:'abra a mesma página inicial com os filtros originais para retomar'};
  const totalLimit=Math.min(50,pages.length+maxPages);
  const temporary=await chrome.tabs.create({url:source.url,active:false,windowId:source.windowId});
  const seenIds=new Set(pages.filter(page=>page.ok).flatMap(page=>page.listingIds??[])),seenPages=new Set();
  let stoppedReason='limite de páginas atingido',complete=false,progressError=null,lastUrl=source.url;
  const persist=async()=>{
    if(!options.onProgress)return true;
    try{await options.onProgress({pagesScanned:pages.length,pagesSucceeded:pages.filter(page=>page.ok).length,pages,seenUrls:[...new Set(pages.filter(page=>page.ok).map(page=>page.url))],pendingLinks:complete?[]:[{url:lastUrl,label:'retomada de anúncios',filterSignature:initialInfo.filterSignature}],maxPages:totalLimit,unsupportedLinks:!complete,receiptProtocol:1,stoppedReason:String(stoppedReason).slice(0,300)});return true;}
    catch(error){progressError=String(error?.message??error);stoppedReason='falha ao persistir progresso avançado';return false;}
  };
  const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const filterQuery=url=>JSON.stringify([...new URL(url).searchParams.entries()].filter(([key])=>!/^(page|page_number|p|offset|limit)$/i.test(key)).sort());
  try{
    let expectedPage=initialInfo.spaPagination?.page,previousFingerprint=null;
    for(let index=0;index<totalLimit;index++){
      let info,preview,fingerprint,stable=false,reapplied=false;
      // Wait until page marker and rendered listing identities agree twice.
      for(let attempt=0;attempt<12;attempt++){
        info=await readCapturePageInfo(temporary.id);
        if(!validContext(info)){stoppedReason='conta, filtros, login ou área divergentes';break;}
        const url=normalizeAuthorizedAreaUrl(info.url,origin,marketplace);
        if(!url||filterQuery(url.href)!==filterQuery(source.url)){stoppedReason='URL ou filtros divergentes';break;}
        if(info.filterSignature!==initialInfo.filterSignature){
          if(!reapplied){
            reapplied=true;
            const restored=await chrome.tabs.sendMessage(temporary.id,{type:'MI_CAPTURE_REAPPLY_FILTERS',accountId:info.accountId,url:info.url,currentSignature:info.filterSignature,targetSignature:initialInfo.filterSignature}).catch(()=>null);
            if(!restored?.ok){stoppedReason='filtros não puderam ser reaplicados com segurança';break;}
          }
          await new Promise(resolve=>setTimeout(resolve,400));continue;
        }
        if(expectedPage!==undefined&&info.spaPagination?.page!==expectedPage){await new Promise(resolve=>setTimeout(resolve,400));continue;}
        const response=await chrome.tabs.sendMessage(temporary.id,{type:'MI_CAPTURE_REQUEST'}).catch(()=>null);
        preview=response?.ok?response.snapshot:null;
        const ids=(preview?.listings??[]).map(row=>String(row.listingId));
        const candidate=JSON.stringify(ids.sort());
        if(preview?.accountId!==info.accountId||preview?.url!==info.url||preview?.filterSignature!==info.filterSignature||!ids.length||candidate===previousFingerprint||new Set(ids).size!==ids.length){await new Promise(resolve=>setTimeout(resolve,400));continue;}
        if(fingerprint===candidate){stable=true;break;}
        fingerprint=candidate;preview=null;
        await new Promise(resolve=>setTimeout(resolve,400));
      }
      if(!stable||!preview||!valid(info)||JSON.stringify(preview.listings.map(row=>String(row.listingId)).sort())!==fingerprint){stoppedReason='não foi possível confirmar uma página estável da mesma loja e filtro';break;}
      const ids=preview.listings.map(row=>String(row.listingId));
      const key=JSON.stringify([info.url,info.spaPagination?.page??null,fingerprint]);
      lastUrl=info.url;
      const listingFingerprint=options.logicalBatchId?await digest(fingerprint):fingerprint;
      const prior=pages[index];
      if(prior&&(!sameUrl(prior.url,info.url)||prior.spaPage!==info.spaPagination?.page||prior.filterSignature!==info.filterSignature||prior.listingFingerprint!==listingFingerprint)){stoppedReason='a identidade da página mudou desde o histórico; inicie novo lote';break;}
      if(seenPages.has(key)){stoppedReason='ciclo de paginação detectado';break;}
      if(!prior?.ok){
        if(ids.some(id=>seenIds.has(id))){stoppedReason='anúncios repetidos: coleta interrompida';break;}
        if(options.beforeCapture)await options.beforeCapture();
        const base={page:index+1,url:info.url,spaPage:info.spaPagination?.page,pageKind:'seller_listings',filterSignature:info.filterSignature,listingFingerprint,listingIds:ids,ok:false};
        pages[index]=base;
        if(!await persist())break;
        const canonicalUrl=new URL(info.url);canonicalUrl.searchParams.sort();canonicalUrl.hash='';
        const captureKey=options.logicalBatchId?await digest(JSON.stringify([options.logicalBatchId,info.accountId,canonicalUrl.href,info.spaPagination?.page??null,info.filterSignature])):undefined;
        const captured=await captureTab(temporary.id,{accountId:info.accountId,url:info.url,filterSignature:info.filterSignature,spaPage:info.spaPagination?.page,listingFingerprint:fingerprint,virtualized:true,excludedListingIds:seenIds,...(captureKey?{captureKey,bindPageIdentity:true}:{})});
        const observedIds=(captured.snapshot?.listings??preview.listings).map(row=>String(row.listingId));
        pages[index]={...base,ok:Boolean(captured.ok),listingIds:observedIds,listings:observedIds.length,error:captured.error,coverageWarnings:captured.snapshot?.coverageWarnings??info.coverageWarnings};
        if(!await persist())break;
        if(!captured.ok){stoppedReason='captura não confirmada: '+(captured.error??'erro');break;}
        observedIds.forEach(id=>seenIds.add(id));
      }
      seenPages.add(key);previousFingerprint=fingerprint;
      if(pages[index].coverageWarnings?.length){stoppedReason='cobertura parcial da interface; corrija a origem e inicie novo lote';break;}
      if(info.nextPageUrl){
        const next=normalizeAuthorizedAreaUrl(info.nextPageUrl,origin,marketplace);
        if(!next||next.pathname!==new URL(info.url).pathname||filterQuery(next.href)!==filterQuery(info.url)||next.href===info.url){stoppedReason='link de próxima página ou filtro divergente';break;}
        if(index+1>=totalLimit)break;
        expectedPage=undefined;
        const loaded=waitForTabComplete(temporary.id,next.href);
        await Promise.all([loaded,chrome.tabs.update(temporary.id,{url:next.href})]);
      }else if(info.spaPagination?.canAdvance){
        if(index+1>=totalLimit)break;
        const moved=await chrome.tabs.sendMessage(temporary.id,{type:'MI_CAPTURE_ADVANCE_SPA',accountId:info.accountId,url:info.url,filterSignature:info.filterSignature,page:info.spaPagination.page}).catch(()=>null);
        if(!moved?.ok){stoppedReason='controle de paginação não confirmado';break;}
        expectedPage=info.spaPagination.page+1;
      }else{
        complete=index+1===pages.length&&!info.paginationUnsupported;
        stoppedReason=complete?'fim dos controles de paginação reconhecidos':'paginação não reconhecida; revisão manual necessária';
        break;
      }
    }
  }catch(error){stoppedReason=String(error?.message??error).slice(0,300);}
  finally{await chrome.tabs.remove(temporary.id).catch(()=>undefined);}
  if(!progressError)await persist();
  return {ok:pages.some(page=>page.ok),complete,marketplace,pagesScanned:pages.length,pagesSucceeded:pages.filter(page=>page.ok).length,totalListings:seenIds.size,pendingPages:complete?0:1,unsupportedLinks:!complete,stoppedReason,pages,...(progressError?{progressError}:{})};
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

function spaRecordIds(snapshot){
  const ids=[];
  for(const row of snapshot?.listings??[]){if(!row.listingId)return null;ids.push(JSON.stringify(['listing',String(row.listingId)]));}
  for(const row of snapshot?.details??[]){if(!row.kind||!row.externalId)return null;ids.push(JSON.stringify(['detail',row.kind,row.parentExternalId??'',row.externalId]));}
  for(const row of snapshot?.customerVoice??[]){if(!row.kind||!row.externalRef)return null;ids.push(JSON.stringify(['voice',row.kind,row.externalRef]));}
  return ids.length&&new Set(ids).size===ids.length?ids.sort():null;
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
    ...(Number.isInteger(page.spaPage)&&typeof page.spaFingerprint==='string'?{spaPage:page.spaPage,spaFingerprint:page.spaFingerprint}:{}),
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
    return target && keyOf(target) === keyOf(url) && page.spaPage===undefined && !page.ok && (!page.queued || Boolean(saved.receiptProtocol));
  });
  const canCapture = (url) => pages.length < maxPages || failedIndex(url) >= 0 || pages.some(p=>!p.ok&&p.spaPage!==undefined&&keyOf(new URL(p.url))===keyOf(url));
  const recordPage = (url, data) => {
    const existing = failedIndex(url);
    if (existing >= 0) pages[existing] = { ...data, page: existing + 1 };
    else pages.push({ ...data, page: pages.length + 1 });
  };
  // Demonstrated routes only prioritize links independently found in the live DOM.
  // Memory never introduces a new URL or permission to navigate.
  let learnedRoutes=new Set(),learnedEdges=new Set();
  if(typeof callService==='function'){
    const learned=await callService('navigation.list',{accountId:expectedAccountId,origin}).catch(()=>null);
    if(learned?.ok&&Array.isArray(learned.result))learnedRoutes=new Set(learned.result.map(row=>JSON.stringify([row.route,row.page_kind])));
    const graph=await callService('navigation.graph',{accountId:expectedAccountId,origin}).catch(()=>null);
    if(graph?.ok&&Array.isArray(graph.result))learnedEdges=new Set(graph.result.map(row=>JSON.stringify([row.from_route,row.to_route])));
  }
  const queue = [];
  let unsupportedLinks = Boolean(saved.unsupportedLinks) || legacyQueued;
  const supportedQuery = (url) => [...url.searchParams.entries()].every(([key, value]) => /^(page|page_number|p|offset|limit|sort|order|start_date|end_date|date_from|date_to|from|to|period|status|startDate|endDate|dateFrom|dateTo)$/i.test(key) && /^[A-Za-z0-9_.:-]{1,80}$/.test(value));
  const enqueueLinks = (links, fromRoute) => {
    const priority=link=>{try{const route=new URL(link.url).pathname;const routeScore=learnedRoutes.has(JSON.stringify([route,link.pageKind]))?1:0;const edgeScore=learnedEdges.has(JSON.stringify([fromRoute,route]))?2:0;return routeScore+edgeScore;}catch{return 0;}};
    for (const link of (Array.isArray(links) ? [...links] : []).sort((a,b)=>priority(b)-priority(a))) {
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
    enqueueLinks(info.authorizedAreaLinks,new URL(info.url).pathname);
    if ((info.paginationUnsupported&&!info.spaPagination) || info.coverageWarnings?.some(w=>w!=='TABELA_VIRTUALIZADA')) unsupportedLinks = true;
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

  const rootSpa=Boolean(initialInfo.spaPagination&&!initialInfo.nextPageUrl);
  const rootTemporary=rootSpa||Boolean(initialInfo.coverageWarnings?.includes('TABELA_VIRTUALIZADA'));
  if(prior?.spaPage!==undefined&&!rootSpa)return {ok:false,error:'marcador SPA anterior não está disponível para retomada segura'};
  if(rootTemporary&&!seen.has(keyOf(currentUrl))&&!queue.some(item=>item.key===keyOf(currentUrl)))queue.unshift({key:keyOf(currentUrl),url:currentUrl.href,label:'paginação SPA inicial',filterSignature:initialInfo.filterSignature});
  if(rootSpa&&seen.has(keyOf(currentUrl))&&prior?.spaPage===undefined)unsupportedLinks=true;
  // Na retomada, a página raiz e as áreas concluídas não são capturadas de novo.
  if (!rootTemporary&&currentUrl && !seen.has(keyOf(currentUrl)) && canCapture(currentUrl)) {
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
      let info = await readCapturePageInfo(temporary.id);
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
      if(item.filterSignature!==undefined&&item.filterSignature!==info.filterSignature){
        const before=info;
        const restored=await chrome.tabs.sendMessage(temporary.id,{type:'MI_CAPTURE_REAPPLY_FILTERS',pageKind:before.pageKind,accountId:expectedAccountId,url:before.url,currentSignature:before.filterSignature,targetSignature:item.filterSignature}).catch(()=>null);
        if(restored?.ok){
          for(let attempt=0;attempt<10;attempt++){
            await new Promise(resolve=>setTimeout(resolve,400));
            info=await readCapturePageInfo(temporary.id);
            if(!info?.ok||info.accountId!==expectedAccountId||info.url!==before.url||info.pageKind!==before.pageKind||info.loginRequired||info.challenge)break;
            if(info.filterSignature===item.filterSignature&&!info.coverageWarnings?.includes('FILTRO_NAO_RECONHECIDO'))break;
          }
        }
        if(!restored?.ok||!info?.ok||info.accountId!==expectedAccountId||info.url!==before.url||info.pageKind!==before.pageKind||info.loginRequired||info.challenge||info.filterSignature!==item.filterSignature||info.coverageWarnings?.includes('FILTRO_NAO_RECONHECIDO')){stoppedReason='filtros da próxima página não puderam ser reaplicados com segurança';break;}
      }
      if(pages.some(p=>p.spaPage!==undefined&&keyOf(new URL(p.url))===item.key)&&(!info.spaPagination||info.nextPageUrl)){unsupportedLinks=true;stoppedReason='marcador SPA anterior não está disponível';break;}
      if(info.spaPagination&&!info.nextPageUrl){
        const history=pages.filter(p=>keyOf(new URL(p.url))===item.key);
        if(history.some(p=>p.spaPage===undefined)){unsupportedLinks=true;stoppedReason='histórico anterior sem identidade SPA; inicie novo lote';break;}
        let state=info,expectedPage=history[0]?.spaPage??1;
        if(expectedPage!==1||(item.key===keyOf(currentUrl)&&rootSpa&&initialInfo.spaPagination.page!==1)){unsupportedLinks=true;stoppedReason='abra a primeira página SPA para iniciar ou retomar';break;}
        const observedIds=new Set();
        let finished=false,failed=false,initialSummary=null;
        const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
        const contextOk=s=>s?.ok&&s.marketplace===marketplace&&s.accountId===expectedAccountId&&s.pageKind===info.pageKind&&s.url===info.url&&s.filterSignature===info.filterSignature&&!s.loginRequired&&!s.challenge&&!s.coverageWarnings?.includes('FILTRO_NAO_RECONHECIDO')&&s.spaPagination?.page===expectedPage;
        for(let step=0;step<500;step++){
          let fingerprint=null,ids=null,stable=false,summary=null;
          for(let attempt=0;attempt<12;attempt++){
            state=await readCapturePageInfo(temporary.id);
            if(!contextOk(state)){stoppedReason='conta, filtros ou marcador SPA divergentes';break;}
            const response=await chrome.tabs.sendMessage(temporary.id,{type:'MI_CAPTURE_REQUEST',...(state.coverageWarnings?.includes('TABELA_VIRTUALIZADA')?{virtualized:true,accountId:expectedAccountId,url:state.url,filterSignature:state.filterSignature,spaPage:expectedPage}:{})}).catch(()=>null);
            const snap=response?.ok?response.snapshot:null;
            ids=spaRecordIds(snap);
            if(!ids||snap.marketplace!==marketplace||snap.accountId!==expectedAccountId||snap.pageKind!==info.pageKind||snap.url!==info.url||snap.filterSignature!==info.filterSignature||snap.spaPage!==expectedPage){fingerprint=null;await new Promise(resolve=>setTimeout(resolve,400));continue;}
            const candidate=JSON.stringify(ids);
            summary=JSON.stringify([snap.accountMetrics??null,snap.chartPoints??[]]);
            if(candidate===fingerprint){stable=true;break;}
            fingerprint=candidate;await new Promise(resolve=>setTimeout(resolve,400));
          }
          if(!stable||!ids||ids.some(id=>observedIds.has(id))){stoppedReason='registros SPA ausentes, instáveis ou repetidos';unsupportedLinks=true;failed=true;break;}
          if(step===0)initialSummary=summary;
          else if(summary!==JSON.stringify([null,[]])&&summary!==initialSummary){unsupportedLinks=true;stoppedReason='indicadores de área variam entre páginas SPA; agregação não comprovada';failed=true;break;}
          enqueueLinks(state.authorizedAreaLinks,new URL(state.url).pathname);
          const hash=await digest(fingerprint);
          const existing=pages.findIndex(p=>keyOf(new URL(p.url))===item.key&&p.spaPage===expectedPage);
          const previous=existing>=0?pages[existing]:null;
          if(previous&&(previous.spaFingerprint!==hash||previous.filterSignature!==info.filterSignature)){stoppedReason='identidade SPA mudou desde a captura anterior';unsupportedLinks=true;failed=true;break;}
          if(!previous?.ok){
            if(existing<0&&pages.length>=maxPages){stoppedReason='limite de páginas SPA atingido';failed=true;break;}
            if(options.beforeCapture)await options.beforeCapture();
            const base={page:existing>=0?existing+1:pages.length+1,url:info.url,pageKind:info.pageKind,spaPage:expectedPage,spaFingerprint:hash,filterSignature:info.filterSignature,ok:false};
            const position=existing>=0?existing:pages.length;
            pages[position]=base;
            if(!await persistProgress()){failed=true;break;}
            const captureKey=options.logicalBatchId?await digest(JSON.stringify([options.logicalBatchId,expectedAccountId,item.key,expectedPage])):undefined;
            const captured=await captureTab(temporary.id,{accountId:expectedAccountId,url:info.url,pageKind:info.pageKind,filterSignature:info.filterSignature,spaPage:expectedPage,spaRecordIds:fingerprint,spaFingerprint:hash,virtualized:Boolean(state.coverageWarnings?.includes('TABELA_VIRTUALIZADA')),skipAreaTotals:step>0,...(captureKey?{captureKey}:{})});
            pages[position]={...base,ok:Boolean(captured.ok),queued:Boolean(captured.queued),error:captured.ok?undefined:captured.error,coverageWarnings:captured.snapshot?.coverageWarnings??state.coverageWarnings};
            if(!await persistProgress()){failed=true;break;}
            if(!captured.ok){stoppedReason='captura SPA não confirmada';failed=true;break;}
          }
          ids.forEach(id=>observedIds.add(id));
          if(pages.find(p=>keyOf(new URL(p.url))===item.key&&p.spaPage===expectedPage)?.coverageWarnings?.length){unsupportedLinks=true;stoppedReason='cobertura SPA parcial';failed=true;break;}
          if(!state.spaPagination.canAdvance){finished=true;break;}
          if(pages.length>=maxPages&&!history.some(p=>p.spaPage===expectedPage+1)){stoppedReason='limite de páginas SPA atingido';failed=true;break;}
          const moved=await chrome.tabs.sendMessage(temporary.id,{type:'MI_CAPTURE_ADVANCE_SPA',reactive:true,pageKind:info.pageKind,accountId:expectedAccountId,url:info.url,filterSignature:info.filterSignature,page:expectedPage}).catch(()=>null);
          if(!moved?.ok){stoppedReason='transição SPA não confirmada';unsupportedLinks=true;failed=true;break;}
          expectedPage++;
        }
        if(!finished||failed)break;
        seen.add(item.key);queue.shift();enqueuePageLinks(state,currentTarget);
        stoppedReason=queue.length?'há mais áreas autorizadas':'áreas reconhecidas percorridas';
        if(!await persistProgress())break;
        continue;
      }

      if (options.beforeCapture) await options.beforeCapture();
      const captured = await captureTab(temporary.id, { accountId: expectedAccountId, url: info.url, filterSignature:info.filterSignature, spaPage:info.spaPagination?.page, virtualized:Boolean(info.coverageWarnings?.includes('TABELA_VIRTUALIZADA')), ...(options.logicalBatchId ? { captureKey: await keyForCapture(target) } : {}) });
      recordPage(target, { url: current.url, label: item.label, pageKind: info.pageKind, ok: Boolean(captured.ok), error: captured.ok ? undefined : captured.error, queued: Boolean(captured.queued), filterSignature:info.filterSignature, coverageWarnings:captured.snapshot?.coverageWarnings??info.coverageWarnings });
      if((captured.snapshot?.coverageWarnings??info.coverageWarnings)?.length)unsupportedLinks=true;
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
  const advanced=batch.result.batch?.collection_mode==='ADVANCED_LISTINGS';
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
      if (info?.ok && info.accountId === account.account_id && !info.loginRequired && !info.challenge && AUTHORIZED_AREA_KINDS.has(info.pageKind) && (!advanced||info.pageKind==='seller_listings')) {
        if(advanced&&resumeState.pages?.length){const first=resumeState.pages[0];const normalize=raw=>{const url=new URL(raw);url.searchParams.sort();url.hash='';return url.href;};if(normalize(first.url)!==normalize(info.url)||first.filterSignature!==info.filterSignature||first.spaPage!==info.spaPagination?.page)continue;}
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
    const scanFn=advanced?captureListingPages:captureAuthorizedAreas;
    const scan = await scanFn(matched.tab.id, requestedMaxPages, {
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

// Learning is explicitly requested by the extension panel, never by a webpage.
async function navigationPage(tabId){
  const tab=await chrome.tabs.get(tabId);
  const marketplace=marketplaceOf(tab.url||'');
  const origin=new URL(tab.url).origin;
  const info=await chrome.tabs.sendMessage(tabId,{type:'MI_CAPTURE_PAGE_INFO'}).catch(()=>null);
  if(!marketplace||!info?.ok||info.marketplace!==marketplace||info.url!==tab.url||!info.accountId||info.loginRequired||info.challenge||!AUTHORIZED_AREA_KINDS.has(info.pageKind))throw Error('abra uma área de leitura autenticada e com conta identificada');
  const url=normalizeAuthorizedAreaUrl(tab.url,origin,marketplace);
  if(!url||url.port||url.hash)throw Error('rota não autorizada');
  return {tabId,accountId:info.accountId,origin,route:url.pathname,pageKind:info.pageKind,spaPage:Number.isInteger(info.spaPagination?.page)?info.spaPagination.page:null,canAdvance:info.spaPagination?.canAdvance===true,filterSignature:info.coverageWarnings?.includes('FILTRO_NAO_RECONHECIDO')?null:info.filterSignature??''};
}
// Executed in the isolated world of the selected public search tab. No network calls.
function collectPublicCompetitorCards(){
  const page=new URL(location.href),mp=page.protocol==='https:'&&!page.port?
    page.hostname==='lista.mercadolivre.com.br'?'mercado_livre':
    page.hostname==='shopee.com.br'&&page.pathname==='/search'&&page.searchParams.has('keyword')?'shopee':
    page.hostname==='www.amazon.com.br'&&page.pathname==='/s'&&page.searchParams.has('k')?'amazon':null:null;
  if(!mp)return {error:'Abra uma busca pública reconhecida.'};
  const visible=el=>Boolean(el&&el.getClientRects().length&&window.getComputedStyle(el).visibility!=='hidden'&&window.getComputedStyle(el).display!=='none');
  const selector=mp==='mercado_livre'?'.ui-search-layout__item':mp==='shopee'?'.shopee-search-item-result__item, [data-sqe="item"]':'[data-component-type="s-search-result"][data-asin]';
  const cards=[...document.querySelectorAll(selector)].filter(visible),seen=new Set(),candidates=[];
  const text=el=>visible(el)?String(el.innerText||el.textContent||'').trim():'';
  const getPrice=card=>{
    const price=card.querySelector(mp==='mercado_livre'?'.andes-money-amount:not(.andes-money-amount--previous)':mp==='amazon'?'.a-price:not(.a-text-price) .a-offscreen':'[data-sqe="price"]');
    if(!price)return null;
    // Amazon's a-offscreen is visually represented by the containing visible price; only explicit single BRL values.
    const raw=String(price.textContent||'').trim().replace(/\s+/g,' ');
    const hit=raw.match(/^R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?$/);
    if(!hit)return null;
    const amount=Number(hit[1].replace(/\./g,''))*100+Number(hit[2]||0);
    return Number.isSafeInteger(amount)?amount:null;
  };
  for(const card of cards){
    if(candidates.length>=20)break;
    const titleEl=card.querySelector(mp==='mercado_livre'?'.poly-component__title, .ui-search-item__title':mp==='amazon'?'h2':'[data-sqe="name"]');
    const title=text(titleEl);if(title.length<2||title.length>500)continue;
    for(const anchor of card.querySelectorAll('a[href]')){
      if(!visible(anchor))continue;
      let url;try{url=new URL(anchor.href,page);}catch{continue;}
      if(url.protocol!=='https:'||url.username||url.password||url.port)continue;
      const host=mp==='mercado_livre'?/(^|\.)mercadolivre\.com\.br$/i.test(url.hostname):mp==='shopee'?url.hostname==='shopee.com.br':url.hostname==='www.amazon.com.br';
      if(!host)continue;
      const raw=mp==='mercado_livre'?url.pathname.match(/(?:MLB-?)(\d{5,17})(?=[^0-9]|$)/i)?.[1]:mp==='shopee'?url.pathname.match(/(?:-i\.|\/product\/)(\d+)[./](\d+)(?:$|\/)/)?.slice(1).join('.'):url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:$|\/)/i)?.[1]?.toUpperCase();
      const id=mp==='mercado_livre'&&raw?'MLB'+raw:raw;
      if(!id||seen.has(id)||(mp==='amazon'&&card.getAttribute('data-asin')!==id))continue;
      seen.add(id);url.search='';url.hash='';
      const adLabel=[...card.querySelectorAll('span,small')].some(el=>/^(patrocinad[oa]|sponsored)$/i.test(text(el)));const sponsored=adLabel?true:null;
      candidates.push({externalId:id,title,url:url.href,priceCents:getPrice(card),sponsored,observedOrder:candidates.length+1});
      break;
    }
  }
  return {marketplace:mp,sourceUrl:page.href,observedAt:new Date().toISOString(),candidates};
}
/** Ponte para o painel lateral e para o popup. */

const COMP_PLAN_KEY='mi.competitor.public.schedule.v1';
let publicPlanBusy=false;
let scheduleWork=Promise.resolve();
function withCompetitorSchedule(fn){
  const work=scheduleWork.then(fn);
  scheduleWork=work.catch(()=>{});
  return work;
}
async function competitorSessionFingerprint(){
  const token=await sessionToken();
  if(!token)throw Error('Sessão local necessária.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
}
async function executePublicCompetitorPlan(input){
  if(publicPlanBusy)throw Error('Já existe uma busca pública em andamento.');
  publicPlanBusy=true;
  try{
        if(input.confirmed!==true||!Array.isArray(input.marketplaces)||input.marketplaces.length<1||input.marketplaces.length>3||!['TITLE','BRAND_MODEL','SKU','ATTRIBUTES'].includes(input.kind))throw Error('Confirme o critério e os marketplaces.');
        if(typeof input.accountId!=='string'||!input.accountId||typeof input.ownProductId!=='string'||!input.ownProductId||input.marketplaces.some(m=>!['mercado_livre','shopee','amazon'].includes(m)))throw Error('Escopo inválido.');
        if(input.marketplaces.includes('amazon')&&!await chrome.permissions.contains({origins:['https://www.amazon.com.br/*']}))throw Error('Permissão Amazon ausente.');
        const plan=await callService('competitor.searchPlan',{accountId:input.accountId,ownProductId:input.ownProductId,marketplaces:input.marketplaces});
        if(!plan?.ok)throw Error(plan?.error?.message||'Plano indisponível.');
        const links=(plan.result?.links??[]).filter(row=>row.kind===input.kind).slice(0,3),outcomes=[];
        for(const row of links){
          let temporary;
          try{
            const url=new URL(row.url),valid=url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&['lista.mercadolivre.com.br','shopee.com.br','www.amazon.com.br'].includes(url.hostname);
            if(!valid)throw Error('URL pública fora do escopo.');
            temporary=await chrome.tabs.create({url:url.href,active:false});
            await waitForTabComplete(temporary.id,url.href,10000);
            let captured;
            for(let attempt=0;attempt<4;attempt++){
              const results=await chrome.scripting.executeScript({target:{tabId:temporary.id},func:collectPublicCompetitorCards});
              captured=results[0]?.result;
              if(captured?.error||captured?.candidates?.length)break;
              await new Promise(resolve=>setTimeout(resolve,700));
            }
            const current=await chrome.tabs.get(temporary.id);
            if(!captured||captured.error||!captured.candidates?.length||captured.marketplace!==row.marketplace||captured.sourceUrl!==current.url||current.url!==url.href)throw Error(captured?.error||'Página mudou ou não exibiu cartões reconhecidos.');
            const saved=await callService('competitor.capturePublicSearch',{accountId:input.accountId,ownProductId:input.ownProductId,...captured});
            if(!saved?.ok)throw Error(saved?.error?.message||'Persistência recusada.');
            outcomes.push({marketplace:row.marketplace,status:'OBSERVED',observedCards:saved.result.observedCards});
          }catch(error){outcomes.push({marketplace:row.marketplace,status:'NOT_VERIFIED',reason:String(error?.message||error)});}
          finally{if(temporary?.id)await chrome.tabs.remove(temporary.id).catch(()=>{});}
        }

    if(!outcomes.length)throw Error('Nenhuma busca disponível para o critério.');
    return {outcomes,coverageVerified:false};
  }finally{publicPlanBusy=false;}
}
async function competitorSchedule(action,input={}){
  return withCompetitorSchedule(async()=>{
    const existing=(await chrome.storage.local.get(COMP_PLAN_KEY))[COMP_PLAN_KEY];
    if(action==='status')return existing?{enabled:existing.enabled,remaining:existing.remaining,nextAt:existing.nextAt,last:existing.last,accountId:existing.accountId,ownProductId:existing.ownProductId}:null;
    if(action==='stop'){await chrome.storage.local.remove(COMP_PLAN_KEY);return {enabled:false};}
    if(action!=='start'||input.confirmed!==true||!Number.isInteger(input.runs)||input.runs<1||input.runs>30||typeof input.accountId!=='string'||!input.accountId||typeof input.ownProductId!=='string'||!input.ownProductId||!['TITLE','BRAND_MODEL','SKU','ATTRIBUTES'].includes(input.kind)||!Array.isArray(input.marketplaces)||input.marketplaces.length<1||input.marketplaces.length>3||input.marketplaces.some(m=>!['mercado_livre','shopee','amazon'].includes(m)))throw Error('Plano ou limite inválido.');
    const fingerprint=await competitorSessionFingerprint();
    if(input.marketplaces.includes('amazon')&&!await chrome.permissions.contains({origins:['https://www.amazon.com.br/*']}))throw Error('Permissão Amazon ausente.');
    const marketplaces=[...new Set(input.marketplaces)];
    const plan=await callService('competitor.searchPlan',{accountId:input.accountId,ownProductId:input.ownProductId,marketplaces});
    if(!plan?.ok||!plan.result?.links?.some(r=>r.kind===input.kind))throw Error('Plano indisponível.');
    const state={enabled:true,remaining:input.runs,nextAt:Date.now()+86400000,last:null,accountId:input.accountId,ownProductId:input.ownProductId,kind:input.kind,marketplaces,fingerprint};
    await chrome.storage.local.set({[COMP_PLAN_KEY]:state});
    return {enabled:true,remaining:state.remaining,nextAt:state.nextAt};
  });
}
async function runDueCompetitorSchedule(){
  return withCompetitorSchedule(async()=>{
    const state=(await chrome.storage.local.get(COMP_PLAN_KEY))[COMP_PLAN_KEY];
    if(!state?.enabled||state.remaining<1||state.nextAt>Date.now()||publicPlanBusy)return;
    try{
      if(await competitorSessionFingerprint()!==state.fingerprint)throw Error('Sessão mudou; autorize novamente.');
      // Reserve a run before opening tabs. A restart cannot replay this run.
      state.remaining--;state.nextAt=Date.now()+86400000;state.enabled=false;state.last={status:'DISPATCHED',at:Date.now()};
      await chrome.storage.local.set({[COMP_PLAN_KEY]:state});
      const result=await executePublicCompetitorPlan({...state,confirmed:true});
      const ok=result.outcomes.every(r=>r.status==='OBSERVED');
      state.last={status:ok?'OBSERVED':'NOT_VERIFIED',at:Date.now(),outcomes:result.outcomes};
      state.enabled=ok&&state.remaining>0;
    }catch(e){state.enabled=false;state.last={status:'NOT_VERIFIED',at:Date.now(),reason:String(e?.message||e).slice(0,500)};}
    await chrome.storage.local.set({[COMP_PLAN_KEY]:state});
  });
}

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
      if(message.method==='competitor.executePublicPlan'){
        sendResponse({ok:true,result:await executePublicCompetitorPlan(message.payload??{})});return;
      }
      if(['competitor.schedule.start','competitor.schedule.stop','competitor.schedule.status'].includes(message.method)){
        sendResponse({ok:true,result:await competitorSchedule(message.method.split('.').pop(),message.payload??{})});return;
      }
      if(message.method==='competitor.captureCurrentPublicSearch'){
        const input=message.payload??{};
        if(input.confirmed!==true||typeof input.accountId!=='string'||typeof input.ownProductId!=='string')throw Error('Confirme a loja e produto.');
        const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
        if(!tab?.id||!tab.url)throw Error('Abra a aba pública de busca.');
        const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:collectPublicCompetitorCards});
        const captured=result[0]?.result;
        const current=await chrome.tabs.get(tab.id);
        if(!captured||captured.error||!captured.candidates?.length||current.url!==tab.url||captured.sourceUrl!==tab.url)throw Error(captured?.error||'Nenhum cartão reconhecido ou a página mudou. Não foi salvo.');
        sendResponse(await callService('competitor.capturePublicSearch',{accountId:input.accountId,ownProductId:input.ownProductId,...captured}));return;
      }
      if (['learning.context','learning.observe','learning.list','learning.clear'].includes(message.method)) {
        const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
        if(!tab?.id)throw Error('nenhuma aba ativa');
        const ctx=await navigationPage(tab.id);
        if(message.method==='learning.context'){sendResponse({ok:true,result:ctx});return;}
        const requested=message.payload;
        if(!requested||requested.tabId!==ctx.tabId||requested.accountId!==ctx.accountId||requested.origin!==ctx.origin)throw Error('aba, loja ou origem mudou; aprendizado interrompido');
        if(message.method==='learning.observe'&&(requested.route!==ctx.route||requested.pageKind!==ctx.pageKind))throw Error('a página mudou durante a observação; demonstre novamente');
        let actionKind;
        if(message.method==='learning.observe'&&requested.previous){
          const p=requested.previous;
          if(requested.spaPage!==ctx.spaPage||requested.filterSignature!==ctx.filterSignature)throw Error('estado de página mudou durante a observação');
          if(p.tabId===ctx.tabId&&p.accountId===ctx.accountId&&p.origin===ctx.origin&&p.route===ctx.route&&p.pageKind===ctx.pageKind&&typeof p.filterSignature==='string'&&typeof ctx.filterSignature==='string'){
            if(Number.isInteger(p.spaPage)&&ctx.spaPage===p.spaPage+1&&p.canAdvance===true&&p.filterSignature===ctx.filterSignature)actionKind='SPA_NEXT';
            else if(p.filterSignature!==ctx.filterSignature&&p.spaPage===ctx.spaPage)actionKind='FILTER_CHANGE';
          }
        }
        const base={accountId:ctx.accountId,origin:ctx.origin};
        const result=await callService(message.method==='learning.observe'?'navigation.observe':message.method==='learning.list'?'navigation.list':'navigation.clear',message.method==='learning.observe'?{...base,route:ctx.route,pageKind:ctx.pageKind,...(typeof requested.fromRoute==='string'?{fromRoute:requested.fromRoute}:{}),...(actionKind?{actionKind}:{})}:base);
        sendResponse(result);return;
      }
      if(message.method==='listing.browser.apply'){
        const input=message.payload??{};
        if(typeof input.proposalId!=='string'||typeof input.externalListingId!=='string'||!['DUPLICATE','CREATE_VARIATION','EDIT_VARIATION'].includes(input.action)||input.confirmed!==true)throw Error('proposta, anúncio, ação e confirmação explícitas necessárias');
        const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
        if(!tab?.id||marketplaceOf(tab.url)!=='mercado_livre')throw Error('abra a área do vendedor do Mercado Livre');
        const info=await chrome.tabs.sendMessage(tab.id,{type:'MI_LISTING_OPERATION_CONTEXT',action:input.action,externalListingId:input.externalListingId,variationId:input.variationId||undefined});
        if(!info?.ok)throw Error(info?.error||'controle não reconhecido');
        const {ok,...ctx}=info;
        const claim=await callService('listing.browser.claim',{...ctx,proposalId:input.proposalId,confirmed:true});
        if(!claim?.ok||!claim.result){sendResponse(claim);return;}
        const grant=claim.result;
        let result;
        try{
          const current=await chrome.tabs.get(tab.id);
          if(!current.active||current.url!==tab.url)throw Error('aba mudou após autorização');
          result=await chrome.tabs.sendMessage(tab.id,{type:'MI_LISTING_OPERATION_APPLY',grant});
        }catch(error){result={outcome:'NEEDS_VERIFICATION',message:String(error?.message||error)};}
        const outcome=['FAILED','CANCELLED','NEEDS_VERIFICATION'].includes(result?.outcome)?result.outcome:'NEEDS_VERIFICATION';
        const recorded=await callService('listing.browser.result',{id:grant.id,token:grant.token,outcome,message:String(result?.message||'resultado desconhecido; não repetir').slice(0,1000),...(result?.duplicateReceipt?.message?{duplicateReceipt:result.duplicateReceipt.message}:{})});
        const verified=recorded?.ok&&outcome==='NEEDS_VERIFICATION'&&result?.clicked===true
          ? input.action==='DUPLICATE'
            ? await observeDuplicateInFreshTab(tab,grant,input.proposalId,result.baseline,result.duplicateReceipt)
            : await verifyVariationInFreshTab(tab,grant,input.proposalId)
          : null;
        sendResponse(verified??recorded);return;
      }
      if(['campaign.browser.apply','campaign.browser.verify'].includes(message.method)){
        const input=message.payload??{};
        if(typeof input.proposalId!=='string'||typeof input.campaignRef!=='string'||input.confirmed!==true)throw Error('proposta, campanha e confirmação explícitas necessárias');
        const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
        if(!tab?.id||marketplaceOf(tab.url)!=='mercado_livre')throw Error('abra a publicidade do Mercado Livre');
        const info=await chrome.tabs.sendMessage(tab.id,{type:'MI_CAMPAIGN_BUDGET_CONTEXT',campaignRef:input.campaignRef,changeKind:input.changeKind});
        if(!info?.ok)throw Error(info?.error||'contexto não reconhecido');
        const {ok,...ctx}=info;
        const payload={...ctx,proposalId:input.proposalId};
        if(message.method==='campaign.browser.verify'){sendResponse(await callService('campaign.budget.verify',payload));return;}
        const claim=await callService('campaign.budget.claim',{...payload,confirmed:true});
        if(!claim?.ok||!claim.result){sendResponse(claim);return;}
        const grant=claim.result;
        let result;
        try{
          const current=await chrome.tabs.get(tab.id);
          if(!current.active||current.url!==tab.url)throw Error('aba mudou após autorização');
          result=await chrome.tabs.sendMessage(tab.id,{type:'MI_CAMPAIGN_BUDGET_APPLY',grant});
        }catch(error){result={outcome:'NEEDS_VERIFICATION',message:String(error?.message||error)};}
        const outcome=['FAILED','CANCELLED','NEEDS_VERIFICATION'].includes(result?.outcome)?result.outcome:'NEEDS_VERIFICATION';
        const recorded=await callService('campaign.budget.result',{id:grant.id,token:grant.token,outcome,message:String(result?.message||'resultado desconhecido; não repetir').slice(0,1000)});
        const verified=recorded?.ok && outcome==='NEEDS_VERIFICATION' && result?.clicked===true
          ? await verifyCampaignInFreshTab(tab,grant,input.proposalId)
          : null;
        sendResponse(verified??recorded);return;
      }
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
