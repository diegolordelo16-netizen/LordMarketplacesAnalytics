import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(__dirname, '..', '..', '..');
const ext = join(root, 'packages', 'extension');

/** Carrega dom-utils.js em um contexto isolado e devolve window.MI_DOM. */
function loadDomUtils() {
  const code = readFileSync(join(ext, 'content', 'dom-utils.js'), 'utf8');
  const window: Record<string, unknown> = {};
  const context = vm.createContext({ window, Element: class {}, Number, String, Math, URL });
  vm.runInContext(code, context);
  return window.MI_DOM as {
    parseNumberPtBr: (t: unknown) => number | null;
    extractExternalId: (u: string) => string | null;
    normalizeLabel: (t: string) => string;
    safeNextPageUrl: (href: string, current: string, marketplace: string) => string | null;
  };
}

describe('extensão: manifest', () => {
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));

  it('mantém a versão visível do painel alinhada ao manifest', () => {
    const panel = readFileSync(join(ext, 'panel', 'panel.html'), 'utf8');
    expect(panel.match(/id="version">v([^<]+)</)?.[1]).toBe(manifest.version);
    expect(manifest.version).toBe('3.11.0');
  });

  it('é MV3 e não pede permissões além do necessário', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['storage', 'sidePanel', 'tabs', 'scripting', 'nativeMessaging']),
    );
    // Nunca cookies, webRequest ou acesso a histórico
    expect(manifest.permissions).not.toContain('cookies');
    expect(manifest.permissions).not.toContain('webRequest');
    expect(manifest.permissions).not.toContain('history');
  });

  it('restringe host_permissions a marketplaces e ao loopback do serviço local', () => {
    const marketplaceHosts = manifest.host_permissions.filter((pattern: string) => pattern !== 'http://127.0.0.1/*');
    expect(marketplaceHosts.length).toBeGreaterThan(0);
    for (const pattern of marketplaceHosts) {
      expect(pattern).toMatch(/mercadolivre|mercadolibre|shopee|sellercentral\.amazon/);
    }
    expect(manifest.host_permissions).toContain('http://127.0.0.1/*');
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  });

  it('todos os arquivos citados existem no pacote', () => {
    const referenced = [
      manifest.background.service_worker,
      manifest.side_panel.default_path,
      ...manifest.content_scripts.flatMap((cs: { js: string[] }) => cs.js),
      ...Object.values(manifest.icons),
    ];
    for (const rel of referenced) {
      expect(existsSync(join(ext, rel)), `arquivo ausente: ${rel}`).toBe(true);
    }
  });

  it('o pacote compilado em dist/extension tem todos os arquivos do manifest', () => {
    // O Chrome recusa o manifest se o service worker não estiver no pacote: o
    // teste olha o que o instalador embarca, não só o fonte.
    const dist = join(process.cwd(), 'dist', 'extension');
    if (!existsSync(dist)) return; // dist só existe depois do build
    const distManifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
    const referenced = [
      distManifest.background.service_worker,
      distManifest.side_panel.default_path,
      ...distManifest.content_scripts.flatMap((cs: { js: string[] }) => cs.js),
      ...Object.values(distManifest.icons),
    ];
    for (const rel of referenced) {
      expect(existsSync(join(dist, rel as string)), `ausente no pacote: ${rel}`).toBe(true);
    }
  });

  it('content scripts carregam dom-utils antes do script do marketplace', () => {
    for (const cs of manifest.content_scripts) {
      expect(cs.js[0]).toBe('content/dom-utils.js');
      expect(cs.js.length).toBeGreaterThan(1);
    }
  });

  it('CSP não permite script remoto e libera apenas 127.0.0.1', () => {
    const csp: string = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval/);
    // connect-src pode usar http://127.0.0.1:* (o serviço muda de porta a cada
    // início), mas nunca um host remoto nem curinga fora de 127.0.0.1.
    expect(csp).toMatch(/connect-src[^;]*http:\/\/127\.0\.0\.1:/);
    expect(csp).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(csp).not.toContain('unsafe-inline');
  });

  it('painel chama auth.session com o token no payload (o serviço valida payload.token)', () => {
    const panel = readFileSync(join(ext, 'panel', 'panel.js'), 'utf8');
    // Sem payload.token o serviço devolve 400 VALIDATION_ERROR e o painel
    // mostrava «serviço local indisponível» com o serviço no ar.
    expect(panel).toMatch(/call\('auth\.session',\s*\{\s*token\s*\}/);
    expect(panel).not.toMatch(/call\('auth\.session'\)/);
  });

  it('service worker é clássico: navegador não recusa o manifest por erro de módulo', () => {
    expect(manifest.background.type).toBeUndefined();
    const worker = readFileSync(join(ext, 'service-worker.js'), 'utf8');
    expect(worker).not.toMatch(/^\s*import\s/m);
    expect(worker).not.toMatch(/^\s*export\s/m);
  });

  it('expõe sincronização multi-conta, modos e agendamentos sem permitir publicação', () => {
    const panel = readFileSync(join(ext, 'panel', 'panel.html'), 'utf8');
    const js = readFileSync(join(ext, 'panel', 'panel.js'), 'utf8');
    expect(panel).toContain('id="sync-all"');
    expect(panel).toContain('id="operation-mode"');
    expect(panel).toContain('id="schedule-analysis"');
    expect(js).toContain("call('sync.createAll'");
    expect(js).toContain("call('capture.syncAllOpenTabs'");
    expect(js).toContain("call('analysis.schedule.create'");
    expect(js).toContain("call('report.schedule.create'");
    expect(js).toContain('Publicação: desativada');
  });

  it('captura frete, prazo, patrocínio e URLs de imagens apenas quando visíveis', () => {
    const schema = readFileSync(join(root, 'packages', 'shared', 'src', 'schemas', 'ipc.ts'), 'utf8');
    expect(schema).toContain('visibleImageUrls');
    for (const file of ['mercado-livre.js', 'shopee.js']) {
      const script = readFileSync(join(ext, 'content', file), 'utf8');
      expect(script).toContain('collectVisibleOfferEvidence');
      expect(script).toContain('patrocinado|publicidade|sponsored|ad');
      expect(script).toContain('shippingCents');
      expect(script).toContain('deliveryDaysMin');
    }
  });

  it('aceita chamadas IPC apenas de páginas da própria extensão', () => {
    const worker = readFileSync(join(ext, 'service-worker.js'), 'utf8');
    expect(worker).toContain('sender.id !== chrome.runtime.id');
    expect(worker).toContain('sender.url.startsWith(extensionOrigin)');
  });
});

