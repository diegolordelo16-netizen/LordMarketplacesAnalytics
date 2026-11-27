import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../packages/extension/service-worker.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../packages/local-agent/panel/src/app.js', import.meta.url), 'utf8');
const root = 'https://seller.shopee.com.br/datacenter';
const orders = 'https://seller.shopee.com.br/order';

function scanFixture({ captureOk = true, links = [], current = root, next = {}, pageInfo = {}, learned = [], graph = [] } = {}) {
  const captured = [], progress = [], created = [];
  let tabUrl = current;
  const info = (url) => ({ ok: true, url, accountId: 'store-a', pageKind: url === root ? 'seller_dashboard' : 'seller_orders', authorizedAreaLinks: url === root ? links : [], nextPageUrl: next[url], ...(pageInfo[url] || {}) });
  const ctx = vm.createContext({ URL, URLSearchParams, setTimeout: (fn) => fn(),
    marketplaceOf: () => 'shopee',
    callService: async (method) => method==='navigation.list'?{ok:true,result:learned}:method==='navigation.graph'?{ok:true,result:graph}:{ok:false},
    captureTab: async (id, expected) => { captured.push(expected.url); return { ok: captureOk, error: captureOk ? undefined : 'offline' }; },
    readCapturePageInfo: async () => info(tabUrl),
    waitForTabComplete: async () => {},
    chrome: { tabs: { get: async (id) => ({ id, url: id === 1 ? current : tabUrl, windowId: 1 }),
      sendMessage: async () => info(current), create: async () => { created.push(true); return { id: 2 }; },
      update: async (_, { url }) => { tabUrl = url; }, remove: async () => {} } },
    opts: { onProgress: async (value) => progress.push(structuredClone(value)) },
  });
  vm.runInContext(worker.slice(worker.indexOf('const AUTHORIZED_AREA_KINDS'), worker.indexOf('/**\n * Executor DRAFT')), ctx);
  return { ctx, captured, progress, created, scan: (max, resumeState) => {
    ctx.opts.resumeState = resumeState; ctx.max = max;
    return vm.runInContext('captureAuthorizedAreas(1, max, opts)', ctx);
  } };
}

test('falha da página inicial fica pendente e impede avanço indevido', async () => {
  const f = scanFixture({ captureOk: false, links: [{ url: orders, pageKind: 'seller_orders' }] });
  const result = await f.scan(2);
  assert.equal(result.ok, false);
  assert.equal(result.pendingPages, 2);
  assert.deepEqual(f.captured, [root]);
  assert.equal(f.created.length, 0);
  assert.equal(f.progress.at(-1).pendingLinks[0].url, root);
});

test('retomada substitui a tentativa falha mesmo no limite de páginas', async () => {
  const f = scanFixture();
  const result = await f.scan(1, { maxPages: 1, pages: [{ page: 1, url: root, pageKind: 'seller_dashboard', ok: false }], pendingLinks: [{ url: root }], seenUrls: [] });
  assert.equal(result.pagesScanned, 1);
  assert.equal(result.pagesSucceeded, 1);
  assert.equal(result.pendingPages, 0);
  assert.deepEqual(f.captured, [root]);
  assert.equal(f.created.length, 0);
});

test('retomada de área secundária usa o registro existente sem recapturar a raiz', async () => {
  const f = scanFixture();
  const result = await f.scan(2, { maxPages: 2, pages: [{ page: 1, url: root, pageKind: 'seller_dashboard', ok: true }, { page: 2, url: orders, pageKind: 'seller_orders', ok: false }], pendingLinks: [{ url: orders }], seenUrls: [root] });
  assert.equal(result.pagesScanned, 2);
  assert.equal(result.pagesSucceeded, 2);
  assert.equal(result.pendingPages, 0);
  assert.deepEqual(f.captured, [orders]);
});

test('coleta geral segue paginação de uma área e preserva filtros conhecidos', async () => {
  const first = orders + '?page=1&start_date=2026-11-01&end_date=2026-11-30';
  const second = orders + '?page=2&start_date=2026-11-01&end_date=2026-11-30';
  const f = scanFixture({ current: first, next: { [first]: second } });
  const result = await f.scan(20);
  assert.deepEqual(f.captured, [first, second]);
  assert.equal(result.pagesSucceeded, 2);
  assert.equal(result.pendingPages, 0);
});
test('varredura percorre mais de doze páginas sem recapturar a raiz', async () => {
  const urls = Array.from({length: 16}, (_, i) => orders + '?page=' + (i+1));
  const next = Object.fromEntries(urls.slice(0,-1).map((url,i)=>[url,urls[i+1]]));
  const f = scanFixture({ current: urls[0], next });
  const result = await f.scan(20);
  assert.deepEqual(f.captured, urls);
  assert.equal(result.pagesSucceeded, 16);
});
test('filtro opaco não é removido silenciosamente e não gera conclusão integral', async () => {
  const f = scanFixture({ links: [{url: orders + '?token=not-a-real-token', pageKind:'seller_orders'}] });
  const result = await f.scan(20);
  assert.deepEqual(f.captured, [root]);
  assert.equal(result.unsupportedLinks, true);
});
test('CAPTCHA ou alteração de conta impede captura da próxima página', async () => {
  for (const pageInfo of [{challenge:true}, {accountId:'other'}]) {
    const f = scanFixture({ links: [{url:orders,pageKind:'seller_orders'}], pageInfo:{[orders]:pageInfo} });
    const result = await f.scan(20);
    assert.deepEqual(f.captured,[root]);
    assert.equal(result.pendingPages,1);
  }
});
test('continuação amplia o orçamento quando a janela anterior está concluída', async () => {
  const f = scanFixture({links:[{url:orders,pageKind:'seller_orders'}]});
  const result = await f.scan(1, {maxPages:1,pages:[{page:1,url:root,pageKind:'seller_dashboard',ok:true}],seenUrls:[root],pendingLinks:[{url:orders}]});
  assert.deepEqual(f.captured,[orders]);
  assert.equal(result.pagesSucceeded,2);
});

