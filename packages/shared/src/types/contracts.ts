/**
 * Contratos IPC e de domínio entre extensão, Native Messaging Host e serviço local (§2.3, §17).
 * Framing Native Messaging: 4 bytes little-endian de tamanho + JSON UTF-8.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Limite de payload aceito em qualquer salto (4 MiB). Acima disso → rejeição auditada. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Payloads vindos do MAIN world são limitados mais agressivamente (§4.3). */
export const MAX_MAIN_WORLD_MESSAGE_BYTES = 256 * 1024;

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const ACCESS_ROLES = ['super_admin', 'operador', 'visualizador'] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

export const ROLE_PERMISSIONS: Record<AccessRole, readonly Permission[]> = {
  super_admin: [
    'manage_gemini_key',
    'approve_auto_upgrade',
    'manage_financial_limits',
    'manage_backups',
    'manage_users',
    'execute_task',
    'edit_listing',
    'use_gemini_workspace',
    'view_reports',
    'manage_connectors',
    'manage_accounts',
    'manage_competitors',
    'manage_market_intelligence',
    'manage_experiments',
    'manage_alerts',
  ],
  operador: ['execute_task', 'edit_listing', 'use_gemini_workspace', 'view_reports'],
  visualizador: ['view_reports'],
};

export type Permission =
  | 'manage_gemini_key'
  | 'approve_auto_upgrade'
  | 'manage_financial_limits'
  | 'manage_backups'
  | 'manage_users'
  | 'execute_task'
  | 'edit_listing'
  | 'use_gemini_workspace'
  | 'view_reports'
  | 'manage_connectors'
  | 'manage_accounts'
  | 'manage_competitors'
  | 'manage_market_intelligence'
  | 'manage_experiments'
  | 'manage_alerts';