describe('extensão: navegação entre áreas autorizadas', () => {
  function getPageInfo(file: string, currentUrl: string, links: Array<{ href: string; visible: boolean; textContent: string; getAttribute: (name: string) => string | null }>) {
    const code = readFileSync(join(ext, 'content', file), 'utf8');
    const listeners: Array<(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => void> = [];
    const window: Record<string, unknown> = {
      MI_DOM: {
        isVisible: (element: { visible: boolean }) => element.visible,
        hasChallenge: () => false,
        paginationInfo: () => null,
        parseNumberPtBr: () => null,
        findValueByLabel: () => null,
        extractExternalId: () => null,
      },
    };
    const document = {
      querySelectorAll: () => links,
      querySelector: () => null,
    };
    const chrome = { runtime: { onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) } } };
    const context = vm.createContext({ window, location: { href: currentUrl }, chrome, document, URL, String, Number, Math, Set, Array, RegExp });
    vm.runInContext(code, context);
    let response: any;
    listeners[0]({ type: 'MI_CAPTURE_PAGE_INFO' }, {}, (value) => { response = value; });
    return response;
  }

  it.each([
    ['mercado-livre.js', 'https://vendedores.mercadolivre.com.br/resumo', 'https://vendedores.mercadolivre.com.br/vendas'],
    ['shopee.js', 'https://seller.shopee.com.br/portal/datacenter/overview', 'https://seller.shopee.com.br/portal/order/list'],
    ['amazon.js', 'https://sellercentral.amazon.com.br/home', 'https://sellercentral.amazon.com.br/orders-v3'],
  ])('%s só retorna links visíveis de áreas reconhecidas no mesmo origin', (file, current, allowed) => {
    const links = [
      { href: allowed, visible: true, textContent: 'Pedidos', getAttribute: () => null },
      { href: 'https://example.com/externo', visible: true, textContent: 'Externo', getAttribute: () => null },
      { href: `${new URL(current).origin}/login`, visible: true, textContent: 'Login', getAttribute: () => null },
      { href: `${new URL(current).origin}/dashboard-hidden`, visible: false, textContent: 'Oculto', getAttribute: () => null },
    ];
    const info = getPageInfo(file, current, links);
    expect(info.authorizedAreaLinks).toHaveLength(1);
    expect(info.authorizedAreaLinks[0].url).toBe(allowed);
    expect(info.authorizedAreaLinks[0].pageKind).toBe('seller_orders');
  });

  it('o worker exige allowlist, limita a 500 páginas e interrompe em login/CAPTCHA', () => {
    const worker = readFileSync(join(ext, 'service-worker.js'), 'utf8');
    expect(worker).toContain('captureAuthorizedAreas');
    expect(worker).toContain("'capture.scanAuthorizedAreas'");
    expect(worker).toContain('Math.min(500');
    expect(worker).toContain("info.loginRequired || info.challenge");
    expect(worker).toContain("url.origin !== expectedOrigin");
    expect(worker).toContain("url.protocol !== 'https:'");
  });

  it('o painel pede confirmação antes da varredura guiada', () => {
    const panel = readFileSync(join(ext, 'panel', 'panel.js'), 'utf8');
    expect(panel).toContain("window.confirm('Iniciar leitura das áreas do vendedor");
    expect(panel).toContain("call('capture.scanAuthorizedAreas'");
  });
});

describe('extensão: leitura de números pt-BR', () => {
  const dom = loadDomUtils();

  it('lê milhar com ponto e decimal com vírgula', () => {
    expect(dom.parseNumberPtBr('1.234,56')).toBeCloseTo(1234.56, 2);
    expect(dom.parseNumberPtBr('R$ 12.345,00')).toBe(12345);
  });

  it('lê decimal simples e percentual', () => {
    expect(dom.parseNumberPtBr('12,5%')).toBeCloseTo(12.5, 2);
    expect(dom.parseNumberPtBr('3.7')).toBeCloseTo(3.7, 2);
  });

  it('trata milhar sem decimal', () => {
    expect(dom.parseNumberPtBr('1.234')).toBe(1234);
    expect(dom.parseNumberPtBr('1,234')).toBe(1234);
  });

  it('devolve null quando não há número (nunca inventa zero)', () => {
    expect(dom.parseNumberPtBr('—')).toBeNull();
    expect(dom.parseNumberPtBr('não disponível')).toBeNull();
    expect(dom.parseNumberPtBr(null)).toBeNull();
    expect(dom.parseNumberPtBr('')).toBeNull();
    expect(dom.parseNumberPtBr('12 pedidos / 20 visitas')).toBeNull();
    expect(dom.parseNumberPtBr('01/11/2026')).toBeNull();
    expect(dom.parseNumberPtBr('1,2 mil')).toBeNull();
  });

  it('extrai ID externo do anúncio', () => {
    expect(dom.extractExternalId('https://produto.mercadolivre.com.br/MLB-123456789-fone')).toBe('MLB-123456789');
    expect(dom.extractExternalId('https://www.mercadolivre.com.br/anuncios/MLB123456')).toBe('MLB123456');
    expect(dom.extractExternalId('https://exemplo.com/produto')).toBeNull();
  });

  it('normaliza rótulos com acento, caixa e dois-pontos', () => {
    expect(dom.normalizeLabel('  Visitas:  ')).toBe('visitas');
    expect(dom.normalizeLabel('Avaliação')).toBe('avaliação');
  });
});

describe('extensão: content scripts', () => {
  const files = ['mercado-livre.js', 'shopee.js', 'amazon.js'];

  for (const file of files) {
    it(`${file} não faz requisições nem toca em cookies/storage de sessão`, () => {
      const code = readFileSync(join(ext, 'content', file), 'utf8');
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/XMLHttpRequest/);
      expect(code).not.toMatch(/document\.cookie/);
      expect(code).not.toMatch(/localStorage/);
      expect(code).not.toMatch(/sessionStorage/);
      expect(code).not.toMatch(/chrome\.cookies/);
    });
  }

  it('executor de rascunho exige confirmação do formulário autenticado', () => {
    const worker = readFileSync(join(ext, 'service-worker.js'), 'utf8');
    const ml = readFileSync(join(ext, 'content', 'mercado-livre.js'), 'utf8');
    const shopee = readFileSync(join(ext, 'content', 'shopee.js'), 'utf8');
    expect(worker).toContain('context.sessionAuthenticated !== true');
    expect(ml).toContain('hasAuthenticatedSellerEditForm');
    expect(shopee).toContain('hasAuthenticatedSellerEditForm');
    expect(ml).toContain('saved: false, published: false');
    expect(shopee).toContain('saved: false, published: false');
  });

  it('service worker não executa comandos privilegiados sem sessão', () => {
    const code = readFileSync(join(ext, 'service-worker.js'), 'utf8');
    expect(code).not.toMatch(/document\.cookie/);
    expect(code).not.toMatch(/chrome\.cookies/);
    expect(code).toContain('sendNativeMessage');
    expect(code).toContain('authorization');
  });
});