test('continuação de loja com 205 páginas não perde histórico nem recaptura páginas anteriores', async () => {
  const urls = Array.from({length:205},(_,i)=>orders+'?page='+(i+1));
  const next = Object.fromEntries(urls.slice(199,-1).map((url,i)=>[url,urls[200+i]]));
  const f = scanFixture({current:urls[0],next});
  const pages=urls.slice(0,200).map((url,i)=>({page:i+1,url,pageKind:'seller_orders',ok:true}));
  const result=await f.scan(50,{maxPages:200,pages,seenUrls:urls.slice(0,200),pendingLinks:[{url:urls[200]}]});
  assert.equal(result.pagesSucceeded,205);
  assert.deepEqual(f.captured,urls.slice(200));
});
test('controle de próxima página sem URL não permite conclusão silenciosa', async () => {
  const f=scanFixture({pageInfo:{[root]:{paginationUnsupported:true}}});
  const result=await f.scan(50);
  assert.equal(result.unsupportedLinks,true);
});

test('paginação não descarta filtro presente na URL',async()=>{
  const first=orders+'?page=1&start_date=2026-11-01',second=orders+'?page=2';
  const f=scanFixture({current:first,next:{[first]:second}});
  const result=await f.scan(50);
  assert.deepEqual(f.captured,[first]);assert.equal(result.unsupportedLinks,true);
});
test('paginação pausa quando filtro visível muda sem alterar a URL de filtro',async()=>{
  const first=orders+'?page=1',second=orders+'?page=2';
  const f=scanFixture({current:first,next:{[first]:second},pageInfo:{[first]:{filterSignature:'period=last 7 days'},[second]:{filterSignature:'period=last 30 days'}}});
  const result=await f.scan(50);
  assert.deepEqual(f.captured,[first]);assert.equal(result.pendingPages,1);
  assert.equal(f.progress.at(-1).pendingLinks[0].filterSignature,'period=last 7 days');
});
test('tabela virtualizada impede conclusão integral',async()=>{
  const f=scanFixture({pageInfo:{[root]:{coverageWarnings:['TABELA_VIRTUALIZADA']}}});
  const result=await f.scan(50);
  assert.equal(result.unsupportedLinks,true);
  assert.deepEqual(f.progress.at(-1).pages[0].coverageWarnings,['TABELA_VIRTUALIZADA']);
});

function renderFixture() {
  const pending = [];
  const host = { innerHTML: '' }, title = { textContent: '' };
  const state = { view: 'exec', accountId: 'a' };
  const ctx = vm.createContext({ state, VIEWS: { exec: { label: 'Dashboard', render: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } }, $: (sel) => sel === '#view' ? host : title, initializeTables: () => {}, esc: String });
  vm.runInContext(dashboard.slice(dashboard.indexOf('let viewRenderSequence'), dashboard.indexOf('// ------------------------------------------------------------------ ações')), ctx);
  return { pending, state, host, render: () => vm.runInContext('renderView()', ctx) };
}

test('resposta de loja anterior não substitui a loja atual', async () => {
  const f = renderFixture();
  const first = f.render(); f.state.accountId = 'b'; const second = f.render();
  f.pending[1].resolve('loja b'); assert.equal(await second, true);
  f.pending[0].resolve('loja a'); assert.equal(await first, false);
  assert.equal(f.host.innerHTML, 'loja b');
});

test('erro atrasado não apaga a tela atual', async () => {
  const f = renderFixture();
  const first = f.render(); const second = f.render();
  f.pending[1].resolve('atual'); await second;
  f.pending[0].reject(new Error('erro antigo')); assert.equal(await first, false);
  assert.equal(f.host.innerHTML, 'atual');
});

test('erro atual é exibido e não retorna sucesso', async () => {
  const f = renderFixture(); const call = f.render();
  f.pending[0].reject(new Error('serviço indisponível'));
  assert.equal(await call, false); assert.match(f.host.innerHTML, /serviço indisponível/);
});

test('concorrência consulta o produto da loja atual, nunca o produto selecionado de outra loja', async () => {
  const state = { accountId: 'loja-b', ownProductId: 'produto-a' };
  const calls = [];
  const ctx = vm.createContext({ state, viewRenderSequence: 1, api: async (method, payload) => {
    calls.push([method, structuredClone(payload)]);
    return method === 'competitor.ownProduct.list' ? [{ id: 'produto-b' }] : {};
  } });
  const start = dashboard.indexOf('async function viewCompetition()');
  const end = dashboard.indexOf('  const s = stats || {};', start);
  await vm.runInContext(dashboard.slice(start, end) + '\n}\nviewCompetition()', ctx);
  assert.deepEqual(calls, [['competitor.ownProduct.list', { accountId: 'loja-b' }], ['competitor.stats', { accountId: 'loja-b', ownProductId: 'produto-b' }]]);
  assert.equal(state.ownProductId, 'produto-b');
});


