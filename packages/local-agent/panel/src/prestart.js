/**
 * Tela de Pré-Start & Diagnóstico.
 *
 * Fala com o serviço local por HTTP (token de sessão na URL, guardado em
 * sessionStorage). Não usa nada da extensão para funcionar: se a extensão não
 * estiver carregada, a tela continua útil e diz exatamente o que falta.
 */
(() => {
  'use strict';

  const state = {
    token: '',
    report: null,
    extensionConnected: false,
    lastPingAt: null,
  };

  const $ = (sel) => document.querySelector(sel);

  function toast(message, kind = 'info') {
    const host = $('#toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function readToken() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      sessionStorage.setItem('mi.token', fromUrl);
      params.delete('token');
      const clean = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
      history.replaceState(null, '', clean);
      return fromUrl;
    }
    return sessionStorage.getItem('mi.token') ?? '';
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        authorization: `Bearer ${state.token}`,
        'content-type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const message = body?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(message);
    }
    return body.result;
  }

  const STATUS_LABEL = { OK: 'ok', ATENCAO: 'atenção', PENDENTE: 'pendente', OPCIONAL: 'opcional' };
  const STATUS_CLASS = { OK: 'ok', ATENCAO: 'warn', PENDENTE: 'warn', OPCIONAL: 'muted' };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function renderChecks(report) {
    const host = $('#ps-checks');
    const rows = report.checks
      .map(
        (c) => `
        <div class="ps-check">
          <span class="ps-dot ${STATUS_CLASS[c.status] ?? 'muted'}"></span>
          <div class="ps-check-body">
            <div class="ps-check-label">${esc(c.label)} <span class="ps-check-status">${esc(STATUS_LABEL[c.status] ?? c.status)}</span></div>
            <div class="ps-check-detail">${esc(c.detail)}</div>
            ${c.action ? `<div class="ps-check-action">${esc(c.action)}</div>` : ''}
          </div>
        </div>`,
      )
      .join('');
    host.innerHTML = rows || '<div class="note">Nada a verificar.</div>';
    $('#ps-version').textContent = `v${report.version} · porta ${report.port}`;
    $('#ps-ext-path').textContent = report.extensionPath || 'pasta não encontrada';
    $('#ps-ext-id').textContent = report.extensionId || '—';
  }

  function setExtBadge(connected) {
    const label = connected ? 'extensão conectada' : 'aguardando conexão';
    for (const sel of ['#ps-ext-badge', '#ps-dock-badge']) {
      const badge = $(sel);
      if (!badge) continue;
      badge.textContent = label;
      badge.className = `badge ${connected ? 'ok' : 'warn'}`;
    }
    // Conectada e ainda "aguardando"? Só pode ser o selo do cartão: nada a fazer.
  }

  async function refresh() {
    try {
      const report = await api('/api/prestart');
      state.report = report;
      renderChecks(report);
      await loadLogFiles(report);
    } catch (err) {
      $('#ps-checks').innerHTML = `<div class="note bad">Falha ao verificar: ${esc(err.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------- logs
  let logTimer = null;

  async function loadLogFiles(report) {
    const select = $('#ps-log-file');
    if (!report?.logs?.length) {
      select.innerHTML = '<option value="">sem logs ainda</option>';
      return;
    }
    const current = select.value;
    select.innerHTML = report.logs
      .map((l) => `<option value="${esc(l.file)}">${esc(l.file.split(/[\\/]/).pop())} (${Math.round(l.sizeBytes / 1024)} KB)</option>`)
      .join('');
    if (current && report.logs.some((l) => l.file === current)) select.value = current;
  }

  async function loadLogs() {
    const file = $('#ps-log-file').value;
    const level = $('#ps-log-level').value;
    try {
      const params = new URLSearchParams({ lines: '300' });
      if (file) params.set('file', file);
      if (level) params.set('level', level);
      const result = await api(`/api/prestart/logs?${params}`);
      const pre = $('#ps-log');
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.textContent = result.lines.length ? result.lines.join('\n') : 'nenhuma linha ainda';
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      $('#ps-log').textContent = `falha ao ler log: ${err.message}`;
    }
  }

  function startLogPolling() {
    if (logTimer) clearInterval(logTimer);
    loadLogs();
    logTimer = setInterval(loadLogs, 3000);
  }

  // ---------------------------------------------------------------- testes
  /** Entrega token, porta e pasta da extensão para a extensão, se ela estiver viva. */
  async function handTokenToExtension() {
    try {
      await fetch('/api/prestart/handshake', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ token: state.token, port: Number(location.port) || 47811 }),
      });
    } catch {
      /* serviço fora do ar: nada a repassar */
    }
  }

  async function testPing() {
    const out = $('#ps-ping-out');
    out.textContent = 'testando…';
    const t0 = performance.now();
    try {
      const report = await api('/api/prestart');
      const ms = Math.round(performance.now() - t0);
      state.lastPingAt = new Date().toISOString();
      out.innerHTML = `
        <div class="ps-ok"><span class="ps-dot ok"></span> Serviço local respondeu em <strong>${ms} ms</strong></div>
        <div class="ps-line">protocolo 1 · versão ${esc(report.version)} · porta ${report.port}</div>`;
      // O host nativo e a extensão só respondem se a extensão estiver carregada.
      const hostCheck = report.checks.find((c) => c.key === 'nativeHost');
      const status = await api('/api/prestart/extension');
      const diag = status?.diagnosis;
      const diagLine = diag
        ? `extensão v${esc(diag.version ?? '?')} · HTTP ${diag.http?.ok ? `OK na porta ${diag.http.port}` : 'falhou'} · token ${
            diag.token ? 'OK' : 'ausente'
          }`
        : 'sem diagnóstico ainda (a extensão ainda não falou)';
      // Bolinha por serviço: verde funciona, amarelo responde com erro,
      // vermelho fora do ar — o mesmo código de cores do painel da extensão.
      const extState = status?.connected ? 'ok' : 'bad';
      const diagState = !diag ? 'warn' : diag.http?.ok && diag.token ? 'ok' : diag.http?.ok ? 'warn' : 'bad';
      out.insertAdjacentHTML(
        'beforeend',
        `<div class="ps-line"><span class="ps-dot ok"></span> host nativo: ${esc(hostCheck?.detail ?? '—')}</div>
         <div class="ps-line"><span class="ps-dot ${extState}"></span> extensão: ${
           state.extensionConnected ? 'conectada (ping recebido)' : 'sem ping da extensão ainda'
         }</div>
         <div class="ps-line"><span class="ps-dot ${diagState}"></span> ${diagLine}</div>`,
      );
      setExtBadge(status?.connected === true);
    } catch (err) {
      out.innerHTML = `<div class="ps-bad">Falha: ${esc(err.message)}</div>`;
    }
  }

  async function testTab() {
    const out = $('#ps-tab-out');
    out.textContent = 'procurando aba de marketplace…';
    try {
      const result = await api('/api/prestart/tabtest', { method: 'POST', body: JSON.stringify({}) });
      if (!result?.found) {
        out.innerHTML = `
          <div class="ps-bad">Nenhuma aba de marketplace aberta.</div>
          <div class="ps-line">Abra o painel do vendedor no Mercado Livre ou na Shopee, com a sua conta logada, e teste de novo.</div>`;
        return;
      }
      out.innerHTML = `
        <div class="ps-ok">Aba encontrada: <strong>${esc(result.marketplace)}</strong></div>
        <div class="ps-line">${esc(result.title || '')}</div>
        <div class="ps-line">última captura desta aba: ${esc(result.lastCaptureAt || 'nenhuma ainda')}</div>`;
    } catch (err) {
      out.innerHTML = `<div class="ps-bad">Falha: ${esc(err.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------- ações
  async function copyPath() {
    const path = state.report?.extensionPath;
    if (!path) return toast('Pasta da extensão não encontrada.', 'bad');
    try {
      await navigator.clipboard.writeText(path);
      toast('Caminho copiado. Cole no navegador com Ctrl+V.', 'ok');
    } catch {
      // Sem permissão de área de transferência: seleciona para cópia manual.
      const range = document.createRange();
      range.selectNodeContents($('#ps-ext-path'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('Selecionei o caminho: use Ctrl+C.', 'info');
    }
  }

  /**
   * Abre a página de extensões.
   *
   * Nenhum clique em página web abre `edge://extensions` (o navegador bloqueia
   * por segurança). Quem pode é o serviço local, que chama o navegador com
   * `--extensions-url`; se não houver navegador conhecido, a resposta diz o que
   * digitar na barra de endereços.
   */
  async function openExtensions(browser) {
    const name = browser === 'edge' ? 'Edge' : 'Chrome';
    try {
      const result = await api('/api/prestart/open-extensions', {
        method: 'POST',
        body: JSON.stringify({ browser }),
      });
      if (result?.opened) {
        toast(`${name} abriu a página de extensões. Ative o Modo do desenvolvedor e use "Carregar sem compactação".`, 'ok');
      } else {
        toast(result?.note ?? `Digite edge://extensions na barra de endereços do ${name}.`, 'warn');
      }
    } catch (err) {
      toast(`Não foi possível abrir o ${name}: ${err.message}. Digite edge://extensions na barra de endereços.`, 'warn');
    }
  }

  async function exportLog() {
    const text = $('#ps-log').textContent ?? '';
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `diagnostico-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function copyLog() {
    try {
      await navigator.clipboard.writeText($('#ps-log').textContent ?? '');
      toast('Log copiado.', 'ok');
    } catch {
      toast('Não foi possível copiar. Use o botão Exportar.', 'warn');
    }
  }

  async function goDashboard() {
    const target = $('#ps-always').checked ? 'dashboard' : 'prestart';
    try {
      await api('/api/prestart/start-target', { method: 'POST', body: JSON.stringify({ target }) });
    } catch {
      /* preferência é conforto; nunca bloqueia a ida ao painel */
    }
    // Token também no storage local: o painel principal usa o mesmo.
    location.href = '/app';
  }

  /** A extensão avisa que está viva com um ping em /api/prestart/ping. */
  function watchExtension() {
    setInterval(async () => {
      try {
        const result = await api('/api/prestart/extension');
        const connected = Boolean(result?.connected);
        if (connected !== state.extensionConnected) {
          state.extensionConnected = connected;
          setExtBadge(connected);
          if (connected) toast('Extensão conectada.', 'ok');
        }
      } catch {
        /* silencioso: o selo só muda quando há resposta */
      }
    }, 4000);
  }

  /**
   * Cartão «Conexão manual»: mostra a porta e o token desta sessão para o
   * usuário colar no painel da extensão quando a descoberta automática falha.
   * O token nunca sai de 127.0.0.1: a tela roda no mesmo serviço local.
   */
  async function loadCredentials() {
    try {
      const result = await api('/api/token');
      const token = result?.token ?? '';
      const port = result?.port ?? (location.port || '—');
      $('#ps-cred-port').textContent = String(port);
      $('#ps-cred-token').textContent = token || '—';
      return { port, token };
    } catch (err) {
      $('#ps-cred-out').innerHTML = `<div class="ps-bad">Não foi possível ler as credenciais: ${esc(err.message)}</div>`;
      return { port: '', token: '' };
    }
  }

  function copyText(text, label) {
    return navigator.clipboard
      .writeText(text)
      .then(() => toast(`${label} copiado.`, 'ok'))
      .catch(() => {
        // Sem permissão de área de transferência: mostra o valor para copiar à mão.
        $('#ps-cred-out').innerHTML = `<div class="ps-line">Copie manualmente: <code>${esc(text)}</code></div>`;
      });
  }

  /**
   * Token quando a URL perdeu o «?token=» (favorito, histórico, cache limpo).
   * O serviço entrega o token a quem vem de 127.0.0.1: é a mesma máquina.
   */
  async function recoverToken() {
    try {
      const res = await fetch('/api/token');
      const body = await res.json();
      const token = body?.result?.token;
      if (!token) return '';
      sessionStorage.setItem('mi.token', token);
      return token;
    } catch {
      return '';
    }
  }

  async function boot() {
    state.token = readToken() || (await recoverToken());
    if (!state.token) {
      $('#ps-checks').innerHTML =
        '<div class="note bad">Não foi possível falar com o serviço local. Abra pelo atalho do Menu Iniciar.</div>';
      return;
    }
    $('#ps-refresh').addEventListener('click', refresh);
    $('#ps-copy').addEventListener('click', copyPath);
    $('#ps-open-chrome').addEventListener('click', () => openExtensions('chrome'));
    $('#ps-open-edge').addEventListener('click', () => openExtensions('edge'));
    $('#ps-ping').addEventListener('click', testPing);
    $('#ps-token-refresh').addEventListener('click', async () => {
      try {
        // O token novo volta na própria resposta: guardá-lo já evita as
        // chamadas desta tela falharem com 401 logo depois da troca.
        const rotated = await api('/api/token/rotate', { method: 'POST' });
        if (rotated?.token) {
          state.token = rotated.token;
          sessionStorage.setItem('mi.token', rotated.token);
        }
        await loadCredentials();
        $('#ps-cred-out').innerHTML =
          '<div class="ps-ok">Token novo gerado. O token anterior deixou de valer.</div>';
      } catch (err) {
        $('#ps-cred-out').innerHTML = `<div class="ps-bad">Falha ao gerar token: ${esc(err.message)}</div>`;
      }
    });
    $('#ps-copy-port').addEventListener('click', async () => {
      const { port } = await loadCredentials();
      if (port) void copyText(String(port), 'Porta');
    });
    $('#ps-copy-token').addEventListener('click', async () => {
      const { token } = await loadCredentials();
      if (token) void copyText(token, 'Token');
    });
    $('#ps-copy-both').addEventListener('click', async () => {
      const { port, token } = await loadCredentials();
      if (port && token) void copyText(`porta ${port}\ntoken ${token}`, 'Porta e token');
    });
    void loadCredentials();
    $('#ps-tabtest').addEventListener('click', testTab);
    $('#ps-log-copy').addEventListener('click', copyLog);
    $('#ps-log-download').addEventListener('click', exportLog);
    $('#ps-log-file').addEventListener('change', loadLogs);
    $('#ps-log-level').addEventListener('change', loadLogs);
    $('#ps-go').addEventListener('click', goDashboard);
    $('#ps-dock-go').addEventListener('click', goDashboard);

    refresh();
    startLogPolling();
    watchExtension();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
