/**
 * Montagem do serviço local: banco, serviços de negócio e handlers do canal.
 *
 * Este arquivo é o "cérebro ligado no corpo": cada handler é uma ação que a
 * extensão pode chamar, e cada uma devolve dado real ou um erro explícito.
 * Nenhum handler inventa valor para parecer completo.
 */
import { DEFAULT_PORT, LocalAgentServer } from "./loopback-server.js";
import type { ErrorCode } from "@lma/protocol";

/** Erro de negócio com código do protocolo — nunca vira INTERNAL_ERROR genérico. */
class BusinessError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}
import { LocalDatabase } from "./database/db.js";
import { CollectionRepository } from "./database/collection-repository.js";
import { AnalyticsService, AuditService, computeAlerts } from "./services/analytics.js";
import { buildAuditPrompt, think } from "./services/brain.js";
import { GeminiAuditor, configFromEnv } from "./services/gemini.js";
import { ImprovementService } from "./services/improvements.js";
import { CompetitorService, MONITORED_PLATFORMS, parseListingLink, parseManualRef } from "./services/competitors.js";
import { DescriptionEditor, TitleImmutableError, diffLines } from "./services/description-editor.js";
import { FinanceService, MissionService } from "./services/finance.js";
import { buildMissions } from "./services/missions.js";
import { parseListingList } from "./adapters/mercadolivre/listings.js";
import { ORDERS_ADAPTER_VERSION, parseOrderList } from "./adapters/orders.js";
import {
  ApiCredentialService,
  CONNECTORS,
  MissingEncryptionKeyError,
  deriveKey,
} from "./services/api-credentials.js";
import {
  SHOPEE_ADAPTER_VERSION,
  SHOPEE_METHOD,
  parseShopeeProductList,
} from "./adapters/shopee/listings.js";

export const AGENT_VERSION = "0.6.2";

/** Forma comum que todo adapter de captura devolve. */
interface CaptureShape {
  listings: { externalRef: string; observations: import("./database/collection-repository.js").ObservationInput[] }[];
  cardsSeen: number;
  cardsParsed: number;
}

/**
 * Cria um Document a partir de HTML, sem rede e sem carregar recursos.
 * Fica num único ponto para poder ser trocado por um parser mais leve no
 * instalador final sem tocar em nenhuma regra de negócio.
 */
export async function createDocument(html: string): Promise<Document> {
  // Import dinâmico: o jsdom só carrega quando uma captura acontece, então o
  // serviço sobe rápido e o empacotador consegue deixá-lo externo.
  const { JSDOM } = await import("jsdom");
  return new JSDOM(html, { runScripts: "outside-only" }).window.document;
}

export interface AgentContext {
  db: LocalDatabase;
  repo: CollectionRepository;
  analytics: AnalyticsService;
  audit: AuditService;
  gemini: GeminiAuditor;
  improvements: ImprovementService;
  credentials: ApiCredentialService;
  competitors: CompetitorService;
  descriptionEditor: DescriptionEditor;
  finance: FinanceService;
  missions: MissionService;
  ownerId: string;
}

export interface BuildOptions {
  dbPath: string;
  allowedOrigins: string[];
  port?: number;
  env?: NodeJS.ProcessEnv;
}

export function createContext(dbPath: string, env: NodeJS.ProcessEnv = process.env): AgentContext {
  const db = new LocalDatabase({ path: dbPath });
  const improvements = new ImprovementService(db);
  const ownerId = improvements.ensureOwner();
  const audit = new AuditService(db);
  audit.append("startup", { version: AGENT_VERSION });
  // Chave de criptografia das credenciais de API: só existe se o usuário gerou.
  const keyRaw = env.LMA_API_SECRET_KEY?.trim();
  return {
    db,
    repo: new CollectionRepository(db),
    analytics: new AnalyticsService(db),
    audit,
    gemini: new GeminiAuditor(db, configFromEnv(env)),
    improvements,
    credentials: new ApiCredentialService({
      db: db.raw(),
      key: keyRaw ? deriveKey(keyRaw) : null,
      audit,
    }),
    competitors: new CompetitorService(db.raw()),
    descriptionEditor: new DescriptionEditor(db.raw()),
    finance: new FinanceService(db.raw()),
    missions: new MissionService(db.raw()),
    ownerId,
  };
}

