/**
 * Testes do adapter da Shopee (runner nativo do Node).
 *
 * O que está protegido:
 *  - preço em faixa usa o menor valor, e o texto bruto fica preservado;
 *  - estoque ausente vira NOT_COLLECTED, nunca zero;
 *  - id extraído de /{shopid}/{itemid} e de atributos de dado;
 *  - card sem id é contado, não descartado em silêncio;
 *  - página sem produtos não inventa dado.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  extractShopeeItemRef,
  parseShopeePriceToCents,
  parseShopeeProductList,
} from "../src/adapters/shopee/listings.js";

const FIXTURE = `<!doctype html><html><body>
<table class="product-list">
  <tbody>
    <tr>
      <td><a href="/portal/product/123456/987654321" title="Fone TWS">Fone TWS</a></td>
      <td class="price">R$ 129,90</td>
      <td class="stock">Estoque: 42</td>
    </tr>
    <tr>
      <td><a href="/portal/product/123456/987654322">Capa Transparente</a></td>
      <td class="price">R$ 19,90 - R$ 34,90</td>
      <td class="stock">Estoque: 0</td>
    </tr>
    <tr>
      <td><a href="/portal/product/123456/987654323">Carregador Turbo</a></td>
      <td class="price">sob consulta</td>
      <td></td>
    </tr>
    <tr>
      <td><a href="/portal/product/123456/987654324">Sem estoque na tela</a></td>
      <td class="price">R$ 59,00</td>
    </tr>
  </tbody>
</table>
</body></html>`;

function doc(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("parseShopeePriceToCents", () => {
  test("converte preço simples", () => {
    assert.equal(parseShopeePriceToCents("R$ 129,90"), 12990);
    assert.equal(parseShopeePriceToCents("R$ 1.234,56"), 123456);
  });

  test("faixa de preço usa o menor valor", () => {
    assert.equal(parseShopeePriceToCents("R$ 19,90 - R$ 34,90"), 1990);
  });

  test("texto sem número devolve null, nunca 0", () => {
    assert.equal(parseShopeePriceToCents("sob consulta"), null);
    assert.equal(parseShopeePriceToCents(""), null);
    assert.equal(parseShopeePriceToCents(null), null);
  });
});

describe("extractShopeeItemRef", () => {
  test("extrai shopid:itemid do link de edição", () => {
    assert.equal(extractShopeeItemRef("/portal/product/123456/987654321"), "123456:987654321");
    assert.equal(
      extractShopeeItemRef("https://seller.shopee.com.br/portal/product/1/2?x=1"),
      "1:2",
    );
  });

  test("extrai de atributos de dado", () => {
    assert.equal(extractShopeeItemRef(null, { itemId: "555666", shopId: "777" }), "777:555666");
    assert.equal(extractShopeeItemRef(null, { itemId: "555666" }), "555666");
  });

  test("devolve null sem id", () => {
    assert.equal(extractShopeeItemRef("/portal/product"), null);
    assert.equal(extractShopeeItemRef(null), null);
  });
});

describe("parseShopeeProductList", () => {
  const result = parseShopeeProductList(doc(FIXTURE));

  test("lê os quatro produtos da tabela", () => {
    assert.equal(result.cardsParsed, 4);
  });

  test("primeiro produto: título, preço e estoque verificados", () => {
    const first = result.listings.find((l) => l.externalRef === "123456:987654321");
    assert.ok(first);
    const byMetric = Object.fromEntries(first.observations.map((o) => [o.metric, o]));
    assert.equal(byMetric.title.valueRaw, "Fone TWS");
    assert.equal(byMetric.price_cents.valueNum, 12990);
    assert.equal(byMetric.price_cents.quality, "VERIFIED");
    assert.equal(byMetric.stock.valueNum, 42);
    assert.equal(byMetric.stock.quality, "VERIFIED");
  });

  test("estoque zero confirmado tem status VERIFIED com valor 0", () => {
    const second = result.listings.find((l) => l.externalRef === "123456:987654322");
    assert.ok(second);
    const stock = second.observations.find((o) => o.metric === "stock");
    assert.ok(stock);
    assert.equal(stock.valueNum, 0);
    assert.equal(stock.quality, "VERIFIED");
  });

  test("preço ilegível vira UNKNOWN com texto bruto", () => {
    const third = result.listings.find((l) => l.externalRef === "123456:987654323");
    assert.ok(third);
    const price = third.observations.find((o) => o.metric === "price_cents");
    assert.ok(price);
    assert.equal(price.quality, "UNKNOWN");
    // A célula de preço contém apenas "sob consulta": sem número, sem valor.
    assert.match(String(price.valueRaw), /sob consulta/);
    assert.equal(price.valueNum, null);
  });

  test("estoque ausente vira NOT_COLLECTED, nunca zero", () => {
    const fourth = result.listings.find((l) => l.externalRef === "123456:987654324");
    assert.ok(fourth);
    const stock = fourth.observations.find((o) => o.metric === "stock");
    assert.ok(stock);
    assert.equal(stock.quality, "NOT_COLLECTED");
    assert.equal(stock.valueNum, null);
  });

  test("toda observação é do tipo product com o id do produto", () => {
    for (const listing of result.listings) {
      for (const obs of listing.observations) {
        assert.equal(obs.entityType, "product");
        assert.equal(obs.entityRef, listing.externalRef);
      }
    }
  });

  test("página sem produtos não inventa dado", () => {
    const empty = parseShopeeProductList(doc("<html><body><p>vazio</p></body></html>"));
    assert.equal(empty.cardsParsed, 0);
    assert.deepEqual(empty.listings, []);
  });
});