export function roleHasPermission(role: AccessRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Operações que a extensão pode pedir ao serviço local. */
export const IPC_METHODS = [
  'ping',
  'auth.login',
  'auth.logout',
  'auth.session',
  'auth.bootstrap',
  'settings.get',
  'settings.set',
  'gemini.setKey',
  'gemini.testKey',
  'account.upsert',
  'account.list',
  'account.setActive',
  'user.list',
  'user.upsert',
  'user.setActive',
  'catalog.product.upsert',
  'catalog.product.list',
  'catalog.sku.upsert',
  'catalog.sku.list',
  'media.list',
  'media.get',
  'media.add',
  'media.delete',
  'capture.ingest',
  'capture.snapshot',
  'capture.accountSnapshots',
  'capture.details',
  'capture.chartPoints',
  'navigation.observe',
  'navigation.list',
  'navigation.graph',
  'navigation.summary',
  'navigation.clear',
  'kpi.listing',
  'kpi.dashboard',
  'kpi.history',
  'kpi.compare',
  'kpi.compare.detail',
  'analysis.run',
  'missions.today',
  'finance.simulate',
  'finance.bundle.simulate',
  'finance.costs.upsert',
  'task.create',
  'task.createByFilter',
  'task.list',
  'task.pause',
  'task.resume',
  'task.skipItem',
  'task.cancel',
  'task.runNow',
  'task.claimNext',
  'task.itemResult',
  'task.recoverDraft',
  'task.approvePublish',
  'task.claimNextPublish',
  'task.publishResult',
  'task.rollbackPrepare',
  'guard.evaluate',
  'audit.list',
  'audit.rollback',
  'adapter.diagnostics',
  'keyword.list',
  'keyword.upsert',
  'keyword.gap',
  'keyword.suggest',
  'keyword.cluster',
  'keyword.visibility',
  'keyword.cannibalization',
  'rank.record',
  'rank.history',
  'competitor.upsert',
  'competitor.list',
  'competitor.timeline',
  'competitor.alerts',
  'competitor.ownProduct.upsert',
  'competitor.ownProduct.list',
  'competitor.search',
  'competitor.relations',
  'competitor.approve',
  'competitor.reject',
  'competitor.edit',
  'competitor.changeCandidate',
  'competitor.reanalyze',
  'competitor.monitoring.set',
  'competitor.monitoring.record',
  'competitor.monitoring.history',
  'competitor.stats',
  'market.categorySnapshot',
  'market.opportunities',
  'voc.ingest',
  'voc.topics',
  'growth.initiatives',
  'growth.initiative.upsert',
  'growth.initiative.setStatus',
  'growth.metricTree',
  'experiment.create',
  'experiment.list',
  'experiment.result',
  'agent.run',
  'agent.runs',
  'agent.recommendations',
  'agent.feedback',
  'agent.debate',
  'agent.memory',
  'agent.budget',
  'autoupgrade.propose',
  'autoupgrade.list',
  'autoupgrade.apply',
  'autoupgrade.rollback',
  'connector.registry',
  'connector.setEnabled',
  'connector.disconnect',
  'connector.import',
  'connector.import.list',
  'connector.import.get',
  'connector.import.commit',
  'forecast.run',
  'alerts.list',
  'alerts.ack',
  'report.export',
  'sync.createAll',
  'sync.list',
  'sync.retryFailed',
  'sync.completeAccount',
  'sync.accountProgress',
  'sync.claimAccount',
  'sync.schedule.create',
  'sync.schedule.list',
  'sync.schedule.setEnabled',
  'sync.schedule.runs',
  'sync.claimScheduled',
  'sync.claimBrowserRequest',
  'voc.ingestBatch',
  'voc.items',
  'finance.realized.upsert',
  'finance.realized.list',
  'finance.realized.summary',
  'finance.profitability',
  'listing.change.prepare',
  'listing.change.list',
  'listing.change.review',
  'operation.receipt.record',
  'operation.receipt.list',
  'operation.measure',
  'offer.variation.update',
  'offer.variation.delete',
  'inventory.dashboard',
  'ads.dashboard',
  'competitor.evidence.record',
  'competitor.evidence.compare',
  'campaign.change.prepare',
  'campaign.change.list',
  'campaign.change.review',
  'offer.variation.prepare',
  'offer.variation.list',
  'offer.variation.review',
  'operation.mode.get',
  'operation.mode.set',
  'analysis.schedule.create',
  'analysis.schedule.list',
  'analysis.schedule.setEnabled',
  'analysis.schedule.runs',
  'report.schedule.create',
  'report.schedule.list',
  'report.schedule.setEnabled',
  'report.schedule.runs',
  'report.schedule.run.get',
  'connector.configure',
  'connector.test',
  'task.verifySaved',
  'task.rollbackPlan',
  'backup.create',
  'backup.list',
  'backup.restore',
] as const;
export type IpcMethod = (typeof IPC_METHODS)[number];

export interface IpcRequest<T = unknown> {
  id: string;
  method: IpcMethod;
  protocolVersion: number;
  /** Papel do usuário autenticado — validado no serviço local, não confiado do cliente. */
  token?: string;
  payload?: T;
}

export type IpcErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BLOCKED_BY_GUARD'
  | 'PAYLOAD_TOO_LARGE'
  | 'PROTOCOL_MISMATCH'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL';

export interface IpcResponse<T = unknown> {
  id: string;
  ok: boolean;
  protocolVersion: number;
  result?: T;
  error?: { code: IpcErrorCode; message: string; details?: unknown };
}

/** Eventos empurrados do serviço local para a extensão. */
export const IPC_EVENTS = [
  'task.progress',
  'task.status',
  'session.changed',
  'alert.created',
  'agent.progress',
  'guard.blocked',
  'autoupgrade.pending',
] as const;
export type IpcEvent = (typeof IPC_EVENTS)[number];

export interface TaskStatusCounts {
  PENDING: number;
  SCHEDULED: number;
  WAITING_BROWSER: number;
  RUNNING: number;
  PAUSED: number;
  COMPLETED: number;
  FAILED: number;
  CANCELLED: number;
}
