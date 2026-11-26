import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/db/database';
import { TaskScheduler } from '../src/scheduler/task-scheduler';
import { SecretStore, hashPassword } from '../src/security/secrets';
import { GeminiClient } from '../src/ai/gemini-client';
import { KnowledgeBase } from '../src/ai/knowledge-base';
import { AutoUpgradeEngine } from '../src/ai/auto-upgrade';
import { CaptureService } from '../src/capture/capture-service';
import { LocalService, redactPII } from '../src/service';
import { evaluateGuard, GUARD_CHECKS } from '../src/guard/automation-guard';
import { mercadoLivreAdapter, shopeeAdapter, adapterForUrl, unsupportedCapabilities } from '../src/adapters';

let dir: string;
let db: LocalDatabase;
let service: LocalService;
let token = '';

function build(): LocalService {
  const secrets = new SecretStore(db, join(dir, 'secrets'));
  const gemini = new GeminiClient(db, secrets, async () => ({
    ok: true,
    status: 200,
    json: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
  }));
  return new LocalService({
    db,
    secrets,
    tasks: new TaskScheduler(db),
    gemini,
    knowledge: new KnowledgeBase(db),
    autoUpgrade: new AutoUpgradeEngine(db, gemini, dir),
    capture: new CaptureService(db),
    version: '1.0.0-test',
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mi-test-'));
  db = new LocalDatabase({ file: join(dir, 'test.db') });
  db.migrate();
  service = build();
  const boot = await service.handle({ id: '1', protocolVersion: 1, method: 'auth.bootstrap', payload: { email: 'admin@local.test', password: 'senha-forte-123', displayName: 'Admin' } });
  expect(boot.ok).toBe(true);
  const login = await service.handle({ id: '2', protocolVersion: 1, method: 'auth.login', payload: { email: 'admin@local.test', password: 'senha-forte-123' } });
  expect(login.ok).toBe(true);
  token = (login.result as { token: string }).token;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* já fechado */
  }
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, payload?: unknown, useToken = true) =>
  service.handle({ id: 'r', protocolVersion: 1, method, payload, token: useToken ? token : undefined });

describe('banco local', () => {
  it('aplica migrações e registra versão', () => {
    const rows = db.rows<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.length).toBeGreaterThan(0);
    expect(db.integrityCheck().ok).toBe(true);
  });

  it('não aplica migração duas vezes', () => {
    const before = db.rows<{ version: number }>('SELECT version FROM schema_migrations').length;
    db.migrate();
    expect(db.rows<{ version: number }>('SELECT version FROM schema_migrations').length).toBe(before);
  });

  it('gera backup verificável', () => {
    const b = db.backup('teste');
    expect(b.bytes).toBeGreaterThan(0);
    expect(b.checksum).toHaveLength(64);
    const rows = db.rows<{ path: string }>('SELECT path FROM backups');
    expect(rows.length).toBe(1);
  });
});

