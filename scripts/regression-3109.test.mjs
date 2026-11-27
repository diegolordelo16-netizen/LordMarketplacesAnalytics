import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../packages/extension/service-worker.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../packages/local-agent/panel/src/app.js', import.meta.url), 'utf8');
const root = 'https://seller.shopee.com.br/datacenter';
const orders = 'https://seller.shopee.com.br/order';

function scanFixture({ captureOk = true, links = [], current = root, next = {}, pageInfo = {} } = {}) {
  const captured = [], progress = [], created = [];
  let tabUrl = current;
  const info = (url) => ({ ok: true, url, accountId: 'store-a', pageKind: url === root ? 'seller_dashboard' : 'seller_orders', authorizedAreaLinks: url === root ? links : [], nextPageUrl: next[url], ...(pageInfo[url] || {}) });
  const ctx = vm.createContext({ URL, URLSearchParams, setTimeout: (fn) => fn(),
    marketplaceOf: () => 'shopee',
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
