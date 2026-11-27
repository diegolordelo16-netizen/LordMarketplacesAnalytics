/**
 * Schema completo do banco local (§30). Fonte de verdade: SQLite.
 * Decisão de engenharia: Drizzle ORM foi substituído pelo driver `node:sqlite` nativo
 * (Node 22+) com migrations SQL versionadas e repositórios tipados. Justificativa:
 *  - zero dependência nativa compilada (better-sqlite3 exigiria build tools no Windows);
 *  - o instalador passa a distribuir apenas o runtime Node, sem addons pré-compilados;
 *  - migrations explícitas e auditáveis, com WAL, foreign_keys e transações.
 * O schema abaixo é a especificação executável; `migrations/001_init.sql` o materializa.
 */

export interface TableSpec {
  name: string;
  purpose: string;
  scope: string[];
  indexes?: string[][];
  retention?: string;
}

export const SCHEMA_VERSION = 8;

export const TABLE_SPECS: TableSpec[] = [
  // ---------------------------------------------------------------- identidade & acesso
  { name: 'users', purpose: 'perfis super_admin/operador/visualizador', scope: [], retention: 'permanente' },
  { name: 'auth_sessions', purpose: 'sessões locais (token hash, expiração)', scope: ['user_id'], retention: '30 dias' },
  { name: 'audit_log', purpose: 'trilha de auditoria de toda ação sensível', scope: ['actor_user_id'], retention: 'permanente' },

  // ---------------------------------------------------------------- fontes & proveniência
  { name: 'data_sources', purpose: 'catálogo de fontes e classes A..G', scope: [], retention: 'permanente' },
  { name: 'data_source_runs', purpose: 'execuções de coleta/importação', scope: ['data_source_id', 'account_id'], retention: '180 dias' },
  { name: 'data_provenance', purpose: 'proveniência por métrica coletada', scope: ['account_id', 'listing_id'], retention: '365 dias' },
  { name: 'data_quality_issues', purpose: 'problemas de integridade detectados', scope: ['account_id', 'run_id'], retention: '180 dias' },
  { name: 'import_jobs', purpose: 'importação de CSV/XLSX pelo usuário', scope: ['account_id'], retention: '180 dias' },
  { name: 'import_job_rows', purpose: 'linhas normalizadas em staging até o mapeamento e commit explícitos', scope: ['job_id'], retention: '180 dias' },

  // ---------------------------------------------------------------- catálogo & contas
  { name: 'marketplaces', purpose: 'marketplaces suportados', scope: [], retention: 'permanente' },
  { name: 'accounts', purpose: 'contas/lojas autenticadas detectadas', scope: ['marketplace'], retention: 'permanente' },
  { name: 'catalog_products', purpose: 'produtos canônicos (agrupam variações)', scope: ['account_id'], retention: 'permanente' },
  { name: 'skus', purpose: 'SKUs com identificadores (EAN/GTIN/UPC)', scope: ['catalog_product_id'], retention: 'permanente' },
  { name: 'listings', purpose: 'anúncios por marketplace/conta', scope: ['account_id', 'sku_id'], indexes: [['account_id', 'external_id']], retention: 'permanente' },
  { name: 'listing_variations', purpose: 'variações/grade do anúncio', scope: ['listing_id'], retention: 'permanente' },
  { name: 'listing_snapshots', purpose: 'snapshots datados de KPIs, estado do anúncio e evidências da captura', scope: ['listing_id', 'account_id'], indexes: [['listing_id', 'captured_at']], retention: 'permanente' },
  { name: 'account_snapshots', purpose: 'snapshots agregados de KPIs sem depender de anúncio individual', scope: ['account_id', 'marketplace', 'page_kind'], indexes: [['account_id', 'captured_at']], retention: 'permanente' },

  // ---------------------------------------------------------------- financeiro
  { name: 'sku_costs', purpose: 'versões históricas de custos por SKU', scope: ['sku_id'], retention: 'permanente' },
  { name: 'marketplace_fees', purpose: 'comissões e taxas por marketplace/categoria', scope: ['marketplace'], retention: 'permanente' },
  { name: 'price_observations', purpose: 'preço próprio e de concorrentes ao longo do tempo', scope: ['listing_id'], retention: 'permanente' },
  { name: 'price_scenarios', purpose: 'cenários simulados (nunca aplicados automaticamente)', scope: ['sku_id'], retention: '365 dias' },
  { name: 'price_rules', purpose: 'limites de preço, margem mínima, cooldown', scope: ['sku_id'], retention: 'permanente' },
  { name: 'price_change_approvals', purpose: 'aprovação humana de mudança de preço', scope: ['sku_id'], retention: 'permanente' },

  // ---------------------------------------------------------------- busca & keywords
  { name: 'keywords', purpose: 'banco versionado de termos', scope: ['marketplace'], indexes: [['marketplace', 'normalized']], retention: 'permanente' },
  { name: 'keyword_clusters', purpose: 'agrupamentos semânticos corrigíveis', scope: ['marketplace'], retention: 'permanente' },
  { name: 'keyword_observations', purpose: 'observações por origem/data (frequência, índice, volume)', scope: ['keyword_id', 'account_id'], retention: 'permanente' },
  { name: 'keyword_competitor_gaps', purpose: 'lacunas e sobreposição vs concorrentes', scope: ['account_id'], retention: '365 dias' },
  { name: 'search_snapshots', purpose: 'captura de SERP interna por termo/contexto', scope: ['marketplace', 'account_id'], retention: 'permanente' },
  { name: 'search_results', purpose: 'resultados observados em cada snapshot', scope: ['snapshot_id'], retention: 'permanente' },
  { name: 'rank_observations', purpose: 'posição do anúncio por termo/data', scope: ['listing_id', 'keyword_id'], retention: 'permanente' },
  { name: 'visibility_share_snapshots', purpose: 'share of visibility observado (não é market share)', scope: ['account_id'], retention: 'permanente' },

  // ---------------------------------------------------------------- concorrência & mercado
  { name: 'competitor_content_observations', purpose: 'descrições, promoções e evidência visual comparável com origem e data', scope: ['account_id','own_product_id','candidate_id'], retention: 'permanente' },
  { name: 'competitor_public_search_observations', purpose: 'cartões públicos observados por produto/conta, sem inferir ranking absoluto', scope: ['account_id','own_product_id','candidate_id'], retention: 'permanente' },
  { name: 'competitors', purpose: 'concorrentes cadastrados/descobertos', scope: ['account_id'], retention: 'permanente' },
  { name: 'competitor_listings', purpose: 'anúncios do concorrente e vínculo ao produto próprio', scope: ['competitor_id'], retention: 'permanente' },
  { name: 'competitor_snapshots', purpose: 'estado observado (preço, frete, nota, posição)', scope: ['competitor_listing_id'], retention: 'permanente' },
  { name: 'competitor_events', purpose: 'mudanças detectadas entre snapshots', scope: ['competitor_id'], retention: 'permanente' },
  { name: 'competitor_alerts', purpose: 'alertas configuráveis de movimento', scope: ['competitor_id'], retention: '180 dias' },
  { name: 'category_snapshots', purpose: 'painel de categoria por período', scope: ['marketplace', 'account_id'], retention: 'permanente' },
  { name: 'category_trends', purpose: 'séries de tendência relativa', scope: ['marketplace'], retention: 'permanente' },
  { name: 'product_opportunities', purpose: 'oportunidades de produto/nicho', scope: ['marketplace', 'account_id'], retention: 'permanente' },
  { name: 'opportunity_scores', purpose: 'componentes e confiança do score', scope: ['product_opportunity_id'], retention: 'permanente' },

  // ---------------------------------------------------------------- voz do cliente
  { name: 'customer_voice_items', purpose: 'avaliações/perguntas/reclamações com redaction', scope: ['account_id', 'listing_id'], retention: 'configurável' },
  { name: 'customer_voice_topics', purpose: 'temas classificados com evidência e confiança', scope: ['account_id'], retention: 'configurável' },
  { name: 'return_reason_observations', purpose: 'motivos de devolução observados', scope: ['listing_id'], retention: 'permanente' },
  { name: 'review_insights', purpose: 'insights agregados (promessa vs. recebido)', scope: ['account_id'], retention: 'permanente' },

  // ---------------------------------------------------------------- growth
  { name: 'metric_definitions', purpose: 'definição formal de cada métrica', scope: [], retention: 'permanente' },
  { name: 'metric_tree_nodes', purpose: 'árvore de métricas até a North Star', scope: [], retention: 'permanente' },
  { name: 'growth_initiatives', purpose: 'backlog com RICE/ICE e responsável', scope: ['account_id'], retention: 'permanente' },
  { name: 'growth_hypotheses', purpose: 'hipóteses falsificáveis', scope: ['account_id'], retention: 'permanente' },
  { name: 'experiments', purpose: 'registro de experimentos e desenho', scope: ['account_id'], retention: 'permanente' },
  { name: 'experiment_variants', purpose: 'controle e variantes', scope: ['experiment_id'], retention: 'permanente' },
  { name: 'experiment_observations', purpose: 'observações por variante/período', scope: ['experiment_id'], retention: 'permanente' },
  { name: 'experiment_results', purpose: 'análise, limitações e decisão', scope: ['experiment_id'], retention: 'permanente' },
  { name: 'cohorts', purpose: 'coortes agregadas (sem perfil individual)', scope: ['account_id'], retention: 'permanente' },
  { name: 'cohort_metrics', purpose: 'retenção/recompra por coorte', scope: ['cohort_id'], retention: 'permanente' },
  { name: 'attribution_records', purpose: 'janelas de atribuição por canal (agregado)', scope: ['account_id'], retention: 'permanente' },

  // ---------------------------------------------------------------- operações & automação
  { name: 'tasks', purpose: 'tarefas personalizadas e agendamentos', scope: ['account_id', 'created_by'], retention: 'permanente' },
  { name: 'task_items', purpose: 'itens por anúncio dentro da tarefa', scope: ['task_id', 'listing_id'], retention: 'permanente' },
  { name: 'task_runs', purpose: 'execuções com progresso e resultado verificado', scope: ['task_id'], retention: '365 dias' },
  { name: 'automation_guard_decisions', purpose: '10 verificações pré-execução e resultado', scope: ['account_id', 'listing_id'], retention: 'permanente' },
  { name: 'change_sets', purpose: 'antes/depois de cada alteração com rollback', scope: ['account_id', 'listing_id'], retention: 'permanente' },
  { name: 'image_library', purpose: 'capas validadas por SKU/marketplace', scope: ['account_id', 'sku_id'], retention: 'permanente' },
  { name: 'description_learnings', purpose: 'base anti-devolução aprendida por categoria', scope: ['marketplace'], retention: 'permanente' },
  { name: 'typing_profiles', purpose: 'configuração de teclado virtual por editor', scope: ['marketplace'], retention: 'permanente' },

  // ---------------------------------------------------------------- IA & governança
  { name: 'agent_runs', purpose: 'execução de agente com orçamento e resultado', scope: ['account_id'], retention: '365 dias' },
  { name: 'agent_evidence', purpose: 'evidências citadas por recomendação', scope: ['agent_run_id'], retention: '365 dias' },
  { name: 'agent_recommendations', purpose: 'recomendação com contrato de 10 campos', scope: ['agent_run_id'], retention: 'permanente' },
  { name: 'human_feedback', purpose: 'aceite/rejeição humana e motivo', scope: ['recommendation_id'], retention: 'permanente' },
  { name: 'knowledge_items', purpose: 'memória operacional local (RAG leve)', scope: ['marketplace', 'account_id'], retention: 'permanente' },
  { name: 'validated_playbooks', purpose: 'padrões validados reutilizáveis', scope: ['marketplace'], retention: 'permanente' },
  { name: 'gemini_usage', purpose: 'tokens, custo e status por chamada', scope: ['account_id'], retention: '365 dias' },
  { name: 'prompt_versions', purpose: 'versionamento de prompts de agentes', scope: [], retention: 'permanente' },
  { name: 'debate_sessions', purpose: 'workspace de debate com Gemini', scope: ['user_id'], retention: '180 dias' },
  { name: 'auto_upgrade_proposals', purpose: 'patches propostos com diff, risco e testes', scope: [], retention: 'permanente' },

  // ---------------------------------------------------------------- conectores, previsão, alertas
  { name: 'seo_external_runs', purpose: 'histórico externo Google, backlinks e IA com proveniência e custo', scope: ['account_id'], retention: 'permanente' },
  { name: 'seo_rank_watches', purpose: 'monitoramento Google opt-in com limite finito de chamadas', scope: ['account_id'], retention: 'permanente' },
  { name: 'connector_sync_runs', purpose: 'histórico de leituras oficiais segregado por conta e propriedade', scope: ['account_id','connector_id'], retention: '365 dias' },
  { name: 'connector_sync_rows', purpose: 'dados externos sem promoção automática a KPI', scope: ['run_id'], retention: '365 dias' },
  { name: 'connector_request_log', purpose: 'reservas de quota local antes de chamadas externas', scope: ['connector_id'], retention: '365 dias' },
  { name: 'connector_registry', purpose: 'conectores disponíveis, limites e custos', scope: [], retention: 'permanente' },
  { name: 'connector_credentials_metadata', purpose: 'metadados de credencial (NUNCA o segredo)', scope: ['connector_id'], retention: 'permanente' },
  { name: 'connector_usage_costs', purpose: 'consumo/custo estimado por conector', scope: ['connector_id'], retention: '365 dias' },
  { name: 'forecast_runs', purpose: 'execuções de previsão com método e erro', scope: ['account_id'], retention: '365 dias' },
  { name: 'forecast_scenarios', purpose: 'cenários com intervalos de incerteza', scope: ['forecast_run_id'], retention: '365 dias' },
  { name: 'anomaly_events', purpose: 'anomalias detectadas com baseline', scope: ['account_id'], retention: '365 dias' },
  { name: 'alerts', purpose: 'alertas com severidade, evidência e ack', scope: ['account_id'], retention: '365 dias' },

  // ---------------------------------------------------------------- configuração & backup
  { name: 'settings', purpose: 'configurações chave-valor (sem segredos)', scope: [], retention: 'permanente' },
  { name: 'secrets', purpose: 'segredos cifrados via DPAPI/AES-GCM (chave Gemini)', scope: [], retention: 'permanente' },
  { name: 'backups', purpose: 'registro de backups criados', scope: [], retention: 'permanente' },
  { name: 'schema_migrations', purpose: 'controle de migrations aplicadas', scope: [], retention: 'permanente' },
];

export function tableNames(): string[] {
  return TABLE_SPECS.map((t) => t.name);
}
