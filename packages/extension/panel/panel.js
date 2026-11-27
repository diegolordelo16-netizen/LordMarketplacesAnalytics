/**
 * Painel lateral (§31): captura sob demanda e estado do serviço local.
 * Nenhuma decisão automática acontece aqui; o painel só mostra e pede.
 */
const $ = (id) => document.getElementById(id);

const MP_LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', tiktok_shop: 'TikTok Shop' };
let currentRole = null;

const KIND_LABEL = {
  listing_public: 'anúncio público',
  listing_list: 'lista de anúncios',
  orders: 'pedidos',
  metrics: 'métricas',
  questions: 'perguntas',
  reputation: 'reputação',
  ads: 'anúncios pagos',
  unknown: 'não reconhecida',
};

function call(method, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'MI_CALL', method, payload }, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
      else resolve(response ?? { ok: false, error: { message: 'sem resposta' } });
    });
  });
}

/**
 * Estado dos serviços, um por linha.
 *
 * `ok` = verde (funciona), `warn` = amarelo (respondeu, mas recusou),
 * `bad` = vermelho (fora do ar), `idle` = cinza (ainda não testado).
 */
const DOT = { ok: 'dot ok', warn: 'dot warn', bad: 'dot bad', idle: 'dot idle' };

function mark(service, state, note) {
  const dot = $(`dot-${service}`);
  if (dot) dot.className = DOT[state] ?? DOT.idle;
  const label = $(`note-${service}`);
  if (label) label.textContent = note ?? '—';
}

function setStatus(ok, level, text) {
  const state = level ?? (ok ? 'ok' : 'bad');
  const dot = $('status-dot');
  if (dot) dot.className = DOT[state] ?? DOT.idle;
  const el = $('service-state');
  if (el) {
    el.className = `state ${state}`;
    el.textContent = text ?? (ok ? 'conectado ao serviço local' : 'serviço local indisponível');
  }
}

/**
 * Estado do serviço com diagnóstico.
 *
 * O `ping` do serviço é público (não prova que o token vale), então a chamada
 * autenticada é que decide o estado — e, quando falha, o diagnóstico da
 * extensão diz qual caminho quebrou (host nativo, porta ou token).
 */
let lastDiagnosis = null;

/**
 * Chamada autenticada de verdade. O `ping` do serviço é público: ele responde
 * mesmo com token errado, então não serve para provar a conexão — e era por
 * isso que o cartão dizia «serviço local indisponível» com o serviço no ar.
 */
async function ping() {
  mark('worker', 'ok', 'ativo');
  // O token que a extensão tem, para mandar no payload: `auth.session` valida
  // payload.token, e sem ele o serviço devolve 400 (era esta a falha real).
  const current = await call('manual.get');
  const token = current?.result?.token ?? '';
  mark('token', token ? 'ok' : 'bad', token ? 'guardado' : 'sem token');

  const res = await call('auth.session', { token });
  if (res?.ok === true) {
    currentRole = res.result?.role ?? null;
    const admin = $('user-admin');
    if (admin) {
      admin.hidden = currentRole !== 'super_admin';
      if (currentRole === 'super_admin') void loadUsers();
    }
    mark('http', 'ok', 'autenticado');
    mark('native', 'ok', 'respondendo');
    setStatus(true, 'ok', 'conectado ao serviço local');
    return true;
  }
  currentRole = null;
  if ($('user-admin')) $('user-admin').hidden = true;

  // Diagnóstico: separa «fora do ar» de «respondeu mas recusou».
  const diag = (await call('mi.diagnose'))?.result ?? null;
  lastDiagnosis = diag;
  if (diag) {
    mark('http', diag.http?.ok ? 'ok' : 'bad', diag.http?.ok ? `porta ${diag.http.port}` : diag.http?.error || 'sem resposta');
    mark(
      'native',
      diag.nativeHost?.ok ? 'ok' : 'warn',
      diag.nativeHost?.ok ? 'registrado' : diag.nativeHost?.error || 'sem resposta',
    );
    if (!diag.token) mark('token', 'bad', 'sem token');
  }
  const recusado = Boolean(diag?.http?.ok); // serviço no ar, credencial não passou
  setStatus(false, recusado ? 'warn' : 'bad', res?.error?.message ?? 'serviço local indisponível');
  const detail = $('service-detail');
  if (detail) detail.textContent = res?.error?.message ?? '';
  return false;
}

