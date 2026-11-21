/**
 * Testes do adapter de pedidos.
 *
 * Protegido aqui:
 *  - valor em centavos inteiros, sem float;
 *  - data brasileira e ISO convertidas para a mesma referência;
 *  - pedido sem valor não é pedido (linha ignorada, não inventada);
 *  - pedido sem id é contado, não silenciado;
 *  - status ilegível vira NOT_COLLECTED, nunca "pendente" por padrão.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  extractOrderRef,
  parseBrazilianDate,
  parseMoneyToCents,
  parseOrderList,
} from "../src/adapters/orders.js";

const ML = `<!doctype html><html><body><table><tbody>
  <tr>
    <td>Venda 2000012345678901</td>
    <td>R$ 249,90</td>
    <td>21/11/2026</td>
    <td>Enviado</td>
  </tr>
  <tr>
    <td>Venda 2000012345678902</td>
    <td>R$ 1.010,00</td>
    <td>2026-11-20</td>
    <td>Entregue</td>
  </tr>
  <tr>
    <td>Venda sem número</td>
    <td>R$ 59,90</td>
    <td>19/11/2026</td>
    <td>Pendente</td>
  </tr>
  <tr>
    <td>Aviso de sistema</td>
    <td>—</td>
    <td></td>
    <td></td>
  </tr>
</tbody></table></body></html>`;

function doc(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("parseMoneyToCents", () => {
  test("converte formato brasileiro", () => {
    assert.equal(parseMoneyToCents("R$ 249,90"), 24990);
    assert.equal(parseMoneyToCents("R$ 1.010,00"), 101000);
  });

  test("texto sem número devolve null", () => {
    assert.equal(parseMoneyToCents("—"), null);
    assert.equal(parseMoneyToCents(null), null);
  });
});

describe("parseBrazilianDate", () => {
  test("dd/mm/aaaa vira ISO", () => {
    assert.equal(parseBrazilianDate("21/11/2026"), "2026-11-21T00:00:00.000Z");
  });

  test("aaaa-mm-dd vira ISO", () => {
    assert.equal(parseBrazilianDate("2026-11-20"), "2026-11-20T00:00:00.000Z");
  });

  test("texto sem data devolve null", () => {
    assert.equal(parseBrazilianDate("hoje"), null);
    assert.equal(parseBrazilianDate(null), null);
  });
});

describe("extractOrderRef", () => {
  test("extrai id longo numérico", () => {
    assert.equal(extractOrderRef("Venda 2000012345678901"), "2000012345678901");
  });

  test("devolve null sem id", () => {
    assert.equal(extractOrderRef("sem número"), null);
    assert.equal(extractOrderRef(null), null);
  });
});

describe("parseOrderList", () => {
  const result = parseOrderList(doc(ML), "mercadolivre");

  test("lê os dois pedidos com id, ignora a linha sem id", () => {
    assert.equal(result.rowsParsed, 2);
    assert.equal(result.rowsWithoutId, 1);
    assert.equal(result.rowsSeen, 3); // três linhas com valor
  });

  test("valor e data do primeiro pedido", () => {
    const first = result.orders.find((o) => o.externalRef === "2000012345678901");
    assert.ok(first);
    const byMetric = Object.fromEntries(first.observations.map((o) => [o.metric, o]));
    assert.equal(byMetric.order_total_cents.valueNum, 24990);
    assert.equal(byMetric.order_date.valueRaw, "21/11/2026");
    assert.equal(byMetric.order_status.valueRaw, "Enviado");
    assert.equal(byMetric.order_marketplace.valueRaw, "mercadolivre");
    for (const o of first.observations) assert.equal(o.quality, "VERIFIED");
  });

  test("linha sem valor não vira pedido", () => {
    const ids = result.orders.map((o) => o.externalRef);
    assert.ok(!ids.some((id) => id.includes("sem")));
  });

  test("página sem pedidos não inventa dado", () => {
    const empty = parseOrderList(doc("<html><body><p>vazio</p></body></html>"), "shopee");
    assert.equal(empty.rowsParsed, 0);
    assert.deepEqual(empty.orders, []);
  });
});
