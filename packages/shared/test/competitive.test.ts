import { describe, expect, it } from 'vitest';
import {
  applyLearning,
  deriveLearningRules,
  detectModel,
  normalize,
  scoreSimilarity,
  titleTerms,
  withLearning,
  type FeedbackSample,
  type ProductFeatures,
} from '../src/competitive/similarity';

const capacete: ProductFeatures = {
  title: 'Capacete Norisk FF302 Fechado Fosco Preto',
  brand: 'Norisk',
  model: 'FF302',
  category: 'Capacetes',
  attributes: { tipo: 'fechado', tamanho: '58', certificacao: 'NBR 7471' },
  variations: ['Preto', 'Cinza'],
  priceCents: 45900,
  seller: 'Loja Própria',
};

describe('normalização e termos', () => {
  it('remove acentos, pontuação e caixa', () => {
    expect(normalize('Capacete Nórisk FF-302, Preto!')).toBe('capacete norisk ff 302 preto');
  });

  it('descarta stopwords do título', () => {
    const terms = titleTerms('Capacete Norisk FF302 de Fechado para Motociclista');
    expect(terms).toContain('capacete');
    expect(terms).toContain('ff302');
    expect(terms).not.toContain('de');
    expect(terms).not.toContain('para');
  });

  it('detecta modelo no título', () => {
    expect(detectModel('Capacete Norisk FF302')).toBe('ff302');
    expect(detectModel('Capacete sem modelo')).toBeNull();
  });
});

describe('scoreSimilarity', () => {
  it('mesmo produto com título diferente continua DIRETO', () => {
    const result = scoreSimilarity(capacete, {
      title: 'Capacete Motociclista Fechado Norisk FF 302 Fosco Tam 58',
      brand: 'Norisk',
      model: 'FF302',
      category: 'Capacetes',
      attributes: { tipo: 'fechado', tamanho: '58', certificacao: 'NBR 7471' },
      variations: ['Preto'],
      priceCents: 43900,
      seller: 'Outro Vendedor',
    });
    expect(result.similarityPct).toBeGreaterThanOrEqual(70);
    expect(result.kind).toBe('DIRETO');
    expect(result.summary).toMatch(/%/);
    expect(result.factors.length).toBeGreaterThan(3);
  });

  it('produto equivalente de outra marca fica SIMILAR, não DIRETO', () => {
    const result = scoreSimilarity(capacete, {
      title: 'Capacete Fechado Pro Tork Vision Preto',
      brand: 'Pro Tork',
      model: 'VISION',
      category: 'Capacetes',
      attributes: { tipo: 'fechado', tamanho: '58' },
      priceCents: 39900,
    });
    // Marca diferente não vira DIRETO: a categoria e o tipo mantêm a relação
    // como disputa pelo mesmo público, mas o modelo não confirma o mesmo produto.
    expect(result.kind).not.toBe('DIRETO');
    expect(result.similarityPct).toBeLessThan(70);
    expect(result.factors.find((f) => f.factor === 'brand')?.points).toBeLessThan(0);
    expect(result.factors.find((f) => f.factor === 'category')?.points).toBe(15);
  });

  it('produto de outra categoria cai para INDIRETO', () => {
    const result = scoreSimilarity(capacete, {
      title: 'Luvas de moto em couro tamanho G',
      brand: 'X11',
      model: 'X11',
      category: 'Luvas',
      attributes: {},
      priceCents: 8900,
    });
    expect(result.kind).toBe('INDIRETO');
    expect(result.similarityPct).toBeLessThan(45);
  });

  it('mesmo vendedor não é concorrente', () => {
    const result = scoreSimilarity(capacete, {
      ...capacete,
      title: 'Capacete Norisk FF302 Preto',
      seller: 'Loja Própria',
    });
    const sellerFactor = result.factors.find((f) => f.factor === 'seller');
    expect(sellerFactor?.points).toBeLessThan(0);
    expect(result.kind).not.toBe('DIRETO');
  });

  it('sem dados suficientes declara o que faltou em vez de inventar', () => {
    const result = scoreSimilarity(capacete, { title: 'Capacete' });
    expect(result.similarityPct).toBeLessThan(45);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.missing.join(' ')).toMatch(/marca|categoria|modelo/);
  });

  it('justificativa é legível e cita os campos comparados', () => {
    const result = scoreSimilarity(capacete, { ...capacete, title: 'Capacete Norisk FF302', seller: 'Outro' });
    const details = result.factors.map((f) => f.detail).join(' | ');
    expect(details).toMatch(/mesma marca/);
    expect(details).toMatch(/mesmo modelo/);
    expect(details).toMatch(/mesma categoria/);
  });

  it('nunca passa de 0 nem de 100', () => {
    const high = scoreSimilarity(capacete, { ...capacete, seller: 'Outro', title: capacete.title, attributes: capacete.attributes });
    const low = scoreSimilarity(capacete, { title: 'Bicicleta infantil', brand: 'Caloi', model: 'CALOI', category: 'Bicicletas' });
    expect(high.similarityPct).toBeLessThanOrEqual(100);
    expect(low.similarityPct).toBeGreaterThanOrEqual(0);
  });
});

