import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { bootstrap, type Bootstrap } from '../src/main';

// Em teste o código roda de src/, não do bundle: as migrações ficam no pacote.
const MIGRATIONS = resolve(__dirname, '..', 'migrations');

let dir = '';
let app: Bootstrap;
let accountId = '';

let sessionToken = '';

async function call(method: string, payload: unknown = {}): Promise<any> {
  const res = await app.service.handle({
    id: `t-${Math.random().toString(36).slice(2)}`,
    protocolVersion: 1,
    method,
    payload,
    ...(sessionToken ? { token: sessionToken } : {}),
  });
  if (!res.ok) throw new Error(`${method}: ${res.error?.code} ${res.error?.message}`);
  return res.result;
}

const capacete = {
  accountId: '',
  marketplace: 'mercado_livre',
  title: 'Capacete Norisk FF302 Fechado Fosco Preto',
  brand: 'Norisk',
  model: 'FF302',
  category: 'Capacetes',
  attributes: { tipo: 'fechado', certificacao: 'NBR 7471' },
  variations: ['Preto', 'Cinza'],
  priceCents: 45900,
};

const candidatos = [
  {
    marketplace: 'mercado_livre',
    externalId: 'MLB111',
    url: 'https://produto.mercadolivre.com.br/MLB-111-capacete-norisk-ff302',
    title: 'Capacete Motociclista Fechado Norisk FF 302 Fosco 58',
    brand: 'Norisk',
    model: 'FF302',
    category: 'Capacetes',
    attributes: { tipo: 'fechado', certificacao: 'NBR 7471' },
    priceCents: 43900,
    seller: 'Loja A',
  },
  {
    marketplace: 'mercado_livre',
    externalId: 'MLB222',
    url: 'https://produto.mercadolivre.com.br/MLB-222-capacete-pro-tork',
    title: 'Capacete Pro Tork Vision Preto Fechado',
    brand: 'Pro Tork',
    model: 'VISION',
    category: 'Capacetes',
    attributes: { tipo: 'fechado' },
    priceCents: 39900,
    seller: 'Loja B',
  },
  {
    marketplace: 'shopee',
    externalId: 'SH333',
    url: 'https://shopee.com.br/product/1/333',
    title: 'Luvas de moto couro tamanho G',
    brand: 'X11',
    category: 'Luvas',
    priceCents: 8900,
    seller: 'Loja C',
  },
];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mi-comp-'));
  app = bootstrap({ dataDir: dir, migrationsDir: MIGRATIONS });
  await call('auth.bootstrap', { email: 'admin@teste.local', password: 'senha-segura-123', displayName: 'Admin Teste' });
  const login = await call('auth.login', { email: 'admin@teste.local', password: 'senha-segura-123' });
  sessionToken = login.token;
  accountId = 'ml:conta-teste';
  // Conta necessária para as FKs de produtos próprios
  const now = new Date().toISOString();
  app.db.db
    .prepare(
      'INSERT OR IGNORE INTO accounts (id, marketplace, display_name, detection_confidence, verified_by_user, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(accountId, 'mercado_livre', 'Conta teste', 1, 1, 1, now, now);
});

