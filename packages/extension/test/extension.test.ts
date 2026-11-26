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
  const context = vm.createContext({ window, Element: class {}, Number, String, Math });
  vm.runInContext(code, context);
  return window.MI_DOM as {
    parseNumberPtBr: (t: unknown) => number | null;
    extractExternalId: (u: string) => string | null;
    normalizeLabel: (t: string) => string;
  };
}

describe('extensão: manifest', () => {
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));

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

  it('restringe host_permissions a domínios de marketplace', () => {
    for (const pattern of manifest.host_permissions) {
      expect(pattern).toMatch(/mercadolivre|mercadolibre|shopee|sellercentral\.amazon/);
      expect(pattern).not.toBe('<all_urls>');
    }
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
  const files = ['mercado-livre.js', 'shopee.js'];

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

  it('páginas públicas e listas usam tipos aceitos pelo contrato de captura', () => {
    expect(detect('https://www.mercadolivre.com.br/fone/p/MLB123456')).toBe('product_detail');
    expect(detect('https://www.mercadolivre.com.br/items/MLB123456')).toBe('product_detail');
    expect(detect('https://vendedores.mercadolivre.com.br/anuncios')).toBe('seller_listings');
  });

  it('captura os anúncios visíveis quando a página é seller_listings', () => {
    let listener: ((message: unknown, sender: unknown, respond: (value: unknown) => void) => unknown) | undefined;
    const row = {
      innerHTML: 'MLB123456',
      getAttribute: () => null,
      querySelector: (selector: string) => selector.includes('andes-money-amount')
        ? { textContent: '199' }
        : { textContent: 'Fone Bluetooth' },
    };
    const window = {
      MI_DOM: {
        extractExternalId: (value: unknown) => String(value).match(/MLB\d+/)?.[0] ?? null,
        parseNumberPtBr: (value: unknown) => Number(String(value).replace(',', '.')),
        findValueByLabel: () => null,
      },
    };
    const context = vm.createContext({
      window,
      location: { href: 'https://vendedores.mercadolivre.com.br/anuncios' },
      document: { querySelectorAll: () => [row], querySelector: () => null, body: {} },
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
        findValueByLabel: (_body: unknown, labels: string[]) =>
          labels.some((label) => label === 'stock') ? { text: '12', label: 'Stock' } : null,
        parseNumberPtBr: (value: unknown) => Number(String(value).replace(',', '.')),
      },
    };
    const context = vm.createContext({
      window,
      location: { href: url },
      document: { body: {}, querySelector: () => null },
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
    for (const m of code.matchAll(/(?<![.\w$])([a-z][\w$]{3,})\s*\(/g)) used.add(m[1]);
    const builtins = new Set([
      'console', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
      'structuredClone', 'queueMicrotask',
    ]);
    // palavras que o regex pega dentro de comentários/strings em português
    const noise = new Set([
      'nativo', 'local', 'fixa', 'ocioso', 'onInstalled', 'reject', 'resolve', 'vel', 'gina',
      'barato', 'sendResponse', 'async', 'catch', 'while', 'void',
    ]);
    const missing = [...used].filter((n) => !declared.has(n) && !builtins.has(n) && !noise.has(n));
    expect(missing).toEqual([]);
  });
});