test('coleta de anúncios SPA confirma conta, filtros, número de página e mudança de IDs',async()=>{
  const source='https://seller.shopee.com.br/portal/product/list';
  let page=1,closed=false;
  const info=()=>({ok:true,marketplace:'shopee',pageKind:'seller_listings',accountId:'store-a',url:source,filterSignature:'period=last 7 days',spaPagination:{page,canAdvance:page<2}});
  const snapshots=()=>({accountId:'store-a',url:source,filterSignature:'period=last 7 days',spaPage:page,listings:[{listingId:'L'+page}]});
  const captures=[];
  const ctx=vm.createContext({URL,URLSearchParams,setTimeout:fn=>fn(),marketplaceOf:()=> 'shopee',readCapturePageInfo:async()=>info(),captureTab:async(id,expected)=>{captures.push(expected);return {ok:true,snapshot:snapshots()}},chrome:{tabs:{get:async()=>({url:source,windowId:1}),create:async()=>({id:2}),remove:async()=>{closed=true},sendMessage:async(_,msg)=>{if(msg.type==='MI_CAPTURE_ADVANCE_SPA'){page++;return {ok:true}}if(msg.type==='MI_CAPTURE_REQUEST')return {ok:true,snapshot:snapshots()};return info()}}}});
  vm.runInContext(worker.slice(worker.indexOf('async function captureListingPages'),worker.indexOf('async function captureAuthorizedAreas')),ctx);
  const result=await vm.runInContext('captureListingPages(1,5)',ctx);
  assert.equal(result.pagesSucceeded,2);assert.equal(result.complete,true);assert.equal(result.totalListings,2);
  assert.equal(captures[1].spaPage,2);assert.equal(closed,true);
});


test('coleta dedicada reaplica filtro reconhecido na aba temporária e verifica a seleção',async()=>{
  const source='https://seller.shopee.com.br/portal/product/list';
  let selected='period=last 30 days',restores=0;
  const info=()=>({ok:true,marketplace:'shopee',pageKind:'seller_listings',accountId:'store-a',url:source,filterSignature:selected});
  const snapshot=()=>({accountId:'store-a',url:source,filterSignature:selected,listings:[{listingId:'L1'}]});
  const ctx=vm.createContext({URL,URLSearchParams,setTimeout:fn=>fn(),marketplaceOf:()=> 'shopee',readCapturePageInfo:async()=>info(),captureTab:async()=>({ok:true,snapshot:snapshot()}),chrome:{tabs:{get:async()=>({url:source,windowId:1}),create:async()=>({id:2}),remove:async()=>{},sendMessage:async(id,msg)=>{if(id===1)return {...info(),filterSignature:'period=last 7 days'};if(msg.type==='MI_CAPTURE_REAPPLY_FILTERS'){selected=msg.targetSignature;restores++;return {ok:true}}if(msg.type==='MI_CAPTURE_REQUEST')return {ok:true,snapshot:snapshot()};return info()}}}});
  vm.runInContext(worker.slice(worker.indexOf('async function captureListingPages'),worker.indexOf('async function captureAuthorizedAreas')),ctx);
  const result=await vm.runInContext('captureListingPages(1,5)',ctx);
  assert.equal(result.pagesSucceeded,1);assert.equal(restores,1);assert.equal(selected,'period=last 7 days');
});


