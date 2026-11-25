/**
 * Testes da camada de inteligência: concorrentes por link, editor de descrição
 * (título imutável), financeiro e missões.
 *
 * O que estes testes protegem:
 *  - link colado é reconhecido sem chamar o marketplace;
 *  - campo não lido fica NULL, nunca zero;
 *  - histórico de concorrente nunca é sobrescrito;
 *  - o editor RECUSA perder texto original;
 *  - sem custo cadastrado não existe margem (NOT_COLLECTED), não existe zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalDatabase } from "../src/database/db.js";
import {
  CompetitorService,
  parseListingLink,
  parseListingPage,
} from "../src/services/competitors.js";
import {
  DescriptionEditor,
  assertPreserved,
  diffLines,
} from "../src/services/description-editor.js";
import { FinanceService, scoreMission } from "../src/services/finance.js";
import { buildMissions } from "../src/services/missions.js";

function freshDb(): LocalDatabase {
  const dir = mkdtempSync(join(tmpdir(), "lma-intel-"));
  return new LocalDatabase({ path: join(dir, "test.db") });
}

// ------------------------------------------------------------- links

test("identifica o anúncio do Mercado Livre a partir do link colado", () => {
  const a = parseListingLink("https://www.mercadolivre.com.br/fone-bluetooth/p/MLB12345678?tracking=abc");
  assert.equal(a.marketplace, "mercadolivre");
  assert.equal(a.externalRef, "MLB12345678");
  const b = parseListingLink("https://produto.mercadolivre.com.br/MLB-3456789012-fone#position=3");
  assert.equal(b.externalRef, "MLB3456789012");
});

test("identifica o produto da Shopee e recusa link sem código", () => {
  const p = parseListingLink("https://shopee.com.br/Fone-Bluetooth-i.123456.987654321?sp_atk=x");
  assert.equal(p.marketplace, "shopee");
  assert.equal(p.externalRef, "123456:987654321");
  assert.throws(() => parseListingLink("https://shopee.com.br/loja"), /Shopee/);
});

test("marketplace desconhecido é registrado como desconhecido, sem inventar", () => {
  const p = parseListingLink("https://www.amazon.com.br/dp/B0ABC123");
  assert.equal(p.kind, "unknown");
  assert.equal(p.marketplace, "com.br");
});

// ------------------------------------------------------------- leitura

test("lê preço, vendidos, avaliação e estoque da página", () => {
  const html = `<html><body>
    <h1>Fone Bluetooth XYZ</h1>
    <div class="andes-money-amount__fraction">129</div>
    <span>1.234 vendidos</span>
    <span>4,7 de 5 estrelas</span>
    <span>(356 avaliações)</span>
    <span>Últimas 3 unidades</span>
    <span>Chega grátis amanhã</span>
  </body></html>`;
  const r = parseListingPage(html);
  assert.equal(r.priceCents, 12900);
  assert.equal(r.soldCount, 1234);
  assert.equal(r.rating, 4.7);
  assert.equal(r.reviewsCount, 356);
  assert.match(r.stockText ?? "", /3 unidades/i);
  assert.equal(r.quality, "VERIFIED");
});

test("página sem dado legível não inventa: fica NOT_COLLECTED", () => {
  const r = parseListingPage("<html><body>aguarde</body></html>");
  assert.equal(r.priceCents, null);
  assert.equal(r.soldCount, null);
  assert.equal(r.quality, "NOT_COLLECTED");
});

// ------------------------------------------------------------- concorrentes

test("cadastro por link é idempotente e guarda histórico sem sobrescrever", () => {
  const db = freshDb();
  const svc = new CompetitorService(db.raw());
  const c1 = svc.add("https://produto.mercadolivre.com.br/MLB-1111111111-fone");
  const c2 = svc.add("https://produto.mercadolivre.com.br/MLB-1111111111-fone?utm=x");
  assert.equal(c1.id, c2.id);

  svc.recordSnapshot(c1.id, {
    html: `<h1>Fone A</h1><div class="andes-money-amount__fraction">100</div><span>10 vendidos</span>`,
    pageUrl: "u1",
  });
  svc.recordSnapshot(c1.id, {
    html: `<h1>Fone A</h1><div class="andes-money-amount__fraction">90</div><span>25 vendidos</span>`,
    pageUrl: "u2",
  });

  const detail = svc.get(c1.id);
  assert.equal(detail?.snapshots, 2);
  assert.equal(detail?.latest?.priceCents, 9000);
  assert.equal(detail?.change?.soldDelta, 15);
  assert.ok((detail?.change?.pricePct ?? 0) < -9);

  const events = svc.events(10);
  assert.ok(events.some((e) => e.kind === "PRICE_DROP"));
  assert.ok(events.some((e) => e.kind === "SALES_UP"));
});

test("primeira leitura não gera evento de mudança (não há comparação)", () => {
  const db = freshDb();
  const svc = new CompetitorService(db.raw());
  const c = svc.add("https://produto.mercadolivre.com.br/MLB-2222222222-x");
  svc.recordSnapshot(c.id, {
    html: `<h1>X</h1><div class="andes-money-amount__fraction">50</div>`,
    pageUrl: "u",
  });
  assert.equal(svc.events(10).length, 0);
  assert.equal(svc.get(c.id)?.change?.firstObservation, true);
});

test("pausar e excluir monitoramento", () => {
  const db = freshDb();
  const svc = new CompetitorService(db.raw());
  const c = svc.add("https://produto.mercadolivre.com.br/MLB-3333333333-x");
  assert.ok(svc.setStatus(c.id, "PAUSED"));
  assert.equal(svc.list({ status: "PAUSED" }).length, 1);
  svc.setStatus(c.id, "DELETED");
  assert.equal(svc.list().length, 0);
});

// ------------------------------------------------------------- descrição

test("proposta complementa a descrição sem tocar no título e preserva o original", () => {
  const db = freshDb();
  const ed = new DescriptionEditor(db.raw());
  const original = "Camiseta masculina algodão. Enviamos em 24h.";
  const p = ed.propose({
    marketplace: "mercadolivre",
    entityRef: "MLB1",
    title: "Camiseta masculina",
    description: original,
    knownFacts: { tecido: "Composição: 100% algodão." },
  });
  assert.equal(p.titleOriginal, "Camiseta masculina");
  assert.ok(p.descriptionAfter.includes(original));
  assert.ok(p.additions.length >= 1);
  assert.equal(p.status, "PROPOSED");
  assert.ok(diffLines(p.descriptionBefore, p.descriptionAfter).some((l) => l.kind === "added"));
});

test("texto original perdido é recusado pela trava", () => {
  assert.throws(() => assertPreserved("linha original", "outra coisa"), /perdeu texto/);
});

test("sem dado confirmado a lacuna não é preenchida pela IA", () => {
  const db = freshDb();
  const ed = new DescriptionEditor(db.raw());
  const p = ed.propose({
    marketplace: "mercadolivre",
    entityRef: "MLB2",
    title: "Fone bluetooth",
    description: "Fone bluetooth com case.",
  });
  assert.equal(p.descriptionAfter, p.descriptionBefore);
  assert.equal(p.additions.length, 0);
});

test("aprovação e rejeição mudam o estado, aplicado é final", () => {
  const db = freshDb();
  const ed = new DescriptionEditor(db.raw());
  const p = ed.propose({
    marketplace: "mercadolivre",
    entityRef: "MLB3",
    title: "Tênis corrida",
    description: "Tênis para corrida leve.",
    knownFacts: { material: "Material: cabedal em mesh." },
  });
  assert.equal(ed.decide(p.id, "APPROVED").status, "APPROVED");
  assert.equal(ed.decide(p.id, "APPLIED").status, "APPLIED");
  assert.throws(() => ed.decide(p.id, "REJECTED"), /já aplicada/);
});

// ------------------------------------------------------------- financeiro

test("sem custo cadastrado não existe margem — e não é zero", () => {
  const db = freshDb();
  const fin = new FinanceService(db.raw());
  const m = fin.margin("SKU1", 10000);
  assert.equal(m.contributionCents, null);
  assert.equal(m.status, "NOT_COLLECTED");
  assert.ok(m.missing.includes("custo do produto"));
});

test("margem com custo, comissão e imposto", () => {
  const db = freshDb();
  const fin = new FinanceService(db.raw());
  fin.saveCost({
    entityRef: "SKU1",
    costCents: 4000,
    packagingCents: 200,
    commissionBp: 1400,
    taxBp: 600,
    fixedFeeCents: 500,
    freightCents: 1000,
    minMarginBp: 2000,
  });
  const m = fin.margin("SKU1", 10000);
  // 10000 - (4000+200+1400+600+500+1000) = 2300
  assert.equal(m.commissionCents, 1400);
  assert.equal(m.taxCents, 600);
  assert.equal(m.contributionCents, 2300);
  assert.equal(m.marginBp, 2300);
  assert.equal(m.status, "CALCULATED");
});

test("cenários de preço mostram onde a margem mínima é violada", () => {
  const db = freshDb();
  const fin = new FinanceService(db.raw());
  fin.saveCost({ entityRef: "SKU2", costCents: 8000, minMarginBp: 2000 });
  const sc = fin.scenarios("SKU2", 10000);
  const baixo = sc.find((s) => s.priceCents === 9000);
  assert.equal(baixo?.belowFloor, true);
  const alto = sc.find((s) => s.priceCents === 11000);
  assert.equal(alto?.belowFloor, false);
});

test("score de missão premia impacto e urgência, e pune esforço", () => {
  const base = {
    entityRef: "A",
    marketplace: null,
    pillar: "p",
    bottleneck: "b",
    hypothesis: "h",
    evidence: "e",
    impactCents: 10000,
    impactPct: null,
    effort: 1,
    urgency: 5,
    risk: "r",
  };
  const forte = scoreMission(base, 10000);
  const caro = scoreMission({ ...base, effort: 5 }, 10000);
  assert.ok(forte > caro);
});

test("missões só nascem de dados presentes e ficam no máximo 5", () => {
  const db = freshDb();
  const fin = new FinanceService(db.raw());
  const listings = Array.from({ length: 9 }, (_, i) => ({
    entityRef: `SKU${i}`,
    title: `Produto ${i}`,
    priceCents: 10000,
    stock: 2,
    metrics: [
      { metric: "sold", latest: 300 } as never,
      { metric: "visits", latest: 200 } as never,
    ],
  }));
  const missions = buildMissions(listings, fin, { listings });
  assert.ok(missions.length <= 5);
  assert.ok(missions.every((m) => m.evidence.length > 0));
  // sem custo cadastrado, nenhuma missão afirma margem
  assert.ok(!missions.some((m) => m.pillar === "lucratividade"));
});

test("custo é versionado: o vigente é o mais recente já em vigor", () => {
  const db = freshDb();
  const fin = new FinanceService(db.raw());
  fin.saveCost({ entityRef: "SKU3", costCents: 1000, effectiveFrom: "2026-01-01T00:00:00.000Z" });
  fin.saveCost({ entityRef: "SKU3", costCents: 2000, effectiveFrom: "2026-06-01T00:00:00.000Z" });
  const atual = fin.currentCost("SKU3");
  assert.equal(atual?.costCents, 2000);
  db.close();
});