async function capture() {
  const button = $('capture');
  button.disabled = true;
  button.textContent = 'Capturando…';
  const res = await call('capture.activeTab');
  button.disabled = false;
  button.textContent = 'Capturar esta página';

  const hint = $('hint');
  if (!res?.snapshot) {
    hint.textContent = res?.error ?? 'não foi possível capturar esta página';
    return;
  }

  const s = res.snapshot;
  $('mp').textContent = MP_LABEL[s.marketplace] ?? s.marketplace;
  $('kind').textContent = KIND_LABEL[s.pageKind] ?? s.pageKind;
  const read = Object.keys(s.evidence ?? {}).filter((k) => k !== 'missing');
  $('fields').textContent = read.length ? read.join(', ') : 'nada visível';
  $('missing').textContent = (s.missing ?? []).length ? s.missing.join(', ') : '—';

  hint.textContent = res.ok
    ? 'Captura enviada ao serviço local.'
    : res.queued
      ? 'Serviço fora do ar: captura guardada na fila local e será enviada depois.'
      : `Falha: ${res.error ?? 'desconhecida'}`;
}

async function capturePages() {
  const button = $('capture-pages');
  button.disabled = true;
  button.textContent = 'Coletando páginas…';
  const hint = $('hint');
  hint.textContent = 'A coleta usa uma aba temporária, controles reconhecidos de paginação e rolagem de tabelas indexadas. Ela para em CAPTCHA/login e nunca publica alterações.';
  const res = await call('capture.scanListingPages', { maxPages: 5 });
  button.disabled = false;
  button.textContent = 'Coletar até 5 páginas de anúncios';
  if (!res?.ok || !res.result) {
    hint.textContent = `Falha na coleta paginada: ${res?.error?.message ?? 'resposta inválida'}`;
    return;
  }
  const r = res.result;
  hint.textContent = `${r.complete?'Fim reconhecido':'Coleta parcial'} · ${r.pagesSucceeded}/${r.pagesScanned} páginas capturadas · ${r.totalListings} anúncios encontrados. Parada: ${r.stoppedReason}`;
}

