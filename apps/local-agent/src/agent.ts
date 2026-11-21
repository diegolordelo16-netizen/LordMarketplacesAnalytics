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
import { parseListingList } from "./adapters/mercadolivre/listings.js";
import { JSDOM } from "jsdom";

export const AGENT_VERSION = "0.1.0";

export interface AgentContext {
  db: LocalDatabase;
  repo: CollectionRepository;
  analytics: AnalyticsService;
  audit: AuditService;
  gemini: GeminiAuditor;
  improvements: ImprovementService;
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
  return {
    db,
    repo: new CollectionRepository(db),
    analytics: new AnalyticsService(db),
    audit,
    gemini: new GeminiAuditor(db, configFromEnv(env)),
    improvements,
    ownerId,
  };
}

/** Registra todos os handlers do protocolo no servidor. */
export function registerHandlers(server: LocalAgentServer, ctx: AgentContext): void {
  const { db, repo, analytics, audit, gemini, improvements } = ctx;

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
  server.handle("capture.page", (envelope) => {
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
    if (payload.marketplace !== "mercadolivre") {
      throw new BusinessError("ADAPTER_UNAVAILABLE", `marketplace sem adapter implementado: ${payload.marketplace}`);
    }
    if (payload.pageKind !== "listing-list") {
      throw new BusinessError("PAGE_NOT_RECOGNIZED", `tipo de página sem adapter implementado: ${payload.pageKind}`);
    }

    const startedAt = new Date().toISOString();
    const runId = repo.startRun({
      marketplace: payload.marketplace,
      accountId: null,
      pageKind: payload.pageKind,
      pageUrl: payload.pageUrl,
      startedAt,
    });

    const doc = new JSDOM(payload.html).window.document;
    const parsed = parseListingList(doc);

    const provenance = {
      source: "dom",
      marketplace: payload.marketplace,
      accountRef: payload.accountRef ?? null,
      pageKind: payload.pageKind,
      pageUrl: payload.pageUrl,
      referenceDate: startedAt,
      collectedAt: startedAt,
      method: "adapter.mercadolivre.listing-list.dom-v1",
      adapterVersion: "0.1.0",
    };

    let written = 0;
    for (const listing of parsed.listings) {
      for (const obs of listing.observations) {
        repo.record(runId, provenance, obs);
        written += 1;
      }
    }

    // Se a página tinha cards mas nenhum foi lido, isso é falha de adapter, não sucesso vazio.
    const outcome = parsed.cardsParsed > 0 ? "COMPLETED" : parsed.cardsSeen > 0 ? "PARTIAL" : "COMPLETED";
    const reason = parsed.cardsSeen > 0 && parsed.cardsParsed === 0 ? "cards encontrados, nenhum legível" : undefined;
    repo.finishRun(runId, outcome, new Date().toISOString(), reason);
    audit.append("capture", { runId, marketplace: payload.marketplace, written, outcome });

    return {
      runId,
      outcome,
      cardsSeen: parsed.cardsSeen,
      cardsParsed: parsed.cardsParsed,
      observationsWritten: written,
      // Deixa claro na resposta: nada foi "estimado".
      note:
        parsed.cardsSeen === 0
          ? "Nenhum anúncio reconhecido nesta página. Confirme que está na lista de anúncios do vendedor."
          : undefined,
    };
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