describe('autenticação e perfis', () => {
  it('rejeita bootstrap duplicado', async () => {
    const r = await service.handle({ id: 'x', protocolVersion: 1, method: 'auth.bootstrap', payload: { email: 'outro@local.test', password: 'senha-forte-123', displayName: 'Outro' } });
    expect(r.ok).toBe(true);
    expect((r.result as { ok: boolean }).ok).toBe(false);
  });

  it('rejeita senha errada', async () => {
    const r = await call('auth.login', { email: 'admin@local.test', password: 'errada' }, false);
    expect((r.result as { ok: boolean }).ok).toBe(false);
  });

  it('bloqueia método protegido sem token', async () => {
    const r = await call('task.list', {}, false);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAUTHORIZED');
  });

  it('bloqueia método inexistente', async () => {
    const r = await call('metodo.fantasma', {});
    expect(r.ok).toBe(false);
    expect(['NOT_FOUND', 'VALIDATION_ERROR']).toContain(r.error?.code);
  });

  it('visualizador não pode executar tarefa nem chamar métodos de escrita sem permissão', async () => {
    const { hash, salt } = hashPassword('senha-visualizador-123');
    db.db
      .prepare('INSERT INTO users (id, email, display_name, role, password_hash, password_salt, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run('u2', 'view@local.test', 'View', 'visualizador', hash, salt, new Date().toISOString());
    const login = await service.handle({ id: 'l', protocolVersion: 1, method: 'auth.login', payload: { email: 'view@local.test', password: 'senha-visualizador-123' } });
    expect(login.ok).toBe(true);
    const viewerToken = (login.result as { token: string }).token;
    const viewerCall = (method: string, payload: unknown = {}) =>
      service.handle({ id: 'viewer', protocolVersion: 1, method, payload, token: viewerToken });

    const task = await viewerCall('task.runNow', { taskId: 'missing' });
    expect(task.ok).toBe(false);
    expect(task.error?.code).toBe('FORBIDDEN');

    const cost = await viewerCall('finance.costs.upsert', { skuId: 'SKU1', unitCostCents: 1000 });
    expect(cost.ok).toBe(false);
    expect(cost.error?.code).toBe('FORBIDDEN');

    const competitor = await viewerCall('competitor.approve', { relationId: 'missing' });
    expect(competitor.ok).toBe(false);
    expect(competitor.error?.code).toBe('FORBIDDEN');

    const read = await viewerCall('competitor.list', { accountId: 'acc-test' });
    expect(read.ok).toBe(true);
  });

  it('não permite que uma sessão encerre a sessão de outro usuário', async () => {
    const { hash, salt } = hashPassword('senha-visualizador-456');
    db.db
      .prepare('INSERT INTO users (id, email, display_name, role, password_hash, password_salt, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run('u3', 'other@local.test', 'Other', 'visualizador', hash, salt, new Date().toISOString());
    const login = await service.handle({ id: 'other-login', protocolVersion: 1, method: 'auth.login', payload: { email: 'other@local.test', password: 'senha-visualizador-456' } });
    const otherToken = (login.result as { token: string }).token;
    const attempt = await call('auth.logout', { token: otherToken });
    expect(attempt.ok).toBe(true);
    expect((attempt.result as { ok: boolean }).ok).toBe(false);
    const stillValid = await service.handle({ id: 'other-session', protocolVersion: 1, method: 'auth.session', payload: { token: otherToken } });
    expect((stillValid.result as { ok: boolean }).ok).toBe(true);
  });

  it('registra auditoria de login', async () => {
    const rows = db.rows<{ action: string; result: string }>('SELECT action, result FROM audit_log');
    expect(rows.some((r) => r.action === 'LOGIN' && r.result === 'OK')).toBe(true);
    expect(rows.some((r) => r.action === 'BOOTSTRAP')).toBe(true);
  });
});

describe('captura e KPIs', () => {
  const payload = {
    marketplace: 'mercado_livre',
    accountId: 'ml:conta1',
    pageKind: 'seller_dashboard',
    url: 'https://www.mercadolivre.com.br/vendas',
    collectedAt: new Date().toISOString(),
    referenceAt: new Date().toISOString(),
    sourceClass: 'A_PRIMARY_UI',
    method: 'dom_read',
    listings: [
      {
        listingId: 'MLB123',
        title: 'Fone Bluetooth',
        visits: 1000,
        orders: 30,
        units: 32,
        gmv: 3200,
        organicImpressions: 8000,
        paidImpressions: 2000,
        adSpend: 200,
        adClicks: 400,
        adAttributedRevenue: 900,
        returnsCount: 1,
        returnsValue: 100,
        stockAvailable: 40,
        reviewRating: 4.5,
        reviewCount: 20,
      },
    ],
  };

  it('rejeita captura de conta inexistente', async () => {
    const r = await call('capture.ingest', payload);
    const res = r.result as { ok: boolean; errors: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('não cadastrada');
  });

  it('grava snapshot com proveniência quando a conta existe', async () => {
    await call('account.upsert', {
      marketplace: 'mercado_livre',
      accountId: 'ml:conta1',
      displayName: 'Loja Teste',
      confidence: 0.9,
      verifiedByUser: true,
    });
    const r = await call('capture.ingest', payload);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const res = r.result as { ok: boolean; listingsIngested: number };
    expect(res.ok).toBe(true);
    expect(res.listingsIngested).toBe(1);

    const prov = db.rows<{ field: string; source_class: string }>('SELECT field, source_class FROM data_provenance');
    expect(prov.length).toBeGreaterThan(5);
    expect(prov.every((p) => p.source_class === 'A_PRIMARY_UI')).toBe(true);

    const kpi = (await call('kpi.listing', { listingId: db.rows<{ id: string }>('SELECT id FROM listings')[0]!.id })).result as {
      pillars: { conversion_cro: { cvr: number } };
    };
    expect((kpi.pillars.conversion_cro.cvr as unknown as { value: number }).value).toBeCloseTo(3, 5);

    const dashboard = (await call('kpi.dashboard')).result as {
      totals: { gmvCents: number; netRevenueCents: number | null; adSpendCents: number; orders: number };
    };
    expect(dashboard.totals.gmvCents).toBe(320000);
    expect(dashboard.totals.netRevenueCents).toBeNull();
    expect(dashboard.totals.adSpendCents).toBe(20000);
    expect(dashboard.totals.orders).toBe(30);
  });

  it('não apresenta subtotal como total da conta quando há anúncio sem captura', async () => {
    await call('account.upsert', {
      marketplace: 'mercado_livre',
      accountId: 'ml:conta1',
      displayName: 'Loja Teste',
      confidence: 0.9,
      verifiedByUser: true,
    });
    await call('capture.ingest', payload);
    const now = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO listings (id, account_id, marketplace, external_id, title, status, url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    ).run('listing-without-snapshot', 'ml:conta1', 'mercado_livre', 'MLB999', 'Sem snapshot', payload.url, now, now);

    const dashboard = (await call('kpi.dashboard')).result as {
      coverage: { totalListings: number; capturedListings: number; uncapturedListings: number };
      totals: { gmvCents: number | null; orders: number | null };
    };
    expect(dashboard.coverage).toEqual({ totalListings: 2, capturedListings: 1, uncapturedListings: 1 });
    expect(dashboard.totals.gmvCents).toBeNull();
    expect(dashboard.totals.orders).toBeNull();
  });

  it('não sobrescreve histórico ao capturar de novo', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:conta1', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    await call('capture.ingest', payload);
    await call('capture.ingest', { ...payload, collectedAt: new Date(Date.now() + 1000).toISOString() });
    const snaps = db.rows<{ c: number }>('SELECT COUNT(*) AS c FROM listing_snapshots');
    expect(snaps[0]!.c).toBe(2);
  });

  it('recusa captura inválida com relatório de qualidade', async () => {
    const r = await call('capture.ingest', { marketplace: 'x' });
    const res = r.result as { ok: boolean; errors: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});

describe('tarefas e guard', () => {
  it('cria tarefa com itens e transita estados', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:c', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const created = (
      await call('task.create', {
        name: 'Duplicar anúncios',
        kind: 'duplicate',
        mode: 'DRAFT',
        typing: { mode: 'set_value', charDelayMs: 0, settleDelayMs: 0, verifyAfterTyping: true },
        items: [{ listingId: 'MLB1', marketplace: 'mercado_livre', accountId: 'ml:c', copies: 2 }],
      })
    ).result as { taskId: string };
    expect(created.taskId).toBeTruthy();

    const list = (await call('task.list')).result as { counts: Record<string, number> };
    expect(list.counts.PENDING).toBe(1);

    await call('task.pause', { taskId: created.taskId });
    expect(((await call('task.list')).result as { counts: Record<string, number> }).counts.PAUSED).toBe(1);
  });

  const guardBase = {
    action: 'edit_description' as const,
    marketplace: { id: 'mercado_livre', enabled: true },
    account: { id: 'ml:conta1', marketplace: 'mercado_livre', sessionState: 'AUTHENTICATED', verified: true },
    listing: { id: 'L1', accountId: 'ml:conta1', externalId: 'MLB1', status: 'ACTIVE' },
    currentState: { title: 'Fone', description: 'Texto original longo do vendedor' },
    financialLimits: null,
    requiredData: { missing: [] as string[] },
    platformRules: { violations: [] as string[] },
    authorization: { approved: true, approvedBy: 'admin' },
    conflicts: [] as string[],
  };

  it('guard bloqueia quando a sessão está em CAPTCHA', () => {
    const d = evaluateGuard({
      ...guardBase,
      actorRole: 'super_admin',
      account: { ...guardBase.account, sessionState: 'CHALLENGE_REQUIRED' },
    });
    expect(d.allowed).toBe(false);
    expect(d.blockedReasons.join(' ')).toMatch(/sess/i);
  });

  it('guard registra as 10 verificações com detalhe legível por perfil', () => {
    const visualizador = evaluateGuard({ ...guardBase, actorRole: 'visualizador' });
    const admin = evaluateGuard({ ...guardBase, actorRole: 'super_admin' });
    expect(visualizador.allowed).toBe(false);
    expect(visualizador.blockedReasons.length).toBeGreaterThan(0);
    expect(admin.checks.length).toBe(GUARD_CHECKS.length);
    expect(admin.checks.every((c) => c.detail.length > 0)).toBe(true);
    expect(admin.checks.find((c) => c.check === 'user_permission')?.detail).toContain('super_admin');
  });

  it('guard bloqueia quando faltam dados obrigatórios', () => {
    const d = evaluateGuard({ ...guardBase, actorRole: 'super_admin', requiredData: { missing: ['price'] } });
    expect(d.allowed).toBe(false);
    expect(d.blockedReasons.join(' ')).toMatch(/dado/i);
  });

  it('guard bloqueia violação de regra da plataforma', () => {
    const d = evaluateGuard({ ...guardBase, actorRole: 'super_admin', platformRules: { violations: ['promessa de cura'] } });
    expect(d.allowed).toBe(false);
  });

  it('expõe as 10 verificações do guard', () => {
    expect(GUARD_CHECKS.length).toBe(10);
  });
});

describe('segredos e Gemini', () => {
  it('cifra e decifra segredo com roundtrip', () => {
    const store = new SecretStore(db, join(dir, 'sec2'));
    store.set('gemini.apiKey', 'chave-secreta-de-teste-123456');
    expect(store.get('gemini.apiKey')).toBe('chave-secreta-de-teste-123456');
    expect(store.get('inexistente')).toBeNull();
  });

  it('não devolve a chave do Gemini para a UI', async () => {
    const r = await call('gemini.setKey', { apiKey: 'AIzaSyTesteChaveComTamanhoSuficiente123' });
    expect((r.result as { ok: boolean }).ok).toBe(true);
    const hint = (r.result as { hint: string }).hint;
    expect(hint).not.toContain('AIzaSyTesteChaveComTamanhoSuficiente123');
    const budget = (await call('agent.budget')).result as { geminiConfigured: boolean };
    expect(budget.geminiConfigured).toBe(true);
  });

  it('bloqueia gravação de segredo via settings', async () => {
    const r = await call('settings.set', { key: 'gemini_apiKey', value: 'x' });
    expect(r.ok).toBe(false);
  });

  it('client sem chave retorna NO_KEY sem chamar rede', async () => {
    const c = new GeminiClient(db, new SecretStore(db, join(dir, 'sec3')), async () => ({ ok: false, status: 200, json: {} }));
    const res = await c.call({ agentKey: 'x', model: 'gemini-2.5-flash', systemPrompt: 's', userContent: 'u' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('NO_KEY');
  });

  it('client respeita orçamento diário', async () => {
    const c = new GeminiClient(db, new SecretStore(db, join(dir, 'sec4')), async () => ({
      ok: true,
      status: 200,
      json: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    }));
    c.setKey('AIzaSyTesteChaveComTamanhoSuficiente123');
    const res = await c.call({
      agentKey: 'x',
      model: 'gemini-2.5-flash',
      systemPrompt: 's',
      userContent: 'u',
      budget: { dailyCostLimitUsd: 0 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(['BUDGET_EXCEEDED', 'HTTP_ERROR']).toContain(res.errorCode);
  });
});

describe('adapters', () => {
  it('resolve adapter por URL e ignora domínio desconhecido', () => {
    expect(adapterForUrl('https://www.mercadolivre.com.br/vendas')?.id).toBe('mercado_livre');
    expect(adapterForUrl('https://seller.shopee.com.br/portal/product/list')?.id).toBe('shopee');
    expect(adapterForUrl('https://exemplo.com')).toBeNull();
  });

  it('detecta página de edição e de desafio', () => {
    expect(mercadoLivreAdapter.detectPage('https://www.mercadolivre.com.br/vendas/anuncios/editar/MLB1', [])?.kind).toBe('seller_listing_edit');
    expect(mercadoLivreAdapter.detectPage('https://www.mercadolivre.com.br/captcha', [])?.kind).toBe('challenge');
  });

  it('detecta sessão autenticada com conta', () => {
    const s = mercadoLivreAdapter.detectSession('https://www.mercadolivre.com.br/vendas', ['seller-nav', 'nickname:LOJATESTE']);
    expect(s.state).toBe('AUTHENTICATED');
    expect(s.account?.handle).toBe('LOJATESTE');
  });

  it('marca sessão como desafio quando há captcha', () => {
    expect(shopeeAdapter.detectSession('https://seller.shopee.com.br/', ['captcha']).state).toBe('CHALLENGE_REQUIRED');
  });

  it('diagnostica mudança de layout', () => {
    const d = mercadoLivreAdapter.diagnose({ listing_title_input: 1, listing_price_input: 0, listing_stock_input: 0 });
    expect(d.layoutChangedSuspected).toBe(true);
  });

  it('lista capacidades não suportadas honestamente', () => {
    expect(unsupportedCapabilities(mercadoLivreAdapter).length).toBe(0);
    expect(unsupportedCapabilities(shopeeAdapter).length).toBe(0);
  });
});

describe('voz do cliente e privacidade', () => {
  it('redige dados pessoais', () => {
    const out = redactPII('meu email joao@teste.com e telefone (11) 98888-7777 e cpf 123.456.789-09');
    expect(out).not.toContain('joao@teste.com');
    expect(out).not.toContain('98888');
    expect(out).not.toContain('123.456');
  });

  it('grava avaliação já redigida', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:c', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const r = await call('voc.ingest', { accountId: 'ml:c', kind: 'REVIEW', text: 'Chegou antes do prazo, contato joao@teste.com', rating: 5 });
    expect((r.result as { ok: boolean }).ok).toBe(true);
    const row = db.rows<{ text_redacted: string }>('SELECT text_redacted FROM customer_voice_items');
    expect(row[0]!.text_redacted).not.toContain('joao@teste.com');
  });
});

describe('financeiro e missões', () => {
  it('simula cenário e devolve margem', async () => {
    const r = await call('finance.simulate', {
      priceCents: 10000,
      quantity: 10,
      commissionPct: 14,
      fixedFeeCents: 600,
      unitCostCents: 4000,
      taxPct: 8,
      minMarginPct: 20,
    });
    const res = r.result as { netRevenueCents: number; contributionMarginPct: number };
    expect(res.netRevenueCents).toBeGreaterThan(0);
    expect(res.contributionMarginPct).toBeGreaterThan(0);
  });

  it('versiona custos em vez de sobrescrever', async () => {
    db.db
      .prepare("INSERT INTO skus (id, sku_code, created_at) VALUES ('SKU1', 'SKU1', ?)")
      .run(new Date().toISOString());
    const ra = await call('finance.costs.upsert', { skuId: 'SKU1', unitCostCents: 1000 });
    if (!ra.ok) throw new Error(JSON.stringify(ra.error));
    const a = ra.result as { version: number };
    const rb = await call('finance.costs.upsert', { skuId: 'SKU1', unitCostCents: 1100 });
    if (!rb.ok) throw new Error(JSON.stringify(rb.error));
    const b = rb.result as { version: number };
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(db.rows<{ c: number }>('SELECT COUNT(*) AS c FROM sku_costs')[0]!.c).toBe(2);
  });
});

describe('agentes', () => {
  it('devolve síntese com recomendações, conflitos e notas', async () => {
    const r = await call('agent.run', {
      agents: ['seo_demand', 'finance'],
      context: {
        accountId: 'ml:conta1',
        marketplace: 'mercado_livre',
        listingId: 'MLB1',
        window: { start: new Date(Date.now() - 30 * 86400000).toISOString(), end: new Date().toISOString(), days: 30 },
        metrics: { keywordCoveragePct: 42, attributeCompletenessPct: 55, contributionMarginPct: -5 },
        missingData: ['posição média', 'ads'],
      },
    });
    expect(r.ok).toBe(true);
    const res = r.result as { recommendations: unknown[]; conflicts: Array<{ resolution: string }>; notes: string[] };
    expect(Array.isArray(res.recommendations)).toBe(true);
    expect(Array.isArray(res.conflicts)).toBe(true);
    expect(Array.isArray(res.notes)).toBe(true);
    // prevalência financeira: margem negativa impede recomendações de tráfego (§29.4)
    expect(res.notes.join(' ')).toMatch(/margem negativa/i);
    expect(res.conflicts.length).toBeGreaterThan(0);
  });
});

describe('backup', () => {
  it('cria backup pela API e audita', async () => {
    const r = await call('backup.create', { note: 'antes da migração' });
    expect((r.result as { ok: boolean }).ok).toBe(true);
    const audit = db.rows<{ action: string }>("SELECT action FROM audit_log WHERE action = 'BACKUP_CREATE'");
    expect(audit.length).toBe(1);
  });
});
