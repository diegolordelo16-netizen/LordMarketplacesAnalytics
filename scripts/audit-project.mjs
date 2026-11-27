/** Auditoria estática rápida de consistência do workspace (sem credenciais ou rede). */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const manifest = readJson('packages/extension/manifest.json');
const contracts = readJson('contracts.json');
const appJs = readFileSync(join(root, 'packages/local-agent/panel/src/app.js'), 'utf8');
const panelHtml = readFileSync(join(root, 'packages/extension/panel/panel.html'), 'utf8');
const mainTs = readFileSync(join(root, 'packages/local-agent/src/main.ts'), 'utf8');
const installerIss = readFileSync(join(root, 'installer/marketplace-intelligence.iss'), 'utf8');
const serviceTs = readFileSync(join(root, 'packages/local-agent/src/service.ts'), 'utf8');
const workerJs = readFileSync(join(root, 'packages/extension/service-worker.js'), 'utf8');
const mlContent = readFileSync(join(root, 'packages/extension/content/mercado-livre.js'), 'utf8');
const shopeeContent = readFileSync(join(root, 'packages/extension/content/shopee.js'), 'utf8');
const ipcSchema = readFileSync(join(root, 'packages/shared/src/schemas/ipc.ts'), 'utf8');
const failures = [];
const checks = [];
const check = (condition, label) => {
  checks.push({ ok: Boolean(condition), label });
  if (!condition) failures.push(label);
};

check(pkg.version === lock.version && pkg.version === lock.packages?.['']?.version, 'versão do package.json e package-lock.json alinhada');
check(/^>=22\.13(?:\.0)?$/.test(pkg.engines?.node ?? ''), 'runtime Node.js mínimo documentado');
check(manifest.version === pkg.version, 'versão da extensão alinhada ao pacote');
check(panelHtml.includes(`v${pkg.version}`), 'versão exibida no painel da extensão alinhada ao pacote');
check(new RegExp(`process\\.env\\.MI_VERSION\\s*\\?\\?\\s*['\"]${pkg.version.replaceAll('.', '\\.')}['\"]`).test(mainTs), 'versão padrão do serviço alinhada ao pacote');
check(new RegExp(`^\\s*#define AppVersion \"${pkg.version.replaceAll('.', '\\.')}\"$`, 'm').test(installerIss), 'versão padrão do instalador alinhada ao pacote');

check(existsSync(join(root, 'scripts/audit-publish-flow.mjs')) && pkg.scripts?.['audit:publish'] === 'node scripts/audit-publish-flow.mjs', 'smoke test SQLite de publicação assistida está exposto no npm');
for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  const parts = String(command).trim().split(/\s+/);
  const nodeIndex = parts.indexOf('node');
  const target = nodeIndex >= 0 ? parts.slice(nodeIndex + 1).find((part) => !part.startsWith('-')) : null;
  if (target) {
    // O servidor só existe depois do build do agente; sua ausência no checkout limpo é esperada.
    const generatedByBuild = name === 'start:serve' && target === 'dist/local-agent/main.js' && String(pkg.scripts?.['agent:build'] ?? '').includes('build-local-agent.mjs');
    check(existsSync(join(root, target)) || generatedByBuild, `script npm ${name} aponta para ${target}${generatedByBuild ? ' (artefato de agent:build)' : ''}`);
  }
}

const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts ?? []).flatMap((item) => item.js ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.web_accessible_resources ?? []).flatMap((item) => item.resources ?? []).filter((path) => !path.includes('*')),
].filter(Boolean);
for (const path of new Set(referenced)) {
  check(existsSync(join(root, 'packages/extension', path)), `recurso do manifest existe: ${path}`);
}

