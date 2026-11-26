/**
 * Painel lateral (§31): captura sob demanda e estado do serviço local.
 * Nenhuma decisão automática acontece aqui; o painel só mostra e pede.
 */
const $ = (id) => document.getElementById(id);

const MP_LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', tiktok_shop: 'TikTok Shop' };
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
    mark('http', 'ok', 'autenticado');
    mark('native', 'ok', 'respondendo');
    setStatus(true, 'ok', 'conectado ao serviço local');
    return true;
  }

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

async function flush() {
  const res = await call('queue.flush');
  const hint = $('hint');
  if (res?.ok) hint.textContent = `Fila: ${res.result.sent} enviado(s), ${res.result.left} restante(s).`;
  else hint.textContent = `Fila indisponível: ${res?.error?.message ?? 'erro'}`;
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

document.addEventListener('DOMContentLoaded', async () => {
  $('capture').addEventListener('click', () => void capture());
  $('flush').addEventListener('click', () => void flush());
  $('ping').addEventListener('click', () => void ping());
  $('manual-save').addEventListener('click', () => void saveManual());
  // Preenche com o que o worker diz estar valendo de fato (não um palpite).
  const current = await call('manual.get');
  if (current?.result?.port) $('manual-port').value = String(current.result.port);
  if (current?.result?.token) $('manual-token').value = current.result.token;
  const version = chrome.runtime.getManifest().version;
  $('version').textContent = `v${version}`;
  await ping();
});
