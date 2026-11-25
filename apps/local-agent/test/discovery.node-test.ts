/**
 * Descoberta assistida: nota explicável, nenhuma sugestão aprovada sozinha,
 * rejeição registrada e aprendizado que muda a próxima nota.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalDatabase } from "../src/database/db.js";
import { DiscoveryService, keywords, modelTokens, scrapeListings } from "../src/services/discovery.js";
import { CompetitorService } from "../src/services/competitors.js";

function freshDb(): LocalDatabase {
  const dir = mkdtempSync(join(tmpdir(), "lma-discovery-"));
  return new LocalDatabase({ path: join(dir, "test.db") });
}

const MEU = {
  entityRef: "MLB100000000",
  marketplace: "mercadolivre",
  title: "Capacete Norisk FF302 Fechado Preto Fosco",
  brand: "Norisk",
  model: "FF302",
  category: "Capacetes",
  attributes: { tipo: "capacete fechado", viseira: "fumê" },
  priceCents: 34990,
};

test("palavras e códigos de modelo saem limpos do título", () => {
  assert.deepEqual(modelTokens("Capacete Norisk FF302 Preto"), ["ff302"]);
  const k = keywords("Capacete Norisk FF302 Fechado Preto Fosco");
  assert.ok(k.includes("capacete"));
  assert.ok(!k.includes("de"));
  assert.ok(k.includes("ff302")); // a palavra existe; o que a exclui do modelo é o teste acima
});

test("lê anúncios de uma página de resultados do Mercado Livre", () => {
  const html = `
    <ol>
      <li><a href="https://produto.mercadolivre.com.br/MLB-1111111111-capacete-a" title="Capacete Norisk FF302 Preto">
        <h2>Capacete Norisk FF302 Preto</h2>
        <span class="andes-money-amount__fraction">329</span>
      </a></li>
      <li><a href="https://produto.mercadolivre.com.br/MLB-2222222222-capacete-b">
        <h2>Capacete LS2 Storm Preto</h2>
        <span class="andes-money-amount__fraction">459</span>
      </a></li>
    </ol>`;
  const items = scrapeListings(html, "mercadolivre");
  assert.deepEqual(items.map((i) => i.externalRef), ["MLB1111111111", "MLB2222222222"], JSON.stringify(items));
  assert.equal(items[0].externalRef, "MLB1111111111");
  assert.equal(items[0].priceCents, 32900);
  assert.equal(items[1].externalRef, "MLB2222222222");
});

test("mesmo modelo e marca vira concorrente DIRETO com nota alta", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const scored = service.score(product, {
    externalRef: "MLB9",
    url: "https://produto.mercadolivre.com.br/MLB-9",
    title: "Capacete Norisk FF302 Fechado Preto Fosco Tamanho 58",
    seller: null,
    priceCents: 33990,
    imageUrl: null,
  });
  assert.equal(scored.relation, "DIRETO");
  assert.ok(scored.similarityBp >= 7000, `nota ${scored.similarityBp}`);
  assert.ok(scored.justification.includes("modelo"));
  assert.ok(scored.components.some((c) => c.signal === "modelo" && c.points > 0));
});

test("título diferente mas mesmo modelo ainda é reconhecido", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const scored = service.score(product, {
    externalRef: "MLB10",
    url: "https://produto.mercadolivre.com.br/MLB-10",
    title: "Capacete Fechado Original NORISK modelo FF 302",
    seller: null,
    priceCents: 36990,
    imageUrl: null,
  });
  assert.ok(scored.similarityBp >= 3000, `nota ${scored.similarityBp}`);
  assert.ok(["DIRETO", "SIMILAR"].includes(scored.relation));
});

test("produto de outra categoria fica INDIRETO ou fora do corte", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const scored = service.score(product, {
    externalRef: "MLB11",
    url: "https://produto.mercadolivre.com.br/MLB-11",
    title: "Luva de moto em couro preta tamanho G",
    seller: null,
    priceCents: 12900,
    imageUrl: null,
  });
  assert.equal(scored.relation, "INDIRETO");
  assert.ok(scored.similarityBp < 4500);
});

test("busca grava sugestões PENDENTES e nunca aprovadas", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const html = `
    <a href="https://produto.mercadolivre.com.br/MLB-1111111111-a"><h2>Capacete Norisk FF302 Preto</h2></a>
    <a href="https://produto.mercadolivre.com.br/MLB-2222222222-b"><h2>Luva de moto couro</h2></a>`;
  const r = service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "https://lista.mercadolivre.com.br/capacete" });
  assert.equal(r.seen, 2);
  assert.ok(r.candidates.length >= 1);
  assert.ok(r.candidates.every((c) => c.status === "PENDENTE"));
  const stats = service.stats();
  assert.equal(stats.approved, 0);
  assert.equal(stats.pending, r.candidates.length);
});

test("busca repetida não duplica a mesma sugestão", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const html = `<a href="https://produto.mercadolivre.com.br/MLB-1111111111-a"><h2>Capacete Norisk FF302 Preto</h2></a>`;
  service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "x" });
  service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "x" });
  assert.equal(service.candidates({ productId: product.id }).length, 1);
});

test("página sem anúncio legível não inventa sugestão", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const r = service.discoverFromHtml(product.id, "<html><body>captcha</body></html>", {
    marketplace: "mercadolivre",
    pageUrl: "x",
  });
  assert.equal(r.seen, 0);
  assert.equal(r.candidates.length, 0);
  assert.ok(r.note.includes("não trouxe anúncios"));
});

test("rejeitar registra o motivo e não volta a ser pendente na próxima busca", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const html = `<a href="https://produto.mercadolivre.com.br/MLB-2222222222-b"><h2>Luva de moto couro preta</h2></a>`;
  const first = service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
  const id = first.candidates[0].id;
  service.reject(id, "é acessório, não capacete");
  assert.equal(service.candidate(id)?.status, "REJEITADO");
  assert.equal(service.candidate(id)?.rejectionReason, "é acessório, não capacete");
  service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
  assert.equal(service.candidate(id)?.status, "REJEITADO");
});

test("aprovar é o único caminho para o monitoramento", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const html = `<a href="https://produto.mercadolivre.com.br/MLB-1111111111-a"><h2>Capacete Norisk FF302 Preto</h2></a>`;
  const r = service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "x" });
  const c = r.candidates[0];
  assert.equal(c.competitorId, null);
  const { candidate, competitor } = service.approve(c.id, { linkedEntityRef: product.entityRef });
  assert.equal(candidate.status, "APROVADO");
  assert.ok(competitor);
  assert.equal(candidate.competitorId, competitor.id);
  assert.equal(competitor.linkedEntityRef, product.entityRef);
});

test("o aprendizado muda a nota da próxima busca", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const alvo = `<a href="https://produto.mercadolivre.com.br/MLB-3333333333-c"><h2>Capacete genérico preto com viseira</h2></a>`;
  const antes = service.discoverFromHtml(product.id, alvo, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
  const notaAntes = antes.candidates[0].similarityBp;

  // O dono rejeita três anúncios parecidos: "genérico" e "viseira" pesam contra.
  for (let i = 0; i < 3; i++) {
    const html = `<a href="https://produto.mercadolivre.com.br/MLB-44444444${i}-d"><h2>Capacete genérico com viseira ${i}</h2></a>`;
    const r = service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
    service.reject(r.candidates[0].id, "não é o mesmo tipo de capacete");
  }

  const depois = service.discoverFromHtml(product.id, alvo, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
  const notaDepois = depois.candidates[0].similarityBp;
  assert.ok(notaDepois < notaAntes, `nota deveria cair: antes ${notaAntes}, depois ${notaDepois}`);
  assert.ok(depois.candidates[0].components.some((c) => c.signal === "aprendizado" && c.points < 0));
});

test("aprovar aumenta a nota de anúncios parecidos", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const alvo = `<a href="https://produto.mercadolivre.com.br/MLB-5555555555-e"><h2>Capacete integral fosco marca xyz</h2></a>`;
  const antes = service.discoverFromHtml(product.id, alvo, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
  for (let i = 0; i < 2; i++) {
    const html = `<a href="https://produto.mercadolivre.com.br/MLB-66666666${i}-f"><h2>Capacete integral fosco marca xyz ${i}</h2></a>`;
    const r = service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
    service.approve(r.candidates[0].id, {});
  }
  const depois = service.discoverFromHtml(product.id, alvo, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
  assert.ok(depois.candidates[0].similarityBp > antes.candidates[0].similarityBp);
});

test("estatísticas de precisão saem do histórico, não de chute", () => {
  const db = freshDb();
  const service = new DiscoveryService(db, new CompetitorService(db.raw()));
  const product = service.saveProduct(MEU);
  const html = `
    <a href="https://produto.mercadolivre.com.br/MLB-1111111111-a"><h2>Capacete Norisk FF302 Preto</h2></a>
    <a href="https://produto.mercadolivre.com.br/MLB-2222222222-b"><h2>Luva de moto couro</h2></a>`;
  const r = service.discoverFromHtml(product.id, html, { marketplace: "mercadolivre", pageUrl: "x", minSimilarityBp: 0 });
  service.approve(r.candidates[0].id, {});
  service.reject(r.candidates[1].id, "acessório");
  const s = service.stats();
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.decided, 2);
  assert.equal(s.approvalRateBp, 5000);
});