describe('extensão: o pedido ao serviço leva o token da sessão', () => {
  const worker = readFileSync(join(ext, 'service-worker.js'), 'utf8');

  it('callNative inclui o token no envelope (o serviço autentica por req.token)', () => {
    // Sem o token no envelope, capture.ingest volta "sessão necessária" mesmo
    // com o painel autenticado — foi o defeito observado na captura real.
    expect(worker).toMatch(/sendNativeMessage\(\s*HOST_NAME,\s*\{\s*id,\s*method,\s*token,/);
  });

  it('callHttp inclui o token no corpo além do cabeçalho', () => {
    expect(worker).toMatch(/JSON\.stringify\(\{\s*id: nextId\(\),\s*method,\s*token: bearer,/);
  });

  it('a lista de métodos públicos espelha a do serviço', () => {
    expect(worker).toMatch(/PUBLIC_METHODS = new Set\(\['ping', 'auth\.login', 'auth\.bootstrap', 'auth\.session'\]\)/);
  });
});

describe('extensão: contexto visível de filtros e períodos', () => {
  it('registra apenas selects, datas e tabs ativas como evidência de contexto', () => {
    for (const file of ['mercado-livre.js', 'shopee.js']) {
      const code = readFileSync(join(ext, 'content', file), 'utf8');
      expect(code).toContain('visibleFilterPeriodContext');
      expect(code).toContain('input[type="date"]');
      expect(code).toContain('input[type="month"]');
      expect(code).toContain('evidence.filtersAndPeriod');
      expect(code).not.toMatch(/input\[type=\"text\"\].*value/);
    }
  });
});

describe('extensão: velocidade de digitação de rascunhos', () => {
  it('Mercado Livre e Shopee usam atraso limitado por caractere e resposta assíncrona', () => {
    for (const file of ['mercado-livre.js', 'shopee.js']) {
      const code = readFileSync(join(ext, 'content', file), 'utf8');
      expect(code).toContain('typing.charDelayMs >= 0 && typing.charDelayMs <= 250');
      expect(code).toContain('await setDraftField(');
      expect(code).toContain('await new Promise((resolve) => setTimeout(resolve, charDelayMs))');
      expect(code).toContain('settleDelayMs <= 5000');
      expect(code).toContain('saved: false, published: false');
    }
  });
});

describe('extensão: classificação de página do Mercado Livre', () => {
  const code = readFileSync(join(ext, 'content', 'mercado-livre.js'), 'utf8');

  // O adaptador roda numa IIFE: para exercitar a classificação sem tocar no DOM,
  // o teste injeta um `location` controlado e lê o pageKind que o adaptador
  // grava em `window.MI_LAST_PAGE_KIND` ao carregar.
  const detect = (url: string): string => {
    const window: Record<string, unknown> = {};
    const location = { href: url };
    const chrome = { runtime: { onMessage: { addListener: () => {} } } };
    const context = vm.createContext({ window, location, chrome, document: { querySelectorAll: () => [] }, String, Number, Math, RegExp });
    vm.runInContext(code, context);
    return String(window.MI_LAST_PAGE_KIND ?? '');
  };

  it('o painel de resumo do vendedor é reconhecido como dashboard', () => {
    // A tela que o usuário abriu: vendedores.mercadolivre.com.br/resumo
    expect(detect('https://vendedores.mercadolivre.com.br/resumo')).toBe('seller_dashboard');
    expect(detect('https://vendedores.mercadolivre.com.br/resumo#menu-user')).toBe('seller_dashboard');
  });

  it('as demais áreas do vendedor usam os tipos do contrato de captura', () => {
    const expected: Record<string, string> = {
      'https://vendedores.mercadolivre.com.br/vendas': 'seller_orders',
      'https://vendedores.mercadolivre.com.br/moderador': 'seller_listings',
      'https://vendedores.mercadolivre.com.br/publicidade': 'seller_ads',
      'https://vendedores.mercadolivre.com.br/perguntas': 'seller_questions',
      'https://vendedores.mercadolivre.com.br/reputacao': 'seller_reputation',
      'https://vendedores.mercadolivre.com.br/devolucoes': 'seller_returns',
      'https://vendedores.mercadolivre.com.br/estoque': 'seller_inventory',
    };
    for (const [url, kind] of Object.entries(expected)) expect(detect(url), url).toBe(kind);
  });

  it('reconhece tela de edição de anúncio por ID externo', () => {
    expect(detect('https://www.mercadolivre.com.br/vendas/anuncios/editar/MLB123456')).toBe('seller_listing_edit');
  });

  it('recalcula o tipo de página depois de navegação SPA', () => {
    let listener: ((message: unknown, sender: unknown, respond: (value: unknown) => void) => unknown) | undefined;
    const window = { MI_DOM: { extractExternalId: (value: string) => value.match(/MLB\d+/)?.[0] ?? null, isVisible: () => false } };
    const location = { href: 'https://vendedores.mercadolivre.com.br/anuncios' };
    const chrome = { runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } } };
    const fakeField = { disabled: false, readOnly: false, getAttribute: () => null };
    const context = vm.createContext({ window, location, chrome, document: { querySelectorAll: () => [], querySelector: (selector: string) => selector.includes('password') || selector.includes('login') || selector.includes('signin') ? null : fakeField }, String, Number, Math, RegExp, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
    vm.runInContext(code, context);
    location.href = 'https://www.mercadolivre.com.br/vendas/anuncios/editar/MLB123456';
    let response: any;
    listener?.({ type: 'MI_TASK_CONTEXT' }, {}, (value) => { response = value; });
    expect(response?.pageKind).toBe('seller_listing_edit');
    expect(response?.externalListingId).toBe('MLB123456');
    expect(response?.sessionAuthenticated).toBe(true);
  });

  it('páginas públicas e listas usam tipos aceitos pelo contrato de captura', () => {
    expect(detect('https://www.mercadolivre.com.br/fone/p/MLB123456')).toBe('product_detail');
    expect(detect('https://www.mercadolivre.com.br/items/MLB123456')).toBe('product_detail');
    expect(detect('https://vendedores.mercadolivre.com.br/anuncios')).toBe('seller_listings');
  });

  it('captura os anúncios visíveis quando a página é seller_listings', () => {
    let listener: ((message: unknown, sender: unknown, respond: (value: unknown) => void) => unknown) | undefined;
    const row = {
      getAttribute: (name: string) => name === 'data-item-id' ? 'MLB123456' : null,
      querySelectorAll: () => [],
      querySelector: (selector: string) => selector.includes('andes-money-amount')
        ? { textContent: '199' }
        : { textContent: 'Fone Bluetooth' },
    };
    const window = {
      MI_DOM: {
        isVisible: (element: any) => !element.hidden,
        hasChallenge: () => false,
        visibleCustomerVoice: () => [],
        extractExternalId: (value: unknown) => String(value).match(/MLB\d+/)?.[0] ?? null,
        parseNumberPtBr: (value: unknown) => Number(String(value).replace(',', '.')),
        findValueByLabel: () => null,
      },
    };
    const context = vm.createContext({
      window,
      location: { href: 'https://vendedores.mercadolivre.com.br/anuncios' },
      document: { querySelectorAll: (selector: string) => selector.includes('item-row') ? [row, { ...row, hidden: true, getAttribute: () => 'MLB999999' }, { ...row, getAttribute: () => null }] : [], querySelector: () => null, body: {} },
      chrome: { runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } } },
      String, Number, Math, RegExp,
    });
    vm.runInContext(code, context);
    let response: any;
    listener?.({ type: 'MI_CAPTURE_REQUEST' }, {}, (value) => { response = value; });
    expect(response?.ok).toBe(true);
    expect(response?.snapshot?.pageKind).toBe('seller_listings');
    expect(response?.snapshot?.listings).toHaveLength(1);
    expect(response?.snapshot?.listings?.[0]?.listingId).toBe('MLB123456');
    expect(response?.snapshot?.listings?.[0]?.title).toBe('Fone Bluetooth');
  });

  it('nenhum tipo devolvido fica fora do contrato de captura', () => {
    expect(code).not.toMatch(/return 'metrics'/);
    expect(detect('https://vendedores.mercadolivre.com.br/metricas')).toBe('seller_dashboard');
  });
});


describe('extensão: classificação e diagnóstico da Shopee', () => {
  const code = readFileSync(join(ext, 'content', 'shopee.js'), 'utf8');

  function capturePage(url: string) {
    let listener: ((message: unknown, sender: unknown, respond: (value: unknown) => void) => unknown) | undefined;
    const window = {
      MI_DOM: {
        hasChallenge: () => false,
        visibleCustomerVoice: () => [],
        findValueByLabel: (_body: unknown, labels: string[]) =>
          labels.some((label) => label === 'stock') ? { text: '12', label: 'Stock' } : null,
        parseNumberPtBr: (value: unknown) => Number(String(value).replace(',', '.')),
      },
    };
    const context = vm.createContext({
      window,
      location: { href: url },
      document: { body: {}, querySelector: () => null, querySelectorAll: () => [] },
      chrome: { runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } } },
      String, Number, Math, RegExp,
    });
    vm.runInContext(code, context);
    let response: any;
    listener?.({ type: 'MI_CAPTURE_REQUEST' }, {}, (value) => { response = value; });
    return response?.snapshot;
  }

  it.each([
    ['https://seller.shopee.com.br/portal/product/list', 'seller_listings'],
    ['https://seller.shopee.com.br/datacenter', 'seller_dashboard'],
    ['https://seller.shopee.com.br/order', 'seller_orders'],
    ['https://seller.shopee.com.br/portal/marketing/ads', 'seller_ads'],
    ['https://shopee.com.br/product/123/456', 'product_detail'],
  ])('mapeia %s para o enum %s', (url, expected) => {
    expect(capturePage(url).pageKind).toBe(expected);
  });

  it('missing usa as mesmas chaves dos campos capturados', () => {
    const snapshot = capturePage('https://seller.shopee.com.br/portal/product/list');
    expect(snapshot.missing).not.toContain('stockAvailable');
    expect(snapshot.missing).toContain('visits');
  });
});

describe('extensão: captura financeira com rótulos não ambíguos', () => {
  it('separa GMV, receita líquida e taxas sem classificar faturamento como pedidos', () => {
    const captureFinancialPage = (file: string, url: string, grossLabel: string) => {
      let listener: ((message: unknown, sender: unknown, respond: (value: any) => void) => unknown) | undefined;
      const pairs = [
        [grossLabel, 'R$ 1.000,00'], ['Receita líquida', 'R$ 910,00'], ['Comissão', 'R$ 65,00'],
        ['Tarifa fixa', 'R$ 5,00'], ['Frete pago pelo vendedor', 'R$ 12,00'], ['Impostos', 'R$ 8,00'],
        ['Tarifas do marketplace', 'R$ 3,00'],
      ];
      class VisibleElement { constructor(public textContent: string, public nextElementSibling: VisibleElement | null = null) {} getBoundingClientRect() { return { width: 100, height: 20 }; } }
      const nodes = pairs.map(([label, value]) => new VisibleElement(label, new VisibleElement(value)));
      const body = { querySelectorAll: () => nodes, innerText: pairs.map(([label, value]) => `${label} ${value}`).join(' ') };
      const window: Record<string, unknown> = { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) };
      const context = vm.createContext({
        window, location: { href: url }, document: { body, querySelector: () => null, querySelectorAll: () => [] },
        chrome: { runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } } },
        String, Number, Math, RegExp, URL, Element: VisibleElement,
      });
      vm.runInContext(readFileSync(join(ext, 'content', 'dom-utils.js'), 'utf8'), context);
      vm.runInContext(readFileSync(join(ext, 'content', file), 'utf8'), context);
      let response: any;
      listener?.({ type: 'MI_CAPTURE_REQUEST' }, {}, (value) => { response = value; });
      return response?.snapshot?.accountMetrics;
    };
    const ml = captureFinancialPage('mercado-livre.js', 'https://www.mercadolivre.com.br/vendas/metricas', 'Faturamento bruto');
    const shopee = captureFinancialPage('shopee.js', 'https://seller.shopee.com.br/portal/datacenter', 'Vendas brutas (BRL)');
    const amazon = captureFinancialPage('amazon.js', 'https://sellercentral.amazon.com.br/home', 'Ordered Product Sales');
    expect(amazon.gmv).toBe(1000);
    expect(amazon.netRevenue).toBe(910);
    for (const metrics of [ml, shopee]) {
      expect(metrics.gmv).toBe(1000);
      expect(metrics.netRevenue).toBe(910);
      expect(metrics.commission).toBe(65);
      expect(metrics.fixedFee).toBe(5);
      expect(metrics.shippingFee).toBe(12);
      expect(metrics.tax).toBe(8);
      expect(metrics.marketplaceFee).toBe(3);
      expect(metrics.orders).toBeUndefined();
    }
  });
});