/** Registra todos os handlers do protocolo no servidor. */
export function registerHandlers(server: LocalAgentServer, ctx: AgentContext): void {
  const { db, repo, analytics, audit, gemini, improvements, credentials, competitors, descriptionEditor, finance, missions } = ctx;

  // -------------------------------------------------------------- system
  server.handle("system.ping", () => ({ pong: true, serverVersion: AGENT_VERSION }));

  server.handle("system.health", () => ({
    ok: true,
    version: AGENT_VERSION,
    migrations: db.migrations(),
    audit: audit.verify(),
    gemini: { configured: gemini.isConfigured(), remaining: gemini.quotaRemaining() },
    ownerSet: improvements.ownerId() !== null,
  }));

  server.handle("system.identity", () => ({
    ownerId: improvements.ownerId(),
    // A extensão usa isto para saber se pode mostrar aprovações.
    canApprove: true,
  }));

  // ------------------------------------------------------------- capture
  /**
   * Recebe o HTML de uma página já aberta na sessão do usuário e extrai os
   * anúncios. O HTML chega pronto: o serviço não faz requisição a marketplace.
   */
  server.handle("capture.page", async (envelope) => {
    const payload = envelope.payload as {
      marketplace?: string;
      pageKind?: string;
      pageUrl?: string;
      html?: string;
      accountRef?: string | null;
    };

    if (!payload?.html || !payload.pageUrl || !payload.marketplace) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", "payload incompleto: html, pageUrl e marketplace são obrigatórios");
    }
    if (payload.pageKind !== "listing-list") {
      throw new BusinessError("PAGE_NOT_RECOGNIZED", `tipo de página sem adapter implementado: ${payload.pageKind}`);
    }

    // Um adapter por marketplace; nenhum deles faz requisição de rede.
    const adapters: Record<
      string,
      { method: string; version: string; entityType: string; parse: (doc: Document) => CaptureShape }
    > = {
      mercadolivre: {
        method: "adapter.mercadolivre.listing-list.dom-v1",
        version: "0.1.0",
        entityType: "listing",
        parse: (doc) => parseListingList(doc),
      },
      shopee: {
        method: SHOPEE_METHOD,
        version: SHOPEE_ADAPTER_VERSION,
        entityType: "product",
        parse: (doc) => parseShopeeProductList(doc),
      },
    };

    const adapter = adapters[payload.marketplace];
    if (!adapter) {
      throw new BusinessError(
        "ADAPTER_UNAVAILABLE",
        `marketplace sem adapter implementado: ${payload.marketplace}`,
      );
    }

    const startedAt = new Date().toISOString();
    const runId = repo.startRun({
      marketplace: payload.marketplace,
      accountId: null,
      pageKind: payload.pageKind,
      pageUrl: payload.pageUrl,
      startedAt,
    });

    // O HTML chega pronto do content script; o parsing usa um DOM local.
    const doc = await createDocument(payload.html);
    const parsed = adapter.parse(doc);

    const provenance = {
      source: "dom",
      marketplace: payload.marketplace,
      accountRef: payload.accountRef ?? null,
      pageKind: payload.pageKind,
      pageUrl: payload.pageUrl,
      referenceDate: startedAt,
      collectedAt: startedAt,
      method: adapter.method,
      adapterVersion: adapter.version,
    };

    let written = 0;
    for (const item of parsed.listings) {
      for (const obs of item.observations) {
        repo.record(runId, provenance, obs);
        written += 1;
      }
    }

    // Cards vistos e não lidos = falha de adapter, não sucesso vazio.
    const outcome = parsed.cardsParsed > 0 ? "COMPLETED" : parsed.cardsSeen > 0 ? "PARTIAL" : "COMPLETED";
    const reason =
      parsed.cardsSeen > 0 && parsed.cardsParsed === 0 ? "cards encontrados, nenhum legível" : undefined;
    repo.finishRun(runId, outcome, new Date().toISOString(), reason);
    audit.append("capture", { runId, marketplace: payload.marketplace, written, outcome });

    return {
      runId,
      outcome,
      entityType: adapter.entityType,
      cardsSeen: parsed.cardsSeen,
      cardsParsed: parsed.cardsParsed,
      observationsWritten: written,
      note:
        parsed.cardsSeen === 0
          ? "Nenhum item reconhecido nesta página. Confirme que está na lista de produtos do vendedor."
          : undefined,
    };
  });

  /**
   * Captura de pedidos. Diferente da lista de anúncios: aqui cada pedido é uma
   * entidade própria, e o que interessa é o cruzamento posterior com estoque.
   */
  server.handle("capture.orders", async (envelope) => {
    const payload = envelope.payload as {
      marketplace?: string;
      pageUrl?: string;
      html?: string;
      accountRef?: string | null;
    };
    if (!payload?.html || !payload.pageUrl || !payload.marketplace) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", "payload incompleto: html, pageUrl e marketplace são obrigatórios");
    }
    if (!["mercadolivre", "shopee"].includes(payload.marketplace)) {
      throw new BusinessError("ADAPTER_UNAVAILABLE", `pedidos sem adapter para: ${payload.marketplace}`);
    }

    const startedAt = new Date().toISOString();
    const runId = repo.startRun({
      marketplace: payload.marketplace,
      accountId: null,
      pageKind: "orders",
      pageUrl: payload.pageUrl,
      startedAt,
    });

    const parsed = parseOrderList(await createDocument(payload.html), payload.marketplace);
    const provenance = {
      source: "dom",
      marketplace: payload.marketplace,
      accountRef: payload.accountRef ?? null,
      pageKind: "orders",
      pageUrl: payload.pageUrl,
      referenceDate: startedAt,
      collectedAt: startedAt,
      method: `adapter.${payload.marketplace}.orders.dom-v1`,
      adapterVersion: ORDERS_ADAPTER_VERSION,
    };

    let written = 0;
    for (const order of parsed.orders) {
      for (const o of order.observations) {
        repo.record(runId, provenance, o);
        written += 1;
      }
    }

    const outcome = parsed.rowsParsed > 0 ? "COMPLETED" : parsed.rowsSeen > 0 ? "PARTIAL" : "COMPLETED";
    repo.finishRun(
      runId,
      outcome,
      new Date().toISOString(),
      parsed.rowsSeen > 0 && parsed.rowsParsed === 0 ? "linhas com valor, nenhum id legível" : undefined,
    );
    audit.append("capture_orders", { runId, marketplace: payload.marketplace, written, outcome });

    return {
      runId,
      outcome,
      entityType: "order",
      rowsSeen: parsed.rowsSeen,
      rowsParsed: parsed.rowsParsed,
      rowsWithoutId: parsed.rowsWithoutId,
      observationsWritten: written,
      note: parsed.rowsSeen === 0 ? "Nenhum pedido reconhecido nesta página." : undefined,
    };
  });

  /**
   * Cruzamento venda × estoque: a conta que justifica ter capturado pedido.
   * Devolve só o que os dados sustentam; sem histórico, diz que não dá.
   */
  server.handle("kpi.salesStock", () => {
    const rows = db
      .raw()
      .prepare(
        `SELECT entity_ref, metric, value_num, collected_at, marketplace
         FROM data_points WHERE entity_type = 'order' AND metric IN ('order_total_cents','order_date')`,
      )
      .all() as { entity_ref: string; metric: string; value_num: number | null; collected_at: string; marketplace: string }[];

    const orders = new Map<string, { total: number | null; date: string | null; marketplace: string }>();
    for (const r of rows) {
      const current = orders.get(r.entity_ref) ?? { total: null, date: null, marketplace: r.marketplace };
      if (r.metric === "order_total_cents") current.total = r.value_num;
      if (r.metric === "order_date") current.date = r.collected_at;
      orders.set(r.entity_ref, current);
    }

    const withValue = [...orders.values()].filter((o) => o.total !== null);
    const totalCents = withValue.reduce((sum, o) => sum + (o.total ?? 0), 0);
    const byMarketplace: Record<string, { orders: number; totalCents: number }> = {};
    for (const o of withValue) {
      const bucket = (byMarketplace[o.marketplace] ??= { orders: 0, totalCents: 0 });
      bucket.orders += 1;
      bucket.totalCents += o.total ?? 0;
    }

    const stockRows = db
      .raw()
      .prepare(
        `SELECT entity_ref, value_num FROM data_points
         WHERE metric = 'stock' AND collected_at = (
           SELECT MAX(collected_at) FROM data_points d2
           WHERE d2.entity_ref = data_points.entity_ref AND d2.metric = 'stock'
         )`,
      )
      .all() as { entity_ref: string; value_num: number | null }[];
    const stockKnown = stockRows.filter((s) => s.value_num !== null).length;

    return {
      ordersCaptured: orders.size,
      ordersWithValue: withValue.length,
      totalCents,
      byMarketplace,
      stockKnown,
      // Honestidade: sem estoque lido não há cobertura de vendas.
      note:
        orders.size === 0
          ? "Nenhum pedido capturado ainda: capture a página de pedidos para ter este número."
          : stockKnown === 0
            ? "Há pedidos, mas nenhum estoque legível: a cobertura de vendas não pode ser calculada."
            : undefined,
    };
  });

  // ------------------------------------------------------------------ api
  // Credenciais de API dos marketplaces: OPCIONAIS. O produto funciona
  // inteiro sem elas (captura pela sessão do navegador). O que entra aqui é
  // acréscimo de dado oficial — e nunca sai segredo na resposta.
  server.handle("api.catalog", () => ({
    connectors: CONNECTORS,
    encryptionAvailable: credentials.encryptionAvailable,
    note:
      "API é opcional: o produto analisa pelo site logado no navegador. " +
      "Configurar credencial só melhora a qualidade do dado (pedido confirmado pelo marketplace).",
  }));

  server.handle("api.list", () => ({
    credentials: credentials.list(),
    encryptionAvailable: credentials.encryptionAvailable,
  }));

  server.handle("api.save", (envelope) => {
    const p = envelope.payload as {
      marketplace?: string;
      accountRef?: string | null;
      label?: string;
      publicFields?: Record<string, string>;
      secret?: string;
      scopes?: string[];
    };
    if (!p?.marketplace || !p.label || !p.secret) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", "marketplace, label e secret são obrigatórios");
    }
    try {
      const saved = credentials.save({
        marketplace: p.marketplace as never,
        accountRef: p.accountRef ?? null,
        label: p.label,
        publicFields: p.publicFields ?? {},
        secret: p.secret,
        scopes: p.scopes ?? [],
      });
      return { credential: saved };
    } catch (err) {
      if (err instanceof MissingEncryptionKeyError) {
        throw new BusinessError("ENCRYPTION_KEY_MISSING", err.message);
      }
      throw err;
    }
  });

  server.handle("api.remove", (envelope) => {
    const p = envelope.payload as { id?: string };
    if (!p?.id) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "id é obrigatório");
    if (!credentials.remove(p.id)) throw new BusinessError("CREDENTIAL_NOT_FOUND", "credencial não encontrada");
    return { removed: true };
  });

  server.handle("capture.runs", (envelope) => {
    const limit = (envelope.payload as { limit?: number })?.limit ?? 20;
    return { runs: analytics.recentRuns(limit) };
  });

  // ------------------------------------------------------------ analytics
  server.handle("kpi.listings", (envelope) => {
    const limit = (envelope.payload as { limit?: number })?.limit ?? 100;
    const listings = analytics.listings(limit);
    return {
      listings,
      qualityCensus: analytics.qualityCensus(),
      alerts: computeAlerts(listings),
    };
  });

  server.handle("kpi.series", (envelope) => {
    const p = envelope.payload as { entityType?: string; entityRef?: string; metric?: string };
    if (!p?.entityType || !p.entityRef || !p.metric) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", "entityType, entityRef e metric são obrigatórios");
    }
    return { rows: analytics.seriesFor(p.entityType, p.entityRef, p.metric) };
  });

  // ---------------------------------------------------------------- brain
  server.handle("agent.report", () => {
    const listings = analytics.listings();
    const alerts = computeAlerts(listings);
    return think(listings, alerts);
  });

  server.handle("agent.audit", async () => {
    const listings = analytics.listings();
    const report = think(listings, computeAlerts(listings));
    const result = await gemini.ask(buildAuditPrompt(report), "audit");
    return {
      ...result,
      // Nunca esconde por que não houve auditoria.
      message: result.ok
        ? "Revisão do auditor externo."
        : `Auditoria externa indisponível: ${result.detail ?? result.reason}`,
    };
  });

  server.handle("gemini.grantExtra", (envelope) => {
    const quantity = (envelope.payload as { quantity?: number })?.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", "quantity deve ser inteiro entre 1 e 20");
    }
    gemini.grantExtra(quantity);
    return { granted: quantity, remaining: gemini.quotaRemaining() };
  });

  // --------------------------------------------------------- improvements
  server.handle("improvement.propose", (envelope) => {
    const p = envelope.payload as {
      title?: string;
      rationale?: string;
      kind?: string;
      payload?: Record<string, unknown>;
    };
    const imp = improvements.propose({
      title: p.title ?? "",
      rationale: p.rationale ?? "",
      kind: (p.kind ?? "rule") as never,
      payload: p.payload ?? {},
    });
    audit.append("improvement_proposed", { id: imp.id, kind: imp.kind });
    return imp;
  });

  server.handle("improvement.list", (envelope) => {
    const status = (envelope.payload as { status?: string })?.status as never;
    return { items: improvements.list(status) };
  });

  server.handle("improvement.decide", (envelope) => {
    const p = envelope.payload as { id?: string; decision?: string; actorId?: string; note?: string };
    if (!p?.id) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "id é obrigatório");
    // A checagem de dono acontece no serviço; aqui só repassamos o ator alegado.
    const result =
      p.decision === "APPROVED"
        ? improvements.approve(p.id, p.actorId ?? null, p.note)
        : improvements.reject(p.id, p.actorId ?? null, p.note);
    audit.append("improvement_decided", { id: p.id, decision: result.status, actorId: p.actorId });
    return result;
  });

  // ------------------------------------------------------- concorrentes
  // Cadastro por link: o serviço identifica o marketplace sozinho e devolve o
  // que sabe do link. Nenhuma chamada ao marketplace acontece aqui.
  server.handle("competitor.parseLink", (envelope) => {
    const p = envelope.payload as { url?: string };
    try {
      return { parsed: parseListingLink(p?.url ?? "") };
    } catch (err) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", err instanceof Error ? err.message : "link inválido");
    }
  });

  // Lista de plataformas para a tela de concorrentes. `readable` é honesto:
  // só quem tem leitor de página testado aparece com true.
  server.handle("competitor.platforms", () => ({
    platforms: MONITORED_PLATFORMS.map((p) => ({ id: p.id, label: p.label, readable: p.readable })),
  }));

  server.handle("competitor.add", (envelope) => {
    const p = envelope.payload as {
      url?: string;
      notes?: string;
      linkedEntityRef?: string;
      marketplace?: string;
      externalRef?: string;
    };
    try {
      // Duas portas de entrada: link colado (o serviço identifica a plataforma)
      // ou plataforma escolhida na tela com o código do anúncio.
      const target =
        p?.url && p.url.trim()
          ? parseListingLink(p.url)
          : parseManualRef(p?.marketplace ?? "", p?.externalRef ?? "");
      const competitor = competitors.add(target.url || `${target.marketplace}:${target.externalRef}`, {
        notes: p?.notes ?? null,
        linkedEntityRef: p?.linkedEntityRef ?? null,
        parsed: target,
      });
      audit.append("competitor_added", { id: competitor.id, marketplace: competitor.marketplace });
      return { competitor };
    } catch (err) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", err instanceof Error ? err.message : "não foi possível cadastrar");
    }
  });

  server.handle("competitor.list", (envelope) => {
    const p = envelope.payload as { marketplace?: string; status?: string } | undefined;
    return { competitors: competitors.list({ marketplace: p?.marketplace, status: p?.status as never }) };
  });

  server.handle("competitor.detail", (envelope) => {
    const p = envelope.payload as { id?: string };
    const competitor = competitors.get(p?.id ?? "");
    if (!competitor) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "concorrente não encontrado");
    return {
      competitor,
      history: competitors.snapshots(competitor.id, 90),
      events: competitors.events(200).filter((e) => e.competitorId === competitor.id),
    };
  });

  // A coleta chega do navegador do usuário (a página que ele já tem aberta).
  server.handle("competitor.collect", (envelope) => {
    const p = envelope.payload as { id?: string; html?: string; pageUrl?: string; method?: string };
    if (!p?.html) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "sem conteúdo de página não há coleta");
    try {
      const result = competitors.recordSnapshot(p.id ?? "", {
        html: p.html,
        pageUrl: p.pageUrl ?? "",
        method: p.method,
      });
      audit.append("competitor_collected", { id: p.id, quality: result.snapshot.quality });
      return result;
    } catch (err) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", err instanceof Error ? err.message : "coleta recusada");
    }
  });

  server.handle("competitor.status", (envelope) => {
    const p = envelope.payload as { id?: string; status?: string };
    const ok = competitors.setStatus(p?.id ?? "", (p?.status ?? "PAUSED") as never);
    if (!ok) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "concorrente não encontrado");
    return { ok };
  });

  server.handle("competitor.link", (envelope) => {
    const p = envelope.payload as { id?: string; entityRef?: string | null };
    const ok = competitors.link(p?.id ?? "", p?.entityRef ?? null);
    if (!ok) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "concorrente não encontrado");
    return { ok };
  });

  server.handle("competitor.events", (envelope) => {
    const p = envelope.payload as { limit?: number } | undefined;
    return { events: competitors.events(p?.limit ?? 40) };
  });

  // ------------------------------------------------- edição de descrição
  // O título entra só como referência do original. Ele nunca é alterado: a
  // proposta não tem campo de título, e o serviço recusa qualquer mudança.
  server.handle("edit.propose", (envelope) => {
    const p = envelope.payload as {
      marketplace?: string;
      entityRef?: string;
      title?: string;
      description?: string;
      knownFacts?: Record<string, string>;
    };
    if (!p?.entityRef) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "informe o anúncio");
    const listing = analytics.listings(500).find((l) => l.entityRef === p.entityRef);
    const title = p.title ?? listing?.title ?? "";
    try {
      const proposal = descriptionEditor.propose({
        marketplace: p.marketplace ?? "mercadolivre",
        entityRef: p.entityRef,
        title,
        description: p.description ?? "",
        knownFacts: p.knownFacts,
      });
      return { proposal, diff: diffLines(proposal.descriptionBefore, proposal.descriptionAfter) };
    } catch (err) {
      if (err instanceof TitleImmutableError) throw new BusinessError("SCHEMA_VALIDATION_FAILED", err.message);
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", err instanceof Error ? err.message : "não foi possível gerar");
    }
  });

  server.handle("edit.list", (envelope) => {
    const p = envelope.payload as { limit?: number } | undefined;
    return { proposals: descriptionEditor.list(p?.limit ?? 30) };
  });

  server.handle("edit.decide", (envelope) => {
    const p = envelope.payload as { id?: string; status?: string; note?: string };
    try {
      const proposal = descriptionEditor.decide(p?.id ?? "", (p?.status ?? "APPROVED") as never, p?.note ?? null);
      audit.append("description_edit_decided", { id: proposal.id, status: proposal.status });
      return { proposal };
    } catch (err) {
      throw new BusinessError("SCHEMA_VALIDATION_FAILED", err instanceof Error ? err.message : "decisão recusada");
    }
  });

  // ------------------------------------------------------------ financeiro
  server.handle("finance.saveCost", (envelope) => {
    const p = envelope.payload as {
      entityRef?: string;
      costCents?: number | null;
      commissionBp?: number | null;
      taxBp?: number | null;
      fixedFeeCents?: number | null;
      freightCents?: number | null;
      packagingCents?: number | null;
      minMarginBp?: number | null;
    };
    if (!p?.entityRef) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "informe o anúncio ou SKU");
    const saved = finance.saveCost({ ...p, entityRef: p.entityRef, costCents: p.costCents ?? null });
    audit.append("sku_cost_saved", { entityRef: p.entityRef });
    return saved;
  });

  server.handle("finance.margin", (envelope) => {
    const p = envelope.payload as { entityRef?: string; priceCents?: number };
    if (!p?.entityRef) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "informe o anúncio ou SKU");
    const listing = analytics.listings(500).find((l) => l.entityRef === p.entityRef);
    const price = p.priceCents ?? listing?.priceCents ?? null;
    if (price === null) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "sem preço coletado para este anúncio");
    return { margin: finance.margin(p.entityRef, price), scenarios: finance.scenarios(p.entityRef, price) };
  });

  // -------------------------------------------------------- missões do dia
  server.handle("missions.generate", () => {
    const built = buildMissions(analytics.listings(500), finance);
    return { missions: missions.replaceForToday(built) };
  });

  server.handle("missions.today", () => ({ missions: missions.today() }));

  server.handle("missions.decide", (envelope) => {
    const p = envelope.payload as { id?: string; status?: string };
    const ok = missions.decide(p?.id ?? "", (p?.status ?? "DONE") as never);
    if (!ok) throw new BusinessError("SCHEMA_VALIDATION_FAILED", "missão não encontrada");
    return { ok };
  });

  // -------------------------------------------------- visão consolidada
  // Uma chamada só para o dashboard pintar tudo: KPIs, séries, missões,
  // concorrentes e alertas. Sem isso o painel faria seis idas ao serviço.
  server.handle("kpi.overview", () => {
    const listings = analytics.listings(500);
    const monitored = competitors.list();
    const today = missions.today();

    // Série de faturamento por dia: só dias que têm coleta, nada interpolado.
    const byDay = db
      .raw()
      .prepare(
        `SELECT substr(collected_at, 1, 10) AS day, SUM(value_num) AS total
         FROM data_points
         WHERE metric = 'revenue_cents' AND value_num IS NOT NULL
         GROUP BY day ORDER BY day ASC LIMIT 90`,
      )
      .all() as { day: string; total: number }[];

    const quality: Record<string, number> = {};
    for (const row of db
      .raw()
      .prepare(`SELECT quality, COUNT(*) AS n FROM data_points GROUP BY quality`)
      .all() as { quality: string; n: number }[]) {
      quality[row.quality] = row.n;
    }

    const marketplaces: Record<string, number> = {};
    for (const row of db
      .raw()
      .prepare(`SELECT marketplace, COUNT(*) AS n FROM data_points GROUP BY marketplace`)
      .all() as { marketplace: string; n: number }[]) {
      marketplaces[row.marketplace] = row.n;
    }

    const withPrice = listings.filter((l) => l.priceCents !== null);
    const totalStock = listings.reduce((acc, l) => acc + (l.stock ?? 0), 0);
    const margins = withPrice
      .map((l) => finance.margin(l.entityRef, l.priceCents as number))
      .filter((m) => m.contributionCents !== null);

    return {
      totals: {
        listings: listings.length,
        withPrice: withPrice.length,
        stockUnits: totalStock,
        competitors: monitored.length,
        missions: today.length,
        marginKnown: margins.length,
        marginAvgBp:
          margins.length > 0
            ? Math.round(margins.reduce((a, m) => a + (m.marginBp ?? 0), 0) / margins.length)
            : null,
      },
      revenueSeries: byDay.map((d) => ({ day: d.day, cents: Number(d.total) })),
      quality,
      marketplaces,
      missions: today,
      competitors: monitored.slice(0, 20),
      alerts: computeAlerts(listings),
    };
  });
}

export async function startAgent(options: BuildOptions) {
  const ctx = createContext(options.dbPath, options.env);
  const server = new LocalAgentServer({
    port: options.port ?? DEFAULT_PORT,
    allowedOrigins: options.allowedOrigins,
  });
  registerHandlers(server, ctx);
  const address = await server.start();
  return { server, ctx, ...address };
}
