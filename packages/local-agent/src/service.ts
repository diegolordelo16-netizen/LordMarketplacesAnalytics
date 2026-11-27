/**
 * Serviço local: registro de métodos IPC, autenticação/perfis, auditoria e ciclo de vida.
 * Exposto por Named Pipe no Windows (host nativo) e por HTTP local no painel do desktop.
 */
import { parseCsvText, parseXlsxBase64 } from './importers/tabular';
import { parsePdfBase64 } from './importers/pdf';
import { googleAdsTerm } from './connectors/dataforseo';
import { googleReadTarget, verifyGoogleRead } from './connectors/google';
import { seoResearchInput } from './connectors/openseo';
import { ExternalSeoWorkspace, correlateSeoListings } from './competitive/external-seo';
import { customerInsights, compareCatalogText } from './competitive/customer-insights';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  captureIngestSchema,
  evaluateQualityGate,
  ipcRequestSchema,
  protocolCompatible,
  PROTOCOL_VERSION,
  roleHasPermission,
  simulateScenario,
  buildDailyMissions,
  computePriority,
  type AccessRole,
  type IpcRequest,
  type IpcResponse,
  type Permission,
  type ListingPeriodInput,
} from '@mi/shared';
import type { LocalDatabase } from './db/database';
import type { TaskScheduler } from './scheduler/task-scheduler';
import { firstOccurrence, nextOccurrence, retryDecision, type ScheduleCadence } from './scheduler/cadence';
import { SecretStore, hashPassword, sha256, verifyPassword } from './security/secrets';
import type { GeminiClient } from './ai/gemini-client';
import type { KnowledgeBase } from './ai/knowledge-base';
import type { AutoUpgradeEngine } from './ai/auto-upgrade';
import type { CaptureService } from './capture/capture-service';
import { CompetitorService } from './competitive/competitor-service';
import { MercadoLivreVariations, legacyVariationOption, legacyStockOption, upOfferOption } from './adapters/mercado-livre-variations';
import { IMPLEMENTED_ADAPTERS, PLANNED_ADAPTERS } from './adapters';
import { evaluateGuard, type GuardContext } from './guard/automation-guard';
import { AGENT_KEYS, runAgents, synthesize, type AgentContext, type AgentKey } from './ai/agents';

const nowIso = () => new Date().toISOString();
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}


export interface ServiceDeps {
  db: LocalDatabase;
  secrets: SecretStore;
  tasks: TaskScheduler;
  gemini: GeminiClient;
  knowledge: KnowledgeBase;
  autoUpgrade: AutoUpgradeEngine;
  capture: CaptureService;
  version: string;
}

export interface AuthContext {
  userId: string;
  role: AccessRole;
}

type Handler = (payload: unknown, auth: AuthContext | null) => unknown | Promise<unknown>;

/**
 * Todo método protegido precisa declarar uma permissão. Ausência de regra não
 * significa acesso livre: o dispatcher nega por padrão.
 */
const METHOD_PERMISSION: Record<string, Permission> = {
  'settings.get': 'view_reports',
  'settings.set': 'manage_financial_limits',
  'gemini.setKey': 'manage_gemini_key',
  'gemini.testKey': 'manage_gemini_key',
  'account.upsert': 'manage_accounts',
  'account.list': 'view_reports',
  'account.setActive': 'manage_accounts',
  'user.list': 'manage_users',
  'user.upsert': 'manage_users',
  'user.setActive': 'manage_users',
  'catalog.product.upsert': 'manage_accounts',
  'catalog.product.list': 'view_reports',
  'catalog.sku.upsert': 'manage_accounts',
  'catalog.sku.list': 'view_reports',
  'media.list': 'view_reports',
  'media.get': 'view_reports',
  'media.add': 'manage_accounts',
  'media.delete': 'manage_accounts',
  'capture.ingest': 'execute_task',
  'capture.snapshot': 'view_reports',
  'capture.accountSnapshots': 'view_reports',
  'capture.details':'view_reports',
  'capture.chartPoints':'view_reports',
  'navigation.observe': 'execute_task',
  'navigation.list': 'execute_task',
  'navigation.graph': 'execute_task',
  'navigation.summary': 'view_reports',
  'navigation.clear': 'execute_task',
  'kpi.listing': 'view_reports',
  'kpi.dashboard': 'view_reports',
  'kpi.history': 'view_reports',
  'kpi.compare': 'view_reports',
  'kpi.compare.detail': 'view_reports',
  'analysis.run': 'use_gemini_workspace',
  'missions.today': 'view_reports',
  'finance.simulate': 'view_reports',
  'finance.bundle.simulate': 'view_reports',
  'finance.costs.upsert': 'manage_financial_limits',
  'task.create': 'execute_task',
  'task.createByFilter': 'execute_task',
  'task.list': 'view_reports',
  'task.pause': 'execute_task',
  'task.resume': 'execute_task',
  'task.cancel': 'execute_task',
  'task.skipItem': 'execute_task',
  'task.runNow': 'execute_task',
  'task.claimNext': 'execute_task',
  'task.itemResult': 'execute_task',
  'task.recoverDraft': 'execute_task',
  'task.approvePublish': 'manage_accounts',
  'task.claimNextPublish': 'manage_accounts',
  'task.publishResult': 'manage_accounts',
  'task.rollbackPrepare': 'execute_task',
  'guard.evaluate': 'execute_task',
  'audit.list': 'manage_backups',
  'audit.rollback': 'manage_backups',
  'adapter.diagnostics': 'view_reports',
  'keyword.upsert': 'manage_market_intelligence',
  'seo.external.research': 'manage_connectors',
  'seo.config.status': 'view_reports',
  'seo.config.save': 'manage_connectors',
  'seo.config.clear': 'manage_connectors',
  'seo.external.volume': 'manage_connectors',
  'seo.external.history': 'view_reports',
  'seo.external.get': 'view_reports',
  'seo.external.gap': 'view_reports',
  'seo.external.groups': 'view_reports',
  'seo.external.opportunities': 'view_reports',
  'seo.watch.create': 'manage_connectors',
  'seo.watch.list': 'view_reports',
  'seo.watch.disable': 'manage_connectors',
  'seo.watch.history': 'view_reports',
  'keyword.list': 'view_reports',
  'keyword.gap': 'view_reports',
  'keyword.suggest': 'view_reports',
  'keyword.googleVolume': 'manage_connectors',
  'keyword.cluster': 'manage_market_intelligence',
  'keyword.visibility': 'view_reports',
  'keyword.cannibalization': 'view_reports',
  'rank.record': 'manage_market_intelligence',
  'rank.history': 'view_reports',
  'competitor.upsert': 'manage_competitors',
  'competitor.list': 'view_reports',
  'competitor.timeline': 'view_reports',
  'competitor.alerts': 'view_reports',
  'competitor.ownProduct.upsert': 'manage_competitors',
  'competitor.ownProduct.list': 'view_reports',
  'competitor.search': 'manage_competitors',
  'competitor.searchPlan': 'view_reports',
  'competitor.capturePublicSearch': 'manage_competitors',
  'competitor.relations': 'view_reports',
  'competitor.approve': 'manage_competitors',
  'competitor.reject': 'manage_competitors',
  'competitor.edit': 'manage_competitors',
  'competitor.changeCandidate': 'manage_competitors',
  'competitor.reanalyze': 'manage_competitors',
  'competitor.monitoring.set': 'manage_competitors',
  'competitor.monitoring.record': 'manage_competitors',
  'competitor.monitoring.history': 'view_reports',
  'competitor.stats': 'view_reports',
  'market.categorySnapshot': 'manage_market_intelligence',
  'market.opportunities': 'view_reports',
  'voc.ingest': 'manage_market_intelligence',
  'voc.topics': 'view_reports',
  'growth.initiatives': 'view_reports',
  'growth.initiative.upsert': 'manage_market_intelligence',
  'growth.initiative.setStatus': 'manage_market_intelligence',
  'growth.metricTree': 'view_reports',
  'experiment.create': 'manage_experiments',
  'experiment.list': 'view_reports',
  'experiment.result': 'view_reports',
  'agent.run': 'use_gemini_workspace',
  'agent.runs': 'view_reports',
  'agent.recommendations': 'view_reports',
  'agent.feedback': 'use_gemini_workspace',
  'agent.debate': 'use_gemini_workspace',
  'agent.memory': 'use_gemini_workspace',
  'agent.budget': 'view_reports',
  'autoupgrade.propose': 'approve_auto_upgrade',
  'autoupgrade.list': 'view_reports',
  'autoupgrade.apply': 'approve_auto_upgrade',
  'autoupgrade.rollback': 'approve_auto_upgrade',
  'connector.registry': 'view_reports',
  'connector.setEnabled': 'manage_connectors',
  'connector.disconnect': 'manage_connectors',
  'connector.import': 'manage_connectors',
  'connector.import.list': 'view_reports',
  'connector.import.get': 'view_reports',
  'connector.import.commit': 'manage_connectors',
  'forecast.run': 'execute_task',
  'alerts.list': 'view_reports',
  'alerts.ack': 'manage_alerts',
  'report.export': 'view_reports',
  'sync.createAll': 'execute_task',
  'sync.list': 'view_reports',
  'sync.retryFailed': 'execute_task',
  'sync.completeAccount': 'execute_task',
  'sync.accountProgress': 'execute_task',
  'sync.claimAccount': 'execute_task',
  'sync.schedule.create': 'execute_task',
  'sync.schedule.list': 'view_reports',
  'sync.schedule.setEnabled': 'execute_task',
  'sync.schedule.runs': 'view_reports',
  'sync.claimScheduled': 'execute_task',
  'sync.claimBrowserRequest': 'execute_task',
  'voc.ingestBatch': 'manage_market_intelligence',
  'voc.items': 'view_reports',
  'voc.overview': 'view_reports',
  'voc.insights': 'view_reports',
  'finance.realized.upsert': 'manage_financial_limits',
  'finance.realized.list': 'view_reports',
  'listing.change.prepare': 'manage_market_intelligence',
  'listing.change.list': 'view_reports',
  'listing.change.review': 'manage_accounts',
  'operation.receipt.record': 'manage_accounts',
  'operation.receipt.list': 'view_reports',
  'operation.receipt.verify': 'manage_accounts',
  'operation.measure': 'view_reports',
  'offer.variation.update': 'manage_market_intelligence',
  'offer.variation.delete': 'manage_market_intelligence',
  'finance.profitability': 'view_reports',
  'inventory.dashboard': 'view_reports',
  'ads.dashboard': 'view_reports',
  'ads.reconcile': 'manage_accounts',
  'finance.realized.summary': 'view_reports',
  'competitor.evidence.record': 'manage_competitors',
  'competitor.evidence.compare': 'view_reports',
  'campaign.change.prepare': 'manage_market_intelligence',
  'campaign.change.list': 'view_reports',
  'campaign.change.review': 'manage_accounts',
  'campaign.budget.claim': 'manage_accounts',
  'campaign.budget.result': 'manage_accounts',
  'campaign.budget.verify': 'manage_accounts',
  'campaign.budget.list': 'view_reports',
  'operation.limits.get': 'view_reports',
  'operation.limits.set': 'manage_financial_limits',
  'listing.browser.claim': 'manage_accounts',
  'listing.browser.result': 'manage_accounts',
  'listing.browser.verify': 'manage_accounts',
  'listing.browser.list': 'view_reports',
  'variation.api.create': 'manage_accounts',
  'variation.api.remove': 'manage_accounts',
  'variation.api.editStock': 'manage_accounts',
  'variation.api.createUpOffer': 'manage_accounts',
  'variation.api.verify': 'manage_accounts',
  'variation.api.list': 'view_reports',
  'offer.variation.prepare': 'manage_market_intelligence',
  'offer.variation.list': 'view_reports',
  'offer.variation.review': 'manage_accounts',
  'operation.mode.get': 'view_reports',
  'operation.mode.set': 'manage_accounts',
  'analysis.schedule.create': 'use_gemini_workspace',
  'analysis.schedule.list': 'view_reports',
  'analysis.schedule.setEnabled': 'use_gemini_workspace',
  'analysis.schedule.runs': 'view_reports',
  'report.schedule.create': 'view_reports',
  'report.schedule.list': 'view_reports',
  'report.schedule.setEnabled': 'view_reports',
  'report.schedule.runs': 'view_reports',
  'report.schedule.run.get': 'view_reports',
  'connector.configure': 'manage_connectors',
  'connector.test': 'manage_connectors',
  'task.verifySaved': 'execute_task',
  'task.rollbackPlan': 'execute_task',
  'backup.create': 'manage_backups',
  'backup.list': 'manage_backups',
  'backup.restore': 'manage_backups',
};

/** Métodos liberados sem sessão (apenas os necessários para o primeiro acesso). */
const PUBLIC_METHODS = new Set(['ping', 'auth.login', 'auth.bootstrap', 'auth.session']);
/** Logout exige sessão válida, mas não uma permissão de negócio específica. */
const SESSION_ONLY_METHODS = new Set(['auth.logout']);

export class LocalService {
  private readonly handlers = new Map<string, Handler>();

  private readonly competitors: CompetitorService;

  private scheduledWorkRunning = false;
  private readonly externalSeo:ExternalSeoWorkspace;

  constructor(private readonly deps: ServiceDeps) {
    this.competitors = new CompetitorService(deps.db);
    this.externalSeo=new ExternalSeoWorkspace(this.deps.db,this.deps.secrets);
    this.registerAll();
  }

  private register(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  private audit(auth: AuthContext | null, action: string, entity: string, entityId: string | null, result: string, reason?: string, after?: unknown): void {
    this.deps.db.db
      .prepare(
        'INSERT INTO audit_log (at, actor_user_id, actor_role, action, entity, entity_id, result, reason, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        new Date().toISOString(),
        auth?.userId ?? null,
        auth?.role ?? null,
        action,
        entity,
        entityId,
        result,
        reason ?? null,
        after ? JSON.stringify(after) : null,
      );
  }

  /** Executa no máximo cinco trabalhos vencidos por ciclo; nunca publica alterações. */
  async processScheduledWork(): Promise<{ analyses: number; reports: number; syncs: number; errors: string[] }> {
    if (this.scheduledWorkRunning) return { analyses: 0, reports: 0, syncs: 0, errors: ['ciclo de agendamento já está em execução'] };
    this.scheduledWorkRunning = true;
    try {
      const { db } = this.deps;
      const errors: string[] = [];
      let analyses = 0;
      let reports = 0;
      let syncs = 0;
      const now = nowIso();
      const dueAnalyses = db.rows<{
        id: string; account_id: string | null; mode: string; days: number;
        cadence: ScheduleCadence; next_run_at: string; interval_minutes: number | null; consecutive_failures: number;
      }>(
        `SELECT id,account_id,mode,days,cadence,next_run_at,interval_minutes,consecutive_failures
           FROM analysis_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 5`, now,
      );
      for (const schedule of dueAnalyses) {
        const started = Date.now();
        const runId = randomUUID();
        try {
          const handler = this.handlers.get('analysis.run');
          if (!handler) throw new Error('handler analysis.run indisponível');
          const result = await handler({ mode: schedule.mode, accountId: schedule.account_id ?? undefined, days: schedule.days }, null);
          const serialized = JSON.stringify(result ?? null);
          const resultJson = serialized.length <= 250_000 ? serialized : JSON.stringify({ truncated: true, reason: 'resultado acima de 250 KB' });
          const nextAt = nextOccurrence(schedule.next_run_at, schedule.cadence, schedule.interval_minutes, new Date());
          db.db.prepare(`INSERT INTO analysis_schedule_runs (id,schedule_id,started_at,finished_at,status,result_json,duration_ms)
                         VALUES (?,?,?,?, 'COMPLETED',?,?)`)
            .run(runId, schedule.id, new Date(started).toISOString(), nowIso(), resultJson, Date.now() - started);
          db.db.prepare('UPDATE analysis_schedules SET last_run_at=?,last_status=?,last_error=NULL,next_run_at=?,consecutive_failures=0,updated_at=? WHERE id=?')
            .run(nowIso(), 'COMPLETED', nextAt, nowIso(), schedule.id);
          analyses += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retry = retryDecision(schedule.consecutive_failures, new Date());
          const failures = retry.consecutiveFailures;
          const status = retry.shouldRetry ? 'RETRYING' : 'FAILED';
          const nextAt = retry.nextRunAt
            ?? nextOccurrence(schedule.next_run_at, schedule.cadence, schedule.interval_minutes, new Date());
          db.db.prepare(`INSERT INTO analysis_schedule_runs (id,schedule_id,started_at,finished_at,status,error,duration_ms)
                         VALUES (?,?,?,?,?,?,?)`)
            .run(runId, schedule.id, new Date(started).toISOString(), nowIso(), status, message.slice(0, 1000), Date.now() - started);
          db.db.prepare('UPDATE analysis_schedules SET last_run_at=?,last_status=?,last_error=?,next_run_at=?,consecutive_failures=?,updated_at=? WHERE id=?')
            .run(nowIso(), status, message.slice(0, 1000), nextAt, failures, nowIso(), schedule.id);
          errors.push(`analysis ${schedule.id} (${status}): ${message}`);
        }
      }

      const dueReports = db.rows<{
        id: string; account_id: string | null; report_type: string; format: string;
        cadence: ScheduleCadence; next_run_at: string; interval_minutes: number | null; consecutive_failures: number;
      }>(
        `SELECT id,account_id,report_type,format,cadence,next_run_at,interval_minutes,consecutive_failures
           FROM report_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT ?`, now, Math.max(0, 5 - analyses),
      );
      for (const schedule of dueReports) {
        const runId = randomUUID();
        const started = Date.now();
        try {
          const handler = this.handlers.get('report.export');
          if (!handler) throw new Error('handler report.export indisponível');
          const result = await handler({ type: schedule.report_type, format: schedule.format, accountId: schedule.account_id ?? undefined }, null);
          const serialized = JSON.stringify(result);
          const reportJson = serialized.length <= 1_000_000 ? serialized : JSON.stringify({ truncated: true, reason: 'relatório acima de 1 MB; execute exportação manual para baixar o arquivo completo' });
          const rowCount = Number((result as { rowCount?: number } | null)?.rowCount ?? 0);
          db.db.prepare('INSERT INTO report_schedule_runs (id,schedule_id,generated_at,status,report_json,row_count) VALUES (?,?,?,?,?,?)')
            .run(runId, schedule.id, nowIso(), 'COMPLETED', reportJson, rowCount);
          const nextAt = nextOccurrence(schedule.next_run_at, schedule.cadence, schedule.interval_minutes, new Date());
          db.db.prepare('UPDATE report_schedules SET last_run_at=?,last_status=?,last_error=NULL,next_run_at=?,consecutive_failures=0,updated_at=? WHERE id=?')
            .run(nowIso(), 'COMPLETED', nextAt, nowIso(), schedule.id);
          reports += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retry = retryDecision(schedule.consecutive_failures, new Date());
          const failures = retry.consecutiveFailures;
          const status = retry.shouldRetry ? 'RETRYING' : 'FAILED';
          const nextAt = retry.nextRunAt
            ?? nextOccurrence(schedule.next_run_at, schedule.cadence, schedule.interval_minutes, new Date());
          db.db.prepare('INSERT INTO report_schedule_runs (id,schedule_id,generated_at,status,error,row_count) VALUES (?,?,?,?,?,0)')
            .run(runId, schedule.id, nowIso(), 'FAILED', message.slice(0, 1000));
          db.db.prepare('UPDATE report_schedules SET last_run_at=?,last_status=?,last_error=?,next_run_at=?,consecutive_failures=?,updated_at=? WHERE id=?')
            .run(nowIso(), status, message.slice(0, 1000), nextAt, failures, nowIso(), schedule.id);
          errors.push(`report ${schedule.id} (${status}): ${message}`);
        }
      }
      const dueSyncSchedules = db.rows<{
        id: string; scope: 'ALL_ACTIVE_ACCOUNTS' | 'ALL_ENABLED_MARKETPLACES' | 'ACCOUNT';
        account_id: string | null; cadence: ScheduleCadence; interval_minutes: number | null; next_run_at: string;
      }>(
        `SELECT s.id,s.scope,s.account_id,s.cadence,s.interval_minutes,s.next_run_at
           FROM sync_schedules s WHERE s.enabled=1 AND s.next_run_at<=?
             AND NOT EXISTS (SELECT 1 FROM sync_schedule_runs r WHERE r.schedule_id=s.id AND r.status IN ('QUEUED','RUNNING'))
           ORDER BY s.next_run_at LIMIT ?`, now, Math.max(0, 5 - analyses - reports),
      );
      for (const schedule of dueSyncSchedules) {
        const runId = randomUUID();
        const batchId = randomUUID();
        const accounts = db.rows<{ id: string; marketplace: string }>(
          `SELECT a.id,a.marketplace FROM accounts a
            WHERE a.is_active=1 AND (? IS NULL OR a.id=?)
              AND (? <> 'ALL_ENABLED_MARKETPLACES' OR EXISTS (SELECT 1 FROM marketplaces m WHERE m.id=a.marketplace AND m.enabled=1))
            ORDER BY a.marketplace,a.id`,
          schedule.account_id, schedule.account_id, schedule.scope,
        );
        const nextAt = nextOccurrence(schedule.next_run_at, schedule.cadence, schedule.interval_minutes, new Date());
        if (!accounts.length) {
          const error = 'nenhuma conta ativa conhecida no escopo do agendamento';
          db.transaction(() => {
            db.db.prepare(`INSERT INTO sync_schedule_runs (id,schedule_id,batch_id,scheduled_at,finished_at,status,summary_json,error)
                           VALUES (?,?,NULL,?,?,'FAILED','{}',?)`)
              .run(runId, schedule.id, schedule.next_run_at, nowIso(), error);
            db.db.prepare('UPDATE sync_schedules SET next_run_at=?,last_run_at=?,last_status=?,last_error=?,updated_at=? WHERE id=?')
              .run(nextAt, nowIso(), 'FAILED', error, nowIso(), schedule.id);
          });
          errors.push(`sync schedule ${schedule.id}: ${error}`);
          syncs += 1;
          continue;
        }
        db.transaction(() => {
          db.db.prepare('INSERT INTO sync_batches (id,requested_by,scope,status,requested_at,summary_json) VALUES (?,?,?,?,?,?)')
            .run(batchId, null, schedule.scope, 'QUEUED', nowIso(), JSON.stringify({ accountCount: accounts.length, scheduled: true, scheduleId: schedule.id }));
          const insert = db.db.prepare('INSERT INTO sync_batch_accounts (id,batch_id,account_id,marketplace,status) VALUES (?,?,?,?,?)');
          for (const account of accounts) insert.run(randomUUID(), batchId, account.id, account.marketplace, 'WAITING_BROWSER');
          db.db.prepare(`INSERT INTO sync_schedule_runs (id,schedule_id,batch_id,scheduled_at,status,summary_json)
                         VALUES (?,?,?,?,'QUEUED',?)`)
            .run(runId, schedule.id, batchId, schedule.next_run_at, JSON.stringify({ accountCount: accounts.length }));
          db.db.prepare('UPDATE sync_schedules SET next_run_at=?,last_run_at=?,last_status=?,last_error=NULL,updated_at=? WHERE id=?')
            .run(nextAt, nowIso(), 'QUEUED', nowIso(), schedule.id);
        });
        syncs += 1;
      }
      try{await this.externalSeo.processDue();}catch{errors.push('falha no ciclo SEO externo');}
      return { analyses, reports, syncs, errors };
    } finally {
      this.scheduledWorkRunning = false;
    }
  }

  private registerAll(): void {
    const { db, secrets, tasks, gemini, knowledge, autoUpgrade, capture } = this.deps;
    // Receipts are committed together with their writes. A lost HTTP/native reply is safe to replay.
    function captureOnce<T extends { ok: boolean }>(method: string, payload: unknown, work: () => T): T {
      const raw = payload as Record<string, unknown> | null | undefined;
      if (raw?.captureKey === undefined) return work();
      const parsed = z.object({ captureKey: z.string().regex(/^[a-f0-9]{64}$/), accountId: z.string().min(1), filterSignature:z.string().max(512).optional(),capturePageIdentity:z.string().regex(/^[a-f0-9]{64}$/).optional() }).passthrough().parse(payload);
      const { captureKey, accountId } = parsed;
      const source = new URL(z.string().url().max(2048).parse(method === 'capture.ingest' ? parsed.url : parsed.sourceUrl));
      if (source.protocol !== 'https:' || source.username || source.password) throw new Error('URL do recibo inválida');
      source.hash = ''; source.searchParams.sort();
      // Keep receipts with no filter compatible with the previous protocol; a different visible filter must never be acknowledged as the same capture.
      const identity = createHash('sha256').update(parsed.capturePageIdentity ? JSON.stringify([source.href,parsed.filterSignature??'',parsed.capturePageIdentity]) : parsed.filterSignature ? JSON.stringify([source.href,parsed.filterSignature]) : source.href).digest('hex');
      let rejected: T | undefined;
      const abort = new Error('captura não confirmada');
      try {
        return db.transaction(() => {
          const active = db.row<{ is_active: number; marketplace: string }>('SELECT is_active,marketplace FROM accounts WHERE id=?', accountId);
          if (!active?.is_active) throw new Error('conta inexistente ou inativa');
          const hosts: Record<string, RegExp> = { mercado_livre: /(^|\.)mercadolivre\.com\.br$/i, shopee: /(^|\.)shopee\.com\.br$/i, amazon: /^sellercentral\.amazon\.com\.br$/i };
          if (!hosts[active.marketplace]?.test(source.hostname) || (method === 'capture.ingest' && parsed.marketplace !== active.marketplace)) throw new Error('recibo não pertence ao marketplace da conta');
          const receipt = db.row<{ result_json: string; identity_hash: string }>('SELECT result_json,identity_hash FROM capture_receipts WHERE account_id=? AND method=? AND capture_key=?', accountId, method, captureKey);
          if (receipt) {
            if (receipt.identity_hash !== identity) throw new Error('chave de captura reutilizada para outra página ou seleção de filtros');
            return JSON.parse(receipt.result_json) as T;
          }
          const result = work();
          if (!result.ok) { rejected = result; throw abort; }
          db.db.prepare('INSERT INTO capture_receipts(account_id,method,capture_key,identity_hash,result_json,created_at) VALUES (?,?,?,?,?,?)')
            .run(accountId,method,captureKey,identity,JSON.stringify(result),nowIso());
          return result;
        });
      } catch (error) {
        if (error === abort && rejected) return rejected;
        throw error;
      }
    }

    this.register('ping', () => ({ pong: true, version: this.deps.version, at: new Date().toISOString() }));

    // ------------------------------------------------------------ autenticação
    this.register('auth.bootstrap', (payload) => {
      const schema = z.object({ email: z.string().email(), password: z.string().min(8), displayName: z.string().min(1) });
      const input = schema.parse(payload);
      const existing = db.row<{ c: number }>('SELECT COUNT(*) AS c FROM users');
      if ((existing?.c ?? 0) > 0) {
        return { ok: false, error: 'bootstrap já realizado: o super_admin já existe' };
      }
      const { hash, salt } = hashPassword(input.password);
      const id = randomUUID();
      db.db
        .prepare(
          'INSERT INTO users (id, email, display_name, role, password_hash, password_salt, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        )
        .run(id, input.email.toLowerCase(), input.displayName, 'super_admin', hash, salt, new Date().toISOString());
      this.audit({ userId: id, role: 'super_admin' }, 'BOOTSTRAP', 'user', id, 'OK', 'criação do super_admin');
      return { ok: true, userId: id, role: 'super_admin' };
    });

    this.register('auth.login', (payload) => {
      const schema = z.object({ email: z.string().email(), password: z.string() });
      const input = schema.parse(payload);
      const user = db.row<{
        id: string;
        role: AccessRole;
        password_hash: string;
        password_salt: string;
        is_active: number;
      }>('SELECT id, role, password_hash, password_salt, is_active FROM users WHERE email = ?', input.email.toLowerCase());
      if (!user || !verifyPassword(input.password, user.password_hash, user.password_salt)) {
        this.audit(null, 'LOGIN_FAILED', 'user', null, 'DENIED', input.email);
        return { ok: false, error: 'credenciais inválidas' };
      }
      if (!user.is_active) return { ok: false, error: 'usuário inativo' };
      const token = randomUUID() + randomUUID();
      const expires = new Date(Date.now() + 12 * 3600_000).toISOString();
      db.db
        .prepare('INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), user.id, sha256(token), new Date().toISOString(), expires);
      db.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
      this.audit({ userId: user.id, role: user.role }, 'LOGIN', 'user', user.id, 'OK');
      return { ok: true, token, role: user.role, expiresAt: expires };
    });

    this.register('auth.session', (payload) => {
      const schema = z.object({ token: z.string() });
      const input = schema.parse(payload);
      const session = this.resolveSession(input.token);
      return session ? { ok: true, role: session.role } : { ok: false, error: 'sessão inválida ou expirada' };
    });

    this.register('auth.logout', (payload, auth) => {
      const schema = z.object({ token: z.string().min(1).max(4096) });
      const input = schema.parse(payload);
      const session = db.row<{ user_id: string }>(
        'SELECT user_id FROM auth_sessions WHERE token_hash = ?',
        sha256(input.token),
      );
      if (!session || !auth || session.user_id !== auth.userId) {
        return { ok: false, error: 'a sessão não pertence ao usuário autenticado' };
      }
      db.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?').run(new Date().toISOString(), sha256(input.token));
      this.audit(auth, 'LOGOUT', 'user', auth.userId, 'OK');
      return { ok: true };
    });

    // ------------------------------------------------------------ settings & gemini
    this.register('settings.get', () => {
      const rows = db.rows<{ key: string; value_json: string }>('SELECT key, value_json FROM settings');
      return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)]));
    });

    this.register('settings.set', (payload, auth) => {
      const schema = z.object({ key: z.string().min(1).max(120), value: z.unknown() });
      const input = schema.parse(payload);
      if(input.key.startsWith('assisted_limits:'))throw Error('use operation.limits.set para confirmar limites de operação');
      if (/key|secret|token|password/i.test(input.key)) {
        throw new Error('segredos não podem ser gravados em settings; use o cofre cifrado');
      }
      db.db
        .prepare(
          'INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by',
        )
        .run(input.key, JSON.stringify(input.value), new Date().toISOString(), auth?.userId ?? null);
      this.audit(auth, 'SETTINGS_SET', 'settings', input.key, 'OK', undefined, input.value);
      return { ok: true };
    });

    this.register('gemini.setKey', async (payload, auth) => {
      const schema = z.object({ apiKey: z.string().min(20).max(500) });
      const input = schema.parse(payload);
      gemini.setKey(input.apiKey);
      this.audit(auth, 'GEMINI_KEY_SET', 'secrets', 'gemini.apiKey', 'OK', 'chave armazenada cifrada');
      return { ok: true, hint: gemini.keyHint() };
    });

    this.register('gemini.testKey', async () => {
      const res = await gemini.testKey();
      return res.ok ? { ok: true, model: res.model, latencyMs: res.latencyMs } : { ok: false, error: res.message };
    });

    // ------------------------------------------------------------ contas & captura
    this.register('account.upsert', (payload, auth) => {
      const schema = z.object({
        marketplace: z.string().min(1).max(80),
        accountId: z.string().trim().min(1).max(256),
        displayName: z.string().trim().min(1).max(500),
        handle: z.string().optional(),
        confidence: z.number().min(0).max(1),
        verifiedByUser: z.boolean(),
      });
      const input = schema.parse(payload);
      const now = new Date().toISOString();
      const existing = db.row<{ marketplace: string }>('SELECT marketplace FROM accounts WHERE id=?', input.accountId);
      if (existing && existing.marketplace !== input.marketplace) throw new Error('identidade da conta pertence a outro marketplace');
      db.db
        .prepare(
          `INSERT INTO accounts (id, marketplace, external_ref, display_name, handle, detection_confidence, verified_by_user, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, handle=excluded.handle,
             detection_confidence=excluded.detection_confidence, verified_by_user=excluded.verified_by_user, updated_at=excluded.updated_at WHERE accounts.marketplace=excluded.marketplace`,
        )
        .run(input.accountId, input.marketplace, input.handle ?? null, input.displayName, input.handle ?? null, input.confidence, input.verifiedByUser ? 1 : 0, now, now);
      this.audit(auth, 'ACCOUNT_UPSERT', 'account', input.accountId, 'OK');
      return { ok: true, accountId: input.accountId };
    });

    this.register('account.list', () =>
      db.rows<{ id: string; marketplace: string; display_name: string; verified_by_user: number; detection_confidence: number; is_active: number }>(
        'SELECT id, marketplace, display_name, verified_by_user, detection_confidence, is_active FROM accounts ORDER BY marketplace, display_name',
      ),
    );

    this.register('account.setActive', (payload, auth) => {
      const i = z.object({ accountId: z.string().min(1), isActive: z.boolean() }).parse(payload);
      const changed = db.db.prepare('UPDATE accounts SET is_active = ?, updated_at = ? WHERE id = ?').run(i.isActive ? 1 : 0, new Date().toISOString(), i.accountId);
      if (Number(changed.changes) !== 1) throw new Error('conta não encontrada');
      this.audit(auth, 'ACCOUNT_SET_ACTIVE', 'account', i.accountId, 'OK', i.isActive ? 'ativada' : 'desativada');
      return { ok: true, accountId: i.accountId, isActive: i.isActive };
    });

    this.register('user.list', () => db.rows<Record<string, unknown>>(
      'SELECT id, email, display_name, role, is_active, created_at, last_login_at FROM users ORDER BY created_at ASC',
    ));

    this.register('user.upsert', (payload, auth) => {
      const i = z.object({ id: z.string().optional(), email: z.string().email(), displayName: z.string().min(1).max(120), role: z.enum(['super_admin','operador','visualizador']), password: z.string().min(10).max(200).optional() }).parse(payload);
      const email = i.email.trim().toLowerCase();
      const now = new Date().toISOString();
      const existing = i.id ? db.row<{ id: string }>('SELECT id FROM users WHERE id = ?', i.id) : db.row<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
      if (!existing && !i.password) throw new Error('senha inicial de pelo menos 10 caracteres obrigatória');
      if (existing) {
        const current = db.row<{ role: AccessRole; is_active: number }>('SELECT role,is_active FROM users WHERE id=?', existing.id);
        if (current?.role === 'super_admin' && current.is_active === 1 && i.role !== 'super_admin') {
          const admins = db.row<{ total: number }>("SELECT COUNT(*) AS total FROM users WHERE role='super_admin' AND is_active=1");
          if ((admins?.total ?? 0) <= 1) throw new Error('o último super_admin ativo não pode perder o papel');
        }
        const credentials = i.password ? hashPassword(i.password) : null;
        db.transaction(() => {
          db.db.prepare('UPDATE users SET email = ?, display_name = ?, role = ? WHERE id = ?').run(email, i.displayName, i.role, existing.id);
          if (credentials) db.db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(credentials.hash, credentials.salt, existing.id);
          if (credentials || current?.role !== i.role) db.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now, existing.id);
        });
        this.audit(auth, 'USER_UPDATE', 'user', existing.id, 'OK', `papel ${i.role}`);
        return { ok: true, id: existing.id, created: false };
      }
      const id = randomUUID();
      const { hash, salt } = hashPassword(i.password!);
      db.db.prepare('INSERT INTO users (id,email,display_name,role,password_hash,password_salt,is_active,created_at) VALUES (?,?,?,?,?,?,1,?)')
        .run(id, email, i.displayName, i.role, hash, salt, now);
      this.audit(auth, 'USER_CREATE', 'user', id, 'OK', `papel ${i.role}`);
      return { ok: true, id, created: true };
    });

    this.register('user.setActive', (payload, auth) => {
      const i = z.object({ userId: z.string().min(1), isActive: z.boolean() }).parse(payload);
      if (!auth) throw new Error('sessão necessária');
      if (i.userId === auth.userId && !i.isActive) throw new Error('não é permitido desativar a própria sessão de administração');
      const target = db.row<{ role: AccessRole; is_active: number }>('SELECT role, is_active FROM users WHERE id = ?', i.userId);
      if (!target) throw new Error('usuário não encontrado');
      if (target.role === 'super_admin' && i.isActive === false && target.is_active === 1) {
        const admins = db.row<{ total: number }>("SELECT COUNT(*) AS total FROM users WHERE role = 'super_admin' AND is_active = 1");
        if ((admins?.total ?? 0) <= 1) throw new Error('o último super_admin ativo não pode ser desativado');
      }
      db.db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(i.isActive ? 1 : 0, i.userId);
      if (!i.isActive) db.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), i.userId);
      this.audit(auth, 'USER_SET_ACTIVE', 'user', i.userId, 'OK', i.isActive ? 'ativado' : 'desativado');
      return { ok: true, userId: i.userId, isActive: i.isActive };
    });

    this.register('catalog.product.upsert', (payload, auth) => {
      const i = z.object({ id: z.string().optional(), accountId: z.string().min(1), name: z.string().min(1).max(500), brand: z.string().max(200).nullable().optional(), model: z.string().max(200).nullable().optional(), category: z.string().max(200).nullable().optional() }).parse(payload);
      if (!db.row('SELECT id FROM accounts WHERE id = ? AND is_active = 1', i.accountId)) throw new Error('conta ativa não encontrada');
      const id = i.id ?? randomUUID();
      if (i.id) {
        const changed = db.db.prepare('UPDATE catalog_products SET name=?, brand=?, model=?, category=? WHERE id=? AND account_id=?').run(i.name, i.brand ?? null, i.model ?? null, i.category ?? null, id, i.accountId);
        if (Number(changed.changes) !== 1) throw new Error('produto não encontrado nesta conta');
      } else {
        db.db.prepare('INSERT INTO catalog_products (id,account_id,name,brand,model,category,created_at) VALUES (?,?,?,?,?,?,?)').run(id, i.accountId, i.name, i.brand ?? null, i.model ?? null, i.category ?? null, nowIso());
      }
      this.audit(auth, 'CATALOG_PRODUCT_UPSERT', 'catalog_product', id, 'OK');
      return { ok: true, id };
    });

    this.register('catalog.product.list', (payload) => {
      const i = z.object({ accountId: z.string().optional() }).parse(payload ?? {});
      return i.accountId ? db.rows<Record<string, unknown>>('SELECT * FROM catalog_products WHERE account_id = ? ORDER BY name', i.accountId) : db.rows<Record<string, unknown>>('SELECT * FROM catalog_products ORDER BY name');
    });

    this.register('catalog.sku.upsert', (payload, auth) => {
      const i = z.object({ id: z.string().optional(), accountId: z.string().optional(), productId: z.string().nullable().optional(), sku: z.string().min(1).max(120), ean: z.string().max(32).nullable().optional(), gtin: z.string().max(32).nullable().optional(), upc: z.string().max(32).nullable().optional(), attributes: z.record(z.string(), z.unknown()).default({}) }).parse(payload);
      const id = i.id ?? randomUUID();
      const attrs = JSON.stringify(i.attributes);
      if (i.accountId && !db.row('SELECT id FROM accounts WHERE id=? AND is_active=1', i.accountId)) throw new Error('conta ativa não encontrada');
      const currentSku = i.id ? db.row<{ catalog_product_id: string | null; account_id: string | null }>('SELECT catalog_product_id,account_id FROM skus WHERE id=?', id) : null;
      if (i.id && !currentSku) throw new Error('SKU não encontrado');
      const resolvedProductId = i.productId === undefined ? currentSku?.catalog_product_id ?? null : i.productId;
      const product = resolvedProductId
        ? db.row<{ account_id: string; is_active: number }>('SELECT p.account_id,a.is_active FROM catalog_products p JOIN accounts a ON a.id=p.account_id WHERE p.id=?', resolvedProductId)
        : null;
      if (resolvedProductId && !product) throw new Error('produto não encontrado');
      if (product?.is_active === 0) throw new Error('conta do produto está inativa');
      if (i.accountId && product && product.account_id !== i.accountId) throw new Error('produto pertence a outra conta');
      const resolvedAccountId = i.accountId ?? product?.account_id ?? currentSku?.account_id ?? null;
      if (i.id) {
        const changed = db.db.prepare('UPDATE skus SET account_id=?,catalog_product_id=?,sku_code=?,ean=?,gtin=?,upc=?,attributes_json=? WHERE id=?').run(resolvedAccountId, resolvedProductId, i.sku, i.ean ?? null, i.gtin ?? null, i.upc ?? null, attrs, id);
        if (Number(changed.changes) !== 1) throw new Error('SKU não encontrado');
      } else db.db.prepare('INSERT INTO skus (id,account_id,catalog_product_id,sku_code,ean,gtin,upc,attributes_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, resolvedAccountId, i.productId ?? null, i.sku, i.ean ?? null, i.gtin ?? null, i.upc ?? null, attrs, nowIso());
      this.audit(auth, 'CATALOG_SKU_UPSERT', 'sku', id, 'OK');
      return { ok: true, id };
    });

    this.register('catalog.sku.list', (payload) => {
      const i = z.object({ productId: z.string().optional(), accountId: z.string().optional() }).parse(payload ?? {});
      if (i.productId) return i.accountId
        ? db.rows<Record<string, unknown>>('SELECT * FROM skus WHERE catalog_product_id = ? AND account_id = ? ORDER BY sku_code', i.productId, i.accountId)
        : db.rows<Record<string, unknown>>('SELECT * FROM skus WHERE catalog_product_id = ? ORDER BY sku_code', i.productId);
      if (i.accountId) return db.rows<Record<string, unknown>>('SELECT * FROM skus WHERE account_id = ? ORDER BY sku_code', i.accountId);
      return db.rows<Record<string, unknown>>('SELECT * FROM skus ORDER BY sku_code');
    });

    this.register('media.list', (payload) => {
      const i = z.object({ accountId: z.string().optional() }).parse(payload ?? {});
      const rows = i.accountId
        ? db.rows<Record<string, unknown>>('SELECT id,account_id,filename,mime_type,byte_size,sha256,alt_text,created_at FROM media_library WHERE account_id = ? ORDER BY created_at DESC', i.accountId)
        : db.rows<Record<string, unknown>>('SELECT id,account_id,filename,mime_type,byte_size,sha256,alt_text,created_at FROM media_library ORDER BY created_at DESC');
      return rows;
    });

    this.register('media.add', (payload, auth) => {
      const i = z.object({ accountId: z.string().nullable().optional(), filename: z.string().min(1).max(240), mimeType: z.enum(['image/jpeg','image/png','image/webp','image/gif']), base64: z.string().min(1).max(3_500_000), altText: z.string().max(500).optional() }).parse(payload);
      const raw = i.base64.replace(/^data:[^,]+,/, '');
      const bytes = Buffer.from(raw, 'base64');
      if (!bytes.length || bytes.length > 2_500_000) throw new Error('imagem vazia ou maior que 2,5 MB');
      const signatures: Record<string, number[]> = { 'image/jpeg': [0xff,0xd8,0xff], 'image/png': [0x89,0x50,0x4e,0x47], 'image/gif': [0x47,0x49,0x46,0x38], 'image/webp': [0x52,0x49,0x46,0x46] };
      const signature = signatures[i.mimeType];
      if (!signature || !signature.every((b, idx) => bytes[idx] === b) || (i.mimeType === 'image/webp' && bytes.toString('ascii',8,12) !== 'WEBP')) throw new Error('conteúdo não corresponde ao tipo de imagem declarado');
      if (i.accountId && !db.row('SELECT id FROM accounts WHERE id=? AND is_active=1', i.accountId)) throw new Error('conta ativa não encontrada');
      const id = randomUUID();
      const digest = createHash('sha256').update(bytes).digest('hex');
      db.db.prepare('INSERT INTO media_library (id,account_id,filename,mime_type,byte_size,sha256,content_base64,alt_text,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, i.accountId ?? null, i.filename.replace(/[\/\\]/g,'_'), i.mimeType, bytes.length, digest, bytes.toString('base64'), i.altText ?? null, auth?.userId ?? null, nowIso());
      this.audit(auth, 'MEDIA_ADD', 'media', id, 'OK', `${bytes.length} bytes`);
      return { ok: true, id, byteSize: bytes.length, sha256: digest };
    });

    this.register('media.get', (payload) => {
      const i = z.object({ id: z.string().min(1), accountId: z.string().nullable().optional() }).parse(payload);
      const row = db.row<Record<string, unknown>>('SELECT id,filename,mime_type,byte_size,sha256,content_base64,alt_text,created_at FROM media_library WHERE id=? AND ((? IS NULL AND account_id IS NULL) OR account_id=?)', i.id, i.accountId ?? null, i.accountId ?? null);
      if (!row) throw new Error('imagem não encontrada');
      return row;
    });

    this.register('media.delete', (payload, auth) => {
      const i = z.object({ id: z.string().min(1), accountId: z.string().nullable().optional() }).parse(payload);
      const result = db.db.prepare('DELETE FROM media_library WHERE id=? AND ((? IS NULL AND account_id IS NULL) OR account_id=?)').run(i.id, i.accountId ?? null, i.accountId ?? null);
      if (Number(result.changes) !== 1) throw new Error('imagem não encontrada');
      this.audit(auth, 'MEDIA_DELETE', 'media', i.id, 'OK');
      return { ok: true };
    });

    this.register('capture.ingest', (payload, auth) => {
      if ((payload as { captureKey?: unknown } | null)?.captureKey !== undefined) captureIngestSchema.parse(payload);
      return captureOnce('capture.ingest', payload, () => {
      const result = capture.ingest(payload);
      this.audit(auth, 'CAPTURE_INGEST', 'listing_snapshot', null, result.ok ? 'OK' : 'PARTIAL', result.errors.join('; '));
      return result;
      });
    });

    // Only structural routes; no arbitrary URL, query, fragment, customer text or selectors.
    const navigationContext=z.object({accountId:z.string().min(1).max(200),origin:z.string().url().max(200)});
    const navigationAccount=(i:{accountId:string;origin:string})=>{
      const account=db.row<{marketplace:string;is_active:number;verified_by_user:number}>('SELECT marketplace,is_active,verified_by_user FROM accounts WHERE id=?',i.accountId);
      const hosts:Record<string,RegExp>={mercado_livre:/(^|\.)mercadolivre\.com\.br$/i,shopee:/(^|\.)shopee\.com\.br$/i,amazon:/^sellercentral\.amazon\.com\.br$/i};
      const url=new URL(i.origin);
      if(!account?.is_active||!account.verified_by_user||url.protocol!=='https:'||url.origin!==i.origin||!hosts[account.marketplace]?.test(url.hostname)||url.port)throw new Error('conta ou origem de aprendizado não autorizada');
      return account;
    };
    this.register('navigation.observe',(payload,auth)=>{
      const i=navigationContext.extend({route:z.string().max(160).regex(/^\/(?:[a-z][a-z_-]{0,39}\/)*[a-z][a-z_-]{0,39}\/?$/i),pageKind:z.enum(['seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory']) ,fromRoute:z.string().max(160).optional(),actionKind:z.enum(['SPA_NEXT','FILTER_CHANGE']).optional()}).strict().parse(payload);
      navigationAccount(i);
      if(i.actionKind&&i.fromRoute!==i.route)throw new Error('ação interna exige a mesma rota');
      const segments=i.route.toLowerCase().split('/').filter(Boolean);
      const allowed=new Set('portal product list manage datacenter business-insights order orders sales dashboard home resumo summary metricas stats performance vendas anuncios publicaciones moderador mis-publicaciones itens items publicidade product_ads ads promocoes promociones perguntas preguntas questions question reputacao reputation avaliacoes reviews opinions rating ratings reclamacoes reclamaciones claims complaints disputas mediacoes devolucoes devoluciones returns return refund estoque inventario inventory stock produtos productos ventas pedidos marketing advertising campaignmanager myinventory manageinventory feedback complaint dispute'.split(' '));
      if(segments.some(part=>!allowed.has(part)))throw new Error('rota não estrutural ou não reconhecida');
      const now=nowIso();
      db.transaction(()=>{
        const prior=db.row<{page_kind:string}>('SELECT page_kind FROM navigation_memory WHERE account_id=? AND origin=? AND route=?',i.accountId,i.origin,i.route);
        if(prior&&prior.page_kind!==i.pageKind)throw new Error('classificação da rota mudou; limpe a memória antes de ensinar novamente');
        if(!prior&&(db.row<{n:number}>('SELECT COUNT(*) n FROM navigation_memory WHERE account_id=?',i.accountId)?.n??0)>=100)throw new Error('limite de 100 rotas por conta atingido');
        db.db.prepare('INSERT INTO navigation_memory(account_id,origin,route,page_kind,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,origin,route) DO UPDATE SET observations=MIN(observations+1,1000000),last_seen_at=excluded.last_seen_at').run(i.accountId,i.origin,i.route,i.pageKind,now,now);
        if(i.fromRoute&&i.fromRoute!==i.route){
          if(!db.row('SELECT 1 FROM navigation_memory WHERE account_id=? AND origin=? AND route=?',i.accountId,i.origin,i.fromRoute))throw new Error('origem da transição não demonstrada');
          const prior=db.row('SELECT 1 FROM navigation_transitions WHERE account_id=? AND origin=? AND from_route=? AND to_route=?',i.accountId,i.origin,i.fromRoute,i.route);
          if(!prior&&(db.row<{n:number}>('SELECT COUNT(*) n FROM navigation_transitions WHERE account_id=?',i.accountId)?.n??0)>=500)throw new Error('limite de transições atingido');
          db.db.prepare('INSERT INTO navigation_transitions(account_id,origin,from_route,to_route,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id,origin,from_route,to_route) DO UPDATE SET observations=MIN(observations+1,1000000),last_seen_at=excluded.last_seen_at').run(i.accountId,i.origin,i.fromRoute,i.route,now);
        }
        if(i.actionKind)db.db.prepare('INSERT INTO navigation_actions(account_id,origin,route,action_kind,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id,origin,route,action_kind) DO UPDATE SET observations=MIN(observations+1,1000000),last_seen_at=excluded.last_seen_at').run(i.accountId,i.origin,i.route,i.actionKind,now);
      });
      this.audit(auth,'NAVIGATION_OBSERVE','account',i.accountId,'OK','rota estrutural demonstrada');
      return {ok:true};
    });
    this.register('navigation.list',(payload)=>{
      const i=navigationContext.strict().parse(payload);navigationAccount(i);
      return db.rows('SELECT route,page_kind,observations,first_seen_at,last_seen_at FROM navigation_memory WHERE account_id=? AND origin=? ORDER BY last_seen_at DESC,route LIMIT 100',i.accountId,i.origin);
    });
    this.register('navigation.graph',(payload)=>{
      const i=navigationContext.strict().parse(payload);navigationAccount(i);
      return db.rows('SELECT from_route,to_route,observations,last_seen_at FROM navigation_transitions WHERE account_id=? AND origin=? ORDER BY observations DESC,last_seen_at DESC LIMIT 500',i.accountId,i.origin);
    });
    this.register('navigation.summary',(payload)=>{
      const i=z.object({accountId:z.string().min(1).max(200)}).strict().parse(payload);
      if(!db.row('SELECT 1 FROM accounts WHERE id=? AND is_active=1 AND verified_by_user=1',i.accountId))throw new Error('conta ativa e verificada necessária');
      return {
        routes:db.rows('SELECT origin,route,page_kind,observations,last_seen_at FROM navigation_memory WHERE account_id=? ORDER BY last_seen_at DESC,route LIMIT 100',i.accountId),
        transitions:db.rows('SELECT origin,from_route,to_route,observations,last_seen_at FROM navigation_transitions WHERE account_id=? ORDER BY observations DESC,last_seen_at DESC LIMIT 500',i.accountId),
        actions:db.rows('SELECT origin,route,action_kind,observations,last_seen_at FROM navigation_actions WHERE account_id=? ORDER BY last_seen_at DESC LIMIT 200',i.accountId)
      };
    });
    this.register('navigation.clear',(payload,auth)=>{
      const i=navigationContext.strict().parse(payload);navigationAccount(i);
      db.db.prepare('DELETE FROM navigation_memory WHERE account_id=? AND origin=?').run(i.accountId,i.origin);
      this.audit(auth,'NAVIGATION_CLEAR','account',i.accountId,'OK','memória de navegação limpa');
      return {ok:true};
    });

    this.register('capture.chartPoints',(payload)=>{
      const i=z.object({accountId:z.string().min(1),limit:z.number().int().min(1).max(200).default(100)}).parse(payload);
      return db.rows('SELECT id,chart_id,chart_title,series,dimension,value,unit,raw_text,page_kind,filter_signature,captured_at,source_class FROM capture_chart_points WHERE account_id=? ORDER BY captured_at DESC,id LIMIT ?',i.accountId,i.limit);
    });
    this.register('capture.details',(payload)=>{
      const i=z.object({accountId:z.string().min(1),kind:z.enum(['AD_CAMPAIGN','AD','LISTING_VARIANT','WAREHOUSE_STOCK']).optional(),limit:z.number().int().min(1).max(100).default(50)}).parse(payload);
      return db.rows<Record<string,unknown>>('SELECT * FROM capture_detail_snapshots WHERE account_id=? AND (? IS NULL OR kind=?) ORDER BY captured_at DESC,id LIMIT ?',i.accountId,i.kind??null,i.kind??null,i.limit).map(row=>({...row,metrics:parseJsonObject(String(row.metrics_json)),evidence:parseJsonObject(String(row.evidence_json)),context:parseJsonObject(String(row.context_json))}));
    });
    this.register('capture.accountSnapshots', (payload) => {
      const i=z.object({accountId:z.string().min(1),limit:z.number().int().min(1).max(100).default(50)}).parse(payload);
      return db.rows<Record<string,unknown>>('SELECT * FROM account_snapshots WHERE account_id=? ORDER BY captured_at DESC LIMIT ?',i.accountId,i.limit).map(row=>({...row,metrics:parseJsonObject(String(row.metrics_json??'')),evidence:parseJsonObject(String(row.evidence_json??''))}));
    });

    this.register('capture.snapshot', (payload) => {
      const input = z.object({ listingId: z.string().optional(), accountId: z.string().optional(), days: z.number().int().min(1).max(365).default(30), limit: z.number().int().min(1).max(500).default(200) }).parse(payload ?? {});
      if (input.listingId) return { kpis: capture.kpisForListing(input.listingId, input.days), trend: capture.trend(input.listingId) };
      const rows = input.accountId
        ? db.rows<Record<string, unknown>>(`SELECT s.*, l.external_id, l.title, l.marketplace FROM listing_snapshots s JOIN listings l ON l.id=s.listing_id WHERE s.account_id=? ORDER BY s.captured_at DESC LIMIT ?`, input.accountId, input.limit)
        : db.rows<Record<string, unknown>>(`SELECT s.*, l.external_id, l.title, l.marketplace FROM listing_snapshots s JOIN listings l ON l.id=s.listing_id ORDER BY s.captured_at DESC LIMIT ?`, input.limit);
      return rows.map((row) => ({ ...row, metrics: JSON.parse(String(row.metrics_json || '{}')) }));
    });

    // ------------------------------------------------------------ KPIs, missões, financeiro
    this.register('kpi.listing', (payload) => {
      const schema = z.object({ listingId: z.string(), accountId: z.string().optional(), days: z.number().int().min(1).max(365).default(30) });
      const input = schema.parse(payload);
      if (input.accountId && !db.row('SELECT id FROM listings WHERE id=? AND account_id=?', input.listingId, input.accountId)) {
        throw new Error('o anúncio não pertence à loja selecionada');
      }
      return capture.kpisForListing(input.listingId, input.days);
    });

    const buildDashboard = (filter: { accountId?: string; marketplace?: string; days?:number; listingId?:string; skuId?:string } = {}) => {
      const days=filter.days??30;
      const cutoff=new Date(Date.now()-days*86400000).toISOString();
      const entityScoped=Boolean(filter.listingId||filter.skuId);
      const accounts = db.rows<{ id: string; marketplace: string; display_name: string; is_active: number }>(
        'SELECT id, marketplace, display_name, is_active FROM accounts WHERE (? IS NULL OR id = ?) AND (? IS NULL OR marketplace = ?) ORDER BY display_name',
        filter.accountId ?? null, filter.accountId ?? null, filter.marketplace ?? null, filter.marketplace ?? null,
      );
      const listings = db.rows<{ id: string; account_id: string; marketplace: string; external_id: string; title: string | null }>(
        'SELECT id, account_id, marketplace, external_id, title FROM listings WHERE (? IS NULL OR account_id = ?) AND (? IS NULL OR marketplace = ?) AND (? IS NULL OR id=?) AND (? IS NULL OR sku_id=?)',
        filter.accountId ?? null, filter.accountId ?? null, filter.marketplace ?? null, filter.marketplace ?? null,filter.listingId??null,filter.listingId??null,filter.skuId??null,filter.skuId??null,
      );
      const perListing = listings.map((l) => ({ ...l, kpis: capture.kpisForListing(l.id, 30, cutoff) }));
      const captured = perListing.filter((l) => l.kpis !== null);
      const sumKnown = (rows: typeof perListing, select: (pillars: NonNullable<(typeof perListing)[number]['kpis']>['pillars']) => number | null): number | null => {
        if (rows.length === 0 || rows.some((l) => !l.kpis)) return null;
        const values = rows.map((l) => select(l.kpis!.pillars));
        if (values.some((value) => value === null || !Number.isFinite(value))) return null;
        return (values as number[]).reduce((sum, value) => sum + value, 0);
      };
      const listingSnapshotRows = db.rows<{ listing_id:string; account_id:string; captured_at:string; metrics_json:string }>(
        `SELECT listing_id,account_id,captured_at,metrics_json FROM listing_snapshots
          WHERE captured_at>=? AND (? IS NULL OR account_id=?) ORDER BY captured_at DESC`,
        cutoff, filter.accountId ?? null, filter.accountId ?? null,
      );
      const latestListingSnapshots = new Map<string, Record<string,unknown>>();
      for (const row of listingSnapshotRows) {
        const key = `${row.account_id}|${row.listing_id}`;
        if (latestListingSnapshots.has(key)) continue;
        try { latestListingSnapshots.set(key, JSON.parse(row.metrics_json) as Record<string,unknown>); } catch { continue; }
      }
      const accountSnapshotRows = entityScoped?[]:db.rows<{ account_id:string; page_kind:string; captured_at:string; metrics_json:string }>(
        `SELECT account_id,page_kind,captured_at,metrics_json FROM account_snapshots
          WHERE captured_at>=? AND (? IS NULL OR account_id=?) AND (? IS NULL OR marketplace=?)
          ORDER BY captured_at DESC`,
        cutoff, filter.accountId ?? null, filter.accountId ?? null,
        filter.marketplace ?? null, filter.marketplace ?? null,
      );
      const accountMetricPriority: Record<string,string[]> = {
        seller_dashboard: ['gmv','netRevenue','commission','fixedFee','shippingFee','tax','marketplaceFee','orders','visits','units','stockAvailable','returnsCount','cancellations'],
        seller_orders: ['gmv','netRevenue','commission','fixedFee','shippingFee','tax','marketplaceFee','orders','units'],
        seller_ads: ['adSpend','adClicks','adAttributedRevenue','adAttributedOrders','paidImpressions','organicImpressions'],
        seller_inventory: ['stockAvailable'], seller_returns: ['returnsCount','returnsValue','cancellations','cancellationValue'],
        seller_questions: ['questionsPending','questionsAnswered'], seller_reputation: ['reviewRating','reviewCount'],
      };
      const accountMetrics = new Map<string,Map<string,{value:number;capturedAt:string;pageKind:string}>>();
      for (const snapshot of accountSnapshotRows) {
        let parsed: Record<string,unknown>;
        try { parsed = JSON.parse(snapshot.metrics_json) as Record<string,unknown>; } catch { continue; }
        let metrics = accountMetrics.get(snapshot.account_id);
        if (!metrics) { metrics = new Map(); accountMetrics.set(snapshot.account_id,metrics); }
        for (const key of accountMetricPriority[snapshot.page_kind] ?? []) {
          const value = parsed[key];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
          const current = metrics.get(key);
          if (!current || snapshot.captured_at > current.capturedAt) metrics.set(key,{value,capturedAt:snapshot.captured_at,pageKind:snapshot.page_kind});
        }
      }
      const toCents = (v: number | null) => v === null ? null : Math.round(v * 100);
      const sumListingMetric = (rows: typeof perListing, key: string): number | null => {
        if (!rows.length) return null;
        const values = rows.map((listing) => latestListingSnapshots.get(`${listing.account_id}|${listing.id}`)?.[key]);
        if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
        return (values as number[]).reduce((sum,value) => sum + value,0);
      };
      const makeTotals = (rows: typeof perListing, accountId?: string) => {
        const g = accountMetrics.get(accountId ?? '');
        const observed = (key:string) => g?.get(key)?.value;
        const prefer = (key:string, listingValue:number|null) => observed(key) ?? listingValue;
        const gmv = prefer('gmv',sumKnown(rows, p => p.revenue_profit.gmv));
        const net = prefer('netRevenue',sumKnown(rows, p => p.revenue_profit.netRevenue));
        const visits = prefer('visits',sumKnown(rows, p => p.conversion_cro.visits));
        const orders = prefer('orders',sumKnown(rows, p => p.conversion_cro.orders));
        const adSpend = prefer('adSpend',sumKnown(rows, p => p.acquisition_ads.adSpend));
        const adRevenue = prefer('adAttributedRevenue',sumKnown(rows, p => p.acquisition_ads.adAttributedRevenue));
        const units = prefer('units',sumKnown(rows, p => p.conversion_cro.units));
        const stock = prefer('stockAvailable',sumKnown(rows, p => p.operational_health.stockAvailable));
        const returns = prefer('returnsCount',sumKnown(rows, p => p.post_purchase_retention.returnsCount));
        const commission = prefer('commission',sumListingMetric(rows,'commission'));
        const fixedFee = prefer('fixedFee',sumListingMetric(rows,'fixedFee'));
        const shippingFee = prefer('shippingFee',sumListingMetric(rows,'shippingFee'));
        const tax = prefer('tax',sumListingMetric(rows,'tax'));
        const marketplaceFee = prefer('marketplaceFee',sumListingMetric(rows,'marketplaceFee'));
        const dailySales = sumKnown(rows, p => p.operational_health.dailySalesAvg.value);
        return {
          gmvCents: toCents(gmv), netRevenueCents: toCents(net), contributionCents: null, contributionMarginPct: null,
          commissionCents: toCents(commission), fixedFeeCents: toCents(fixedFee), shippingFeeCents: toCents(shippingFee), taxCents: toCents(tax), marketplaceFeeCents: toCents(marketplaceFee),
          visits, orders, units, adSpendCents: toCents(adSpend), adRevenueCents: toCents(adRevenue), returnsCount: returns,
          stockAvailable: stock, accountSnapshotMetrics: g ? [...g.keys()] : [],
          cvr: visits !== null && visits > 0 && orders !== null ? orders / visits * 100 : null,
          aovCents: gmv !== null && orders !== null && orders > 0 ? Math.round(gmv * 100 / orders) : null,
          acosPct: adSpend !== null && adRevenue !== null && adRevenue > 0 ? adSpend / adRevenue * 100 : null,
          roas: adSpend !== null && adSpend > 0 && adRevenue !== null ? adRevenue / adSpend : null,
          returnRatePct: returns !== null && orders !== null && orders > 0 ? returns / orders * 100 : null,
          stockCoverageDays: stock !== null && dailySales !== null && dailySales > 0 ? stock / dailySales : null,
        };
      };
      const byAccount = accounts.filter(a=>!entityScoped||perListing.some(l=>l.account_id===a.id)).map((a) => {
        const rows = perListing.filter((l) => l.account_id === a.id);
        const capturedRows = rows.filter((l) => l.kpis);
        const metrics = accountMetrics.get(a.id);
        return { ...a, coverage: { totalListings: rows.length, capturedListings: capturedRows.length, uncapturedListings: rows.length - capturedRows.length, accountSnapshotMetricCount: metrics?.size ?? 0 }, totals: makeTotals(rows,a.id) };
      });
      const sumAccountField = (field: string): number | null => {
        if (!byAccount.length) return null;
        const values = byAccount.map((a) => (a.totals as unknown as Record<string,unknown>)[field]);
        if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
        return (values as number[]).reduce((sum,value) => sum+value,0);
      };
      const totalGmv = sumAccountField('gmvCents');
      const totalNet = sumAccountField('netRevenueCents');
      const totalVisits = sumAccountField('visits');
      const totalOrders = sumAccountField('orders');
      const totalAdSpend = sumAccountField('adSpendCents');
      const totalAdRevenue = sumAccountField('adRevenueCents');
      const totalReturns = sumAccountField('returnsCount');
      const totals = {
        gmvCents: totalGmv, netRevenueCents: totalNet, contributionCents: null, contributionMarginPct: null,
        commissionCents: sumAccountField('commissionCents'), fixedFeeCents: sumAccountField('fixedFeeCents'), shippingFeeCents: sumAccountField('shippingFeeCents'), taxCents: sumAccountField('taxCents'), marketplaceFeeCents: sumAccountField('marketplaceFeeCents'),
        visits: totalVisits, orders: totalOrders, units: sumAccountField('units'),
        adSpendCents: totalAdSpend, adRevenueCents: totalAdRevenue, returnsCount: totalReturns,
        cvr: totalVisits !== null && totalVisits > 0 && totalOrders !== null ? totalOrders / totalVisits * 100 : null,
        aovCents: totalGmv !== null && totalOrders !== null && totalOrders > 0 ? totalGmv / totalOrders : null,
        acosPct: totalAdSpend !== null && totalAdRevenue !== null && totalAdRevenue > 0 ? totalAdSpend / totalAdRevenue * 100 : null,
        roas: totalAdSpend !== null && totalAdSpend > 0 && totalAdRevenue !== null ? totalAdRevenue / totalAdSpend : null,
        returnRatePct: totalReturns !== null && totalOrders !== null && totalOrders > 0 ? totalReturns / totalOrders * 100 : null,
      };
      return {
        accounts, listings: perListing, coverage: { totalListings: listings.length, capturedListings: captured.length, uncapturedListings: listings.length - captured.length, accountsWithSnapshots: accountMetrics.size },
        totals, byAccount,window:{days,cutoff,kind:'CAPTURE_RECENCY',sourcePeriodVerified:false,entityScoped},
      };
    };

    this.register('kpi.dashboard', (payload) => {
      const i = z.object({ accountId: z.string().optional(), marketplace:z.enum(['mercado_livre','shopee','amazon']).optional(),days:z.number().int().min(1).max(365).default(30),listingId:z.string().max(200).optional(),skuId:z.string().max(200).optional() }).parse(payload ?? {});
      return buildDashboard(i);
    });
    this.register('kpi.compare', (payload) => {
      const i = z.object({ marketplace: z.string().optional() }).parse(payload ?? {});
      const dashboard = buildDashboard({ marketplace: i.marketplace });
      return { generatedAt: nowIso(), accounts: dashboard.byAccount, coverage: dashboard.coverage };
    });

    this.register('kpi.history', (payload) => {
      const i = z.object({
        accountId: z.string().optional(),
        marketplace: z.enum(['mercado_livre','shopee','amazon']).optional(),
        days: z.number().int().min(1).max(365).default(30),
        listingId:z.string().min(1).max(200).optional(),skuId:z.string().min(1).max(200).optional(),
      }).parse(payload ?? {});
      if (i.accountId && !db.row('SELECT id FROM accounts WHERE id=?', i.accountId)) throw new Error('conta não encontrada');
      const from = new Date(Date.now() - i.days * 86_400_000).toISOString();
      const rows = db.rows<{ listing_id:string; account_id:string; marketplace:string; captured_at:string; metrics_json:string }>(
        `SELECT s.listing_id,s.account_id,l.marketplace,s.captured_at,s.metrics_json
           FROM listing_snapshots s JOIN listings l ON l.id=s.listing_id
          WHERE s.captured_at>=? AND (? IS NULL OR s.account_id=?) AND (? IS NULL OR l.marketplace=?) AND (? IS NULL OR l.id=?) AND (? IS NULL OR l.sku_id=?)
          ORDER BY s.captured_at ASC`,
        from, i.accountId ?? null, i.accountId ?? null, i.marketplace ?? null, i.marketplace ?? null,i.listingId??null,i.listingId??null,i.skuId??null,i.skuId??null,
      );
      const accountRows = i.listingId||i.skuId?[]:db.rows<{ account_id:string; marketplace:string; page_kind:string; captured_at:string; metrics_json:string }>(
        `SELECT account_id,marketplace,page_kind,captured_at,metrics_json FROM account_snapshots
          WHERE captured_at>=? AND (? IS NULL OR account_id=?) AND (? IS NULL OR marketplace=?)
          ORDER BY captured_at ASC`,
        from, i.accountId ?? null, i.accountId ?? null, i.marketplace ?? null, i.marketplace ?? null,
      );
      const latestPerListingDay = new Map<string, typeof rows[number]>();
      for (const row of rows) latestPerListingDay.set(`${row.listing_id}|${row.captured_at.slice(0,10)}`, row);
      const metricKeys = ['gmv','netRevenue','commission','fixedFee','shippingFee','tax','marketplaceFee','orders','visits','units','adSpend','adAttributedRevenue','stockAvailable','returnsCount','cancellations','returnsValue','cancellationValue','adClicks','adAttributedOrders','paidImpressions','organicImpressions','questionsPending','questionsAnswered','reviewCount','reviewRating','organicClicks','favorites','addToCart','discounts','newCustomers','returningCustomers'];
      type MetricAggregate = { sum:number; count:number };
      type DailyAccount = { listings:Set<string>; values:Record<string,MetricAggregate> };
      const daily = new Map<string,Map<string,DailyAccount>>();
      const accountDay = (date:string,accountId:string) => {
        let accounts=daily.get(date);
        if(!accounts){accounts=new Map();daily.set(date,accounts);}
        let point=accounts.get(accountId);
        if(!point){point={listings:new Set<string>(),values:Object.fromEntries(metricKeys.map(key=>[key,{sum:0,count:0}]))};accounts.set(accountId,point);}
        return point;
      };
      for (const row of latestPerListingDay.values()) {
        const point=accountDay(row.captured_at.slice(0,10),row.account_id);
        point.listings.add(row.listing_id);
        let metrics:Record<string,unknown>;
        try{metrics=JSON.parse(row.metrics_json) as Record<string,unknown>;}catch{continue;}
        for(const key of metricKeys){
          const value=metrics[key];
          if(typeof value==='number'&&Number.isFinite(value)&&value>=0){
            point.values[key]!.sum+=value;point.values[key]!.count+=1;
          }
        }
      }
      const accountMetricPriority: Record<string,string[]> = {
        seller_dashboard: ['gmv','netRevenue','commission','fixedFee','shippingFee','tax','marketplaceFee','orders','visits','units','stockAvailable','returnsCount','cancellations'],
        seller_orders: ['gmv','netRevenue','commission','fixedFee','shippingFee','tax','marketplaceFee','orders','units'],
        seller_ads: ['adSpend','adClicks','adAttributedRevenue','adAttributedOrders','paidImpressions','organicImpressions'],
        seller_inventory: ['stockAvailable'],
        seller_returns: ['returnsCount','returnsValue','cancellations','cancellationValue'],
        seller_questions: ['questionsPending','questionsAnswered'],
        seller_reputation: ['reviewRating','reviewCount'],
      };
      const accountDaily = new Map<string, Map<string,{value:number;capturedAt:string;pageKind:string}>>();
      for (const row of accountRows) {
        const date = row.captured_at.slice(0,10);
        let metrics: Record<string,unknown>;
        try { metrics = JSON.parse(row.metrics_json) as Record<string,unknown>; } catch { continue; }
        accountDay(date,row.account_id);
        const accountKey=JSON.stringify([date,row.account_id]);
        let byMetric = accountDaily.get(accountKey);
        if (!byMetric) { byMetric = new Map(); accountDaily.set(accountKey, byMetric); }
        for (const key of accountMetricPriority[row.page_kind] ?? []) {
          const value = metrics[key];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
          const existing = byMetric.get(key);
          if (!existing || row.captured_at > existing.capturedAt) byMetric.set(key,{value,capturedAt:row.captured_at,pageKind:row.page_kind});
        }
      }
      const allMetricKeys=[...new Set([...metricKeys,...Object.values(accountMetricPriority).flat()])];
      const points=[...daily.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,accounts])=>{
        const out:Record<string,unknown>={date,listingsCaptured:[...accounts.values()].reduce((sum,p)=>sum+p.listings.size,0),accountsCaptured:accounts.size};
        const metricCoverage:Record<string,number>={},accountSnapshotMetrics:Record<string,number>={};
        for(const key of allMetricKeys){
          const values:number[]=[];
          let observedAccounts=0;
          for(const [accountId,point] of accounts){
            const observed=accountDaily.get(JSON.stringify([date,accountId]))?.get(key);
            if(observed){values.push(observed.value);observedAccounts++;continue;}
            const entry=point.values[key];
            if(entry&&entry.count>0&&entry.count===point.listings.size&&(key!=='reviewRating'||point.listings.size===1))values.push(entry.sum);
          }
          // A missing contribution is not zero; ratings must not be added across shops.
          out[key]=values.length===accounts.size&&(key!=='reviewRating'||accounts.size===1)?values.reduce((sum,value)=>sum+value,0):null;
          out[`${key}Coverage`]=values.length;
          metricCoverage[key]=values.length;
          if(observedAccounts)accountSnapshotMetrics[key]=observedAccounts;
        }
        out.gmvCents = typeof out.gmv === 'number' ? Math.round((out.gmv as number) * 100) : null;
        out.netRevenueCents = typeof out.netRevenue === 'number' ? Math.round((out.netRevenue as number) * 100) : null;
        out.adSpendCents = typeof out.adSpend === 'number' ? Math.round((out.adSpend as number) * 100) : null;
        out.adAttributedRevenueCents = typeof out.adAttributedRevenue === 'number' ? Math.round((out.adAttributedRevenue as number) * 100) : null;
        for (const field of ['commission','fixedFee','shippingFee','tax','marketplaceFee']) {
          out[`${field}Cents`] = typeof out[field] === 'number' ? Math.round((out[field] as number) * 100) : null;
        }
        const ratio=(numerator:string,denominator:string,multiplier=1)=>{
          const a=out[numerator],b=out[denominator];
          return typeof a==='number'&&typeof b==='number'&&b>0?a/b*multiplier:null;
        };
        out.cvr=ratio('orders','visits',100);out.aovCents=ratio('gmvCents','orders');
        out.acosPct=ratio('adSpend','adAttributedRevenue',100);out.roas=ratio('adAttributedRevenue','adSpend');
        out.returnRatePct=ratio('returnsCount','orders',100);
        out.coverage={totalCapturedListings:out.listingsCaptured,accountsCaptured:accounts.size,accountSnapshotMetrics,metrics:metricCoverage,unit:'accounts_with_known_metric'};
        return out;
      });
      return { from, to: nowIso(), days: i.days, points, source: 'listing_snapshots+account_snapshots', aggregation: 'latest_snapshot_per_listing_per_day_within_account_then_sum_known_accounts', missingValues: 'null_not_zero' };
    });

    this.register('kpi.compare.detail', (payload) => {
      const i = z.object({
        primaryFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        primaryTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        comparisonFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        comparisonTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        groupBy: z.enum(['account','product','listing','marketplace']).default('listing'),
        accountId: z.string().optional(),
        marketplace: z.enum(['mercado_livre','shopee','amazon']).optional(),
        listingId:z.string().min(1).max(200).optional(),
        skuId:z.string().min(1).max(200).optional(),
      }).parse(payload ?? {});
      const dateRange = (from: string, to: string) => {
        const start = new Date(`${from}T00:00:00.000Z`);
        const end = new Date(`${to}T23:59:59.999Z`);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start.toISOString().slice(0,10) !== from || end.toISOString().slice(0,10) !== to || start > end) {
          throw new Error('intervalo de datas inválido');
        }
        const days=Math.round((end.getTime()-start.getTime()+1)/86400000);
        if(days>366)throw new Error('cada intervalo deve ter no máximo 366 dias');
        return { start: start.toISOString(), end: end.toISOString(),days };
      };
      const primary = dateRange(i.primaryFrom,i.primaryTo);
      const comparison = dateRange(i.comparisonFrom,i.comparisonTo);
      if (primary.start <= comparison.end && comparison.start <= primary.end) throw new Error('os dois períodos de comparação não podem se sobrepor');
      if (i.accountId && !db.row('SELECT id FROM accounts WHERE id=? AND is_active=1', i.accountId)) throw new Error('conta ativa não encontrada');
      const records = db.rows<{
        listing_id:string; account_id:string; captured_at:string; metrics_json:string; external_id:string; title:string|null;
        marketplace:string; product_id:string|null; product_name:string|null; account_name:string; evidence_json:string; source_class:string;
      }>(
        `SELECT s.listing_id,s.account_id,s.captured_at,s.metrics_json,s.evidence_json,s.source_class,l.external_id,l.title,l.marketplace,
                cp.id AS product_id,cp.name AS product_name,a.display_name AS account_name
           FROM listing_snapshots s JOIN listings l ON l.id=s.listing_id
           JOIN accounts a ON a.id=s.account_id
           LEFT JOIN skus sku ON sku.id=l.sku_id AND sku.account_id=l.account_id
           LEFT JOIN catalog_products cp ON cp.id=sku.catalog_product_id AND cp.account_id=l.account_id
          WHERE ((s.captured_at>=? AND s.captured_at<=?) OR (s.captured_at>=? AND s.captured_at<=?))
            AND (? IS NULL OR s.account_id=?) AND (? IS NULL OR l.marketplace=?)
            AND (? IS NULL OR l.id=?) AND (? IS NULL OR l.sku_id=?)
          ORDER BY s.captured_at DESC`,
        primary.start,primary.end,comparison.start,comparison.end,i.accountId ?? null,i.accountId ?? null,i.marketplace ?? null,i.marketplace ?? null,i.listingId??null,i.listingId??null,i.skuId??null,i.skuId??null,
      );
      type RecordItem = typeof records[number] & { metrics: Record<string,unknown> };
      const latest = new Map<string,RecordItem>();
      for (const row of records) {
        let metrics: Record<string,unknown>;
        try { metrics = JSON.parse(row.metrics_json) as Record<string,unknown>; } catch { continue; }
        const item = { ...row, metrics };
        if (row.captured_at >= primary.start && row.captured_at <= primary.end) {
          const key = `primary|${row.listing_id}`;
          if (!latest.has(key)) latest.set(key,item);
        }
        if (row.captured_at >= comparison.start && row.captured_at <= comparison.end) {
          const key = `comparison|${row.listing_id}`;
          if (!latest.has(key)) latest.set(key,item);
        }
      }
      const groups = new Map<string,{label:string;accountId:string;marketplace:string;periods:{primary:RecordItem[];comparison:RecordItem[]}}>();
      for (const [key,item] of latest.entries()) {
        const period = key.startsWith('primary|') ? 'primary' : 'comparison';
        const groupKey = i.groupBy==='marketplace' ? item.marketplace : i.groupBy==='account' ? item.account_id : i.groupBy==='product' ? (item.product_id ?? `listing:${item.listing_id}`) : item.listing_id;
        const label = i.groupBy==='marketplace' ? item.marketplace : i.groupBy==='account' ? item.account_name : i.groupBy==='product' ? (item.product_name ?? item.title ?? item.external_id) : (item.title ?? item.external_id);
        let group = groups.get(groupKey);
        if (!group) { group={label,accountId:i.groupBy==='marketplace'?'':item.account_id,marketplace:item.marketplace,periods:{primary:[],comparison:[]}}; groups.set(groupKey,group); }
        if (!group.periods[period].some((entry) => entry.listing_id===item.listing_id)) group.periods[period].push(item);
      }
      const metricKeys = ['gmv','netRevenue','orders','units','visits','adSpend','adAttributedRevenue','commission','fixedFee','shippingFee','tax','marketplaceFee','returnsCount','stockAvailable'] as const;
      const sumKnown = (items:RecordItem[], key:string):number|null => {
        if (!items.length) return null;
        const values=items.map((item)=>item.metrics[key]);
        if (values.some((value)=>typeof value!=='number'||!Number.isFinite(value)||value<0)) return null;
        return (values as number[]).reduce((sum,value)=>sum+value,0);
      };
      const rows = [...groups.entries()].map(([id,group]) => {
        const build = (items:RecordItem[]) => {
          const metrics:Record<string,number|null>={};
          for (const key of metricKeys) metrics[key]=sumKnown(items,key);
          metrics.cvr = metrics.visits!==null&&metrics.visits!==undefined&&metrics.visits>0&&metrics.orders!==null&&metrics.orders!==undefined?metrics.orders/metrics.visits*100:null;
          metrics.aov = metrics.gmv!==null&&metrics.gmv!==undefined&&metrics.orders!==null&&metrics.orders!==undefined&&metrics.orders>0?metrics.gmv/metrics.orders:null;
          metrics.returnRate = metrics.returnsCount!==null&&metrics.returnsCount!==undefined&&metrics.orders!==null&&metrics.orders!==undefined&&metrics.orders>0?metrics.returnsCount/metrics.orders*100:null;
          metrics.roas = metrics.adSpend!==null&&metrics.adSpend!==undefined&&metrics.adSpend>0&&metrics.adAttributedRevenue!==null&&metrics.adAttributedRevenue!==undefined?metrics.adAttributedRevenue/metrics.adSpend:null;
          metrics.acos = metrics.adAttributedRevenue!==null&&metrics.adAttributedRevenue!==undefined&&metrics.adAttributedRevenue>0&&metrics.adSpend!==null&&metrics.adSpend!==undefined?metrics.adSpend/metrics.adAttributedRevenue*100:null;
          return { listingCount:items.length,metrics };
        };
        const current=build(group.periods.primary), previous=build(group.periods.comparison);
        const currentIds=group.periods.primary.map(x=>x.listing_id).sort(),previousIds=group.periods.comparison.map(x=>x.listing_id).sort();
        const sameListings=currentIds.length>0&&JSON.stringify(currentIds)===JSON.stringify(previousIds);
        const equalDuration=primary.days===comparison.days;
        const windowMatches=(items:RecordItem[],from:string,to:string)=>items.length>0&&items.every(item=>{
          if(item.source_class!=='A_PRIMARY_UI')return false;
          const evidence=parseJsonObject(item.evidence_json??'{}');
          if(typeof evidence.filtersAndPeriod!=='string')return false;
          const entries=evidence.filtersAndPeriod.split('|').map(entry=>entry.split('='));
          if(entries.some(entry=>entry.length!==2))return false;
          const starts=entries.filter(([k])=>/^(start_date|date_from|data inicial|start date)$/.test(k??''));
          const ends=entries.filter(([k])=>/^(end_date|date_to|data final|end date)$/.test(k??''));
          return starts.length===1&&ends.length===1&&starts[0]?.[1]===from&&ends[0]?.[1]===to;
        });
        const sourceWindowsVerified=windowMatches(group.periods.primary,i.primaryFrom,i.primaryTo)&&windowMatches(group.periods.comparison,i.comparisonFrom,i.comparisonTo);
        const contextSignature=(item:RecordItem)=>{
          const evidence=parseJsonObject(item.evidence_json??'{}');
          if(typeof evidence.filtersAndPeriod!=='string'||evidence.coverageWarnings)return null;
          const entries=evidence.filtersAndPeriod.split('|').map(entry=>entry.split('='));
          if(entries.some(entry=>entry.length!==2)||new Set(entries.map(entry=>entry[0])).size!==entries.length)return null;
          return JSON.stringify(entries.filter(([key])=>!/^(start_date|date_from|data inicial|start date|end_date|date_to|data final|end date)$/.test(key??'')).sort((a,b)=>(a[0]??'').localeCompare(b[0]??'')));
        };
        const previousById=new Map(group.periods.comparison.map(item=>[item.listing_id,item]));
        const sameFilters=sameListings&&group.periods.primary.every(item=>{
          const prior=previousById.get(item.listing_id);
          const signature=contextSignature(item);
          return prior&&signature!==null&&signature===contextSignature(prior);
        });
        const comparable=equalDuration&&sameListings&&sameFilters&&sourceWindowsVerified&&primary.end<nowIso()&&comparison.end<nowIso();
        const deltaPct:Record<string,number|null>={},verifiedDeltaPct:Record<string,number|null>={};
        for (const key of [...metricKeys,'cvr','aov','returnRate','roas','acos']) {
          const a=current.metrics[key],b=previous.metrics[key];
          deltaPct[key]=sameListings&&typeof a==='number'&&typeof b==='number'&&b!==0?(a-b)/Math.abs(b)*100:null;
          verifiedDeltaPct[key]=comparable?deltaPct[key]??null:null;
        }
        const diagnostics:Array<{code:string;metric:string;current:number;previous:number|null;note:string}>=[];
        const signal=(code:string,metric:string,note:string,condition:(a:number,b:number)=>boolean)=>{
          const a=current.metrics[metric],b=previous.metrics[metric];
          if(comparable&&typeof a==='number'&&typeof b==='number'&&condition(a,b))diagnostics.push({code,metric,current:a,previous:b,note});
        };
        signal('SALES_DECLINE','gmv','GMV observado caiu pelo menos 10%; investigar demanda, estoque e preço, sem atribuir causa.',(a,b)=>b>0&&a<=b*0.9);
        signal('ORDERS_DECLINE','orders','Pedidos observados caíram pelo menos 10%.',(a,b)=>b>0&&a<=b*0.9);
        for(const metric of ['adSpend','commission','fixedFee','shippingFee','tax','marketplaceFee'])signal('COST_INCREASE',metric,'Custo observado aumentou pelo menos 10%; não somar taxas que podem se sobrepor.',(a,b)=>b>0&&a>=b*1.1);
        signal('CVR_DECLINE','cvr','Conversão caiu pelo menos 1 ponto percentual; volumes de visitas precisam ser suficientes.',(a,b)=>b-a>=1&&(current.metrics.visits??0)>=100&&(previous.metrics.visits??0)>=100);
        if(i.groupBy==='product'||i.groupBy==='listing')signal('GROWTH_REVIEW','orders','Sinal de crescimento observado: pedidos subiram pelo menos 10%, com conversão não inferior e estoque observado positivo. Avaliar margem e demanda antes de agir.',(a,b)=>b>=10&&a>=b*1.1&&typeof current.metrics.cvr==='number'&&typeof previous.metrics.cvr==='number'&&current.metrics.cvr>=previous.metrics.cvr&&(current.metrics.stockAvailable??0)>0);
        return { id,label:group.label,accountId:group.accountId,marketplace:group.marketplace,current,previous,deltaPct,verifiedDeltaPct,diagnostics,comparisonQuality:{equalDuration,sameListings,sameFilters,sourceWindowsVerified,comparable,coverageVerified:false} };
      }).sort((a,b)=>(b.current.metrics.gmv??-1)-(a.current.metrics.gmv??-1));
      const campaignRows=i.listingId||i.skuId?[]:db.rows<{account_id:string;marketplace:string;external_id:string;parent_external_id:string;label:string|null;metrics_json:string;context_json:string;evidence_json:string;captured_at:string;source_class:string}>(`SELECT account_id,marketplace,external_id,parent_external_id,label,metrics_json,context_json,evidence_json,captured_at,source_class FROM capture_detail_snapshots WHERE kind='AD_CAMPAIGN' AND captured_at>=? AND captured_at<=? AND (? IS NULL OR account_id=?) AND (? IS NULL OR marketplace=?) ORDER BY captured_at DESC,id DESC`,primary.start,primary.end,i.accountId??null,i.accountId??null,i.marketplace??null,i.marketplace??null);
      const campaigns=[] as Array<{accountId:string;marketplace:string;campaignId:string;label:string|null;spend:number;attributedRevenue:number;capturedAt:string;note:string}>;
      const seenCampaigns=new Set<string>();
      for(const row of campaignRows){
        const key=JSON.stringify([row.account_id,row.external_id,row.parent_external_id]);
        if(seenCampaigns.has(key))continue;
        seenCampaigns.add(key);
        const metrics=parseJsonObject(row.metrics_json),context=parseJsonObject(row.context_json),evidence=parseJsonObject(row.evidence_json);
        const spend=metrics.adSpend,revenue=metrics.adAttributedRevenue;
        if(row.source_class!=='A_PRIMARY_UI'||typeof spend!=='number'||typeof revenue!=='number'||!Number.isFinite(spend)||!Number.isFinite(revenue)||revenue<0||spend<=revenue||evidence.coverageWarnings||context.coverageWarnings)continue;
        const filters=context.filtersAndPeriod;
        if(typeof filters!=='string')continue;
        const entries=filters.split('|').map(s=>s.split('='));
        if(entries.some(e=>e.length!==2)||new Set(entries.map(e=>e[0])).size!==entries.length)continue;
        const starts=entries.filter(([k])=>/^(start_date|date_from|data inicial|start date)$/.test(k??''));
        const ends=entries.filter(([k])=>/^(end_date|date_to|data final|end date)$/.test(k??''));
        if(starts.length!==1||ends.length!==1||starts[0]?.[1]!==i.primaryFrom||ends[0]?.[1]!==i.primaryTo||primary.end>=nowIso())continue;
        campaigns.push({accountId:row.account_id,marketplace:row.marketplace,campaignId:row.external_id,label:row.label,spend,attributedRevenue:revenue,capturedAt:row.captured_at,note:'Investimento maior que receita atribuída observada; não comprova prejuízo contábil nem efeito incremental.'});
      }
      return { generatedAt:nowIso(),groupBy:i.groupBy,primary,comparison,rows,campaigns,diagnosticPolicy:'Somente sinais observados com filtros compatíveis; cobertura integral não comprovada; sem inferência causal.',method:'último snapshot por anúncio em cada janela de captura; variação observada não equivale a vendas realizadas no período. Variação verificada exige janelas iguais, anúncios idênticos, períodos encerrados e datas explícitas da origem.' };
    });

    this.register('missions.today', (payload) => {
      const filter = z.object({ accountId: z.string().optional(), marketplace: z.string().optional() }).parse(payload ?? {});
      const listings = db.rows<{ id: string; account_id: string; marketplace: string }>(
        'SELECT id, account_id, marketplace FROM listings WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR marketplace=?)',
        filter.accountId ?? null, filter.accountId ?? null, filter.marketplace ?? null, filter.marketplace ?? null,
      );
      const missions = listings
        .map((l) => {
          const k = capture.kpisForListing(l.id, 30);
          if (!k) return null;
          const contribution = (k.pillars.revenue_profit.gmv ?? 0) - (k.pillars.acquisition_ads.adSpend ?? 0);
          return computePriority({
            listingId: l.id,
            marketplace: l.marketplace,
            accountId: l.account_id,
            pillar: 'conversion_cro',
            potentialImpactCents: Math.max(0, Math.round(contribution * 0.1)),
            effortHours: 2,
            urgency: 0.6,
            confidence: 0.8,
            signals: {
              stockCoverageDays: k.pillars.operational_health.stockCoverageDays.value,
              cvr: k.pillars.conversion_cro.cvr.value,
              cvrBenchmark: 3,
              visits: k.pillars.conversion_cro.visits ?? 0,
              adSpendCents: (k.pillars.acquisition_ads.adSpend ?? 0) * 100,
              adRevenueCents: (k.pillars.acquisition_ads.adAttributedRevenue ?? 0) * 100,
              returnRatePct: k.pillars.post_purchase_retention.returnRateValue.value,
            },
          });
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
      return buildDailyMissions(missions);
    });

    this.register('finance.simulate', (payload) => {
      const schema = z.object({
        priceCents: z.number().int().positive(),
        quantity: z.number().int().positive(),
        commissionPct: z.number().min(0).max(100),
        fixedFeeCents: z.number().int().min(0),
        installmentPct: z.number().min(0).max(100).default(0),
        unitCostCents: z.number().int().min(0),
        packagingCents: z.number().int().min(0).default(0),
        shippingCents: z.number().int().min(0).default(0),
        taxPct: z.number().min(0).max(100).default(0),
        otherVariableCents: z.number().int().min(0).default(0),
        minMarginPct: z.number().min(0).max(100).default(20),
        discountPct: z.number().min(0).max(100).default(0),
        couponCents: z.number().int().min(0).default(0),
        adSpendCents: z.number().int().min(0).default(0),
        returnRatePct: z.number().min(0).max(100).default(0),
        cancellationRatePct: z.number().min(0).max(100).default(0),
        reverseLogisticsCents: z.number().int().min(0).default(0),
      });
      const i = schema.parse(payload);
      return simulateScenario({
        priceCents: i.priceCents,
        quantity: i.quantity,
        fee: { commissionPct: i.commissionPct, fixedFeeCents: i.fixedFeeCents, installmentPct: i.installmentPct },
        costs: {
          sku: 'sim',
          unitCostCents: i.unitCostCents,
          packagingCents: i.packagingCents,
          shippingCents: i.shippingCents,
          taxPct: i.taxPct,
          otherVariableCents: i.otherVariableCents,
          minMarginPct: i.minMarginPct,
          version: 1,
          validFrom: new Date().toISOString(),
        },
        discountPct: i.discountPct,
        couponCents: i.couponCents,
        adSpendCents: i.adSpendCents,
        returnRatePct: i.returnRatePct,
        cancellationRatePct: i.cancellationRatePct,
        reverseLogisticsCents: i.reverseLogisticsCents,
      });
    });

    this.register('finance.bundle.simulate', (payload) => {
      const input = z.object({
        bundleDiscountPct: z.number().min(0).max(100).default(0),
        adSpendCents: z.number().int().min(0).default(0),
        returnRatePct: z.number().min(0).max(100).default(0),
        cancellationRatePct: z.number().min(0).max(100).default(0),
        components: z.array(z.object({
          name: z.string().min(1).max(120),
          priceCents: z.number().int().positive(),
          quantity: z.number().int().min(1).max(500),
          commissionPct: z.number().min(0).max(100),
          fixedFeeCents: z.number().int().min(0).default(0),
          installmentPct: z.number().min(0).max(100).default(0),
          unitCostCents: z.number().int().min(0),
          packagingCents: z.number().int().min(0).default(0),
          shippingCents: z.number().int().min(0).default(0),
          otherVariableCents: z.number().int().min(0).default(0),
          taxPct: z.number().min(0).max(100).default(0),
          minMarginPct: z.number().min(0).max(100).default(20),
          reverseLogisticsCents: z.number().int().min(0).default(0),
        })).min(1).max(20),
      }).parse(payload ?? {});
      const components = input.components.map((component) => ({
        name: component.name,
        quantity: component.quantity,
        ...simulateScenario({
          priceCents: component.priceCents,
          quantity: component.quantity,
          fee: { commissionPct: component.commissionPct, fixedFeeCents: component.fixedFeeCents, installmentPct: component.installmentPct },
          costs: {
            sku: component.name,
            unitCostCents: component.unitCostCents,
            packagingCents: component.packagingCents,
            shippingCents: component.shippingCents,
            otherVariableCents: component.otherVariableCents,
            taxPct: component.taxPct,
            minMarginPct: component.minMarginPct,
            version: 1,
            validFrom: nowIso(),
          },
          discountPct: input.bundleDiscountPct,
          adSpendCents: 0,
          returnRatePct: input.returnRatePct,
          cancellationRatePct: input.cancellationRatePct,
          reverseLogisticsCents: component.reverseLogisticsCents,
        }),
      }));
      const moneyFields = ['grossRevenueCents','discountCents','revenueAfterDiscountCents','commissionCents','fixedFeeCents','installmentCents','taxCents','netRevenueCents','productCostCents','packagingCents','shippingCents','otherVariableCents','couponCents','returnLossCents','cancellationLossCents','contributionCents'];
      const total: Record<string,number|null> = {};
      for (const field of moneyFields) total[field] = components.reduce((sum, item) => sum + Number((item as Record<string,unknown>)[field] ?? 0), 0);
      const totalRevenue = total.revenueAfterDiscountCents ?? 0;
      const totalUnits = components.reduce((sum,item) => sum + Number(item.quantity ?? 0),0);
      total.totalUnits = totalUnits;
      total.unitContributionCents = totalUnits > 0 ? Math.round(Number(total.contributionCents ?? 0) / totalUnits) : 0;
      total.adSpendCents = input.adSpendCents;
      total.operatingProfitCents = (total.contributionCents ?? 0) - input.adSpendCents;
      total.realizedResultCents = null;
      total.contributionMarginPct = totalRevenue > 0 ? (Number(total.contributionCents ?? 0) / totalRevenue) * 100 : null;
      total.operatingMarginPct = totalRevenue > 0 ? (Number(total.operatingProfitCents ?? 0) / totalRevenue) * 100 : null;
      total.componentCount = components.length;
      total.bundleDiscountPct = input.bundleDiscountPct;
      return { total, components, note: 'Simulação local. Tarifas, impostos, devoluções e custos dependem dos valores informados; resultado realizado permanece null até haver liquidação real. Nenhuma oferta é publicada.' };
    });

    this.register('finance.costs.upsert', (payload, auth) => {
      const schema = z.object({
        skuId: z.string().optional(),
        sku: z.string().optional(),
        accountId: z.string().optional(),
        unitCostCents: z.number().int().min(0).optional(),
        costCents: z.number().int().min(0).optional(),
        packagingCents: z.number().int().min(0).default(0),
        shippingCents: z.number().int().min(0).default(0),
        otherVariableCents: z.number().int().min(0).default(0),
        taxPct: z.number().min(0).max(100).default(0),
        minMarginPct: z.number().min(0).max(100).default(20),
      });
      const i = schema.parse(payload);
      // Aceita o ID interno ou o código comercial do SKU digitado na interface.
      const skuRef = i.skuId ?? i.sku;
      if (!skuRef) throw new Error('informe o ID ou código do SKU');
      let sku: { id: string } | null;
      if (i.skuId) {
        sku = db.row<{ id: string }>('SELECT id FROM skus WHERE id=? AND (? IS NULL OR account_id=?)', i.skuId, i.accountId ?? null, i.accountId ?? null);
      } else {
        if (!i.accountId) throw new Error('accountId é obrigatório quando o custo é informado pelo código SKU');
        sku = db.row<{ id: string }>('SELECT id FROM skus WHERE account_id=? AND sku_code=?', i.accountId, i.sku!);
      }
      if (!sku) throw new Error(`SKU ${skuRef} não cadastrado na conta informada; confirme a loja e cadastre o SKU antes de informar custos`);
      const unitCostCents = i.unitCostCents ?? i.costCents;
      if (unitCostCents === undefined) throw new Error('informe o custo unitário em centavos');
      const last = db.row<{ v: number }>('SELECT COALESCE(MAX(version),0) AS v FROM sku_costs WHERE sku_id = ?', sku.id);
      const version = (last?.v ?? 0) + 1;
      db.db
        .prepare(
          'INSERT INTO sku_costs (id, sku_id, version, unit_cost_cents, packaging_cents, shipping_cents, other_variable_cents, tax_pct, min_margin_pct, valid_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), sku.id, version, unitCostCents, i.packagingCents, i.shippingCents, i.otherVariableCents, i.taxPct, i.minMarginPct, new Date().toISOString(), new Date().toISOString());
      this.audit(auth, 'COST_VERSION', 'sku_cost', sku.id, 'OK', `versão ${version}`);
      return { ok: true, version };
    });

    // ------------------------------------------------------------ tarefas
    this.register('task.create', (payload, auth) => {
      const schema = z.object({
        name: z.string().min(1).max(200),
        kind: z.string(),
        accountId: z.string().optional(),
        mode: z.enum(['DRAFT', 'PUBLISH']),
        scheduleAt: z.string().datetime().nullable().optional(),
        recurrence: z.enum(['1h','6h','daily','weekly']).nullable().optional(),
        typing: z.object({ mode: z.literal('set_value'), charDelayMs: z.number().int().min(0).max(250), settleDelayMs: z.number().int().min(0).max(5000), verifyAfterTyping: z.literal(true) }),
        items: z
          .array(
            z.object({
              listingId: z.string().min(1).max(160),
              marketplace: z.enum(['mercado_livre','shopee']),
              accountId: z.string(),
              copies: z.number().int().min(1).max(50).default(1),
              title: z.string().max(500).nullable().optional(),
              descriptionAdditions: z.string().max(10000).nullable().optional(),
              coverImageId: z.string().nullable().optional(),
            }),
          )
          .min(1),
      });
      const i = schema.parse(payload);
      if (i.mode === 'PUBLISH') throw new Error('PUBLICAÇÃO AUTOMÁTICA BLOQUEADA: o executor atual só oferece rascunhos verificados; use DRAFT e revise manualmente no marketplace');
      if (!['edit_title','edit_description'].includes(i.kind)) throw new Error(`tipo de tarefa ${i.kind} ainda não possui executor seguro; disponíveis: edit_title e edit_description`);
      const normalizedItems = i.items.map((item) => {
        if (i.kind === 'edit_title' && !item.title?.trim()) throw new Error('informe o novo título para a tarefa de edição de título');
        if (i.kind === 'edit_description' && !item.descriptionAdditions?.trim()) throw new Error('informe o acréscimo de descrição para a tarefa de edição de descrição');
        if (i.kind === 'edit_title' && item.descriptionAdditions?.trim()) throw new Error('tarefa de título não pode alterar a descrição; crie uma tarefa separada');
        if (i.kind === 'edit_description' && item.title?.trim()) throw new Error('tarefa de descrição não pode alterar o título; crie uma tarefa separada');
        if (item.copies !== 1 || item.coverImageId) throw new Error('duplicação e troca de imagem ainda não possuem executor seguro');
        const account = db.row<{ marketplace: string; is_active: number }>(
          'SELECT marketplace,is_active FROM accounts WHERE id=?', item.accountId,
        );
        if (!account || account.is_active !== 1 || account.marketplace !== item.marketplace) {
          throw new Error(`conta ${item.accountId} inexistente, inativa ou de outro marketplace`);
        }
        const listing = db.row<{ id: string; account_id: string; marketplace: string }>(
          'SELECT id,account_id,marketplace FROM listings WHERE account_id=? AND marketplace=? AND (id=? OR external_id=?) LIMIT 1',
          item.accountId, item.marketplace, item.listingId, item.listingId,
        );
        if (!listing) throw new Error(`anúncio ${item.listingId} não cadastrado na conta/marketplace informado; faça uma captura antes`);
        return { ...item, listingId: listing.id };
      });
      const created = tasks.create({
        name: i.name,
        kind: i.kind,
        accountId: i.accountId,
        mode: i.mode,
        scheduleAt: i.scheduleAt ?? null,
        recurrence: i.recurrence ?? null,
        typing: i.typing,
        createdBy: auth?.userId ?? 'system',
        items: normalizedItems,
      });
      this.audit(auth, 'TASK_CREATE', 'task', created.taskId, 'OK', `${i.items.length} itens`);
      return created;
    });

    this.register('task.createByFilter', (payload, auth) => {
      const schema = z.object({
        name: z.string().min(1).max(200),
        accountId: z.string().min(1),
        marketplace: z.enum(['mercado_livre','shopee','amazon']).optional(),
        kind: z.enum(['edit_title','edit_description']),
        charDelayMs: z.number().int().min(0).max(250).default(0),
        draftTitle: z.string().max(500).optional(),
        descriptionAdditions: z.string().max(10000).optional(),
        filters: z.object({
          minGmv: z.number().min(0).optional(),
          maxGmv: z.number().min(0).optional(),
          minOrders: z.number().int().min(0).optional(),
          minVisits: z.number().int().min(0).optional(),
          maxCvrPct: z.number().min(0).max(100).optional(),
          maxStockAvailable: z.number().int().min(0).optional(),
        }).refine((f) => Object.values(f).some((v) => v !== undefined), 'informe ao menos um filtro de desempenho'),
      }).superRefine((v, ctx) => {
        if (v.kind === 'edit_title' && !v.draftTitle?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['draftTitle'], message: 'informe o modelo do novo título' });
        if (v.kind === 'edit_description' && !v.descriptionAdditions?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['descriptionAdditions'], message: 'informe o acréscimo da descrição' });
        if (v.filters.minGmv !== undefined && v.filters.maxGmv !== undefined && v.filters.minGmv > v.filters.maxGmv) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters'], message: 'GMV mínimo maior que o máximo' });
      });
      const i = schema.parse(payload);
      const account = db.row<{ marketplace: string; is_active: number }>('SELECT marketplace,is_active FROM accounts WHERE id=?', i.accountId);
      if (!account || account.is_active !== 1) throw new Error('conta inexistente ou inativa');
      if (!['mercado_livre','shopee'].includes(account.marketplace)) throw new Error('criação de rascunho por filtro está disponível somente para Mercado Livre e Shopee');
      if (i.marketplace && i.marketplace !== account.marketplace) throw new Error('marketplace não corresponde à conta selecionada');
      if (i.kind === 'edit_title' && i.descriptionAdditions?.trim()) throw new Error('tarefa de título não pode alterar a descrição');
      if (i.kind === 'edit_description' && i.draftTitle?.trim()) throw new Error('tarefa de descrição não pode alterar o título');
      const candidates = db.rows<{ id: string; account_id: string; marketplace: string; external_id: string; title: string | null; captured_at: string; metrics_json: string }>(
        `SELECT l.id,l.account_id,l.marketplace,l.external_id,l.title,s.captured_at,s.metrics_json
           FROM listings l JOIN accounts a ON a.id=l.account_id
           JOIN listing_snapshots s ON s.listing_id=l.id AND s.account_id=l.account_id
          WHERE l.account_id=? AND a.is_active=1 AND l.status='ACTIVE'
            AND (? IS NULL OR l.marketplace=?)
            AND s.captured_at=(SELECT MAX(s2.captured_at) FROM listing_snapshots s2 WHERE s2.listing_id=l.id AND s2.account_id=l.account_id)
          ORDER BY s.captured_at DESC LIMIT 10000`,
        i.accountId, i.marketplace ?? null, i.marketplace ?? null,
      );
      const allMatched = candidates.flatMap((row) => {
        let metrics: Record<string, unknown>;
        try { metrics = JSON.parse(row.metrics_json) as Record<string, unknown>; } catch { return []; }
        const numeric = (key: string): number | null => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]) && Number(metrics[key]) >= 0 ? Number(metrics[key]) : null;
        const gmv = numeric('gmv'); const orders = numeric('orders'); const visits = numeric('visits'); const stock = numeric('stockAvailable');
        const cvr = visits !== null && visits > 0 && orders !== null ? orders / visits * 100 : null;
        const f = i.filters;
        if (f.minGmv !== undefined && (gmv === null || gmv < f.minGmv)) return [];
        if (f.maxGmv !== undefined && (gmv === null || gmv > f.maxGmv)) return [];
        if (f.minOrders !== undefined && (orders === null || orders < f.minOrders)) return [];
        if (f.minVisits !== undefined && (visits === null || visits < f.minVisits)) return [];
        if (f.maxCvrPct !== undefined && (cvr === null || cvr > f.maxCvrPct)) return [];
        if (f.maxStockAvailable !== undefined && (stock === null || stock > f.maxStockAvailable)) return [];
        const title = i.kind === 'edit_title'
          ? i.draftTitle!.replaceAll('{title}', row.title ?? '').replaceAll('{externalId}', row.external_id).trim()
          : null;
        if (title !== null && !title) return [];
        return [{ listingId: row.id, marketplace: row.marketplace as 'mercado_livre' | 'shopee', accountId: row.account_id, copies: 1, title, descriptionAdditions: i.kind === 'edit_description' ? i.descriptionAdditions!.trim() : null }];
      });
      const totalMatched = allMatched.length;
      const matched = allMatched.slice(0, 100);
      if (!matched.length) return { created: false, matched: 0, totalMatched, truncated: false, note: 'Nenhum anúncio possui snapshots completos que atendam a todos os filtros. Nenhuma tarefa foi criada.' };
      const created = tasks.create({
        name: i.name, kind: i.kind, accountId: i.accountId, mode: 'DRAFT', scheduleAt: null, recurrence: null,
        typing: { mode: 'set_value', charDelayMs: i.charDelayMs, settleDelayMs: 300, verifyAfterTyping: true },
        options: { createdFromPerformanceFilters: true, filters: i.filters, snapshotCutoff: candidates[0]?.captured_at ?? null },
        createdBy: auth?.userId ?? 'system', items: matched,
      });
      this.audit(auth, 'TASK_CREATE_BY_FILTER', 'task', created.taskId, 'OK', `${matched.length} anúncios; filtros de desempenho; DRAFT`);
      return { ...created, created: true, matched: matched.length, totalMatched, truncated: totalMatched > matched.length, limit: 100, note: totalMatched > matched.length ? `Rascunho criado para os primeiros 100 de ${totalMatched} anúncios encontrados. Refine os filtros para incluir o restante em outra tarefa.` : 'Rascunho criado. A extensão só preencherá os anúncios exatos em abas autenticadas; nada será publicado.' };
    });

    this.register('task.list', (payload) => {
      const i = z.object({ accountId: z.string().optional() }).parse(payload ?? {});
      return tasks.list(undefined, i.accountId).map((task) => {
        const items = db.rows<Record<string, unknown>>(
          `SELECT i.*,l.external_id,l.title AS listing_title FROM task_items i
             JOIN listings l ON l.id=i.listing_id WHERE i.task_id=? AND (? IS NULL OR i.account_id=?) ORDER BY i.order_index`,
          task.id, i.accountId ?? null, i.accountId ?? null,
        ).map(({ draft_claim_token: _claimToken, ...item }) => item);
        const approvals = db.rows<{ id: string; item_id: string; status: string; expires_at: string }>(
          'SELECT id,item_id,status,expires_at FROM task_publish_approvals WHERE task_id=? AND (? IS NULL OR account_id=?) ORDER BY approved_at', task.id, i.accountId ?? null, i.accountId ?? null,
        );
        const progress = {
          completed: items.filter((item) => item.status === 'COMPLETED').length,
          failed: items.filter((item) => item.status === 'FAILED').length,
          skipped: items.filter((item) => item.status === 'SKIPPED').length,
          processing: items.filter((item) => item.status === 'PROCESSING').length,
          pending: items.filter((item) => ['PENDING','WAITING_BROWSER'].includes(String(item.status))).length,
        };
        const finished = progress.completed + progress.failed + progress.skipped;
        return { ...task, items, items_count: items.length, progress: { ...progress, finished, total: items.length, percent: items.length ? Math.round(finished / items.length * 100) : 0 }, listing_id: items.map((item) => item.external_id).join(', '), publish_approvals: approvals, published_count: approvals.filter((a) => a.status === 'PUBLISHED').length };
      });
    });

    this.register('task.pause', (payload, auth) => {
      const i = z.object({ taskId: z.string() }).parse(payload);
      tasks.transition(i.taskId, 'PAUSED');
      this.audit(auth, 'TASK_PAUSE', 'task', i.taskId, 'OK');
      return { ok: true };
    });

    this.register('task.resume', (payload, auth) => {
      const i = z.object({ taskId: z.string() }).parse(payload);
      tasks.transition(i.taskId, 'RUNNING');
      this.audit(auth, 'TASK_RESUME', 'task', i.taskId, 'OK');
      return { ok: true };
    });

    this.register('task.cancel', (payload, auth) => {
      const i = z.object({ taskId: z.string() }).parse(payload);
      tasks.transition(i.taskId, 'CANCELLED');
      this.audit(auth, 'TASK_CANCEL', 'task', i.taskId, 'OK');
      return { ok: true };
    });

    this.register('task.skipItem', (payload, auth) => {
      const i = z.object({ itemId: z.string().optional(), taskId: z.string().optional() }).refine((v) => Boolean(v.itemId || v.taskId), 'informe itemId ou taskId').parse(payload);
      const itemId = i.itemId ?? tasks.skipNextItem(i.taskId!);
      if (i.itemId) tasks.skipItem(itemId);
      this.audit(auth, 'TASK_ITEM_SKIP', 'task_item', itemId, 'OK');
      return { ok: true, itemId };
    });

    this.register('task.runNow', (payload, auth) => {
      const i = z.object({ taskId: z.string() }).parse(payload);
      const task = tasks.get(i.taskId);
      if (!task) throw new Error('tarefa inexistente');
      if (task.mode !== 'DRAFT') throw new Error('publicação automática não está habilitada; converta a tarefa para DRAFT e revise manualmente');
      if (!['PENDING','SCHEDULED','PAUSED','FAILED','WAITING_BROWSER'].includes(task.status)) {
        throw new Error(`tarefa não pode ser iniciada no estado ${task.status}`);
      }
      if (task.status === 'FAILED') {
        tasks.resetExhaustedItemsForRetry(i.taskId);
        tasks.transition(i.taskId, 'PENDING');
      }
      if (tasks.get(i.taskId)?.status !== 'WAITING_BROWSER') tasks.transition(i.taskId, 'WAITING_BROWSER', 'aguardando aba autenticada do anúncio correspondente');
      this.audit(auth, 'TASK_RUN_NOW', 'task', i.taskId, 'QUEUED', 'aguardando aba autenticada e anúncio correspondente');
      return { ok: true, status: 'WAITING_BROWSER', note: 'tarefa enfileirada. A extensão aplicará apenas alterações em rascunho quando encontrar o anúncio exato numa aba autenticada; nada será publicado.' };
    });

    this.register('task.claimNext', (payload) => {
      const i = z.object({ marketplace: z.string().min(1), accountId: z.string().min(1), externalListingId: z.string().min(1) }).parse(payload);
      return tasks.claimNextDraftItem(i.marketplace, i.externalListingId, i.accountId);
    });

    this.register('task.recoverDraft', (payload, auth) => {
      const i = z.object({ itemId: z.string().min(1), accountId: z.string().min(1), closedOldTabs: z.literal(true) }).parse(payload);
      const result = tasks.recoverInterruptedDraft(i.itemId, i.accountId);
      this.audit(auth, 'TASK_DRAFT_RECOVER', 'task_item', i.itemId, 'OK', 'recuperação manual após fechamento das abas anteriores');
      return result;
    });

    this.register('task.itemResult', (payload, auth) => db.transaction(() => {
      const i = z.object({
        itemId: z.string().min(1), claimToken: z.string().uuid(), ok: z.boolean(), message: z.string().max(1000).optional(),
        accountId: z.string().min(1).optional(), externalListingId: z.string().min(1).optional(),
        baseline: z.object({ title: z.string().max(5000).nullable(), description: z.string().max(20000).nullable() }).optional(),
        sourceUrl: z.string().url().optional(),
      }).parse(payload);
      const current = db.row<{ status: string; task_status: string; active: number; account_id: string; external_id: string; draft_claim_token: string | null }>(`SELECT ti.draft_claim_token,ti.status,t.status AS task_status,a.is_active AS active,ti.account_id,l.external_id FROM task_items ti JOIN tasks t ON t.id=ti.task_id JOIN listings l ON l.id=ti.listing_id AND l.account_id=ti.account_id AND l.marketplace=ti.marketplace JOIN accounts a ON a.id=ti.account_id AND a.marketplace=ti.marketplace WHERE ti.id=?`, i.itemId);
      if (!current || current.status !== 'PROCESSING' || !['RUNNING','WAITING_BROWSER','PAUSED'].includes(current.task_status) || !current.active) throw new Error('item não está em execução em uma conta ativa');
      if (i.claimToken !== current.draft_claim_token) throw new Error('resultado de execução anterior ou não reivindicada');
      if (i.accountId !== current.account_id || i.externalListingId !== current.external_id) throw new Error('resultado não corresponde à conta e ao anúncio reivindicados');
      if (i.ok) {
        if (!i.baseline || !i.sourceUrl) throw new Error('snapshot original do anúncio é obrigatório para concluir o rascunho');
        const item = db.row<{ marketplace: string; account_id: string; listing_id: string; title: string | null; description_additions: string | null; external_id: string }>(
          `SELECT ti.marketplace,ti.account_id,ti.listing_id,ti.title,ti.description_additions,l.external_id
             FROM task_items ti JOIN listings l ON l.id=ti.listing_id AND l.account_id=ti.account_id AND l.marketplace=ti.marketplace WHERE ti.id=?`, i.itemId,
        );
        if (!item) throw new Error('item da tarefa/anúncio não encontrado');
        if (i.accountId !== item.account_id || i.externalListingId !== item.external_id) throw new Error('snapshot não corresponde à conta e ao anúncio reivindicados');
        const url = new URL(i.sourceUrl);
        const allowedHost = item.marketplace === 'mercado_livre' ? /(^|\.)mercadolivre\.com\.br$/i : item.marketplace === 'shopee' ? /(^|\.)shopee\.com\.br$/i : null;
        if (url.protocol !== 'https:' || !allowedHost?.test(url.hostname)) throw new Error('URL do snapshot fora do domínio do marketplace');
        if ((item.title && i.baseline.title === null) || (item.description_additions && i.baseline.description === null)) {
          throw new Error('snapshot original incompleto para o campo alterado');
        }
        db.db.prepare(`UPDATE task_items SET before_title=?,before_description=?,baseline_source_url=?,baseline_captured_at=? WHERE id=?`)
          .run(i.baseline.title, i.baseline.description, i.sourceUrl, nowIso(), i.itemId);
      }
      const result = tasks.completeDraftItem(i.itemId, i.ok, i.message);
      this.audit(auth, 'TASK_ITEM_RESULT', 'task_item', i.itemId, i.ok ? 'OK' : 'FAILED', i.message);
      return result;
    }));

    // Publicação é uma segunda etapa: só um super_admin pode autorizar e cada
    // anúncio recebe confirmação independente no navegador ativo.
    this.register('task.approvePublish', (payload, auth) => {
      const i = z.object({ taskId: z.string().min(1), confirmation: z.string().min(1).max(80), reason: z.string().min(3).max(500) }).parse(payload ?? {});
      if (!auth || auth.role !== 'super_admin') throw new Error('somente super_admin pode autorizar publicação remota');
      const task = tasks.get(i.taskId);
      if (!task || task.mode !== 'DRAFT' || task.status !== 'COMPLETED') throw new Error('a tarefa precisa estar concluída como DRAFT antes da aprovação');
      if (!['edit_title','edit_description'].includes(task.kind)) throw new Error('publicação assistida só suporta alteração de título ou acréscimo de descrição');
      const items = tasks.items(i.taskId);
      if (new Set(items.map((item) => item.listing_id)).size !== items.length) throw new Error('o mesmo anúncio não pode aparecer duas vezes no mesmo lote');
      if (task.kind === 'edit_title' && items.some((item) => !item.title?.trim() || Boolean(item.description_additions))) throw new Error('lote de título deve conter somente um novo título por anúncio');
      if (task.kind === 'edit_description' && items.some((item) => !item.description_additions?.trim() || Boolean(item.title))) throw new Error('lote de descrição deve conter somente acréscimos por anúncio');
      if (!items.length || items.length > 10) throw new Error('aprovação limitada a 1–10 anúncios por lote');
      if (i.confirmation !== `PUBLICAR ${items.length}`) throw new Error(`confirmação incorreta; digite exatamente PUBLICAR ${items.length}`);
      if (items.some((item) => item.status !== 'COMPLETED' || item.copies !== 1 || item.cover_image_id)) {
        throw new Error('todos os itens precisam ser rascunhos preenchidos, sem duplicação/troca de imagem');
      }
      for (const item of items) {
        const baseline = db.row<{ before_title: string | null; before_description: string | null; baseline_source_url: string | null; baseline_captured_at: string | null }>(
          'SELECT before_title,before_description,baseline_source_url,baseline_captured_at FROM task_items WHERE id=? AND task_id=?', item.id, i.taskId,
        );
        const originalValue = task.kind === 'edit_title' ? baseline?.before_title : baseline?.before_description;
        const capturedAt = baseline?.baseline_captured_at ? Date.parse(baseline.baseline_captured_at) : Number.NaN;
        if (!baseline?.baseline_source_url || originalValue === null || originalValue === undefined || !Number.isFinite(capturedAt) || Date.now() - capturedAt > 30 * 60_000) {
          throw new Error(`item ${item.id} sem snapshot original recente e verificável; reabra o anúncio e gere novamente o rascunho`);
        }
      }
      const accountIds = new Set(items.map((item) => item.account_id));
      const marketplaces = new Set(items.map((item) => item.marketplace));
      if (accountIds.size !== 1 || marketplaces.size !== 1) throw new Error('um lote de publicação deve conter uma única conta e marketplace');
      const accountId = items[0]!.account_id;
      const marketplace = items[0]!.marketplace;
      const account = db.row<{ id: string; marketplace: string; is_active: number; verified_by_user: number }>(
        'SELECT id,marketplace,is_active,verified_by_user FROM accounts WHERE id=?', accountId,
      );
      if (!account || account.marketplace !== marketplace || account.is_active !== 1 || account.verified_by_user !== 1) {
        throw new Error('conta inativa, não verificada ou incompatível com o marketplace');
      }
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const approvalIds: string[] = [];
      db.transaction(() => {
        for (const item of items) {
          const listing = db.row<{ external_id: string; status: string }>(
            'SELECT external_id,status FROM listings WHERE id=? AND account_id=? AND marketplace=?', item.listing_id, accountId, marketplace,
          );
          if (!listing || listing.status === 'CLOSED') throw new Error(`anúncio ${item.listing_id} não está ativo na conta autorizada`);
          const id = randomUUID();
          approvalIds.push(id);
          db.db.prepare(`INSERT INTO task_publish_approvals
            (id,task_id,item_id,account_id,marketplace,external_listing_id,status,approved_by,approved_at,expires_at,reason)
            VALUES (?,?,?,?,?,?,'APPROVED',?,?,?,?)`)
            .run(id, i.taskId, item.id, accountId, marketplace, listing.external_id, auth.userId, nowIso(), expiresAt, i.reason);
          const itemTransition = db.db.prepare("UPDATE task_items SET status='APPROVED_TO_PUBLISH',last_error=NULL WHERE id=? AND task_id=? AND status='COMPLETED'")
            .run(item.id, i.taskId);
          if (Number(itemTransition.changes) !== 1) throw new Error(`item ${item.id} mudou de estado durante a aprovação; nenhum lote foi autorizado`);
        }
      });
      this.audit(auth, 'TASK_PUBLISH_APPROVED', 'task', i.taskId, 'APPROVED', `${items.length} anúncio(s), conta ${accountId}, marketplace ${marketplace}; expira ${expiresAt}; ${i.reason}`);
      return { ok: true, taskId: i.taskId, approvalIds, approvedItems: items.length, expiresAt, requiresPerListingBrowserConfirmation: true, note: 'autorização de uso único; a extensão só tenta executar na aba ativa, com conta e ID exatos, e pede confirmação individual.' };
    });

    this.register('task.claimNextPublish', (payload) => {
      const i = z.object({ marketplace: z.enum(['mercado_livre','shopee']), accountId: z.string().min(1), externalListingId: z.string().min(1) }).parse(payload ?? {});
      return db.transaction(() => {
        const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
        const stale = db.rows<{ id: string; item_id: string }>(`SELECT id,item_id FROM task_publish_approvals WHERE status='EXECUTING' AND execution_started_at<?`, staleBefore);
        for (const row of stale) {
          db.db.prepare("UPDATE task_publish_approvals SET status='NEEDS_VERIFICATION',execution_finished_at=?,result_json=? WHERE id=? AND status='EXECUTING'")
            .run(nowIso(), JSON.stringify({ outcome: 'UNCERTAIN', message: 'worker reiniciado ou confirmação não recebida; não retentar para evitar publicação duplicada' }), row.id);
          db.db.prepare("UPDATE task_items SET status='UNCERTAIN',last_error='publicação pode ter sido enviada; verificação manual necessária' WHERE id=? AND status='PUBLISHING'")
            .run(row.item_id);
        }
        db.db.prepare("UPDATE task_publish_approvals SET status='EXPIRED' WHERE status='APPROVED' AND expires_at<=?").run(nowIso());
        db.db.prepare("UPDATE task_items SET status='FAILED',last_error='autorização de publicação expirou' WHERE status='APPROVED_TO_PUBLISH' AND id IN (SELECT item_id FROM task_publish_approvals WHERE status='EXPIRED')");
        const matches = db.rows<Record<string, any>>(`SELECT a.id approval_id,a.task_id,a.item_id,a.account_id,a.marketplace,a.external_listing_id,
            t.name task_name,t.kind task_kind,t.typing_json,i.listing_id,i.copies,i.title,i.description_additions,
            i.before_title,i.before_description,i.baseline_source_url
          FROM task_publish_approvals a
          JOIN tasks t ON t.id=a.task_id
          JOIN task_items i ON i.id=a.item_id AND i.task_id=t.id
          JOIN listings l ON l.id=i.listing_id AND l.account_id=i.account_id AND l.marketplace=i.marketplace
          JOIN accounts ac ON ac.id=a.account_id AND ac.marketplace=a.marketplace AND ac.is_active=1 AND ac.verified_by_user=1
          WHERE a.status='APPROVED' AND a.expires_at>? AND a.marketplace=? AND a.account_id=? AND a.external_listing_id=?
            AND i.status='APPROVED_TO_PUBLISH' AND l.status<>'CLOSED'
            AND NOT EXISTS (SELECT 1 FROM listing_api_executions remote WHERE remote.account_id=i.account_id AND remote.listing_id=i.listing_id AND remote.status<>'REMOTE_VERIFIED')
            AND NOT EXISTS (SELECT 1 FROM listing_browser_executions browser WHERE browser.account_id=i.account_id AND browser.listing_id=i.listing_id AND browser.status IN ('CLAIMED','NEEDS_VERIFICATION'))
            AND NOT EXISTS (SELECT 1 FROM task_items busy WHERE busy.account_id=i.account_id AND busy.listing_id=i.listing_id AND busy.id<>i.id AND busy.status IN ('PROCESSING','PUBLISHING','UNCERTAIN'))
          ORDER BY a.approved_at LIMIT 2`, nowIso(), i.marketplace, i.accountId, i.externalListingId);
        if (matches.length > 1) return { ambiguous: true };
        const match = matches[0];
        if (!match) return null;
        const updated = db.db.prepare("UPDATE task_publish_approvals SET status='EXECUTING',execution_started_at=? WHERE id=? AND status='APPROVED'")
          .run(nowIso(), match.approval_id);
        if (Number(updated.changes) !== 1) return null;
        const itemStarted = db.db.prepare("UPDATE task_items SET status='PUBLISHING' WHERE id=? AND status='APPROVED_TO_PUBLISH'")
          .run(match.item_id);
        if (Number(itemStarted.changes) !== 1) throw new Error('item não está mais aguardando publicação; autorização revertida pela transação');
        return {
          approvalId: match.approval_id,
          task: { id: match.task_id, name: match.task_name, kind: match.task_kind, mode: 'PUBLISH', typing_json: match.typing_json },
          item: { id: match.item_id, task_id: match.task_id, listing_id: match.listing_id, account_id: match.account_id, marketplace: match.marketplace, copies: match.copies, title: match.title, description_additions: match.description_additions, baselineTitle: match.before_title, baselineDescription: match.before_description, baselineSourceUrl: match.baseline_source_url },
          externalListingId: match.external_listing_id,
        };
      });
    });

    this.register('task.publishResult', (payload, auth) => {
      if (!auth || auth.role !== 'super_admin') throw new Error('somente super_admin pode registrar o resultado de uma publicação autorizada');
      const i = z.object({ approvalId: z.string().min(1), externalListingId: z.string().min(1), outcome: z.enum(['PUBLISHED','CANCELLED','FAILED','UNCERTAIN']), message: z.string().max(1000).optional(), after: z.object({ title: z.string().max(5000).nullable(), description: z.string().max(20000).nullable() }).optional(), sourceUrl: z.string().url().optional(), successText: z.string().max(500).optional(), saveButtonLabel: z.string().max(120).optional() }).parse(payload ?? {});
      const approval = db.row<Record<string, any>>(`SELECT a.*,i.listing_id,i.before_title,i.before_description,i.baseline_source_url,i.title approved_title,i.description_additions approved_description_additions,t.kind task_kind
        FROM task_publish_approvals a
        JOIN task_items i ON i.id=a.item_id AND i.task_id=a.task_id
        JOIN tasks t ON t.id=a.task_id WHERE a.id=?`, i.approvalId);
      if (!approval || approval.status !== 'EXECUTING') throw new Error('aprovação inexistente ou já consumida');
      if (i.externalListingId !== approval.external_listing_id) throw new Error('resultado não corresponde ao anúncio autorizado');
      if (i.outcome === 'PUBLISHED') {
        if (!i.after || !i.successText || !i.saveButtonLabel || !i.sourceUrl) throw new Error('evidência de publicação incompleta; resultado não será marcado como publicado');
        const page = new URL(i.sourceUrl);
        const baselinePage = approval.baseline_source_url ? new URL(approval.baseline_source_url) : null;
        if (page.protocol !== 'https:' || !baselinePage || page.hostname !== baselinePage.hostname || !((approval.marketplace === 'mercado_livre' && /(^|\.)mercadolivre\.com\.br$/i.test(page.hostname)) || (approval.marketplace === 'shopee' && /(^|\.)shopee\.com\.br$/i.test(page.hostname)))) throw new Error('URL de evidência fora do domínio original autorizado');
        if (approval.task_kind === 'edit_title') {
          if (approval.before_title === null || !approval.approved_title || i.after.title !== approval.approved_title || approval.before_title === i.after.title) throw new Error('título pós-publicação não corresponde à alteração aprovada ou não há valor original');
        }
        if (approval.task_kind === 'edit_description') {
          if (approval.before_description === null || !approval.approved_description_additions || !String(i.after.description ?? '').includes(approval.approved_description_additions) || String(approval.before_description).includes(approval.approved_description_additions)) throw new Error('descrição pós-publicação não corresponde à alteração aprovada ou não há valor original');
        }
      }
      const terminal = i.outcome === 'PUBLISHED' ? 'PUBLISHED' : i.outcome === 'CANCELLED' ? 'CANCELLED' : i.outcome === 'UNCERTAIN' ? 'NEEDS_VERIFICATION' : 'FAILED';
      const itemStatus = i.outcome === 'PUBLISHED' ? 'PUBLISHED' : i.outcome === 'CANCELLED' ? 'SKIPPED' : i.outcome === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED';
      db.transaction(() => {
        const consumed = db.db.prepare("UPDATE task_publish_approvals SET status=?,execution_finished_at=?,result_json=? WHERE id=? AND status='EXECUTING'")
          .run(terminal, nowIso(), JSON.stringify({ outcome: i.outcome, message: i.message ?? null, before: { title: approval.before_title, description: approval.before_description }, after: i.after ?? null, sourceUrl: i.sourceUrl ?? null, successText: i.successText ?? null, saveButtonLabel: i.saveButtonLabel ?? null }), i.approvalId);
        if (Number(consumed.changes) !== 1) throw new Error('a autorização já foi consumida por outra execução');
        const itemFinished = db.db.prepare("UPDATE task_items SET status=?,last_error=? WHERE id=? AND status='PUBLISHING'")
          .run(itemStatus, i.outcome === 'PUBLISHED' ? null : (i.message ?? terminal).slice(0,1000), approval.item_id);
        if (Number(itemFinished.changes) !== 1) throw new Error('item não está mais em execução; resultado remoto não será aceito');
        if (i.outcome === 'PUBLISHED' && i.after) {
          const field = approval.task_kind === 'edit_title' ? 'title' : 'description';
          const beforeText = field === 'title' ? approval.before_title : approval.before_description;
          const afterText = field === 'title' ? i.after.title : i.after.description;
          if (beforeText === null || afterText === null || beforeText === afterText) throw new Error('não há mudança verificável para registrar');
          db.db.prepare(`INSERT INTO change_sets (id,account_id,listing_id,field,before_text,after_text,diff_json,preservation_ok,verified_after_save,applied_at,actor_user_id,task_id)
            VALUES (?,?,?,?,?,?,?,1,1,?,?,?)`)
            .run(randomUUID(), approval.account_id, approval.listing_id, field, beforeText, afterText, JSON.stringify({source:'human_confirmed_marketplace_save',successText:i.successText}), nowIso(), auth.userId, approval.task_id);
        }
      });
      this.audit(auth, 'TASK_PUBLISH_RESULT', 'task_item', approval.item_id, terminal, i.message ?? i.successText ?? i.outcome);
      return { ok: true, status: terminal, itemStatus, manualVerificationRequired: i.outcome === 'UNCERTAIN' };
    });

    this.register('task.rollbackPrepare', (payload, auth) => {
      const i = z.object({ approvalId: z.string().min(1) }).parse(payload ?? {});
      const approval = db.row<Record<string, any>>(`SELECT a.*,i.listing_id FROM task_publish_approvals a JOIN task_items i ON i.id=a.item_id AND i.task_id=a.task_id WHERE a.id=? AND a.status='PUBLISHED'`, i.approvalId);
      if (!approval) throw new Error('publicação verificada não encontrada');
      const change = db.row<{ before_text: string; after_text: string; field: string }>(
        `SELECT before_text,after_text,field FROM change_sets WHERE task_id=? AND listing_id=? AND field='title' ORDER BY applied_at DESC LIMIT 1`, approval.task_id, approval.listing_id,
      );
      if (!change) throw new Error('rollback assistido disponível somente para título; descrição exige revisão manual do texto original');
      const listing = db.row<{ external_id: string; marketplace: string; title: string | null }>('SELECT external_id,marketplace,title FROM listings WHERE id=? AND account_id=?', approval.listing_id, approval.account_id);
      if (!listing) throw new Error('anúncio original não está mais disponível na conta');
      const created = tasks.create({
        name: `Reverter título · ${listing.external_id}`, kind: 'edit_title', accountId: approval.account_id, mode: 'DRAFT', scheduleAt: null, recurrence: null,
        typing: { mode: 'set_value', charDelayMs: 0, settleDelayMs: 300, verifyAfterTyping: true },
        options: { rollbackOfApproval: approval.id, sourceTaskId: approval.task_id }, createdBy: auth?.userId ?? 'system',
        items: [{ listingId: listing.external_id, marketplace: listing.marketplace as 'mercado_livre' | 'shopee', accountId: approval.account_id, copies: 1, title: change.before_text }],
      });
      this.audit(auth, 'TASK_ROLLBACK_DRAFT_PREPARE', 'task', created.taskId, 'DRAFT_CREATED', `rascunho de reversão para aprovação ${approval.id}`);
      return { ok: true, taskId: created.taskId, execution: 'DRAFT_ONLY', note: 'rascunho restaurador criado; precisa ser revisado, preenchido e autorizado separadamente. Nenhuma chamada remota foi feita.' };
    });

    // ------------------------------------------------------------ guard
    this.register('guard.evaluate', (payload, auth) => {
      // Um pedido sem as seções obrigatórias estourava dentro do guard com
      // "Cannot read properties of undefined". Agora responde validação clara.
      const parsed = z
        .object({
          action: z.enum(['edit_title', 'edit_description', 'upload_image', 'change_price', 'duplicate_listing', 'toggle_ads','change_campaign_budget','create_variation','edit_variation']),
          campaign:z.object({id:z.string(),accountId:z.string()}).nullable().optional(),
          actorRole: z.enum(['super_admin', 'operador', 'visualizador']).optional(),
          marketplace: z.object({ id: z.string(), enabled: z.boolean() }),
          account: z
            .object({ id: z.string(), marketplace: z.string(), sessionState: z.string(), verified: z.boolean() })
            .nullable()
            .default(null),
          listing: z
            .object({ id: z.string(), accountId: z.string(), externalId: z.string(), status: z.string() })
            .nullable()
            .default(null),
          currentState: z.record(z.string(), z.unknown()).nullable().default(null),
          financialLimits: z.record(z.string(), z.unknown()).nullable().default(null),
          requiredData: z.object({ missing: z.array(z.string()) }).default({ missing: [] }),
          platformRules: z.object({ violations: z.array(z.string()) }).default({ violations: [] }),
          authorization: z.object({ approved: z.boolean(), approvedBy: z.string().optional(), reason: z.string().optional() }).default({ approved: false }),
          conflicts: z.array(z.string()).default([]),
        })
        .safeParse(payload ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          error: `contexto do guard incompleto: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        };
      }
      const ctx = parsed.data as unknown as GuardContext;
      const decision = evaluateGuard({ ...ctx, actorRole: auth?.role ?? ctx.actorRole });
      this.audit(auth, 'GUARD_EVALUATE', 'listing', ctx.listing?.id ?? null, decision.allowed ? 'ALLOWED' : 'BLOCKED', decision.blockedReasons.join('; '));
      return decision;
    });

    // ------------------------------------------------------------ auditoria
    this.register('audit.list', (payload) => {
      const i = z.object({ limit: z.number().int().min(1).max(500).default(100) }).parse(payload ?? {});
      return db.rows<Record<string, unknown>>('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?', i.limit);
    });

    this.register('audit.rollback', (payload, auth) => {
      const i = z.object({ changeSetId: z.string() }).parse(payload);
      const cs = db.row<{ id: string; listing_id: string; field: string; before_text: string | null; after_text: string | null }>(
        'SELECT id, listing_id, field, before_text, after_text FROM change_sets WHERE id = ?',
        i.changeSetId,
      );
      if (!cs) throw new Error('change set inexistente');
      db.db.prepare('UPDATE change_sets SET rolled_back_at = ? WHERE id = ?').run(new Date().toISOString(), i.changeSetId);
      this.audit(auth, 'ROLLBACK', 'change_set', i.changeSetId, 'OK', `campo ${cs.field}`);
      return { ok: true, field: cs.field, restoreValue: cs.before_text, note: 'reaplicação no marketplace exige execução de tarefa aprovada' };
    });

    this.register('adapter.diagnostics', (payload) => {
      const i = z.object({ marketplace: z.string(), observed: z.record(z.string(), z.number()).default({}) }).parse(payload);
      const adapter = IMPLEMENTED_ADAPTERS.find((a) => a.id === i.marketplace);
      if (!adapter) return { ok: false, error: `adapter ${i.marketplace} não implementado`, planned: PLANNED_ADAPTERS };
      return { ok: true, diagnostics: adapter.diagnose(i.observed) };
    });

    // ------------------------------------------------------------ keywords / rank
    const seoAccount=z.object({accountId:z.string().min(1)});
    const seoRun=seoAccount.extend({id:z.string().uuid()}).strict();
    this.register('seo.config.status',()=>this.externalSeo.status());
    this.register('seo.config.save',(payload,auth)=>{if(auth?.role!=='super_admin')throw Error('super_admin necessário');const result=this.externalSeo.configure(payload);this.audit(auth,'SEO_CONFIG_SAVE','dataforseo',null,'OK');return result;});
    this.register('seo.config.clear',(_payload,auth)=>{if(auth?.role!=='super_admin')throw Error('super_admin necessário');const result=this.externalSeo.disconnect();this.audit(auth,'SEO_CONFIG_CLEAR','dataforseo',null,'OK');return result;});
    this.register('seo.external.volume',async(payload,auth)=>{
      if(auth?.role!=='super_admin')throw Error('super_admin necessário para consulta externa tarifada');
      const i=z.object({accountId:z.string().min(1),terms:z.array(googleAdsTerm).min(1).max(20),confirmed:z.literal(true)}).strict().parse(payload);
      const result=await this.externalSeo.volume(i.accountId,i.terms);
      this.audit(auth,'GOOGLE_ADS_SEARCH_VOLUME','account',i.accountId,'OK',String(result.items.length)+' termos');return result;
    });
    this.register('seo.external.research',async(payload,auth)=>{
      if(auth?.role!=='super_admin')throw Error('super_admin necessário para consulta externa tarifada');
      const {accountId,...input}=seoResearchInput.extend({accountId:z.string().min(1)}).strict().parse(payload);
      const result=await this.externalSeo.execute(accountId,input);
      this.audit(auth,'SEO_EXTERNAL_RESEARCH','account',accountId,result.status,undefined,{mode:result.mode,scope:result.scope,costUsd:result.costUsd,providerCode:result.providerCode});
      return result;
    });
    this.register('seo.external.history',payload=>{
      const i=seoAccount.extend({limit:z.number().int().min(1).max(200).default(50)}).strict().parse(payload);
      return this.externalSeo.history(i.accountId,i.limit);
    });
    this.register('seo.external.get',payload=>{
      const i=seoRun.parse(payload),run=this.externalSeo.get(i.accountId,i.id);
      const {result_json,...meta}=run;return {...meta,rows:JSON.parse(result_json)};
    });
    this.register('seo.external.gap',payload=>{
      const i=seoAccount.extend({ownId:z.string().uuid(),otherId:z.string().uuid()}).strict().parse(payload);
      return this.externalSeo.gap(i.accountId,i.ownId,i.otherId);
    });
    this.register('seo.external.groups',payload=>{
      const i=seoRun.parse(payload);return this.externalSeo.groups(i.accountId,i.id);
    });
    this.register('seo.external.opportunities',async(payload,auth)=>{
      const i=seoRun.extend({periodStart:z.string().datetime(),periodEnd:z.string().datetime()}).strict().parse(payload);
      if(i.periodStart>i.periodEnd||Date.parse(i.periodEnd)>Date.now()||Date.parse(i.periodEnd)-Date.parse(i.periodStart)>366*86400000)throw Error('Intervalo financeiro inválido.');
      const keywords=this.externalSeo.keywords(i.accountId,i.id);
      const profitHandler=this.handlers.get('finance.profitability'),inventoryHandler=this.handlers.get('inventory.dashboard');
      if(!profitHandler||!inventoryHandler)throw Error('Indicadores internos indisponíveis.');
      const profits=z.object({listings:z.array(z.object({id:z.string(),profitCents:z.number().nullable(),marginPct:z.number().nullable(),status:z.string()}))}).parse(await profitHandler({accountId:i.accountId,periodStart:i.periodStart,periodEnd:i.periodEnd},auth));
      const inventory=z.object({items:z.array(z.object({id:z.string(),stock:z.number().nullable(),units:z.number().nullable(),adSpend:z.number().nullable(),capturedAt:z.string().nullable(),window:z.unknown()}))}).parse(await inventoryHandler({accountId:i.accountId,days:30},auth));
      const listings=db.rows<{id:string;title:string|null;external_id:string}>('SELECT id,title,external_id FROM listings WHERE account_id=? ORDER BY id LIMIT 1000',i.accountId);
      return {periodStart:i.periodStart,periodEnd:i.periodEnd,rows:correlateSeoListings(keywords,listings,profits.listings,inventory.items.map(row=>({...row,window:row.window}))),note:'Demanda do Google e aderência lexical não comprovam demanda interna ou causalidade. Margem do intervalo exato e estoque/vendas/Ads da última captura em 30 dias são exibidos separadamente. Nenhuma ordem de investimento.'};
    });
    this.register('seo.watch.create',(payload,auth)=>{
      if(auth?.role!=='super_admin')throw Error('super_admin necessário para agendamento tarifado');
      const result=this.externalSeo.addWatch(payload);this.audit(auth,'SEO_WATCH_CREATE','seo_rank_watch',result.id,'OK');return result;
    });
    this.register('seo.watch.list',payload=>this.externalSeo.watches(seoAccount.strict().parse(payload).accountId));
    this.register('seo.watch.disable',(payload,auth)=>{
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      const i=seoRun.parse(payload);return this.externalSeo.disable(i.accountId,i.id);
    });
    this.register('seo.watch.history',payload=>{const i=seoRun.parse(payload);return this.externalSeo.rankHistory(i.accountId,i.id);});
    this.register('keyword.upsert', (payload, auth) => {
      const i = z
        .object({
          term: z.string().min(2).max(200),
          marketplace: z.string(),
          intent: z.string(),
          language: z.string().default('pt-BR'),
        })
        .parse(payload);
      const normalized = i.term.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
      const existing = db.row<{ id: string }>('SELECT id FROM keywords WHERE marketplace = ? AND normalized = ?', i.marketplace, normalized);
      const id = existing?.id ?? randomUUID();
      if (!existing) {
        db.db
          .prepare('INSERT INTO keywords (id, term, normalized, language, intent, marketplace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, i.term, normalized, i.language, i.intent, i.marketplace, new Date().toISOString(), new Date().toISOString());
      }
      this.audit(auth, 'KEYWORD_UPSERT', 'keyword', id, 'OK');
      return { ok: true, id };
    });

    this.register('keyword.list', (payload) => {
      const i = z.object({ marketplace: z.string().optional(), limit: z.number().int().min(1).max(1000).default(200) }).parse(payload ?? {});
      return i.marketplace
        ? db.rows<Record<string, unknown>>('SELECT * FROM keywords WHERE marketplace = ? ORDER BY updated_at DESC LIMIT ?', i.marketplace, i.limit)
        : db.rows<Record<string, unknown>>('SELECT * FROM keywords ORDER BY updated_at DESC LIMIT ?', i.limit);
    });

    this.register('keyword.gap', (payload) => {
      const i = z.object({ accountId: z.string() }).parse(payload);
      return db.rows<Record<string, unknown>>('SELECT * FROM keyword_competitor_gaps WHERE account_id = ? ORDER BY computed_at DESC', i.accountId);
    });

    this.register('keyword.googleVolume',async(payload,auth)=>{
      const input=z.object({
        accountId:z.string().min(1),terms:z.array(googleAdsTerm).min(1).max(20),
        login:z.string().trim().min(1).max(254).regex(/^[^:\r\n]+$/),
        password:z.string().min(1).max(256),confirmedPaidRequest:z.literal(true),
      }).strict().parse(payload);
      if(!db.row('SELECT id FROM accounts WHERE id=? AND is_active=1',input.accountId))throw Error('conta ativa não encontrada');
      const result=await this.externalSeo.volume(input.accountId,input.terms,{login:input.login,password:input.password});
      this.audit(auth,'GOOGLE_ADS_SEARCH_VOLUME','account',input.accountId,'OK',String(result.items.length)+' termos');
      return result;
    });
    this.register('keyword.suggest', (payload) => {
      const i = z.object({ accountId: z.string().min(1), marketplace: z.enum(['mercado_livre','shopee','amazon']).optional(), limit: z.number().int().min(1).max(200).default(80) }).parse(payload ?? {});
      const account = db.row<{id:string;marketplace:string}>('SELECT id,marketplace FROM accounts WHERE id=? AND is_active=1', i.accountId);
      if (!account) throw new Error('conta ativa não encontrada');
      if (i.marketplace && i.marketplace !== account.marketplace) throw new Error('marketplace não corresponde à conta');
      const marketplace = i.marketplace ?? account.marketplace;
      const titles = db.rows<{title:string|null}>('SELECT title FROM listings WHERE account_id=? AND marketplace=? AND title IS NOT NULL UNION ALL SELECT title FROM own_products WHERE account_id=? AND marketplace=?', i.accountId, marketplace, i.accountId, marketplace);
      const stop = new Set(['para','com','sem','por','uma','uns','das','dos','the','and','with','de','da','do','e','em','no','na','ao','aos','as','os','um','kit','original']);
      const frequency = new Map<string,{term:string;count:number;sourceTitles:Set<number>}>();
      titles.forEach((row,index) => {
        const tokens = String(row.title ?? '').toLocaleLowerCase('pt-BR').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter((t) => t.length >= 2 && !stop.has(t));
        const seen = new Set<string>();
        for (let size=2;size<=4;size++) for (let at=0;at<=tokens.length-size;at++) {
          const term = tokens.slice(at,at+size).join(' ');
          if (seen.has(term)) continue;
          seen.add(term);
          const value = frequency.get(term) ?? { term, count:0, sourceTitles:new Set<number>() };
          value.count += 1; value.sourceTitles.add(index); frequency.set(term,value);
        }
      });
      const known = new Set(db.rows<{normalized:string}>('SELECT normalized FROM keywords WHERE marketplace=?', marketplace).map((r) => r.normalized));
      return [...frequency.values()].filter((item) => !known.has(item.term)).sort((a,b) => b.count-a.count || b.term.length-a.term.length || a.term.localeCompare(b.term,'pt-BR')).slice(0,i.limit).map((item) => ({
        term:item.term, localFrequency:item.count, sourceTitles:item.sourceTitles.size,
        source:'LOCAL_CATALOG_TITLES', demandLabel:'FREQUENCIA_NO_CATALOGO',
        confidence: Math.min(0.9,0.3 + item.sourceTitles.size * 0.08),
        note:'Sugestão lexical derivada dos títulos cadastrados; não representa volume de busca nem demanda externa.',
      }));
    });

    this.register('keyword.cluster', (payload, auth) => {
      const i = z.object({ marketplace: z.enum(['mercado_livre','shopee','amazon']), threshold: z.number().min(0.1).max(1).default(0.25) }).parse(payload ?? {});
      const rows = db.rows<{id:string;term:string;normalized:string;cluster_id:string|null}>('SELECT k.id,k.term,k.normalized,k.cluster_id FROM keywords k LEFT JOIN keyword_clusters c ON c.id=k.cluster_id WHERE k.marketplace=? AND (k.cluster_id IS NULL OR COALESCE(c.corrected_manually,0)=0) ORDER BY k.term',i.marketplace);
      const tokens = rows.map((row) => new Set(row.normalized.split(/\s+/).filter((t) => t.length>2)));
      const parent = rows.map((_,index) => index);
      const find = (value:number):number => parent[value]===value ? value : (parent[value]=find(parent[value]!));
      const union = (a:number,b:number) => { const x=find(a),y=find(b); if (x!==y) parent[y]=x; };
      for (let a=0;a<rows.length;a++) for (let b=a+1;b<rows.length;b++) {
        const left=tokens[a]!,right=tokens[b]!; const intersection=[...left].filter((t)=>right.has(t)).length;
        const unionSize=new Set([...left,...right]).size; const score=unionSize ? intersection/unionSize : 0;
        if (score>=i.threshold) union(a,b);
      }
      const groups=new Map<number,number[]>();
      rows.forEach((_,index)=>{ const rootIndex=find(index); const group=groups.get(rootIndex)??[]; group.push(index); groups.set(rootIndex,group); });
      let created=0,assigned=0;
      db.transaction(() => {
        const generated = db.rows<{id:string}>('SELECT id FROM keyword_clusters WHERE marketplace=? AND method=? AND corrected_manually=0',i.marketplace,'TOKEN_OVERLAP_LOCAL');
        for (const cluster of generated) db.db.prepare('UPDATE keywords SET cluster_id=NULL WHERE cluster_id=?').run(cluster.id);
        db.db.prepare('DELETE FROM keyword_clusters WHERE marketplace=? AND method=? AND corrected_manually=0').run(i.marketplace,'TOKEN_OVERLAP_LOCAL');
        for (const indexes of groups.values()) {
          if (indexes.length<2) continue;
          const clusterId=randomUUID(); const terms=indexes.map((index)=>rows[index]!.term);
          const label=terms.slice().sort((a,b)=>a.length-b.length)[0]!.slice(0,120);
          db.db.prepare('INSERT INTO keyword_clusters (id,marketplace,label,method,corrected_manually,created_at) VALUES (?,?,?,?,0,?)').run(clusterId,i.marketplace,label,'TOKEN_OVERLAP_LOCAL',nowIso());
          for (const index of indexes) {
            const row=rows[index]!;
            if (row.cluster_id) {
              const manual=db.row<{corrected_manually:number}>('SELECT corrected_manually FROM keyword_clusters WHERE id=?',row.cluster_id);
              if (manual?.corrected_manually===1) continue;
            }
            db.db.prepare('UPDATE keywords SET cluster_id=?,updated_at=? WHERE id=?').run(clusterId,nowIso(),row.id);
            assigned++;
          }
          created++;
        }
      });
      this.audit(auth,'KEYWORD_CLUSTER','keyword_cluster',i.marketplace,'OK',`${created} grupos; ${assigned} termos`);
      return { marketplace:i.marketplace, clustersCreated:created, keywordsAssigned:assigned, method:'TOKEN_OVERLAP_LOCAL', threshold:i.threshold };
    });

    this.register('keyword.visibility', (payload, auth) => db.transaction(() => {
      const i=z.object({accountId:z.string().min(1),days:z.number().int().min(1).max(365).default(30)}).parse(payload ?? {});
      const account=db.row<{marketplace:string}>('SELECT marketplace FROM accounts WHERE id=? AND is_active=1',i.accountId);
      if(!account) throw new Error('conta ativa não encontrada');
      const to=nowIso(),from=new Date(Date.parse(to)-i.days*86_400_000).toISOString();
      const snapshots=db.rows<{id:string;term:string;captured_at:string;results_count:number}>('SELECT id,term,captured_at,results_count FROM search_snapshots WHERE account_id=? AND marketplace=? AND captured_at>=? AND captured_at<=? ORDER BY captured_at DESC,id DESC',i.accountId,account.marketplace,from,to);
      const summaries=snapshots.flatMap((snap)=>{
        const results=db.rows<{position:number;is_own:number}>('SELECT position,is_own FROM search_results WHERE snapshot_id=? AND position BETWEEN 1 AND 20 ORDER BY position',snap.id);
        if(!results.length||new Set(results.map(r=>r.position)).size!==results.length)return [];
        const own=results.filter((r)=>r.is_own===1);
        const weighted=results.reduce((sum,r)=>sum+1/Math.log2(Math.max(2,r.position+1)),0);
        const ownWeighted=own.reduce((sum,r)=>sum+1/Math.log2(Math.max(2,r.position+1)),0);
        return [{ term:snap.term,capturedAt:snap.captured_at,ownTop3:own.some((r)=>r.position<=3),ownTop10:own.some((r)=>r.position<=10),ownTop20:own.length>0,ownCount:own.length,totalCount:results.length,weightedShare:weighted>0?ownWeighted/weighted:null }];
      });
      const byTerm=new Map<string,typeof summaries>();
      for(const item of summaries){const group=byTerm.get(item.term)??[];group.push(item);byTerm.set(item.term,group);}
      const output=[...byTerm.entries()].map(([term,items])=>{
        const sample=items.length;
        const avg=(key:'ownTop3'|'ownTop10'|'ownTop20'|'weightedShare')=>{const values=items.map(x=>x[key]).filter((v)=>typeof v==='number'||typeof v==='boolean');return values.length?values.reduce<number>((sum,v)=>sum+(typeof v==='boolean'?(v?1:0):v as number),0)/values.length:null;};
        const result={term,sampleSize:sample,top3PresencePct:(avg('ownTop3')??0)*100,top10PresencePct:(avg('ownTop10')??0)*100,top20PresencePct:(avg('ownTop20')??0)*100,ownVisibilitySharePct:avg('weightedShare')===null?null:(avg('weightedShare') as number)*100,observedAt:nowIso()};
        db.db.prepare('INSERT INTO visibility_share_snapshots (id,account_id,marketplace,term,captured_at,top3_presence,top10_presence,top20_presence,own_share,sample_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),i.accountId,account.marketplace,term,result.observedAt,result.top3PresencePct,result.top10PresencePct,result.top20PresencePct,result.ownVisibilitySharePct,JSON.stringify(items));
        return result;
      });
      this.audit(auth,'KEYWORD_VISIBILITY','account',i.accountId,'OK',`${snapshots.length} snapshots observados`);
      return {accountId:i.accountId,marketplace:account.marketplace,days:i.days,snapshots:snapshots.length,excludedSnapshots:snapshots.length-summaries.length,terms:output,note:'Share de visibilidade calculado somente sobre resultados SERP previamente capturados; não é market share.'};
    }));

    this.register('keyword.cannibalization', (payload) => {
      const i=z.object({accountId:z.string().min(1),days:z.number().int().min(1).max(365).default(90)}).parse(payload ?? {});
      const from=new Date(Date.now()-i.days*86_400_000).toISOString();
      const rows=db.rows<{keyword_id:string;term:string;listing_id:string;external_id:string;title:string|null;avg_position:number|null;observations:number}> (
        `SELECT r.keyword_id,k.term,r.listing_id,l.external_id,l.title,AVG(r.position) AS avg_position,COUNT(*) AS observations
           FROM rank_observations r JOIN keywords k ON k.id=r.keyword_id JOIN listings l ON l.id=r.listing_id
          WHERE l.account_id=? AND r.keyword_id IS NOT NULL AND r.observed_at>=?
          GROUP BY r.keyword_id,r.listing_id ORDER BY k.term,avg_position`,i.accountId,from);
      const groups=new Map<string,typeof rows>();
      for(const row of rows){const group=groups.get(row.keyword_id)??[];group.push(row);groups.set(row.keyword_id,group);}
      return [...groups.values()].filter((group)=>new Set(group.map((r)=>r.listing_id)).size>1).map((group)=>({
        keywordId:group[0]!.keyword_id,term:group[0]!.term,listingCount:group.length,
        listings:group.map((row)=>({listingId:row.listing_id,externalId:row.external_id,title:row.title,averagePosition:row.avg_position,observations:row.observations})),
        diagnosis:'Mais de um anúncio próprio aparece para a mesma palavra-chave. Avaliar intenção, sobreposição e conversão antes de consolidar.',
      }));
    });

    this.register('rank.record', (payload, auth) => {
      const i = z
        .object({ listingId: z.string(), keywordId: z.string().nullable().default(null), position: z.number().int().min(0).max(500), isSponsored: z.boolean().default(false), context: z.record(z.string(), z.unknown()).default({}) })
        .parse(payload);
      db.db
        .prepare('INSERT INTO rank_observations (listing_id, keyword_id, position, is_sponsored, observed_at, context_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(i.listingId, i.keywordId, i.position, i.isSponsored ? 1 : 0, new Date().toISOString(), JSON.stringify(i.context));
      this.audit(auth, 'RANK_RECORD', 'listing', i.listingId, 'OK', `posição ${i.position}`);
      return { ok: true };
    });

    this.register('rank.history', (payload) => {
      const i = z.object({ listingId: z.string(), limit: z.number().int().min(1).max(500).default(100) }).parse(payload);
      return db.rows<Record<string, unknown>>('SELECT * FROM rank_observations WHERE listing_id = ? ORDER BY observed_at DESC LIMIT ?', i.listingId, i.limit);
    });

    // ------------------------------------------------------------ concorrência
    this.register('competitor.upsert', (payload, auth) => {
      const i = z
        .object({ accountId: z.string(), marketplace: z.string(), name: z.string(), handle: z.string().optional(), groupKind: z.enum(['EQUIVALENT', 'SUBSTITUTE', 'BRAND', 'SELLER', 'CATEGORY']) })
        .parse(payload);
      const id = randomUUID();
      db.db
        .prepare('INSERT INTO competitors (id, account_id, marketplace, name, handle, group_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, i.accountId, i.marketplace, i.name, i.handle ?? null, i.groupKind, new Date().toISOString());
      this.audit(auth, 'COMPETITOR_UPSERT', 'competitor', id, 'OK');
      return { ok: true, id };
    });

    this.register('competitor.list', (payload) => {
      const i = z.object({ accountId: z.string() }).parse(payload);
      return db.rows<Record<string, unknown>>('SELECT * FROM competitors WHERE account_id = ? ORDER BY created_at DESC', i.accountId);
    });

    this.register('competitor.timeline', (payload) => {
      const i = z.object({ competitorId: z.string(), limit: z.number().int().min(1).max(500).default(100) }).parse(payload);
      return db.rows<Record<string, unknown>>('SELECT * FROM competitor_events WHERE competitor_id = ? ORDER BY detected_at DESC LIMIT ?', i.competitorId, i.limit);
    });

    this.register('competitor.alerts', (payload) => {
      const i = z.object({ accountId: z.string().optional() }).parse(payload ?? {});
      return db.rows<Record<string, unknown>>('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200');
    });

    // ------------------------------- inteligência competitiva assistida (§22)
    this.register('competitor.ownProduct.upsert', (payload, auth) => {
      const r = this.competitors.upsertOwnProduct(payload);
      this.audit(auth, 'OWN_PRODUCT_UPSERT', 'own_product', r.id, 'OK');
      return r;
    });

    this.register('competitor.ownProduct.list', (payload) => {
      const i = z.object({ accountId: z.string() }).parse(payload);
      return this.competitors.listOwnProducts(i.accountId);
    });

    this.register('competitor.searchPlan',payload=>{
      const i=z.object({accountId:z.string().min(1),ownProductId:z.string().min(1),marketplaces:z.array(z.enum(['mercado_livre','shopee','amazon'])).min(1).max(3)}).strict().parse(payload);
      const own=db.row<{title:string;brand:string|null;model:string|null;attributes_json:string|null;sku:string|null}>(`SELECT o.title,o.brand,o.model,o.attributes_json,s.sku_code AS sku FROM own_products o JOIN accounts a ON a.id=o.account_id AND a.is_active=1 LEFT JOIN listings l ON l.id=o.listing_id AND l.account_id=o.account_id LEFT JOIN skus s ON s.id=l.sku_id AND s.account_id=o.account_id WHERE o.id=? AND o.account_id=?`,i.ownProductId,i.accountId);
      if(!own)throw Error('produto não pertence à conta ativa');
      const attrs=parseJsonObject(own.attributes_json??'{}');
      const queries=[{kind:'TITLE',term:own.title},{kind:'BRAND_MODEL',term:[own.brand,own.model].filter(Boolean).join(' ')},{kind:'SKU',term:own.sku??''},{kind:'ATTRIBUTES',term:[own.brand,own.model,...Object.values(attrs).filter(v=>typeof v==='string').slice(0,3)].filter(Boolean).join(' ')}];
      const unique=new Set<string>();
      const links=queries.filter(q=>{q.term=q.term.trim().slice(0,200);const key=q.term.toLowerCase();if(q.term.length<2||unique.has(key))return false;unique.add(key);return true;}).flatMap(q=>[...new Set(i.marketplaces)].map(m=>({marketplace:m,...q,url:m==='mercado_livre'?'https://lista.mercadolivre.com.br/'+encodeURIComponent(q.term):m==='shopee'?'https://shopee.com.br/search?keyword='+encodeURIComponent(q.term):'https://www.amazon.com.br/s?k='+encodeURIComponent(q.term),targetResults:20})));
      return {links,note:'Abra as buscas públicas e importe candidatos observados. Nenhuma busca remota ou posição foi confirmada pelo plano.'};
    });
    this.register('competitor.capturePublicSearch',(payload,auth)=>db.transaction(()=>{
      const i=z.object({accountId:z.string().min(1),ownProductId:z.string().min(1),marketplace:z.enum(['mercado_livre','shopee','amazon']),sourceUrl:z.string().url().max(2048),observedAt:z.string().datetime(),candidates:z.array(z.object({externalId:z.string().min(1).max(100),title:z.string().trim().min(2).max(500),url:z.string().url().max(2048),priceCents:z.number().int().nonnegative().nullable(),sponsored:z.boolean().nullable(),observedOrder:z.number().int().min(1).max(20)}).strict()).min(1).max(20)}).strict().parse(payload);
      if(!db.row('SELECT o.id FROM own_products o JOIN accounts a ON a.id=o.account_id AND a.is_active=1 WHERE o.id=? AND o.account_id=?',i.ownProductId,i.accountId))throw Error('produto não pertence à conta ativa');
      if(Math.abs(Date.now()-Date.parse(i.observedAt))>5*60000)throw Error('captura pública fora da janela de 5 minutos');
      const source=new URL(i.sourceUrl),allowed=(url:URL)=>url.protocol==='https:'&&!url.username&&!url.password&&!url.port;
      const searchPage=allowed(source)&&(i.marketplace==='mercado_livre'?source.hostname==='lista.mercadolivre.com.br':i.marketplace==='shopee'?source.hostname==='shopee.com.br'&&source.pathname==='/search'&&!!source.searchParams.get('keyword'):source.hostname==='www.amazon.com.br'&&source.pathname==='/s'&&!!source.searchParams.get('k'));
      if(!searchPage)throw Error('página pública de busca não reconhecida');
      if(new Set(i.candidates.map(r=>r.externalId)).size!==i.candidates.length||new Set(i.candidates.map(r=>r.observedOrder)).size!==i.candidates.length)throw Error('candidatos/ordem duplicados');
      for(const row of i.candidates){
        const url=new URL(row.url);
        const id=i.marketplace==='mercado_livre'?url.pathname.match(/(?:MLB-?)(\d{5,17})(?=[^0-9]|$)/i)?.[1]:i.marketplace==='shopee'?url.pathname.match(/(?:-i\.|\/product\/)(\d+)[./](\d+)(?:$|\/)/)?.slice(1).join('.'):url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:$|\/)/i)?.[1]?.toUpperCase();
        const canonical=i.marketplace==='mercado_livre'&&id?'MLB'+id:id;
        const host=i.marketplace==='mercado_livre'?/(^|\.)mercadolivre\.com\.br$/i.test(url.hostname):i.marketplace==='shopee'?url.hostname==='shopee.com.br':url.hostname==='www.amazon.com.br';
        if(!allowed(url)||!host||!canonical||canonical!==row.externalId||url.search||url.hash)throw Error('identidade pública do candidato incompatível');
      }
      const result=this.competitors.search({ownProductId:i.ownProductId,marketplaces:[i.marketplace],sourceClass:'A_PRIMARY_UI',discoveryMethod:'BUSCA_ASSISTIDA',candidates:i.candidates.map(row=>({marketplace:i.marketplace,externalId:row.externalId,title:row.title,url:row.url,priceCents:row.priceCents}))});
      for(const row of i.candidates){
        const candidate=db.row<{id:string}>('SELECT id FROM competitor_candidates WHERE own_product_id=? AND marketplace=? AND external_id=?',i.ownProductId,i.marketplace,row.externalId);if(!candidate)throw Error('candidato não persistido');
        db.db.prepare('INSERT INTO competitor_public_search_observations(id,run_id,account_id,own_product_id,candidate_id,marketplace,source_url,observed_at,observed_order,title,price_cents,sponsored) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),result.runId,i.accountId,i.ownProductId,candidate.id,i.marketplace,source.origin+source.pathname,i.observedAt,row.observedOrder,row.title,row.priceCents,row.sponsored===null?null:Number(row.sponsored));
      }
      this.audit(auth,'COMPETITOR_PUBLIC_SEARCH','own_product',i.ownProductId,'OK',String(i.candidates.length)+' cartões visíveis; ordem observada, não ranking completo');
      return {...result,observedCards:i.candidates.length,coverageVerified:false};
    }));
    this.register('competitor.search', (payload, auth) => {
      const r = this.competitors.search(payload);
      this.audit(auth, 'COMPETITOR_SEARCH', 'own_product', (payload as { ownProductId?: string })?.ownProductId ?? null, 'OK', undefined, r);
      return r;
    });

    this.register('competitor.relations', (payload) => {
      const i = z
        .object({
          ownProductId: z.string().optional(),
          accountId: z.string().optional(),
          status: z.enum(['PENDENTE', 'APROVADO', 'REJEITADO']).optional(),
        })
        .parse(payload ?? {});
      return this.competitors.listRelations(i);
    });

    this.register('competitor.approve', (payload, auth) => {
      const r = this.competitors.approve(payload);
      this.audit(auth, 'COMPETITOR_APPROVE', 'competitor_relation', (payload as { relationId?: string })?.relationId ?? null, 'OK');
      return r;
    });

    this.register('competitor.reject', (payload, auth) => {
      const r = this.competitors.reject(payload);
      this.audit(auth, 'COMPETITOR_REJECT', 'competitor_relation', (payload as { relationId?: string })?.relationId ?? null, 'OK');
      return r;
    });

    this.register('competitor.edit', (payload, auth) => {
      const r = this.competitors.edit(payload);
      this.audit(auth, 'COMPETITOR_EDIT', 'competitor_relation', (payload as { relationId?: string })?.relationId ?? null, 'OK');
      return r;
    });

    this.register('competitor.changeCandidate', (payload, auth) => {
      const r = this.competitors.changeCandidate(payload);
      this.audit(auth, 'COMPETITOR_CHANGE_CANDIDATE', 'competitor_relation', (payload as { relationId?: string })?.relationId ?? null, 'OK');
      return r;
    });

    this.register('competitor.reanalyze', (payload, auth) => {
      const r = this.competitors.reanalyze(payload);
      this.audit(auth, 'COMPETITOR_REANALYZE', 'competitor_relation', (payload as { relationId?: string })?.relationId ?? null, 'OK');
      return r;
    });

    this.register('competitor.monitoring.set', (payload, auth) => {
      const r = this.competitors.setMonitoring(payload);
      this.audit(auth, 'COMPETITOR_MONITORING_SET', 'competitor_relation', (payload as { relationId?: string })?.relationId ?? null, 'OK');
      return r;
    });

    this.register('competitor.monitoring.record', (payload, auth) => {
      const r = this.competitors.recordPoint(payload);
      this.audit(auth, 'COMPETITOR_MONITORING_RECORD', 'competitor_relation', (payload as { relationId?: string })?.relationId ?? null, 'OK');
      return r;
    });

    this.register('competitor.monitoring.history', (payload) => {
      const i = z.object({ relationId: z.string(), limit: z.number().int().min(1).max(1000).optional() }).parse(payload);
      return this.competitors.monitoring(i);
    });

    this.register('competitor.stats', (payload) => {
      const i = z.object({ accountId: z.string().optional(), ownProductId: z.string().optional() }).parse(payload ?? {});
      return this.competitors.stats(i);
    });

    // ------------------------------------------------------------ mercado, VOC, growth
    this.register('market.categorySnapshot', (payload) => {
      const i = z.object({ marketplace: z.string(), category: z.string() }).parse(payload);
      return db.rows<Record<string, unknown>>(
        'SELECT * FROM category_snapshots WHERE marketplace = ? AND category = ? ORDER BY captured_at DESC LIMIT 20',
        i.marketplace,
        i.category,
      );
    });

    this.register('market.opportunities', () =>
      db.rows<Record<string, unknown>>(
        `SELECT o.*, s.score, s.confidence FROM product_opportunities o
         LEFT JOIN opportunity_scores s ON s.product_opportunity_id = o.id
         ORDER BY o.created_at DESC LIMIT 100`,
      ),
    );

    this.register('voc.ingest', (payload, auth) => {
      const i = z
        .object({
          accountId: z.string(),
          listingId: z.string().nullable().default(null),
          kind: z.enum(['REVIEW', 'QUESTION', 'COMPLAINT', 'RETURN_REASON', 'MESSAGE']),
          text: z.string().max(5000),
          rating: z.number().int().min(1).max(5).nullable().default(null),
        })
        .parse(payload);
      if (!db.row('SELECT id FROM accounts WHERE id=? AND is_active=1',i.accountId)) throw new Error('conta inexistente ou inativa');
      if (i.listingId && !db.row('SELECT id FROM listings WHERE id=? AND account_id=?',i.listingId,i.accountId)) throw new Error('anúncio não pertence à conta selecionada');
      const redacted = redactPII(i.text);
      const id = randomUUID();
      db.db
        .prepare('INSERT INTO customer_voice_items (id, account_id, listing_id, kind, source_class, observed_at, text_redacted, rating, verified_purchase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
        .run(id, i.accountId, i.listingId, i.kind, 'F_USER_INPUT', nowIso(), redacted, i.rating);
      this.audit(auth, 'VOC_INGEST', 'customer_voice_item', id, 'OK', 'texto com dados pessoais redigidos');
      return { ok: true, id };
    });

    this.register('voc.ingestBatch', (payload, auth) => {
      const i = z.object({
        accountId: z.string().min(1), captureKey: z.string().regex(/^[a-f0-9]{64}$/).optional(), sourceUrl: z.string().url().max(2048).optional(), filterSignature:z.string().max(512).optional(),capturePageIdentity:z.string().regex(/^[a-f0-9]{64}$/).optional(),
        sourceClass: z.enum(['A_PRIMARY_UI','B_PLATFORM_EXPORT','F_USER_INPUT']).default('A_PRIMARY_UI'),
        items: z.array(z.object({
          listingId: z.string().nullable().optional(),
          externalListingId:z.string().trim().min(1).max(200).nullable().optional(),
          kind: z.enum(['REVIEW','QUESTION','COMPLAINT','RETURN_REASON','MESSAGE']),
          text: z.string().trim().min(3).max(5000),
          rating: z.number().int().min(1).max(5).nullable().optional(),
          externalRef: z.string().max(200).nullable().optional(),
          observedAt: z.string().datetime().optional(),
        })).min(1).max(200),
      }).parse(payload ?? {});
      return captureOnce('voc.ingestBatch', i, () => {
      const account = db.row<{ id: string; is_active: number }>('SELECT id,is_active FROM accounts WHERE id=?', i.accountId);
      if (!account || account.is_active !== 1) throw new Error('conta inexistente ou inativa');
      const listingIds = [...new Set(i.items.map((item) => item.listingId).filter((value): value is string => Boolean(value)))];
      for (const listingId of listingIds) {
        if (!db.row('SELECT id FROM listings WHERE id=? AND account_id=?', listingId, i.accountId)) throw new Error(`anúncio ${listingId} não pertence à conta selecionada`);
      }
      const inserted: string[] = [];
      let linked=0,unresolved=0;
      const duplicates: string[] = [];
      db.transaction(() => {
        for (const item of i.items) {
          const externalRef = item.externalRef ?? null;
          const resolved=item.externalListingId?db.row<{id:string}>('SELECT id FROM listings WHERE account_id=? AND external_id=?',i.accountId,item.externalListingId)?.id:undefined;
          if(item.listingId&&item.externalListingId&&item.listingId!==resolved)throw new Error('identificadores de anúncio divergentes');
          const listingId=item.listingId??resolved??null;
          if (externalRef) {
            const existing = db.row<{ id: string;listing_id:string|null;external_listing_id:string|null }>('SELECT id,listing_id,external_listing_id FROM customer_voice_items WHERE account_id=? AND external_ref=? AND kind=? LIMIT 1', i.accountId, externalRef, item.kind);
            if (existing) {
              if((existing.listing_id&&listingId&&existing.listing_id!==listingId)||(existing.external_listing_id&&item.externalListingId&&existing.external_listing_id!==item.externalListingId))throw new Error('feedback já associado a outro anúncio');
              db.db.prepare('UPDATE customer_voice_items SET listing_id=COALESCE(listing_id,?),external_listing_id=COALESCE(external_listing_id,?),rating=COALESCE(rating,?) WHERE id=? AND account_id=?').run(listingId,item.externalListingId??null,item.kind==='REVIEW'?item.rating??null:null,existing.id,i.accountId);
              duplicates.push(existing.id);continue;
            }
          }
          const id = randomUUID();
          const redacted = redactPII(item.text);
          db.db.prepare(`INSERT INTO customer_voice_items (id,account_id,listing_id,kind,source_class,observed_at,text_redacted,rating,verified_purchase,external_ref,external_listing_id)
                         VALUES (?,?,?,?,?,?,?,?,0,?,?)`)
            .run(id, i.accountId, listingId, item.kind, i.sourceClass, item.observedAt ?? nowIso(), redacted, item.rating ?? null, externalRef,item.externalListingId??null);
          if(listingId)linked++;else if(item.externalListingId)unresolved++;
          inserted.push(id);
        }
      });
      this.audit(auth, 'VOC_INGEST_BATCH', 'customer_voice_item', null, 'OK', `${inserted.length} inseridos; ${duplicates.length} duplicados ignorados`);
      return { ok: true, inserted: inserted.length, duplicates: duplicates.length, ids: inserted, duplicateIds: duplicates, piiRedacted: true, linked, unresolved };
      });
    });

    this.register('voc.items',(payload)=>{
      const i=z.object({accountId:z.string().min(1),limit:z.number().int().min(1).max(100).default(50)}).parse(payload);
      return db.rows(`SELECT v.id,v.kind,v.text_redacted,v.rating,v.observed_at,v.external_listing_id,v.listing_id,l.external_id AS linked_external_id,l.title AS listing_title
        FROM customer_voice_items v LEFT JOIN listings l ON l.id=v.listing_id AND l.account_id=v.account_id WHERE v.account_id=? ORDER BY v.observed_at DESC,v.id LIMIT ?`,i.accountId,i.limit);
    });

    this.register('voc.insights',payload=>{
      const i=z.object({accountId:z.string().min(1),days:z.number().int().min(1).max(365).default(30),listingId:z.string().optional()}).strict().parse(payload);
      if(!db.row('SELECT id FROM accounts WHERE id=? AND is_active=1',i.accountId))throw Error('conta ativa não encontrada');
      if(i.listingId&&!db.row('SELECT id FROM listings WHERE account_id=? AND id=?',i.accountId,i.listingId))throw Error('anúncio não pertence à conta');
      const to=nowIso(),from=new Date(Date.parse(to)-i.days*86400000).toISOString();
      const items=db.rows<Parameters<typeof customerInsights>[0][number]>("SELECT id,kind,source_class,listing_id,text_redacted,rating,observed_at FROM customer_voice_items WHERE account_id=? AND observed_at>=? AND observed_at<=? AND (? IS NULL OR listing_id=?) ORDER BY observed_at DESC,id LIMIT 2001",i.accountId,from,to,i.listingId??null,i.listingId??null);
      return {from,to,analyzed:Math.min(2000,items.length),truncated:items.length>2000,groups:customerInsights(items.slice(0,2000)),note:'Menções lexicais, inclusive positivas ou negadas; não confirmam defeito, sentimento ou causa de devolução. Revisar evidências antes de agir.'};
    });
    this.register('voc.overview',(payload)=>{
      const {accountId,days}=z.object({accountId:z.string().min(1),days:z.number().int().min(1).max(365).default(30)}).strict().parse(payload);
      if (!db.row('SELECT id FROM accounts WHERE id=? AND is_active=1',accountId)) throw new Error('conta inexistente ou inativa');
      const to=nowIso();
      const from=new Date(Date.parse(to)-days*86400000).toISOString();
      const summary=db.rows<{kind:string;source_class:string;count:number;rated:number;average_rating:number|null}>(`
        SELECT kind,source_class,COUNT(*) AS count,COUNT(CASE WHEN kind='REVIEW' THEN rating END) AS rated,
          AVG(CASE WHEN kind='REVIEW' THEN rating END) AS average_rating
        FROM customer_voice_items
        WHERE account_id=? AND observed_at>=? AND observed_at<=?
        GROUP BY kind,source_class ORDER BY kind,source_class`,accountId,from,to);
      const reputation=db.rows<{id:string;captured_at:string;metrics_json:string;evidence_json:string}>(`
        SELECT id,captured_at,metrics_json,evidence_json FROM account_snapshots
        WHERE account_id=? AND page_kind='seller_reputation' AND source_class='A_PRIMARY_UI'
          AND captured_at>=? AND captured_at<=?
        ORDER BY captured_at DESC,id DESC LIMIT 101`,accountId,from,to);
      const observations=reputation.slice(0,100).map(row=>{
        const metrics=parseJsonObject(row.metrics_json);
        return {id:row.id,capturedAt:row.captured_at,rating:knownNumber(metrics,'reviewRating'),
          reviewCount:knownNumber(metrics,'reviewCount'),partial:Boolean(parseJsonObject(row.evidence_json).coverageWarnings)};
      });
      const returnReasons=db.rows<{reason:string;source_class:string;count:number}>(`
        SELECT TRIM(text_redacted) AS reason,source_class,COUNT(*) AS count FROM customer_voice_items
        WHERE account_id=? AND kind='RETURN_REASON' AND observed_at>=? AND observed_at<=? AND TRIM(text_redacted)<>''
        GROUP BY TRIM(text_redacted),source_class HAVING COUNT(*)>=2
        ORDER BY count DESC,reason,source_class LIMIT 21`,accountId,from,to);
      return {from,to,summary,reputation:observations,reputationTruncated:reputation.length>100,
        returnReasons:returnReasons.slice(0,20),returnReasonsTruncated:returnReasons.length>20};
    });

    this.register('sync.createAll', (payload, auth) => {
      const i = z.object({ scope: z.enum(['ALL_ACTIVE_ACCOUNTS','ALL_ENABLED_MARKETPLACES','ACCOUNT']).default('ALL_ACTIVE_ACCOUNTS'), accountId: z.string().optional(), browserRequest: z.boolean().default(false),collectionMode:z.enum(['AUTHORIZED_AREAS','ADVANCED_LISTINGS']).default('AUTHORIZED_AREAS') }).parse(payload ?? {});
      if (i.scope === 'ACCOUNT' && !i.accountId) throw new Error('informe accountId para sincronização por conta');
      if(i.collectionMode==='ADVANCED_LISTINGS'&&i.scope!=='ACCOUNT')throw new Error('coleta avançada exige uma conta específica');
      const accounts = db.rows<{ id: string; marketplace: string }>(
        `SELECT a.id,a.marketplace FROM accounts a
          WHERE a.is_active=1 AND (? IS NULL OR a.id=?)
            AND (? <> 'ALL_ENABLED_MARKETPLACES' OR EXISTS (SELECT 1 FROM marketplaces m WHERE m.id=a.marketplace AND m.enabled=1))
          ORDER BY a.marketplace,a.id`,
        i.accountId ?? null, i.accountId ?? null, i.scope,
      );
      if (!accounts.length) throw new Error('nenhuma conta ativa conhecida no escopo; cadastre e confirme uma conta primeiro');
      const batchId = randomUUID();
      const now = nowIso();
      db.transaction(() => {
        db.db.prepare('INSERT INTO sync_batches (id,requested_by,scope,status,requested_at,summary_json,browser_request,collection_mode) VALUES (?,?,?,?,?,?,?,?)')
          .run(batchId, auth?.userId ?? null, i.scope, 'QUEUED', now, JSON.stringify({ accountCount: accounts.length }), Number(i.browserRequest),i.collectionMode);
        const insert = db.db.prepare('INSERT INTO sync_batch_accounts (id,batch_id,account_id,marketplace,status) VALUES (?,?,?,?,?)');
        for (const account of accounts) insert.run(randomUUID(), batchId, account.id, account.marketplace, 'WAITING_BROWSER');
      });
      this.audit(auth, 'SYNC_BATCH_CREATE', 'sync_batch', batchId, 'OK', `${accounts.length} conta(s); aguarda abas autenticadas abertas`);
      return { ok: true, batchId, status: 'QUEUED', accounts,collectionMode:i.collectionMode, requiresOpenSellerTabs: true, neverSwitchesAccounts: true };
    });

    this.register('sync.list', (payload) => {
      const i = z.object({ batchId: z.string().optional(), accountId:z.string().optional(), compact:z.boolean().default(false),includePageRuns:z.boolean().default(true),pageOffset:z.number().int().min(0).max(1000000).default(0),pageLimit:z.number().int().min(1).max(500).optional(), limit: z.number().int().min(1).max(100).default(30) }).parse(payload ?? {});
      if (i.batchId) {
        const accounts = db.rows<Record<string,unknown>>('SELECT * FROM sync_batch_accounts WHERE batch_id=? AND (? IS NULL OR account_id=?) ORDER BY marketplace,account_id',i.batchId,i.accountId??null,i.accountId??null).map(({lease_hash:_leaseHash,...account})=>account);
        const total=db.row<{total:number}>('SELECT COUNT(*) total FROM sync_batch_page_runs WHERE batch_id=? AND (? IS NULL OR account_id=?)',i.batchId,i.accountId??null,i.accountId??null)?.total??0;
        const pageRuns=!i.includePageRuns?[]:i.pageLimit!==undefined?db.rows('SELECT * FROM sync_batch_page_runs WHERE batch_id=? AND (? IS NULL OR account_id=?) ORDER BY account_id,page_no LIMIT ? OFFSET ?',i.batchId,i.accountId??null,i.accountId??null,i.pageLimit,i.pageOffset):i.compact?[]:db.rows('SELECT * FROM sync_batch_page_runs WHERE batch_id=? AND (? IS NULL OR account_id=?) ORDER BY account_id,page_no',i.batchId,i.accountId??null,i.accountId??null);
        return { batch:db.row('SELECT * FROM sync_batches WHERE id=?',i.batchId),accounts:i.compact?accounts.map(({progress_json,...account})=>{
          const progress=parseJsonObject(String(progress_json??'{}'));
          return {...account,pendingPages:Array.isArray(progress.pendingLinks)?progress.pendingLinks.length:0,unsupportedLinks:progress.unsupportedLinks===true,stoppedReason:progress.stoppedReason??null};
        }):accounts,pageRuns,totalPageRuns:total };
      }
      return db.rows('SELECT * FROM sync_batches ORDER BY requested_at DESC LIMIT ?', i.limit);
    });

    this.register('sync.retryFailed', (payload, auth) => {
      const i = z.object({ batchId: z.string().min(1), browserRequest: z.boolean().default(false) }).parse(payload ?? {});
      const original = db.row<{ id: string; scope: 'ALL_ACTIVE_ACCOUNTS' | 'ALL_ENABLED_MARKETPLACES' | 'ACCOUNT'; status: string; logical_batch_id: string | null;collection_mode:string }>(
        'SELECT id,scope,status,logical_batch_id,collection_mode FROM sync_batches WHERE id=?', i.batchId,
      );
      if (!original) throw new Error('lote original de sincronização não encontrado');
      if (!['PARTIAL','FAILED'].includes(original.status)) throw new Error('somente lotes parciais ou com falha podem ser repetidos');
      const failedAccounts = db.rows<{ account_id: string; marketplace: string; progress_json: string; pages_scanned: number; pages_succeeded: number }>(
        `SELECT ba.account_id,ba.marketplace,ba.progress_json,ba.pages_scanned,ba.pages_succeeded FROM sync_batch_accounts ba
           JOIN accounts a ON a.id=ba.account_id
          WHERE ba.batch_id=? AND ba.status IN ('FAILED','PARTIAL','SKIPPED') AND a.is_active=1
            AND NOT EXISTS (
              SELECT 1 FROM sync_batch_accounts pending
               JOIN sync_batches b ON b.id=pending.batch_id
              WHERE pending.account_id=ba.account_id AND pending.status IN ('WAITING_BROWSER','RUNNING')
                AND b.status IN ('QUEUED','RUNNING')
            )
          ORDER BY ba.marketplace,ba.account_id`, i.batchId,
      );
      if (!failedAccounts.length) throw new Error('nenhuma conta ativa com falha pode ser repetida; confira se já existe um lote em andamento');
      const batchId = randomUUID(); const now = nowIso();
      db.transaction(() => {
        db.db.prepare('INSERT INTO sync_batches (id,requested_by,scope,status,requested_at,summary_json,browser_request,logical_batch_id,collection_mode) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(batchId, auth?.userId ?? null, original.scope, 'QUEUED', now, JSON.stringify({ retryOf: original.id, accountCount: failedAccounts.length }), Number(i.browserRequest), original.logical_batch_id ?? original.id,original.collection_mode);
        const insert = db.db.prepare('INSERT INTO sync_batch_accounts (id,batch_id,account_id,marketplace,status,progress_json,pages_scanned,pages_succeeded) VALUES (?,?,?,?,?,?,?,?)');
        const copyPage = db.db.prepare(`INSERT INTO sync_batch_page_runs(id,batch_id,account_id,page_no,page_url,page_kind,status,error,queued,updated_at,spa_page)
          SELECT ?,?,account_id,page_no,page_url,page_kind,status,error,queued,?,spa_page FROM sync_batch_page_runs WHERE id=?`);
        for (const account of failedAccounts) {
          insert.run(randomUUID(), batchId, account.account_id, account.marketplace, 'WAITING_BROWSER', account.progress_json, account.pages_scanned, account.pages_succeeded);
          for (const page of db.rows<{ id: string }>('SELECT id FROM sync_batch_page_runs WHERE batch_id=? AND account_id=?',original.id,account.account_id)) copyPage.run(randomUUID(),batchId,now,page.id);
        }
      });
      this.audit(auth, 'SYNC_BATCH_RETRY', 'sync_batch', batchId, 'OK', `${failedAccounts.length} conta(s); origem ${original.id}`);
      return { ok: true, batchId, accounts: failedAccounts, retryOf: original.id, requiresOpenSellerTabs: true, neverSwitchesAccounts: true };
    });

    this.register('sync.schedule.create', (payload, auth) => {
      const i = z.object({
        scope: z.enum(['ALL_ACTIVE_ACCOUNTS','ALL_ENABLED_MARKETPLACES','ACCOUNT']).default('ALL_ACTIVE_ACCOUNTS'),
        accountId: z.string().optional(), cadence: z.enum(['1h','6h','daily','weekly','custom']),
        intervalMinutes: z.number().int().min(15).max(43200).optional(),
      }).parse(payload ?? {});
      if (i.scope === 'ACCOUNT' && !i.accountId) throw new Error('informe accountId para agendamento por conta');
      if (i.scope !== 'ACCOUNT' && i.accountId) throw new Error('accountId só pode ser informado para escopo ACCOUNT');
      if (i.cadence === 'custom' && i.intervalMinutes === undefined) throw new Error('informe intervalo personalizado de 15 a 43200 minutos');
      if (i.cadence !== 'custom' && i.intervalMinutes !== undefined) throw new Error('intervalo personalizado só é aceito com cadence=custom');
      if (i.accountId && !db.row('SELECT id FROM accounts WHERE id=? AND is_active=1', i.accountId)) throw new Error('conta ativa não encontrada');
      const id = randomUUID(); const now = nowIso(); const storedCadence = i.cadence === 'custom' ? '1h' : i.cadence;
      const nextAt = firstOccurrence(i.cadence, i.intervalMinutes);
      db.db.prepare(`INSERT INTO sync_schedules (id,scope,account_id,cadence,interval_minutes,enabled,next_run_at,created_by,created_at,updated_at)
                     VALUES (?,?,?,?,?,1,?,?,?,?)`)
        .run(id, i.scope, i.accountId ?? null, storedCadence, i.intervalMinutes ?? null, nextAt, auth?.userId ?? null, now, now);
      this.audit(auth, 'SYNC_SCHEDULE_CREATE', 'sync_schedule', id, 'OK', `${i.scope}/${i.cadence}${i.intervalMinutes ? `/${i.intervalMinutes}m` : ''}`);
      return { ok: true, id, scope: i.scope, nextRunAt: nextAt, cadence: i.cadence, intervalMinutes: i.intervalMinutes ?? null, requiresBrowserOpen: true };
    });
    this.register('sync.schedule.list', () => db.rows(`SELECT *,CASE WHEN interval_minutes IS NULL THEN cadence ELSE 'custom' END AS cadence_label
      FROM sync_schedules ORDER BY next_run_at`));
    this.register('sync.schedule.setEnabled', (payload, auth) => {
      const i = z.object({ id: z.string(), enabled: z.boolean() }).parse(payload ?? {});
      const schedule = db.row<{ cadence: ScheduleCadence; interval_minutes: number | null }>('SELECT cadence,interval_minutes FROM sync_schedules WHERE id=?', i.id);
      if (!schedule) throw new Error('agendamento de sincronização não encontrado');
      const nextAt = i.enabled ? firstOccurrence(schedule.cadence, schedule.interval_minutes) : null;
      const changed = db.db.prepare('UPDATE sync_schedules SET enabled=?,next_run_at=COALESCE(?,next_run_at),last_status=CASE WHEN ?=1 THEN NULL ELSE last_status END,last_error=CASE WHEN ?=1 THEN NULL ELSE last_error END,updated_at=? WHERE id=?')
        .run(i.enabled ? 1 : 0, nextAt, i.enabled ? 1 : 0, i.enabled ? 1 : 0, nowIso(), i.id);
      if (Number(changed.changes) !== 1) throw new Error('agendamento de sincronização não encontrado');
      this.audit(auth, 'SYNC_SCHEDULE_TOGGLE', 'sync_schedule', i.id, 'OK', String(i.enabled));
      return { ok: true, nextRunAt: nextAt };
    });
    this.register('sync.schedule.runs', (payload) => {
      const i = z.object({ scheduleId: z.string(), limit: z.number().int().min(1).max(200).default(50) }).parse(payload ?? {});
      return db.rows('SELECT id,schedule_id,batch_id,scheduled_at,started_at,finished_at,status,summary_json,error FROM sync_schedule_runs WHERE schedule_id=? ORDER BY scheduled_at DESC LIMIT ?', i.scheduleId, i.limit);
    });
    this.register('sync.claimBrowserRequest', () => db.transaction(() => {
      const now = nowIso();
      const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
      const batch = db.row<{ id: string; status: string }>(`
        SELECT b.id,b.status FROM sync_batches b
        WHERE b.browser_request=1 AND EXISTS (
          SELECT 1 FROM sync_batch_accounts a WHERE a.batch_id=b.id AND a.status IN ('WAITING_BROWSER','RUNNING')
        )
        AND (b.status='QUEUED' OR (b.status='RUNNING' AND b.browser_claimed_at<=? AND NOT EXISTS (
          SELECT 1 FROM sync_batch_accounts a WHERE a.batch_id=b.id AND (a.progress_updated_at>? OR a.finished_at>?)
        )))
        ORDER BY b.requested_at,b.id LIMIT 1`, staleBefore, staleBefore, staleBefore);
      if (!batch) return { claimed: false };
      db.db.prepare("UPDATE sync_batches SET status='RUNNING',browser_claimed_at=? WHERE id=?").run(now, batch.id);
      return { claimed: true, batchId: batch.id, recoveredStaleLease: batch.status === 'RUNNING' };
    }));

    this.register('sync.claimScheduled', () => db.transaction(() => {
      // Um worker MV3 pode ser encerrado pelo navegador no meio de uma coleta.
      // Reivindique novamente o mesmo lote após 30 minutos; contas já terminais
      // são puladas pelo worker e apenas contas incompletas são reprocessadas.
      const now = nowIso();
      const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
      const row = db.row<{ id: string; batch_id: string; schedule_id: string }>(`SELECT id,batch_id,schedule_id FROM sync_schedule_runs
        WHERE batch_id IS NOT NULL AND (status='QUEUED' OR (status='RUNNING' AND started_at<=? AND NOT EXISTS (
          SELECT 1 FROM sync_batch_accounts a WHERE a.batch_id=sync_schedule_runs.batch_id AND a.progress_updated_at>?
        )))
        ORDER BY scheduled_at,id LIMIT 1`, staleBefore, staleBefore);
      if (!row) return { claimed: false };
      const pending = db.row<{ total: number }>("SELECT COUNT(*) AS total FROM sync_batch_accounts WHERE batch_id=? AND status IN ('WAITING_BROWSER','RUNNING')", row.batch_id)?.total ?? 0;
      if (Number(pending) === 0) {
        // Repara a pequena janela entre gravar o estado final do lote e o histórico da agenda.
        const counts = db.row<{ total: number; completed: number; partial: number; failed: number }>(
          `SELECT COUNT(*) total,
            SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) completed,
            SUM(CASE WHEN status='PARTIAL' THEN 1 ELSE 0 END) partial,
            SUM(CASE WHEN status IN ('FAILED','SKIPPED') THEN 1 ELSE 0 END) failed
           FROM sync_batch_accounts WHERE batch_id=?`, row.batch_id,
        )!;
        const finalStatus = Number(counts.completed) === Number(counts.total) ? 'COMPLETED'
          : Number(counts.completed) + Number(counts.partial) > 0 ? 'PARTIAL' : 'FAILED';
        const batchSummary = JSON.stringify(counts);
        const errors = db.rows<{ error: string | null }>('SELECT error FROM sync_batch_accounts WHERE batch_id=? AND error IS NOT NULL', row.batch_id).map((item) => item.error).filter(Boolean).join('; ').slice(0, 1000) || null;
        db.db.prepare('UPDATE sync_batches SET status=?,finished_at=COALESCE(finished_at,?),summary_json=? WHERE id=?')
          .run(finalStatus, now, batchSummary, row.batch_id);
        db.db.prepare('UPDATE sync_schedule_runs SET status=?,finished_at=COALESCE(finished_at,?),summary_json=?,error=? WHERE id=?')
          .run(finalStatus, now, batchSummary, errors, row.id);
        db.db.prepare('UPDATE sync_schedules SET last_status=?,last_error=?,updated_at=? WHERE id=?')
          .run(finalStatus, errors, now, row.schedule_id);
        return { claimed: false, reconciled: true, batchId: row.batch_id, status: finalStatus };
      }
      const claimed = db.db.prepare("UPDATE sync_schedule_runs SET status='RUNNING',started_at=? WHERE id=? AND (status='QUEUED' OR (status='RUNNING' AND started_at<=?))").run(now, row.id, staleBefore);
      if (Number(claimed.changes) !== 1) return { claimed: false };
      db.db.prepare("UPDATE sync_batches SET status='RUNNING' WHERE id=? AND status IN ('QUEUED','RUNNING')").run(row.batch_id);
      return { claimed: true, batchId: row.batch_id, runId: row.id, recoveredStaleLease: true };
    }));

    // One account, one active collector across browser instances and batches.
    this.register('sync.claimAccount', (payload, auth) => db.transaction(() => {
      const i = z.object({batchId:z.string().min(1),accountId:z.string().min(1),leaseToken:z.string().uuid().optional()}).parse(payload);
      const now=nowIso(), expiresAt=new Date(Date.now()+120_000).toISOString();
      const row=db.row<{id:string;status:string;lease_hash:string|null;lease_expires_at:string|null}>(`SELECT ba.id,ba.status,ba.lease_hash,ba.lease_expires_at
        FROM sync_batch_accounts ba JOIN accounts a ON a.id=ba.account_id AND a.is_active=1 AND a.marketplace=ba.marketplace
        JOIN sync_batches b ON b.id=ba.batch_id WHERE ba.batch_id=? AND ba.account_id=? AND b.status IN ('QUEUED','RUNNING')`,i.batchId,i.accountId);
      if (!row || !['WAITING_BROWSER','RUNNING'].includes(row.status)) return {ok:true,claimed:false,reason:'conta/lote não está disponível'};
      if (i.leaseToken) {
        if (row.lease_hash!==sha256(i.leaseToken) || !row.lease_expires_at || row.lease_expires_at<=now) throw new Error('reserva de coleta expirada ou substituída');
        db.db.prepare('UPDATE sync_batch_accounts SET lease_expires_at=? WHERE id=?').run(expiresAt,row.id);
        return {ok:true,claimed:true,leaseToken:i.leaseToken,expiresAt};
      }
      if (db.row(`SELECT id FROM sync_batch_accounts WHERE account_id=? AND status='RUNNING' AND lease_hash IS NOT NULL AND lease_expires_at>? LIMIT 1`,i.accountId,now)) {
        return {ok:true,claimed:false,reason:'esta conta já tem coleta em execução'};
      }
      const leaseToken=randomUUID();
      db.db.prepare("UPDATE sync_batch_accounts SET status='RUNNING',lease_hash=?,lease_expires_at=?,started_at=COALESCE(started_at,?) WHERE id=?").run(sha256(leaseToken),expiresAt,now,row.id);
      db.db.prepare("UPDATE sync_batches SET status='RUNNING',browser_claimed_at=COALESCE(browser_claimed_at,?) WHERE id=?").run(now,i.batchId);
      this.audit(auth,'SYNC_ACCOUNT_CLAIM','sync_batch_account',row.id,'OK','reserva exclusiva');
      return {ok:true,claimed:true,leaseToken,expiresAt};
    }));

    this.register('sync.accountProgress', (payload, auth) => {
      const pageKind = z.enum(['seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory']);
      const i = z.object({
        batchId: z.string().min(1), accountId: z.string().min(1), leaseToken:z.string().uuid(),
        pagesScanned: z.number().int().min(0).max(500), pagesSucceeded: z.number().int().min(0).max(500),
        pages: z.array(z.object({ page: z.number().int().min(1).max(500), url: z.string().url().max(2048), pageKind, spaPage:z.number().int().min(1).max(9999).optional(),spaFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),listingFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),listingIds:z.array(z.string().min(1).max(200)).max(500).optional(),ok: z.boolean(), error: z.string().max(500).optional(), queued: z.boolean().optional(), filterSignature:z.string().max(512).optional(),coverageWarnings:z.array(z.enum(['FILTRO_NAO_RECONHECIDO','TABELA_VIRTUALIZADA','GRAFICO_SEM_DADOS_TEXTUAIS'])).max(10).optional() })).max(500),
        seenUrls: z.array(z.string().max(2048)).max(500),
        pendingLinks: z.array(z.object({ url: z.string().url().max(2048), label: z.string().max(80), filterSignature:z.string().max(512).optional() })).max(500),
        maxPages: z.number().int().min(1).max(500), unsupportedLinks: z.boolean().default(false), receiptProtocol: z.literal(1).or(z.literal(0)).default(0), stoppedReason: z.string().max(300).optional(),
      }).refine((v) => v.pagesSucceeded <= v.pagesScanned && v.pages.length === v.pagesScanned && v.pagesScanned <= v.maxPages, 'contagens do progresso inválidas')
        .refine((v) => v.pages.every((page, index) => page.page === index + 1) && new Set(v.pages.map((page) => page.page)).size === v.pages.length, 'numeração de páginas inválida')
        .refine((v) => v.pages.filter((page) => page.ok).length === v.pagesSucceeded, 'páginas concluídas não correspondem à contagem')
        .parse(payload ?? {});
      const row = db.row<{ id: string; status: string; marketplace: string; pages_scanned: number; pages_succeeded: number; lease_hash:string|null;lease_expires_at:string|null }>('SELECT ba.id,ba.status,ba.marketplace,ba.pages_scanned,ba.pages_succeeded,ba.lease_hash,ba.lease_expires_at FROM sync_batch_accounts ba JOIN accounts a ON a.id=ba.account_id AND a.marketplace=ba.marketplace AND a.is_active=1 WHERE ba.batch_id=? AND ba.account_id=?', i.batchId, i.accountId);
      if (!row) throw new Error('conta não pertence ao lote de sincronização');
      if (row.status!=='RUNNING' || row.lease_hash!==sha256(i.leaseToken) || !row.lease_expires_at || row.lease_expires_at<=nowIso()) throw new Error('reserva de coleta expirada ou substituída');
      const hosts: Record<string, RegExp> = {
        mercado_livre: /(^|\.)mercadolivre\.com\.br$/i,
        shopee: /(^|\.)shopee\.com\.br$/i,
        amazon: /^sellercentral\.amazon\.com\.br$/i,
      };
      const sanitizeUrl = (raw: string) => {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || !hosts[row.marketplace]?.test(url.hostname)) throw new Error('URL de progresso fora do domínio autorizado');
        url.username = ''; url.password = ''; url.hash = '';
        // Só preserva parâmetros de paginação conhecidos; descarta tokens e parâmetros opacos.
        const safe = new URLSearchParams();
        for (const [key, value] of url.searchParams) if (/^(page|page_number|p|offset|limit|sort|order|start_date|end_date|date_from|date_to|from|to|period|status|startDate|endDate|dateFrom|dateTo)$/i.test(key) && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)) safe.append(key, value.slice(0, 80)); else throw new Error('filtro da URL não suportado para retomada segura');
        url.search = safe.toString();
        return url.toString();
      };
      const mode=db.row<{collection_mode:string}>('SELECT collection_mode FROM sync_batches WHERE id=?',i.batchId)?.collection_mode;
      const advanced=mode==='ADVANCED_LISTINGS';
      if(advanced&&(i.maxPages>50||i.pages.some(page=>page.pageKind!=='seller_listings'||!page.listingFingerprint||!page.listingIds?.length||new Set(page.listingIds).size!==page.listingIds.length)))throw new Error('histórico de coleta avançada sem identidade comprovada');
      if(!advanced&&i.pages.some(page=>page.listingFingerprint!==undefined||page.listingIds!==undefined||(page.spaPage!==undefined)!==(page.spaFingerprint!==undefined)))throw new Error('identidade SPA geral incompleta ou incompatível');
      if(advanced&&i.pages.some(page=>page.spaFingerprint!==undefined))throw new Error('identidade SPA geral incompatível com coleta avançada');
      const completedIds=i.pages.filter(page=>page.ok).flatMap(page=>page.listingIds??[]);
      if(advanced&&new Set(completedIds).size!==completedIds.length)throw new Error('anúncios repetidos entre páginas concluídas');
      const cleanPages = i.pages.map((page) => ({
        page_no: page.page, page_url: sanitizeUrl(page.url), page_kind: page.pageKind,spa_page:page.spaPage??null,
        status: page.ok ? 'COMPLETED' : page.queued ? 'QUEUED' : 'FAILED', error: page.error ?? null, queued: page.queued ? 1 : 0,
      }));
      if (i.pagesScanned < row.pages_scanned || i.pagesSucceeded < row.pages_succeeded) throw new Error('progresso atrasado não pode reduzir contagens');
      const uniquePageKey = (raw: string,spaPage?:number|null) => { const u = new URL(raw); u.searchParams.sort(); return JSON.stringify([u.href,spaPage??null]); };
      if (new Set(cleanPages.map((page) => uniquePageKey(page.page_url,page.spa_page))).size !== cleanPages.length) throw new Error('URLs duplicadas no progresso');
      for (const prev of db.rows<{ page_no: number; page_url: string; status: string;spa_page:number|null }>('SELECT page_no,page_url,status,spa_page FROM sync_batch_page_runs WHERE batch_id=? AND account_id=?',i.batchId,i.accountId)) {
        const next = cleanPages[prev.page_no - 1];
        if (!next || uniquePageKey(next.page_url,next.spa_page) !== uniquePageKey(prev.page_url,prev.spa_page) || (prev.status === 'COMPLETED' && next.status !== 'COMPLETED')) throw new Error('progresso anterior não pode ser substituído por outra página ou regredir');
      }
      {
        const prior=parseJsonObject(String(db.row<{progress_json:string}>('SELECT progress_json FROM sync_batch_accounts WHERE id=?',row.id)?.progress_json??'{}'));
        for(const page of Array.isArray(prior.pages)?prior.pages:[]){
          const next=i.pages[Number(page.page)-1];
          if((advanced||page.spaPage!==undefined)&&(!next||next.spaFingerprint!==page.spaFingerprint||next.listingFingerprint!==page.listingFingerprint||next.filterSignature!==page.filterSignature||(page.ok&&JSON.stringify(next.listingIds)!==JSON.stringify(page.listingIds))))throw new Error('identidade do histórico avançado não pode ser alterada');
        }
      }
      const cleanState = {
        seenUrls: i.seenUrls.map((url) => {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' || !hosts[row.marketplace]?.test(parsed.hostname)) throw new Error('URL visitada fora do domínio autorizado');
          parsed.username = ''; parsed.password = ''; parsed.hash = '';
          const safe = new URLSearchParams();
          for (const [key, value] of parsed.searchParams) if (/^(page|page_number|p|offset|limit|sort|order|start_date|end_date|date_from|date_to|from|to|period|status|startDate|endDate|dateFrom|dateTo)$/i.test(key) && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)) safe.append(key, value.slice(0, 80)); else throw new Error('filtro da URL não suportado para retomada segura');
          parsed.search = safe.toString();
          return parsed.toString();
        }),
        pendingLinks: i.pendingLinks.map((item) => ({ url: sanitizeUrl(item.url), label: item.label, ...(item.filterSignature!==undefined?{filterSignature:item.filterSignature}:{}) })),
        pages: cleanPages.map((page) => ({ page: page.page_no, url: page.page_url, pageKind: page.page_kind, ...(advanced?{...(page.spa_page!==null?{spaPage:page.spa_page}:{}),listingFingerprint:i.pages[page.page_no-1]!.listingFingerprint,listingIds:i.pages[page.page_no-1]!.listingIds}:page.spa_page!==null?{spaPage:page.spa_page,spaFingerprint:i.pages[page.page_no-1]!.spaFingerprint}:{}),ok: page.status === 'COMPLETED', ...(page.error ? { error: page.error } : {}), queued: Boolean(page.queued), ...(i.pages[page.page_no-1]?.filterSignature!==undefined?{filterSignature:i.pages[page.page_no-1]!.filterSignature}:{}),...(i.pages[page.page_no-1]?.coverageWarnings?{coverageWarnings:i.pages[page.page_no-1]!.coverageWarnings}:{}) })),
        maxPages: i.maxPages, unsupportedLinks: i.unsupportedLinks || i.pages.some(page=>Boolean(page.coverageWarnings?.length)), receiptProtocol: i.receiptProtocol, stoppedReason: i.stoppedReason ?? null,
      };
      const now = nowIso();
      db.transaction(() => {
        const upsertPage = db.db.prepare(`INSERT INTO sync_batch_page_runs
          (id,batch_id,account_id,page_no,page_url,page_kind,status,error,queued,updated_at,spa_page)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,account_id,page_no) DO UPDATE SET
          page_url=excluded.page_url,page_kind=excluded.page_kind,spa_page=excluded.spa_page,status=excluded.status,error=excluded.error,queued=excluded.queued,updated_at=excluded.updated_at`);
        for (const page of cleanPages) upsertPage.run(randomUUID(), i.batchId, i.accountId, page.page_no, page.page_url, page.page_kind, page.status, page.error, page.queued, now,page.spa_page);
        const current = cleanPages.at(-1) ?? null;
        db.db.prepare(`UPDATE sync_batch_accounts SET status='RUNNING',pages_scanned=MAX(pages_scanned,?),pages_succeeded=MAX(pages_succeeded,?),
          current_page_no=?,current_url=?,progress_json=?,progress_updated_at=?,lease_expires_at=?,started_at=COALESCE(started_at,?) WHERE id=?`)
          .run(i.pagesScanned, i.pagesSucceeded, current?.page_no ?? null, current?.page_url ?? null, JSON.stringify(cleanState), now, new Date(Date.now()+120_000).toISOString(), now, row.id);
      });
      return { ok: true, pagesScanned: i.pagesScanned, pagesSucceeded: i.pagesSucceeded, currentPage: cleanPages.at(-1)?.page_no ?? null, pendingPages: i.pendingLinks.length, updatedAt: now };
    });

    this.register('sync.completeAccount', (payload, auth) => db.transaction(() => {
      const i = z.object({ batchId: z.string(), accountId: z.string(), leaseToken:z.string().uuid(), status: z.enum(['RUNNING','COMPLETED','PARTIAL','FAILED','SKIPPED']), pagesScanned: z.number().int().min(0).max(500).default(0), pagesSucceeded: z.number().int().min(0).max(500).default(0), error: z.string().max(1000).optional() }).refine((v) => v.pagesSucceeded <= v.pagesScanned, 'pagesSucceeded não pode superar pagesScanned').parse(payload);
      const row = db.row<{ id: string; status: string; progress_json: string;lease_hash:string|null;lease_expires_at:string|null;pages_scanned:number;pages_succeeded:number }>('SELECT id,status,progress_json,lease_hash,lease_expires_at,pages_scanned,pages_succeeded FROM sync_batch_accounts WHERE batch_id=? AND account_id=?', i.batchId, i.accountId);
      if (!row) throw new Error('conta não pertence ao lote de sincronização');
      if (['COMPLETED','PARTIAL','FAILED','SKIPPED'].includes(row.status)) {
        if (row.status !== i.status) throw new Error('conta em estado terminal; use a repetição em novo lote');
        const batch = db.row<{ status: string; summary_json: string }>('SELECT status,summary_json FROM sync_batches WHERE id=?', i.batchId)!;
        return { ok: true, batchStatus: batch.status, counts: parseJsonObject(batch.summary_json) };
      }
      if (row.lease_hash!==sha256(i.leaseToken) || !row.lease_expires_at || row.lease_expires_at<=nowIso()) throw new Error('reserva de coleta expirada ou substituída');
      if (i.status === 'COMPLETED') {
        const progress = parseJsonObject(row.progress_json);
        if (progress.unsupportedLinks === true || !Array.isArray(progress.pendingLinks) || progress.pendingLinks.length || !Array.isArray(progress.pages) || !progress.pages.length || progress.pages.length!==i.pagesScanned || i.pagesScanned!==i.pagesSucceeded || i.pagesScanned!==row.pages_scanned || i.pagesSucceeded!==row.pages_succeeded || progress.pages.some((page) => page?.ok !== true)) {
          throw new Error('a coleta tem páginas pendentes ou sem confirmação');
        }
      }
      const now = nowIso();
      db.db.prepare(`UPDATE sync_batch_accounts SET status=?,pages_scanned=MAX(pages_scanned,?),pages_succeeded=MAX(pages_succeeded,?),error=?,started_at=COALESCE(started_at,?),finished_at=? WHERE id=?`)
        .run(i.status, i.pagesScanned, i.pagesSucceeded, i.error ?? null, now, ['COMPLETED','PARTIAL','FAILED','SKIPPED'].includes(i.status) ? now : null, row.id);
      const counts = db.row<{ total: number; open: number; completed: number; failed: number; partial: number }>(
        `SELECT COUNT(*) total, SUM(CASE WHEN status IN ('WAITING_BROWSER','RUNNING') THEN 1 ELSE 0 END) open,
          SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) completed,
          SUM(CASE WHEN status IN ('FAILED','SKIPPED') THEN 1 ELSE 0 END) failed,
          SUM(CASE WHEN status='PARTIAL' THEN 1 ELSE 0 END) partial FROM sync_batch_accounts WHERE batch_id=?`, i.batchId,
      )!;
      const batchStatus = Number(counts.open) > 0 ? 'RUNNING' : Number(counts.completed) === Number(counts.total) ? 'COMPLETED' : Number(counts.completed) + Number(counts.partial) > 0 ? 'PARTIAL' : 'FAILED';
      db.db.prepare('UPDATE sync_batches SET status=?,finished_at=?,summary_json=? WHERE id=?')
        .run(batchStatus, Number(counts.open) === 0 ? now : null, JSON.stringify(counts), i.batchId);
      const scheduledRun = db.row<{ id: string; schedule_id: string }>('SELECT id,schedule_id FROM sync_schedule_runs WHERE batch_id=?', i.batchId);
      if (scheduledRun) {
        const terminal = ['COMPLETED','PARTIAL','FAILED'].includes(batchStatus);
        const errors = db.rows<{ error: string | null }>('SELECT error FROM sync_batch_accounts WHERE batch_id=? AND error IS NOT NULL', i.batchId).map((item) => item.error).filter(Boolean);
        db.db.prepare('UPDATE sync_schedule_runs SET status=?,finished_at=?,summary_json=?,error=? WHERE id=?')
          .run(batchStatus, terminal ? now : null, JSON.stringify(counts), errors.join('; ').slice(0, 1000) || null, scheduledRun.id);
        if (terminal) db.db.prepare('UPDATE sync_schedules SET last_status=?,last_error=?,updated_at=? WHERE id=?')
          .run(batchStatus, errors.join('; ').slice(0, 1000) || null, now, scheduledRun.schedule_id);
      }
      this.audit(auth, 'SYNC_ACCOUNT_RESULT', 'sync_batch_account', row.id, i.status, i.error);
      return { ok: true, batchStatus, counts };
    }));

    this.register('finance.realized.upsert', (payload, auth) => {
      const i = z.object({
        id: z.string().optional(), accountId: z.string(), listingId: z.string().nullable().optional(),
        periodStart: z.string().datetime(), periodEnd: z.string().datetime(),
        netRevenueCents: z.number().int().min(0), productCostCents: z.number().int().min(0), packagingCents: z.number().int().min(0),
        shippingCents: z.number().int().min(0), marketplaceFeesCents: z.number().int().min(0), taxesCents: z.number().int().min(0),
        adSpendCents: z.number().int().min(0), refundsCents: z.number().int().min(0), returnLogisticsCents: z.number().int().min(0),
        cancellationLossCents: z.number().int().min(0), otherCostsCents: z.number().int().min(0),
        sourceClass: z.enum(['A_PRIMARY_UI','B_PLATFORM_EXPORT','F_USER_INPUT']), evidence: z.record(z.string(), z.unknown()), observedAt: z.string().datetime().optional(),
      }).refine((v) => Date.parse(v.periodStart) <= Date.parse(v.periodEnd), 'periodStart deve ser anterior ou igual a periodEnd')
        .refine((v) => Object.keys(v.evidence).length > 0, 'informe evidência da origem dos valores').parse(payload ?? {});
      const account = db.row<{ id: string; is_active: number }>('SELECT id,is_active FROM accounts WHERE id=?', i.accountId);
      if (!account || account.is_active !== 1) throw new Error('conta inexistente ou inativa');
      if (i.listingId && !db.row('SELECT id FROM listings WHERE id=? AND account_id=?', i.listingId, i.accountId)) throw new Error('anúncio não pertence à conta');
      const idOwner = i.id ? db.row<{ account_id: string;source_class:string;listing_id:string|null;period_start:string;period_end:string }>('SELECT account_id,source_class,listing_id,period_start,period_end FROM realized_profit_snapshots WHERE id=?', i.id) : null;
      if (idOwner && (idOwner.account_id !== i.accountId||idOwner.source_class!==i.sourceClass||idOwner.listing_id!==(i.listingId??null)||idOwner.period_start!==i.periodStart||idOwner.period_end!==i.periodEnd)) throw new Error('registro de lucro pertence a outro escopo ou fonte');
      const existing = i.id ? db.row<{ id: string }>('SELECT id FROM realized_profit_snapshots WHERE id=? AND account_id=?', i.id, i.accountId)
        : db.row<{ id: string }>('SELECT id FROM realized_profit_snapshots WHERE account_id=? AND listing_id IS ? AND period_start=? AND period_end=? AND source_class=?', i.accountId, i.listingId ?? null, i.periodStart, i.periodEnd, i.sourceClass);
      const id = existing?.id ?? i.id ?? randomUUID();
      db.db.prepare(`INSERT INTO realized_profit_snapshots (id,account_id,listing_id,period_start,period_end,net_revenue_cents,product_cost_cents,packaging_cents,shipping_cents,marketplace_fees_cents,taxes_cents,ad_spend_cents,refunds_cents,return_logistics_cents,cancellation_loss_cents,other_costs_cents,source_class,evidence_json,observed_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET listing_id=excluded.listing_id,period_start=excluded.period_start,period_end=excluded.period_end,net_revenue_cents=excluded.net_revenue_cents,product_cost_cents=excluded.product_cost_cents,packaging_cents=excluded.packaging_cents,shipping_cents=excluded.shipping_cents,marketplace_fees_cents=excluded.marketplace_fees_cents,taxes_cents=excluded.taxes_cents,ad_spend_cents=excluded.ad_spend_cents,refunds_cents=excluded.refunds_cents,return_logistics_cents=excluded.return_logistics_cents,cancellation_loss_cents=excluded.cancellation_loss_cents,other_costs_cents=excluded.other_costs_cents,evidence_json=excluded.evidence_json,observed_at=excluded.observed_at`)
        .run(id,i.accountId,i.listingId ?? null,i.periodStart,i.periodEnd,i.netRevenueCents,i.productCostCents,i.packagingCents,i.shippingCents,i.marketplaceFeesCents,i.taxesCents,i.adSpendCents,i.refundsCents,i.returnLogisticsCents,i.cancellationLossCents,i.otherCostsCents,i.sourceClass,JSON.stringify({...i.evidence,costFieldsConfirmed:true}),i.observedAt ?? nowIso(),auth?.userId ?? null);
      const realizedProfitCents = i.netRevenueCents - i.productCostCents - i.packagingCents - i.shippingCents - i.marketplaceFeesCents - i.taxesCents - i.adSpendCents - i.refundsCents - i.returnLogisticsCents - i.cancellationLossCents - i.otherCostsCents;
      this.audit(auth, 'REALIZED_PROFIT_UPSERT', 'realized_profit_snapshot', id, 'OK', `${i.sourceClass}; lucro calculado a partir dos valores informados`);
      return { ok: true, id, realizedProfitCents, classification: i.sourceClass === 'F_USER_INPUT' ? 'REALIZED_FROM_REPORTED_INPUT' : 'REALIZED_FROM_CAPTURED_SOURCE', sourceClass: i.sourceClass, notAnEstimate: true };
    });

    this.register('finance.realized.list', (payload) => {
      const i = z.object({ accountId: z.string(), listingId: z.string().optional(), limit: z.number().int().min(1).max(1000).default(200) }).parse(payload ?? {});
      const rows = db.rows<Record<string, unknown>>(`SELECT * FROM realized_profit_snapshots WHERE account_id=? AND (? IS NULL OR listing_id=?) ORDER BY period_end DESC LIMIT ?`, i.accountId, i.listingId ?? null, i.listingId ?? null, i.limit);
      return rows.map((r) => ({ ...r, realizedProfitCents: Number(r.net_revenue_cents)-Number(r.product_cost_cents)-Number(r.packaging_cents)-Number(r.shipping_cents)-Number(r.marketplace_fees_cents)-Number(r.taxes_cents)-Number(r.ad_spend_cents)-Number(r.refunds_cents)-Number(r.return_logistics_cents)-Number(r.cancellation_loss_cents)-Number(r.other_costs_cents), evidence: parseJsonObject(String(r.evidence_json)) }));
    });

    this.register('finance.realized.summary', (payload) => {
      const i = z.object({ accountId: z.string(), periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional() }).parse(payload ?? {});
      const rows = db.rows<Record<string, unknown>>(`SELECT * FROM realized_profit_snapshots WHERE account_id=? AND (? IS NULL OR period_start>=?) AND (? IS NULL OR period_end<=?)`, i.accountId, i.periodStart ?? null, i.periodStart ?? null, i.periodEnd ?? null, i.periodEnd ?? null);
      if(i.periodStart&&i.periodEnd&&Date.parse(i.periodStart)>Date.parse(i.periodEnd))throw new Error('intervalo de datas inválido');
      const invalidWindow=rows.some(row=>!Number.isFinite(Date.parse(String(row.period_start)))||!Number.isFinite(Date.parse(String(row.period_end)))||Date.parse(String(row.period_start))>Date.parse(String(row.period_end)));
      const byEntity=new Map<string,Array<Record<string,unknown>>>();
      for(const row of rows){
        const key=row.listing_id==null?'ACCOUNT':'LISTING:'+String(row.listing_id);
        const list=byEntity.get(key)??[];list.push(row);byEntity.set(key,list);
      }
      const mixedScope=byEntity.has('ACCOUNT')&&byEntity.size>1;
      const overlap=[...byEntity.values()].some(list=>{
        const sorted=[...list].sort((a,b)=>Date.parse(String(a.period_start))-Date.parse(String(b.period_start)));
        return sorted.some((row,index)=>index>0&&Date.parse(String(row.period_start))<=Date.parse(String(sorted[index-1]?.period_end)));
      });
      const conflict=invalidWindow||mixedScope||overlap;
      const total = (field: string) => rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0);
      const realizedProfitCents = total('net_revenue_cents') - total('product_cost_cents') - total('packaging_cents') - total('shipping_cents') - total('marketplace_fees_cents') - total('taxes_cents') - total('ad_spend_cents') - total('refunds_cents') - total('return_logistics_cents') - total('cancellation_loss_cents') - total('other_costs_cents');
      return { accountId: i.accountId, records: rows.length, realizedProfitCents:rows.length&&!conflict?realizedProfitCents:null, netRevenueCents:rows.length&&!conflict?total('net_revenue_cents'):null, sourceClasses: [...new Set(rows.map((r) => String(r.source_class)))], confidence:conflict?'CONFLICTING_RECORDS':rows.length?'SOURCE_CLASS_DEPENDENT':'NO_DATA', missingVsEstimate: rows.length === 0, scope:!rows.length?'NONE':mixedScope?'MIXED':byEntity.has('ACCOUNT')?'ACCOUNT':'OBSERVED_LISTINGS', overlappingPeriods:overlap, mixedScope, coverageVerified:false };
    });

    // Explicit, closed source windows only. Never assume a capture date describes the sales window.
    const observedWindow=(evidence:Record<string,unknown>)=>{
      if(typeof evidence.filtersAndPeriod!=='string'||evidence.coverageWarnings)return null;
      const entries=evidence.filtersAndPeriod.split('|').map(x=>x.split('='));
      if(entries.some(x=>x.length!==2)||new Set(entries.map(x=>x[0])).size!==entries.length)return null;
      const starts=entries.filter(([k])=>/^(start_date|date_from|data inicial|start date)$/.test(k??''));
      const ends=entries.filter(([k])=>/^(end_date|date_to|data final|end date)$/.test(k??''));
      const from=starts[0]?.[1],to=ends[0]?.[1];
      const valid=(v:string|undefined)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
      if(starts.length!==1||ends.length!==1||!valid(from)||!valid(to)||!from||!to||from>to||to+'T23:59:59.999Z'>=nowIso())return null;
      const days=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
      if(days<1||days>366)return null;
      const filters=JSON.stringify(entries.filter(([k])=>!/^(start_date|date_from|data inicial|start date|end_date|date_to|data final|end date)$/.test(k??'')).sort((a,b)=>(a[0]??'').localeCompare(b[0]??'')));
      return {from,to,days,filters};
    };
    const knownNumber=(o:Record<string,unknown>,key:string)=>typeof o[key]==='number'&&Number.isFinite(o[key])&&(o[key] as number)>=0?o[key] as number:null;
    const operationAccount=(id:string)=>{
      const account=db.row<{id:string;marketplace:string}>('SELECT id,marketplace FROM accounts WHERE id=? AND is_active=1 AND verified_by_user=1',id);
      if(!account)throw new Error('conta ativa e verificada necessária');return account;
    };
    const profitFields=['net_revenue_cents','product_cost_cents','packaging_cents','shipping_cents','marketplace_fees_cents','taxes_cents','ad_spend_cents','refunds_cents','return_logistics_cents','cancellation_loss_cents','other_costs_cents'];
    this.register('finance.profitability',(payload)=>{
      const i=z.object({accountId:z.string().min(1),periodStart:z.string().datetime(),periodEnd:z.string().datetime()}).strict().parse(payload);
      operationAccount(i.accountId);
      if(i.periodStart>i.periodEnd)throw new Error('intervalo inválido');
      const rows=db.rows<Record<string,unknown>>(`SELECT r.*,l.title,l.external_id,l.sku_id,cp.id product_id,cp.name product_name FROM realized_profit_snapshots r JOIN listings l ON l.id=r.listing_id AND l.account_id=r.account_id LEFT JOIN skus s ON s.id=l.sku_id AND s.account_id=l.account_id LEFT JOIN catalog_products cp ON cp.id=s.catalog_product_id AND cp.account_id=l.account_id WHERE r.account_id=? AND r.period_start=? AND r.period_end=? ORDER BY r.listing_id,r.observed_at DESC,r.id`,i.accountId,i.periodStart,i.periodEnd);
      const listings=db.rows<{id:string;title:string|null;external_id:string;sku_id:string|null;product_id:string|null;product_name:string|null}>(`SELECT l.id,l.title,l.external_id,l.sku_id,cp.id product_id,cp.name product_name FROM listings l LEFT JOIN skus s ON s.id=l.sku_id AND s.account_id=l.account_id LEFT JOIN catalog_products cp ON cp.id=s.catalog_product_id AND cp.account_id=l.account_id WHERE l.account_id=? ORDER BY l.id`,i.accountId);
      const results=listings.map(l=>{
        const matches=rows.filter(r=>r.listing_id===l.id),r=matches[0];
        const valid=matches.length===1&&!!r&&profitFields.every(k=>knownNumber(r,k)!==null)&&parseJsonObject(String(r.evidence_json??'')).costFieldsConfirmed===true;
        const net=valid?knownNumber(r!,'net_revenue_cents'):null;
        const profit=net===null?null:net-profitFields.slice(1).reduce((s,k)=>s+Number(r![k]),0);
        return {...l,netRevenueCents:net,profitCents:profit,marginPct:profit!==null&&net!==null&&net>0?profit/net*100:null,negative:profit!==null&&profit<0,status:matches.length>1?'CONFLICT':valid?'RECORDED':'NO_DATA',sourceClass:valid?r!.source_class:null};
      });
      const products=new Map<string,typeof results>();
      for(const row of results){const key=row.product_id??'listing:'+row.id;const group=products.get(key)??[];group.push(row);products.set(key,group);}
      return {listings:results,products:[...products.entries()].map(([id,group])=>{
        const complete=group.every(r=>r.profitCents!==null&&r.netRevenueCents!==null);
        const profit=complete?group.reduce((s,r)=>s+r.profitCents!,0):null,net=complete?group.reduce((s,r)=>s+r.netRevenueCents!,0):null;
        return {id,label:group[0]?.product_name??group[0]?.title??id,listingCount:group.length,knownListings:group.filter(r=>r.profitCents!==null).length,profitCents:profit,netRevenueCents:net,marginPct:net!==null&&net>0&&profit!==null?profit/net*100:null};
      }),coverageVerified:false,method:'Somente registros do intervalo exato por anúncio; produtos com anúncio sem dado ou registros conflitantes permanecem nulos. Valores registrados não constituem auditoria contábil.'};
    });
    const campaignCostKeys=['productCostCents','packagingCents','shippingCents','marketplaceFeesCents','taxesCents','refundsCents','returnLogisticsCents','cancellationLossCents','otherCostsCents'];
    this.register('ads.reconcile',(payload,auth)=>{
      const i=z.object({accountId:z.string().min(1),snapshotId:z.string().min(1),netAttributedRevenueCents:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),costs:z.record(z.string(),z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),sourceReference:z.string().trim().min(5).max(1000),confirmedSameScope:z.literal(true)}).strict().parse(payload);
      operationAccount(i.accountId);
      if(auth?.role!=='super_admin'||!auth.userId)throw Error('somente super_admin pode registrar conciliação');
      if(Object.keys(i.costs).length!==campaignCostKeys.length||campaignCostKeys.some(k=>!Object.hasOwn(i.costs,k)))throw Error('informe todos os custos efetivos, inclusive zeros confirmados');
      const row=db.row<{metrics_json:string;context_json:string;evidence_json:string;source_class:string}>(`SELECT metrics_json,context_json,evidence_json,source_class FROM capture_detail_snapshots WHERE id=? AND account_id=? AND kind='AD_CAMPAIGN'`,i.snapshotId,i.accountId);
      if(!row||row.source_class!=='A_PRIMARY_UI'||!observedWindow(parseJsonObject(row.context_json))||parseJsonObject(row.evidence_json).coverageWarnings)throw Error('campanha da conta com janela explícita e sem alerta de cobertura necessária');
      const spend=knownNumber(parseJsonObject(row.metrics_json),'adSpend');
      const cost=campaignCostKeys.reduce((s,k)=>s+i.costs[k]!,0);
      if(spend===null||!Number.isSafeInteger(Math.round(spend*100))||!Number.isSafeInteger(cost)||!Number.isSafeInteger(cost+Math.round(spend*100)))throw Error('investimento ou custos inválidos');
      db.db.prepare('INSERT INTO campaign_profit_observations(snapshot_id,account_id,net_attributed_revenue_cents,costs_json,source_reference,observed_at,created_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET net_attributed_revenue_cents=excluded.net_attributed_revenue_cents,costs_json=excluded.costs_json,source_reference=excluded.source_reference,observed_at=excluded.observed_at,created_by=excluded.created_by').run(i.snapshotId,i.accountId,i.netAttributedRevenueCents,JSON.stringify(i.costs),i.sourceReference,nowIso(),auth.userId);
      this.audit(auth,'ADS_RECONCILE','capture_detail_snapshot',i.snapshotId,'OK','custos e receita líquida atribuída informados pelo usuário');
      return {profitCents:i.netAttributedRevenueCents-cost-Math.round(spend*100),classification:'REPORTED_ATTRIBUTED_PROFIT',coverageVerified:false};
    });
    this.register('ads.dashboard',(payload)=>{
      const i=z.object({accountId:z.string().min(1),from:z.string().datetime(),to:z.string().datetime(),kind:z.enum(['AD','AD_CAMPAIGN']).optional(),externalId:z.string().max(200).optional()}).strict().parse(payload);
      const account=operationAccount(i.accountId);
      if(i.from>i.to||Date.parse(i.to)-Date.parse(i.from)>366*86400000)throw new Error('intervalo inválido');
      const rows=db.rows<Record<string,unknown>>(`SELECT * FROM capture_detail_snapshots WHERE account_id=? AND marketplace=? AND kind IN ('AD','AD_CAMPAIGN') AND captured_at>=? AND captured_at<=? AND (? IS NULL OR kind=?) AND (? IS NULL OR external_id=?) ORDER BY captured_at DESC,id DESC LIMIT 501`,account.id,account.marketplace,i.from,i.to,i.kind??null,i.kind??null,i.externalId??null,i.externalId??null);
      const seen=new Set<string>();
      const items=[];
      for(const r of rows.slice(0,500)){
        const key=JSON.stringify([r.kind,r.external_id,r.parent_external_id]);
        if(seen.has(key))continue;seen.add(key);
        const metrics=parseJsonObject(String(r.metrics_json)),context=parseJsonObject(String(r.context_json)),window=observedWindow(context);
        const spend=knownNumber(metrics,'adSpend'),revenue=knownNumber(metrics,'adAttributedRevenue');
        const verified=window!==null&&r.source_class==='A_PRIMARY_UI'&&!parseJsonObject(String(r.evidence_json)).coverageWarnings;
        const rec=verified&&r.kind==='AD_CAMPAIGN'?db.row<{net_attributed_revenue_cents:number;costs_json:string;source_reference:string}>(`SELECT net_attributed_revenue_cents,costs_json,source_reference FROM campaign_profit_observations WHERE snapshot_id=? AND account_id=?`,r.id,account.id):null;
        const costs=rec?parseJsonObject(rec.costs_json):null;
        const profit=rec&&spend!==null&&costs&&campaignCostKeys.every(k=>knownNumber(costs,k)!==null)?rec.net_attributed_revenue_cents-Math.round(spend*100)-campaignCostKeys.reduce((s,k)=>s+Number(costs[k]),0):null;
        items.push({...r,metrics,context,window,verified,profitCents:profit,profitSource:rec?.source_reference??null,signal:profit!==null&&profit<0?'REPORTED_NEGATIVE_ATTRIBUTED_PROFIT':verified&&spend!==null&&spend>0&&revenue!==null&&revenue<spend?'REVIEW_SPEND':null});
      }
      const snapshots=db.rows<Record<string,unknown>>(`SELECT * FROM account_snapshots WHERE account_id=? AND marketplace=? AND page_kind IN ('seller_ads','seller_dashboard','seller_orders') AND captured_at>=? AND captured_at<=? ORDER BY captured_at DESC,id DESC LIMIT 501`,account.id,account.marketplace,i.from,i.to);
      const pick=(metric:string,kinds:string[])=>snapshots.find(s=>kinds.includes(String(s.page_kind))&&knownNumber(parseJsonObject(String(s.metrics_json)),metric)!==null);
      const ad=pick('adSpend',['seller_ads']),sale=pick('gmv',['seller_dashboard','seller_orders']);
      const aw=ad?observedWindow(parseJsonObject(String(ad.evidence_json))):null,sw=sale?observedWindow(parseJsonObject(String(sale.evidence_json))):null;
      const spend=ad?knownNumber(parseJsonObject(String(ad.metrics_json)),'adSpend'):null,gmv=sale?knownNumber(parseJsonObject(String(sale.metrics_json)),'gmv'):null;
      const compatible=!i.kind&&!i.externalId&&rows.length<=500&&snapshots.length<=500&&aw!==null&&sw!==null&&JSON.stringify(aw)===JSON.stringify(sw)&&ad?.source_class==='A_PRIMARY_UI'&&sale?.source_class==='A_PRIMARY_UI';
      const listingCandidates=[];
      if(!i.kind&&!i.externalId){
        const latest=db.rows<Record<string,unknown>>(`SELECT * FROM (SELECT s.*,l.external_id,l.title,l.sku_id,ROW_NUMBER() OVER(PARTITION BY s.listing_id ORDER BY s.captured_at DESC,s.id DESC) rn FROM listing_snapshots s JOIN listings l ON l.id=s.listing_id AND l.account_id=s.account_id WHERE s.account_id=? AND s.captured_at>=? AND s.captured_at<=?) WHERE rn=1 ORDER BY captured_at DESC,id LIMIT 501`,account.id,i.from,i.to);
        for(const row of latest.slice(0,500)){
          const m=parseJsonObject(String(row.metrics_json)),window=observedWindow(parseJsonObject(String(row.evidence_json)));
          if(!window||row.source_class!=='A_PRIMARY_UI')continue;
          const spend=knownNumber(m,'adSpend'),revenue=knownNumber(m,'adAttributedRevenue'),stock=knownNumber(m,'stockAvailable'),orders=knownNumber(m,'adAttributedOrders');
          if(spend===null||spend<=0||revenue===null||stock===null||stock<=0||orders===null||orders<=0||revenue<=spend)continue;
          const records=db.rows<Record<string,unknown>>('SELECT * FROM realized_profit_snapshots WHERE account_id=? AND listing_id=? AND period_start=? AND period_end=?',account.id,row.listing_id,window.from+'T00:00:00.000Z',window.to+'T23:59:59.999Z');
          const r=records[0];
          if(records.length!==1||!r||parseJsonObject(String(r.evidence_json)).costFieldsConfirmed!==true||profitFields.some(k=>knownNumber(r,k)===null))continue;
          const profit=Number(r.net_revenue_cents)-profitFields.slice(1).reduce((s,k)=>s+Number(r[k]),0);
          if(profit>0)listingCandidates.push({listingId:row.listing_id,label:row.title??row.external_id,stock,spend,revenue,orders,profitCents:profit,window,signal:'REVIEW_MORE_INVESTMENT',note:'Lucro total do anúncio registrado positivo, receita atribuída maior que investimento e estoque positivo; revisar margem incremental antes de aumentar orçamento.'});
        }
      }
      return {items,listingCandidates,tacosPct:compatible&&gmv!==null&&gmv>0&&spend!==null?spend/gmv*100:null,window:compatible?aw:null,truncated:rows.length>500||snapshots.length>500,coverageVerified:false};
    });
    this.register('inventory.dashboard',(payload)=>{
      const i=z.object({accountId:z.string().min(1),days:z.number().int().min(1).max(365).default(30)}).strict().parse(payload);
      const account=operationAccount(i.accountId),cutoff=new Date(Date.now()-i.days*86400000).toISOString();
      const listings=db.rows<{id:string;sku_id:string|null;external_id:string;title:string|null}>(`SELECT id,sku_id,external_id,title FROM listings WHERE account_id=? ORDER BY id`,account.id);
      const snapshots=db.rows<Record<string,unknown>>(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY listing_id ORDER BY captured_at DESC,id DESC) rn FROM listing_snapshots WHERE account_id=? AND captured_at>=?) WHERE rn=1 ORDER BY captured_at DESC,id DESC`,account.id,cutoff);
      const latest=new Map<unknown,Record<string,unknown>>();
      for(const r of snapshots)if(!latest.has(r.listing_id))latest.set(r.listing_id,r);
      const items=listings.map(l=>{
        const row=latest.get(l.id),metrics=parseJsonObject(String(row?.metrics_json??'')),evidence=parseJsonObject(String(row?.evidence_json??''));
        const stock=knownNumber(metrics,'stockAvailable'),units=knownNumber(metrics,'units'),spend=knownNumber(metrics,'adSpend'),pending=knownNumber(metrics,'questionsPending');
        const window=observedWindow(evidence);
        const coverage=window&&row?.source_class==='A_PRIMARY_UI'&&stock!==null&&units!==null&&units>0?stock/(units/window.days):null;
        return {...l,stock,units,adSpend:spend,questionsPending:pending,coverageDays:coverage,capturedAt:row?.captured_at??null,window,signals:[stock===0?'OUT_OF_STOCK':null,coverage!==null&&coverage<=7?'LOW_COVERAGE':null,stock===0&&spend!==null&&spend>0?'ADS_SPEND_WITH_ZERO_STOCK_OBSERVED':null,pending!==null&&pending>0?'PENDING_QUESTIONS':null].filter(Boolean)};
      });
      const history=db.rows<Record<string,unknown>>(`SELECT s.id,s.listing_id,s.captured_at,s.metrics_json,s.source_class,s.evidence_json,l.external_id,l.sku_id FROM listing_snapshots s JOIN listings l ON l.id=s.listing_id AND l.account_id=s.account_id WHERE s.account_id=? AND s.captured_at>=? ORDER BY s.captured_at DESC,s.id DESC LIMIT 501`,account.id,cutoff);
      const areaRows=db.rows<Record<string,unknown>>(`SELECT * FROM account_snapshots WHERE account_id=? AND captured_at>=? AND page_kind IN ('seller_inventory','seller_questions','seller_returns','seller_reputation') ORDER BY captured_at DESC,id DESC LIMIT 101`,account.id,cutoff);
      const warehouses=db.rows<Record<string,unknown>>(`SELECT * FROM capture_detail_snapshots WHERE account_id=? AND captured_at>=? AND kind='WAREHOUSE_STOCK' ORDER BY captured_at DESC,id DESC LIMIT 101`,account.id,cutoff);
      return {items,history:history.slice(0,500).map(r=>({...r,stock:knownNumber(parseJsonObject(String(r.metrics_json)),'stockAvailable')})),areas:areaRows.slice(0,100).map(r=>({...r,metrics:parseJsonObject(String(r.metrics_json)),evidence:parseJsonObject(String(r.evidence_json))})),warehouses:warehouses.slice(0,100).map(r=>({...r,metrics:parseJsonObject(String(r.metrics_json))})),truncated:history.length>500||areaRows.length>100||warehouses.length>100,coverageVerified:false,cutoff,method:'Último snapshot por anúncio. Estoque zero é distinto de ausente; não somar estoque de anúncios que compartilham SKU. Cobertura em dias exige janela de vendas explícita. Investimento e estoque observados não comprovam simultaneidade operacional.'};
    });

    this.register('competitor.evidence.record', (payload, auth) => db.transaction(() => {
      const i = z.object({ relationId: z.string(), priceCents: z.number().int().min(0).nullable().optional(), shippingCents: z.number().int().min(0).nullable().optional(), deliveryDaysMin: z.number().min(0).nullable().optional(), deliveryDaysMax: z.number().min(0).nullable().optional(), rating: z.number().min(0).max(5).nullable().optional(), reviews: z.number().int().min(0).nullable().optional(), sponsored: z.boolean().nullable().optional(), images: z.array(z.object({ url: z.string().url().max(2048), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(10).default([]), sourceClass: z.enum(['A_PRIMARY_UI','B_PLATFORM_EXPORT']), capturedAt: z.string().datetime().optional(), evidence: z.record(z.string(), z.string().max(2000)).default({}) }).refine((v) => v.deliveryDaysMin == null || v.deliveryDaysMax == null || v.deliveryDaysMin <= v.deliveryDaysMax, 'prazo mínimo não pode superar o máximo').parse(payload ?? {});
      const relation = db.row<{ id: string; status: string; monitoring_state: string; own_product_id: string; candidate_id: string }>('SELECT id,status,monitoring_state,own_product_id,candidate_id FROM competitor_relations WHERE id=?', i.relationId);
      if (!relation || relation.status === 'REJEITADO') throw new Error('relação de concorrência inexistente ou rejeitada');
      const id = randomUUID(); const capturedAt = i.capturedAt ?? nowIso();
      if(capturedAt>nowIso())throw Error('data da captura no futuro');
      db.db.prepare(`INSERT INTO competitor_monitoring_points (id,relation_id,captured_at,price_cents,rating,reviews,source_class,shipping_cents,delivery_days_min,delivery_days_max,sponsored,images_json,evidence_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,i.relationId,capturedAt,i.priceCents ?? null,i.rating ?? null,i.reviews ?? null,i.sourceClass,i.shippingCents ?? null,i.deliveryDaysMin ?? null,i.deliveryDaysMax ?? null,i.sponsored == null ? null : (i.sponsored ? 1 : 0),JSON.stringify(i.images),JSON.stringify(i.evidence));
      const candidate = db.row<{ id: string }>('SELECT id FROM competitor_candidates WHERE id=?', relation.candidate_id);
      if (candidate) db.db.prepare('UPDATE competitor_candidates SET shipping_cents=COALESCE(?,shipping_cents),delivery_days_min=COALESCE(?,delivery_days_min),delivery_days_max=COALESCE(?,delivery_days_max),sponsored=COALESCE(?,sponsored),images_json=CASE WHEN ?=0 THEN images_json ELSE ? END,last_seen_at=? WHERE id=? AND last_seen_at<=?')
        .run(i.shippingCents ?? null,i.deliveryDaysMin ?? null,i.deliveryDaysMax ?? null,i.sponsored == null ? null : (i.sponsored ? 1 : 0),i.images.length,JSON.stringify(i.images),capturedAt,candidate.id,capturedAt);
      this.audit(auth, 'COMPETITOR_EVIDENCE_RECORD', 'competitor_monitoring_point', id, 'OK', `${i.sourceClass}; ${i.images.length} image(s); dados ausentes preservados como NULL`);
      return { ok: true, id, relationId: i.relationId, capturedAt, visualComparison: 'HASH_ONLY_WHEN_PROVIDED', missingFieldsRemainNull: true };
    }));

    this.register('competitor.evidence.compare', (payload) => {
      const i = z.object({relationId:z.string(),accountId:z.string().min(1).optional()}).parse(payload ?? {});
      const row = db.row<Record<string, unknown>>(`SELECT r.id,r.status,o.title own_title,o.attributes_json own_attributes,o.price_cents own_price,o.shipping_cents own_shipping,o.delivery_days_min own_delivery_min,o.delivery_days_max own_delivery_max,o.images_json own_images,c.title competitor_title,c.attributes_json competitor_attributes,c.rating competitor_rating,c.reviews competitor_reviews,c.price_cents competitor_price,c.shipping_cents competitor_shipping,c.delivery_days_min competitor_delivery_min,c.delivery_days_max competitor_delivery_max,c.images_json competitor_images,c.sponsored,
        p.id AS observed_id,p.captured_at AS observed_at,p.price_cents AS observed_price,p.shipping_cents AS observed_shipping,
        p.delivery_days_min AS observed_delivery_min,p.delivery_days_max AS observed_delivery_max,p.images_json AS observed_images,p.sponsored AS observed_sponsored,p.rating observed_rating,p.reviews observed_reviews,p.position observed_position,p.promotions_json observed_promotions,p.title observed_title
        FROM competitor_relations r JOIN own_products o ON o.id=r.own_product_id
        JOIN competitor_candidates c ON c.id=r.candidate_id AND c.own_product_id=o.id
        LEFT JOIN competitor_monitoring_points p ON p.id=(
          SELECT newest.id FROM competitor_monitoring_points newest
          WHERE newest.relation_id=r.id AND newest.captured_at<=? ORDER BY newest.captured_at DESC,newest.rowid DESC LIMIT 1
        )
        WHERE r.id=? AND (? IS NULL OR o.account_id=?)`,nowIso(),i.relationId,i.accountId??null,i.accountId??null);
      if (!row) throw new Error('relação de concorrência não encontrada');
      const ownImages = (() => { try { return JSON.parse(String(row.own_images ?? '[]')) as Array<{ sha256?: string }>; } catch { return []; } })();
      const compImages = (() => { try { return JSON.parse(String((row.observed_id?row.observed_images:row.competitor_images) ?? '[]')) as Array<{ sha256?: string }>; } catch { return []; } })();
      const ownHashes = new Set(ownImages.map((image) => image.sha256).filter(Boolean));
      const sharedHashes = compImages.map((image) => image.sha256).filter((hash): hash is string => Boolean(hash && ownHashes.has(hash)));
      const diff = (own: unknown, competitor: unknown) => own == null || competitor == null ? null : Number(competitor) - Number(own);
      const sponsored=row.observed_id?row.observed_sponsored:row.sponsored;
      return { relationId: i.relationId, status: row.status, observedAt:row.observed_at??null, competitorRating:row.observed_id?row.observed_rating:row.competitor_rating,competitorReviews:row.observed_id?row.observed_reviews:row.competitor_reviews,position:row.observed_position??null,promotions:row.observed_promotions?parseJsonObject(String(row.observed_promotions)):null,catalogComparison:compareCatalogText(String(row.own_title),String(row.competitor_title),parseJsonObject(String(row.own_attributes??'{}')),parseJsonObject(String(row.competitor_attributes??'{}'))),priceDifferenceCents: diff(row.own_price,row.observed_id?row.observed_price:row.competitor_price), shippingDifferenceCents: diff(row.own_shipping,row.observed_id?row.observed_shipping:row.competitor_shipping), deliveryDaysMinDifference: diff(row.own_delivery_min,row.observed_id?row.observed_delivery_min:row.competitor_delivery_min), deliveryDaysMaxDifference: diff(row.own_delivery_max,row.observed_id?row.observed_delivery_max:row.competitor_delivery_max), images: { ownCount: ownImages.length, competitorCount: compImages.length, identicalHashes: sharedHashes.length, visualSimilarity: 'NOT_COMPUTED', explanation: 'hashes iguais indicam arquivo idêntico; hashes diferentes/ausentes não provam diferença visual' }, sponsored: sponsored == null ? null : Boolean(sponsored), unknowns: ['frete/prazo não coletados permanecem null','patrocínio só é informado quando visível e registrado'] };
    });

    this.register('campaign.change.prepare', (payload, auth) => {
      const i = z.object({ accountId: z.string(), marketplace: z.string(), campaignRef: z.string().min(1).max(200), baseline: z.record(z.string(), z.unknown()), changes: z.record(z.string(), z.unknown()), reason: z.string().min(5).max(2000) }).parse(payload ?? {});
      if (!db.row('SELECT id FROM accounts WHERE id=? AND marketplace=? AND is_active=1', i.accountId, i.marketplace)) throw new Error('conta ativa e marketplace não correspondem');
      operationAccount(i.accountId);
      if (!Object.keys(i.changes).length||!Object.keys(i.baseline).length) throw new Error('estado inicial e alteração proposta são obrigatórios');
      if(JSON.stringify(i.baseline).length>20000||JSON.stringify(i.changes).length>20000)throw new Error('proposta muito extensa');
      const id = randomUUID(); const now = nowIso();
      db.db.prepare('INSERT INTO campaign_change_proposals (id,account_id,marketplace,campaign_ref,baseline_json,changes_json,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'DRAFT\',?,?,?)')
        .run(id,i.accountId,i.marketplace,i.campaignRef,JSON.stringify(i.baseline),JSON.stringify(i.changes),i.reason,auth?.userId ?? null,now,now);
      this.audit(auth, 'CAMPAIGN_CHANGE_PREPARE', 'campaign_change_proposal', id, 'OK', 'rascunho local; nenhuma API ou interface foi alterada');
      return { ok: true, id, status: 'DRAFT', execution: 'NOT_EXECUTED', requiresHumanReview: true };
    });
    this.register('campaign.change.list', (payload) => {
      const i = z.object({ accountId: z.string().optional(), status: z.enum(['DRAFT','APPROVED','REJECTED','BLOCKED','EXECUTED','FAILED']).optional(), limit: z.number().int().min(1).max(500).default(100) }).parse(payload ?? {});
      return db.rows<Record<string, unknown>>('SELECT * FROM campaign_change_proposals WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR status=?) ORDER BY created_at DESC LIMIT ?',i.accountId ?? null,i.accountId ?? null,i.status ?? null,i.status ?? null,i.limit).map((r)=>({...r,baseline:parseJsonObject(String(r.baseline_json)),changes:parseJsonObject(String(r.changes_json))}));
    });
    this.register('campaign.change.review', (payload, auth) => {
      const i = z.object({ accountId:z.string().min(1),proposalId: z.string(), decision: z.enum(['APPROVED','REJECTED']), reason: z.string().min(3).max(1000) }).parse(payload ?? {});
      if (auth?.role !== 'super_admin') throw new Error('somente super_admin pode aprovar alterações de campanha');
      operationAccount(i.accountId);
      const row = db.row<{ id: string; status: string }>('SELECT id,status FROM campaign_change_proposals WHERE id=? AND account_id=?',i.proposalId,i.accountId);
      if (!row || row.status !== 'DRAFT') throw new Error('proposta inexistente ou já revisada');
      const changed=db.db.prepare("UPDATE campaign_change_proposals SET status=?,approved_by=?,approved_at=?,updated_at=? WHERE id=? AND account_id=? AND status='DRAFT'")
        .run(i.decision, i.decision==='APPROVED' ? auth.userId : null, i.decision==='APPROVED' ? nowIso() : null, nowIso(), i.proposalId,i.accountId);
      if(changed.changes!==1)throw Error('proposta já revisada');
      this.audit(auth, 'CAMPAIGN_CHANGE_REVIEW', 'campaign_change_proposal', i.proposalId, i.decision, i.reason);
      return { ok: true, status: i.decision, execution: 'BLOCKED_UNTIL_MARKETPLACE_ADAPTER_AND_SESSION_ARE_VERIFIED', changedRemotely: false };
    });

    const assistedLimitsSchema=z.object({
      maxCampaignDailyBudgetCents:z.number().int().min(1).max(100000000),
      minVariationPriceCents:z.number().int().min(1).max(100000000),
      maxVariationPriceCents:z.number().int().min(1).max(100000000),
      maxVariationStock:z.number().int().min(0).max(1000000),
      maxVariationPriceChangePct:z.number().finite().min(0).max(100)
    }).strict().refine(v=>v.minVariationPriceCents<=v.maxVariationPriceCents,'faixa de preços inválida');
    const readAssistedLimits=(accountId:string)=>{
      const row=db.row<{value_json:string}>('SELECT value_json FROM settings WHERE key=?','assisted_limits:'+accountId);
      if(!row)return null;
      const parsed=assistedLimitsSchema.safeParse(parseJsonObject(row.value_json));
      return parsed.success?parsed.data:null;
    };
    this.register('operation.limits.get',payload=>{
      const i=z.object({accountId:z.string().min(1)}).strict().parse(payload);operationAccount(i.accountId);
      return {limits:readAssistedLimits(i.accountId),scope:'PER_CAMPAIGN_AND_VARIATION',accountTotalBudgetVerified:false};
    });
    this.register('operation.limits.set',(payload,auth)=>{
      const i=z.object({accountId:z.string().min(1),limits:assistedLimitsSchema,confirmed:z.literal(true)}).strict().parse(payload);operationAccount(i.accountId);
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      db.db.prepare('INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run('assisted_limits:'+i.accountId,JSON.stringify(i.limits),nowIso(),auth.userId??null);
      this.audit(auth,'ASSISTED_LIMITS_SET','account',i.accountId,'OK','limites de operação assistida confirmados');
      return {ok:true,limits:i.limits};
    });
    const budgetContext=z.object({accountId:z.string().min(1),campaignRef:z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),sourcePath:z.string().min(1).max(1000),documentNonce:z.string().uuid(),budgetCents:z.number().int().min(0).max(100000000),campaignStatus:z.enum(['ACTIVE','PAUSED']).optional(),roasTargetHundredths:z.number().int().min(100).max(3500).optional()});
    const budgetSource=(path:string)=>{
      const url=new URL(path);
      if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port||url.hostname!=='vendedores.mercadolivre.com.br'||!/(?:^|\/)(?:publicidade|product_ads|product-ads|ads)(?:\/|$)/.test(url.pathname))throw Error('página de publicidade não reconhecida');
      return url.origin+url.pathname;
    };
    this.register('campaign.budget.claim',(payload,auth)=>db.transaction(()=>{
      const i=budgetContext.extend({proposalId:z.string().min(1),confirmed:z.literal(true)}).strict().parse(payload);
      const account=operationAccount(i.accountId);
      if(auth?.role!=='super_admin'||account.marketplace!=='mercado_livre')throw Error('executor inicial restrito ao Mercado Livre e super_admin');
      const source=budgetSource(i.sourcePath);
      const p=db.row<{campaign_ref:string;baseline_json:string;changes_json:string;status:string;marketplace:string}>('SELECT campaign_ref,baseline_json,changes_json,status,marketplace FROM campaign_change_proposals WHERE id=? AND account_id=?',i.proposalId,i.accountId);
      if(!p||p.status!=='APPROVED'||p.marketplace!==account.marketplace||p.campaign_ref!==i.campaignRef)throw Error('proposta aprovada não corresponde à campanha');
      const before=parseJsonObject(p.baseline_json),after=parseJsonObject(p.changes_json);
      const budget=z.number().int().min(1).max(100000000);
      const schema=z.object({dailyBudgetCents:budget,status:z.enum(['ACTIVE','PAUSED']).optional(),roasTargetHundredths:z.number().int().min(100).max(3500).optional()}).strict();
      const baseline=schema.parse(before),target=schema.parse(after);
      const b=baseline.dailyBudgetCents,t=target.dailyBudgetCents;
      const beforeStatus=baseline.status,targetStatus=target.status,beforeRoas=baseline.roasTargetHundredths,targetRoas=target.roasTargetHundredths;
      const statusMode=beforeStatus!==undefined,roasMode=beforeRoas!==undefined;
      const validChange=statusMode?b===t&&beforeStatus!==targetStatus:roasMode?b===t&&beforeRoas!==targetRoas:b!==t;
      if(b!==i.budgetCents||i.campaignStatus!==beforeStatus||i.roasTargetHundredths!==beforeRoas||
         statusMode!==(targetStatus!==undefined)||roasMode!==(targetRoas!==undefined)||(statusMode&&roasMode)||!validChange)throw Error('estado visível diverge do aprovado ou não há mudança válida');
      if(db.row('SELECT id FROM operation_manual_receipts WHERE proposal_kind=? AND proposal_id=?','CAMPAIGN',i.proposalId))throw Error('já existe relato manual da proposta');
      if(db.row('SELECT id FROM campaign_budget_executions WHERE proposal_id=?',i.proposalId))throw Error('autorização já utilizada; verifique o resultado sem repetir o clique');
      const limits=readAssistedLimits(i.accountId);
      const conflict=db.row("SELECT id FROM campaign_budget_executions WHERE account_id=? AND campaign_ref=? AND status IN ('CLAIMED','NEEDS_VERIFICATION')",i.accountId,i.campaignRef);
      const guard=evaluateGuard({action:'change_campaign_budget',actorRole:auth.role,marketplace:{id:account.marketplace,enabled:Boolean(db.row('SELECT id FROM marketplaces WHERE id=? AND enabled=1',account.marketplace))},account:{id:account.id,marketplace:account.marketplace,verified:true,sessionState:'AUTHENTICATED'},listing:null,campaign:{id:i.campaignRef,accountId:account.id},currentState:{dailyBudgetCents:b},financialLimits:limits?{...limits,targetDailyBudgetCents:t}:null,requiredData:{missing:[]},platformRules:{violations:[]},authorization:{approved:true,approvedBy:auth.userId},conflicts:conflict?['execução anterior pendente']:[]});
      if(!guard.allowed)throw Error(guard.blockedReasons.join('; '));
      const id=randomUUID(),token=randomUUID(),now=nowIso(),expiresAt=new Date(Date.now()+120000).toISOString();
      db.db.prepare('INSERT INTO campaign_budget_executions(id,proposal_id,account_id,campaign_ref,before_cents,target_cents,source_path,document_nonce,token_hash,status,created_at,expires_at,updated_at,before_campaign_status,target_campaign_status,before_roas_target,target_roas_target) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,i.proposalId,i.accountId,i.campaignRef,b,t,source,i.documentNonce,createHash('sha256').update(token).digest('hex'),'CLAIMED',now,expiresAt,now,beforeStatus??null,targetStatus??null,beforeRoas??null,targetRoas??null);
      this.audit(auth,'CAMPAIGN_BUDGET_CLAIM','campaign_change_proposal',i.proposalId,'CLAIMED','autorização de clique único; expira em dois minutos');
      return {id,token,accountId:i.accountId,campaignRef:i.campaignRef,beforeCents:b,targetCents:t,beforeStatus,targetStatus,beforeRoas,targetRoas,sourcePath:source,documentNonce:i.documentNonce,expiresAt};
    }));
    this.register('campaign.budget.result',(payload,auth)=>db.transaction(()=>{
      const i=z.object({id:z.string().uuid(),token:z.string().uuid(),outcome:z.enum(['CANCELLED','FAILED','NEEDS_VERIFICATION']),message:z.string().max(1000)}).strict().parse(payload);
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      const e=db.row<{proposal_id:string;account_id:string;status:string;token_hash:string}>('SELECT proposal_id,account_id,status,token_hash FROM campaign_budget_executions WHERE id=?',i.id);
      if(!e||e.status!=='CLAIMED'||e.token_hash!==createHash('sha256').update(i.token).digest('hex'))throw Error('execução inválida ou já consumida');
      operationAccount(e.account_id);
      db.db.prepare('UPDATE campaign_budget_executions SET status=?,updated_at=?,result_json=? WHERE id=? AND status=?').run(i.outcome,nowIso(),JSON.stringify({message:i.message}),i.id,'CLAIMED');
      this.audit(auth,'CAMPAIGN_BUDGET_RESULT','campaign_change_proposal',e.proposal_id,i.outcome,i.message);
      return {status:i.outcome,remoteVerified:false};
    }));
    this.register('campaign.budget.verify',(payload,auth)=>db.transaction(()=>{
      const i=budgetContext.extend({proposalId:z.string().min(1)}).strict().parse(payload);
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      operationAccount(i.accountId);
      const e=db.row<{id:string;status:string;campaign_ref:string;target_cents:number;target_campaign_status:string|null;target_roas_target:number|null;source_path:string;document_nonce:string;expires_at:string}>('SELECT id,status,campaign_ref,target_cents,target_campaign_status,target_roas_target,source_path,document_nonce,expires_at FROM campaign_budget_executions WHERE proposal_id=? AND account_id=?',i.proposalId,i.accountId);
      if(!e||!['CLAIMED','NEEDS_VERIFICATION'].includes(e.status)||e.campaign_ref!==i.campaignRef||e.source_path!==budgetSource(i.sourcePath)||e.document_nonce===i.documentNonce)throw Error('nova leitura em documento recarregado da mesma campanha necessária');
      if(e.status==='CLAIMED'&&e.expires_at>nowIso())throw Error('aguarde expiração da execução interrompida');
      if(e.target_cents!==i.budgetCents||(e.target_campaign_status??undefined)!==i.campaignStatus||(e.target_roas_target??undefined)!==i.roasTargetHundredths)return {status:'NEEDS_VERIFICATION',remoteVerified:false,message:'valor observado não corresponde ao aprovado; nenhuma retentativa'};
      db.db.prepare('UPDATE campaign_budget_executions SET status=?,updated_at=?,result_json=? WHERE id=?').run('UI_READBACK_MATCHED',nowIso(),JSON.stringify({observedBudgetCents:i.budgetCents,observedCampaignStatus:i.campaignStatus,observedRoasTarget:i.roasTargetHundredths,sourcePath:i.sourcePath,documentNonce:i.documentNonce}),e.id);
      db.db.prepare("UPDATE campaign_change_proposals SET status='EXECUTED',updated_at=? WHERE id=? AND account_id=? AND status='APPROVED'").run(nowIso(),i.proposalId,i.accountId);
      this.audit(auth,'CAMPAIGN_BUDGET_READBACK','campaign_change_proposal',i.proposalId,'UI_READBACK_MATCHED','valor observado em novo documento; não comprova causalidade');
      return {status:'UI_READBACK_MATCHED',remoteVerified:false,uiReadbackMatched:true};
    }));
    this.register('campaign.budget.list',(payload)=>{
      const i=z.object({accountId:z.string().min(1)}).strict().parse(payload);operationAccount(i.accountId);
      return db.rows('SELECT id,proposal_id,account_id,campaign_ref,before_cents,target_cents,before_campaign_status,target_campaign_status,before_roas_target,target_roas_target,status,created_at,expires_at,updated_at,result_json FROM campaign_budget_executions WHERE account_id=? ORDER BY created_at DESC LIMIT 200',i.accountId);
    });

    this.register('offer.variation.prepare', (payload, auth) => {
      const i = z.object({ accountId: z.string(), listingId: z.string(), variationName: z.string().min(1).max(120), options: z.array(z.record(z.string(), z.unknown())).min(1).max(100), proposedPriceCents: z.number().int().min(0).nullable().optional(), proposedStock: z.number().int().min(0).nullable().optional() }).parse(payload ?? {});
      operationAccount(i.accountId);
      if(JSON.stringify(i.options).length>20000||i.options.some(o=>Object.keys(o).length===0))throw Error('opções vazias ou muito extensas');
      const listing = db.row<{ id: string; account_id: string }>('SELECT id,account_id FROM listings WHERE id=? AND account_id=?',i.listingId,i.accountId);
      if (!listing) throw new Error('anúncio não pertence à conta');
      const id=randomUUID(); const now=nowIso();
      db.db.prepare('INSERT INTO offer_variation_proposals (id,account_id,listing_id,variation_name,options_json,proposed_price_cents,proposed_stock,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'DRAFT\',?,?,?)')
        .run(id,i.accountId,i.listingId,i.variationName,JSON.stringify(i.options),i.proposedPriceCents ?? null,i.proposedStock ?? null,auth?.userId ?? null,now,now);
      this.audit(auth,'OFFER_VARIATION_PREPARE','offer_variation_proposal',id,'OK','variação salva como proposta local');
      return { ok:true,id,status:'DRAFT',published:false };
    });
    this.register('offer.variation.list', (payload) => {
      const i=z.object({accountId:z.string().optional(),listingId:z.string().optional(),limit:z.number().int().min(1).max(500).default(100)}).parse(payload ?? {});
      return db.rows<Record<string,unknown>>('SELECT * FROM offer_variation_proposals WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR listing_id=?) ORDER BY created_at DESC LIMIT ?',i.accountId ?? null,i.accountId ?? null,i.listingId ?? null,i.listingId ?? null,i.limit).map((r)=>({...r,options:JSON.parse(String(r.options_json))}));
    });
    this.register('offer.variation.review', (payload, auth) => {
      const i=z.object({accountId:z.string().min(1),id:z.string(),decision:z.enum(['APPROVED','REJECTED']),reason:z.string().min(3).max(1000)}).parse(payload ?? {});
      if(auth?.role!=='super_admin') throw new Error('somente super_admin pode aprovar variações');
      operationAccount(i.accountId);
      const row=db.row<{id:string;status:string}>('SELECT id,status FROM offer_variation_proposals WHERE id=? AND account_id=?',i.id,i.accountId);
      if(!row || row.status!=='DRAFT') throw new Error('proposta inexistente ou já revisada');
      const changed=db.db.prepare("UPDATE offer_variation_proposals SET status=?,updated_at=? WHERE id=? AND account_id=? AND status='DRAFT'").run(i.decision,nowIso(),i.id,i.accountId);
      if(changed.changes!==1)throw Error('proposta já revisada');
      this.audit(auth,'OFFER_VARIATION_REVIEW','offer_variation_proposal',i.id,i.decision,i.reason);
      return {ok:true,status:i.decision,published:false,execution:'REQUIRES_MARKETPLACE_UI_VALIDATION'};
    });

    this.register('listing.change.prepare',(payload,auth)=>{
      const i=z.object({accountId:z.string().min(1),listingId:z.string().min(1),kind:z.enum(['COVER','DUPLICATE']),mediaId:z.string().min(1).optional(),reason:z.string().trim().min(5).max(2000)}).strict().parse(payload);
      operationAccount(i.accountId);
      const baseline=db.row<{id:string}>(`SELECT s.id FROM listing_snapshots s JOIN listings l ON l.id=s.listing_id AND l.account_id=s.account_id WHERE s.account_id=? AND s.listing_id=? AND s.source_class='A_PRIMARY_UI' ORDER BY s.captured_at DESC,s.id DESC LIMIT 1`,i.accountId,i.listingId);
      if(!baseline)throw Error('capture o anúncio da conta antes de preparar uma alteração');
      const image=i.mediaId?db.row<{sha256:string}>('SELECT sha256 FROM media_library WHERE id=? AND account_id=?',i.mediaId,i.accountId):null;
      if(i.kind==='COVER'&&!image)throw Error('selecione uma imagem da mesma loja');
      if(i.kind==='DUPLICATE'&&i.mediaId)throw Error('duplicação não permite alterar capa na mesma proposta');
      const id=randomUUID(),now=nowIso();
      db.db.prepare('INSERT INTO listing_change_proposals(id,account_id,listing_id,kind,media_id,media_sha256,baseline_snapshot_id,reason,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,i.accountId,i.listingId,i.kind,i.mediaId??null,image?.sha256??null,baseline.id,i.reason,auth?.userId??null,now,now);
      this.audit(auth,'LISTING_CHANGE_PREPARE','listing_change_proposal',id,'OK','rascunho local; disponibilidade de operação remota não comprovada');
      return {id,status:'DRAFT',published:false};
    });
    this.register('listing.change.list',(payload)=>{
      const i=z.object({accountId:z.string().min(1)}).strict().parse(payload);operationAccount(i.accountId);
      return db.rows('SELECT p.*,l.external_id,l.title,m.filename FROM listing_change_proposals p JOIN listings l ON l.id=p.listing_id AND l.account_id=p.account_id LEFT JOIN media_library m ON m.id=p.media_id AND m.account_id=p.account_id WHERE p.account_id=? ORDER BY p.created_at DESC,p.id LIMIT 200',i.accountId);
    });
    this.register('listing.change.review',(payload,auth)=>{
      const i=z.object({accountId:z.string().min(1),id:z.string().min(1),decision:z.enum(['APPROVED','REJECTED']),reason:z.string().trim().min(3).max(1000)}).strict().parse(payload);
      operationAccount(i.accountId);
      if(auth?.role!=='super_admin')throw Error('somente super_admin pode revisar');
      const p=db.row<{kind:string;status:string;media_id:string|null;media_sha256:string|null}>('SELECT kind,status,media_id,media_sha256 FROM listing_change_proposals WHERE id=? AND account_id=?',i.id,i.accountId);
      if(!p||p.status!=='DRAFT')throw Error('proposta não disponível');
      if(i.decision==='APPROVED'&&p.kind==='COVER'&&!db.row('SELECT id FROM media_library WHERE id=? AND account_id=? AND sha256=?',p.media_id,i.accountId,p.media_sha256))throw Error('a imagem original não está mais disponível');
      const now=nowIso();
      const changed=db.db.prepare("UPDATE listing_change_proposals SET status=?,approved_by=?,approved_at=?,updated_at=? WHERE id=? AND account_id=? AND status='DRAFT'").run(i.decision,i.decision==='APPROVED'?auth.userId:null,i.decision==='APPROVED'?now:null,now,i.id,i.accountId);
      if(changed.changes!==1)throw Error('proposta já revisada');
      this.audit(auth,'LISTING_CHANGE_REVIEW','listing_change_proposal',i.id,i.decision,i.reason);
      return {status:i.decision,published:false,execution:'MANUAL_ONLY_NOT_VERIFIED'};
    });
    this.register('offer.variation.update',(payload,auth)=>{
      const i=z.object({accountId:z.string().min(1),id:z.string().min(1),variationName:z.string().trim().min(1).max(120),options:z.array(z.record(z.string(),z.unknown())).min(1).max(100),proposedPriceCents:z.number().int().min(0).nullable().optional(),proposedStock:z.number().int().min(0).nullable().optional()}).strict().parse(payload);
      operationAccount(i.accountId);
      const serialized=JSON.stringify(i.options);if(serialized.length>20000||i.options.some(o=>Object.keys(o).length===0))throw Error('opções vazias ou muito extensas');
      const result=db.db.prepare("UPDATE offer_variation_proposals SET variation_name=?,options_json=?,proposed_price_cents=?,proposed_stock=?,updated_at=? WHERE id=? AND account_id=? AND status='DRAFT'").run(i.variationName,serialized,i.proposedPriceCents??null,i.proposedStock??null,nowIso(),i.id,i.accountId);
      if(result.changes!==1)throw Error('somente rascunho da mesma conta pode ser editado');
      this.audit(auth,'OFFER_VARIATION_UPDATE','offer_variation_proposal',i.id,'OK');return {ok:true,status:'DRAFT',published:false};
    });
    this.register('offer.variation.delete',(payload,auth)=>{
      const i=z.object({accountId:z.string().min(1),id:z.string().min(1)}).strict().parse(payload);operationAccount(i.accountId);
      const result=db.db.prepare("DELETE FROM offer_variation_proposals WHERE id=? AND account_id=? AND status='DRAFT'").run(i.id,i.accountId);
      if(result.changes!==1)throw Error('somente rascunho da mesma conta pode ser excluído');
      this.audit(auth,'OFFER_VARIATION_DELETE','offer_variation_proposal',i.id,'OK');return {ok:true};
    });
    const listingBrowserContext=z.object({
      accountId:z.string().min(1),externalListingId:z.string().regex(/^MLB-?\d{5,}$/i),sourcePath:z.string().max(1000),documentNonce:z.string().uuid(),
      action:z.enum(['DUPLICATE','CREATE_VARIATION','EDIT_VARIATION']),variationId:z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).optional(),
      variationLabel:z.string().max(120).optional(),beforePriceCents:z.number().int().min(0).max(100000000).optional(),beforeStock:z.number().int().min(0).max(1000000).optional()
    });
    const listingBrowserSource=(path:string,action:string,externalId:string)=>{
      const url=new URL(path);
      if(url.origin!=='https://vendedores.mercadolivre.com.br'||url.username||url.password||url.search||url.hash)throw Error('origem de vendedor não autorizada');
      if(action==='DUPLICATE'){
        if(!/^\/(?:vendas\/)?(?:anuncios|publicaciones|moderador|mis-publicaciones|items|itens)(?:\/|$)/i.test(url.pathname)||/(editar|edit|modificar)/i.test(url.pathname))throw Error('abra a listagem do vendedor');
      }else if(!/(?:editar|edit|modificar|modify)(?:\/|$)/i.test(url.pathname)||!url.pathname.toUpperCase().split('/').includes(externalId.toUpperCase()))throw Error('abra o editor do anúncio aprovado');
      return url.origin+url.pathname;
    };
    type VariantCapture={id:string;captured_at:string;metrics_json:string;label:string|null;context_json:string};
    const variantCaptureScope="FROM capture_detail_snapshots WHERE account_id=? AND marketplace=? AND kind='LISTING_VARIANT' AND parent_external_id=? AND external_id=? AND source_class='A_PRIMARY_UI'";
    const variantCaptureFields='SELECT id,captured_at,metrics_json,label,context_json ';
    const variantValues=(capture:VariantCapture)=>{
      if(parseJsonObject(capture.context_json).coverageWarnings)return null;
      const metrics=parseJsonObject(capture.metrics_json);
      const price=knownNumber(metrics,'price'),stock=knownNumber(metrics,'stockAvailable');
      if(price===null||!Number.isSafeInteger(Math.round(price*100))||stock===null||!Number.isSafeInteger(stock))return null;
      return {priceCents:Math.round(price*100),stock};
    };
    const legacyApiInput=z.object({
      accountId:z.string().min(1),proposalId:z.string().min(1),accessToken:z.string().trim().min(10).max(4096).regex(/^[A-Za-z0-9._~-]+$/),
    });
    const variationApiTarget=(accountId:string,proposalId:string)=>{
      const account=operationAccount(accountId);
      if(account.marketplace!=='mercado_livre')throw Error('executor oficial disponível para Mercado Livre');
      const handle=db.row<{handle:string|null}>('SELECT handle FROM accounts WHERE id=?',accountId)?.handle?.trim();
      if(!handle)throw Error('o apelido oficial deve constar na conta local');
      const row=db.row<{listing_id:string;external_id:string;listing_status:string;options_json:string;proposed_price_cents:number|null;proposed_stock:number|null}>(`
        SELECT p.listing_id,l.external_id,l.status listing_status,p.options_json,p.proposed_price_cents,p.proposed_stock
        FROM offer_variation_proposals p JOIN listings l ON l.id=p.listing_id AND l.account_id=p.account_id
        WHERE p.id=? AND p.account_id=? AND p.status='APPROVED' AND l.marketplace='mercado_livre'`,proposalId,accountId);
      if(!row||row.listing_status==='CLOSED')throw Error('proposta aprovada de anúncio da mesma conta necessária');
      const [option]=z.tuple([z.union([legacyVariationOption,legacyStockOption,upOfferOption,z.object({removeVariationId:z.string().regex(/^\d{1,20}$/)}).strict()])]).parse(JSON.parse(row.options_json));
      const priceCents=z.number().int().min(1).max(100000000).parse(row.proposed_price_cents);
      const stock=z.number().int().min(0).max(1000000).parse(row.proposed_stock);
      return { handle,listingId:row.listing_id,externalId:row.external_id,status:row.listing_status,option,priceCents,stock };
    };
    type VariationApiExecution={seller_id:string;item_id:string;variation_id:string|null;status:string;started_at:string;updated_at:string;price_cents:number;stock:number;action:'CREATE_VARIATION'|'REMOVE_VARIATION'|'EDIT_VARIATION'|'CREATE_UP_OFFER'};
    const readVariationExecution=(accountId:string,proposalId:string)=>db.row<VariationApiExecution>(
      'SELECT seller_id,item_id,variation_id,status,started_at,updated_at,price_cents,stock,action FROM listing_api_executions WHERE account_id=? AND proposal_id=?',accountId,proposalId);
    const reserveVariationApi=(i:{accountId:string;proposalId:string},p:ReturnType<typeof variationApiTarget>,
      auth:NonNullable<Parameters<Handler>[1]>,action:VariationApiExecution['action'],sellerId:string,itemId:string,targetVariationId:string|null)=>{
      db.transaction(()=>{
        if(canonicalJson(variationApiTarget(i.accountId,i.proposalId))!==canonicalJson(p))throw Error('contexto local mudou durante a consulta');
        if(readVariationExecution(i.accountId,i.proposalId)||
           db.row("SELECT id FROM operation_manual_receipts WHERE proposal_kind='VARIATION' AND proposal_id=?",i.proposalId)||
           db.row("SELECT id FROM listing_browser_executions WHERE proposal_kind='VARIATION' AND proposal_id=?",i.proposalId))throw Error('proposta já utilizada');
        if(db.row("SELECT proposal_id FROM listing_api_executions WHERE account_id=? AND listing_id=? AND status<>'REMOTE_VERIFIED'",i.accountId,p.listingId)||
           db.row("SELECT id FROM listing_browser_executions WHERE account_id=? AND listing_id=? AND status IN ('CLAIMED','NEEDS_VERIFICATION')",i.accountId,p.listingId)||
           db.row("SELECT id FROM task_items WHERE account_id=? AND listing_id=? AND status IN ('PROCESSING','PUBLISHING','APPROVED_TO_PUBLISH','UNCERTAIN')",i.accountId,p.listingId))throw Error('execução anterior pendente');
        if(action==='CREATE_UP_OFFER'){
          if(!('userProductId' in p.option))throw Error('proposta User Products divergente');
          if(db.row(`SELECT r.proposal_id FROM listing_api_executions r JOIN offer_variation_proposals v ON v.id=r.proposal_id AND v.account_id=r.account_id
            WHERE r.account_id=? AND r.action='CREATE_UP_OFFER' AND json_extract(v.options_json,'$[0].userProductId')=?
            AND (r.status<>'REMOTE_VERIFIED' OR json_extract(v.options_json,'$[0].listingTypeId')=?)`,i.accountId,p.option.userProductId,p.option.listingTypeId))throw Error('User Product com operação pendente ou condição já executada');
        }
        const limits=readAssistedLimits(i.accountId);
        const guard=evaluateGuard({action:action==='CREATE_VARIATION'||action==='CREATE_UP_OFFER'?'create_variation':'edit_variation',actorRole:auth.role,
          marketplace:{id:'mercado_livre',enabled:Boolean(db.row("SELECT id FROM marketplaces WHERE id='mercado_livre' AND enabled=1"))},
          account:{id:i.accountId,marketplace:'mercado_livre',verified:true,sessionState:'AUTHENTICATED'},
          listing:{id:p.listingId,accountId:i.accountId,externalId:p.externalId,status:p.status},
          currentState:{externalListingId:p.externalId,sourcePath:'https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/'+itemId},
          financialLimits:limits?{...limits,targetVariationPriceCents:p.priceCents,targetVariationStock:p.stock,currentPriceCents:p.priceCents}:null,
          requiredData:{missing:[]},platformRules:{violations:[]},authorization:{approved:true,approvedBy:auth.userId},conflicts:[]});
        if(!guard.allowed)throw Error(guard.blockedReasons.join('; '));
        const now=nowIso();
        db.db.prepare('INSERT INTO listing_api_executions(proposal_id,account_id,listing_id,seller_id,item_id,price_cents,stock,status,started_at,updated_at,action,variation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(i.proposalId,i.accountId,p.listingId,sellerId,itemId,p.priceCents,p.stock,'DISPATCHED',now,now,action,targetVariationId);
        this.audit(auth,'VARIATION_API_WRITE','offer_variation_proposal',i.proposalId,'DISPATCHED',action);
      });
    };
    const executeVariationApi=(action:Exclude<VariationApiExecution['action'],'CREATE_UP_OFFER'>):Handler=>async(payload,auth)=>{

      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      const i=legacyApiInput.extend({confirmed:z.literal(true)}).strict().parse(payload);
      if(readVariationExecution(i.accountId,i.proposalId))throw Error('proposta já encaminhada; não repetir a criação');
      const p=variationApiTarget(i.accountId,i.proposalId);
      const api=new MercadoLivreVariations(i.accessToken);
      const {item,sellerId}=await api.readOwner(p.externalId,p.handle);
      const option=p.option;
      if(action==='REMOVE_VARIATION'){
        if(!('removeVariationId' in option)||p.stock!==0)throw Error('proposta de remoção com estoque zero necessária');
        api.checkRemoval(item,option.removeVariationId,p.priceCents);
      }else if(action==='EDIT_VARIATION'){
        if(!('editVariationId' in option))throw Error('proposta de edição de estoque necessária');
        api.checkStockEdit(item,option,p.priceCents,p.stock);
      }else{
        if(!('attributeCombinations' in option))throw Error('proposta de criação necessária');
        api.checkNewOption(item,option);
      }

      const targetVariationId='removeVariationId' in option?option.removeVariationId:'editVariationId' in option?option.editVariationId:null;
      reserveVariationApi(i,p,auth,action,sellerId,item.id,targetVariationId);
      let variationId:string|null=targetVariationId;
      let verified=false;
      try{
        if('removeVariationId' in option){
          await api.remove(item.id,option.removeVariationId);
          const after=await api.readOwner(item.id,p.handle);
          verified=after.sellerId===sellerId&&!after.item.variations.some(row=>row.id===option.removeVariationId);
        }else if('editVariationId' in option){
          await api.editStock(item,option,p.stock);
          const after=await api.readOwner(item.id,p.handle);
          verified=after.sellerId===sellerId&&await api.matchesStock(after.item,option.editVariationId,p.priceCents,p.stock);
        }else if('attributeCombinations' in option){
          const created=await api.create(item.id,option,p.priceCents,p.stock);
          if(item.variations.some(variant=>variant.id===created))throw Error('ID da resposta já existia antes da criação');
          variationId=created;
          db.db.prepare("UPDATE listing_api_executions SET variation_id=?,updated_at=? WHERE proposal_id=? AND status='DISPATCHED'")
            .run(variationId,nowIso(),i.proposalId);
          const after=await api.readOwner(item.id,p.handle);
          verified=after.sellerId===sellerId&&after.item.variations.filter(row=>row.id===variationId).length===1&&
            await api.matches(item.id,variationId,option,p.priceCents,p.stock);
        }
      }catch{
        // Uma falha de transporte depois da reserva pode ter ocorrido após a gravação.
      }
      const status=verified?'REMOTE_VERIFIED':'NEEDS_VERIFICATION';
      db.transaction(()=>{
        db.db.prepare("UPDATE listing_api_executions SET status=?,updated_at=? WHERE proposal_id=? AND status='DISPATCHED'")
          .run(status,nowIso(),i.proposalId);
        this.audit(auth,'VARIATION_API_RESULT','offer_variation_proposal',i.proposalId,status,variationId??'sem ID retornado');
      });
      return {status,variationId,action,remoteVerified:verified};
    };
    this.register('variation.api.createUpOffer',async(payload,auth)=>{
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      const i=legacyApiInput.extend({confirmed:z.literal(true)}).strict().parse(payload);
      if(readVariationExecution(i.accountId,i.proposalId))throw Error('proposta já encaminhada; não repetir a criação');
      const p=variationApiTarget(i.accountId,i.proposalId),option=p.option;
      if(!('userProductId' in option))throw Error('proposta de nova condição de venda User Products necessária');
      const api=new MercadoLivreVariations(i.accessToken);
      const {item,sellerId}=await api.readUpOfferOwner(p.externalId,p.handle,option);
      const prior=await api.checkUpOffer(item,sellerId,option,p.stock);
      reserveVariationApi(i,p,auth,'CREATE_UP_OFFER',sellerId,item.id,null);
      let variationId:string|null=null,verified=false;
      try{
        const created=await api.createUpOffer(option,p.priceCents);
        if(prior.includes(created))throw Error('ID de oferta já existente antes da criação');
        variationId=created;
        db.db.prepare("UPDATE listing_api_executions SET variation_id=?,updated_at=? WHERE proposal_id=? AND status='DISPATCHED'").run(created,nowIso(),i.proposalId);
        const after=await api.readUpOfferOwner(p.externalId,p.handle,option);
        verified=after.sellerId===sellerId&&await api.matchesUpOffer(created,item.id,sellerId,option,p.priceCents,p.stock);
      }catch{
        // Resultado desconhecido após a reserva: não reenviar.
      }
      const status=verified?'REMOTE_VERIFIED':'NEEDS_VERIFICATION';
      db.transaction(()=>{
        db.db.prepare("UPDATE listing_api_executions SET status=?,updated_at=? WHERE proposal_id=? AND status='DISPATCHED'").run(status,nowIso(),i.proposalId);
        this.audit(auth,'VARIATION_API_RESULT','offer_variation_proposal',i.proposalId,status,variationId??'sem ID retornado');
      });
      return {status,variationId,action:'CREATE_UP_OFFER',remoteVerified:verified};
    });
    this.register('variation.api.create',executeVariationApi('CREATE_VARIATION'));
    this.register('variation.api.remove',executeVariationApi('REMOVE_VARIATION'));
    this.register('variation.api.editStock',executeVariationApi('EDIT_VARIATION'));
    this.register('variation.api.verify',async(payload,auth)=>{
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      const i=legacyApiInput.strict().parse(payload);
      const p=variationApiTarget(i.accountId,i.proposalId);
      const execution=readVariationExecution(i.accountId,i.proposalId);
      if(!execution?.variation_id)throw Error('a criação não registrou um ID retornado pela API');
      if(execution.status==='REMOTE_VERIFIED')return {status:execution.status,variationId:execution.variation_id,remoteVerified:true};
      if(execution.status==='DISPATCHED'&&Date.parse(execution.updated_at)>Date.now()-30_000)throw Error('aguarde a leitura da operação em andamento');
      const api=new MercadoLivreVariations(i.accessToken);
      const verified=await (async()=>{
      if(execution.action==='CREATE_UP_OFFER'){
        if(!('userProductId' in p.option))throw Error('proposta User Products divergente');
        const {item,sellerId}=await api.readUpOfferOwner(p.externalId,p.handle,p.option);
        if(sellerId!==execution.seller_id||item.id!==execution.item_id)throw Error('a conta ou o anúncio diverge da execução');
        return api.matchesUpOffer(execution.variation_id!,item.id,sellerId,p.option,p.priceCents,p.stock);
      }
      const {item,sellerId}=await api.readOwner(p.externalId,p.handle);
      if(sellerId!==execution.seller_id||item.id!==execution.item_id)throw Error('a conta ou o anúncio diverge da execução');
      return execution.action==='REMOVE_VARIATION'
        ? 'removeVariationId' in p.option&&p.option.removeVariationId===execution.variation_id&&!item.variations.some(row=>row.id===execution.variation_id)
        : execution.action==='EDIT_VARIATION'
          ? 'editVariationId' in p.option&&p.option.editVariationId===execution.variation_id&&await api.matchesStock(item,execution.variation_id!,p.priceCents,p.stock)
          : 'attributeCombinations' in p.option&&item.variations.filter(row=>row.id===execution.variation_id).length===1&&
          await api.matches(item.id,execution.variation_id!,p.option,p.priceCents,p.stock);
      })();
      if(verified)db.transaction(()=>{
        db.db.prepare("UPDATE listing_api_executions SET status='REMOTE_VERIFIED',updated_at=? WHERE proposal_id=? AND status<>'REMOTE_VERIFIED'")
          .run(nowIso(),i.proposalId);
        this.audit(auth,'VARIATION_API_READBACK','offer_variation_proposal',i.proposalId,'REMOTE_VERIFIED',execution.variation_id!);
      });
      return {status:verified?'REMOTE_VERIFIED':'NEEDS_VERIFICATION',variationId:execution.variation_id,remoteVerified:verified};
    });
    this.register('variation.api.list',payload=>{
      const {accountId}=z.object({accountId:z.string().min(1)}).strict().parse(payload);
      operationAccount(accountId);
      return db.rows('SELECT proposal_id,listing_id,item_id,variation_id,status,started_at,updated_at,action FROM listing_api_executions WHERE account_id=? ORDER BY started_at DESC LIMIT 200',accountId);
    });
    this.register('listing.browser.claim',(payload,auth)=>db.transaction(()=>{
      const i=listingBrowserContext.extend({proposalId:z.string().min(1),confirmed:z.literal(true)}).strict().parse(payload);
      const account=operationAccount(i.accountId);
      if(auth?.role!=='super_admin'||account.marketplace!=='mercado_livre')throw Error('executor inicial restrito ao Mercado Livre e super_admin');
      const source=listingBrowserSource(i.sourcePath,i.action,i.externalListingId);
      const kind=i.action==='DUPLICATE'?'LISTING_CHANGE':'VARIATION';
      const table=kind==='LISTING_CHANGE'?'listing_change_proposals':'offer_variation_proposals';
      const proposal=db.row<Record<string,unknown>>('SELECT * FROM '+table+' WHERE id=? AND account_id=? AND status=?',i.proposalId,i.accountId,'APPROVED');
      if(!proposal)throw Error('proposta aprovada da mesma conta necessária');
      const listing=db.row<{id:string;external_id:string;title:string;status:string}>('SELECT id,external_id,title,status FROM listings WHERE id=? AND account_id=? AND marketplace=?',proposal.listing_id,i.accountId,account.marketplace);
      if(!listing||listing.external_id!==i.externalListingId||listing.status==='CLOSED')throw Error('anúncio não corresponde à proposta');
      if(db.row("SELECT proposal_id FROM listing_api_executions WHERE account_id=? AND (proposal_id=? OR (listing_id=? AND status<>'REMOTE_VERIFIED'))",
        i.accountId,i.proposalId,listing.id))throw Error('proposta usada ou execução oficial pendente');
      let plan:Record<string,unknown>;
      if(i.action==='DUPLICATE'){
        if(proposal.kind!=='DUPLICATE'||i.variationId!==undefined||i.beforePriceCents!==undefined||i.beforeStock!==undefined)throw Error('proposta de duplicação necessária');
        plan={originalTitle:listing.title};
      }else{
        const price=z.number().int().min(1).max(100000000).parse(proposal.proposed_price_cents);
        const stock=z.number().int().min(0).max(1000000).parse(proposal.proposed_stock);
        const name=z.string().trim().min(1).max(120).parse(proposal.variation_name);
        const options=JSON.parse(String(proposal.options_json));
        if(!Array.isArray(options)||options.length!==1)throw Error('executor inicial exige uma única opção explícita');
        if(i.action==='CREATE_VARIATION'){
          const option=z.object({name:z.string().trim().min(1).max(120)}).strict().parse(options[0]);
          if(i.variationId!==undefined||i.beforePriceCents!==undefined||i.beforeStock!==undefined)throw Error('formulário de nova variação necessário');
          plan={name,option:option.name,priceCents:price,stock};
        }else{
          const option=z.object({externalId:z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),beforePriceCents:z.number().int().min(0).max(100000000),beforeStock:z.number().int().min(0).max(1000000)}).strict().parse(options[0]);
          if(i.variationId!==option.externalId||i.variationLabel!==name||i.beforePriceCents!==option.beforePriceCents||i.beforeStock!==option.beforeStock||(price===i.beforePriceCents&&stock===i.beforeStock))throw Error('variação ou valores anteriores não correspondem à aprovação');
          const observed=db.row<VariantCapture>(variantCaptureFields+variantCaptureScope+' ORDER BY captured_at DESC,id DESC LIMIT 1',i.accountId,account.marketplace,i.externalListingId,option.externalId);
          const values=observed&&variantValues(observed);
          if(!observed||observed.captured_at>nowIso()||observed.label!==name||values?.priceCents!==option.beforePriceCents||values?.stock!==option.beforeStock)throw Error('capture primeiro a variação com preço, estoque e rótulo correspondentes');
          plan={name,variationId:option.externalId,priceCents:price,stock,baselineSnapshotId:observed.id};
        }
      }
      if(db.row('SELECT id FROM operation_manual_receipts WHERE proposal_kind=? AND proposal_id=?',kind,i.proposalId)||db.row('SELECT id FROM listing_browser_executions WHERE proposal_kind=? AND proposal_id=?',kind,i.proposalId))throw Error('proposta já utilizada; não repetir');
      const conflict=db.row("SELECT id FROM listing_browser_executions WHERE account_id=? AND listing_id=? AND status IN ('CLAIMED','NEEDS_VERIFICATION')",i.accountId,listing.id)||db.row("SELECT id FROM task_items WHERE account_id=? AND listing_id=? AND status IN ('PROCESSING','PUBLISHING','APPROVED_TO_PUBLISH','UNCERTAIN')",i.accountId,listing.id);
      const limits=readAssistedLimits(i.accountId);
      const action=i.action==='DUPLICATE'?'duplicate_listing':i.action==='CREATE_VARIATION'?'create_variation':'edit_variation';
      const guard=evaluateGuard({action,actorRole:auth.role,marketplace:{id:account.marketplace,enabled:Boolean(db.row('SELECT id FROM marketplaces WHERE id=? AND enabled=1',account.marketplace))},account:{id:account.id,marketplace:account.marketplace,verified:true,sessionState:'AUTHENTICATED'},listing:{id:listing.id,accountId:account.id,externalId:listing.external_id,status:listing.status},currentState:{sourcePath:source,externalListingId:listing.external_id,...(i.action==='EDIT_VARIATION'?{beforePriceCents:i.beforePriceCents,beforeStock:i.beforeStock}:{})},financialLimits:limits?{...limits,targetVariationPriceCents:Number(plan.priceCents),targetVariationStock:Number(plan.stock),currentPriceCents:i.beforePriceCents}:null,requiredData:{missing:[]},platformRules:{violations:[]},authorization:{approved:true,approvedBy:auth.userId},conflicts:conflict?['execução ou tarefa anterior pendente']:[]});
      if(!guard.allowed)throw Error(guard.blockedReasons.join('; '));
      const id=randomUUID(),token=randomUUID(),now=nowIso(),expiresAt=new Date(Date.now()+120000).toISOString();
      const context={accountId:i.accountId,externalListingId:i.externalListingId,sourcePath:source,documentNonce:i.documentNonce,action:i.action,variationId:i.variationId,variationLabel:i.variationLabel,beforePriceCents:i.beforePriceCents,beforeStock:i.beforeStock};
      db.db.prepare('INSERT INTO listing_browser_executions(id,proposal_kind,proposal_id,account_id,listing_id,external_listing_id,action,plan_json,context_json,token_hash,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,kind,i.proposalId,i.accountId,listing.id,i.externalListingId,i.action,JSON.stringify(plan),JSON.stringify(context),createHash('sha256').update(token).digest('hex'),'CLAIMED',now,expiresAt,now);
      this.audit(auth,'LISTING_BROWSER_CLAIM',table,i.proposalId,'CLAIMED',i.action);
      return {id,token,context,plan,expiresAt};
    }));
    const parseDuplicateReceipt=(message:string)=>{
      const normalized=message.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
      const match=/^ANUNCIO (MLB-?\d{5,17}) (?:FOI )?DUPLICADO COM SUCESSO[.!]? NOVO ANUNCIO: ?(MLB-?\d{5,17})[.!]?$/.exec(normalized);
      if(!match?.[1]||!match[2])return null;
      const sourceId=match[1].replace('-',''),newId=match[2].replace('-','');
      return sourceId!==newId?{sourceId,newId,message}:null;
    };
    this.register('listing.browser.result',(payload,auth)=>db.transaction(()=>{
      const i=z.object({id:z.string().uuid(),token:z.string().uuid(),outcome:z.enum(['CANCELLED','FAILED','NEEDS_VERIFICATION']),message:z.string().max(1000),duplicateReceipt:z.string().trim().max(500).optional()}).strict().parse(payload);
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      const e=db.row<{proposal_id:string;account_id:string;status:string;token_hash:string;action:string;external_listing_id:string}>('SELECT proposal_id,account_id,status,token_hash,action,external_listing_id FROM listing_browser_executions WHERE id=?',i.id);
      if(!e||e.status!=='CLAIMED'||e.token_hash!==createHash('sha256').update(i.token).digest('hex'))throw Error('execução inválida ou já consumida');
      operationAccount(e.account_id);
      const parsed=i.outcome==='NEEDS_VERIFICATION'&&e.action==='DUPLICATE'&&i.duplicateReceipt?parseDuplicateReceipt(i.duplicateReceipt):null;
      const duplicateReceipt=parsed&&parsed.sourceId===e.external_listing_id.replace('-','').toUpperCase()?parsed:null;
      db.db.prepare('UPDATE listing_browser_executions SET status=?,updated_at=?,result_json=? WHERE id=? AND status=?').run(i.outcome,nowIso(),JSON.stringify({message:i.message,...(duplicateReceipt?{duplicateReceipt}:{})}),i.id,'CLAIMED');
      this.audit(auth,'LISTING_BROWSER_RESULT','listing_browser_execution',i.id,i.outcome,i.message);
      return {status:i.outcome,remoteVerified:false};
    }));
    const listingReadback = (input: {
      accountId:string; marketplace:string; listingId:string; externalListingId:string;
      observedExternalId:string; after:string; baselineAt:string;
      action:'DUPLICATE'|'CREATE_VARIATION'|'EDIT_VARIATION'; plan:Record<string,unknown>; duplicateReceipt?:unknown;
    }) => {
      const {accountId,marketplace,listingId,externalListingId,observedExternalId,after,baselineAt,action,plan}=input;
      const safeCapture=(at:string,evidence:string)=>at>after&&at<=nowIso()&&!parseJsonObject(evidence).coverageWarnings;
      if(action!=='EDIT_VARIATION'){
        const kind=action==='DUPLICATE'?'LISTING_CHANGE':'VARIATION';
        const parent=action==='DUPLICATE'?null:listingId;
        const browser=db.row(`SELECT id FROM listing_browser_executions WHERE account_id=? AND proposal_kind=? AND status IN ('CANDIDATE_OBSERVED','UI_READBACK_MATCHED')
          AND json_extract(result_json,'$.observedExternalId')=? AND (? IS NULL OR listing_id=?)`,
          accountId,kind,observedExternalId,parent,parent);
        const table=kind==='LISTING_CHANGE'?'listing_change_proposals':'offer_variation_proposals';
        const manual=db.row(`SELECT r.id FROM operation_manual_receipts r JOIN ${table} p ON p.id=r.proposal_id AND p.account_id=r.account_id
          WHERE r.account_id=? AND r.proposal_kind=? AND json_extract(r.observation_json,'$.status')='CANDIDATE_OBSERVED'
          AND json_extract(r.observation_json,'$.observedExternalId')=? AND (? IS NULL OR p.listing_id=?)`,
          accountId,kind,observedExternalId,parent,parent);
        if(browser||manual)throw Error('candidato já vinculado a outra operação da loja');
      }
      if(action==='DUPLICATE'){
        const item=db.row<{id:string;title:string;created_at:string}>('SELECT id,title,created_at FROM listings WHERE account_id=? AND external_id=? AND marketplace=?',accountId,observedExternalId,marketplace);
        if(!item||item.id===listingId||item.created_at<=baselineAt||item.title!==plan.originalTitle)throw Error('informe um novo anúncio da mesma loja com título correspondente');
        const snap=db.row<{id:string;captured_at:string;evidence_json:string}>("SELECT id,captured_at,evidence_json FROM listing_snapshots WHERE listing_id=? AND account_id=? AND source_class='A_PRIMARY_UI' ORDER BY captured_at DESC,id DESC LIMIT 1",item.id,accountId);
        const existed=db.row('SELECT id FROM listing_snapshots WHERE listing_id=? AND account_id=? AND captured_at<=?',item.id,accountId,baselineAt);
        if(existed||!snap||!safeCapture(snap.captured_at,snap.evidence_json))throw Error('capture o novo anúncio após a operação com a conta verificada');
        const proof=typeof input.duplicateReceipt==='object'&&input.duplicateReceipt!==null&&'message' in input.duplicateReceipt&&typeof input.duplicateReceipt.message==='string'
          ?parseDuplicateReceipt(input.duplicateReceipt.message):null;
        if(proof&&proof.sourceId===externalListingId.replace('-','').toUpperCase()){
          if(proof.newId!==observedExternalId.replace('-','').toUpperCase())throw Error('ID observado diverge da confirmação explícita da duplicação');
          return {status:'UI_READBACK_MATCHED',observedSnapshotId:snap.id,observedExternalId,remoteVerified:false,duplicateOriginObserved:true};
        }
        return {status:'CANDIDATE_OBSERVED',observedSnapshotId:snap.id,observedExternalId,remoteVerified:false};
      }
      const keys=[accountId,marketplace,externalListingId,observedExternalId];
      const snap=db.row<VariantCapture>(variantCaptureFields+variantCaptureScope+' ORDER BY captured_at DESC,id DESC LIMIT 1',...keys);
      if(!snap||!safeCapture(snap.captured_at,snap.context_json))throw Error('capture a variação com ID e anúncio pai após a operação');
      const matches=(capture:VariantCapture,price:unknown,stock:unknown,label:unknown)=>{
        const values=variantValues(capture);
        return Boolean(values&&capture.label===label&&values.priceCents===price&&values.stock===stock);
      };
      if(action==='EDIT_VARIATION'){
        if(observedExternalId!==plan.variationId||!matches(snap,plan.priceCents,plan.stock,plan.name))throw Error('a variação, preço ou estoque observado difere da proposta');
        const baseline=typeof plan.baselineSnapshotId==='string'
          ? db.row<VariantCapture>(variantCaptureFields+variantCaptureScope+' AND id=? AND captured_at<=?',...keys,plan.baselineSnapshotId,baselineAt)
          : db.row<VariantCapture>(variantCaptureFields+variantCaptureScope+' AND captured_at<=? ORDER BY captured_at DESC,id DESC LIMIT 1',...keys,baselineAt);
        if(!baseline||!matches(baseline,plan.beforePriceCents,plan.beforeStock,plan.name))throw Error('a captura anterior não comprova os valores de origem da variação');
        return {status:'UI_READBACK_MATCHED',baselineSnapshotId:baseline.id,observedSnapshotId:snap.id,observedExternalId,remoteVerified:false};
      }
      if(!matches(snap,plan.priceCents,plan.stock,plan.option)||db.row("SELECT id FROM capture_detail_snapshots WHERE account_id=? AND marketplace=? AND kind='LISTING_VARIANT' AND parent_external_id=? AND external_id=? AND captured_at<=?",...keys,baselineAt))throw Error('informe uma opção nova com nome, preço e estoque correspondentes');
      return {status:'CANDIDATE_OBSERVED',observedSnapshotId:snap.id,observedExternalId,remoteVerified:false};
    };
    this.register('listing.browser.verify',(payload,auth)=>db.transaction(()=>{
      const i=z.object({accountId:z.string().min(1),proposalId:z.string().min(1),observedExternalId:z.string().min(1).max(200)}).strict().parse(payload);
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      const account=operationAccount(i.accountId);
      const e=db.row<{id:string;listing_id:string;external_listing_id:string;action:'DUPLICATE'|'CREATE_VARIATION'|'EDIT_VARIATION';plan_json:string;context_json:string;created_at:string;expires_at:string;updated_at:string;status:string;result_json:string}>('SELECT * FROM listing_browser_executions WHERE account_id=? AND proposal_id=?',i.accountId,i.proposalId);
      if(!e||!['CLAIMED','NEEDS_VERIFICATION'].includes(e.status)||(e.status==='CLAIMED'&&e.expires_at>nowIso()))throw Error('execução não está disponível para conferência');
      const plan={...parseJsonObject(e.context_json),...parseJsonObject(e.plan_json)};
      const observation=listingReadback({...i,marketplace:account.marketplace,listingId:e.listing_id,externalListingId:e.external_listing_id,action:e.action,plan,duplicateReceipt:parseJsonObject(e.result_json).duplicateReceipt,baselineAt:e.created_at,after:e.status==='CLAIMED'?e.expires_at:e.updated_at});
      db.db.prepare('UPDATE listing_browser_executions SET status=?,updated_at=?,result_json=? WHERE id=?').run(observation.status,nowIso(),JSON.stringify({...parseJsonObject(e.result_json),...observation}),e.id);
      this.audit(auth,'LISTING_BROWSER_READBACK','listing_browser_execution',e.id,observation.status,'conferência por captura da loja');
      return observation;
    }));
    this.register('listing.browser.list',(payload)=>{
      const i=z.object({accountId:z.string().min(1)}).strict().parse(payload);operationAccount(i.accountId);
      return db.rows('SELECT id,proposal_kind,proposal_id,account_id,listing_id,external_listing_id,action,status,created_at,expires_at,updated_at,result_json FROM listing_browser_executions WHERE account_id=? ORDER BY created_at DESC LIMIT 200',i.accountId);
    });

    this.register('operation.receipt.record',(payload,auth)=>{
      const i=z.object({accountId:z.string().min(1),proposalKind:z.enum(['CAMPAIGN','VARIATION','LISTING_CHANGE']),proposalId:z.string().min(1),performedAt:z.string().datetime(),evidenceReference:z.string().trim().min(5).max(1000),confirmedManualExecution:z.literal(true)}).strict().parse(payload);
      operationAccount(i.accountId);
      if(auth?.role!=='super_admin'||!auth.userId)throw Error('somente super_admin pode registrar execução manual');
      const tables={CAMPAIGN:'campaign_change_proposals',VARIATION:'offer_variation_proposals',LISTING_CHANGE:'listing_change_proposals'} as const;
      const p=db.row<{status:string;updated_at:string}>(`SELECT status,updated_at FROM ${tables[i.proposalKind]} WHERE id=? AND account_id=?`,i.proposalId,i.accountId);
      if(!p||p.status!=='APPROVED'||i.performedAt<p.updated_at||i.performedAt>nowIso())throw Error('proposta aprovada da mesma conta e data posterior à revisão são obrigatórias');
      if(i.proposalKind==='CAMPAIGN'&&db.row('SELECT id FROM campaign_budget_executions WHERE proposal_id=?',i.proposalId))throw Error('existe tentativa de execução assistida; use a verificação de orçamento');
      if(i.proposalKind!=='CAMPAIGN'&&db.row('SELECT id FROM listing_browser_executions WHERE proposal_kind=? AND proposal_id=?',i.proposalKind,i.proposalId))throw Error('existe tentativa assistida; use a conferência por captura');
      if(i.proposalKind==='VARIATION'&&readVariationExecution(i.accountId,i.proposalId))throw Error('existe uma execução pela API oficial');
      const id=randomUUID();
      db.db.prepare('INSERT INTO operation_manual_receipts(id,account_id,proposal_kind,proposal_id,performed_at,evidence_reference,reported_by,reported_at) VALUES(?,?,?,?,?,?,?,?)').run(id,i.accountId,i.proposalKind,i.proposalId,i.performedAt,i.evidenceReference,auth.userId,nowIso());
      this.audit(auth,'OPERATION_MANUAL_RECEIPT','operation_manual_receipt',id,'OK','relato humano; não comprova alteração no marketplace');
      return {id,status:'HUMAN_REPORTED',remoteVerified:false};
    });
    this.register('operation.receipt.verify',(payload,auth)=>db.transaction(()=>{
      const i=z.object({accountId:z.string().min(1),proposalKind:z.enum(['VARIATION','LISTING_CHANGE']),proposalId:z.string().min(1),observedExternalId:z.string().trim().min(1).max(200)}).strict().parse(payload);
      if(auth?.role!=='super_admin')throw Error('super_admin necessário');
      const account=operationAccount(i.accountId);
      const receipt=db.row<{id:string;performed_at:string;observation_json:string|null}>('SELECT id,performed_at,observation_json FROM operation_manual_receipts WHERE account_id=? AND proposal_kind=? AND proposal_id=?',i.accountId,i.proposalKind,i.proposalId);
      if(!receipt||receipt.observation_json)throw Error('relato da mesma loja sem conferência anterior necessário');
      const table=i.proposalKind==='VARIATION'?'offer_variation_proposals':'listing_change_proposals';
      const p=db.row<Record<string,unknown>>('SELECT * FROM '+table+" WHERE id=? AND account_id=? AND status='APPROVED'",i.proposalId,i.accountId);
      if(!p)throw Error('proposta aprovada da mesma loja necessária');
      const listing=db.row<{id:string;external_id:string;title:string}>('SELECT id,external_id,title FROM listings WHERE id=? AND account_id=? AND marketplace=?',p.listing_id,i.accountId,account.marketplace);
      if(!listing)throw Error('anúncio não pertence à loja');
      let action:'DUPLICATE'|'CREATE_VARIATION'|'EDIT_VARIATION';
      let plan:Record<string,unknown>;
      if(i.proposalKind==='LISTING_CHANGE'){
        if(p.kind!=='DUPLICATE')throw Error('a captura de anúncios não permite conferir a troca de capa');
        action='DUPLICATE';
        plan={originalTitle:listing.title};
      }else{
        const [option]=z.tuple([z.union([
          z.object({externalId:z.string().min(1),beforePriceCents:z.number().int().nonnegative(),beforeStock:z.number().int().nonnegative()}).strict(),
          z.object({name:z.string().trim().min(1)}).strict(),
        ])]).parse(JSON.parse(String(p.options_json)));
        const priceCents=z.number().int().positive().parse(p.proposed_price_cents);
        const stock=z.number().int().nonnegative().parse(p.proposed_stock);
        plan={name:String(p.variation_name).trim(),priceCents,stock};
        if('externalId' in option){
          action='EDIT_VARIATION';
          if(priceCents===option.beforePriceCents&&stock===option.beforeStock)throw Error('a proposta não tem mudança de preço ou estoque');
          plan={...plan,variationId:option.externalId,beforePriceCents:option.beforePriceCents,beforeStock:option.beforeStock};
        }else{
          action='CREATE_VARIATION';
          plan.option=option.name;
        }
      }
      const observation=listingReadback({...i,marketplace:account.marketplace,listingId:listing.id,externalListingId:listing.external_id,action,plan,baselineAt:receipt.performed_at,after:receipt.performed_at});
      db.db.prepare('UPDATE operation_manual_receipts SET observation_json=? WHERE id=?').run(JSON.stringify({...observation,checkedAt:nowIso(),checkedBy:auth.userId}),receipt.id);
      this.audit(auth,'OPERATION_RECEIPT_READBACK','operation_manual_receipt',receipt.id,observation.status,'conferência por captura da loja');
      return observation;
    }));
    this.register('operation.receipt.list',(payload)=>{
      const i=z.object({accountId:z.string().min(1)}).strict().parse(payload);operationAccount(i.accountId);
      return db.rows<Record<string,unknown>>('SELECT * FROM operation_manual_receipts WHERE account_id=? ORDER BY performed_at DESC,id LIMIT 200',i.accountId).map(({observation_json,...row})=>({...row,status:'HUMAN_REPORTED',observation:observation_json?parseJsonObject(String(observation_json)):null,remoteVerified:false}));
    });

    this.register('operation.measure',(payload)=>{
      const i=z.object({accountId:z.string().min(1),proposalKind:z.enum(['CAMPAIGN','VARIATION','LISTING_CHANGE']),proposalId:z.string().min(1)}).strict().parse(payload);
      const account=operationAccount(i.accountId);
      const apiRun=i.proposalKind==='VARIATION'?readVariationExecution(i.accountId,i.proposalId):undefined;
      let apiState:Record<string,unknown>|undefined;
      if(apiRun){
        if(apiRun.status!=='REMOTE_VERIFIED'||!apiRun.variation_id)return {status:'EXECUTION_EVIDENCE_REQUIRED',metrics:null,remoteVerified:false};
        const externalId=apiRun.variation_id,confirmedAt=apiRun.updated_at;
        if(apiRun.action==='CREATE_UP_OFFER'){
          apiState={status:'API_UP_OFFER_CONFIRMED',createdOffer:{externalId,confirmedAt,priceCents:apiRun.price_cents,stock:apiRun.stock}};
        }else if(apiRun.action==='REMOVE_VARIATION'){
          apiState={status:'API_VARIATION_REMOVAL_CONFIRMED',removedVariation:{externalId,confirmedAt}};
        }else if(apiRun.action==='EDIT_VARIATION'){
          const p=variationApiTarget(i.accountId,i.proposalId);
          if(!('editVariationId' in p.option)||p.option.editVariationId!==externalId)throw Error('proposta de estoque divergente');
          apiState={status:'API_VARIATION_STOCK_CONFIRMED',editedVariation:{externalId,confirmedAt,priceCents:apiRun.price_cents,beforeStock:p.option.beforeStock,stock:apiRun.stock}};
        }else{
          apiState={status:'API_VARIATION_CONFIRMED',createdVariation:{externalId,confirmedAt,priceCents:apiRun.price_cents,stock:apiRun.stock}};
        }
      }
      const receipt=apiRun?undefined:db.row<{performed_at:string;observation_json:string|null}>('SELECT performed_at,observation_json FROM operation_manual_receipts WHERE account_id=? AND proposal_kind=? AND proposal_id=?',i.accountId,i.proposalKind,i.proposalId);
      type ExecutionInterval={created_at:string;updated_at:string;result_json:string};
      const assisted = receipt||apiRun ? undefined : i.proposalKind==='CAMPAIGN'
        ? db.row<ExecutionInterval>("SELECT created_at,updated_at,result_json FROM campaign_budget_executions WHERE account_id=? AND proposal_id=? AND status='UI_READBACK_MATCHED'",i.accountId,i.proposalId)
        : db.row<ExecutionInterval>("SELECT created_at,updated_at,result_json FROM listing_browser_executions WHERE account_id=? AND proposal_kind=? AND proposal_id=? AND status IN ('UI_READBACK_MATCHED','CANDIDATE_OBSERVED')",i.accountId,i.proposalKind,i.proposalId);
      if(!receipt&&!assisted&&!apiRun)return {status:'EXECUTION_EVIDENCE_REQUIRED',metrics:null,remoteVerified:false};
      const start=apiRun?.started_at??receipt?.performed_at??assisted!.created_at;
      const end=apiRun?.updated_at??receipt?.performed_at??assisted!.updated_at;
      let duplicateState:Record<string,unknown>|undefined;
      let originalListingId:string|undefined,copyListingId:string|undefined;
      const finish=(result:Record<string,unknown>)=>apiState
        ? {...result,measurementStatus:result.status,...apiState,remoteVerified:true,causalityVerified:false,measurementScope:apiRun?.action==='CREATE_UP_OFFER'?'USER_PRODUCT_ORIGINAL_VS_OFFER':'LISTING',executionEvidence:'REMOTE_VERIFIED'}
        : duplicateState?{...result,measurementStatus:result.status,...duplicateState,remoteVerified:false,causalityVerified:false,measurementScope:'DUPLICATE_ORIGINAL_VS_COPY',executionEvidence:'UI_READBACK_MATCHED'}:result;
      type Observation={id:string;captured_at:string;source_class:string;metrics_json:string;evidence_json:string;listing_id?:string};
      let observations:Observation[]=[];
      let variationObservation: {externalId:string;before:{id:string;capturedAt:string;priceCents:number;stock:number};after:{id:string;capturedAt:string;priceCents:number;stock:number}}|undefined;
      if(i.proposalKind==='CAMPAIGN'){
        const p=db.row<{campaign_ref:string}>('SELECT campaign_ref FROM campaign_change_proposals WHERE id=? AND account_id=? AND status=?',i.proposalId,i.accountId,assisted?'EXECUTED':'APPROVED');
        if(!p)throw Error('proposta de campanha não disponível');
        const rows=db.rows<Observation&{parent_external_id:string}>(`SELECT id,captured_at,source_class,metrics_json,context_json AS evidence_json,parent_external_id FROM capture_detail_snapshots WHERE account_id=? AND marketplace=? AND kind='AD_CAMPAIGN' AND external_id=? ORDER BY captured_at DESC,id DESC LIMIT 501`,i.accountId,account.marketplace,p.campaign_ref);
        if(new Set(rows.map(r=>r.parent_external_id)).size>1)return {status:'AMBIGUOUS_ENTITY',metrics:null,remoteVerified:false};
        observations=rows;
      }else{
        const table=i.proposalKind==='VARIATION'?'offer_variation_proposals':'listing_change_proposals';
        const p=db.row<{listing_id:string;kind?:string}>(`SELECT listing_id${i.proposalKind==='LISTING_CHANGE'?',kind':''} FROM ${table} WHERE id=? AND account_id=? AND status='APPROVED'`,i.proposalId,i.accountId);
        if(!p)throw Error('proposta de anúncio não disponível');
        if(apiRun?.action==='CREATE_UP_OFFER'){
          const copy=db.row<{id:string}>('SELECT id FROM listings WHERE account_id=? AND marketplace=? AND external_id=? AND id<>?',i.accountId,account.marketplace,apiRun.variation_id,p.listing_id);
          if(!copy)return finish({status:'INSUFFICIENT_COMPATIBLE_WINDOWS',metrics:null});
          originalListingId=p.listing_id;copyListingId=copy.id;
        }
        const result=parseJsonObject(receipt?.observation_json??assisted?.result_json??'{}');
        if(result.status==='CANDIDATE_OBSERVED'){
          const {observedSnapshotId,observedExternalId}=result;
          if(typeof observedSnapshotId!=='string'||typeof observedExternalId!=='string')throw Error('evidência de candidato incompleta');
          const listing=db.row<{external_id:string}>('SELECT external_id FROM listings WHERE id=? AND account_id=? AND marketplace=?',p.listing_id,i.accountId,account.marketplace);
          const snapshot=p.kind==='DUPLICATE'
            ? db.row<Observation>(`SELECT s.id,s.captured_at,s.source_class,s.metrics_json,s.evidence_json FROM listing_snapshots s
                JOIN listings l ON l.id=s.listing_id AND l.account_id=s.account_id
                WHERE s.id=? AND s.account_id=? AND l.marketplace=? AND l.external_id=? AND l.id<>? AND s.source_class='A_PRIMARY_UI'`,
                observedSnapshotId,i.accountId,account.marketplace,observedExternalId,p.listing_id)
            : listing&&db.row<Observation>('SELECT id,captured_at,source_class,metrics_json,context_json AS evidence_json '+variantCaptureScope+' AND id=?',
                i.accountId,account.marketplace,listing.external_id,observedExternalId,observedSnapshotId);
          if(!snapshot||snapshot.captured_at<=start||snapshot.captured_at>nowIso()||parseJsonObject(snapshot.evidence_json).coverageWarnings){
            return {status:'CANDIDATE_EVIDENCE_UNAVAILABLE',metrics:null,remoteVerified:false,causalityVerified:false};
          }
          const data=parseJsonObject(snapshot.metrics_json);
          const price=knownNumber(data,'price');
          return {status:'CANDIDATE_STATE_OBSERVED',metrics:null,remoteVerified:false,causalityVerified:false,
            candidateObservation:{externalId:observedExternalId,snapshotId:snapshot.id,capturedAt:snapshot.captured_at,
              priceCents:price!==null&&Number.isSafeInteger(Math.round(price*100))?Math.round(price*100):null,
              stock:knownNumber(data,'stockAvailable')}};
        }
        if(p.kind==='DUPLICATE'){
          if(result.status!=='UI_READBACK_MATCHED'||result.duplicateOriginObserved!==true||
             typeof result.observedSnapshotId!=='string'||typeof result.observedExternalId!=='string')return {status:'NEW_LISTING_ID_NOT_VERIFIED',metrics:null,remoteVerified:false};
          const original=db.row<{external_id:string}>('SELECT external_id FROM listings WHERE id=? AND account_id=? AND marketplace=?',p.listing_id,i.accountId,account.marketplace);
          const copy=db.row<{id:string;external_id:string}>('SELECT id,external_id FROM listings WHERE account_id=? AND marketplace=? AND external_id=? AND id<>?',i.accountId,account.marketplace,result.observedExternalId,p.listing_id);
          const proof=typeof result.duplicateReceipt==='object'&&result.duplicateReceipt!==null&&'message' in result.duplicateReceipt&&typeof result.duplicateReceipt.message==='string'?parseDuplicateReceipt(result.duplicateReceipt.message):null;
          const snap=copy&&db.row<Observation>("SELECT id,captured_at,source_class,metrics_json,evidence_json FROM listing_snapshots WHERE id=? AND listing_id=? AND account_id=? AND source_class='A_PRIMARY_UI'",result.observedSnapshotId,copy.id,i.accountId);
          if(!original||!copy||!proof||proof.sourceId!==original.external_id.replace('-','').toUpperCase()||proof.newId!==copy.external_id.replace('-','').toUpperCase()||
            !snap||snap.captured_at<=start||snap.captured_at>nowIso()||parseJsonObject(snap.evidence_json).coverageWarnings)return {status:'NEW_LISTING_ID_NOT_VERIFIED',metrics:null,remoteVerified:false};
          originalListingId=p.listing_id;copyListingId=copy.id;
          duplicateState={status:'DUPLICATE_STATE_CONFIRMED',duplicateObservation:{originalExternalId:original.external_id,copyExternalId:copy.external_id,snapshotId:snap.id,capturedAt:snap.captured_at}};
        }
        if(i.proposalKind==='VARIATION'){
          const {baselineSnapshotId,observedSnapshotId,observedExternalId}=result;
          if(result.status==='UI_READBACK_MATCHED'&&typeof baselineSnapshotId==='string'&&typeof observedSnapshotId==='string'&&typeof observedExternalId==='string'){
            const listing=db.row<{external_id:string}>('SELECT external_id FROM listings WHERE id=? AND account_id=? AND marketplace=?',p.listing_id,i.accountId,account.marketplace);
            if(listing){
              const keys=[i.accountId,account.marketplace,listing.external_id,observedExternalId];
              const before=db.row<VariantCapture>(variantCaptureFields+variantCaptureScope+' AND id=?',...keys,baselineSnapshotId);
              const after=db.row<VariantCapture>(variantCaptureFields+variantCaptureScope+' AND id=?',...keys,observedSnapshotId);
              const prior=before&&variantValues(before),next=after&&variantValues(after);
              if(before&&after&&prior&&next&&before.captured_at<=start&&after.captured_at>start&&after.captured_at<=nowIso()){
                variationObservation={externalId:observedExternalId,before:{id:before.id,capturedAt:before.captured_at,...prior},after:{id:after.id,capturedAt:after.captured_at,...next}};
              }
            }
          }
        }

        observations=db.rows<Observation>(`SELECT id,captured_at,source_class,metrics_json,evidence_json,listing_id FROM listing_snapshots WHERE account_id=? AND listing_id IN (?,?) ORDER BY captured_at DESC,id DESC LIMIT 501`,i.accountId,p.listing_id,copyListingId??p.listing_id);
      }
      if(observations.length>500)return finish({status:'LIMIT_REACHED',metrics:null,variationObservation,remoteVerified:false});
      const now=nowIso();
      const eligible=observations.flatMap(snapshot=>{
        if(snapshot.source_class!=='A_PRIMARY_UI'||snapshot.captured_at>now)return [];
        const window=observedWindow(parseJsonObject(snapshot.evidence_json));
        if(!window||window.to+'T23:59:59.999Z'>snapshot.captured_at)return [];
        return [{snapshot,window,key:JSON.stringify([window.days,window.filters])}];
      });
      const baselines=new Map<string,(typeof eligible)[number]>();
      for(const row of eligible){
        if((!originalListingId||row.snapshot.listing_id===originalListingId)&&row.snapshot.captured_at<start&&row.window.to+'T23:59:59.999Z'<start&&!baselines.has(row.key))baselines.set(row.key,row);
      }
      const followup=eligible.find(row=>(!copyListingId||row.snapshot.listing_id===copyListingId)&&row.snapshot.captured_at>end&&row.window.from+'T00:00:00.000Z'>end&&baselines.has(row.key));
      const baseline=followup&&baselines.get(followup.key);
      if(!baseline||!followup)return finish({status:variationObservation?'VARIATION_STATE_OBSERVED':'INSUFFICIENT_COMPATIBLE_WINDOWS',metrics:null,variationObservation,remoteVerified:false,causalityVerified:false});
      const {snapshot:before,window:bw}=baseline,{snapshot:after,window:aw}=followup;
      const a=parseJsonObject(before.metrics_json),b=parseJsonObject(after.metrics_json),metrics:Record<string,{before:number;after:number;delta:number;deltaPct:number|null}>={};
      for(const k of ['gmv','orders','units','visits','adSpend','adAttributedRevenue','adClicks','paidImpressions','adAttributedOrders','stockAvailable']){
        const v=knownNumber(a,k),w=knownNumber(b,k);if(v!==null&&w!==null)metrics[k]={before:v,after:w,delta:w-v,deltaPct:v>0?(w-v)/v*100:null};
      }
      return finish({status:Object.keys(metrics).length?'OBSERVED_CHANGE':'NO_COMMON_METRICS',metrics,variationObservation,executionEvidence:receipt?'HUMAN_REPORTED':'UI_READBACK_MATCHED',measurementScope:i.proposalKind==='CAMPAIGN'?'CAMPAIGN':'LISTING',before:{id:before.id,window:bw,capturedAt:before.captured_at},after:{id:after.id,window:aw,capturedAt:after.captured_at},remoteVerified:false,causalityVerified:false});
    });

    const defaultOperationPolicy = { readCapture: true, prepareDrafts: true, editListings: false, publish: false, changeCampaigns: false, changeOffers: false, requireHumanApproval: true, requirePostSaveVerification: true };
    this.register('operation.mode.get', (payload) => {
      const i=z.object({accountId:z.string().optional()}).parse(payload ?? {}); const scopeKey=i.accountId ?? 'global';
      const row=db.row<{mode:string;policy_json:string;updated_at:string}>('SELECT mode,policy_json,updated_at FROM operation_profiles WHERE scope_key=?',scopeKey);
      return {scopeKey,mode:row?.mode ?? 'MANUAL_GUIDED',policy:{...defaultOperationPolicy,...parseJsonObject(row?.policy_json)},updatedAt:row?.updated_at ?? null,hardLimits:{publish:false,campaignExecution:false,neverBypassGuard:true,assistedOperationsRequireExplicitClaim:true}};
    });
    this.register('operation.mode.set', (payload, auth) => {
      const i=z.object({accountId:z.string().optional(),mode:z.enum(['AUTO_PILOT','AUTO_ASSISTED','MANUAL_GUIDED'])}).parse(payload ?? {});
      if(i.accountId && !db.row('SELECT id FROM accounts WHERE id=? AND is_active=1',i.accountId)) throw new Error('conta ativa não encontrada');
      const scopeKey=i.accountId ?? 'global'; const id=i.accountId ?? 'global'; const now=nowIso();
      // Os nomes de modo alteram a política de análise, mas nunca liberam ações remotas sem adapter+autorização.
      const modePolicy={...defaultOperationPolicy,allowAutonomousAnalysis:i.mode!=='MANUAL_GUIDED',suggestionsRequireReview:i.mode!=='MANUAL_GUIDED'};
      db.db.prepare('INSERT INTO operation_profiles (id,scope_key,account_id,mode,policy_json,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET mode=excluded.mode,policy_json=excluded.policy_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at')
        .run(randomUUID(),scopeKey,i.accountId ?? null,i.mode,JSON.stringify(modePolicy),auth?.userId ?? null,now);
      this.audit(auth,'OPERATION_MODE_SET','operation_profile',id,'OK',i.mode);
      return {ok:true,scopeKey,mode:i.mode,policy:modePolicy,remoteWritesEnabled:false};
    });

    this.register('analysis.schedule.create', (payload, auth) => {
      const i = z.object({
        accountId: z.string().nullable().optional(),
        mode: z.enum(['RAPIDA','PADRAO','FORENSE','360']),
        days: z.number().int().min(1).max(365).default(30),
        cadence: z.enum(['1h','6h','daily','weekly','custom']),
        intervalMinutes: z.number().int().min(15).max(43200).optional(),
      }).parse(payload ?? {});
      if (i.cadence === 'custom' && i.intervalMinutes === undefined) throw new Error('informe o intervalo personalizado em minutos (15–43200)');
      if (i.cadence !== 'custom' && i.intervalMinutes !== undefined) throw new Error('intervalo personalizado só é aceito com cadence=custom');
      if(i.accountId && !db.row('SELECT id FROM accounts WHERE id=? AND is_active=1',i.accountId)) throw new Error('conta ativa não encontrada');
      const id=randomUUID(); const now=nowIso(); const storedCadence = i.cadence === 'custom' ? '1h' : i.cadence;
      const nextAt = firstOccurrence(i.cadence, i.intervalMinutes);
      db.db.prepare('INSERT INTO analysis_schedules (id,account_id,mode,days,cadence,interval_minutes,consecutive_failures,enabled,next_run_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,0,1,?,?,?,?)')
        .run(id,i.accountId ?? null,i.mode,i.days,storedCadence,i.intervalMinutes ?? null,nextAt,auth?.userId ?? null,now,now);
      this.audit(auth,'ANALYSIS_SCHEDULE_CREATE','analysis_schedule',id,'OK',`${i.mode}/${i.cadence}${i.intervalMinutes ? `/${i.intervalMinutes}m` : ''}`);
      return {ok:true,id,nextRunAt:nextAt,cadence:i.cadence,intervalMinutes:i.intervalMinutes ?? null};
    });
    this.register('analysis.schedule.list', (payload) => {
      const i=z.object({accountId:z.string().optional()}).parse(payload ?? {});
      return db.rows(`SELECT *,CASE WHEN interval_minutes IS NULL THEN cadence ELSE 'custom' END AS cadence_label FROM analysis_schedules WHERE (? IS NULL OR account_id=?) ORDER BY next_run_at`,i.accountId ?? null,i.accountId ?? null);
    });
    this.register('analysis.schedule.setEnabled', (payload, auth) => {
      const i=z.object({id:z.string(),enabled:z.boolean()}).parse(payload ?? {});
      const schedule=db.row<{cadence:ScheduleCadence;interval_minutes:number|null}>('SELECT cadence,interval_minutes FROM analysis_schedules WHERE id=?',i.id);
      if(!schedule) throw new Error('agendamento não encontrado');
      const nextAt=i.enabled ? firstOccurrence(schedule.cadence,schedule.interval_minutes) : null;
      const r=db.db.prepare('UPDATE analysis_schedules SET enabled=?,next_run_at=COALESCE(?,next_run_at),consecutive_failures=CASE WHEN ?=1 THEN 0 ELSE consecutive_failures END,updated_at=? WHERE id=?')
        .run(i.enabled?1:0,nextAt,i.enabled?1:0,nowIso(),i.id);
      if(Number(r.changes)!==1) throw new Error('agendamento não encontrado');
      this.audit(auth,'ANALYSIS_SCHEDULE_TOGGLE','analysis_schedule',i.id,'OK',String(i.enabled)); return {ok:true,nextRunAt:nextAt};
    });
    this.register('analysis.schedule.runs', (payload) => {
      const i=z.object({scheduleId:z.string(),limit:z.number().int().min(1).max(200).default(50)}).parse(payload ?? {});
      return db.rows('SELECT * FROM analysis_schedule_runs WHERE schedule_id=? ORDER BY started_at DESC LIMIT ?',i.scheduleId,i.limit);
    });

    this.register('report.schedule.create', (payload, auth) => {
      const i=z.object({accountId:z.string().nullable().optional(),reportType:z.enum(['EXECUTIVO','KPIS','CONCORRENCIA','FINANCEIRO','EXPERIMENTOS','AUDITORIA']),format:z.literal('json').default('json'),cadence:z.enum(['1h','6h','daily','weekly','custom']),intervalMinutes:z.number().int().min(15).max(43200).optional()}).parse(payload ?? {});
      if(i.cadence==='custom' && i.intervalMinutes===undefined) throw new Error('informe o intervalo personalizado em minutos (15–43200)');
      if(i.cadence!=='custom' && i.intervalMinutes!==undefined) throw new Error('intervalo personalizado só é aceito com cadence=custom');
      if(i.accountId && !db.row('SELECT id FROM accounts WHERE id=?',i.accountId)) throw new Error('conta não encontrada');
      const id=randomUUID();const now=nowIso();const storedCadence=i.cadence==='custom'?'1h':i.cadence;const nextAt=firstOccurrence(i.cadence,i.intervalMinutes);
      db.db.prepare('INSERT INTO report_schedules (id,account_id,report_type,format,cadence,interval_minutes,consecutive_failures,enabled,next_run_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,0,1,?,?,?,?)')
        .run(id,i.accountId ?? null,i.reportType,i.format,storedCadence,i.intervalMinutes ?? null,nextAt,auth?.userId ?? null,now,now);
      this.audit(auth,'REPORT_SCHEDULE_CREATE','report_schedule',id,'OK',`${i.reportType}/${i.cadence}${i.intervalMinutes ? `/${i.intervalMinutes}m` : ''}`);
      return {ok:true,id,nextRunAt:nextAt,cadence:i.cadence,intervalMinutes:i.intervalMinutes ?? null};
    });
    this.register('report.schedule.list', (payload) => {
      const i=z.object({accountId:z.string().optional()}).parse(payload ?? {});
      return db.rows(`SELECT *,CASE WHEN interval_minutes IS NULL THEN cadence ELSE 'custom' END AS cadence_label FROM report_schedules WHERE (? IS NULL OR account_id=?) ORDER BY next_run_at`,i.accountId ?? null,i.accountId ?? null);
    });
    this.register('report.schedule.setEnabled', (payload, auth) => {
      const i=z.object({id:z.string(),enabled:z.boolean()}).parse(payload ?? {});
      const schedule=db.row<{cadence:ScheduleCadence;interval_minutes:number|null}>('SELECT cadence,interval_minutes FROM report_schedules WHERE id=?',i.id);
      if(!schedule) throw new Error('agendamento não encontrado');
      const nextAt=i.enabled ? firstOccurrence(schedule.cadence,schedule.interval_minutes) : null;
      const r=db.db.prepare('UPDATE report_schedules SET enabled=?,next_run_at=COALESCE(?,next_run_at),consecutive_failures=CASE WHEN ?=1 THEN 0 ELSE consecutive_failures END,updated_at=? WHERE id=?')
        .run(i.enabled?1:0,nextAt,i.enabled?1:0,nowIso(),i.id);
      if(Number(r.changes)!==1)throw new Error('agendamento não encontrado');
      this.audit(auth,'REPORT_SCHEDULE_TOGGLE','report_schedule',i.id,'OK',String(i.enabled));return {ok:true,nextRunAt:nextAt};
    });
    this.register('report.schedule.runs', (payload) => {
      const i=z.object({scheduleId:z.string(),limit:z.number().int().min(1).max(200).default(50)}).parse(payload ?? {});
      return db.rows('SELECT id,schedule_id,generated_at,status,error,row_count FROM report_schedule_runs WHERE schedule_id=? ORDER BY generated_at DESC LIMIT ?',i.scheduleId,i.limit);
    });
    this.register('report.schedule.run.get', (payload) => {
      const i=z.object({runId:z.string().min(1)}).parse(payload ?? {});
      const row=db.row<{id:string;report_json:string|null;status:string}>('SELECT id,report_json,status FROM report_schedule_runs WHERE id=?',i.runId);
      if(!row) throw new Error('execução de relatório não encontrada');
      if(!row.report_json) throw new Error('esta execução não possui arquivo de relatório (falha ou payload não armazenado)');
      return {id:row.id,status:row.status,reportJson:row.report_json};
    });

    this.register('connector.configure', (payload, auth) => {
      const i=z.object({connectorId:z.string().min(1).max(160),provider:z.enum(['GOOGLE_TRENDS','GOOGLE_ANALYTICS4','GOOGLE_SEARCH_CONSOLE','SEO_SERVICE','MARKETPLACE_SERVICE','GENERIC']),publicConfig:z.record(z.string(), z.unknown()).default({}),secrets:z.record(z.string(), z.string().min(1).max(5000)).default({})}).parse(payload ?? {});
      const connector=db.row<{id:string;requires_credentials:number}>('SELECT id,requires_credentials FROM connector_registry WHERE id=?',i.connectorId);if(!connector)throw new Error('conector não cadastrado');
      const target = googleReadTarget(i.connectorId, i.publicConfig);
      if (target && (i.provider !== target.provider || Object.keys(i.secrets).length !== 1 || !/^[A-Za-z0-9._~+/=-]+$/.test(i.secrets.accessToken ?? ''))) {
        throw new Error('informe o token OAuth de acesso do provedor selecionado');
      }
      const configJson = JSON.stringify(i.publicConfig);
      if (Buffer.byteLength(configJson, 'utf8') > 8000) throw new Error('configuração pública excede 8 KB');
      for (const key of Object.keys(i.secrets)) {
        if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw new Error('nome de segredo inválido');
      }
      const namespace = `connector:${i.connectorId}:`;
      const now = nowIso();
      db.transaction(() => {
        this.deps.secrets.deletePrefix(namespace);
        for (const [key,value] of Object.entries(i.secrets)) this.deps.secrets.set(namespace + key, value);
        db.db.prepare(`INSERT INTO connector_runtime_config (connector_id,provider,public_config_json,secret_namespace,status,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(connector_id) DO UPDATE SET provider=excluded.provider,public_config_json=excluded.public_config_json,secret_namespace=excluded.secret_namespace,
          status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at,last_test_at=NULL,last_test_status=NULL,last_test_message=NULL`)
          .run(i.connectorId,i.provider,configJson,namespace,'CONFIGURACAO_PENDENTE',auth?.userId ?? null,now);
        db.db.prepare(`INSERT INTO connector_states (connector_id,enabled,updated_at,updated_by) VALUES (?,0,?,?)
          ON CONFLICT(connector_id) DO UPDATE SET enabled=0,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
          .run(i.connectorId,now,auth?.userId ?? null);
        db.db.prepare("UPDATE connector_registry SET status='CONFIGURADO_NAO_TESTADO' WHERE id=?").run(i.connectorId);
        this.audit(auth,'CONNECTOR_CONFIGURE','connector',i.connectorId,'OK','configuração e segredos guardados');
      });
      return {ok:true,connectorId:i.connectorId,status:'CONFIGURADO_NAO_TESTADO',secretCount:Object.keys(i.secrets).length,secretValuesReturned:false};
    });

    this.register('connector.test', async (payload, auth) => {
      const i = z.object({ connectorId: z.string().min(1).max(160) }).parse(payload ?? {});
      const cfg = db.row<{ provider: string; public_config_json: string; secret_namespace: string; updated_at: string }>(
        'SELECT provider,public_config_json,secret_namespace,updated_at FROM connector_runtime_config WHERE connector_id=?',i.connectorId);
      if (!cfg) throw new Error('conector ainda não foi configurado');
      const target = googleReadTarget(i.connectorId, parseJsonObject(cfg.public_config_json));
      const tokenKey = `${cfg.secret_namespace}accessToken`;
      const token = target ? this.deps.secrets.get(tokenKey) : null;
      const result = target && token
        ? { ...await verifyGoogleRead(target, token), tested: true }
        : { ok: false, tested: false, status: target ? 'CREDENCIAL_AUSENTE' : 'DEPENDENCY_NOT_IMPLEMENTED',
            message: target ? 'Configure um token OAuth para esta propriedade.' : 'O provedor ainda está no catálogo de integrações.' };
      const status = result.ok ? 'CONECTADO' : 'CONFIGURADO_NAO_TESTADO';
      db.transaction(() => {
        if (target && this.deps.secrets.get(tokenKey) !== token) throw new Error('a configuração mudou durante o teste');
        const updated = db.db.prepare(`UPDATE connector_runtime_config SET status=?,last_test_at=?,last_test_status=?,last_test_message=?
          WHERE connector_id=? AND updated_at=? AND public_config_json=?`)
          .run(status,nowIso(),result.status,result.message,i.connectorId,cfg.updated_at,cfg.public_config_json);
        if (!updated.changes) throw new Error('a configuração mudou durante o teste');
        db.db.prepare('UPDATE connector_registry SET status=? WHERE id=?').run(status,i.connectorId);
        if (!result.ok) db.db.prepare('UPDATE connector_states SET enabled=0 WHERE connector_id=?').run(i.connectorId);
        this.audit(auth,'CONNECTOR_TEST','connector',i.connectorId,result.ok ? 'OK' : 'BLOCKED',result.message);
      });
      return { ...result, provider: cfg.provider };
    });

    this.register('task.verifySaved', (payload, auth) => {
      const i=z.object({taskId:z.string(),itemId:z.string(),listingId:z.string(),field:z.string().min(1).max(80),expected:z.unknown(),observed:z.unknown().optional(),sourceUrl:z.string().url().optional(),notVerifiable:z.boolean().default(false),note:z.string().max(1000).optional()}).parse(payload ?? {});
      const item=db.row<{id:string;task_id:string;listing_id:string;account_id:string;status:string}>('SELECT id,task_id,listing_id,account_id,status FROM task_items WHERE id=? AND task_id=? AND listing_id=?',i.itemId,i.taskId,i.listingId);
      if(!item)throw new Error('item da tarefa não corresponde ao anúncio informado');
      if(i.sourceUrl){const u=new URL(i.sourceUrl);if(u.protocol!=='https:')throw new Error('verificação exige URL HTTPS');const listing=db.row<{marketplace:string}>('SELECT marketplace FROM listings WHERE id=? AND account_id=?',i.listingId,item.account_id);if(!listing)throw new Error('anúncio não encontrado na conta do item');const domains:Record<string,RegExp>={mercado_livre:/(^|\.)mercadolivre\.com\.br$/i,shopee:/(^|\.)shopee\.com\.br$/i,amazon:/(^|\.)amazon\.com\.br$/i};if(!domains[listing.marketplace]?.test(u.hostname))throw new Error('URL de verificação fora do domínio autorizado do marketplace');}
      const status=i.notVerifiable || !i.sourceUrl || i.observed===undefined ? 'NOT_VERIFIABLE' : canonicalJson(i.expected)===canonicalJson(i.observed)?'VERIFIED':'MISMATCH';const id=randomUUID();
      db.db.prepare('INSERT INTO change_verifications (id,task_id,item_id,listing_id,field,expected_json,observed_json,status,verified_at,source_url,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,i.taskId,i.itemId,i.listingId,i.field,JSON.stringify(i.expected),i.observed===undefined?null:JSON.stringify(i.observed),status,nowIso(),i.sourceUrl ?? null,i.note ?? null);
      this.audit(auth,'TASK_VERIFY_SAVED','task_item',i.itemId,status,i.note);return {ok:true,id,status,verified:status==='VERIFIED',remoteSaveConfirmed:status==='VERIFIED',note:'evidência enviada pelo verificador da página; não implica que o serviço tenha clicado em salvar'};
    });
    this.register('task.rollbackPlan', (payload) => {
      const i=z.object({taskId:z.string(),itemId:z.string().optional()}).parse(payload ?? {});
      const task=db.row<{id:string;mode:string;status:string}>('SELECT id,mode,status FROM tasks WHERE id=?',i.taskId);if(!task)throw new Error('tarefa não encontrada');
      if(i.itemId && !db.row('SELECT id FROM task_items WHERE id=? AND task_id=?',i.itemId,i.taskId))throw new Error('item não pertence à tarefa');
      const items=db.rows<Record<string,unknown>>(`SELECT ti.id,ti.listing_id,ti.status,cs.id change_set_id,cs.field,cs.before_text,cs.after_text,cs.rolled_back_at FROM task_items ti LEFT JOIN change_sets cs ON cs.task_id=ti.task_id AND cs.listing_id=ti.listing_id WHERE ti.task_id=? AND (? IS NULL OR ti.id=?) ORDER BY ti.order_index,cs.applied_at DESC`,i.taskId,i.itemId ?? null,i.itemId ?? null);
      return {taskId:i.taskId,mode:task.mode,items,execution:'PLAN_ONLY',requiresManualApproval:true,warning:'reversão remota só será possível quando o adapter comprovar suporte; nenhum anúncio foi alterado'};
    });

    this.register('voc.topics', (payload) => {
      const i = z.object({ accountId: z.string() }).parse(payload);
      return db.rows<Record<string, unknown>>('SELECT * FROM customer_voice_topics WHERE account_id = ? ORDER BY frequency DESC', i.accountId);
    });

    this.register('growth.initiatives', (payload) => {
      const i = z.object({ accountId: z.string().optional() }).parse(payload ?? {});
      const rows = i.accountId
        ? db.rows<Record<string, unknown>>('SELECT * FROM growth_initiatives WHERE account_id = ? ORDER BY updated_at DESC LIMIT 200', i.accountId)
        : db.rows<Record<string, unknown>>('SELECT * FROM growth_initiatives ORDER BY updated_at DESC LIMIT 200');
      return rows.map((r) => {
        const rice = Number(r.rice_effort) > 0 ? Number(r.rice_reach || 0) * Number(r.rice_impact || 0) * Number(r.rice_confidence || 0) / Number(r.rice_effort) : 0;
        const ice = (Number(r.ice_impact || 0) * Number(r.ice_confidence || 0) * Number(r.ice_ease || 0));
        return { ...r, rice_score: rice, ice_score: ice, priority_score: Math.max(rice, ice) * (1 + Math.max(0, Number(r.urgency || 0))) };
      });
    });
    this.register('growth.initiative.upsert', (payload, auth) => {
      const i = z.object({ id: z.string().optional(), accountId: z.string().nullable().optional(), title: z.string().min(3).max(300), hypothesis: z.string().min(5).max(3000), pillar: z.string().min(1).max(80).default('GROWTH'), reach: z.number().min(0).default(0), impact: z.number().min(0).max(5).default(1), confidence: z.number().min(0).max(1).default(0.5), effort: z.number().positive().default(1), iceImpact: z.number().min(0).max(10).default(5), iceConfidence: z.number().min(0).max(10).default(5), iceEase: z.number().min(0).max(10).default(5), urgency: z.number().min(0).max(10).default(0), risk: z.string().max(1000).optional(), owner: z.string().max(120).optional(), dueAt: z.string().datetime().nullable().optional(), costCents: z.number().int().min(0).default(0) }).parse(payload);
      if (i.accountId && !db.row('SELECT id FROM accounts WHERE id = ?', i.accountId)) throw new Error('conta não encontrada');
      const id = i.id ?? randomUUID();
      const now = nowIso();
      if (i.id) {
        const changed = db.db.prepare('UPDATE growth_initiatives SET account_id=?,title=?,hypothesis=?,pillar=?,rice_reach=?,rice_impact=?,rice_confidence=?,rice_effort=?,ice_impact=?,ice_confidence=?,ice_ease=?,urgency=?,risk=?,owner=?,due_at=?,cost_cents=?,updated_at=? WHERE id=?')
          .run(i.accountId ?? null,i.title,i.hypothesis,i.pillar,i.reach,i.impact,i.confidence,i.effort,i.iceImpact,i.iceConfidence,i.iceEase,i.urgency,i.risk ?? null,i.owner ?? null,i.dueAt ?? null,i.costCents,now,id);
        if (Number(changed.changes) !== 1) throw new Error('iniciativa não encontrada');
      } else {
        db.db.prepare(`INSERT INTO growth_initiatives (id,account_id,title,hypothesis,pillar,rice_reach,rice_impact,rice_confidence,rice_effort,ice_impact,ice_confidence,ice_ease,urgency,risk,owner,due_at,status,cost_cents,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'BACKLOG',?,?,?)`)
          .run(id,i.accountId ?? null,i.title,i.hypothesis,i.pillar,i.reach,i.impact,i.confidence,i.effort,i.iceImpact,i.iceConfidence,i.iceEase,i.urgency,i.risk ?? null,i.owner ?? null,i.dueAt ?? null,i.costCents,now,now);
      }
      this.audit(auth, 'GROWTH_INITIATIVE_UPSERT', 'growth_initiative', id, 'OK');
      return { ok: true, id };
    });
    this.register('growth.initiative.setStatus', (payload, auth) => {
      const i = z.object({ id: z.string(), status: z.enum(['BACKLOG','PLANNED','IN_PROGRESS','BLOCKED','DONE','CANCELLED']), learning: z.string().max(3000).optional() }).parse(payload);
      const result = db.db.prepare('UPDATE growth_initiatives SET status=?,learning=COALESCE(?,learning),updated_at=? WHERE id=?').run(i.status,i.learning ?? null,nowIso(),i.id);
      if (Number(result.changes) !== 1) throw new Error('iniciativa não encontrada');
      this.audit(auth, 'GROWTH_INITIATIVE_STATUS', 'growth_initiative', i.id, 'OK', i.status);
      return { ok: true };
    });
    this.register('growth.metricTree', () => db.rows<Record<string, unknown>>('SELECT * FROM metric_tree_nodes ORDER BY parent_id, label'));

    this.register('experiment.create', (payload, auth) => {
      const i = z
        .object({
          accountId: z.string(),
          title: z.string(),
          design: z.string(),
          variable: z.string(),
          primaryMetric: z.string(),
          guardrailMetrics: z.array(z.string()).min(1),
          baselineRate: z.number().min(0.0001).max(0.9999),
          mde: z.number().positive(),
          plannedDays: z.number().int().min(1),
        })
        .parse(payload);
      const id = randomUUID();
      db.db
        .prepare(
          `INSERT INTO experiments (id, account_id, title, design, variable, primary_metric, guardrail_metrics_json, baseline_rate, mde, planned_days, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANEJADO')`,
        )
        .run(id, i.accountId, i.title, i.design, i.variable, i.primaryMetric, JSON.stringify(i.guardrailMetrics), i.baselineRate, i.mde, i.plannedDays);
      this.audit(auth, 'EXPERIMENT_CREATE', 'experiment', id, 'OK');
      return { ok: true, id };
    });

    this.register('experiment.list', () => db.rows<Record<string, unknown>>('SELECT * FROM experiments ORDER BY started_at DESC LIMIT 200'));
    this.register('experiment.result', (payload) => {
      const i = z.object({ experimentId: z.string() }).parse(payload);
      return db.rows<Record<string, unknown>>('SELECT * FROM experiment_results WHERE experiment_id = ? ORDER BY computed_at DESC', i.experimentId);
    });

    // ------------------------------------------------------------ agentes
    this.register('analysis.run', (payload, auth) => {
      const i = z.object({ mode: z.enum(['RAPIDA','PADRAO','FORENSE','360']), accountId: z.string().optional(), listingId: z.string().optional(), catalogProductId: z.string().optional(), days: z.number().int().min(1).max(365).default(30) }).refine((value) => !(value.listingId && value.catalogProductId), 'selecione anúncio ou produto, não ambos').parse(payload);
      const selected: AgentKey[] = i.mode === 'RAPIDA' ? ['finance','inventory','ads','conversion_cro'] : i.mode === 'PADRAO' ? ['seo_demand','ads','competition','conversion_cro','finance','inventory','content_postpurchase','pricing_offer'] : [...AGENT_KEYS];
      const listingRows = i.listingId
        ? db.rows<{ id: string; account_id: string; marketplace: string }>('SELECT id,account_id,marketplace FROM listings WHERE id=? AND (? IS NULL OR account_id=?)', i.listingId, i.accountId ?? null, i.accountId ?? null)
        : i.catalogProductId
          ? db.rows<{ id: string; account_id: string; marketplace: string }>(
            `SELECT l.id,l.account_id,l.marketplace FROM listings l
             JOIN skus s ON s.id=l.sku_id
             JOIN catalog_products cp ON cp.id=s.catalog_product_id AND cp.account_id=l.account_id
             WHERE cp.id=? AND (? IS NULL OR l.account_id=?) ORDER BY l.account_id,l.id`,
            i.catalogProductId, i.accountId ?? null, i.accountId ?? null,
          )
          : db.rows<{ id: string; account_id: string; marketplace: string }>('SELECT id,account_id,marketplace FROM listings WHERE (? IS NULL OR account_id=?) ORDER BY account_id, id', i.accountId ?? null, i.accountId ?? null);
      if (!listingRows.length) return { ok: true, mode: i.mode, listingCount: 0, totalMatched: 0, analyses: [], message: i.catalogProductId ? 'Nenhum anúncio vinculado ao produto selecionado nesta conta.' : 'Nenhum anúncio cadastrado para o escopo selecionado. Capture uma página autenticada primeiro.' };
      const requestedLimit = i.listingId ? 1 : i.mode === '360' || i.mode === 'FORENSE' ? 300 : 25;
      const targets = listingRows.slice(0, requestedLimit);
      const truncated = listingRows.length > targets.length;
      const analyses = targets.map((listing) => {
        const k = capture.kpisForListing(listing.id, i.days);
        const p = k?.pillars;
        const cvr = p?.conversion_cro.cvr.value ?? null;
        const roas = p?.acquisition_ads.roas.value ?? null;
        const contribution = null;
        const missing = k?.missingInputs ?? ['snapshot inexistente'];
        const end = nowIso();
        const start = new Date(Date.now() - i.days * 86400000).toISOString();
        const ctx: AgentContext = {
          accountId: listing.account_id, marketplace: listing.marketplace, listingId: listing.id,
          window: { start, end, days: i.days },
          metrics: { visits: p?.conversion_cro.visits ?? null, orders: p?.conversion_cro.orders ?? null, cvrPct: cvr, adSpendCents: p?.acquisition_ads.adSpend == null ? null : Math.round(p.acquisition_ads.adSpend * 100), adRevenueCents: p?.acquisition_ads.adAttributedRevenue == null ? null : Math.round(p.acquisition_ads.adAttributedRevenue * 100), adClicks: p?.acquisition_ads.adClicks ?? null, adImpressions: null, roas, stockCoverageDays: p?.operational_health.stockCoverageDays.value ?? null, units: p?.conversion_cro.units ?? null, dailySales: p?.operational_health.dailySalesAvg.value ?? null, contributionCents: contribution, contributionMarginPct: null, returnRatePct: p?.revenue_profit.returnRate.value ?? null, keywordCoveragePct: p?.discovery_seo.keywordCoverage ?? null, attributeCompletenessPct: p?.discovery_seo.attributeCompleteness ?? null, reviewRating: p?.revenue_profit.reviewRating ?? null, pendingQuestions: p?.operational_health.pendingQuestions ?? null },
          dataConfidence: k ? Math.max(0.1, 1 - missing.length / 24) : 0, missingData: missing,
        };
        const recs = runAgents(selected, ctx);
        const summary = synthesize(recs, ctx);
        const runIds = new Map<AgentKey, string>();
        for (const key of selected) {
          const runId = randomUUID();
          runIds.set(key, runId);
          db.db.prepare('INSERT INTO agent_runs (id,agent_key,account_id,started_at,finished_at,status,trigger) VALUES (?,?,?,?,?,?,?)')
            .run(runId, key, listing.account_id, start, nowIso(), 'CONCLUIDO', `analysis:${i.mode}`);
        }
        for (const rec of recs) {
          const runId = runIds.get(rec.agentKey);
          if (!runId) continue;
          db.db.prepare(`INSERT INTO agent_recommendations (id,agent_run_id,account_id,listing_id,diagnosis,evidence_json,window,facts_json,hypotheses_json,confidence,missing_data_json,impact_range_json,risk,guardrail_metric,action_proposed,alternative,requires_approval,required_permission,verification_criteria,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(randomUUID(), runId, listing.account_id, listing.id, rec.diagnosis, JSON.stringify(rec.evidence), rec.window, JSON.stringify(rec.facts), JSON.stringify(rec.hypotheses), rec.confidence, JSON.stringify(rec.missingData), rec.impactRange ? JSON.stringify(rec.impactRange) : null, rec.risk, rec.guardrailMetric, rec.actionProposed, rec.alternative, rec.requiresApproval ? 1 : 0, rec.requiredPermission, rec.verificationCriteria, 'PROPOSTA', nowIso());
        }
        return { listingId: listing.id, accountId: listing.account_id, marketplace: listing.marketplace, missingData: missing, recommendationCount: recs.length, recommendations: recs, director: summary };
      });
      this.audit(auth, 'ANALYSIS_RUN', 'analysis', null, 'OK', `${i.mode}: ${analyses.length} anúncios`);
      return { ok: true, mode: i.mode, scope: i.catalogProductId ? 'catalog_product' : i.listingId ? 'listing' : i.accountId ? 'account' : 'all_accounts', catalogProductId: i.catalogProductId ?? null, agents: selected, listingCount: analyses.length, totalMatched: listingRows.length, truncated, limit: requestedLimit, analyses };
    });

    this.register('agent.run', (payload, auth) => {
      const schema = z.object({
        agents: z.array(z.string()).min(1),
        context: z.record(z.string(), z.unknown()),
      });
      const i = schema.parse(payload);
      const recs = runAgents(i.agents as never, i.context as unknown as AgentContext);
      const synthesis = synthesize(recs, i.context as unknown as AgentContext);
      this.audit(auth, 'AGENT_RUN', 'agent_run', null, 'OK', `${recs.length} recomendações`);
      return synthesis;
    });

    this.register('agent.runs', () => db.rows<Record<string, unknown>>(
      `SELECT r.*, (SELECT COUNT(*) FROM agent_recommendations a WHERE a.agent_run_id=r.id) AS recommendation_count
         FROM agent_runs r ORDER BY r.started_at DESC LIMIT 100`,
    ));
    this.register('agent.recommendations', (payload) => {
      const i = z.object({ accountId: z.string().optional(), listingId: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) }).parse(payload ?? {});
      return db.rows<Record<string, unknown>>(
        `SELECT * FROM agent_recommendations WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR listing_id=?) AND (? IS NULL OR status=?) ORDER BY created_at DESC LIMIT ?`,
        i.accountId ?? null, i.accountId ?? null, i.listingId ?? null, i.listingId ?? null, i.status ?? null, i.status ?? null, i.limit,
      );
    });

    this.register('agent.feedback', (payload, auth) => {
      const input = z.object({
        recommendationId: z.string().min(1),
        decision: z.enum(['ACEITO','REJEITADO','IMPLEMENTADO','FALHOU']),
        reason: z.string().max(2000).optional(),
        outcome: z.object({
          success: z.boolean(),
          measuredAt: z.string().datetime(),
          baseline: z.record(z.string(), z.number().finite()),
          after: z.record(z.string(), z.number().finite()),
          sampleSize: z.number().int().min(1).max(10_000_000),
          source: z.enum(['A_PRIMARY_UI','B_PLATFORM_EXPORT','F_USER_INPUT']),
          notes: z.string().max(2000).optional(),
        }).optional(),
      }).parse(payload ?? {});
      if (input.decision === 'IMPLEMENTADO' && !input.outcome) throw new Error('para registrar uma ação implementada, informe métricas de antes/depois, amostra e origem');
      const outcome = input.outcome;
      if (outcome) {
        const comparable = Object.keys(outcome.baseline).filter((key) => Object.hasOwn(outcome.after,key));
        if (!comparable.length) throw new Error('o resultado precisa ter ao menos uma métrica presente antes e depois');
      }
      const rec = db.row<{id:string;account_id:string|null;listing_id:string|null;action_proposed:string|null;verification_criteria:string|null}>('SELECT id,account_id,listing_id,action_proposed,verification_criteria FROM agent_recommendations WHERE id=?',input.recommendationId);
      if (!rec) throw new Error('recomendação não encontrada');
      const verificationStatus = input.decision === 'IMPLEMENTADO' ? 'OBSERVADO_NAO_CAUSAL' : input.outcome ? 'OBSERVADO_NAO_CAUSAL' : 'NOT_PROVIDED';
      const feedbackId=randomUUID();
      db.transaction(() => {
        db.db.prepare('INSERT INTO human_feedback (id,recommendation_id,user_id,decision,reason,created_at,outcome_json,verification_status) VALUES (?,?,?,?,?,?,?,?)')
          .run(feedbackId,input.recommendationId,auth?.userId ?? null,input.decision,input.reason ?? null,nowIso(),input.outcome ? JSON.stringify(input.outcome) : null,verificationStatus);
        db.db.prepare('UPDATE agent_recommendations SET status=? WHERE id=?').run(input.decision,input.recommendationId);
      });
      let playbook: {id:string;successes:number;attempts:number}|null=null;
      if (input.decision === 'IMPLEMENTADO' && input.outcome?.success && rec.action_proposed) {
        const feedbackRows=db.rows<{decision:string;outcome_json:string|null}> (
          `SELECT f.decision,f.outcome_json FROM human_feedback f JOIN agent_recommendations r ON r.id=f.recommendation_id
            WHERE r.action_proposed=? AND f.decision IN ('IMPLEMENTADO','FALHOU') AND f.outcome_json IS NOT NULL`,rec.action_proposed);
        const outcomes=feedbackRows.map((row)=>{try{return {decision:row.decision,outcome:JSON.parse(row.outcome_json!) as {success?:boolean}};}catch{return null;}}).filter(Boolean) as Array<{decision:string;outcome:{success?:boolean}} >;
        const successes=outcomes.filter((row)=>row.decision==='IMPLEMENTADO'&&row.outcome.success===true).length;
        const attempts=outcomes.length;
        if(successes>=3){
          const marketplace=rec.account_id ? db.row<{marketplace:string}>('SELECT marketplace FROM accounts WHERE id=?',rec.account_id)?.marketplace : null;
          const label=rec.action_proposed.slice(0,120);
          const existing=db.row<{id:string}>('SELECT id FROM validated_playbooks WHERE marketplace=? AND name=? LIMIT 1',marketplace ?? 'multi',`Ação observada: ${label}`);
          const evidence={recommendationIds:feedbackRows.length,verification:'observational; not causal attribution',sampleOutcomes:outcomes.slice(-10)};
          if(existing){
            db.db.prepare('UPDATE validated_playbooks SET success_rate=?,uses=uses+1,evidence_json=? WHERE id=?').run(successes/attempts,JSON.stringify(evidence),existing.id);
            playbook={id:existing.id,successes,attempts};
          }else{
            const id=randomUUID();
            db.db.prepare('INSERT INTO validated_playbooks (id,marketplace,category,name,steps_json,evidence_json,success_rate,uses,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
              .run(id,marketplace ?? 'multi',null,`Ação observada: ${label}`,JSON.stringify([{action:rec.action_proposed,verification:rec.verification_criteria}]),JSON.stringify(evidence),successes/attempts,1,nowIso());
            playbook={id,successes,attempts};
          }
        }
      }
      this.audit(auth,'AGENT_FEEDBACK','agent_recommendation',input.recommendationId,'OK',input.decision,{feedbackId,verificationStatus,playbook});
      return {ok:true,feedbackId,decision:input.decision,verificationStatus,playbook,note:verificationStatus==='OBSERVADO_NAO_CAUSAL'?'resultado observado e registrado; não comprova causalidade':'feedback registrado sem resultado medido'};
    });

    this.register('agent.debate', async (payload, auth) => {
      const i = z.object({ topic: z.string().min(3), context: z.string().max(20_000), accountId: z.string().optional() }).parse(payload);
      const res = await gemini.call({
        agentKey: 'workspace.debate',
        model: 'gemini-2.5-flash',
        systemPrompt:
          'Você é um consultor sênior de marketplace. Responda em português, cite as evidências fornecidas, separe fatos de hipóteses, aponte dados ausentes e nunca invente números.',
        userContent: `TEMA: ${i.topic}\n\nCONTEXTO:\n${i.context}`,
        accountId: i.accountId,
      });
      if (!res.ok) return { ok: false, error: res.message, pauseExternal: res.pauseExternal };
      this.audit(auth, 'AGENT_DEBATE', 'debate', null, 'OK', `${res.tokensIn}/${res.tokensOut} tokens`);
      return { ok: true, text: res.text, tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd };
    });

    this.register('agent.memory', (payload) => {
      const i = z.object({ query: z.string().default(''), scope: z.string().optional() }).parse(payload ?? {});
      return i.query ? knowledge.search(i.query, { scope: i.scope }) : knowledge.list(i.scope);
    });

    this.register('agent.budget', () => ({
      geminiConfigured: gemini.hasKey(),
      keyHint: gemini.keyHint(),
      spentTodayUsd: gemini.spentTodayUsd(),
    }));

    // ------------------------------------------------------------ auto-upgrade
    this.register('autoupgrade.propose', async (payload, auth) => {
      const i = z.object({ module: z.string(), symptoms: z.string(), currentCode: z.string(), testCommand: z.string().default('npx vitest run') }).parse(payload);
      const res = await autoUpgrade.proposeAdapterFix(i);
      this.audit(auth, 'AUTOUPGRADE_PROPOSE', 'auto_upgrade_proposal', res.proposalId ?? null, res.ok ? 'OK' : 'FAILED', res.message);
      return res;
    });

    this.register('autoupgrade.list', () => autoUpgrade.list());

    this.register('autoupgrade.apply', (payload, auth) => {
      const i = z.object({ proposalId: z.string(), approved: z.boolean(), readFile: z.record(z.string(), z.string()).default({}) }).parse(payload);
      const readFile = (rel: string) => i.readFile[rel] ?? null;
      const writes: Array<{ path: string; content: string }> = [];
      const res = autoUpgrade.apply({
        proposalId: i.proposalId,
        approverRole: auth?.role ?? 'visualizador',
        superAdminApproved: i.approved,
        targetRoot: '.',
        readFile,
        writeFile: (rel, content) => writes.push({ path: rel, content }),
      });
      this.audit(auth, 'AUTOUPGRADE_APPLY', 'auto_upgrade_proposal', i.proposalId, res.applied ? 'OK' : 'BLOCKED', res.reasons.join('; '));
      return { ...res, writes };
    });

    this.register('autoupgrade.rollback', (payload, auth) => {
      const i = z.object({ proposalId: z.string(), files: z.record(z.string(), z.string()).default({}) }).parse(payload);
      const writes: Array<{ path: string; content: string }> = [];
      const res = autoUpgrade.rollback(i.proposalId, '.', (rel) => i.files[rel] ?? null, (rel, content) => writes.push({ path: rel, content }));
      this.audit(auth, 'AUTOUPGRADE_ROLLBACK', 'auto_upgrade_proposal', i.proposalId, res.ok ? 'OK' : 'FAILED', res.message);
      return { ...res, writes };
    });

    // ------------------------------------------------------------ conectores, previsão, alertas
    this.register('connector.registry', () => db.rows<Record<string, unknown>>(
      `SELECT c.*, COALESCE(s.enabled, CASE WHEN c.status = 'CONECTADO' THEN 1 ELSE 0 END) AS enabled, cfg.last_test_at,cfg.last_test_message,
              CASE WHEN cfg.connector_id IS NULL THEN 0 ELSE 1 END AS configured
         FROM connector_registry c LEFT JOIN connector_states s ON s.connector_id = c.id
         LEFT JOIN connector_runtime_config cfg ON cfg.connector_id=c.id ORDER BY c.category, c.label`,
    ));
    this.register('connector.setEnabled', (payload, auth) => {
      const i = z.object({ connectorId: z.string().min(1), enabled: z.boolean() }).parse(payload);
      const connector = db.row<{ id: string; requires_credentials: number; status: string }>('SELECT id,requires_credentials,status FROM connector_registry WHERE id=?', i.connectorId);
      if (!connector) throw new Error('conector não encontrado');
      if (i.enabled && connector.requires_credentials === 1 && connector.status !== 'CONECTADO') {
        throw new Error('conector não pode ser habilitado: credenciais e teste de conexão ainda não foram configurados. O catálogo não representa uma integração ativa.');
      }
      db.db.prepare('INSERT INTO connector_states (connector_id,enabled,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(connector_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
        .run(i.connectorId, i.enabled ? 1 : 0, nowIso(), auth?.userId ?? null);
      this.audit(auth, 'CONNECTOR_SET_ENABLED', 'connector', i.connectorId, 'OK', i.enabled ? 'ativado' : 'desativado');
      return { ok: true, connectorId: i.connectorId, enabled: i.enabled, requiresCredentials: Boolean(connector.requires_credentials) };
    });
    this.register('connector.disconnect', (payload, auth) => {
      const i = z.object({ connectorId: z.string().min(1).max(160) }).parse(payload ?? {});
      const connector = db.row<{ id: string; status: string }>(
        'SELECT id,status FROM connector_registry WHERE id=?', i.connectorId,
      );
      if (!connector) throw new Error('conector não encontrado');

      let secretsRemoved = 0;
      let metadataRemoved = 0;
      db.transaction(() => {
        // Segredos seguem um namespace explícito; a desconexão apaga tokens e
        // refresh tokens, mas preserva histórico de custos e auditoria.
        secretsRemoved = this.deps.secrets.deletePrefix(`connector:${i.connectorId}:`);
        metadataRemoved = Number(db.db.prepare(
          'DELETE FROM connector_credentials_metadata WHERE connector_id=?',
        ).run(i.connectorId).changes);
        db.db.prepare(
          `INSERT INTO connector_states (connector_id,enabled,updated_at,updated_by)
           VALUES (?,0,?,?)
           ON CONFLICT(connector_id) DO UPDATE SET enabled=0,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
        ).run(i.connectorId, nowIso(), auth?.userId ?? null);
        db.db.prepare('DELETE FROM connector_oauth_states WHERE connector_id=?').run(i.connectorId);
        db.db.prepare('DELETE FROM connector_runtime_config WHERE connector_id=?').run(i.connectorId);
        db.db.prepare("UPDATE connector_registry SET status='NAO_CONECTADO' WHERE id=?").run(i.connectorId);
      });

      this.audit(
        auth,
        'CONNECTOR_DISCONNECT',
        'connector',
        i.connectorId,
        'OK',
        `desconectado; ${secretsRemoved} segredo(s) e ${metadataRemoved} metadado(s) removido(s)`,
      );
      return {
        ok: true,
        connectorId: i.connectorId,
        status: 'NAO_CONECTADO',
        enabled: false,
        secretsRemoved,
        credentialMetadataRemoved: metadataRemoved,
      };
    });
    this.register('connector.import', (payload, auth) => {
      const i = z.object({
        fileName: z.string().min(1).max(240),
        fileType: z.enum(['csv','xlsx','pdf']).default('csv'),
        csvText: z.string().max(2_500_000).optional(),
        base64: z.string().max(3_600_000).optional(),
        rows: z.array(z.record(z.string(), z.unknown())).max(10_000).optional(),
        accountId: z.string().min(1),
      }).refine((value) => Boolean(value.rows || (value.fileType === 'csv' ? value.csvText : value.base64)), 'informe as linhas ou o conteúdo do arquivo').parse(payload ?? {});
      if (!db.row('SELECT id FROM accounts WHERE id=? AND is_active=1', i.accountId)) throw new Error('conta ativa não encontrada para importar o arquivo');
      const pdfResult = i.fileType === 'pdf' && !i.rows ? parsePdfBase64(i.base64!) : null;
      const rows = i.rows ?? (i.fileType === 'xlsx' ? parseXlsxBase64(i.base64!) : i.fileType === 'pdf' ? pdfResult!.rows : parseCsvText(i.csvText!));
      if (!rows.length) throw new Error('arquivo não contém linhas de dados');
      if (rows.length > 10_000) throw new Error('importação limitada a 10.000 linhas por arquivo');
      const totalBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0);
      if (totalBytes > 20 * 1024 * 1024) throw new Error('linhas importadas excedem o limite de 20 MB');
      const jobId = randomUUID();
      const safeName = i.fileName.replace(/[\/\\]/g, '_').slice(0, 240);
      db.transaction(() => {
        db.db.prepare('INSERT INTO import_jobs (id,account_id,file_name,file_type,status,rows_total,rows_ok,rows_error,created_at,finished_at,report_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(jobId, i.accountId ?? null, safeName, i.fileType, 'PENDENTE_VALIDACAO', rows.length, 0, 0, nowIso(), null, JSON.stringify({ source: 'user_file', status: 'staging_only', sampleCount: Math.min(20, rows.length) }));
        const stmt = db.db.prepare('INSERT INTO import_job_rows (id,job_id,row_number,data_json,created_at) VALUES (?,?,?,?,?)');
        rows.forEach((row, index) => stmt.run(randomUUID(), jobId, index + 2, JSON.stringify(row), nowIso()));
      });
      this.audit(auth, 'IMPORT_STAGED', 'import_job', jobId, 'OK', `${rows.length} linhas ${i.fileType}; pendente de mapeamento`);
      return { ok: true, jobId, fileType: i.fileType, rowCount: rows.length, previewRows: rows.slice(0, 20), status: 'PENDENTE_VALIDACAO', staged: true, extractedTextChars: pdfResult?.text.length ?? null, warnings: pdfResult?.warnings ?? [], note: 'arquivo interpretado e guardado em staging. Os dados ainda não foram promovidos para KPIs; mapeie as colunas e valide a proveniência antes de importar.' };
    });

    this.register('connector.import.list', (payload, auth) => {
      const i = z.object({ accountId: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) }).parse(payload ?? {});
      if (!db.row('SELECT id FROM accounts WHERE id=? AND is_active=1', i.accountId)) throw new Error('conta ativa não encontrada');
      const rows = db.rows<Record<string, unknown>>('SELECT * FROM import_jobs WHERE account_id=? ORDER BY created_at DESC LIMIT ?', i.accountId, i.limit);
      return rows.map((row) => ({ ...row, report_json: row.report_json ? JSON.parse(String(row.report_json)) : null }));
    });

    this.register('connector.import.get', (payload) => {
      const i = z.object({ jobId: z.string().min(1), accountId: z.string().min(1) }).parse(payload ?? {});
      const job = db.row<Record<string, unknown>>('SELECT * FROM import_jobs WHERE id=? AND account_id=?', i.jobId, i.accountId);
      if (!job) throw new Error('importação não encontrada');
      const rows = db.rows<{ row_number: number; data_json: string }>(
        'SELECT row_number,data_json FROM import_job_rows WHERE job_id=? ORDER BY row_number LIMIT 10000', i.jobId,
      ).map((row) => ({ rowNumber: row.row_number, data: JSON.parse(row.data_json) as Record<string, unknown> }));
      return { ...job, report_json: job.report_json ? JSON.parse(String(job.report_json)) : null, rows };
    });

    this.register('connector.import.commit', (payload, auth) => {
      const i = z.object({
        jobId: z.string().min(1),
        accountId: z.string().min(1),
        mapping: z.object({
          externalId: z.string().min(1),
          capturedAt: z.string().optional(),
          metrics: z.record(z.string(), z.string().min(1)).refine((value) => Object.keys(value).length > 0, 'mapeie ao menos um indicador'),
        }),
      }).parse(payload ?? {});
      const allowedMetrics = new Set([
        'units','orders','visits','impressions','clicks','gmv','netRevenue','organicImpressions','paidImpressions',
        'adSpend','adClicks','adAttributedRevenue','adAttributedOrders','addToCart','favorites','questionsAnswered',
        'discounts','cancellations','cancellationValue','newCustomers','returningCustomers','returnsCount','returnsValue',
        'stockAvailable','questionsPending','reviewRating','reviewCount',
      ]);
      for (const metric of Object.keys(i.mapping.metrics)) {
        if (!allowedMetrics.has(metric)) throw new Error(`indicador não permitido para importação: ${metric}`);
      }
      const account = db.row<{ id: string; marketplace: string }>(
        'SELECT id,marketplace FROM accounts WHERE id=? AND is_active=1', i.accountId,
      );
      if (!account) throw new Error('conta ativa não encontrada para importar dados');
      const job = db.row<{ id: string; account_id: string | null; status: string; rows_total: number }>(
        'SELECT id,account_id,status,rows_total FROM import_jobs WHERE id=?', i.jobId,
      );
      if (!job || job.account_id !== i.accountId) throw new Error('a importação não pertence à conta selecionada');
      if (job.status !== 'PENDENTE_VALIDACAO') throw new Error('esta importação não está pendente de validação');
      const imported = db.rows<{ row_number: number; data_json: string }>(
        'SELECT row_number,data_json FROM import_job_rows WHERE job_id=? ORDER BY row_number', i.jobId,
      );
      if (!imported.length || imported.length !== job.rows_total) throw new Error('linhas da importação estão incompletas');
      const keys = new Set(imported.flatMap((row) => Object.keys(JSON.parse(row.data_json) as Record<string, unknown>)));
      const requiredColumns = [i.mapping.externalId, i.mapping.capturedAt, ...Object.values(i.mapping.metrics)].filter(Boolean) as string[];
      for (const column of requiredColumns) if (!keys.has(column)) throw new Error(`coluna mapeada não encontrada no arquivo: ${column}`);
      const defaultCapturedAt = nowIso();
      const batch: Array<{ rowNumber: number; listingId: string; capturedAt: string; metrics: Record<string, number> }> = [];
      const duplicates = new Set<string>();
      const parseNumber = (raw: unknown, label: string): number => {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw !== 'string') throw new Error(`${label}: valor numérico inválido`);
        let normalized = raw.trim().replace(/[R$\s]/g, '').replace(/%$/, '');
        if (!normalized) throw new Error(`${label}: valor numérico vazio`);
        const comma = normalized.lastIndexOf(',');
        const dot = normalized.lastIndexOf('.');
        if (comma >= 0 && dot >= 0) normalized = comma > dot ? normalized.replace(/\./g, '').replace(',', '.') : normalized.replace(/,/g, '');
        else if (comma >= 0) normalized = normalized.replace(',', '.');
        const value = Number(normalized);
        if (!Number.isFinite(value) || value < 0) throw new Error(`${label}: valor numérico inválido ou negativo`);
        return value;
      };
      for (const item of imported) {
        const row = JSON.parse(item.data_json) as Record<string, unknown>;
        const externalId = String(row[i.mapping.externalId] ?? '').trim();
        if (!externalId) throw new Error(`linha ${item.row_number}: ID externo do anúncio vazio`);
        const listing = db.row<{ id: string }>(
          'SELECT id FROM listings WHERE account_id=? AND marketplace=? AND external_id=?', i.accountId, account.marketplace, externalId,
        );
        if (!listing) throw new Error(`linha ${item.row_number}: anúncio ${externalId} não existe na conta; cadastre/capture o anúncio antes`);
        let capturedAt = defaultCapturedAt;
        if (i.mapping.capturedAt) {
          const rawDate = String(row[i.mapping.capturedAt] ?? '').trim();
          const parsedDate = new Date(rawDate);
          if (!rawDate || !Number.isFinite(parsedDate.getTime())) throw new Error(`linha ${item.row_number}: data inválida`);
          capturedAt = parsedDate.toISOString();
        }
        const key = `${listing.id}|${capturedAt}`;
        if (duplicates.has(key)) throw new Error(`linhas duplicadas para anúncio ${externalId} no mesmo instante`);
        duplicates.add(key);
        const metrics: Record<string, number> = {};
        for (const [metric, column] of Object.entries(i.mapping.metrics)) {
          const value = parseNumber(row[column], `linha ${item.row_number}, coluna ${column}`);
          if (metric === 'reviewRating' && value > 5) throw new Error(`linha ${item.row_number}: reviewRating deve estar entre 0 e 5`);
          metrics[metric] = value;
        }
        batch.push({ rowNumber: item.row_number, listingId: listing.id, capturedAt, metrics });
      }
      for (const item of batch) {
        if (db.row('SELECT id FROM listing_snapshots WHERE listing_id=? AND captured_at=?', item.listingId, item.capturedAt)) {
          throw new Error(`linha ${item.rowNumber}: já existe um snapshot deste anúncio neste instante`);
        }
      }
      const collectedAt = nowIso();
      const sourceId = `import_job:${i.jobId}`;
      db.transaction(() => {
        const insertSnapshot = db.db.prepare(
          `INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,quality_score)
           VALUES (?,?,?,?,?,?,?,?)`,
        );
        const insertProvenance = db.db.prepare(
          `INSERT INTO data_provenance (entity,entity_id,field,account_id,listing_id,source_class,source_id,page_url,reference_at,collected_at,method,confidence,run_id)
           VALUES ('listing_snapshot',?,?,?,?,?, ?,NULL,?,?,?, ?,NULL)`,
        );
        for (const item of batch) {
          const snapshotId = randomUUID();
          insertSnapshot.run(snapshotId,item.listingId,i.accountId,item.capturedAt,item.capturedAt,JSON.stringify(item.metrics),'F_USER_INPUT',0.55);
          for (const field of Object.keys(item.metrics)) {
            insertProvenance.run(snapshotId,field,i.accountId,item.listingId,'F_USER_INPUT',sourceId,item.capturedAt,collectedAt,'CSV_XLSX_USER_IMPORT',0.7);
          }
        }
        db.db.prepare('UPDATE import_jobs SET status=?,rows_ok=?,rows_error=0,finished_at=?,report_json=? WHERE id=?')
          .run('IMPORTADO_VALIDADO',batch.length,collectedAt,JSON.stringify({ sourceClass:'F_USER_INPUT', mapping:i.mapping, snapshotCount:batch.length }),i.jobId);
      });
      this.audit(auth,'IMPORT_COMMITTED','import_job',i.jobId,'OK',`${batch.length} snapshots importados com proveniência F_USER_INPUT`);
      return { ok:true, jobId:i.jobId, snapshotsCreated:batch.length, sourceClass:'F_USER_INPUT', status:'IMPORTADO_VALIDADO', note:'dados importados como entrada manual com proveniência; métricas estimadas não foram criadas' };
    });

    this.register('forecast.run', (payload, auth) => {
      const i = z.object({
        accountId: z.string().min(1),
        metric: z.enum(['gmv','orders','visits','units','adSpend','adAttributedRevenue','stockAvailable']).default('gmv'),
        horizonDays: z.number().int().min(7).max(56).default(28),
      }).parse(payload ?? {});
      const account = db.row<{ id: string; marketplace: string; display_name: string }>(
        'SELECT id,marketplace,display_name FROM accounts WHERE id=? AND is_active=1', i.accountId,
      );
      if (!account) throw new Error('conta inexistente ou inativa');
      const since = new Date(Date.now() - 84 * 86400000).toISOString();
      const snapshots = db.rows<{ captured_at: string; metrics_json: string }>(
        'SELECT captured_at,metrics_json FROM listing_snapshots WHERE account_id=? AND captured_at>=? ORDER BY captured_at ASC',
        i.accountId, since,
      );
      const WEEK_MS = 7 * 86400000;
      const byWeek = new Map<number, { at: string; value: number }>();
      for (const row of snapshots) {
        let metrics: Record<string, unknown>;
        try { metrics = JSON.parse(row.metrics_json) as Record<string, unknown>; } catch { continue; }
        const raw = metrics[i.metric];
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue;
        const week = Math.floor(new Date(row.captured_at).getTime() / WEEK_MS);
        const current = byWeek.get(week);
        // Uma amostra por semana: usa o snapshot mais recente, evitando somar
        // repetidamente métricas acumuladas da mesma janela de marketplace.
        if (!current || row.captured_at > current.at) byWeek.set(week, { at: row.captured_at, value: raw });
      }
      const observations = [...byWeek.entries()].sort((a,b) => a[0]-b[0]).map(([week,v]) => ({ week, at: v.at, value: v.value }));
      const spanWeeks = observations.length > 1 ? observations.at(-1)!.week - observations[0]!.week + 1 : observations.length;
      if (observations.length < 8 || spanWeeks < 8) {
        return { ok: false, error: 'histórico insuficiente para previsão; são necessárias pelo menos 8 semanas distintas com dados', requiredWeeks: 8, observedWeeks: observations.length, spanWeeks, accountId: i.accountId, metric: i.metric };
      }
      const xs = observations.map((o) => o.week - observations[0]!.week);
      const ys = observations.map((o) => o.value);
      const meanX = xs.reduce((a,b)=>a+b,0)/xs.length;
      const meanY = ys.reduce((a,b)=>a+b,0)/ys.length;
      const denom = xs.reduce((sum,x)=>sum+(x-meanX)**2,0);
      const slope = denom === 0 ? 0 : xs.reduce((sum,x,k)=>sum+(x-meanX)*(ys[k]!-meanY),0)/denom;
      const intercept = meanY - slope*meanX;
      const fitted = xs.map((x)=>Math.max(0,intercept+slope*x));
      const residuals = ys.map((y,k)=>y-fitted[k]!);
      const rmse = Math.sqrt(residuals.reduce((sum,v)=>sum+v*v,0)/Math.max(1,residuals.length-2));
      const mapeRows = ys.map((y,k)=>y>0 ? Math.abs((y-fitted[k]!)/y)*100 : null).filter((v): v is number => v !== null);
      const mape = mapeRows.length ? mapeRows.reduce((a,b)=>a+b,0)/mapeRows.length : null;
      const horizonWeeks = Math.ceil(i.horizonDays/7);
      const points = Array.from({ length: horizonWeeks }, (_,idx) => {
        const x = xs.at(-1)! + idx + 1;
        const value = Math.max(0, intercept+slope*x);
        const margin = 1.28 * rmse * Math.sqrt(1 + (idx+1)/observations.length);
        return { week: idx+1, value, low: Math.max(0,value-margin), high: value+margin };
      });
      const runId = randomUUID();
      db.db.prepare('INSERT INTO forecast_runs (id,account_id,metric,method,created_at,horizon_days,mape,notes) VALUES (?,?,?,?,?,?,?,?)')
        .run(runId,i.accountId,i.metric,'weekly_linear_trend',nowIso(),i.horizonDays,mape,'projeção de tendência linear sobre último snapshot de cada semana; intervalo heurístico de 80%, não causal');
      db.db.prepare('INSERT INTO forecast_scenarios (id,forecast_run_id,label,points_json,interval_low_json,interval_high_json) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(),runId,'BASE',JSON.stringify(points.map(p=>({week:p.week,value:p.value}))),JSON.stringify(points.map(p=>({week:p.week,value:p.low}))),JSON.stringify(points.map(p=>({week:p.week,value:p.high}))));
      this.audit(auth,'FORECAST_RUN','forecast',runId,'OK',`${i.metric}; ${observations.length} semanas`);
      return { ok: true, runId, account, metric: i.metric, method: 'weekly_linear_trend', horizonDays: i.horizonDays, observations, trendPerWeek: slope, rmse, mape, interval: 'heurístico aproximado de 80%; não representa garantia nem causalidade', points };
    });
    this.register('alerts.list', () => db.rows<Record<string, unknown>>('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200'));
    this.register('alerts.ack', (payload, auth) => {
      const i = z.object({ alertId: z.string(), falsePositive: z.boolean().default(false) }).parse(payload);
      db.db.prepare('UPDATE alerts SET acknowledged_at = ?, false_positive = ? WHERE id = ?').run(new Date().toISOString(), i.falsePositive ? 1 : 0, i.alertId);
      this.audit(auth, 'ALERT_ACK', 'alert', i.alertId, 'OK', i.falsePositive ? 'falso positivo' : undefined);
      return { ok: true };
    });

    /**
     * Exportação real: devolve as linhas do relatório pedido, com o formato
     * escolhido, prontas para virar arquivo. Não inventa seção vazia: cada
     * relatório traz as linhas que existem hoje no banco.
     */
    this.register('report.export', (payload, auth) => {
      const i = z.object({
        type: z.enum(['EXECUTIVO','KPIS','CONCORRENCIA','FINANCEIRO','EXPERIMENTOS','AUDITORIA']),
        format: z.enum(['csv','json','xlsx']).default('csv'),
        accountId: z.string().optional(),
      }).parse(payload ?? {});
      if (i.accountId) {
        const account = db.row<{ id: string }>('SELECT id FROM accounts WHERE id=?', i.accountId);
        if (!account) throw new Error('conta não encontrada para o relatório');
      }
      let rows: Array<Record<string, unknown>>;
      let summary: unknown = null;
      if (i.type === 'EXECUTIVO') {
        const dashboard = buildDashboard({ accountId: i.accountId });
        summary = dashboard.totals;
        rows = dashboard.byAccount.map((a) => ({ accountId: a.id, marketplace: a.marketplace, account: a.display_name, ...a.totals, ...a.coverage }));
      } else if (i.type === 'KPIS') {
        const listingRows = db.rows<{ captured_at: string; metrics_json: string; evidence_json: string }>(
          `SELECT s.id,s.account_id,l.marketplace,l.external_id,l.title,s.captured_at,s.reference_at,s.source_class,s.quality_score,s.metrics_json,s.evidence_json
             FROM listing_snapshots s JOIN listings l ON l.id=s.listing_id
            WHERE (? IS NULL OR s.account_id=?) ORDER BY s.captured_at DESC LIMIT 20000`,
          i.accountId ?? null, i.accountId ?? null,
        ).map((r) => ({ ...r, entityType: 'listing', metrics: JSON.parse(String(r.metrics_json || '{}')), evidence: JSON.parse(String(r.evidence_json || '{}')) }));
        const accountRows = db.rows<{ captured_at: string; metrics_json: string; evidence_json: string }>(
          `SELECT id,account_id,marketplace,page_kind AS title,captured_at,reference_at,source_class,quality_score,metrics_json,evidence_json
             FROM account_snapshots WHERE (? IS NULL OR account_id=?) ORDER BY captured_at DESC LIMIT 20000`,
          i.accountId ?? null, i.accountId ?? null,
        ).map((r) => ({ ...r, entityType: 'account', external_id: null, metrics: JSON.parse(String(r.metrics_json || '{}')), evidence: JSON.parse(String(r.evidence_json || '{}')) }));
        rows = [...listingRows,...accountRows].sort((a,b)=>String(b.captured_at).localeCompare(String(a.captured_at))).slice(0,20000);
      } else if (i.type === 'CONCORRENCIA') {
        rows = db.rows<Record<string, unknown>>(
          `SELECT r.*,o.account_id,o.title AS own_product_title,c.marketplace,c.external_id,c.title AS competitor_title,c.price_cents
             FROM competitor_relations r JOIN own_products o ON o.id=r.own_product_id
             JOIN competitor_candidates c ON c.id=r.candidate_id
            WHERE (? IS NULL OR o.account_id=?) ORDER BY r.suggested_at DESC LIMIT 10000`,
          i.accountId ?? null, i.accountId ?? null,
        );
      } else if (i.type === 'FINANCEIRO') {
        rows = db.rows<Record<string, unknown>>(
          `SELECT c.*,s.account_id,s.sku_code,s.ean,s.gtin,s.upc FROM sku_costs c JOIN skus s ON s.id=c.sku_id
            WHERE (? IS NULL OR s.account_id=?) ORDER BY c.valid_from DESC LIMIT 10000`,
          i.accountId ?? null, i.accountId ?? null,
        );
      } else if (i.type === 'EXPERIMENTOS') {
        rows = db.rows<Record<string, unknown>>(
          'SELECT * FROM experiments WHERE (? IS NULL OR account_id=?) ORDER BY started_at DESC LIMIT 5000',
          i.accountId ?? null, i.accountId ?? null,
        );
      } else {
        // A auditoria é global por desenho: seus registros não possuem account_id consistente.
        rows = db.rows<Record<string, unknown>>('SELECT * FROM audit_log ORDER BY at DESC LIMIT 10000');
      }
      this.audit(auth, 'REPORT_EXPORT', 'report', i.type, 'OK', `${rows.length} linhas em ${i.format}`);
      return { ok: true, type: i.type, format: i.format, generatedAt: nowIso(), rowCount: rows.length, summary, rows, scope: i.type === 'AUDITORIA' ? 'global' : (i.accountId ?? 'all_accounts') };
    });

    this.register('backup.create', (payload, auth) => {
      const note = z.object({ note: z.string().default('manual') }).parse(payload ?? {}).note;
      const backup = db.backup(note);
      this.audit(auth, 'BACKUP_CREATE', 'backup', backup.path, 'OK', note);
      return { ok: true, ...backup };
    });

    this.register('backup.list', () => db.rows<Record<string, unknown>>('SELECT * FROM backups ORDER BY created_at DESC LIMIT 100'));
    this.register('backup.restore', (payload, auth) => {
      const input = z.object({ backupId: z.string().min(1).max(128), confirmed: z.literal(true) }).parse(payload ?? {});
      const restored = db.restoreBackup(input.backupId);
      this.audit(auth, 'BACKUP_RESTORE', 'backup', input.backupId, 'OK', `integridade=${restored.integrity.ok}; migrations=${restored.migrated.join(',') || 'nenhuma'}`);
      return { ok: true, ...restored };
    });
  }

  /** Resolve token → sessão válida. */
  private resolveSession(token: string): AuthContext | null {
    const row = this.deps.db.row<{ user_id: string; role: AccessRole; expires_at: string; revoked_at: string | null }>(
      `SELECT s.user_id, u.role, s.expires_at, s.revoked_at
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND u.is_active=1`,
      sha256(token),
    );
    if (!row) return null;
    if (row.revoked_at) return null;
    const expiry = Date.parse(row.expires_at);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
    return { userId: row.user_id, role: row.role };
  }

  /** Ponto único de entrada: valida protocolo, sessão, permissão e executa. */
  async handle(raw: unknown): Promise<IpcResponse> {
    const parsed = ipcRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        id: typeof (raw as IpcRequest)?.id === 'string' ? (raw as IpcRequest).id : 'unknown',
        ok: false,
        protocolVersion: 1,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      };
    }
    const req = parsed.data;
    if (!protocolCompatible(req.protocolVersion)) {
      return {
        id: req.id,
        ok: false,
        protocolVersion: PROTOCOL_VERSION,
        error: {
          code: 'PROTOCOL_MISMATCH',
          message: `protocolo ${req.protocolVersion} não suportado; esperado ${PROTOCOL_VERSION}`,
        },
      };
    }
    const handler = this.handlers.get(req.method);
    if (!handler) {
      return { id: req.id, ok: false, protocolVersion: 1, error: { code: 'NOT_FOUND', message: `método ${req.method} inexistente` } };
    }

    const auth = req.token ? this.resolveSession(req.token) : null;
    if (!PUBLIC_METHODS.has(req.method)) {
      if (!auth) {
        return { id: req.id, ok: false, protocolVersion: 1, error: { code: 'UNAUTHORIZED', message: 'sessão necessária' } };
      }
      if (!SESSION_ONLY_METHODS.has(req.method)) {
        const perm = METHOD_PERMISSION[req.method];
        if (!perm) {
          this.audit(auth, 'PERMISSION_DENIED', 'ipc', req.method, 'DENIED', 'método sem política de autorização');
          return { id: req.id, ok: false, protocolVersion: 1, error: { code: 'FORBIDDEN', message: `método ${req.method} sem política de autorização` } };
        }
        if (!roleHasPermission(auth.role, perm)) {
          this.audit(auth, 'PERMISSION_DENIED', 'ipc', req.method, 'DENIED', `perfil ${auth.role} sem ${perm}`);
          return { id: req.id, ok: false, protocolVersion: 1, error: { code: 'FORBIDDEN', message: `perfil ${auth.role} não possui ${perm}` } };
        }
      }
    }

    try {
      const result = await handler(req.payload, auth);
      return { id: req.id, ok: true, protocolVersion: 1, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isValidation = err instanceof z.ZodError;
      return {
        id: req.id,
        ok: false,
        protocolVersion: 1,
        error: { code: isValidation ? 'VALIDATION_ERROR' : 'INTERNAL', message },
      };
    }
  }

  /** Verificação de qualidade usada pela UI antes de mostrar diagnóstico de IA. */
  checkAiGate(metrics: Record<string, Parameters<typeof evaluateQualityGate>[0][string]>, required: string[]) {
    return evaluateQualityGate(metrics, required);
  }
}

/** Redação de dados pessoais em textos de voz do cliente (§25). */
export function redactPII(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]')
    .replace(/\b\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, '[telefone]')
    .replace(/\b\d{5}-?\d{3}\b/g, '[cep]')
    .replace(/\b(?:\d[ -]?){13,16}\b/g, '[cartão]');
}

export type { ListingPeriodInput };
