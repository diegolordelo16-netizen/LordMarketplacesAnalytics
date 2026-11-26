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
  | 'manage_connectors';

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
  'capture.ingest',
  'capture.snapshot',
  'kpi.listing',
  'kpi.dashboard',
  'missions.today',
  'finance.simulate',
  'finance.costs.upsert',
  'task.create',
  'task.list',
  'task.pause',
  'task.resume',
  'task.skipItem',
  'task.cancel',
  'task.runNow',
  'guard.evaluate',
  'audit.list',
  'audit.rollback',
  'adapter.diagnostics',
  'keyword.list',
  'keyword.upsert',
  'keyword.gap',
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
  'growth.metricTree',
  'experiment.create',
  'experiment.list',
  'experiment.result',
  'agent.run',
  'agent.runs',
  'agent.debate',
  'agent.memory',
  'agent.budget',
  'autoupgrade.propose',
  'autoupgrade.list',
  'autoupgrade.apply',
  'autoupgrade.rollback',
  'connector.registry',
  'connector.import',
  'forecast.run',
  'alerts.list',
  'alerts.ack',
  'report.export',
  'backup.create',
  'backup.list',
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