test('retomada avançada revisita marcadores conhecidos e não recaptura páginas concluídas',async()=>{
  const source='https://seller.shopee.com.br/portal/product/list';
  let page=1;
  const info=()=>({ok:true,marketplace:'shopee',pageKind:'seller_listings',accountId:'store-a',url:source,filterSignature:'',spaPagination:{page,canAdvance:page<3}});
  const snapshot=()=>({accountId:'store-a',url:source,filterSignature:'',spaPage:page,listings:[{listingId:'L'+page}]});
  const captures=[],progress=[];
  const digest=async value=>[...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const known={page:1,pageKind:'seller_listings',url:source,spaPage:1,filterSignature:'',listingFingerprint:await digest(JSON.stringify(['L1'])),listingIds:['L1'],ok:true};
  const opts={logicalBatchId:'batch-a',expectedAccountId:'store-a',resumeState:{pages:[known]},onProgress:async state=>progress.push(structuredClone(state))};
  const ctx=vm.createContext({URL,URLSearchParams,crypto:globalThis.crypto,TextEncoder,setTimeout:fn=>fn(),marketplaceOf:()=> 'shopee',readCapturePageInfo:async()=>info(),captureTab:async(_,expected)=>{captures.push(expected.spaPage);return {ok:true,snapshot:snapshot()}},chrome:{tabs:{get:async()=>({url:source,windowId:1}),create:async()=>({id:2}),remove:async()=>{},sendMessage:async(_,msg)=>{if(msg.type==='MI_CAPTURE_ADVANCE_SPA'){page++;return {ok:true}}if(msg.type==='MI_CAPTURE_REQUEST')return {ok:true,snapshot:snapshot()};return info()}}},opts});
  vm.runInContext(worker.slice(worker.indexOf('async function captureListingPages'),worker.indexOf('async function captureAuthorizedAreas')),ctx);
  const result=await vm.runInContext('captureListingPages(1,5,opts)',ctx);
  assert.deepEqual(captures,[2,3]);assert.equal(result.pagesSucceeded,3);assert.equal(result.complete,true);assert.equal(progress.at(-1).unsupportedLinks,false);
});

function generalSpaFixture({repeat=false,changeAccount=false}={}){
  const captures=[],progress=[];
  const url='https://seller.shopee.com.br/ratings';
  let page=1,closed=false;
  const info=()=>({ok:true,url,marketplace:'shopee',accountId:changeAccount&&page===2?'other':'store-a',pageKind:'seller_reputation',filterSignature:'',spaPagination:{page,canAdvance:page<2},paginationUnsupported:page<2,authorizedAreaLinks:[]});
  const snapshot=()=>({...info(),spaPage:page,customerVoice:[{kind:'REVIEW',externalRef:'R'+(repeat?1:page),text:'review'}]});
  const opts={logicalBatchId:'batch-1',onProgress:async v=>progress.push(structuredClone(v))};
  const ctx=vm.createContext({URL,URLSearchParams,crypto:globalThis.crypto,TextEncoder,setTimeout:fn=>fn(),marketplaceOf:()=> 'shopee',readCapturePageInfo:async()=>info(),waitForTabComplete:async()=>{},captureTab:async(_,expected)=>{captures.push(expected);return {ok:true,snapshot:snapshot()}},chrome:{tabs:{get:async()=>({url,windowId:1}),create:async()=>({id:2}),update:async()=>{page=1},remove:async()=>{closed=true},sendMessage:async(_,msg)=>{if(msg.type==='MI_CAPTURE_ADVANCE_SPA'){page++;return {ok:true}}if(msg.type==='MI_CAPTURE_REQUEST')return {ok:true,snapshot:snapshot()};return info()}}},opts});
  vm.runInContext(worker.slice(worker.indexOf('const AUTHORIZED_AREA_KINDS'),worker.indexOf('/**\n * Executor DRAFT')),ctx);
  return {captures,progress,closed:()=>closed,scan:async(max,resumeState)=>{page=1;ctx.max=max;opts.resumeState=resumeState;return vm.runInContext('captureAuthorizedAreas(1,max,opts)',ctx)}};
}
test('SPA geral distingue avaliações na mesma URL, retoma sem recaptura e preserva totais',async()=>{
  const f=generalSpaFixture();
  const first=await f.scan(1);
  assert.equal(first.pagesSucceeded,1);assert.equal(first.pendingPages,1);
  const second=await f.scan(1,f.progress.at(-1));
  assert.equal(second.pagesSucceeded,2);assert.equal(second.pendingPages,0);assert.equal(second.unsupportedLinks,false);
  assert.deepEqual(f.captures.map(x=>x.spaPage),[1,2]);
  assert.notEqual(f.captures[0].captureKey,f.captures[1].captureKey);
  assert.equal(f.captures[1].skipAreaTotals,true);assert.equal(f.closed(),true);
});
test('SPA geral interrompe registros repetidos e mudança de conta',async()=>{
  for(const options of [{repeat:true},{changeAccount:true}]){
    const f=generalSpaFixture(options);
    const result=await f.scan(5);
    assert.equal(result.pagesSucceeded,1);assert.equal(result.pendingPages,1);assert.equal(result.unsupportedLinks,true);
    assert.equal(f.captures.length,1);assert.equal(f.closed(),true);
  }
});

test('memória prioriza apenas rotas visíveis, sem introduzir links ocultos',async()=>{
  const ratings='https://seller.shopee.com.br/ratings';
  const f=scanFixture({links:[{url:orders,pageKind:'seller_orders'},{url:ratings,pageKind:'seller_reputation'}],pageInfo:{[ratings]:{pageKind:'seller_reputation'}},learned:[{route:'/ratings',page_kind:'seller_reputation'},{route:'/inventory',page_kind:'seller_inventory'}]});
  const result=await f.scan(5);
  assert.equal(result.pagesSucceeded,3);
  assert.deepEqual(f.captured,[root,ratings,orders]);
});

test('grafo prioriza transições conhecidas da página atual sem inventar caminhos',async()=>{
  const ratings='https://seller.shopee.com.br/ratings';
  const f=scanFixture({links:[{url:orders,pageKind:'seller_orders'},{url:ratings,pageKind:'seller_reputation'}],pageInfo:{[ratings]:{pageKind:'seller_reputation'}},learned:[{route:'/order',page_kind:'seller_orders'}],graph:[{from_route:'/datacenter',to_route:'/ratings'},{from_route:'/datacenter',to_route:'/inventory'}]});
  const result=await f.scan(5);
  assert.equal(result.pagesSucceeded,3);
  assert.deepEqual(f.captured,[root,ratings,orders]);
});

test('atalhos de comparação usam dias UTC completos e meses de duração equivalente',()=>{
  const ctx=vm.createContext({Date});
  vm.runInContext(dashboard.slice(dashboard.indexOf('function comparisonPreset('),dashboard.indexOf('async function viewCompare()')),ctx);
  const dates=(preset,at)=>JSON.parse(JSON.stringify(vm.runInContext('comparisonPreset('+JSON.stringify(preset)+',new Date('+JSON.stringify(at)+'))',ctx)));
  assert.deepEqual(dates('7','2026-03-01T02:00:00Z'),['2026-02-22','2026-02-28','2026-02-15','2026-02-21']);
  assert.deepEqual(dates('today','2026-01-01T01:00:00Z'),['2026-01-01','2026-01-01','2025-12-31','2025-12-31']);
  assert.deepEqual(dates('month','2026-03-31T12:00:00Z'),['2026-03-01','2026-03-28','2026-02-01','2026-02-28']);
  assert.equal(dates('month','2026-03-01T12:00:00Z'),null);
});

test('gráfico histórico mantém distância temporal e não conecta dias sem evidência',()=>{
  const ctx=vm.createContext({esc:String,brl:String,num:String,Date});
  vm.runInContext(dashboard.slice(dashboard.indexOf('function historyMetricConfig('),dashboard.indexOf('function dt(')),ctx);
  const html=vm.runInContext("renderHistoryChart([{date:'2026-11-01',gmvCents:100},{date:'2026-11-02',gmvCents:null},{date:'2026-11-04',gmvCents:150},{date:'2026-11-05',gmvCents:200}])",ctx);
  const path=html.match(/class="trend-path" d="([^"]+)"/)[1];
  assert.equal((path.match(/M /g)||[]).length,2);
  assert.equal((path.match(/L /g)||[]).length,1);
});

test('gráfico histórico oferece métricas adicionais e mantém zero distinto de ausência',()=>{
  const ctx=vm.createContext({esc:String,brl:String,num:String,pct:String,Date});
  vm.runInContext(dashboard.slice(dashboard.indexOf('function historyMetricConfig('),dashboard.indexOf('function dt(')),ctx);
  const keys=vm.runInContext('Object.keys(historyMetricConfig())',ctx);
  for(const key of ['units','stockAvailable','cvr','roas','aovCents','reviewRating','returnsCount'])assert.ok(keys.includes(key));
  const html=vm.runInContext("renderHistoryChart([{date:'2026-11-01',units:0},{date:'2026-11-02',units:2}],'units')",ctx);
  assert.ok(html.includes('trend-path'));
});

