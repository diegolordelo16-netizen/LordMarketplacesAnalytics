/**
 * API pública do serviço local. Tudo o que o host nativo, o painel HTTP e os
 * testes precisam é exportado daqui — nunca de caminhos internos.
 */
export { LocalDatabase } from './db/database';
export type { DbOptions } from './db/database';
export { LocalService } from './service';
export type { ServiceDeps, AuthContext } from './service';
export { SecretStore } from './security/secrets';
export { TaskScheduler } from './scheduler/task-scheduler';
export { CaptureService } from './capture/capture-service';
export { GeminiClient, DEFAULT_BUDGET } from './ai/gemini-client';
export type { GeminiBudget, GeminiCallInput, GeminiCallResult, GeminiTransport } from './ai/gemini-client';
export { KnowledgeBase } from './ai/knowledge-base';
export { AutoUpgradeEngine } from './ai/auto-upgrade';
export { runAgents, synthesize, AGENT_KEYS, AGENT_LABEL, AGENT_IMPLEMENTATIONS } from './ai/agents';
export type { AgentContext, AgentKey, AgentRecommendation, DirectorSynthesis } from './ai/agents';
export { evaluateGuard, GUARD_CHECKS } from './guard/automation-guard';
export type { GuardContext, GuardAction } from './guard/automation-guard';
export {
  mercadoLivreAdapter,
  shopeeAdapter,
  PLANNED_ADAPTERS,
  IMPLEMENTED_ADAPTERS,
  adapterForUrl,
  unsupportedCapabilities,
} from './adapters/index';
export type { AdapterDefinition } from './adapters/index';
export { bootstrap, start, main, defaultDataDir, runNativeHost } from './main';
export type { Bootstrap, BootstrapOptions, StartedApp } from './main';
export { createPanelServer, startPanelServer } from './server/panel-server';
export type { PanelServer, PanelServerOptions } from './server/panel-server';
