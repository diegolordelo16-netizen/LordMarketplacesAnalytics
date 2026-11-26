/**
 * Serviço local: registro de métodos IPC, autenticação/perfis, auditoria e ciclo de vida.
 * Exposto por Named Pipe no Windows (host nativo) e por HTTP local no painel do desktop.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  evaluateQualityGate,
  ipcRequestSchema,
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
import { SecretStore, hashPassword, sha256, verifyPassword } from './security/secrets';
import type { GeminiClient } from './ai/gemini-client';
import type { KnowledgeBase } from './ai/knowledge-base';
import type { AutoUpgradeEngine } from './ai/auto-upgrade';
import type { CaptureService } from './capture/capture-service';
import { CompetitorService } from './competitive/competitor-service';
import { IMPLEMENTED_ADAPTERS, PLANNED_ADAPTERS } from './adapters';
import { evaluateGuard, type GuardContext } from './guard/automation-guard';
import { runAgents, synthesize, type AgentContext } from './ai/agents';

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
  'capture.ingest': 'execute_task',
  'capture.snapshot': 'view_reports',
  'kpi.listing': 'view_reports',
  'kpi.dashboard': 'view_reports',
  'missions.today': 'view_reports',
  'finance.simulate': 'view_reports',
  'finance.costs.upsert': 'manage_financial_limits',
  'task.create': 'execute_task',
  'task.list': 'view_reports',
  'task.pause': 'execute_task',
  'task.resume': 'execute_task',
  'task.cancel': 'execute_task',
  'task.skipItem': 'execute_task',
  'task.runNow': 'execute_task',
  'guard.evaluate': 'execute_task',
  'audit.list': 'manage_backups',
  'audit.rollback': 'manage_backups',
  'adapter.diagnostics': 'view_reports',
  'keyword.upsert': 'manage_market_intelligence',
  'keyword.list': 'view_reports',
  'keyword.gap': 'view_reports',
  'rank.record': 'manage_market_intelligence',
  'rank.history': 'view_reports',
  'competitor.upsert': 'manage_competitors',
  'competitor.list': 'view_reports',
  'competitor.timeline': 'view_reports',
  'competitor.alerts': 'view_reports',
  'competitor.ownProduct.upsert': 'manage_competitors',
  'competitor.ownProduct.list': 'view_reports',
  'competitor.search': 'manage_competitors',
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
  'growth.metricTree': 'view_reports',
  'experiment.create': 'manage_experiments',
  'experiment.list': 'view_reports',
  'experiment.result': 'view_reports',
  'agent.run': 'use_gemini_workspace',
  'agent.runs': 'view_reports',
  'agent.debate': 'use_gemini_workspace',
  'agent.memory': 'use_gemini_workspace',
  'agent.budget': 'view_reports',
  'autoupgrade.propose': 'approve_auto_upgrade',
  'autoupgrade.list': 'view_reports',
  'autoupgrade.apply': 'approve_auto_upgrade',
  'autoupgrade.rollback': 'approve_auto_upgrade',
  'connector.registry': 'view_reports',
  'connector.import': 'manage_connectors',
  'forecast.run': 'execute_task',
  'alerts.list': 'view_reports',
  'alerts.ack': 'manage_alerts',
  'report.export': 'view_reports',
  'backup.create': 'manage_backups',
  'backup.list': 'manage_backups',
};

/** Métodos liberados sem sessão (apenas os necessários para o primeiro acesso). */
const PUBLIC_METHODS = new Set(['ping', 'auth.login', 'auth.bootstrap', 'auth.session']);
/** Logout exige sessão válida, mas não uma permissão de negócio específica. */
const SESSION_ONLY_METHODS = new Set(['auth.logout']);

export class LocalService {
  private readonly handlers = new Map<string, Handler>();

  private readonly competitors: CompetitorService;