test('executivo usa os mesmos filtros em KPIs, histórico e diagnóstico sem misturar lucro da loja',async()=>{
  const calls=[];
  const ctx=vm.createContext({
    state:{accountId:'store-a',execFilters:{marketplace:'shopee',days:7,listingId:'L1',skuId:'S1'},historyPoints:[]},viewRenderSequence:1,
    api:async(method,payload)=>{calls.push({method,payload});if(method==='kpi.dashboard')return {totals:{gmvCents:100}};if(method==='kpi.history')return {points:[]};if(method==='kpi.compare.detail')return {rows:[],campaigns:[]};return [];},
    comparisonPreset:()=>['2026-11-01','2026-11-07','2026-10-25','2026-10-31'],
    esc:String,brl:String,num:String,pct:String,dt:String,badge:String,card:(a,b)=>a+b,table:()=>'',historyMetricConfig:()=>({}),renderHistoryChart:()=>'',Array
  });
  vm.runInContext(dashboard.slice(dashboard.indexOf('async function viewExec()'),dashboard.indexOf('// ------------------------------------------------------------------ ANÚNCIOS / CAPTURA')),ctx);
  const html=await vm.runInContext('viewExec()',ctx);
  const scope={accountId:'store-a',marketplace:'shopee',days:7,listingId:'L1',skuId:'S1'};
  for(const method of ['kpi.dashboard','kpi.history'])assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c=>c.method===method).payload)),scope);
  const diagnostic=calls.find(c=>c.method==='kpi.compare.detail').payload;
  assert.equal(diagnostic.accountId,'store-a');assert.equal(diagnostic.listingId,'L1');assert.equal(diagnostic.skuId,'S1');
  assert.equal(calls.some(c=>c.method.startsWith('finance.realized.')),false);
  assert.ok(html.includes('Diagnósticos automáticos'));assert.ok(html.includes('Aplicar filtros'));
});

test('cadastro financeiro exige evidência e todos os valores explícitos, inclusive zero',()=>{
  const ctx=vm.createContext({Date,Number,Math});
  vm.runInContext(dashboard.slice(dashboard.indexOf('const REALIZED_FIELDS='),dashboard.indexOf('async function viewFinance()')),ctx);
  const fields=vm.runInContext('REALIZED_FIELDS',ctx);
  const inputs={'rp-from':'2026-10-01','rp-to':'2026-10-31','rp-evidence':'Relatório conciliado','rp-listing':''};
  for(const [key] of fields)inputs['rp-'+key]='0';
  inputs['rp-netRevenueCents']='123,45';
  ctx.inputs=inputs;
  const payload=()=>vm.runInContext("realizedPayload(id=>inputs[id],'store-a')",ctx);
  assert.equal(payload().netRevenueCents,12345);
  assert.equal(payload().productCostCents,0);
  assert.equal(payload().sourceClass,'F_USER_INPUT');
  inputs['rp-productCostCents']='';
  assert.throws(payload,/Informe Custo/);
  inputs['rp-productCostCents']='0';
  inputs['rp-from']='2026-02-30';
  assert.throws(payload,/período válido/);
});

test('publicidade distingue receita ausente de zero e protege divisões',()=>{
  const ctx=vm.createContext({Number});
  vm.runInContext(dashboard.slice(dashboard.indexOf('function observedAdsMetrics('),dashboard.indexOf('async function viewAds()')),ctx);
  const m=vm.runInContext('observedAdsMetrics({adSpend:100,adAttributedRevenue:0,adClicks:10,paidImpressions:200})',ctx);
  assert.equal(m.roas,0);assert.equal(m.acos,null);assert.equal(m.ctr,5);assert.equal(m.cpc,10);
  assert.equal(m.signal,'INVESTIMENTO_SEM_RECEITA_ATRIBUIDA');
  const unknown=vm.runInContext('observedAdsMetrics({adSpend:100})',ctx);
  assert.equal(unknown.revenue,null);assert.equal(unknown.roas,null);assert.equal(unknown.signal,null);
});

