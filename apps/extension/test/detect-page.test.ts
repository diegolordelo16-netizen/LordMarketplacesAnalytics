/**
 * Testes do reconhecimento de página e de conta.
 *
 * O objetivo destes testes é proteger a regra de integridade: quando não dá
 * para reconhecer, o resultado precisa dizer "não reconhecido" — nunca um
 * chute apresentado como fato.
 */
import { describe, expect, it } from "vitest";
import {
  detectAccount,
  detectMarketplace,
  detectPage,
  detectPageKind,
} from "../src/adapters/detect-page.js";

describe("detectMarketplace", () => {
  it("reconhece o Mercado Livre em domínios e subdomínios", () => {
    expect(detectMarketplace("https://www.mercadolivre.com.br/vendas")).toBe("mercadolivre");
    expect(detectMarketplace("https://vendedor.mercadolivre.com.br/anuncios")).toBe("mercadolivre");
    expect(detectMarketplace("https://mercadolivre.com/vendas")).toBe("mercadolivre");
  });

  it("reconhece a Shopee e o seller center", () => {
    expect(detectMarketplace("https://shopee.com.br/product/123")).toBe("shopee");
    expect(detectMarketplace("https://seller.shopee.com.br/portal/product")).toBe("shopee");
  });

  it("não confunde domínio parecido nem aceita lixo", () => {
    expect(detectMarketplace("https://mercadolivre.com.br.evil.example/vendas")).toBe("unknown");
    expect(detectMarketplace("https://shopee.com.br.evil.example/")).toBe("unknown");
    expect(detectMarketplace("nao-e-url")).toBe("unknown");
  });
});

describe("detectPageKind", () => {
  it("classifica páginas do Mercado Livre", () => {
    expect(detectPageKind("https://www.mercadolivre.com.br/vendas", "mercadolivre")).toBe("listing-list");
    expect(detectPageKind("https://www.mercadolivre.com.br/estoque", "mercadolivre")).toBe("inventory");
    expect(detectPageKind("https://www.mercadolivre.com.br/publicidade", "mercadolivre")).toBe("ads");
    expect(detectPageKind("https://www.mercadolivre.com.br/jm/login", "mercadolivre")).toBe("login");
  });

  it("login tem prioridade sobre qualquer outra classificação", () => {
    expect(detectPageKind("https://www.mercadolivre.com.br/vendas/login", "mercadolivre")).toBe("login");
    expect(detectPageKind("https://seller.shopee.com.br/portal/product/login", "shopee")).toBe("login");
  });

  it("classifica páginas da Shopee", () => {
    expect(detectPageKind("https://seller.shopee.com.br/portal/product", "shopee")).toBe("listing-list");
    expect(detectPageKind("https://seller.shopee.com.br/portal/order/all", "shopee")).toBe("orders");
  });

  it("devolve unknown para caminho não mapeado", () => {
    expect(detectPageKind("https://www.mercadolivre.com.br/qualquer-coisa-nova", "mercadolivre")).toBe("unknown");
  });
});

describe("detectAccount", () => {
  it("lê a conta do cabeçalho do painel", () => {
    const text = "Vender\n\nDiego Loja Oficial\nMeus produtos";
    expect(detectAccount("https://www.mercadolivre.com.br/vendas", "mercadolivre", text)).toEqual({
      account: "Diego Loja Oficial",
      source: "page-header",
    });
  });

  it("cai para o slug da URL quando o cabeçalho não está legível", () => {
    expect(
      detectAccount("https://www.mercadolivre.com.br/perfil/DIEGOSTORE", "mercadolivre", ""),
    ).toEqual({ account: "DIEGOSTORE", source: "url-slug" });
  });

  it("não inventa conta: devolve null com motivo", () => {
    expect(detectAccount("https://www.mercadolivre.com.br/vendas", "mercadolivre", "")).toEqual({
      account: null,
      source: "not-readable",
    });
  });
});

describe("detectPage", () => {
  it("monta o contexto com confiança alta quando reconhece tudo", () => {
    const ctx = detectPage(
      "https://www.mercadolivre.com.br/vendas",
      "Vendas",
      "Vender\nMinha Loja Teste\n",
    );
    expect(ctx.marketplace).toBe("mercadolivre");
    expect(ctx.pageKind).toBe("listing-list");
    expect(ctx.account).toBe("Minha Loja Teste");
    expect(ctx.confidence).toBe("high");
    expect(() => new Date(ctx.detectedAt).toISOString()).not.toThrow();
  });

  it("marca confiança baixa fora de marketplace", () => {
    const ctx = detectPage("https://example.com/", "Exemplo", "");
    expect(ctx.marketplace).toBe("unknown");
    expect(ctx.pageKind).toBe("unknown");
    expect(ctx.confidence).toBe("low");
    expect(ctx.account).toBeNull();
  });
});
