/**
 * Testes da IA interna e do motor de alertas.
 *
 * O que está protegido:
 *  - estoque não legível NÃO gera recomendação de reposição;
 *  - estoque zero confirmado gera recomendação crítica;
 *  - preço sem histórico não gera conclusão de tendência;
 *  - lista vazia gera "ponto cego" explícito, não plano vazio silencioso;
 *  - a trilha de auditoria detecta adulteração.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LocalDatabase } from "../src/database/db.js";
import { CollectionRepository } from "../src/database/collection-repository.js";
import {
  AuditService,
  AnalyticsService,
  computeAlerts,
  summarizeSeries,
} from "../src/services/analytics.js";
import { think } from "../src/services/brain.js";
import type { DataPointRow } from "../src/database/collection-repository.js";

function row(metric: string, value: number | null, at: string, quality = "VERIFIED"): DataPointRow {
  return {
    id: crypto.randomUUID(),
    runId: "r",
    entityType: "listing",
    entityRef: "MLB1",
    metric,
    valueRaw: value === null ? null : String(value),
    valueNum: value,
    unit: "count",
    quality: quality as DataPointRow["quality"],
    source: "dom",
    marketplace: "mercadolivre",
    accountRef: null,
    pageKind: "listing-list",
    pageUrl: "https://x",
    referenceDate: at,
    collectedAt: at,
    method: "m",
    adapterVersion: "0.1.0",
    createdAt: at,
  };
}

describe("summarizeSeries", () => {
  test("sem histórico suficiente não calcula variação", () => {
    const s = summarizeSeries([row("price_cents", 1000, "2026-11-21T10:00:00.000Z")]);
    assert.ok(s);
    assert.equal(s.insufficientHistory, true);
    assert.equal(s.changePct, null);
    assert.equal(s.latest, 1000);
  });

  test("com duas leituras calcula variação percentual", () => {
    const s = summarizeSeries([
      row("price_cents", 900, "2026-11-21T12:00:00.000Z"),
      row("price_cents", 1000, "2026-11-21T10:00:00.000Z"),
    ]);
    assert.ok(s);
    assert.equal(s.insufficientHistory, false);
    assert.equal(s.changePct, -10);
  });

  test("divisão por zero não vira Infinity", () => {
    const s = summarizeSeries([
      row("x", 5, "2026-11-21T12:00:00.000Z"),
      row("x", 0, "2026-11-21T10:00:00.000Z"),
    ]);
    assert.ok(s);
    assert.equal(s.changePct, null);
  });
});

describe("alertas", () => {
  test("estoque não legível gera alerta de atenção, não de reposição", () => {
    const alerts = computeAlerts([
      { entityRef: "MLB1", title: "x", priceCents: null, stock: null, metrics: [] },
    ]);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "attention");
    assert.match(alerts[0].detail, /não significa estoque zero/);
  });

  test("estoque zero gera alerta crítico", () => {
    const alerts = computeAlerts([
      { entityRef: "MLB1", title: "x", priceCents: null, stock: 0, metrics: [] },
    ]);
    assert.equal(alerts[0].severity, "critical");
  });

  test("estoque baixo gera alerta de atenção", () => {
    const alerts = computeAlerts([
      { entityRef: "MLB1", title: "x", priceCents: null, stock: 2, metrics: [] },
    ]);
    assert.equal(alerts[0].severity, "attention");
    assert.match(alerts[0].detail, /2 unidades/);
  });

  test("estoque saudável não gera alerta", () => {
    const alerts = computeAlerts([
      { entityRef: "MLB1", title: "x", priceCents: null, stock: 40, metrics: [] },
    ]);
    assert.equal(alerts.length, 0);
  });
});

describe("cérebro (IA interna)", () => {
  test("estoque NOT_COLLECTED gera recomendação de DADOS, nunca de reposição", () => {
    const report = think([
      {
        entityRef: "MLB1",
        title: "Fone",
        priceCents: null,
        stock: null,
        metrics: [
          {
            metric: "stock",
            latest: null,
            latestQuality: "NOT_COLLECTED",
            latestAt: "2026-11-21T10:00:00.000Z",
            series: [],
            changePct: null,
            insufficientHistory: true,
          },
        ],
      },
    ], []);
    const rec = report.recommendations[0];
    assert.equal(rec.area, "dados");
    assert.ok(!rec.title.includes("Repor"));
  });

  test("estoque zero confirmado gera reposição com confiança alta", () => {
    const report = think([
      {
        entityRef: "MLB1",
        title: "Fone",
        priceCents: null,
        stock: 0,
        metrics: [
          {
            metric: "stock",
            latest: 0,
            latestQuality: "VERIFIED",
            latestAt: "2026-11-21T10:00:00.000Z",
            series: [],
            changePct: null,
            insufficientHistory: true,
          },
        ],
      },
    ], []);
    assert.equal(report.recommendations[0].area, "estoque");
    assert.equal(report.recommendations[0].confidence, "alta");
  });

  test("sem anúncios, declara o ponto cego em vez de plano vazio", () => {
    const report = think([], []);
    assert.equal(report.recommendations.length, 0);
    assert.equal(report.blindSpots.length, 1);
    assert.match(report.blindSpots[0], /Nenhum anúncio capturado/);
  });

  test("preço com uma só leitura entra em pontos cegos, não em recomendação", () => {
    const report = think([
      {
        entityRef: "MLB1",
        title: "x",
        priceCents: 1000,
        stock: 10,
        metrics: [
          {
            metric: "price_cents",
            latest: 1000,
            latestQuality: "VERIFIED",
            latestAt: "2026-11-21T10:00:00.000Z",
            series: [],
            changePct: null,
            insufficientHistory: true,
          },
        ],
      },
    ], []);
    assert.equal(report.recommendations.length, 0);
    assert.ok(report.blindSpots.some((b) => /histórico/.test(b)));
  });

  test("é determinístico: mesmo dado, mesmo relatório", () => {
    const listings = [
      {
        entityRef: "MLB1",
        title: "x",
        priceCents: 1000,
        stock: 0,
        metrics: [
          {
            metric: "stock" as const,
            latest: 0,
            latestQuality: "VERIFIED",
            latestAt: "2026-11-21T10:00:00.000Z",
            series: [],
            changePct: null,
            insufficientHistory: true,
          },
        ],
      },
    ];
    const fixed = new Date("2026-11-21T15:00:00.000Z");
    assert.deepEqual(think(listings, [], fixed), think(listings, [], fixed));
  });
});

describe("auditoria encadeada", () => {
  test("cadeia válida verifica ok", () => {
    const db = new LocalDatabase({ path: ":memory:" });
    const audit = new AuditService(db);
    audit.append("coleta", { run: 1 });
    audit.append("coleta", { run: 2 });
    audit.append("pareamento", { ok: true });
    const result = audit.verify();
    assert.equal(result.ok, true);
    assert.equal(result.total, 3);
    db.close();
  });

  test("adulterar uma entrada quebra a cadeia e aponta o seq", () => {
    const db = new LocalDatabase({ path: ":memory:" });
    const audit = new AuditService(db);
    audit.append("coleta", { run: 1 });
    audit.append("coleta", { run: 2 });
    db.raw().prepare("UPDATE audit_log SET detail = ? WHERE seq = 1").run('{"kind":"falso","detail":{}}');
    const result = audit.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAtSeq, 1);
    db.close();
  });
});

describe("AnalyticsService integrado ao banco", () => {
  test("listagem reflete o que foi gravado, com título legível", () => {
    const db = new LocalDatabase({ path: ":memory:" });
    const repo = new CollectionRepository(db);
    const runId = repo.startRun({
      marketplace: "mercadolivre",
      accountId: null,
      pageKind: "listing-list",
      pageUrl: "https://x",
      startedAt: "2026-11-21T10:00:00.000Z",
    });
    const provenance = {
      source: "dom",
      marketplace: "mercadolivre",
      accountRef: null,
      pageKind: "listing-list",
      pageUrl: "https://x",
      referenceDate: "2026-11-21T10:00:00.000Z",
      collectedAt: "2026-11-21T10:00:00.000Z",
      method: "m",
      adapterVersion: "0.1.0",
    };
    repo.record(runId, provenance, {
      entityType: "listing",
      entityRef: "MLB777",
      metric: "title",
      valueRaw: "Fone Bluetooth",
      valueNum: null,
      unit: null,
      quality: "VERIFIED",
    });
    repo.record(runId, provenance, {
      entityType: "listing",
      entityRef: "MLB777",
      metric: "stock",
      valueRaw: "5",
      valueNum: 5,
      unit: "count",
      quality: "VERIFIED",
    });

    const analytics = new AnalyticsService(db);
    const list = analytics.listings();
    assert.equal(list.length, 1);
    assert.equal(list[0].entityRef, "MLB777");
    assert.equal(list[0].title, "Fone Bluetooth");
    assert.equal(list[0].stock, 5);
    assert.deepEqual(analytics.qualityCensus(), { VERIFIED: 2 });
    assert.equal(analytics.recentRuns().length, 1);
    db.close();
  });
});