  constructor(private readonly deps: ServiceDeps) {
    this.competitors = new CompetitorService(deps.db);
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

  private registerAll(): void {
    const { db, secrets, tasks, gemini, knowledge, autoUpgrade, capture } = this.deps;

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
        marketplace: z.string(),
        accountId: z.string(),
        displayName: z.string(),
        handle: z.string().optional(),
        confidence: z.number().min(0).max(1),
        verifiedByUser: z.boolean(),
      });
      const input = schema.parse(payload);
      const now = new Date().toISOString();
      db.db
        .prepare(
          `INSERT INTO accounts (id, marketplace, external_ref, display_name, handle, detection_confidence, verified_by_user, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, handle=excluded.handle,
             detection_confidence=excluded.detection_confidence, verified_by_user=excluded.verified_by_user, updated_at=excluded.updated_at`,
        )
        .run(input.accountId, input.marketplace, input.handle ?? null, input.displayName, input.handle ?? null, input.confidence, input.verifiedByUser ? 1 : 0, now, now);
      this.audit(auth, 'ACCOUNT_UPSERT', 'account', input.accountId, 'OK');
      return { ok: true, accountId: input.accountId };
    });

    this.register('account.list', () =>
      db.rows<{ id: string; marketplace: string; display_name: string; verified_by_user: number; detection_confidence: number }>(
        'SELECT id, marketplace, display_name, verified_by_user, detection_confidence FROM accounts ORDER BY marketplace, display_name',
      ),
    );

    this.register('capture.ingest', (payload, auth) => {
      const result = capture.ingest(payload);
      this.audit(auth, 'CAPTURE_INGEST', 'listing_snapshot', null, result.ok ? 'OK' : 'PARTIAL', result.errors.join('; '));
      return result;
    });

    this.register('capture.snapshot', (payload) => {
      const schema = z.object({ listingId: z.string(), days: z.number().int().min(1).max(365).default(30) });
      const input = schema.parse(payload);
      return {
        kpis: capture.kpisForListing(input.listingId, input.days),
        trend: capture.trend(input.listingId),
      };
    });

    // ------------------------------------------------------------ KPIs, missões, financeiro
    this.register('kpi.listing', (payload) => {
      const schema = z.object({ listingId: z.string(), days: z.number().int().min(1).max(365).default(30) });
      const input = schema.parse(payload);
      return capture.kpisForListing(input.listingId, input.days);
    });

    this.register('kpi.dashboard', () => {
      const accounts = db.rows<{ id: string; marketplace: string; display_name: string }>(
        'SELECT id, marketplace, display_name FROM accounts',
      );
      const listings = db.rows<{ id: string; account_id: string; marketplace: string; external_id: string; title: string | null }>(
        'SELECT id, account_id, marketplace, external_id, title FROM listings',
      );
      const perListing = listings
        .map((l) => ({ ...l, kpis: capture.kpisForListing(l.id, 30) }))
        .filter((l) => l.kpis !== null);
      const sumKnown = (select: (pillars: NonNullable<(typeof perListing)[number]['kpis']>['pillars']) => number | null): number | null => {
        // Não apresentar como total da conta um subtotal quando há anúncios
        // sem snapshot recente. Ausência de captura não significa valor zero.
        if (perListing.length === 0 || perListing.length !== listings.length) return null;
        const values = perListing.map((l) => select(l.kpis!.pillars));
        if (values.some((value) => value === null || !Number.isFinite(value))) return null;
        return (values as number[]).reduce((sum, value) => sum + value, 0);
      };
      const toCents = (value: number | null): number | null => value === null ? null : Math.round(value * 100);
      const grossRevenue = sumKnown((m) => m.revenue_profit.gmv);
      const netRevenue = sumKnown((m) => m.revenue_profit.netRevenue);
      const visits = sumKnown((m) => m.conversion_cro.visits);
      const orders = sumKnown((m) => m.conversion_cro.orders);
      const adSpend = sumKnown((m) => m.acquisition_ads.adSpend);
      const adRevenue = sumKnown((m) => m.acquisition_ads.adAttributedRevenue);
      const units = sumKnown((m) => m.conversion_cro.units);
      const stock = sumKnown((m) => m.operational_health.stockAvailable);
      const returnCount = sumKnown((m) => m.post_purchase_retention.returnsCount);
      const dailySales = sumKnown((m) => m.operational_health.dailySalesAvg.value);
      const acosPct = adSpend !== null && adRevenue !== null && adRevenue > 0 ? (adSpend / adRevenue) * 100 : null;
      const roas = adSpend !== null && adSpend > 0 && adRevenue !== null ? adRevenue / adSpend : null;
      const totals = {
        gmvCents: toCents(grossRevenue),
        netRevenueCents: toCents(netRevenue),
        // O custo dos produtos/comissões ainda não está ligado a todos os snapshots;
        // não inventar contribuição ou margem quando a base financeira está incompleta.
        contributionCents: null,
        contributionMarginPct: null,
        visits,
        orders,
        units,
        adSpendCents: toCents(adSpend),
        cvr: visits !== null && visits > 0 && orders !== null ? (orders / visits) * 100 : null,
        aovCents: grossRevenue !== null && orders !== null && orders > 0 ? Math.round((grossRevenue * 100) / orders) : null,
        acosPct,
        roas,
        returnRatePct: returnCount !== null && orders !== null && orders > 0 ? (returnCount / orders) * 100 : null,
        stockCoverageDays: stock !== null && dailySales !== null && dailySales > 0 ? stock / dailySales : null,
      };
      return {
        accounts,
        listings: perListing,
        coverage: {
          totalListings: listings.length,
          capturedListings: perListing.length,
          uncapturedListings: Math.max(0, listings.length - perListing.length),
        },
        totals,
      };
    });

    this.register('missions.today', () => {
      const listings = db.rows<{ id: string; account_id: string; marketplace: string }>(
        'SELECT id, account_id, marketplace FROM listings',
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

    this.register('finance.costs.upsert', (payload, auth) => {
      const schema = z.object({
        skuId: z.string(),
        unitCostCents: z.number().int().min(0),
        packagingCents: z.number().int().min(0).default(0),
        shippingCents: z.number().int().min(0).default(0),
        otherVariableCents: z.number().int().min(0).default(0),
        taxPct: z.number().min(0).max(100).default(0),
        minMarginPct: z.number().min(0).max(100).default(20),
      });
      const i = schema.parse(payload);
      // O SKU precisa existir antes de versionar custos (FK explícita).
      const sku = db.row<{ id: string }>('SELECT id FROM skus WHERE id = ?', i.skuId);
      if (!sku) throw new Error(`SKU ${i.skuId} não cadastrado; cadastre o SKU antes de informar custos`);
      const last = db.row<{ v: number }>('SELECT COALESCE(MAX(version),0) AS v FROM sku_costs WHERE sku_id = ?', i.skuId);
      const version = (last?.v ?? 0) + 1;
      db.db
        .prepare(
          'INSERT INTO sku_costs (id, sku_id, version, unit_cost_cents, packaging_cents, shipping_cents, other_variable_cents, tax_pct, min_margin_pct, valid_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), i.skuId, version, i.unitCostCents, i.packagingCents, i.shippingCents, i.otherVariableCents, i.taxPct, i.minMarginPct, new Date().toISOString(), new Date().toISOString());
      this.audit(auth, 'COST_VERSION', 'sku_cost', i.skuId, 'OK', `versão ${version}`);
      return { ok: true, version };
    });

    // ------------------------------------------------------------ tarefas
    this.register('task.create', (payload, auth) => {
      const schema = z.object({
        name: z.string().min(1),
        kind: z.string(),
        accountId: z.string().optional(),
        mode: z.enum(['DRAFT', 'PUBLISH']),
        scheduleAt: z.string().datetime().nullable().optional(),
        recurrence: z.string().nullable().optional(),
        typing: z.object({ mode: z.enum(['set_value', 'keyboard_simulated', 'virtual_keyboard']), charDelayMs: z.number().int().min(0).max(1000), settleDelayMs: z.number().int().min(0).max(5000), verifyAfterTyping: z.boolean() }),
        items: z
          .array(
            z.object({
              listingId: z.string(),
              marketplace: z.string(),
              accountId: z.string(),
              copies: z.number().int().min(1).max(50).default(1),
              title: z.string().nullable().optional(),
              descriptionAdditions: z.string().nullable().optional(),
              coverImageId: z.string().nullable().optional(),
            }),
          )
          .min(1),
      });
      const i = schema.parse(payload);
      const created = tasks.create({
        name: i.name,
        kind: i.kind,
        accountId: i.accountId,
        mode: i.mode,
        scheduleAt: i.scheduleAt ?? null,
        recurrence: i.recurrence ?? null,
        typing: i.typing,
        createdBy: auth?.userId ?? 'system',
        items: i.items,
      });
      this.audit(auth, 'TASK_CREATE', 'task', created.taskId, 'OK', `${i.items.length} itens`);
      return created;
    });

    this.register('task.list', () => ({ tasks: tasks.list(), counts: tasks.counts() }));

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
      const i = z.object({ itemId: z.string() }).parse(payload);
      tasks.markItemStatus(i.itemId, 'SKIPPED', 'pulado pelo usuário');
      this.audit(auth, 'TASK_ITEM_SKIP', 'task_item', i.itemId, 'OK');
      return { ok: true };
    });

    this.register('task.runNow', (payload, auth) => {
      const i = z.object({ taskId: z.string() }).parse(payload);
      const task = tasks.get(i.taskId);
      if (!task) throw new Error('tarefa inexistente');
      tasks.transition(i.taskId, 'RUNNING');
      this.audit(auth, 'TASK_RUN_NOW', 'task', i.taskId, 'OK');
      return { ok: true, status: 'RUNNING', note: 'execução requer o navegador com a sessão validada' };
    });

    // ------------------------------------------------------------ guard
    this.register('guard.evaluate', (payload, auth) => {
      // Um pedido sem as seções obrigatórias estourava dentro do guard com
      // "Cannot read properties of undefined". Agora responde validação clara.
      const parsed = z
        .object({
          action: z.enum(['edit_title', 'edit_description', 'upload_image', 'change_price', 'duplicate_listing', 'toggle_ads']),
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
          currentState: z.record(z.unknown()).nullable().default(null),
          financialLimits: z.record(z.unknown()).nullable().default(null),
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
      const i = z.object({ marketplace: z.string(), observed: z.record(z.number()).default({}) }).parse(payload);
      const adapter = IMPLEMENTED_ADAPTERS.find((a) => a.id === i.marketplace);
      if (!adapter) return { ok: false, error: `adapter ${i.marketplace} não implementado`, planned: PLANNED_ADAPTERS };
      return { ok: true, diagnostics: adapter.diagnose(i.observed) };
    });

    // ------------------------------------------------------------ keywords / rank
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

    this.register('rank.record', (payload, auth) => {
      const i = z
        .object({ listingId: z.string(), keywordId: z.string().nullable().default(null), position: z.number().int().min(0).max(500), isSponsored: z.boolean().default(false), context: z.record(z.unknown()).default({}) })
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
      const redacted = redactPII(i.text);
      const id = randomUUID();
      db.db
        .prepare('INSERT INTO customer_voice_items (id, account_id, listing_id, kind, source_class, observed_at, text_redacted, rating, verified_purchase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
        .run(id, i.accountId, i.listingId, i.kind, 'A_PRIMARY_UI', new Date().toISOString(), redacted, i.rating);
      this.audit(auth, 'VOC_INGEST', 'customer_voice_item', id, 'OK', 'texto com dados pessoais redigidos');
      return { ok: true, id };
    });

    this.register('voc.topics', (payload) => {
      const i = z.object({ accountId: z.string() }).parse(payload);
      return db.rows<Record<string, unknown>>('SELECT * FROM customer_voice_topics WHERE account_id = ? ORDER BY frequency DESC', i.accountId);
    });

    this.register('growth.initiatives', () => db.rows<Record<string, unknown>>('SELECT * FROM growth_initiatives ORDER BY updated_at DESC LIMIT 200'));
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
    this.register('agent.run', (payload, auth) => {
      const schema = z.object({
        agents: z.array(z.string()).min(1),
        context: z.record(z.unknown()),
      });
      const i = schema.parse(payload);
      const recs = runAgents(i.agents as never, i.context as unknown as AgentContext);
      const synthesis = synthesize(recs, i.context as unknown as AgentContext);
      this.audit(auth, 'AGENT_RUN', 'agent_run', null, 'OK', `${recs.length} recomendações`);
      return synthesis;
    });

    this.register('agent.runs', () => db.rows<Record<string, unknown>>('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 100'));

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
      const i = z.object({ proposalId: z.string(), approved: z.boolean(), readFile: z.record(z.string()).default({}) }).parse(payload);
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
      const i = z.object({ proposalId: z.string(), files: z.record(z.string()).default({}) }).parse(payload);
      const writes: Array<{ path: string; content: string }> = [];
      const res = autoUpgrade.rollback(i.proposalId, '.', (rel) => i.files[rel] ?? null, (rel, content) => writes.push({ path: rel, content }));
      this.audit(auth, 'AUTOUPGRADE_ROLLBACK', 'auto_upgrade_proposal', i.proposalId, res.ok ? 'OK' : 'FAILED', res.message);
      return { ...res, writes };
    });

    // ------------------------------------------------------------ conectores, previsão, alertas
    this.register('connector.registry', () => db.rows<Record<string, unknown>>('SELECT * FROM connector_registry ORDER BY category, label'));
    this.register('connector.import', (payload, auth) => {
      const i = z.object({ fileName: z.string(), rows: z.array(z.record(z.unknown())).max(50_000) }).parse(payload);
      const jobId = randomUUID();
      db.db
        .prepare('INSERT INTO import_jobs (id, file_name, file_type, status, rows_total, rows_ok, rows_error, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(jobId, i.fileName, 'csv', 'PENDENTE_VALIDACAO', i.rows.length, 0, 0, new Date().toISOString(), null);
      this.audit(auth, 'IMPORT_QUEUED', 'import_job', jobId, 'OK', `${i.rows.length} linhas`);
      return { ok: true, jobId, note: 'linhas ficam em validação até mapeamento de colunas e proveniência' };
    });

    this.register('forecast.run', () => ({ ok: false, error: 'forecast exige histórico mínimo de 8 semanas coletadas' }));
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
      const i = z
        .object({ type: z.string().default('EXECUTIVO'), format: z.enum(['csv', 'json']).default('csv') })
        .parse(payload ?? {});
      const queries: Record<string, string> = {
        EXECUTIVO: 'SELECT * FROM listing_snapshots ORDER BY captured_at DESC LIMIT 5000',
        KPIS: 'SELECT * FROM listing_snapshots ORDER BY captured_at DESC LIMIT 20000',
        CONCORRENCIA: 'SELECT * FROM competitor_relations ORDER BY created_at DESC LIMIT 5000',
        FINANCEIRO: 'SELECT * FROM sku_costs ORDER BY valid_from DESC LIMIT 5000',
        EXPERIMENTOS: 'SELECT * FROM experiments ORDER BY created_at DESC LIMIT 2000',
        AUDITORIA: 'SELECT * FROM audit_log ORDER BY at DESC LIMIT 5000',
      };
      const sql = queries[i.type] ?? queries.EXECUTIVO!;
      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = db.rows<Record<string, unknown>>(sql);
      } catch {
        rows = [];
      }
      this.audit(auth, 'REPORT_EXPORT', 'report', i.type, 'OK', `${rows.length} linhas em ${i.format}`);
      return {
        ok: true,
        type: i.type,
        format: i.format,
        generatedAt: new Date().toISOString(),
        rowCount: rows.length,
        rows,
      };
    });

    this.register('backup.create', (payload, auth) => {
      const note = z.object({ note: z.string().default('manual') }).parse(payload ?? {}).note;
      const backup = db.backup(note);
      this.audit(auth, 'BACKUP_CREATE', 'backup', backup.path, 'OK', note);
      return { ok: true, ...backup };
    });

    this.register('backup.list', () => db.rows<Record<string, unknown>>('SELECT * FROM backups ORDER BY created_at DESC LIMIT 100'));
  }

  /** Resolve token → sessão válida. */
  private resolveSession(token: string): AuthContext | null {
    const row = this.deps.db.row<{ user_id: string; role: AccessRole; expires_at: string; revoked_at: string | null }>(
      `SELECT s.user_id, u.role, s.expires_at, s.revoked_at
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      sha256(token),
    );
    if (!row) return null;
    if (row.revoked_at) return null;
    if (Date.parse(row.expires_at) < Date.now()) return null;
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
