/**
 * Teste de ponta a ponta do serviço: HTML real → canal → banco → analytics → cérebro.
 *
 * É o teste que prova a POC inteira. Se ele passa, o caminho do dado funciona:
 * a página que o usuário tem aberta vira recomendação rastreável no banco.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, makeEnvelope } from "@lma/protocol";
import { startAgent } from "../src/agent.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const PAGE = `<!doctype html><html><body>
<ul>
  <li>
    <a href="https://www.mercadolivre.com.br/anuncios/MLB-1000000001">ver</a>
    <h2 class="title">Fone Bluetooth</h2>
    <span class="price">R$ 199,90</span>
    <span class="stock">0 unidades</span>
  </li>
  <li>
    <a href="https://www.mercadolivre.com.br/anuncios/MLB1000000002">ver</a>
    <h2 class="title">Capa de Celular</h2>
    <span class="price">R$ 39,90</span>
    <span class="stock">2 unidades</span>
  </li>
  <li>
    <a href="https://www.mercadolivre.com.br/anuncios/MLB1000000003">ver</a>
    <h2 class="title">Carregador</h2>
    <span class="price">R$ 89,90</span>
  </li>
</ul></body></html>`;

const SHOPEE_PAGE = `<!doctype html><html><body>
<table><tbody>
  <tr>
    <td><a href="/portal/product/123456/987654321">Fone TWS</a></td>
    <td class="price">R$ 129,90</td>
    <td class="stock">Estoque: 42</td>
  </tr>
  <tr>
    <td><a href="/portal/product/123456/987654322">Capa Transparente</a></td>
    <td class="price">R$ 19,90 - R$ 34,90</td>
    <td class="stock">Estoque: 0</td>
  </tr>
</tbody></table>
</body></html>`;

const ORDERS_PAGE = `<!doctype html><html><body><table><tbody>
  <tr><td>Venda 2000012345678901</td><td>R$ 249,90</td><td>21/11/2026</td><td>Enviado</td></tr>
  <tr><td>Venda 2000012345678902</td><td>R$ 1.010,00</td><td>2026-11-20</td><td>Entregue</td></tr>
  <tr><td>Venda sem numero</td><td>R$ 59,90</td><td>19/11/2026</td><td>Pendente</td></tr>
</tbody></table></body></html>`;

let dir: string;
let server: Awaited<ReturnType<typeof startAgent>>["server"];
let ctx: Awaited<ReturnType<typeof startAgent>>["ctx"];
let port: number;
let ws: WebSocket;
let seq = 0;

/**
 * Uma única fila de eventos: cada chamada registra o correlationId que espera.
 * Fila em vez de `ws.once` por chamada — com vários testes assíncronos o
 * listener avulso perde a resposta e o teste morre por timeout falso.
 */
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function attachQueue(): void {
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const waiter = pending.get(msg.correlationId);
    if (!waiter) return;
    pending.delete(msg.correlationId);
    clearTimeout(waiter.timer);
    if (msg.type === "ERROR") waiter.reject(new Error(`${msg.payload.code}: ${msg.payload.message}`));
    else waiter.resolve(msg.payload);
  });
}