test('executor orçamento exige formulário exclusivo, confirmação e autorização sem replay',async()=>{
  const src=readFileSync(new URL('../packages/extension/content/mercado-livre.js',import.meta.url),'utf8');
  const snippet=src.slice(src.indexOf('let budgetDocumentNonce='),src.indexOf('async function publishApprovedChange'));
  let clicks=0,consent=true,ambiguous=false,challenge=false,accountId='store-a',extraField=false,target='',buttonOverride=false;
  class Input {
    constructor(){this.raw='10.00';}
    get value(){return this.raw;}
    set value(v){this.raw=v;}
    getAttribute(n){return n==='aria-label'?'Orçamento diário (R$)':null;}
    closest(selector){return selector==='[data-campaign-id]'?row:form;}
    get form(){return form;}
    get type(){return 'number';}
    dispatchEvent(){}
    checkValidity(){return true;}
  }
  const field=new Input(),button={textContent:'Salvar',disabled:false,getAttribute:()=>null,hasAttribute:name=>buttonOverride&&name==='formtarget',get form(){return form;},click:()=>clicks++};
  const form={action:'https://vendedores.mercadolivre.com.br/publicidade',get target(){return target;},get elements(){return extraField?[field,{type:'email'}]:[field];},querySelector:()=>null,querySelectorAll:()=>[button]};
  class StatusSelect {
    get value(){return this.current??'active';}
    set value(v){this.current=v;}
    getAttribute(key){return key==='aria-label'?'Status da campanha':null;}
    hasAttribute(){return false;}
    closest(selector){return selector==='form'?statusForm:row;}
    get form(){return statusForm;}
    get type(){return 'select-one';}
    get options(){return [{textContent:'Ativa',value:'active',getAttribute:()=>null},{textContent:'Pausada',value:'paused',getAttribute:()=>null}];}
    dispatchEvent(){}
    checkValidity(){return true;}
  }
  const statusField=new StatusSelect();
  const statusButton={...button,get form(){return statusForm;}};
  const statusForm={...form,elements:[statusField],querySelectorAll:()=>[statusButton]};
  class RoasInput extends Input {
    constructor(){super();this.raw='5.00';}
    getAttribute(n){return n==='aria-label'?'ROAS objetivo (x)':null;}
    closest(selector){return selector==='[data-campaign-id]'?row:roasForm;}
    get form(){return roasForm;}
  }
  const roasField=new RoasInput();
  const roasButton={...button,get form(){return roasForm;}};
  const roasForm={...form,elements:[roasField],querySelectorAll:()=>[roasButton]};
  const row={getAttribute:n=>n==='data-campaign-id'?'C1':null,querySelectorAll:selector=>selector==='select'?[statusField]:[field,roasField],contains:el=>el===form||el===statusForm||el===roasForm};
  const document={visibilityState:'visible',querySelector:()=>null,querySelectorAll:()=>ambiguous?[row,row]:[row]};
  const ctx=vm.createContext({URL,Date,crypto:{randomUUID:()=> 'doc-1'},document,location:new URL(form.action),window:{MI_DOM:{isVisible:()=>true,hasChallenge:()=>challenge},confirm:()=>consent},currentPageKind:()=> 'seller_ads',visibleAccountIdentity:()=>({accountId}),isEditableVisible:()=>true,HTMLInputElement:Input,HTMLSelectElement:StatusSelect,Event:class{},setTimeout:fn=>fn()});
  vm.runInContext(snippet,ctx);
  const grant=(id)=>({id,accountId:'store-a',campaignRef:'C1',sourcePath:form.action,documentNonce:'doc-1',beforeCents:1000,targetCents:1200,expiresAt:new Date(Date.now()+60000).toISOString()});
  const apply=async id=>{ctx.grant=grant(id);return vm.runInContext('applyCampaignBudget(grant)',ctx);};
  ambiguous=true;assert.equal((await apply('ambiguous')).outcome,'FAILED');ambiguous=false;
  challenge=true;assert.equal((await apply('challenge')).outcome,'FAILED');challenge=false;
  extraField=true;assert.equal((await apply('multiple')).outcome,'FAILED');extraField=false;
  target='_blank';assert.equal((await apply('target')).outcome,'FAILED');target='';
  buttonOverride=true;assert.equal((await apply('override')).outcome,'FAILED');buttonOverride=false;
  accountId='other';assert.equal((await apply('wrong')).outcome,'FAILED');accountId='store-a';
  consent=false;assert.equal((await apply('cancel')).outcome,'CANCELLED');consent=true;
  assert.equal(clicks,0);assert.equal(field.value,'10.00');
  assert.equal((await apply('valid')).outcome,'NEEDS_VERIFICATION');assert.equal(field.value,'12.00');assert.equal(clicks,1);
  assert.equal((await apply('valid')).outcome,'FAILED');assert.equal(clicks,1);
  ctx.grant={...grant('pause'),beforeCents:1200,targetCents:1200,beforeStatus:'ACTIVE',targetStatus:'PAUSED'};
  assert.equal((await vm.runInContext('applyCampaignBudget(grant)',ctx)).clicked,true);
  assert.equal(statusField.value,'paused');assert.equal(field.value,'12.00');assert.equal(clicks,2);
  ctx.grant={...grant('roas'),beforeCents:1200,targetCents:1200,beforeRoas:500,targetRoas:650};
  assert.equal((await vm.runInContext('applyCampaignBudget(grant)',ctx)).clicked,true);
  assert.equal(roasField.value,'6.50');assert.equal(field.value,'12.00');assert.equal(clicks,3);
});