afterAll(() => {
  app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('produto próprio', () => {
  it('cadastra e lista o produto âncora', async () => {
    const { id } = await call('competitor.ownProduct.upsert', { ...capacete, accountId });
    expect(id).toBeTruthy();
    const list = await call('competitor.ownProduct.list', { accountId });
    expect(list.some((p: any) => p.id === id)).toBe(true);
  });
});

describe('busca assistida e sugestões', () => {
  let ownProductId = '';

  beforeAll(async () => {
    const r = await call('competitor.ownProduct.upsert', { ...capacete, accountId });
    ownProductId = r.id;
    await call('competitor.search', { ownProductId, marketplaces: ['mercado_livre', 'shopee'], candidates: candidatos });
  });

  it('encontra vários anúncios e cria sugestões PENDENTES', async () => {
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    expect(pend.length).toBe(3);
    expect(pend.every((r: any) => r.status === 'PENDENTE')).toBe(true);
  });

  it('não aprova nada automaticamente', async () => {
    const aprovados = await call('competitor.relations', { ownProductId, status: 'APROVADO' });
    expect(aprovados).toHaveLength(0);
  });

  it('classifica mesmo produto como DIRETO mesmo com título diferente', async () => {
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    const direto = pend.find((r: any) => r.candidate_title.includes('FF 302'));
    expect(direto.relation_kind).toBe('DIRETO');
    expect(direto.similarity_pct).toBeGreaterThanOrEqual(70);
  });

  it('traz justificativa legível com fatores', async () => {
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    const rationale = JSON.parse(pend[0].rationale_json);
    expect(typeof rationale.summary).toBe('string');
    expect(rationale.summary.length).toBeGreaterThan(10);
    expect(Array.isArray(rationale.factors)).toBe(true);
    expect(rationale.factors.length).toBeGreaterThan(2);
  });

  it('produto de outra categoria fica INDIRETO', async () => {
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    const luvas = pend.find((r: any) => r.candidate_title.includes('Luvas'));
    expect(luvas.relation_kind).toBe('INDIRETO');
  });

  it('repetir a busca não duplica nem reabre sugestões', async () => {
    const r = await call('competitor.search', { ownProductId, marketplaces: ['mercado_livre', 'shopee'], candidates: candidatos });
    expect(r.suggestionsCreated).toBe(0);
    expect(r.skipped).toBe(3);
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    expect(pend).toHaveLength(3);
  });
});

describe('revisão humana', () => {
  let ownProductId = '';

  beforeAll(async () => {
    const r = await call('competitor.ownProduct.upsert', { ...capacete, title: 'Capacete Norisk FF302 Preto 2', accountId });
    ownProductId = r.id;
    await call('competitor.search', { ownProductId, marketplaces: ['mercado_livre', 'shopee'], candidates: candidatos });
  });

  it('aprovar coloca em monitoramento contínuo', async () => {
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    const alvo = pend.find((r: any) => r.candidate_title.includes('FF 302'));
    const r = await call('competitor.approve', { relationId: alvo.id });
    expect(r.monitoring).toBe('ATIVO');
    const aprovados = await call('competitor.relations', { ownProductId, status: 'APROVADO' });
    expect(aprovados).toHaveLength(1);
    expect(aprovados[0].monitoring_state).toBe('ATIVO');
  });

  it('rejeitar registra motivo e tira do monitoramento', async () => {
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    const alvo = pend.find((r: any) => r.candidate_title.includes('Luvas'));
    await call('competitor.reject', { relationId: alvo.id, reason: 'não é concorrente do meu produto' });
    const rejeitados = await call('competitor.relations', { ownProductId, status: 'REJEITADO' });
    expect(rejeitados).toHaveLength(1);
    expect(rejeitados[0].rejection_reason).toMatch(/não é concorrente/);
  });

  it('editar corrige dados e recategoriza', async () => {
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    const alvo = pend[0];
    await call('competitor.edit', { relationId: alvo.id, title: 'Título corrigido', relationKind: 'SIMILAR' });
    const depois = await call('competitor.relations', { ownProductId });
    const atualizado = depois.find((r: any) => r.id === alvo.id);
    expect(atualizado.candidate_title).toBe('Título corrigido');
    expect(atualizado.relation_kind).toBe('SIMILAR');
  });

  it('reanalisar volta para PENDENTE com novo score', async () => {
    const aprovados = await call('competitor.relations', { ownProductId, status: 'APROVADO' });
    const r = await call('competitor.reanalyze', { relationId: aprovados[0].id });
    expect(r.ok).toBe(true);
    expect(typeof r.similarityPct).toBe('number');
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    expect(pend.some((p: any) => p.id === aprovados[0].id)).toBe(true);
  });

  it('monitoramento só aceita concorrente aprovado', async () => {
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    await expect(call('competitor.monitoring.set', { relationId: pend[0].id, state: 'ATIVO' })).rejects.toThrow(/aprovado/);
  });
});

describe('aprendizado contínuo', () => {
  let ownProductId = '';

  beforeAll(async () => {
    const r = await call('competitor.ownProduct.upsert', { ...capacete, title: 'Capacete Norisk FF302 Aprendizado', accountId });
    ownProductId = r.id;
    // Duas aprovações da marca Norisk e duas rejeições de marca infantil
    const lote = [
      { marketplace: 'mercado_livre', externalId: 'L1', title: 'Capacete Norisk FF302', brand: 'Norisk', category: 'Capacetes' },
      { marketplace: 'mercado_livre', externalId: 'L2', title: 'Capacete Norisk FF345', brand: 'Norisk', category: 'Capacetes' },
      { marketplace: 'mercado_livre', externalId: 'L3', title: 'Capacete infantil patinete', brand: 'Baby', category: 'Capacetes' },
      { marketplace: 'mercado_livre', externalId: 'L4', title: 'Capacete infantil bike', brand: 'Baby', category: 'Capacetes' },
    ];
    await call('competitor.search', { ownProductId, marketplaces: ['mercado_livre'], candidates: lote });
    const pend = await call('competitor.relations', { ownProductId, status: 'PENDENTE' });
    for (const rel of pend) {
      if (rel.brand === 'Norisk') await call('competitor.approve', { relationId: rel.id });
      else await call('competitor.reject', { relationId: rel.id, reason: 'infantil não é concorrente' });
    }
  });

  it('grava feedback de cada decisão', async () => {
    const stats = await call('competitor.stats', { ownProductId });
    expect(stats.feedbackEvents).toBeGreaterThanOrEqual(4);
  });

  it('deriva regras de preferência e aversão a partir das decisões', async () => {
    const stats = await call('competitor.stats', { accountId });
    const regras = stats.learningRules as Array<{ scope: string; value: string; direction: string }>;
    expect(regras.some((r) => r.scope === 'BRAND' && r.value === 'norisk' && r.direction === 'PREFERIR')).toBe(true);
    expect(regras.some((r) => r.scope === 'BRAND' && r.value === 'baby' && r.direction === 'EVITAR')).toBe(true);
  });

  it('a regra aprendida muda a próxima busca', async () => {
    const novo = await call('competitor.ownProduct.upsert', { ...capacete, title: 'Capacete Norisk FF302 Nova Busca', accountId });
    const r = await call('competitor.search', {
      ownProductId: novo.id,
      marketplaces: ['mercado_livre'],
      candidates: [
        { marketplace: 'mercado_livre', externalId: 'N1', title: 'Capacete Norisk FF302', brand: 'Norisk', category: 'Capacetes' },
        { marketplace: 'mercado_livre', externalId: 'N2', title: 'Capacete infantil patinete', brand: 'Baby', category: 'Capacetes' },
      ],
    });
    expect(r.suggestionsCreated).toBe(2);
    const rels = await call('competitor.relations', { ownProductId: novo.id });
    const norisk = rels.find((x: any) => x.brand === 'Norisk');
    const baby = rels.find((x: any) => x.brand === 'Baby');
    const ratNorisk = JSON.parse(norisk.rationale_json);
    const ratBaby = JSON.parse(baby.rationale_json);
    expect(ratNorisk.summary).toMatch(/aprendizado/);
    expect(ratBaby.summary).toMatch(/aprendizado/);
    expect(norisk.similarity_pct).toBeGreaterThan(baby.similarity_pct);
  });

  it('precisão é calculada sobre decisões reais, não inventada', async () => {
    const stats = await call('competitor.stats', { ownProductId });
    expect(stats.reviewed).toBe(4);
    expect(stats.precisionPct).toBe(50);
    expect(stats.precisionNote).toMatch(/decisões humanas/);
  });
});

describe('monitoramento', () => {
  let relationId = '';

  beforeAll(async () => {
    const r = await call('competitor.ownProduct.upsert', { ...capacete, title: 'Capacete Norisk FF302 Monitoramento', accountId });
    await call('competitor.search', { ownProductId: r.id, marketplaces: ['mercado_livre'], candidates: [candidatos[0]] });
    const pend = await call('competitor.relations', { ownProductId: r.id, status: 'PENDENTE' });
    relationId = pend[0].id;
    await call('competitor.approve', { relationId });
  });

  it('registra histórico e devolve comparação com o produto próprio', async () => {
    const agora = new Date(Date.now()-2*3600_000);
    await call('competitor.monitoring.record', { relationId, capturedAt: agora.toISOString(), priceCents: 43900, position: 3, rating: 4.7, reviews: 128 });
    await call('competitor.monitoring.record', {
      relationId,
      capturedAt: new Date(agora.getTime() + 3600_000).toISOString(),
      priceCents: 41900,
      position: 2,
      rating: 4.7,
      reviews: 131,
    });
    const h = await call('competitor.monitoring.history', { relationId });
    expect(h.points).toHaveLength(2);
    expect(h.competitorPriceCents).toBe(41900);
    expect(h.minPriceCents).toBe(41900);
    expect(h.ownPriceCents).toBe(45900);
    await expect(call('competitor.monitoring.record',{relationId,capturedAt:new Date(Date.now()+3600_000).toISOString(),priceCents:1})).rejects.toThrow(/futuro/);
  });

  it('pausar mantém o histórico', async () => {
    await call('competitor.monitoring.set', { relationId, state: 'PAUSADO' });
    const h = await call('competitor.monitoring.history', { relationId });
    expect(h.monitoringState).toBe('PAUSADO');
    await expect(call('competitor.monitoring.record',{relationId,priceCents:1})).rejects.toThrow(/ativo/);
    expect(h.points).toHaveLength(2);
  });
});

describe('indicadores do painel', () => {
  it('expõe pendentes, aprovados, rejeitados e precisão', async () => {
    const stats = await call('competitor.stats', { accountId });
    expect(stats.pending).toBeGreaterThanOrEqual(0);
    expect(stats.approved).toBeGreaterThan(0);
    expect(stats.rejected).toBeGreaterThan(0);
    expect(stats.monitoringActive).toBeGreaterThan(0);
    expect(stats.precisionPct === null || typeof stats.precisionPct === 'number').toBe(true);
  });
});