describe('extensão: a conta é registrada antes da captura', () => {
  const worker = readFileSync(join(ext, 'service-worker.js'), 'utf8');

  it('captureTab chama ensureAccount antes de capture.ingest', () => {
    // O serviço recusa a captura de conta desconhecida ("conta ... não
    // cadastrada"). A conta sai da própria página, então é registrada no envio.
    const tab = worker.slice(worker.indexOf('async function captureTab'));
    const ensureAt = tab.indexOf('await ensureAccount(');
    const ingestAt = tab.indexOf("callService('capture.ingest'");
    expect(ensureAt).toBeGreaterThan(-1);
    expect(ingestAt).toBeGreaterThan(ensureAt);
  });

  it('ensureAccount usa account.list e account.upsert, com confiança baixa e sem verificação', () => {
    const fn = worker.slice(worker.indexOf('async function ensureAccount'), worker.indexOf('/** Pede o snapshot'));
    expect(fn).toContain("callService('account.list'");
    expect(fn).toContain("callService('account.upsert'");
    expect(fn).toMatch(/verifiedByUser: false/);
    expect(fn).toMatch(/confidence: handle \? 0\.6 : 0\.3/);
  });
});

describe('extensão: o worker executa de verdade', () => {
  it('preserva a fila restante se o serviço cai no meio do envio', async () => {
    const source = readFileSync(join(ext, 'service-worker.js'), 'utf8');
    const queueCode = source.slice(source.indexOf('let queueWork ='), source.indexOf('/**\n * Garante que a conta'));
    const items = ['primeiro', 'interrompido', 'restante'].map((id) => ({ method: 'capture.ingest', payload: { id } }));
    let stored = structuredClone(items);
    const context = vm.createContext({
      QUEUE_KEY: 'fixture', MAX_QUEUE: 500,
      chrome: { storage: { local: {
        get: async () => ({ fixture: structuredClone(stored) }),
        set: async (record: { fixture: typeof items }) => { stored = structuredClone(record.fixture); },
      } } },
      callService: async (_: string, payload: { id: string }) => {
        if (payload.id === 'interrompido') throw new Error('serviço desconectado');
        return { ok: true, result: { ok: true } };
      },
    });
    const result = await vm.runInContext(queueCode + '\nflushQueue()', context);
    expect(result).toEqual({ sent: 1, left: 2 });
    expect(stored).toEqual(items.slice(1));
  });

  it('nenhuma função usada pelo worker fica sem definição (sessionToken faltava)', () => {
    const code = readFileSync(join(ext, 'service-worker.js'), 'utf8');
    const declared = new Set<string>();
    for (const m of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
    for (const m of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
      for (const p of m[1].split(',')) {
        const n = p.trim().split(/[=:]/)[0].trim();
        if (n) declared.add(n);
      }
    }
    const used = new Set<string>();
    for (const m of code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').matchAll(/(?<![.\w$])([a-z][\w$]{3,})\s*\(/g)) used.add(m[1]);
    const builtins = new Set([
      'console', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
      'structuredClone', 'queueMicrotask',
    ]);
    // palavras que o regex pega dentro de comentários/strings em português
    const noise = new Set([
      'nativo', 'local', 'fixa', 'ocioso', 'onInstalled', 'reject', 'resolve', 'vel', 'gina',
      'barato', 'conta', 'processada', 'sendResponse', 'async', 'catch', 'while', 'void',
    ]);
    const missing = [...used].filter((n) => !declared.has(n) && !builtins.has(n) && !noise.has(n));
    expect(missing).toEqual([]);
  });
});


describe('extensão: paginação segura', () => {
  const dom = loadDomUtils();
  const current = 'https://www.mercadolivre.com.br/anuncios?status=active&offset=0';

  it('aceita próxima página HTTPS na mesma origem e rota', () => {
    expect(dom.safeNextPageUrl('/anuncios?status=active&offset=50', current, 'mercado_livre'))
      .toBe('https://www.mercadolivre.com.br/anuncios?status=active&offset=50');
  });

  it('recusa domínio semelhante, subdomínio/origem diferente, HTTP e mudança de rota', () => {
    expect(dom.safeNextPageUrl('https://www.mercadolivre.com.br.evil.test/anuncios?offset=50', current, 'mercado_livre')).toBeNull();
    expect(dom.safeNextPageUrl('https://evil.mercadolivre.com.br/anuncios?offset=50', current, 'mercado_livre')).toBeNull();
    expect(dom.safeNextPageUrl('http://www.mercadolivre.com.br/anuncios?offset=50', current, 'mercado_livre')).toBeNull();
    expect(dom.safeNextPageUrl('/pedidos?offset=50', current, 'mercado_livre')).toBeNull();
  });

  it('Shopee só aceita a mesma origem shopee.com.br', () => {
    const base = 'https://seller.shopee.com.br/portal/product/list';
    expect(dom.safeNextPageUrl('/portal/product/list?page=2', base, 'shopee')).toBe('https://seller.shopee.com.br/portal/product/list?page=2');
    expect(dom.safeNextPageUrl('https://evil.test/portal/product/list?page=2', base, 'shopee')).toBeNull();
    expect(dom.safeNextPageUrl('/myinventory/inventory?page=2', 'https://sellercentral.amazon.com.br/myinventory/inventory', 'amazon')).toBe('https://sellercentral.amazon.com.br/myinventory/inventory?page=2');
    expect(dom.safeNextPageUrl('https://sellercentral.amazon.com.br.evil.test/myinventory/inventory?page=2', 'https://sellercentral.amazon.com.br/myinventory/inventory', 'amazon')).toBeNull();
  });

  it('service worker impõe limite de cinco páginas, aba temporária e parada em CAPTCHA/login', () => {
    const worker = readFileSync(join(ext, 'service-worker.js'), 'utf8');
    expect(worker.replace(/\s+/g,'')).toContain('Math.min(5,Number.isInteger(requestedMaxPages)?requestedMaxPages:5)');
    expect(worker.replace(/\s+/g,"")).toContain("chrome.tabs.create({url:source.url,active:false");
    expect(worker).toContain('info.loginRequired || info.challenge');
    expect(worker).toContain('await chrome.tabs.remove(temporary.id)');
    expect(worker).toContain('snapshot.accountMetrics');
    expect(worker).toContain('payload.listings.length === 0 && !payload.accountMetrics');
  });
});


describe('captura direta: bloqueio de desafios', () => {
  it.each(['mercado-livre.js', 'shopee.js', 'amazon.js'])('%s rejeita captura quando aparece CAPTCHA', (file) => {
    let listener: any;
    const context = vm.createContext({
      window: { MI_DOM: { hasChallenge: () => true } },
      location: { href: 'https://example.com/' },
      document: { querySelector: () => null },
      chrome: { runtime: { onMessage: { addListener: (fn: any) => { listener = fn; } } } },
    });
    vm.runInContext(readFileSync(join(ext, 'content', file), 'utf8'), context);
    let response: any;
    listener({ type: 'MI_CAPTURE_REQUEST' }, {}, (value: unknown) => { response = value; });
    expect(response.ok).toBe(false);
    expect(response.error).toContain('CAPTCHA');
    expect(response.snapshot).toBeUndefined();
  });
});


describe('voz do cliente: campos visíveis e identidade real', () => {
  it.each([['seller_questions','QUESTION','data-question-id'],['seller_reputation','REVIEW','data-review-id'],['seller_complaints','COMPLAINT','data-claim-id'],['seller_returns','RETURN_REASON','data-return-id']])('lê %s sem confiar em test-id', (pageKind, kind, attr) => {
    class FakeElement {
      constructor(public innerText: string, public visible: boolean, public id?: string) {}
      getBoundingClientRect() { return { width: this.visible ? 20 : 0, height: 10 }; }
      closest() { return this; }
      getAttribute(name: string) { return name === attr ? this.id ?? null : name === 'data-testid' ? 'static-test-id' : null; }
    }
    const rows = [new FakeElement('Texto igual',true,'A1'),new FakeElement('Texto igual',true,'A2'),new FakeElement('Oculto',false,'A3'),new FakeElement('Outro comentário',true)];
    const window: any = { getComputedStyle: () => ({ visibility:'visible', display:'block', opacity:'1' }) };
    const context = vm.createContext({ window, Element: FakeElement });
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),context);
    const result = window.MI_DOM.visibleCustomerVoice({ querySelectorAll: () => rows }, pageKind);
    expect(result).toEqual([{kind,text:'Texto igual',externalRef:'A1'},{kind,text:'Texto igual',externalRef:'A2'},{kind,text:'Outro comentário'}]);
  });
});