test('variação simples e duplicação assistidas recusam ambiguidade e repetição',async()=>{
  const src=readFileSync(new URL('../packages/extension/content/mercado-livre.js',import.meta.url),'utf8');
  const snippet=src.slice(src.indexOf('let budgetDocumentNonce='),src.indexOf('async function publishApprovedChange'));
  const listing='MLB1234567',editUrl='https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/'+listing,listUrl='https://vendedores.mercadolivre.com.br/vendas/anuncios';
  let clicks=0,consent=true,ambiguous=false,kind='seller_listing_edit',accountId='store-a',challenge=false,nestedOther=false;
  class Input{
    constructor(label,type,value=''){this.label=label;this.type=type;this.raw=value;this.tagName='INPUT';}
    get value(){return this.raw;}set value(v){this.raw=v;}
    getAttribute(k){return k==='aria-label'?this.label:null;}
    dispatchEvent(){}checkValidity(){return true;}
  }
  const fields=[new Input('Nome da variação','text'),new Input('Opção da variação','text'),new Input('Preço (R$)','number'),new Input('Estoque','number','0')];
  const save={textContent:'Criar variação',disabled:false,getAttribute:()=>null,click:()=>clicks++};
  const form={action:editUrl,elements:fields,getAttribute:()=>null,querySelectorAll:()=>[save],querySelector:()=>null};
  fields.forEach(f=>f.form=form);
  save.form=form;
  const dup={textContent:'Duplicar anúncio',disabled:false,getAttribute:()=>null,closest:selector=>selector==='form'?null:nestedOther?{}:row,click:()=>clicks++};
  const row={getAttribute:k=>k==='data-item-id'?listing:null,querySelectorAll:()=>[dup]};
  const document={visibilityState:'visible',querySelector:()=>null,querySelectorAll:s=>s==='form'?(ambiguous?[form,form]:[form]):s==='[data-item-id],[data-listing-id]'?(ambiguous?[row,row]:[row]):[]};
  const ctx=vm.createContext({URL,Date,MAX_LISTINGS:100,captureListingList:()=>({accountId,listings:[{listingId:listing,title:'Teste'}]}),crypto:{randomUUID:()=> 'doc-1'},document,location:new URL(editUrl),window:{MI_DOM:{isVisible:()=>true,hasChallenge:()=>challenge,collectionFilterState:()=>({signature:'',warnings:[]})},confirm:()=>consent},currentPageKind:()=>kind,currentExternalListingId:()=>listing,visibleAccountIdentity:()=>({accountId}),isEditableVisible:()=>true,HTMLInputElement:Input,Event:class{},setTimeout:fn=>fn()});
  vm.runInContext(snippet,ctx);
  const apply=(id,action,url,plan)=>{ctx.grant={id,context:{accountId:'store-a',externalListingId:listing,sourcePath:url,documentNonce:'doc-1',action},plan,expiresAt:new Date(Date.now()+60000).toISOString()};return vm.runInContext('applyListingOperation(grant)',ctx);};
  const plan={name:'Cor',option:'Azul',priceCents:1200,stock:5};
  ambiguous=true;assert.equal((await apply('ambiguous','CREATE_VARIATION',editUrl,plan)).outcome,'FAILED');ambiguous=false;
  consent=false;assert.equal((await apply('cancel','CREATE_VARIATION',editUrl,plan)).outcome,'CANCELLED');consent=true;
  assert.equal(clicks,0);
  assert.equal((await apply('create','CREATE_VARIATION',editUrl,plan)).outcome,'NEEDS_VERIFICATION');
  assert.deepEqual(fields.map(f=>f.value),['Cor','Azul','12.00','5']);assert.equal(clicks,1);
  assert.equal((await apply('create','CREATE_VARIATION',editUrl,plan)).outcome,'FAILED');assert.equal(clicks,1);
  kind='seller_listings';ctx.location=new URL(listUrl);
  accountId='other';assert.equal((await apply('wrong','DUPLICATE',listUrl,{originalTitle:'Teste'})).outcome,'FAILED');accountId='store-a';
  challenge=true;assert.equal((await apply('challenge','DUPLICATE',listUrl,{originalTitle:'Teste'})).outcome,'FAILED');challenge=false;
  nestedOther=true;assert.equal((await apply('nested','DUPLICATE',listUrl,{originalTitle:'Teste'})).outcome,'FAILED');nestedOther=false;
  const duplicate=await apply('dup','DUPLICATE',listUrl,{originalTitle:'Teste'});
  assert.equal(duplicate.outcome,'NEEDS_VERIFICATION');
  assert.equal(duplicate.clicked,true);assert.equal(duplicate.baseline.listingIds[0],listing);assert.equal(clicks,2);
  assert.equal((await apply('dup','DUPLICATE',listUrl,{originalTitle:'Teste'})).outcome,'FAILED');assert.equal(clicks,2);
});

test('conferência automática de orçamento lê documento distinto da mesma conta e fecha a aba temporária',async()=>{
  const src=readFileSync(new URL('../packages/extension/service-worker.js',import.meta.url),'utf8');
  const snippet=src.slice(src.indexOf('async function verifyCampaignInFreshTab'),src.indexOf('async function readCapturePageInfo'));
  const sourcePath='https://vendedores.mercadolivre.com.br/publicidade';
  const tab={id:10,url:sourcePath,windowId:1};
  const grant={campaignRef:'C1',accountId:'store-a',sourcePath,documentNonce:'old',targetCents:1200};
  let info={ok:true,campaignRef:'C1',accountId:'store-a',sourcePath,documentNonce:'new',budgetCents:1200};
  const calls=[],removed=[];
  const ctx=vm.createContext({
    tab,grant,chrome:{tabs:{
      create:async options=>{assert.equal(options.active,false);assert.equal(options.url,sourcePath);return {id:11};},
      sendMessage:async(id,message)=>{assert.equal(id,11);assert.equal(message.type,'MI_CAMPAIGN_BUDGET_CONTEXT');return info;},
      remove:async id=>removed.push(id),
    }},
    waitForTabComplete:async(id,url)=>{assert.equal(id,11);assert.equal(url,sourcePath);},
    callService:async(method,payload)=>{calls.push({method,payload});return {ok:true,result:{status:'UI_READBACK_MATCHED'}};},
  });
  vm.runInContext(snippet,ctx);
  const verify=()=>vm.runInContext('verifyCampaignInFreshTab(tab,grant,"proposal")',ctx);
  assert.equal((await verify()).result.status,'UI_READBACK_MATCHED');
  assert.equal(calls[0].method,'campaign.budget.verify');
  assert.equal(calls[0].payload.proposalId,'proposal');
  for(const mismatch of [{accountId:'another-store'},{budgetCents:1000},{documentNonce:'old'}]){
    const original=info;
    info={...info,...mismatch};
    assert.equal(await verify(),null);
    info=original;
  }
  assert.equal(calls.length,1);
  assert.deepEqual(removed,[11,11,11,11]);
});