function call(namespace: string, action: string, payload: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = makeEnvelope("REQUEST", namespace as never, { action, ...payload });
    const timer = setTimeout(() => {
      pending.delete(env.correlationId);
      reject(new Error(`timeout em ${action}`));
    }, 5000);
    pending.set(env.correlationId, { resolve, reject, timer });
    ws.send(JSON.stringify(env));
    seq += 1;
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "lma-e2e-"));
  const started = await startAgent({
    dbPath: join(dir, "test.db"),
    allowedOrigins: [ORIGIN],
    port: 0,
    env: {} as NodeJS.ProcessEnv,
  });
  server = started.server;
  ctx = started.ctx;
  port = started.port;

  ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
  await new Promise<void>((r) => ws.once("open", () => r()));
  await new Promise<void>((resolve, reject) => {
    ws.once("message", (raw) => {
      const hs = JSON.parse(raw.toString());
      if (hs.accepted) {
        attachQueue();
        resolve();
      }
      else reject(new Error(`handshake recusado: ${JSON.stringify(hs)}`));
    });
    ws.send(
      JSON.stringify({
        token: server.pairingToken,
        clientVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
  });
});

after(async () => {
  ws?.terminate();
  await server?.stop();
  ctx?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("saúde do serviço", () => {
  test("responde health com auditoria válida", async () => {
    const health = await call("system", "health");
    assert.equal(health.ok, true);
    assert.equal(health.audit.ok, true);
    assert.equal(health.ownerSet, true);
  });
});

describe("captura real", () => {
  test("captura a página e grava proveniência completa", async () => {
    const result = await call("capture", "page", {
      marketplace: "mercadolivre",
      pageKind: "listing-list",
      pageUrl: "https://www.mercadolivre.com.br/vendas",
      html: PAGE,
      accountRef: "loja-do-diego",
    });
    assert.equal(result.cardsParsed, 3);
    assert.equal(result.outcome, "COMPLETED");
    assert.equal(result.observationsWritten, 9); // 3 anúncios × 3 métricas
  });

  test("os anúncios aparecem na listagem com título e estoque", async () => {
    const data = await call("kpi", "listings");
    assert.equal(data.listings.length, 3);
    const fone = data.listings.find((l: any) => l.entityRef === "MLB1000000001");
    assert.equal(fone.title, "Fone Bluetooth");
    assert.equal(fone.priceCents, 19990);
    assert.equal(fone.stock, 0);
  });

  test("o censo de qualidade mostra só dado verificado", async () => {
    const data = await call("kpi", "listings");
    assert.ok(data.qualityCensus.VERIFIED >= 6);
    assert.ok(data.qualityCensus.NOT_COLLECTED >= 1); // estoque do carregador
  });

  test("a série de uma métrica é consultável com proveniência", async () => {
    const series = await call("kpi", "series", {
      entityType: "listing",
      entityRef: "MLB1000000001",
      metric: "price_cents",
    });
    assert.equal(series.rows.length, 1);
    assert.equal(series.rows[0].source, "dom");
    assert.equal(series.rows[0].pageUrl, "https://www.mercadolivre.com.br/vendas");
    assert.equal(series.rows[0].adapterVersion, "0.1.0");
  });

  test("marketplace sem adapter é recusado, não fingido", async () => {
    await assert.rejects(
      () =>
        call("capture", "page", {
          marketplace: "amazon",
          pageKind: "listing-list",
          pageUrl: "https://sellercentral.amazon.com.br",
          html: PAGE,
        }),
      /sem adapter implementado/,
    );
  });

  test("captura pedidos do Mercado Livre com valor e data", async () => {
    const result = await call("capture", "orders", {
      marketplace: "mercadolivre",
      pageUrl: "https://www.mercadolivre.com.br/vendas/pedidos",
      html: ORDERS_PAGE,
    });
    assert.equal(result.entityType, "order");
    assert.equal(result.rowsParsed, 2);
    assert.equal(result.rowsWithoutId, 1);
    assert.equal(result.observationsWritten, 8);
  });

  test("cruzamento venda x estoque soma so o que tem valor", async () => {
    const result = await call("kpi", "salesStock", {});
    assert.equal(result.ordersWithValue, 2);
    assert.equal(result.totalCents, 24990 + 101000);
    assert.equal(result.byMarketplace.mercadolivre.orders, 2);
  });

  test("cruzamento reporta o estoque que ja foi lido, e nao reclama sem motivo", async () => {
    const result = await call("kpi", "salesStock", {});
    // O estoque da captura anterior do teste segue no banco: 2 produtos com valor.
    assert.equal(result.stockKnown, 2);
    assert.equal(result.note, undefined);
  });

  test("captura a lista de produtos da Shopee com proveniência do adapter certo", async () => {
    const result = await call("capture", "page", {
      marketplace: "shopee",
      pageKind: "listing-list",
      pageUrl: "https://seller.shopee.com.br/portal/product/list",
      accountRef: "shop:778899",
      html: SHOPEE_PAGE,
    });
    assert.equal(result.entityType, "product");
    assert.equal(result.cardsParsed, 2);
    assert.equal(result.observationsWritten, 6);
  });

  test("o produto da Shopee é consultável com o método do adapter da Shopee", async () => {
    const series = await call("kpi", "series", {
      entityType: "product",
      entityRef: "123456:987654321",
      metric: "stock",
    });
    assert.equal(series.rows.length, 1);
    assert.equal(series.rows[0].valueNum, 42);
    assert.equal(series.rows[0].method, "adapter.shopee.listing-list.dom-v1");
    assert.equal(series.rows[0].marketplace, "shopee");
  });
});

describe("cérebro", () => {
  test("gera recomendações coerentes com os dados capturados", async () => {
    const report = await call("agent", "report");
    assert.equal(report.listingsAnalyzed, 3);
    const areas = report.recommendations.map((r: any) => r.area);
    assert.ok(areas.includes("estoque")); // fone com estoque 0
    assert.ok(report.blindSpots.some((b: string) => /histórico/.test(b)));
  });

  test("auditoria externa sem chave é recusada com motivo claro", async () => {
    const result = await call("agent", "audit");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "NOT_CONFIGURED");
    assert.match(result.message, /indisponível/);
  });

  test("consultas extraordinárias são limitadas e válidas", async () => {
    await assert.rejects(() => call("gemini", "grantExtra", { quantity: 0 }), /entre 1 e 20/);
    await assert.rejects(() => call("gemini", "grantExtra", { quantity: 99 }), /entre 1 e 20/);
  });
});

describe("central de melhorias", () => {
  test("propõe e só o dono aprova", async () => {
    const imp = await call("improvement", "propose", {
      title: "Novo seletor de estoque",
      rationale: "O seletor atual devolve NOT_COLLECTED em anúncios com variação.",
      kind: "adapter",
      payload: { selector: "[data-testid=stock]" },
    });
    assert.equal(imp.status, "PROPOSED");

    // ator que não é o dono
    await assert.rejects(
      () => call("improvement", "decide", { id: imp.id, decision: "APPROVED", actorId: "intruso" }),
      /IMPROVEMENT_NOT_APPROVED/,
    );

    const approved = await call("improvement", "decide", {
      id: imp.id,
      decision: "APPROVED",
      actorId: ctx.ownerId,
      note: "aprovado",
    });
    assert.equal(approved.status, "APPROVED");

    const list = await call("improvement", "list", { status: "APPROVED" });
    assert.equal(list.items.length, 1);
  });
});

describe("auditoria final", () => {
  test("a cadeia de auditoria continua íntegra depois de tudo", async () => {
    const health = await call("system", "health");
    assert.equal(health.audit.ok, true);
    assert.ok(health.audit.total >= 4);
  });
});