async function captureAreas() {
  if (!window.confirm('Iniciar leitura das áreas do vendedor que estiverem ligadas por links visíveis? A varredura permanece no mesmo domínio, limita-se inicialmente a 50 páginas, com retomada pelo histórico do lote e para em login/CAPTCHA. Nenhuma alteração será publicada.')) return;
  const button = $('capture-areas');
  button.disabled = true;
  button.textContent = 'Varrendo áreas…';
  const hint = $('hint');
  hint.textContent = 'Lendo somente links visíveis e páginas autorizadas do mesmo marketplace. A operação para em qualquer tela de login ou verificação.';
  try {
    const res = await call('capture.scanAuthorizedAreas', { maxPages: 50 });
    if (!res?.ok || !res.result) {
      hint.textContent = `Falha na varredura: ${res?.error?.message ?? 'resposta inválida'}`;
      return;
    }
    const r = res.result;
    hint.textContent = `${r.pagesSucceeded}/${r.pagesScanned} páginas lidas · ${r.pagesQueued} em fila · áreas: ${(r.areas ?? []).join(', ') || '—'}. Parada: ${r.stoppedReason}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Varredura de áreas autorizadas';
  }
}

async function flush() {
  const res = await call('queue.flush');
  const hint = $('hint');
  if (res?.ok) hint.textContent = `Fila: ${res.result.sent} enviado(s), ${res.result.left} restante(s).`;
  else hint.textContent = `Fila indisponível: ${res?.error?.message ?? 'erro'}`;
}


async function syncAllAccounts() {
  const button = $('sync-all');
  const out = $('sync-out');
  button.disabled = true;
  button.textContent = 'Preparando sincronização…';
  try {
    const scope = $('sync-scope').value;
    const createPayload = { scope };
    if (scope === 'ACCOUNT') {
      createPayload.accountId = $('sync-account').value;
      if (!createPayload.accountId) { out.textContent = 'Selecione uma conta ativa para sincronizar.'; return; }
    }
    const created = await call('sync.createAll', { ...createPayload, browserRequest:true });
    if (!created?.ok || !created.result?.batchId) {
      out.textContent = `Não foi possível criar o lote: ${created?.error?.message ?? 'resposta inválida'}`;
      return;
    }
    const { batchId, accounts } = created.result;
    button.textContent = 'Lendo abas de vendedor…';
    const scanned = await call('capture.syncAllOpenTabs', { batchId, maxPages: 50 });
    if (!scanned?.ok || !scanned.result) {
      out.textContent = `Lote ${batchId}: criado, mas a extensão não concluiu a varredura: ${scanned?.error?.message ?? 'sem resultado'}`;
      return;
    }
    const outcomes = scanned.result.outcomes ?? [];
    const completed = outcomes.filter((item) => item.status === 'COMPLETED').length;
    const partial = outcomes.filter((item) => item.status === 'PARTIAL').length;
    const skipped = outcomes.filter((item) => item.status === 'SKIPPED').length;
    const failed = outcomes.filter((item) => item.status === 'FAILED').length;
    out.textContent = `Lote ${batchId} · ${accounts?.length ?? outcomes.length} conta(s): ${completed} completa(s), ${partial} parcial(is), ${skipped} ignorada(s), ${failed} falha(s). Nenhuma sessão foi alternada.`;
    await loadRecentSyncBatches();
  } finally {
    button.disabled = false;
    button.textContent = 'Sincronizar contas em abas abertas';
  }
}

function syncScheduleLabel(schedule) {
  const scope = schedule.scope === 'ALL_ENABLED_MARKETPLACES' ? 'Marketplaces habilitados'
    : schedule.scope === 'ACCOUNT' ? `Conta ${schedule.account_id}` : 'Todas as contas ativas';
  const cadence = schedule.cadence_label === 'custom' ? `a cada ${schedule.interval_minutes} min`
    : ({ '1h': 'por hora', '6h': 'a cada 6 horas', daily: 'diariamente', weekly: 'semanalmente' }[schedule.cadence] || schedule.cadence);
  return `${scope} · ${cadence} · ${schedule.enabled ? 'ativo' : 'pausado'} · próxima: ${schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString('pt-BR') : '—'}${schedule.last_status ? ` · última: ${schedule.last_status}` : ''}`;
}

async function loadSyncSchedules() {
  const target = $('sync-schedules');
  if (!target) return;
  const response = await call('sync.schedule.list', {});
  if (!response?.ok) { target.textContent = `Não foi possível carregar agendamentos: ${response?.error?.message ?? 'serviço indisponível'}`; return; }
  const schedules = response.result ?? [];
  target.replaceChildren();
  if (!schedules.length) { target.textContent = 'Nenhuma coleta recorrente configurada.'; return; }
  for (const schedule of schedules) {
    const row = document.createElement('div'); row.className = 'sync-schedule-row';
    const description = document.createElement('span'); description.textContent = syncScheduleLabel(schedule); row.append(description);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'tiny';
    toggle.textContent = schedule.enabled ? 'Pausar' : 'Ativar'; toggle.dataset.syncAction = 'toggle';
    toggle.dataset.id = schedule.id; toggle.dataset.enabled = schedule.enabled ? '1' : '0'; row.append(toggle);
    const history = document.createElement('button'); history.type = 'button'; history.className = 'tiny';
    history.textContent = 'Histórico'; history.dataset.syncAction = 'history'; history.dataset.id = schedule.id; row.append(history);
    target.append(row);
  }
}

async function showSyncScheduleHistory(scheduleId) {
  const target = $('sync-schedule-history');
  if (!target) return;
  const response = await call('sync.schedule.runs', { scheduleId, limit: 30 });
  if (!response?.ok) { target.textContent = `Histórico indisponível: ${response?.error?.message ?? 'erro'}`; return; }
  const runs = response.result ?? [];
  target.replaceChildren();
  const heading = document.createElement('strong'); heading.textContent = 'Histórico de coletas'; target.append(heading);
  if (!runs.length) { const empty = document.createElement('p'); empty.textContent = 'Nenhuma coleta executada.'; target.append(empty); return; }
  for (const run of runs) {
    const line = document.createElement('p');
    let details = '{}'; try { details = JSON.stringify(JSON.parse(run.summary_json || '{}')); } catch { details = 'resumo inválido'; }
    line.textContent = `${new Date(run.scheduled_at).toLocaleString('pt-BR')} · ${run.status} · ${details}${run.error ? ` · ${run.error}` : ''}`;
    target.append(line);
    if (run.batch_id && ['FAILED','PARTIAL'].includes(run.status)) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tiny';
      retry.textContent = 'Repetir contas com falha'; retry.dataset.syncRetryBatch = run.batch_id; retry.dataset.scheduleId = scheduleId;
      target.append(retry);
    }
  }
}

async function createSyncSchedule() {
  const cadence = $('sync-cadence').value;
  const payload = { scope: $('sync-scope').value, cadence };
  if (payload.scope === 'ACCOUNT') {
    payload.accountId = $('sync-account').value;
    if (!payload.accountId) { $('sync-out').textContent = 'Selecione uma conta ativa para agendar.'; return; }
  }
  if (cadence === 'custom') {
    const intervalMinutes = Number($('sync-interval').value);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 43200) {
      $('sync-out').textContent = 'Intervalo precisa ser um número inteiro entre 15 e 43200 minutos.'; return;
    }
    payload.intervalMinutes = intervalMinutes;
  }
  const button = $('sync-schedule-add'); button.disabled = true;
  try {
    const response = await call('sync.schedule.create', payload);
    if (!response?.ok) { $('sync-out').textContent = `Falha ao agendar coleta: ${response?.error?.message ?? 'erro'}`; return; }
    $('sync-out').textContent = `Coleta agendada. Próxima execução: ${new Date(response.result.nextRunAt).toLocaleString('pt-BR')}. Requer navegador aberto e abas de vendedor autenticadas.`;
    await loadSyncSchedules();
  } finally { button.disabled = false; }
}

async function toggleSyncSchedule(button) {
  const enabled = button.dataset.enabled !== '1';
  const response = await call('sync.schedule.setEnabled', { id: button.dataset.id, enabled });
  $('sync-out').textContent = response?.ok ? (enabled ? 'Agendamento ativado.' : 'Agendamento pausado.') : `Falha ao alterar agendamento: ${response?.error?.message ?? 'erro'}`;
  await loadSyncSchedules();
}

async function loadRecentSyncBatches() {
  const target = $('sync-recent-batches'); if (!target) return;
  const response = await call('sync.list', { limit: 30 });
  if (!response?.ok) { target.textContent = `Lotes indisponíveis: ${response?.error?.message ?? 'serviço fora do ar'}`; return; }
  const batches = response.result ?? []; target.replaceChildren();
  if (!batches.length) { target.textContent = 'Nenhum lote de sincronização registrado.'; return; }
  for (const batch of batches) {
    const line = document.createElement('div'); line.className = 'sync-schedule-row';
    const detail = document.createElement('span');
    detail.textContent = `${new Date(batch.requested_at).toLocaleString('pt-BR')} · ${batch.scope} · ${batch.status} · ${batch.id.slice(0, 8)}`;
    line.append(detail);
    if (['PARTIAL','FAILED'].includes(batch.status)) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tiny';
      retry.textContent = 'Repetir falhas'; retry.dataset.syncRetryBatch = batch.id;
      line.append(retry);
    }
    target.append(line);
  }
}

function userAdminMessage(message) {
  const out = $('user-admin-out'); if (out) out.textContent = message;
}

async function loadUsers() {
  if (currentRole !== 'super_admin') return;
  const target = $('user-list'); if (!target) return;
  const response = await call('user.list', {});
  if (!response?.ok) { target.textContent = `Não foi possível listar usuários: ${response?.error?.message ?? 'erro'}`; return; }
  target.replaceChildren();
  const users = response.result ?? [];
  if (!users.length) { target.textContent = 'Nenhum usuário cadastrado.'; return; }
  for (const user of users) {
    const row = document.createElement('div'); row.className = 'user-row'; row.dataset.userId = user.id;
    row.dataset.userEmail = user.email; row.dataset.userDisplayName = user.display_name;
    const summary = document.createElement('span'); summary.className = 'user-summary';
    summary.textContent = `${user.display_name} · ${user.email} · ${user.is_active ? 'ativo' : 'inativo'}`;
    const role = document.createElement('select'); role.className = 'user-role'; role.setAttribute('aria-label', `Papel de ${user.email}`);
    for (const [value,label] of [['super_admin','Super admin'],['operador','Operador'],['visualizador','Visualizador']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; role.append(option);
    }
    role.value = user.role; role.dataset.originalRole = user.role;
    const save = document.createElement('button'); save.type = 'button'; save.className = 'tiny'; save.dataset.userAction = 'role'; save.textContent = 'Salvar papel';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'tiny'; toggle.dataset.userAction = 'active';
    toggle.dataset.active = user.is_active ? '1' : '0'; toggle.textContent = user.is_active ? 'Desativar' : 'Ativar';
    row.append(summary, role, save, toggle); target.append(row);
  }
}

async function createUser() {
  const payload = {
    displayName: $('new-user-name').value.trim(),
    email: $('new-user-email').value.trim(),
    role: $('new-user-role').value,
    password: $('new-user-password').value,
  };
  if (!payload.displayName || !payload.email || payload.password.length < 10) {
    userAdminMessage('Informe nome, e-mail válido e senha inicial com pelo menos 10 caracteres.'); return;
  }
  const button = $('user-create'); button.disabled = true;
  try {
    const response = await call('user.upsert', payload);
    if (!response?.ok) { userAdminMessage(`Falha ao criar usuário: ${response?.error?.message ?? 'erro'}`); return; }
    $('new-user-name').value = ''; $('new-user-email').value = ''; $('new-user-password').value = '';
    userAdminMessage('Usuário criado. A nova conta recebe somente o papel selecionado.');
    await loadUsers();
  } finally { button.disabled = false; }
}

async function updateUserRole(row) {
  const userId = row.dataset.userId; const role = row.querySelector('.user-role');
  if (!userId || !role) return;
  const response = await call('user.upsert', { id: userId, email: row.dataset.userEmail, displayName: row.dataset.userDisplayName, role: role.value });
  userAdminMessage(response?.ok ? `Papel atualizado para ${role.value}.` : `Não foi possível atualizar: ${response?.error?.message ?? 'erro'}`);
  await ping();
  if (currentRole === 'super_admin') await loadUsers();
}

async function toggleUserActive(row, button) {
  const userId = row.dataset.userId; const enabled = button.dataset.active !== '1';
  const response = await call('user.setActive', { userId, isActive: enabled });
  userAdminMessage(response?.ok ? `Usuário ${enabled ? 'ativado' : 'desativado'}. Sessões do usuário desativado são revogadas.` : `Não foi possível alterar usuário: ${response?.error?.message ?? 'erro'}`);
  await loadUsers();
}

async function loadSyncAccounts() {
  const select = $('sync-account'); if (!select) return;
  const response = await call('account.list', {});
  select.replaceChildren();
  if (!response?.ok) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Contas indisponíveis'; select.append(option); return; }
  const active = (response.result ?? []).filter((account) => account.is_active);
  if (!active.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Nenhuma conta ativa cadastrada'; select.append(option); return; }
  for (const account of active) {
    const option = document.createElement('option'); option.value = account.id;
    option.textContent = `${MP_LABEL[account.marketplace] || account.marketplace} · ${account.display_name}`; select.append(option);
  }
}

async function retryFailedSync(batchId, scheduleId, button) {
  button.disabled = true; button.textContent = 'Preparando repetição…';
  try {
    const created = await call('sync.retryFailed', { batchId, browserRequest:true });
    if (!created?.ok || !created.result?.batchId) { $('sync-out').textContent = `Não foi possível repetir: ${created?.error?.message ?? 'erro'}`; return; }
    const scanned = await call('capture.syncAllOpenTabs', { batchId: created.result.batchId, maxPages: 50 });
    if (!scanned?.ok || !scanned.result) { $('sync-out').textContent = `Novo lote ${created.result.batchId} criado; a extensão não concluiu a coleta: ${scanned?.error?.message ?? 'erro'}`; return; }
    const outcomes = scanned.result.outcomes ?? [];
    const completed = outcomes.filter((item) => item.status === 'COMPLETED').length;
    const partial = outcomes.filter((item) => item.status === 'PARTIAL').length;
    const skipped = outcomes.filter((item) => item.status === 'SKIPPED').length;
    const failed = outcomes.filter((item) => item.status === 'FAILED').length;
    $('sync-out').textContent = `Repetição do lote ${batchId} · ${completed} completa(s), ${partial} parcial(is), ${skipped} ignorada(s), ${failed} falha(s). Nenhuma sessão foi alternada.`;
    await loadRecentSyncBatches();
    if (scheduleId) await showSyncScheduleHistory(scheduleId);
  } finally { button.disabled = false; button.textContent = 'Repetir contas com falha'; }
}

async function loadOperationMode() {
  const res = await call('operation.mode.get', {});
  if (res?.ok && res.result?.mode) $('operation-mode').value = res.result.mode;
}

async function saveOperationMode() {
  const out = $('operation-out');
  const res = await call('operation.mode.set', { mode: $('operation-mode').value });
  if (!res?.ok) {
    out.textContent = `Falha ao salvar modo: ${res?.error?.message ?? 'sem resposta'}`;
    return;
  }
  out.textContent = `Modo ${res.result.mode} salvo. Publicação: desativada; alterações de campanhas: desativadas; aprovação humana: obrigatória.`;
}

async function createAnalysisSchedule() {
  const out = $('operation-out');
  const res = await call('analysis.schedule.create', { mode: '360', days: 30, cadence: $('schedule-cadence').value });
  out.textContent = res?.ok ? `Análise 360 agendada (${res.result.nextRunAt}).` : `Falha no agendamento: ${res?.error?.message ?? 'sem resposta'}`;
}

async function createReportSchedule() {
  const out = $('operation-out');
  const res = await call('report.schedule.create', { reportType: 'EXECUTIVO', format: 'json', cadence: $('schedule-cadence').value });
  out.textContent = res?.ok ? `Relatório executivo agendado (${res.result.nextRunAt}).` : `Falha no agendamento: ${res?.error?.message ?? 'sem resposta'}`;
}

/**
 * Conexão manual: grava a porta e o token no storage da extensão, do mesmo jeito
 * que a tela de Pré-Start faria sozinha. Serve quando a descoberta falha.
 */
async function saveManual() {
  const out = $('manual-out');
  const port = Number($('manual-port').value.trim());
  const token = $('manual-token').value.trim();
  if (!port || port < 1 || port > 65535) {
    out.textContent = 'Porta inválida: informe um número entre 1 e 65535.';
    return;
  }
  if (token.length < 8) {
    out.textContent = 'Token muito curto: copie o valor inteiro da tela de Pré-Start.';
    return;
  }
  const portRes = await call('port.set', { port });
  const tokenRes = await call('session.set', { token });
  if (!portRes?.ok || !tokenRes?.ok) {
    // A etapa que falhou fica visível: era tudo «porta inválida» antes.
    out.textContent = `Falha ao guardar — porta: ${portRes?.ok ? 'ok' : portRes?.error?.message ?? 'sem resposta'} · token: ${
      tokenRes?.ok ? 'ok' : tokenRes?.error?.message ?? 'sem resposta'
    }`;
    return;
  }
  out.textContent = `Credenciais guardadas (porta ${port}). Testando…`;
  const ok = await ping();
  out.textContent = ok
    ? `Conectado ao serviço local na porta ${port}.`
    : 'Credenciais guardadas, mas o serviço ainda não autenticou. Confira a porta e o token.';
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'MI_SYNC_PROGRESS') return;
  const out = $('sync-out'); if (!out) return;
  const current = Number(message.current ?? 0); const total = Number(message.total ?? 0);
  const label = message.marketplace ? `${MP_LABEL[message.marketplace] || message.marketplace} · ` : '';
  out.textContent = `${message.message || 'Coleta em andamento.'} ${total ? `(${current}/${total})` : ''} ${label}${message.pagesScanned !== undefined ? `· páginas ${message.pagesSucceeded ?? 0}/${message.pagesScanned}` : ''}${message.currentPage ? ` · atual ${message.currentPage}` : ''}${message.pendingPages ? ` · pendentes ${message.pendingPages}` : ''}`.trim();
});

let learningSession=null, learningTimer=null, learningBusy=false;
function stopLearning(message='Aprendizado desligado.'){
  learningSession=null;clearInterval(learningTimer);learningTimer=null;
  $('learning-start').disabled=false;$('learning-stop').disabled=true;
  $('learning-status').textContent=message;
}
async function learningTick(){
  const session=learningSession;
  if(!session||learningBusy)return;
  learningBusy=true;
  try{
    const res=await call('learning.context');
    const ctx=res?.result;
    if(learningSession!==session)return;
    if(!res?.ok||!ctx||ctx.tabId!==session.tabId||ctx.accountId!==session.accountId||ctx.origin!==session.origin){stopLearning('Aprendizado pausado: aba, loja ou área mudou.');return;}
    if(ctx.route===session.lastRoute&&ctx.pageKind===session.lastKind&&ctx.spaPage===session.previous?.spaPage&&ctx.filterSignature===session.previous?.filterSignature)return;
    const saved=await call('learning.observe',{...session,route:ctx.route,pageKind:ctx.pageKind,spaPage:ctx.spaPage,filterSignature:ctx.filterSignature,fromRoute:session.lastRoute??undefined,previous:session.previous});
    if(learningSession!==session)return;
    if(!saved?.ok||saved.result?.ok!==true){stopLearning('Aprendizado pausado: '+(saved?.error?.message??'rota não reconhecida'));return;}
    session.lastRoute=ctx.route;session.lastKind=ctx.pageKind;session.previous=ctx;
    $('learning-status').textContent='Página demonstrada: '+ctx.pageKind+'. Continue navegando na mesma aba.';
  }finally{learningBusy=false;}
}
async function learningAction(action){
  if(learningBusy)return;
  if(action==='start'){
    if(learningSession)return;
    if(!window.confirm('Registrar rotas e mudanças de paginação e filtros desta loja enquanto o painel estiver aberto? Os valores dos filtros não serão armazenados.'))return;
  }
  if(action==='clear'&&!window.confirm('Apagar a memória de navegação desta loja e origem?'))return;
  if(action!=='start'&&learningSession)stopLearning();
  const res=await call('learning.context'),ctx=res?.result;
  if(!res?.ok||!ctx){$('learning-status').textContent=res?.error?.message??'Abra uma área de vendedor reconhecida.';return;}
  if(action==='start'){
    learningSession={tabId:ctx.tabId,accountId:ctx.accountId,origin:ctx.origin,lastRoute:null,lastKind:null};
    $('learning-start').disabled=true;$('learning-stop').disabled=false;
    $('learning-status').textContent='Aprendizado ativo.';
    learningTimer=setInterval(()=>void learningTick(),2500);
    await learningTick();return;
  }
  const payload={tabId:ctx.tabId,accountId:ctx.accountId,origin:ctx.origin,route:ctx.route,pageKind:ctx.pageKind};
  const out=await call('learning.'+action,payload);
  if(!out?.ok){$('learning-status').textContent=out?.error?.message??'Operação recusada.';return;}
  if(action==='list'){
    const list=$('learning-routes');list.replaceChildren();
    for(const route of Array.isArray(out.result)?out.result:[]){
      const li=document.createElement('li');li.textContent=route.page_kind+' · '+route.route+' · '+route.observations+' demonstração(ões)';list.appendChild(li);
    }
    $('learning-status').textContent=list.children.length+' rotas conhecidas nesta loja.';
  }else{
    $('learning-routes').replaceChildren();
    $('learning-status').textContent=action==='clear'?'Memória apagada.':'Página demonstrada e salva.';
  }
}
let listingOperationBusy=false;
async function listingOperationApply(){
  if(listingOperationBusy)return;
  const proposalId=$('listing-op-proposal').value.trim(),externalListingId=$('listing-op-external').value.trim(),action=$('listing-op-action').value,variationId=$('listing-op-variation').value.trim(),out=$('listing-op-out');
  if(!proposalId||!externalListingId||(action==='EDIT_VARIATION'&&!variationId)||(action!=='EDIT_VARIATION'&&variationId)){out.textContent='Informe proposta, anúncio e ID de variação somente para edição.';return;}
  if(!window.confirm('Solicitar uma execução única da proposta aprovada? Confira a loja, o anúncio e os dados do formulário.'+' A extensão tentará conferir o resultado em uma nova aba.'))return;
  listingOperationBusy=true;$('listing-op-apply').disabled=true;
  try{
    const response=await call('listing.browser.apply',{proposalId,externalListingId,action,variationId:variationId||undefined,confirmed:true});
    out.textContent=response?.ok?JSON.stringify(response.result):response?.error?.message||'Operação recusada. Confira antes de repetir.';
  }catch(error){out.textContent=String(error?.message||error)+'; confira antes de qualquer nova proposta.';}
  finally{listingOperationBusy=false;$('listing-op-apply').disabled=false;}
}
let budgetBusy=false;
async function budgetAction(action){
  if(budgetBusy)return;
  const proposalId=$('budget-proposal').value.trim(),campaignRef=$('budget-campaign').value.trim(),out=$('budget-out');
  if(!proposalId||!campaignRef){out.textContent='Informe a proposta e a campanha.';return;}
  if(!window.confirm(action==='apply'?'Solicitar uma execução única da proposta aprovada? A extensão tentará conferir o valor em uma nova aba da mesma página.':'A página foi recarregada e corresponde à mesma campanha?'))return;
  budgetBusy=true;$('budget-apply').disabled=true;$('budget-verify').disabled=true;
  try{
    const response=await call('campaign.browser.'+action,{proposalId,campaignRef,changeKind:$('campaign-setting').value,confirmed:true});
    out.textContent=response?.ok?JSON.stringify(response.result):response?.error?.message||'Operação recusada. Não repetir sem conferir.';
  }catch(error){out.textContent=String(error?.message||error)+'; confira antes de qualquer nova proposta.';}
  finally{budgetBusy=false;$('budget-apply').disabled=false;$('budget-verify').disabled=false;}
}
document.addEventListener('DOMContentLoaded', async () => {
  $('listing-op-apply').addEventListener('click',()=>void listingOperationApply());
  $('budget-apply').addEventListener('click',()=>void budgetAction('apply'));
  $('budget-verify').addEventListener('click',()=>void budgetAction('verify'));
  $('learning-start').addEventListener('click',()=>void learningAction('start'));
  $('learning-stop').addEventListener('click',()=>stopLearning());
  $('learning-observe').addEventListener('click',()=>void learningAction('observe'));
  $('learning-list').addEventListener('click',()=>void learningAction('list'));
  $('learning-clear').addEventListener('click',()=>void learningAction('clear'));
  $('capture').addEventListener('click', () => void capture());
  $('capture-pages').addEventListener('click', () => void capturePages());
  $('capture-areas').addEventListener('click', () => void captureAreas());
  $('flush').addEventListener('click', () => void flush());
  $('sync-all').addEventListener('click', () => void syncAllAccounts());
  $('sync-schedule-add').addEventListener('click', () => void createSyncSchedule());
  $('sync-refresh').addEventListener('click', () => void loadSyncSchedules());
  $('sync-cadence').addEventListener('change', () => $('sync-custom-wrap').toggleAttribute('hidden', $('sync-cadence').value !== 'custom'));
  $('sync-scope').addEventListener('change', async () => {
    const scoped = $('sync-scope').value === 'ACCOUNT';
    $('sync-account-wrap').toggleAttribute('hidden', !scoped);
    if (scoped) await loadSyncAccounts();
  });
  $('sync-schedules').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-sync-action]'); if (!button) return;
    if (button.dataset.syncAction === 'toggle') void toggleSyncSchedule(button);
    if (button.dataset.syncAction === 'history') void showSyncScheduleHistory(button.dataset.id);
  });
  const retryBatchHandler = (event) => {
    const button = event.target.closest('button[data-sync-retry-batch]'); if (!button) return;
    void retryFailedSync(button.dataset.syncRetryBatch, button.dataset.scheduleId, button);
  };
  $('sync-schedule-history').addEventListener('click', retryBatchHandler);
  $('sync-recent-batches').addEventListener('click', retryBatchHandler);
  $('sync-batches-refresh').addEventListener('click', () => void loadRecentSyncBatches());
  $('save-mode').addEventListener('click', () => void saveOperationMode());
  $('schedule-analysis').addEventListener('click', () => void createAnalysisSchedule());
  $('schedule-report').addEventListener('click', () => void createReportSchedule());
  $('ping').addEventListener('click', () => void ping());
  $('manual-save').addEventListener('click', () => void saveManual());
  $('user-create').addEventListener('click', () => void createUser());
  $('user-refresh').addEventListener('click', () => void loadUsers());
  $('user-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-user-action]'); if (!button) return;
    const row = button.closest('.user-row'); if (!row) return;
    if (button.dataset.userAction === 'role') void updateUserRole(row);
    if (button.dataset.userAction === 'active') void toggleUserActive(row, button);
  });
  // Preenche com o que o worker diz estar valendo de fato (não um palpite).
  const current = await call('manual.get');
  if (current?.result?.port) $('manual-port').value = String(current.result.port);
  if (current?.result?.token) $('manual-token').value = current.result.token;
  const version = chrome.runtime.getManifest().version;
  $('version').textContent = `v${version}`;
  await loadOperationMode();
  await ping();
  await loadSyncSchedules();
  await loadSyncAccounts();
  await loadRecentSyncBatches();
});