test('edição de variação só registra a releitura em documento novo e da mesma loja',async()=>{
  const start=worker.indexOf('async function verifyVariationInFreshTab');
  const end=worker.indexOf('async function readCapturePageInfo',start);
  assert.ok(start>=0&&end>start);
  const url='https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/MLB1234567';
  const context={accountId:'store-a',externalListingId:'MLB1234567',variationId:'V1',sourcePath:url,documentNonce:'original'};
  const grant={context,plan:{name:'Azul',priceCents:1200,stock:0}};
  const matched={ok:true,action:'EDIT_VARIATION',...context,documentNonce:'fresh',variationLabel:'Azul',beforePriceCents:1200,beforeStock:0};
  let observed=matched,ingested=1;
  const calls=[],removed=[];
  const ctx=vm.createContext({grant,tab:{url,windowId:3},waitForTabComplete:async()=>{},captureAccepted:r=>r.ok,
    chrome:{tabs:{create:async opts=>{assert.equal(opts.active,false);return {id:26};},
      remove:async id=>removed.push(id),sendMessage:async(id,message)=>{assert.equal(id,26);assert.equal(message.type,'MI_LISTING_OPERATION_CONTEXT');return observed;}}},
    callService:async(method,payload)=>{calls.push({method,payload});return {ok:true,result:method==='capture.ingest'?{detailRowsIngested:ingested}:{status:'UI_READBACK_MATCHED'}};}
  });
  vm.runInContext(worker.slice(start,end),ctx);
  const verify=()=>vm.runInContext('verifyVariationInFreshTab(tab,grant,"proposal")',ctx);
  assert.equal((await verify()).result.status,'UI_READBACK_MATCHED');
  assert.equal(calls[0].payload.details[0].metrics.stockAvailable,0);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].payload)),{accountId:'store-a',proposalId:'proposal',observedExternalId:'V1'});
  for(const mismatch of [{accountId:'other'},{externalListingId:'MLB9999999'},{documentNonce:'original'},{beforeStock:1}]){
    observed={...matched,...mismatch};
    assert.equal(await verify(),null);
  }
  assert.equal(calls.length,2);
  ingested=0;
  observed=matched;
  assert.equal(await verify(),null);
  assert.equal(calls.length,3);
  assert.deepEqual(removed,[26,26,26,26,26,26]);
});

test('criação assistida apenas registra um candidato único em nova leitura',async()=>{
  const start=worker.indexOf('async function verifyVariationInFreshTab');
  const end=worker.indexOf('async function readCapturePageInfo',start);
  const externalListingId='MLB1234567';
  const url='https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/'+externalListingId;
  const accountId='store-a',grant={context:{action:'CREATE_VARIATION',accountId,externalListingId,sourcePath:url},plan:{option:'Azul',priceCents:1200,stock:0}};
  const row={kind:'LISTING_VARIANT',parentExternalId:externalListingId,externalId:'V1',label:'Azul',metrics:{price:12,stockAvailable:0},evidence:{price:'R$ 12',stockAvailable:'0'}};
  const snapshot={accountId,marketplace:'mercado_livre',url,pageKind:'seller_listing_edit',details:[row]};
  const calls=[];
  const ctx=vm.createContext({grant,tab:{url},captureAccepted:r=>r.ok,waitForTabComplete:async()=>{},chrome:{tabs:{
    create:async()=>({id:27}),remove:async()=>{},sendMessage:async(_,request)=>{assert.equal(request.type,'MI_CAPTURE_REQUEST');return {ok:true,snapshot};},
  }},callService:async(method,payload)=>{calls.push({method,payload});return {ok:true,result:method==='capture.ingest'?{detailRowsIngested:1}:{status:'CANDIDATE_OBSERVED',remoteVerified:false}};}});
  vm.runInContext(worker.slice(start,end),ctx);
  const verify=()=>vm.runInContext('verifyVariationInFreshTab(tab,grant,"proposal")',ctx);
  snapshot.details=[row,{...row,externalId:'V2'}];
  assert.equal(await verify(),null);
  assert.equal(calls.length,0);
  snapshot.details=[row];
  assert.equal((await verify()).result.remoteVerified,false);
  assert.equal(calls[1].payload.observedExternalId,'V1');
});

test('duplicação assistida procura apenas um novo candidato no mesmo recorte da loja',async()=>{
  const start=worker.indexOf('async function observeDuplicateInFreshTab');
  const end=worker.indexOf('async function readCapturePageInfo',start);
  const url='https://vendedores.mercadolivre.com.br/anuncios',accountId='store-a',externalListingId='MLB1234567';
  const source={listingId:externalListingId,title:'Produto'};
  const existing={listingId:'MLB2345678',title:'Produto'};
  const candidate={listingId:'MLB3456789',title:'Produto'};
  const snapshot={accountId,marketplace:'mercado_livre',url,pageKind:'seller_listings',filterSignature:'status=all',listings:[source,existing,candidate]};
  const grant={context:{accountId,sourcePath:url,externalListingId},plan:{originalTitle:source.title}};
  const baseline={listingIds:[source.listingId,existing.listingId],filterSignature:'status=all'};
  const calls=[],removed=[];
  const ctx=vm.createContext({grant,baseline,tab:{url},captureAccepted:r=>r.ok,waitForTabComplete:async()=>{},chrome:{tabs:{
    create:async()=>({id:29}),remove:async id=>removed.push(id),sendMessage:async()=>({ok:true,snapshot}),
  }},callService:async(method,payload)=>{calls.push({method,payload});return {ok:true,result:method==='capture.ingest'
    ?{listingsIngested:1}:{status:'CANDIDATE_OBSERVED',remoteVerified:false}};}});
  vm.runInContext(worker.slice(start,end),ctx);
  const observe=()=>vm.runInContext('observeDuplicateInFreshTab(tab,grant,"proposal",baseline)',ctx);
  snapshot.filterSignature='status=active';
  assert.equal(await observe(),null);
  snapshot.filterSignature=baseline.filterSignature;
  snapshot.listings.push({listingId:'MLB4567890',title:'Produto'});
  assert.equal(await observe(),null);
  assert.equal(calls.length,0);
  snapshot.listings.pop();
  assert.equal((await observe()).result.remoteVerified,false);
  assert.equal(calls[0].payload.listings[0].listingId,candidate.listingId);
  assert.equal(calls[1].payload.observedExternalId,candidate.listingId);
  assert.deepEqual(removed,[29,29,29]);
});