describe('aprendizado por feedback', () => {
  const samples: FeedbackSample[] = [
    { decision: 'APROVADO', features: { title: 'Capacete Norisk FF302 Preto', brand: 'Norisk', category: 'Capacetes' } },
    { decision: 'APROVADO', features: { title: 'Capacete Norisk FF345 Cinza', brand: 'Norisk', category: 'Capacetes' } },
    { decision: 'REJEITADO', features: { title: 'Capacete infantil infantil Patinete', brand: 'Baby', category: 'Capacetes' } },
    { decision: 'REJEITADO', features: { title: 'Capacete infantil Patinete Bike', brand: 'Baby', category: 'Capacetes' } },
  ];

  it('cria regra de preferência e de aversão com suporte mínimo', () => {
    const rules = deriveLearningRules(samples, 2);
    expect(rules.some((r) => r.scope === 'BRAND' && r.value === 'norisk' && r.direction === 'PREFERIR')).toBe(true);
    expect(rules.some((r) => r.scope === 'BRAND' && r.value === 'baby' && r.direction === 'EVITAR')).toBe(true);
  });

  it('não cria regra com uma única decisão', () => {
    const rules = deriveLearningRules([samples[0]!], 2);
    expect(rules).toHaveLength(0);
  });

  it('regra aprendida altera o score das próximas buscas', () => {
    const rules = deriveLearningRules(samples, 2);
    const candidato = { title: 'Capacete Norisk FF302', brand: 'Norisk', category: 'Capacetes' };
    const base = scoreSimilarity(
      { title: 'Capacete Norisk FF302 Preto', brand: 'Norisk', category: 'Capacetes' },
      candidato,
    );
    const adjustment = applyLearning(candidato, base, rules);
    expect(adjustment.points).toBeGreaterThan(0);
    expect(adjustment.applied.length).toBeGreaterThan(0);
    const adjusted = withLearning(base, adjustment);
    expect(adjusted.similarityPct).toBeGreaterThanOrEqual(base.similarityPct);
    expect(adjusted.summary).toMatch(/aprendizado/);
  });

  it('marca rejeitada reduz a similaridade', () => {
    const rules = deriveLearningRules(samples, 2);
    const candidato = { title: 'Capacete Baby infantil', brand: 'Baby', category: 'Capacetes' };
    const base = scoreSimilarity({ title: 'Capacete Baby infantil', brand: 'Baby', category: 'Capacetes' }, candidato);
    const adjusted = withLearning(base, applyLearning(candidato, base, rules));
    expect(adjusted.similarityPct).toBeLessThanOrEqual(base.similarityPct);
  });

  it('regra sem correspondência não altera nada', () => {
    const rules = deriveLearningRules(samples, 2);
    const candidato = { title: 'Luvas de couro', brand: 'Zeta', category: 'Luvas' };
    const base = scoreSimilarity({ title: 'Luvas', brand: 'Zeta', category: 'Luvas' }, candidato);
    const adjustment = applyLearning(candidato, base, rules);
    expect(adjustment.points).toBe(0);
    expect(adjustment.applied).toHaveLength(0);
  });
});
