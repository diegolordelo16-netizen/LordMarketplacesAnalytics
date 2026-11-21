/**
 * Testes do parser de anúncios do Mercado Livre (runner nativo do Node).
 *
 * Fixtures em HTML real, montadas a partir da estrutura que o painel do
 * vendedor usa. O que está protegido:
 *  - preço BR convertido em centavos inteiros, sem float;
 *  - campo ausente vira NOT_COLLECTED, nunca zero;
 *  - preço ilegível vira UNKNOWN com o texto bruto preservado;
 *  - id extraído do href, inclusive com hífen (MLB-1234567890);
 *  - página sem anúncios não inventa dados.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  extractListingId,
  parseListingList,
  parsePriceToCents,
} from "../src/adapters/mercadolivre/listings.js";

const FIXTURE = `<!doctype html><html><body>
<ul class="ui-search-results">
  <li>
    <a href="https://www.mercadolivre.com.br/anuncios/MLB-1234567890">Ver anúncio</a>
    <h2 class="title">Fone Bluetooth TWS</h2>
    <span class="price">R$ 1.234,56</span>
    <span class="stock">12 unidades</span>
  </li>
  <li>
    <a href="https://www.mercadolivre.com.br/anuncios/MLB987654321">Ver anúncio</a>
    <h2 class="title">Capa de Celular</h2>
    <span class="price">R$ 29,90</span>
  </li>
  <li>
    <a href="https://www.mercadolivre.com.br/anuncios/MLB555555555">Ver anúncio</a>
    <h2 class="title">Produto com preço estranho</h2>
    <span class="price">sob consulta</span>
  </li>
</ul>
</body></html>`;

function doc(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("parsePriceToCents", () => {
  test("converte formato brasileiro em centavos", () => {
    assert.equal(parsePriceToCents("R$ 1.234,56"), 123456);
    assert.equal(parsePriceToCents("R$ 29,90"), 2990);
    assert.equal(parsePriceToCents("R$ 5"), 500);
  });

  test("devolve null para texto sem número (não devolve 0)", () => {
    assert.equal(parsePriceToCents("sob consulta"), null);
    assert.equal(parsePriceToCents(""), null);
    assert.equal(parsePriceToCents(null), null);
  });
});

describe("extractListingId", () => {
  test("extrai id com e sem hífen", () => {
    assert.equal(extractListingId("https://x/MLB-1234567890"), "MLB1234567890");
    assert.equal(extractListingId("https://x/MLB1234567890"), "MLB1234567890");
  });

  test("devolve null quando não há id", () => {
    assert.equal(extractListingId("https://x/qualquer"), null);
    assert.equal(extractListingId(null), null);
  });
});

describe("parseListingList", () => {
  const result = parseListingList(doc(FIXTURE));

  test("lê os três anúncios da página", () => {
    assert.equal(result.cardsParsed, 3);
    assert.equal(result.listings.length, 3);
  });

  test("primeiro anúncio tem título, preço em centavos e estoque", () => {
    const first = result.listings.find((l) => l.externalRef === "MLB1234567890");
    assert.ok(first);
    const byMetric = Object.fromEntries(first.observations.map((o) => [o.metric, o]));
    assert.equal(byMetric.title.quality, "VERIFIED");
    assert.equal(byMetric.price_cents.valueNum, 123456);
    assert.equal(byMetric.price_cents.quality, "VERIFIED");
    assert.equal(byMetric.stock.valueNum, 12);
  });

  test("anúncio sem estoque na tela vira NOT_COLLECTED, nunca zero", () => {
    const second = result.listings.find((l) => l.externalRef === "MLB987654321");
    assert.ok(second);
    const stock = second.observations.find((o) => o.metric === "stock");
    assert.ok(stock);
    assert.equal(stock.quality, "NOT_COLLECTED");
    assert.equal(stock.valueNum, null);
  });

  test("preço ilegível vira UNKNOWN com o texto bruto preservado", () => {
    const third = result.listings.find((l) => l.externalRef === "MLB555555555");
    assert.ok(third);
    const price = third.observations.find((o) => o.metric === "price_cents");
    assert.ok(price);
    assert.equal(price.quality, "UNKNOWN");
    assert.equal(price.valueRaw, "sob consulta");
    assert.equal(price.valueNum, null);
  });

  test("toda observação carrega o id do anúncio como entidade", () => {
    for (const listing of result.listings) {
      for (const obs of listing.observations) {
        assert.equal(obs.entityRef, listing.externalRef);
        assert.equal(obs.entityType, "listing");
      }
    }
  });

  test("página sem anúncios não inventa dados", () => {
    const empty = parseListingList(doc("<html><body><p>Nada aqui</p></body></html>"));
    assert.equal(empty.cardsSeen, 0);
    assert.equal(empty.cardsParsed, 0);
    assert.deepEqual(empty.listings, []);
  });
});