const actionValues = new Set([...appJs.matchAll(/data-act=["']([^"']+)["']/g)].map((match) => match[1]));
const actionStart = appJs.indexOf('const ACTIONS = {');
const actionEnd = appJs.indexOf('\n};', actionStart);
const actionBlock = actionStart >= 0 && actionEnd > actionStart ? appJs.slice(actionStart, actionEnd) : '';
const actionKeys = new Set([...actionBlock.matchAll(/^\s{2,4}['"]?([a-z0-9-]+)['"]?\s*:/gm)].map((match) => match[1]));
const externallyHandled = new Set(['initiative-status']);
for (const action of actionValues) {
  check(actionKeys.has(action) || externallyHandled.has(action), `ação de interface possui handler: ${action}`);
}

const registered = new Set([...serviceTs.matchAll(/this\.register\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
const ipcTypeSource = readFileSync(join(root, 'packages/shared/src/types/contracts.ts'), 'utf8');
const ipcEnum = ipcTypeSource.match(/export const IPC_METHODS = \[([\s\S]*?)\] as const/)?.[1] ?? '';
const declared = [...ipcEnum.matchAll(/'([^']+)'/g)].map((match) => match[1]);
check(declared.length === new Set(declared).size && declared.length === registered.size &&
  declared.every((method) => registered.has(method)), 'enum IPC corresponde aos handlers do serviço');
check(appJs.includes('method, protocolVersion: 1, token, payload') && appJs.includes("prestartRoute('/api/prestart')"), 'autenticação do dashboard e rota do diagnóstico presentes');
check(appJs.includes('browserRequest: true') && workerJs.includes("callService('sync.claimBrowserRequest'") &&
  Object.hasOwn(contracts, 'sync.claimBrowserRequest'), 'coleta solicitada no dashboard chega ao worker');
const permissionBlock = serviceTs.match(/const METHOD_PERMISSION:[^=]+ = \{([\s\S]*?)\n\};/);
const permissionKeys = new Set([...(permissionBlock?.[1] ?? '').matchAll(/['"]([^'"]+)['"]\s*:/g)].map((match) => match[1]));
const special = new Set(['ping', 'auth.login', 'auth.bootstrap', 'auth.session', 'auth.logout']);
for (const method of registered) check(permissionKeys.has(method) || special.has(method), `método IPC possui política de permissão: ${method}`);
for (const method of permissionKeys) check(registered.has(method), `política IPC aponta para método registrado: ${method}`);

check(Boolean(contracts && typeof contracts === 'object'), 'contracts.json é JSON válido');
check(Object.hasOwn(contracts, 'connector.disconnect'), 'contrato IPC de desconexão de conectores declarado');
check(serviceTs.includes("this.register('connector.disconnect'") && serviceTs.includes('this.deps.secrets.deletePrefix'), 'handler de desconexão remove segredos do namespace');
check(appJs.includes('data-act="connector-disconnect"') && actionKeys.has('connector-disconnect'), 'ação de desconexão acessível na interface');
check(readFileSync(join(root, 'packages/extension/panel/panel.html'), 'utf8').includes('id="capture-areas"'), 'botão de varredura guiada está no painel da extensão');
check(readFileSync(join(root, 'packages/extension/service-worker.js'), 'utf8').includes("'capture.scanAuthorizedAreas'"), 'worker registra a varredura guiada de áreas autorizadas');

// Publicação é um fluxo separado e restrito: autorização administrativa, anúncio/conta exatos,
// aba ativa, confirmação humana e evidência positiva. Estes checks evitam regressões perigosas.
check(Object.hasOwn(contracts, 'task.approvePublish') && Object.hasOwn(contracts, 'task.claimNextPublish') && Object.hasOwn(contracts, 'task.publishResult') && Object.hasOwn(contracts, 'task.rollbackPrepare'), 'contratos IPC de publicação assistida declarados');
check(serviceTs.includes("'task.approvePublish': 'manage_accounts'") && serviceTs.includes("'task.claimNextPublish': 'manage_accounts'") && serviceTs.includes("'task.publishResult': 'manage_accounts'"), 'aprovação e confirmação de publicação exigem manage_accounts');
check(serviceTs.includes("auth.role !== 'super_admin'") && serviceTs.includes('PUBLICAR ${items.length}') && serviceTs.includes('items.length > 10'), 'publicação exige super_admin, frase exata e lote limitado');
check(serviceTs.includes('i.accountId, i.externalListingId') && serviceTs.includes('a.account_id=? AND a.external_listing_id=?') && serviceTs.includes('resultado não corresponde ao anúncio autorizado'), 'fila e retorno da publicação filtram conta e anúncio exatos');
check(serviceTs.includes('before_title') && serviceTs.includes('baseline_source_url') && serviceTs.includes("originalValue === null"), 'aprovação exige snapshot original capturado antes do rascunho');
check(serviceTs.includes('task_publish_approvals') && serviceTs.includes("status='EXECUTING'") && serviceTs.includes('NEEDS_VERIFICATION'), 'aprovação é de uso único e execução incerta exige verificação manual');
check(workerJs.includes("chrome.tabs.query({ active: true, lastFocusedWindow: true })") && workerJs.includes('context.sessionAuthenticated !== true') && workerJs.includes('context.accountId'), 'worker só publica na aba ativa, autenticada e da conta identificada');
check(mlContent.includes('window.confirm(prompt)') && shopeeContent.includes('window.confirm(prompt)'), 'publicação exige confirmação humana na página de cada marketplace');
check(mlContent.includes('waitForSaveConfirmation') && shopeeContent.includes('waitForSaveConfirmation') && mlContent.includes('baselineTitle') && shopeeContent.includes('baselineTitle'), 'publicação verifica confirmação visível e preserva valor anterior');
check(mlContent.includes('salvo com sucesso') && shopeeContent.includes('salvo com sucesso') && mlContent.includes('n[aã]o') && shopeeContent.includes('n[aã]o'), 'detecção de sucesso é conservadora e exclui alertas negativos');
check(serviceTs.includes('30 * 60_000') && serviceTs.includes('snapshot original recente'), 'aprovação rejeita snapshots originais com mais de 30 minutos');
check(serviceTs.includes('itemTransition.changes') && serviceTs.includes('itemStarted.changes') && serviceTs.includes('itemFinished.changes'), 'transições de aprovação, execução e resultado são atômicas e verificam estado esperado');
check(serviceTs.includes("execution: 'DRAFT_ONLY'") && serviceTs.includes('reversão remota só será possível'), 'rollback não executa escrita remota automática');
check(ipcSchema.includes("'task.approvePublish'") && ipcSchema.includes("'task.publishResult'"), 'comandos de publicação estão protegidos no schema IPC');

// Exercita os filtros reais dos content scripts sem navegador ou sessão de vendedor.
const navigationCases = [
  ['mercado-livre.js', 'https://vendedores.mercadolivre.com.br/resumo', 'https://vendedores.mercadolivre.com.br/vendas'],
  ['shopee.js', 'https://seller.shopee.com.br/portal/datacenter/overview', 'https://seller.shopee.com.br/portal/order/list'],
  ['amazon.js', 'https://sellercentral.amazon.com.br/home', 'https://sellercentral.amazon.com.br/orders-v3'],
];
for (const [file, currentUrl, allowedUrl] of navigationCases) {
  const code = readFileSync(join(root, 'packages/extension/content', file), 'utf8');
  const links = [
    { href: allowedUrl, visible: true, textContent: 'Pedidos', getAttribute: () => null },
    { href: 'https://example.com/outro-dominio', visible: true, textContent: 'Externo', getAttribute: () => null },
    { href: `${new URL(currentUrl).origin}/login`, visible: true, textContent: 'Login', getAttribute: () => null },
    { href: `${new URL(currentUrl).origin}/hidden`, visible: false, textContent: 'Oculto', getAttribute: () => null },
  ];
  const listeners = [];
  const window = { MI_DOM: { isVisible: (item) => item.visible, hasChallenge: () => false, paginationInfo: () => null, parseNumberPtBr: () => null, findValueByLabel: () => null, extractExternalId: () => null } };
  const document = { querySelectorAll: () => links, querySelector: () => null };
  const chrome = { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } };
  const context = vm.createContext({ window, location: { href: currentUrl }, chrome, document, URL, String, Number, Math, Set, Array, RegExp });
  let info;
  try {
    vm.runInContext(code, context);
    listeners[0]?.({ type: 'MI_CAPTURE_PAGE_INFO' }, {}, (result) => { info = result; });
  } catch (error) {
    info = null;
  }
  check(info?.authorizedAreaLinks?.length === 1 && info.authorizedAreaLinks[0]?.url === allowedUrl && info.authorizedAreaLinks[0]?.pageKind === 'seller_orders', `navigation links seguros: ${file}`);
}
const workerSource = readFileSync(join(root, 'packages/extension/service-worker.js'), 'utf8');
check(workerSource.includes('Math.min(200') && workerSource.includes("url.protocol !== 'https:'") && workerSource.includes('url.origin !== expectedOrigin'), 'varredura impõe HTTPS, mesmo origin e limite de páginas');
check(Object.hasOwn(contracts, 'analysis.schedule.runs') && readFileSync(join(root, 'packages/shared/src/types/contracts.ts'), 'utf8').includes("'analysis.schedule.runs'"), 'histórico de análise programada declarado no contrato IPC');
check(serviceTs.includes("this.register('analysis.schedule.runs'") && serviceTs.includes("this.register('report.schedule.runs'"), 'históricos de execução de análise e relatório registrados');
check(serviceTs.includes('intervalMinutes: z.number().int().min(15).max(43200)') && serviceTs.includes('retryDecision(schedule.consecutive_failures'), 'agendamentos aceitam intervalo customizado e backoff limitado');
check(serviceTs.includes('nextOccurrence(schedule.next_run_at') && serviceTs.includes('consecutive_failures=0'), 'agenda preserva âncora temporal e reinicia falhas após sucesso');
check(serviceTs.includes("retry.shouldRetry ? 'RETRYING' : 'FAILED'") && serviceTs.includes('retry.nextRunAt') && readFileSync(join(root, 'packages/local-agent/src/scheduler/cadence.ts'), 'utf8').includes('RETRY_BACKOFF_MS.length'), 'agendador executa retentativas de 5, 15 e 60 minutos antes de falhar');
check(appJs.includes('data-act=\"schedule-create\"') && appJs.includes('data-act=\"schedule-toggle\"') && appJs.includes('data-act=\"schedule-runs\"'), 'painel permite criar, pausar e consultar agendamentos');
check(pkg.scripts?.['smoke:local'] === 'node --experimental-strip-types scripts/smoke-local-features.mjs' && existsSync(join(root, 'scripts/smoke-local-features.mjs')), 'smoke test local sem dependências npm disponível');
const requirementsDoc = readFileSync(join(root, 'docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md'), 'utf8');
const matrixStart = requirementsDoc.indexOf('## Classificação individual dos 365 requisitos');
const matrixEnd = requirementsDoc.indexOf('\n## Rodada ', matrixStart + 1);
const matrixText = matrixStart >= 0 ? requirementsDoc.slice(matrixStart, matrixEnd >= 0 ? matrixEnd : requirementsDoc.length) : '';
const matrixRows = matrixText.split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|/.test(line));
const matrixIds = matrixRows.map((line) => Number(line.split('|')[1].trim()));
const matrixStatuses = matrixRows.map((line) => line.split('|')[4]?.trim() ?? '');
check(matrixRows.length === 365 && new Set(matrixIds).size === 365 && matrixIds.every((id) => id >= 1 && id <= 365), 'matriz mantém 365 IDs únicos sem lacunas');
const summary = readJson('AUDITORIA-365-RESUMO.json');
const observedStates = Object.fromEntries([...new Set(matrixStatuses)].map((status) =>
  [status, matrixStatuses.filter((value) => value === status).length]));
check(summary.specification_items === matrixRows.length &&
  Object.keys(observedStates).length === Object.keys(summary.raw_states).length &&
  Object.entries(observedStates).every(([status, total]) => summary.raw_states[status] === total),
  'classificação do resumo corresponde à matriz');
const pdfImporter = readFileSync(join(root, 'packages/local-agent/src/importers/pdf.ts'), 'utf8');
check(pdfImporter.includes('spawnSync(executable') && pdfImporter.includes('timeout: 7_000') && pdfImporter.includes('maxBuffer: 2 * 1024 * 1024'), 'PDF usa Poppler opcional sem shell e com limite de tempo/memória');
check(Object.hasOwn(contracts, 'report.schedule.run.get') && readFileSync(join(root, 'packages/shared/src/types/contracts.ts'), 'utf8').includes("'report.schedule.run.get'"), 'consulta/download de execução de relatório declarado no contrato IPC');
const scheduleMethods = ['analysis.schedule.create','analysis.schedule.list','analysis.schedule.setEnabled','analysis.schedule.runs','report.schedule.create','report.schedule.list','report.schedule.setEnabled','report.schedule.runs','report.schedule.run.get'];
const ipcMethods = readFileSync(join(root, 'packages/shared/src/types/contracts.ts'), 'utf8');
for (const method of scheduleMethods) {
  check(registered.has(method) && permissionKeys.has(method) && ipcMethods.includes(`'${method}'`) && Object.hasOwn(contracts, method), `ciclo de vida de agendamento declarado, registrado e protegido: ${method}`);
}
check(serviceTs.includes("this.register('report.schedule.run.get'") && serviceTs.includes("'report.schedule.run.get': 'view_reports'"), 'consulta de arquivo de relatório registrada e protegida por view_reports');
check(appJs.includes("api('report.schedule.run.get', { runId: d.id })") && appJs.includes('data-act="schedule-run-download"') && actionKeys.has('schedule-run-download'), 'download do relatório agendado obtém o JSON sob demanda');
check(appJs.includes("r.status === 'COMPLETED' ? `<button class=\"btn tiny\" data-act=\"schedule-run-download\"") && !appJs.includes('r.report_json ?'), 'histórico mostra download pelo status sem depender do JSON omitido da listagem');
check(serviceTs.includes('progress: { ...progress, finished, total: items.length') && serviceTs.includes('pending: items.filter') && appJs.includes('data-act="task-refresh"') && actionKeys.has('task-refresh'), 'fila expõe contagem de progresso e atualização manual');
check(appJs.includes("card('Controles da fila'") && appJs.includes("card('Fila de tarefas', table(['Status / progresso'"), 'painel separa controle da fila da tabela de tarefas');
const syncMethods = ['sync.schedule.create','sync.schedule.list','sync.schedule.setEnabled','sync.schedule.runs','sync.claimScheduled','sync.retryFailed','sync.accountProgress','sync.claimAccount'];
for (const method of syncMethods) check(registered.has(method) && permissionKeys.has(method) && ipcMethods.includes(`'${method}'`) && Object.hasOwn(contracts, method), `agendamento de coleta declarado, registrado e protegido: ${method}`);
const extensionPanel = readFileSync(join(root, 'packages/extension/panel/panel.js'), 'utf8');
const extensionHtml = readFileSync(join(root, 'packages/extension/panel/panel.html'), 'utf8');
check(serviceTs.includes('FROM sync_schedules s WHERE s.enabled=1 AND s.next_run_at<=?') && serviceTs.includes("r.status IN ('QUEUED','RUNNING')"), 'serviço cria no máximo um lote pendente por agenda de coleta');
check(extensionHtml.includes('id="sync-schedule-add"') && extensionHtml.includes('id="sync-cadence"') && extensionHtml.includes('id="sync-schedules"'), 'painel da extensão oferece cadastro e listagem de coletas agendadas');
check(extensionPanel.includes("call('sync.schedule.create'") && extensionPanel.includes("call('sync.schedule.setEnabled'") && extensionPanel.includes("call('sync.schedule.runs'"), 'painel da extensão cria, pausa e consulta histórico de coletas');
check(serviceTs.includes("this.register('sync.retryFailed'") && serviceTs.includes("ba.status IN ('FAILED','PARTIAL','SKIPPED')") && extensionPanel.includes("call('sync.retryFailed'"), 'repetição de coleta cria lote auditável apenas para contas falhas elegíveis');
const userPanel = readFileSync(join(root, 'packages/extension/panel/panel.js'), 'utf8');
check(serviceTs.includes("this.register('user.list'") && serviceTs.includes("this.register('user.upsert'") && serviceTs.includes("this.register('user.setActive'"), 'serviço implementa listagem, criação/edição e ativação de usuários');
check(userPanel.includes("call('user.list'") && userPanel.includes("call('user.upsert'") && userPanel.includes("call('user.setActive'") && extensionHtml.includes('id="user-admin"'), 'painel administrativo expõe gestão de usuários e papéis');
check(userPanel.includes("currentRole !== 'super_admin'") && serviceTs.includes('não é permitido desativar a própria sessão') && serviceTs.includes('último super_admin ativo'), 'gestão de usuários é restrita e protege a própria sessão/último administrador');
for (const method of ['user.list','user.upsert','user.setActive']) check(Object.hasOwn(contracts, method) && permissionKeys.has(method) && ipcMethods.includes(`'${method}'`), `administração de usuários declarada no IPC e protegida: ${method}`);
check(extensionHtml.includes('id="sync-recent-batches"') && extensionPanel.includes("call('sync.list', { limit: 30 })") && extensionPanel.includes('data-sync-retry-batch'), 'painel lista lotes recentes e permite repetir falhas de coletas manuais ou agendadas');
check(extensionHtml.includes('value="ACCOUNT"') && extensionHtml.includes('id="sync-account"') && extensionPanel.includes("call('account.list'"), 'painel permite agendar e sincronizar uma conta ativa específica');
check(workerJs.includes('MI_SYNC_PROGRESS') && workerJs.includes('notifyProgress({ current: outcomes.length') && extensionPanel.includes('chrome.runtime.onMessage.addListener') && extensionPanel.includes('MI_SYNC_PROGRESS'), 'progresso da coleta é atualizado no painel por conta durante a execução');
check(workerJs.includes("chrome.alarms.create('mi.sync'") && workerJs.includes("if (alarm.name === 'mi.sync') void processScheduledSyncs()") && workerJs.includes("callService('sync.claimScheduled'"), 'alarme periódico da extensão reivindica coletas agendadas');
check(serviceTs.includes('30 * 60_000') && serviceTs.includes('started_at<=?') && serviceTs.includes('recoveredStaleLease: true'), 'lote agendado pode recuperar lease órfão após 30 minutos sem repetir contas terminais');
check(serviceTs.includes('reconciled: true') && serviceTs.includes('UPDATE sync_schedule_runs SET status=?,finished_at=COALESCE'), 'claim reconcilia lote já finalizado se o worker cair entre gravações');
check(workerJs.includes('syncAllOpenSellerTabs(batchId, 50)') && workerJs.includes('nenhuma sessão foi trocada'), 'coleta agendada reusa correspondência exata de contas e abas abertas');
const syncProgressMigration = readFileSync(join(root, 'packages/local-agent/migrations/017_sync_page_progress.sql'), 'utf8');
check(syncProgressMigration.includes('sync_batch_page_runs') && syncProgressMigration.includes('progress_json') && syncProgressMigration.includes('current_page_no'), 'migration de progresso guarda páginas, cursor atual e estado de retomada');
check(registered.has('sync.accountProgress') && permissionKeys.has('sync.accountProgress') && ipcMethods.includes("'sync.accountProgress'") && Object.hasOwn(contracts, 'sync.accountProgress'), 'API de progresso por página está declarada, registrada e protegida');
check(serviceTs.includes('URL de progresso fora do domínio autorizado') && serviceTs.includes('sync_batch_page_runs') && serviceTs.includes('seenUrls') && serviceTs.includes('pendingLinks'), 'serviço valida host, persiste histórico e fila de navegação para retomada');
check(serviceTs.includes("url.username = ''; url.password = ''; url.hash = ''") && serviceTs.includes('safe.append(key, value.slice(0, 80))') && serviceTs.includes('page.page === index + 1'), 'progresso remove credenciais/hash, restringe parâmetros e valida sequência de páginas');
check(workerJs.includes('resumeState,') && workerJs.includes('options.resumeState') && workerJs.includes('saved.pendingLinks') && workerJs.includes('saved.seenUrls'), 'worker retoma páginas concluídas e links pendentes do estado persistido');
check(workerJs.includes("callService('sync.accountProgress'") && workerJs.includes("phase: 'PAGE'") && workerJs.includes('progress.pagesScanned'), 'worker persiste progresso após cada página e emite evento em tempo real');
check(workerJs.includes('Number(scan.pendingPages ?? 0) === 0') && workerJs.includes('pendingPages: queue.length'), 'lote com links pendentes termina como PARTIAL e mantém retomada em vez de falso COMPLETED');
check(extensionPanel.includes('message.currentPage') && extensionPanel.includes('MI_SYNC_PROGRESS'), 'painel exibe página atual e progresso por conta em tempo real');
check(syncProgressMigration.includes('UNIQUE(batch_id,account_id,page_no)') && serviceTs.includes('ON CONFLICT(batch_id,account_id,page_no) DO UPDATE'), 'retomada evita duplicar registros de página no mesmo lote e conta');
check(syncProgressMigration.includes("'COMPLETED','FAILED','QUEUED'") && serviceTs.includes("page.queued ? 'QUEUED' : 'FAILED'") && workerJs.includes('captured.ok || (captured.queued && !options.logicalBatchId)'), 'página falha permanece pendente e página aceita na fila local não é recapturada indevidamente');

const ignoredDirectories = new Set(['node_modules', '.git', 'dist']);
let jsonCount = 0;
const inspectJson = (directory) => {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) inspectJson(relative);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      jsonCount += 1;
      try { JSON.parse(readFileSync(join(root, relative), 'utf8')); check(true, `JSON válido: ${relative}`); }
      catch (error) { check(false, `JSON válido: ${relative} (${error instanceof Error ? error.message : String(error)})`); }
    }
  }
};
inspectJson('.');
check(jsonCount > 0, 'arquivos JSON encontrados para validação');
const failed = checks.filter((item) => !item.ok);
console.log(`Auditoria estática: ${checks.length - failed.length}/${checks.length} verificações aprovadas.`);
for (const item of failed) console.error(`FALHOU: ${item.label}`);
if (failures.length) process.exitCode = 1;
else console.log('OK: sem inconsistências estáticas detectadas.');