describe('DOM: percentuais explícitos e paginação sem URL', () => {
  it('distingue porcentagem observada de número sem unidade e detecta botão de paginação',()=>{
    class E {
      constructor(public innerText:string,public nextElementSibling:E|null=null,public attrs:Record<string,string>={}){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(name:string){return this.attrs[name]??null}
      hasAttribute(name:string){return name in this.attrs}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E,URL});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const pairs=[new E('Taxa de conversão',new E('12,5%')),new E('Ad conversion rate',new E('3')),new E('Preço original',new E('R$ 120,00')),new E('Desconto promocional',new E('25%'))];
    expect(window.MI_DOM.observedExtraMetrics({querySelectorAll:()=>pairs},true).metrics).toEqual({conversionRatePct:12.5,originalPrice:120,promotionDiscountPct:25});
    const button=new E('Próxima',null,{'aria-label':'Próxima'});
    const root={querySelectorAll:(selector:string)=>selector.startsWith('a[')?[]:[button]};
    expect(window.MI_DOM.paginationUnsupported(root,'https://seller.shopee.com.br/order','shopee')).toBe(true);
  });
});


describe('captura de detalhes por identidade de entidade',()=>{
  it('extrai métricas de campanha e ignora linha oculta, sem identidade ou sem evidência',()=>{
    class E{
      constructor(public innerText:string,public attrs:Record<string,string>={},public nodes:E[]=[],public nextElementSibling:E|null=null,public visible=true){}
      getBoundingClientRect(){return {width:this.visible?20:0,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      querySelectorAll(){return this.nodes}
      querySelector(){return null}
      closest(){return this}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const metric=new E('Investimento em publicidade',{},[],new E('R$ 12,50'));
    const row=new E('',{'data-campaign-id':'C1'},[metric]);
    const hidden=new E('',{'data-campaign-id':'C2'},[metric],null,false);
    const root={querySelectorAll:(sel:string)=>sel==='[data-campaign-id]'?[row,hidden,new E('',{},[metric])]:[]};
    expect(window.MI_DOM.visibleDetailRows(root,'seller_ads')).toEqual([{kind:'AD_CAMPAIGN',externalId:'C1',metrics:{adSpend:12.5},evidence:{adSpend:'Investimento em publicidade: R$ 12,50'}}]);
  });
});


describe('filtros e cobertura observáveis',()=>{
  it('registra apenas filtro reconhecido e detecta linhas virtualizadas',()=>{
    class E{
      constructor(public attrs:Record<string,string>={},public nodes:E[]=[],public type='',public value='',public innerText=''){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      querySelectorAll(){return this.nodes}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const date=new E({name:'start_date'},[],'date','2026-11-01');
    const status=new E({'aria-label':'status'},[],'','','desconhecido');
    const input=new E({name:'token'},[],'text','segredo');
    const grid=new E({'aria-rowcount':'20'},[new E(),new E()]);
    const root={querySelectorAll:(sel:string)=>sel.startsWith('input')?[date,status,input]:sel.startsWith('table')?[grid]:[]};
    const result=window.MI_DOM.collectionFilterState(root);
    expect(result.signature).toBe('start_date=2026-11-01');
    expect(result.warnings).toEqual(['FILTRO_NAO_RECONHECIDO']);
    expect(window.MI_DOM.collectionCoverage(root)).toEqual(['TABELA_VIRTUALIZADA']);
  });
});


describe('tabelas e centavos visíveis',()=>{
  it('usa cabeçalho único e preserva fração monetária sem aceitar centavos ocultos',()=>{
    class E{
      constructor(public innerText:string,public parentElement:E|null=null,public hidden=false){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(){return null}
      querySelectorAll(){return []}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const h1=new E('Cliques'),h2=new E('Gasto com anúncios'),c1=new E('25'),c2=new E('R$ 99,90');
    const row:any=new E('');
    row.tagName='TR';row.cells=[c1,c2];row.closest=()=>({tHead:{rows:[{cells:[h1,h2]}]}});
    expect(window.MI_DOM.findValueByLabel(row,['Gasto com anúncios']).text).toBe('R$ 99,90');
    row.closest=()=>({tHead:{rows:[{cells:[h2,h2]}]}});
    expect(window.MI_DOM.findValueByLabel(row,['Gasto com anúncios'])).toBeNull();
    const cents=new E('90'),fraction:any=new E('1.234');
    fraction.closest=()=>({querySelector:()=>cents});
    expect(window.MI_DOM.visibleMoneyParts(fraction)).toEqual({value:1234.9,text:'1.234,90'});
    cents.hidden=true;
    expect(window.MI_DOM.visibleMoneyParts(fraction)).toBeNull();
  });
});


describe('identidade do anúncio no feedback',()=>{
  it('reconhece ID explícito e rejeita identidade ambígua',()=>{
    class E{
      constructor(public innerText:string,public attrs:Record<string,string>){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      closest(){return this}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const rows=[new E('Ótimo produto',{'data-review-id':'A','data-item-id':'MLB123456'}),new E('Boa compra',{'data-review-id':'B','data-item-id':'MLB123456','data-listing-id':'MLB999999'})];
    expect(window.MI_DOM.visibleCustomerVoice({querySelectorAll:()=>rows},'seller_reputation','mercado_livre')).toEqual([{kind:'REVIEW',text:'Ótimo produto',externalRef:'A',externalListingId:'MLB123456'},{kind:'REVIEW',text:'Boa compra',externalRef:'B'}]);
  });
});


describe('paginação SPA com controle explícito',()=>{
  it('clica somente no botão de paginação único, fora de formulários, com número esperado',()=>{
    class E{
      clicked=0;disabled=false;
      constructor(public innerText:string,public attrs:Record<string,string>={},public nodes:E[]=[],public inForm=false){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      hasAttribute(n:string){return n in this.attrs}
      closest(){return this.inForm?this:null}
      querySelectorAll(sel:string){return this.nodes.filter(x=>sel.includes('aria-current')?x.attrs['aria-current']==='page':x.attrs.type==='button')}
      click(){this.clicked++}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const marker=new E('2',{'aria-current':'page'}),next=new E('Próxima',{type:'button'});
    const nav=new E('',{'aria-label':'Paginação'},[marker,next]);
    const root={querySelectorAll:()=>[nav],querySelector:()=>null,body:{innerText:''}};
    expect(window.MI_DOM.advanceSpaPage(root,1)).toBe(false);
    expect(window.MI_DOM.advanceSpaPage(root,2)).toBe(true);
    expect(next.clicked).toBe(1);
    next.disabled=true;expect(window.MI_DOM.advanceSpaPage(root,2)).toBe(false);
    next.disabled=false;next.inForm=true;expect(window.MI_DOM.advanceSpaPage(root,2)).toBe(false);
    expect(next.clicked).toBe(1);
  });
});


describe('rolagem de tabela virtualizada',()=>{
  it('reúne todos os índices e restaura a posição, sem confundir linhas repetidas',async()=>{
    class E{
      scrollTop=0;clientHeight=100;scrollHeight=200;
      constructor(public attrs:Record<string,string>={}){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      querySelector(){return null}
      querySelectorAll(){return [] as E[]}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const grid=new E({'aria-rowcount':'3'});grid.scrollTop=25;
    const indices=()=>grid.scrollTop>=100?[2,3]:[1,2];
    grid.querySelectorAll=()=>indices().map(i=>new E({'aria-rowindex':String(i),'data-product-id':String(i)}));
    const root={querySelectorAll:()=>[grid],querySelector:()=>null,body:{innerText:''}};
    const initial={pageKind:'seller_listings',marketplace:'shopee',accountId:'a',url:'https://seller.shopee.com.br/list',filterSignature:'',coverageWarnings:['TABELA_VIRTUALIZADA'],listings:[{listingId:'1'},{listingId:'2'}]};
    const read=()=>({...initial,listings:indices().map(i=>({listingId:String(i)}))});
    const result=await window.MI_DOM.collectVirtualizedListings(root,initial,read,async()=>{});
    expect(result.listings.map((r:any)=>r.listingId)).toEqual(['1','2','3']);
    expect(result.coverageWarnings).toEqual([]);expect(grid.scrollTop).toBe(25);
    grid.attrs['aria-rowcount']='4';
    const partial=await window.MI_DOM.collectVirtualizedListings(root,initial,read,async()=>{});
    expect(partial.coverageWarnings).toContain('TABELA_VIRTUALIZADA');
    expect(grid.scrollTop).toBe(25);
  });
});


describe('reputação explícita por plataforma',()=>{
  it('preserva métricas específicas sem aceitar números sem porcentagem',()=>{
    class E{
      constructor(public innerText:string,public nextElementSibling:E|null=null){}
      getBoundingClientRect(){return {width:20,height:10}}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const rows=[new E('Order defect rate',new E('0,5%')),new E('Late shipment rate',new E('2%')),new E('Valid tracking rate',new E('99')),new E('Taxa de resposta do chat',new E('98%'))];
    const root={querySelectorAll:()=>rows};
    expect(window.MI_DOM.observedReputation(root,'amazon').metrics).toEqual({orderDefectRatePct:0.5,lateShipmentRatePct:2});
    expect(window.MI_DOM.observedReputation(root,'shopee').metrics).toEqual({lateShipmentRatePct:2,chatResponseRatePct:98});
  });
});


describe('reaplicação segura de filtros nativos',()=>{
  it('restaura seleção explícita em região de filtros sem clicar ou submeter formulários',()=>{
    class E{
      value='7';type='select-one';tagName='SELECT';events:string[]=[];inForm=false;
      options=[{value:'7',innerText:'Últimos 7 dias'},{value:'30',innerText:'Últimos 30 dias'}];
      constructor(public attrs:Record<string,string>={},public nodes:E[]=[]){}
      get selectedOptions(){return this.options.filter(o=>o.value===this.value)}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      querySelectorAll(){return this.nodes}
      closest(){return this.inForm?this:null}
      dispatchEvent(event:any){this.events.push(event.type)}
    }
    class Ev{constructor(public type:string){}}
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E,Event:Ev});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const control=new E({'aria-label':'Período'}),region=new E({'data-testid':'filters'},[control]);
    const root={querySelectorAll:(sel:string)=>sel.startsWith('input')?[control]:[region]};
    expect(window.MI_DOM.restoreVisibleFilters(root,'período=últimos 7 dias','período=últimos 30 dias')).toBe(true);
    expect(control.value).toBe('30');expect(control.events).toEqual(['input','change']);
    control.inForm=true;
    expect(window.MI_DOM.restoreVisibleFilters(root,'período=últimos 30 dias','período=últimos 7 dias')).toBe(false);
    expect(control.value).toBe('30');
  });
});


describe('dados tabulares explícitos de gráficos',()=>{
  it('extrai série, dimensão, unidade e valor somente de tabela reconhecida',()=>{
    class E{
      constructor(public innerText:string='',public attrs:Record<string,string>={}){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    const ctx=vm.createContext({window,Element:E});
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),ctx);
    const row=Object.assign(new E(),{cells:[new E('2026-11-26'),new E('R$ 100,50')]});
    const chart=Object.assign(new E('',{'data-chart-id':'sales'}),{tagName:'TABLE',caption:new E('Vendas por dia'),tHead:{rows:[{cells:[new E('Data'),new E('Receita (R$)')]}]},tBodies:[{rows:[row]}]});
    const root={querySelectorAll:(sel:string)=>sel==='[data-chart-id]'?[chart]:[]};
    expect(window.MI_DOM.visibleChartPoints(root)).toEqual({incomplete:false,points:[{chartId:'sales',chartTitle:'Vendas por dia',series:'Receita (R$)',dimension:'2026-11-26',value:100.5,unit:'BRL',raw:'R$ 100,50'}]});
    row.cells[1].innerText='valor não disponível';
    expect(window.MI_DOM.visibleChartPoints(root)).toEqual({incomplete:true,points:[]});
  });
});

describe('nota individual de avaliações',()=>{
  it('aceita nota explícita e rejeita nota ambígua, oculta ou fracionária',()=>{
    class E{
      constructor(public innerText:string,public attrs:Record<string,string>,public children:E[]=[],public hidden=false){}
      getBoundingClientRect(){return {width:this.hidden?0:20,height:this.hidden?0:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      closest(){return this}
      querySelectorAll(){return this.children}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),vm.createContext({window,Element:E}));
    const rows=[
      new E('Comentário A',{'data-review-id':'A','data-rating':'5'}),
      new E('Comentário B',{'data-review-id':'B'},[new E('',{'aria-label':'4 de 5 estrelas'})]),
      new E('Comentário C',{'data-review-id':'C','data-rating':'3'},[new E('',{'data-stars':'4'})]),
      new E('Comentário D',{'data-review-id':'D','data-rating':'4.5'}),
      new E('Comentário E',{'data-review-id':'E'},[new E('',{'data-stars':'5'},[],true)]),
      new E('Comentário F',{'data-rating':'5'})
    ];
    const result=window.MI_DOM.visibleCustomerVoice({querySelectorAll:()=>rows},'seller_reputation','amazon');
    expect(result.map((item:any)=>item.rating??null)).toEqual([5,4,null,null,null,null]);
  });
});

describe('marcas explícitas de gráficos sem tabela',()=>{
  it('coleta somente marcas visíveis com evidência completa, mantendo cobertura parcial',()=>{
    class E{
      constructor(public attrs:Record<string,string>,public nodes:E[]=[],public hidden=false){}
      getBoundingClientRect(){return {width:this.hidden?0:20,height:this.hidden?0:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      querySelectorAll(s:string){return s==='table'?[]:this.nodes}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),vm.createContext({window,Element:E}));
    const point=new E({'data-series':'Receita','data-dimension':'Dia 1','data-value':'R$ 12,50','aria-label':'Receita Dia 1 R$ 12,50'});
    const chart=new E({'data-chart-id':'sales','aria-label':'Vendas'},[point]);
    const root={querySelectorAll:(s:string)=>s==='[data-chart-id]'?[chart]:[]};
    expect(window.MI_DOM.visibleChartPoints(root)).toEqual({incomplete:true,points:[{chartId:'sales',chartTitle:'Vendas',series:'Receita',dimension:'Dia 1',value:12.5,unit:'BRL',raw:'R$ 12,50'}]});
    point.attrs['aria-label']='Receita Dia 1';
    expect(window.MI_DOM.visibleChartPoints(root)).toEqual({incomplete:true,points:[]});
    point.attrs['aria-label']='Receita Dia 1 R$ 12,50';point.hidden=true;
    expect(window.MI_DOM.visibleChartPoints(root)).toEqual({incomplete:true,points:[]});
  });
});

describe('filtro personalizado sem leitura comprovada',()=>{
  it('sinaliza combobox de período sem interpretar valores arbitrários',()=>{
    class E{
      tagName='DIV';
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return n==='aria-label'?'Período':null}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),vm.createContext({window,Element:E}));
    const root={querySelectorAll:(s:string)=>s.startsWith('[role="combobox"]')?[new E()]:[]};
    expect(window.MI_DOM.collectionFilterState(root)).toEqual({signature:'',warnings:['FILTRO_NAO_RECONHECIDO']});
  });
});

describe('observação reativa da paginação SPA',()=>{
  it('confirma o próximo marcador e desconecta o observador',async()=>{
    let callback:()=>void=()=>{},disconnected=0;
    class Observer{
      constructor(fn:()=>void){callback=fn}
      observe(){}
      disconnect(){disconnected++}
    }
    class E{
      disabled=false;
      constructor(public innerText:string,public attrs:Record<string,string>={},public nodes:E[]=[]){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      hasAttribute(n:string){return n in this.attrs}
      closest(){return null}
      querySelectorAll(s:string){return this.nodes.filter(x=>s.includes('aria-current')?x.attrs['aria-current']==='page':x.attrs.type==='button')}
      click(){}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),vm.createContext({window,Element:E,MutationObserver:Observer,setTimeout,clearTimeout}));
    const marker=new E('1',{'aria-current':'page'}),next=new E('Próxima',{type:'button'});
    const nav=new E('',{'aria-label':'Paginação'},[marker,next]);
    const root={querySelectorAll:()=>[nav],querySelector:()=>null,body:{innerText:''}};
    next.click=()=>{marker.innerText='2';callback()};
    expect(await window.MI_DOM.advanceSpaPageReactive(root,1,1000)).toBe(true);
    expect(disconnected).toBe(1);
    next.click=()=>{};
    expect(await window.MI_DOM.advanceSpaPageReactive(root,2,10)).toBe(false);
    expect(disconnected).toBe(2);
  });
});

describe('filtros personalizados acessíveis',()=>{
  it('reconhece valores inequívocos, mas não aceita seleção conflitante',()=>{
    class E{
      tagName='DIV';
      constructor(public attrs:Record<string,string>,public nodes:E[]=[],public innerText=''){}
      getBoundingClientRect(){return {width:20,height:10}}
      getAttribute(n:string){return this.attrs[n]??null}
      closest(){return null}
      querySelectorAll(){return this.nodes}
    }
    const window:any={getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    vm.runInContext(readFileSync(join(ext,'content','dom-utils.js'),'utf8'),vm.createContext({window,Element:E}));
    const selected=new E({'aria-selected':'true'},[],'Últimos 7 dias');
    const control=new E({'aria-label':'Período','aria-valuetext':'Últimos 7 dias'},[selected]);
    const root={querySelectorAll:(s:string)=>s.startsWith('[role="combobox"]')?[control]:[]};
    expect(window.MI_DOM.collectionFilterState(root)).toEqual({signature:'período=últimos 7 dias',warnings:[]});
    control.attrs['aria-valuetext']='Últimos 30 dias';
    expect(window.MI_DOM.collectionFilterState(root).warnings).toContain('FILTRO_NAO_RECONHECIDO');
  });
});
