/**
 * Testes do banco e da regra de proveniência.
 *
 * Roda no test runner nativo do Node (node:test), não no Vitest: o Vitest
 * tenta resolver `node:sqlite` pelo pipeline do Vite e falha. O runner do Node
 * executa o arquivo direto, com os módulos embutidos no lugar certo.
 *
 * Executar com: node --import tsx --test test/database.test.ts
 *
 * O que está protegido aqui:
 *  - migration aplicada e registrada;
 *  - foreign keys ativas (dado órfão rejeitado pelo banco);
 *  - proveniência incompleta rejeitada;
 *  - ZERO, UNKNOWN e NOT_COLLECTED são estados distintos;
 *  - recaptura gera nova observação, nunca sobrescreve o histórico.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LocalDatabase } from "../src/database/db.js";
import { CollectionRepository, type Provenance } from "../src/database/collection-repository.js";

let db: LocalDatabase;
let repo: CollectionRepository;
let runId: string;

const provenance: Provenance = {
  source: "dom",
  marketplace: "mercadolivre",
  accountRef: "loja-teste",
  pageKind: "listing-list",
  pageUrl: "https://www.mercadolivre.com.br/vendas",
  referenceDate: "2026-11-21T00:00:00.000Z",
  collectedAt: "2026-11-21T14:30:00.000Z",
  method: "adapter.mercadolivre.listings",
  adapterVersion: "0.1.0",
};

beforeEach(() => {
  db = new LocalDatabase({ path: ":memory:" });
  repo = new CollectionRepository(db);
  runId = repo.startRun({
    marketplace: "mercadolivre",
    accountId: null,
    pageKind: "listing-list",
    pageUrl: provenance.pageUrl,
    startedAt: provenance.collectedAt,
  });
});

afterEach(() => db.close());

describe("migrations", () => {
  test("aplica a migration e registra a versão", () => {
    assert.ok(db.migrations().includes("0001_core"));
  });
});

describe("proveniência", () => {
  test("grava observação com proveniência completa", () => {
    const id = repo.record(runId, provenance, {
      entityType: "listing",
      entityRef: "MLB123",
      metric: "visits",
      valueRaw: "42",
      valueNum: 42,
      unit: "count",
      quality: "VERIFIED",
    });
    assert.ok(id);
    assert.equal(repo.countByRun(runId), 1);
  });

  test("rejeita proveniência sem fonte", () => {
    assert.throws(
      () =>
        repo.record(runId, { ...provenance, source: "" }, {
          entityType: "listing",
          entityRef: "MLB123",
          metric: "visits",
          valueRaw: "42",
          valueNum: 42,
          unit: "count",
          quality: "VERIFIED",
        }),
      /PROVENANCE_INCOMPLETE/,
    );
  });

  test("rejeita data de coleta inválida", () => {
    assert.throws(
      () =>
        repo.record(runId, { ...provenance, collectedAt: "ontem" }, {
          entityType: "listing",
          entityRef: "MLB123",
          metric: "visits",
          valueRaw: null,
          valueNum: null,
          unit: null,
          quality: "UNKNOWN",
        }),
      /PROVENANCE_INCOMPLETE/,
    );
  });
});

describe("status de qualidade", () => {
  const base = { entityType: "listing", entityRef: "MLB1", metric: "visits", unit: "count" };

  test("ZERO exige valor zero explícito", () => {
    assert.doesNotThrow(() =>
      repo.record(runId, provenance, { ...base, valueRaw: "0", valueNum: 0, quality: "ZERO" }),
    );
    assert.throws(
      () => repo.record(runId, provenance, { ...base, valueRaw: null, valueNum: null, quality: "ZERO" }),
      /QUALITY_INCONSISTENT/,
    );
  });

  test("UNKNOWN e NOT_COLLECTED não podem carregar valor", () => {
    assert.throws(
      () => repo.record(runId, provenance, { ...base, valueRaw: "10", valueNum: 10, quality: "UNKNOWN" }),
      /QUALITY_INCONSISTENT/,
    );
    assert.doesNotThrow(() =>
      repo.record(runId, provenance, { ...base, valueRaw: null, valueNum: null, quality: "NOT_COLLECTED" }),
    );
  });

  test("rejeita status fora da lista", () => {
    assert.throws(
      () =>
        repo.record(runId, provenance, {
          ...base,
          valueRaw: null,
          valueNum: null,
          quality: "PALPITE" as never,
        }),
      /QUALITY_INVALID/,
    );
  });
});

describe("histórico", () => {
  test("recaptura cria nova observação e preserva a anterior", () => {
    const base = { entityType: "listing", entityRef: "MLB9", metric: "visits", unit: "count" };
    repo.record(runId, provenance, { ...base, valueRaw: "10", valueNum: 10, quality: "VERIFIED" });
    repo.record(
      runId,
      { ...provenance, collectedAt: "2026-11-21T18:00:00.000Z" },
      { ...base, valueRaw: "15", valueNum: 15, quality: "VERIFIED" },
    );
    const history = repo.history("listing", "MLB9", "visits");
    assert.equal(history.length, 2);
    assert.equal(history[0].valueNum, 15);
    assert.equal(history[1].valueNum, 10);
  });
});

describe("integridade referencial", () => {
  test("rejeita dado apontando para execução inexistente", () => {
    assert.throws(() =>
      repo.record("run-que-nao-existe", provenance, {
        entityType: "listing",
        entityRef: "MLB1",
        metric: "visits",
        valueRaw: "1",
        valueNum: 1,
        unit: "count",
        quality: "VERIFIED",
      }),
    );
  });
});
