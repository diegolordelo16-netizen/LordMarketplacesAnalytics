/**
 * Marketplace Intelligence — Console local
 * Cobre todos os métodos IPC do serviço local. Nenhum botão decorativo:
 * cada ação chama uma rota real e mostra o resultado ou o erro real.
 */
'use strict';

// ------------------------------------------------------------------ estado
const state = {
  token: new URLSearchParams(location.search).get('token') || sessionStorage.getItem('mi.token') || '',
  accountId: '',
  ownProductId: '',
  view: 'exec',
  relationsStatus: 'PENDENTE',
};

if (state.token) {
  sessionStorage.setItem('mi.token', state.token);
  if (location.search.includes('token=')) history.replaceState(null, '', location.pathname);
}

/** Token recuperado do serviço local quando a URL não traz mais o «?token=». */
async function recoverToken() {
  try {
    const res = await fetch('/api/token');
    const body = await res.json();
    const token = body?.result?.token;
    if (token) sessionStorage.setItem('mi.token', token);
    return token ?? '';
  } catch {
    return '';
  }
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function brl(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return '—';
  return (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function num(v, digits = 0) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pct(v) {
  return v == null ? '—' : `${num(v, 1)}%`;
}

function dt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

// ------------------------------------------------------------------ API
async function api(method, payload = {}) {
  if (!state.token) state.token = await recoverToken();
  const call = (token) =>
    fetch('/api/ipc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: `ui-${Date.now()}`, method, protocolVersion: 1, payload }),
    });
  let res = await call(state.token);
  if (res.status === 401) {
    // O serviço gera um token novo a cada início: a aba pode ser de antes.
    const fresh = await recoverToken();
    if (fresh && fresh !== state.token) {
      state.token = fresh;
      res = await call(fresh);
    }
  }
  if (res.status === 401) {
    toast('Sessão expirada. Reabra o painel pelo atalho do menu Iniciar.', 'bad');
    throw new Error('UNAUTHORIZED');
  }
  const body = await res.json();
  if (!body.ok) {
    const err = new Error(body.error?.message || 'falha na chamada');
    err.code = body.error?.code;
    throw err;
  }
  return body.result;
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 4500);
}

async function run(fn, okMsg) {
  const out = await fn();
  if (okMsg) toast(okMsg);
  return out;
}

// ------------------------------------------------------------------ helpers de UI
function card(title, body, extra = '') {
  return `<section class="card"><header><h2>${esc(title)}</h2>${extra}</header><div class="card-body">${body}</div></section>`;
}

function table(headers, rows, empty = 'Nenhum registro.') {
  if (!rows || !rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function badge(text, kind = 'neutral') {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

function qualityBadge(q) {
  const map = { VERIFIED: 'ok', CALCULATED: 'info', ESTIMATED: 'warn', ZERO: 'info', UNKNOWN: 'neutral', NOT_COLLECTED: 'neutral', UNAVAILABLE: 'bad' };
  return badge(q || '—', map[q] || 'neutral');
}

// ------------------------------------------------------------------ VISÃO EXECUTIVA
async function viewExec() {
  const [kpis, missions, alerts] = await Promise.all([
    api('kpi.dashboard', state.accountId ? { accountId: state.accountId } : {}).catch((e) => ({ error: e.message })),
    api('missions.today', state.accountId ? { accountId: state.accountId } : {}).catch(() => []),
    api('alerts.list', {}).catch(() => []),
  ]);

  // kpi.dashboard devolve { accounts, listings, totals, ... }: usa totals quando existir.
  const k = kpis && !kpis.error ? (kpis.totals || kpis) : null;
  const kpiCards = [
    ['Receita líquida', k ? brl(k.netRevenueCents) : '—'],
    ['Lucro de contribuição', k ? brl(k.contributionCents) : '—'],
    ['Margem de contribuição', k ? pct(k.contributionMarginPct) : '—'],
    ['GMV', k ? brl(k.gmvCents) : '—'],
    ['Pedidos', k ? num(k.orders) : '—'],
    ['Visitas', k ? num(k.visits) : '—'],
    ['CVR', k ? pct(k.cvr) : '—'],
    ['Ticket médio', k ? brl(k.aovCents) : '—'],
    ['ACoS', k ? pct(k.acosPct) : '—'],
    ['ROAS', k ? num(k.roas, 2) : '—'],
    ['Devoluções', k ? pct(k.returnRatePct) : '—'],
    ['Cobertura de estoque', k ? `${num(k.stockCoverageDays, 1)} d` : '—'],
  ];

  return `
    ${kpis && kpis.error ? card('Sem dados de KPI ainda', `<p class="muted">${esc(kpis.error)}</p>
      <p class="muted small">Os KPIs aparecem depois da primeira captura na sua conta autenticada.</p>`) : ''}
    <div class="kpi-grid">${kpiCards.map(([l, v]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>

    ${card('Missões do dia', Array.isArray(missions) && missions.length
      ? missions.map((m) => `<div class="mission">
          <div class="mission-head"><strong>${esc(m.title || m.type || 'Ação')}</strong>${badge(m.severity || m.priority || '—', m.severity === 'CRITICO' ? 'bad' : 'warn')}</div>
          <div class="muted small">${esc(m.evidence || m.reason || '')}</div>
          ${m.impactCents != null ? `<div class="small">Impacto estimado: ${brl(m.impactCents)} · Esforço: ${esc(m.effort || '—')}</div>` : ''}
        </div>`).join('')
      : '<div class="empty">Nenhuma missão calculada. Rode a captura de dados primeiro.</div>')}

    ${card('Alertas', table(['Severidade', 'Regra', 'Mensagem', 'Quando'],
      (alerts || []).slice(0, 20).map((a) => `<tr>
        <td>${badge(a.severity || '—', a.severity === 'CRITICO' ? 'bad' : 'warn')}</td>
        <td>${esc(a.rule || a.type || '—')}</td><td>${esc(a.message || '')}</td><td>${dt(a.created_at)}</td></tr>`),
      'Nenhum alerta ativo.'))}
  `;
}

// ------------------------------------------------------------------ ANÚNCIOS / CAPTURA
async function viewListings() {
  const snaps = await api('capture.snapshot', state.accountId ? { accountId: state.accountId } : {}).catch(() => []);
  return card('Snapshots capturados', table(
    ['Marketplace', 'Anúncio', 'Quando', 'Origem', 'Qualidade'],
    (snaps || []).slice(0, 100).map((s) => `<tr>
      <td>${esc(s.marketplace || '—')}</td>
      <td>${esc(s.listing_id || s.external_id || '—')}</td>
      <td>${dt(s.captured_at || s.created_at)}</td>
      <td>${esc(s.source_class || '—')}</td>
      <td>${qualityBadge(s.quality || s.status)}</td></tr>`),
    'Nenhum snapshot. Use a extensão na página do anúncio para capturar.'))
  + card('Detalhe de KPI por anúncio', `
    <div class="form-row">
      <label class="grow">ID do anúncio <input id="kpi-listing-id" placeholder="ex.: MLB1234567890"></label>
      <button class="btn" data-act="kpi-listing">Calcular KPIs</button>
    </div>
    <div id="kpi-listing-out" class="out"></div>`);
}

// ------------------------------------------------------------------ FINANCEIRO
async function viewFinance() {
  return card('Simulador de margem e cenários', `
    <div class="form-grid">
      <label>Preço de venda (R$) <input id="fs-price" type="number" step="0.01" value="199.90"></label>
      <label>Custo do produto (R$) <input id="fs-cost" type="number" step="0.01" value="89.00"></label>
      <label>Comissão (%) <input id="fs-commission" type="number" step="0.01" value="16"></label>
      <label>Taxa fixa (R$) <input id="fs-fixed" type="number" step="0.01" value="5.00"></label>
      <label>Frete (R$) <input id="fs-shipping" type="number" step="0.01" value="0"></label>
      <label>Imposto (%) <input id="fs-tax" type="number" step="0.01" value="6"></label>
      <label>Desconto (%) <input id="fs-discount" type="number" step="0.01" value="0"></label>
      <label>Orçamento de Ads (R$) <input id="fs-ads" type="number" step="0.01" value="20.00"></label>
      <label>Devoluções (%) <input id="fs-returns" type="number" step="0.01" value="3"></label>
      <label>Embalagem (R$) <input id="fs-packaging" type="number" step="0.01" value="2.50"></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="finance-simulate">Simular</button></div>
    <div id="finance-out" class="out"></div>`)
  + card('Custos por SKU', `
    <div class="form-row">
      <label>SKU <input id="fc-sku" placeholder="SKU-001"></label>
      <label>Custo (R$) <input id="fc-cost" type="number" step="0.01" placeholder="89.00"></label>
      <button class="btn" data-act="finance-cost">Registrar custo</button>
    </div>
    <p class="muted small">Cada alteração é versionada: o histórico de custos é preservado.</p>`);
}

// ------------------------------------------------------------------ SEO & KEYWORDS
async function viewKeywords() {
  const [kws, gaps] = await Promise.all([
    api('keyword.list', {}).catch(() => []),
    api('keyword.gap', { accountId: state.accountId || 'local:default' }).catch(() => []),
  ]);
  return card('Adicionar palavra-chave', `
    <div class="form-grid">
      <label>Termo <input id="kw-term" placeholder="capacete norisk ff302"></label>
      <label>Intenção <select id="kw-intent">
        <option value="PRODUTO_DIRETO">Produto direto</option><option value="MARCA">Marca</option>
        <option value="MODELO_COMPATIBILIDADE">Modelo/compatibilidade</option>
        <option value="BENEFICIO_USO">Benefício/uso</option><option value="KIT_ATACADO">Kit/atacado</option>
        <option value="SAZONAL">Sazonal</option></select></label>
      <label>Marketplace <input id="kw-mp" value="mercado_livre"></label>
      <label>Origem <select id="kw-src">
        <option value="AUTOCOMPLETE">Autocomplete</option><option value="TITULO_CONCORRENTE">Título de concorrente</option>
        <option value="PERGUNTA">Pergunta de comprador</option><option value="ADS_REPORT">Relatório de Ads</option>
        <option value="IMPORTACAO">Importação</option></select></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="kw-add">Adicionar termo</button></div>`)
  + card('Banco de palavras-chave', table(['Termo', 'Intenção', 'Marketplace', 'Origem', 'Sinal', 'Confiança'],
    (kws || []).slice(0, 200).map((k) => `<tr>
      <td>${esc(k.term)}</td><td>${esc(k.intent || '—')}</td><td>${esc(k.marketplace || '—')}</td>
      <td>${esc(k.source || '—')}</td><td>${esc(k.demand_signal || '—')}</td><td>${esc(k.confidence || '—')}</td></tr>`),
    'Nenhuma palavra-chave registrada.'))
  + card('Lacunas (keyword gap)', `<pre class="json">${esc(JSON.stringify(gaps, null, 2))}</pre>`)
  + card('Rank tracker', `
    <div class="form-row">
      <label class="grow">Anúncio (MLB...) <input id="rk-listing" placeholder="MLB1234567890"></label>
      <label>Posição <input id="rk-pos" type="number" min="1" placeholder="7"></label>
      <button class="btn" data-act="rk-add">Registrar posição</button>
      <button class="btn ghost" data-act="rk-hist">Ver histórico</button>
    </div>
    <div id="rk-out" class="out"></div>`);
}

// ------------------------------------------------------------------ RADAR DE MERCADO
async function viewMarket() {
  return card('Snapshot de categoria', `
    <div class="form-grid">
      <label>Marketplace <input id="mk-mp" value="mercado_livre"></label>
      <label>Categoria <input id="mk-cat" placeholder="Capacetes"></label>
      <label>Preço mínimo (R$) <input id="mk-min" type="number" step="0.01"></label>
      <label>Preço mediano (R$) <input id="mk-med" type="number" step="0.01"></label>
      <label>Preço máximo (R$) <input id="mk-max" type="number" step="0.01"></label>
      <label>Anúncios observados <input id="mk-count" type="number"></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="mk-snapshot">Registrar snapshot</button></div>`)
  + card('Oportunidades de produto', `
    <div class="form-grid">
      <label>Termo/nicho <input id="op-term" placeholder="capacete infantil"></label>
      <label>Demanda (0-100) <input id="op-demand" type="number" min="0" max="100"></label>
      <label>Concorrência (0-100) <input id="op-comp" type="number" min="0" max="100"></label>
      <label>Margem projetada (%) <input id="op-margin" type="number" step="0.1"></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="op-add">Registrar oportunidade</button></div>
    <p class="muted small">O score explica os componentes; sem dados mínimos ele fica "dados insuficientes".</p>`);
}

// ------------------------------------------------------------------ CONCORRÊNCIA (núcleo)
async function viewCompetition() {
  const [products, stats] = await Promise.all([
    api('competitor.ownProduct.list', state.accountId ? { accountId: state.accountId } : {}).catch(() => []),
    api('competitor.stats', state.ownProductId ? { ownProductId: state.ownProductId } : {}).catch(() => null),
  ]);

  if (!state.ownProductId && products && products.length) state.ownProductId = products[0].id;
  const s = stats || {};
  const rules = s.learningRules || [];

  return card('Meu produto', `
    <div class="form-grid">
      <label>Título <input id="op-title" placeholder="Capacete Norisk FF302 Fechado Fosco Preto"></label>
      <label>Marca <input id="op-brand" placeholder="Norisk"></label>
      <label>Modelo <input id="op-model" placeholder="FF302"></label>
      <label>Categoria <input id="op-category" placeholder="Capacetes"></label>
      <label>Preço (R$) <input id="op-price" type="number" step="0.01"></label>
      <label>Marketplace <input id="op-mp" value="mercado_livre"></label>
      <label class="wide">Link do anúncio <input id="op-url" placeholder="https://produto.mercadolivre.com.br/..."></label>
      <label class="wide">Atributos (chave=valor; chave=valor) <input id="op-attrs" placeholder="tipo=fechado; certificacao=NBR 7471"></label>
      <label class="wide">Variações (separadas por vírgula) <input id="op-vars" placeholder="Preto, Cinza"></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="own-add">Cadastrar produto próprio</button></div>
    <p class="muted small">Informe o link e a extensão preenche os dados ao capturar a página; o cadastro manual continua válido.</p>`)
  + card('Produtos cadastrados', table(['Produto', 'Marketplace', 'Preço', 'Ações'],
    (products || []).map((p) => `<tr>
      <td>${esc(p.title)}</td><td>${esc(p.marketplace)}</td><td>${brl(p.price_cents)}</td>
      <td><button class="btn tiny ${state.ownProductId === p.id ? 'primary' : ''}" data-act="own-select" data-id="${p.id}">Selecionar</button></td></tr>`),
    'Nenhum produto próprio cadastrado.'))
  + card('Busca assistida de concorrentes', `
    <div class="form-row">
      <div class="grow">
        <div class="tiny muted">Marketplaces</div>
        <span class="checks">
          ${['mercado_livre', 'shopee', 'amazon', 'tiktok_shop', 'magalu', 'shein', 'netshoes']
            .map((m) => `<label class="chk"><input type="checkbox" class="mp-chk" value="${m}" ${m === 'mercado_livre' ? 'checked' : ''}> ${esc(m)}</label>`).join('')}
        </span>
      </div>
    </div>
    <div class="form-row">
      <label class="grow">Candidatos capturados (JSON da extensão) <textarea id="search-candidates" rows="4" placeholder='[{"marketplace":"mercado_livre","title":"...","brand":"...","priceCents":43900}]'></textarea></label>
    </div>
    <div class="actions">
      <button class="btn primary" data-act="search">Buscar concorrentes</button>
      <button class="btn ghost" data-act="search-demo">Carregar exemplo (MODO DEMONSTRATIVO)</button>
    </div>
    <div id="search-out" class="out"></div>`)
  + `<div class="kpi-grid">
      <div class="kpi pend"><div class="l">Pendentes</div><div class="v">${num(s.pending)}</div></div>
      <div class="kpi ok"><div class="l">Aprovados</div><div class="v">${num(s.approved)}</div></div>
      <div class="kpi bad"><div class="l">Rejeitados</div><div class="v">${num(s.rejected)}</div></div>
      <div class="kpi"><div class="l">Precisão</div><div class="v">${s.precisionPct == null ? '—' : pct(s.precisionPct)}</div></div>
      <div class="kpi"><div class="l">Em monitoramento</div><div class="v">${num(s.monitoringActive)}</div></div>
      <div class="kpi"><div class="l">Eventos de feedback</div><div class="v">${num(s.feedbackEvents)}</div></div>
    </div>`
  + `<div class="note">${esc(s.precisionNote || 'Precisão calculada apenas sobre decisões humanas.')}</div>`
  + card('Central de revisão', `
    <div class="tabs">
      ${['PENDENTE', 'APROVADO', 'REJEITADO'].map((st) => `<button class="tab ${state.relationsStatus === st ? 'active' : ''}" data-act="tab" data-status="${st}">
        ${st === 'PENDENTE' ? 'Pendentes de revisão' : st === 'APROVADO' ? 'Aprovados' : 'Rejeitados'}</button>`).join('')}
    </div>
    <div id="relations-list"><div class="empty">Carregando…</div></div>`)
  + card('Regras aprendidas (explícitas e auditáveis)', `
    <div class="actions"><button class="btn ghost" data-act="rebuild-rules">Recalcular regras do feedback</button></div>
    ${table(['Escopo', 'Valor', 'Direção', 'Suporte', 'Contra', 'Peso'],
      rules.map((r) => `<tr><td>${esc(r.scope)}</td><td>${esc(r.value)}</td>
        <td>${badge(r.direction, r.direction === 'PREFERIR' ? 'ok' : 'bad')}</td>
        <td>${num(r.support)}</td><td>${num(r.counter_support)}</td><td>${num(r.weight, 2)}</td></tr>`),
      'Nenhuma regra ainda — são derivadas de 2+ decisões no mesmo sentido.')}
    <p class="muted small">Isto não é um modelo treinado: são regras com suporte e contraprova, aplicadas na próxima busca.</p>`);
}

async function loadRelations() {
  const el = $('#relations-list');
  if (!el) return;
  let rows;
  try {
    rows = await api('competitor.relations', {
      ...(state.ownProductId ? { ownProductId: state.ownProductId } : {}),
      ...(state.relationsStatus ? { status: state.relationsStatus } : {}),
    });
  } catch (err) {
    el.innerHTML = `<div class="empty bad-text">${esc(err.message)}</div>`;
    return;
  }

  if (!rows.length) {
    el.innerHTML = `<div class="empty">Nenhum item nesta aba.</div>`;
    return;
  }
  el.innerHTML = rows.map((r) => {
    let rationale = { summary: '', factors: [] };
    try { rationale = JSON.parse(r.rationale_json); } catch { /* ignora */ }
    const factors = (rationale.factors || []).slice(0, 8)
      .map((f) => `<li>${esc(f.detail)} ${f.points ? `<b>(${f.points > 0 ? '+' : ''}${f.points})</b>` : ''}</li>`).join('');
    const actions = state.relationsStatus === 'PENDENTE'
      ? `<button class="btn tiny primary" data-act="approve" data-id="${r.id}">Aprovar</button>
         <button class="btn tiny" data-act="reject" data-id="${r.id}">Rejeitar</button>
         <button class="btn tiny" data-act="edit" data-id="${r.id}">Editar</button>
         <button class="btn tiny" data-act="change" data-id="${r.id}">Trocar produto</button>
         <button class="btn tiny" data-act="recat" data-id="${r.id}">Recategorizar</button>
         <button class="btn tiny ghost" data-act="reanalyze" data-id="${r.id}">Nova análise</button>`
      : state.relationsStatus === 'APROVADO'
        ? `<button class="btn tiny" data-act="monitor" data-id="${r.id}" data-state="${r.monitoring_state}">${r.monitoring_state === 'ATIVO' ? 'Pausar' : 'Retomar'}</button>
           <button class="btn tiny" data-act="history" data-id="${r.id}">Histórico</button>
           <button class="btn tiny ghost" data-act="reanalyze" data-id="${r.id}">Nova análise</button>`
        : `<button class="btn tiny" data-act="reanalyze" data-id="${r.id}">Reconsiderar</button>`;
    return `<div class="rel-card">
      <div class="rel-head">
        <div>
          <strong>${esc(r.candidate_title)}</strong>
          <div class="muted small">${esc(r.marketplace)} · ${esc(r.seller || 'vendedor não informado')} · ${brl(r.price_cents)}
            ${r.rating != null ? ` · ★ ${num(r.rating, 1)} (${num(r.reviews)})` : ''}</div>
          <div class="muted small">Meu produto: ${esc(r.own_title)} · ${brl(r.own_price_cents)}</div>
        </div>
        <div class="rel-score">
          <div class="score ${r.similarity_pct >= 70 ? 'hi' : r.similarity_pct >= 45 ? 'mid' : 'lo'}">${Math.round(r.similarity_pct)}%</div>
          ${badge(r.relation_kind, r.relation_kind === 'DIRETO' ? 'ok' : r.relation_kind === 'SIMILAR' ? 'warn' : 'neutral')}
          ${r.monitoring_state ? badge(r.monitoring_state, r.monitoring_state === 'ATIVO' ? 'ok' : 'neutral') : ''}
        </div>
      </div>
      <div class="rationale">${esc(rationale.summary || 'sem justificativa registrada')}<ul>${factors}</ul></div>
      ${r.rejection_reason ? `<div class="small bad-text">Motivo da rejeição: ${esc(r.rejection_reason)}</div>` : ''}
      ${r.url ? `<a class="link" href="${esc(r.url)}" target="_blank" rel="noopener">abrir anúncio</a>` : ''}
      <div class="actions">${actions}</div>
      <div class="rel-out" data-out="${r.id}"></div>
    </div>`;
  }).join('');
}

// ------------------------------------------------------------------ PREÇO & OFERTAS
async function viewPricing() {
  return card('Corredor de preço e cenários', `
    <div class="form-grid">
      <label>Custo total (R$) <input id="pr-cost" type="number" step="0.01"></label>
      <label>Margem mínima (%) <input id="pr-min" type="number" step="0.1" value="15"></label>
      <label>Comissão (%) <input id="pr-comm" type="number" step="0.01" value="16"></label>
      <label>Taxa fixa (R$) <input id="pr-fixed" type="number" step="0.01" value="5"></label>
      <label>Imposto (%) <input id="pr-tax" type="number" step="0.01" value="6"></label>
      <label>Frete (R$) <input id="pr-ship" type="number" step="0.01" value="0"></label>
      <label>Preço do concorrente (R$) <input id="pr-comp" type="number" step="0.01"></label>
      <label>Preço atual (R$) <input id="pr-cur" type="number" step="0.01"></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="price-calc">Calcular piso, teto e cenários</button></div>
    <div id="price-out" class="out"></div>
    <p class="muted small">Nenhuma alteração de preço é aplicada automaticamente: exige limites, guard e aprovação.</p>`);
}

// ------------------------------------------------------------------ VOZ DO CLIENTE
async function viewVoc() {
  const topics = state.accountId ? await api('voc.topics', { accountId: state.accountId }).catch(() => []) : [];
  return card('Registrar item da voz do cliente', `
    <div class="form-grid">
      <label>Tipo <select id="voc-type">
        <option value="REVIEW">Avaliação</option><option value="QUESTION">Pergunta</option>
        <option value="COMPLAINT">Reclamação</option><option value="RETURN_REASON">Motivo de devolução</option></select></label>
      <label>Nota (1-5) <input id="voc-rating" type="number" min="1" max="5"></label>
      <label class="wide">Texto <textarea id="voc-text" rows="3" placeholder="Texto público, sem dados pessoais"></textarea></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="voc-add">Registrar</button></div>
    <p class="muted small">Dados pessoais são removidos antes do armazenamento.</p>`)
  + (state.accountId ? '' : '<div class="note warn">Selecione uma conta no topo para ver os temas detectados.</div>')
  + card('Temas detectados', table(['Tema', 'Ocorrências', 'Sentimento', 'Impacto'],
    (topics || []).map((t) => `<tr><td>${esc(t.topic || t.theme)}</td><td>${num(t.count)}</td>
      <td>${esc(t.sentiment || '—')}</td><td>${esc(t.impact || '—')}</td></tr>`),
    'Nenhum tema ainda.'));
}

// ------------------------------------------------------------------ GROWTH LAB
async function viewGrowth() {
  const [inits, exps] = await Promise.all([
    api('growth.initiatives').catch(() => []),
    api('experiment.list', {}).catch(() => []),
  ]);
  return card('North Star e árvore de métricas', `
    <div class="actions"><button class="btn" data-act="metric-tree">Ver árvore de métricas</button></div>
    <div id="tree-out" class="out"></div>`)
  + card('Portfólio de iniciativas (RICE/ICE)', `
    <div class="form-grid">
      <label>Título <input id="gi-title" placeholder="Melhorar capa dos 10 anúncios com mais visitas"></label>
      <label>Reach <input id="gi-reach" type="number" min="0"></label>
      <label>Impacto <input id="gi-impact" type="number" min="0" max="3" step="0.1"></label>
      <label>Confiança <input id="gi-conf" type="number" min="0" max="1" step="0.05"></label>
      <label>Esforço <input id="gi-effort" type="number" min="0.5" step="0.5"></label>
      <label>Hipótese <input id="gi-hyp"></label>
    </div>
    <div class="actions"><button class="btn" data-act="gi-add">Gravar iniciativa</button></div>
    <p class="muted small">Gravação de iniciativa ainda não existe no serviço: por enquanto esta lista é somente leitura.</p>`)
  + card('Iniciativas', table(['Título', 'Score', 'Status'],
    (inits || []).map((i) => `<tr><td>${esc(i.title)}</td><td>${num(i.score, 1)}</td><td>${esc(i.status || '—')}</td></tr>`),
    'Nenhuma iniciativa.'))
  + card('Experimentos', `
    <div class="form-grid">
      <label>Hipótese <input id="ex-hyp" placeholder="Capa com medidas reduz devoluções"></label>
      <label>Variável <select id="ex-var"><option value="CAPA">Capa</option><option value="TITULO">Título</option>
        <option value="PRECO">Preço</option><option value="DESCRICAO">Descrição</option><option value="ADS">Ads</option></select></label>
      <label>Desenho <select id="ex-design"><option value="AB_RANDOMIZADO">A/B randomizado</option>
        <option value="ANTES_DEPOIS">Antes/depois</option><option value="SEQUENCIAL">Sequencial</option>
        <option value="SKU_PAREAADO">SKU pareado</option></select></label>
      <label>Métrica primária <input id="ex-metric" value="CVR"></label>
      <label>Taxa base (%) <input id="ex-baseline" type="number" step="0.01" value="2"></label>
      <label>Duração (dias) <input id="ex-days" type="number" value="14"></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="ex-add">Criar experimento</button></div>`)
  + card('Experimentos registrados', table(['Hipótese', 'Variável', 'Desenho', 'Status', 'Resultado'],
    (exps || []).map((e) => `<tr><td>${esc(e.hypothesis)}</td><td>${esc(e.variable || '—')}</td>
      <td>${esc(e.design || '—')}</td><td>${esc(e.status || '—')}</td>
      <td><button class="btn tiny" data-act="ex-result" data-id="${e.id}">Calcular</button></td></tr>`),
    'Nenhum experimento.'));
}

// ------------------------------------------------------------------ AGENTES DE IA
async function viewAgents() {
  const [runs, budget, memory] = await Promise.all([
    api('agent.runs', {}).catch(() => []),
    api('agent.budget', {}).catch(() => null),
    api('agent.memory', {}).catch(() => []),
  ]);
  const b = budget || {};
  return card('Orçamento e consumo do Gemini', `
    <div class="kpi-grid">
      <div class="kpi"><div class="l">Chamadas hoje</div><div class="v">${num(b.callsToday)}</div></div>
      <div class="kpi"><div class="l">Tokens entrada</div><div class="v">${num(b.tokensIn)}</div></div>
      <div class="kpi"><div class="l">Tokens saída</div><div class="v">${num(b.tokensOut)}</div></div>
      <div class="kpi"><div class="l">Custo hoje (US$)</div><div class="v">${num(b.costUsd, 4)}</div></div>
      <div class="kpi"><div class="l">Limite diário (US$)</div><div class="v">${num(b.dailyCostLimitUsd, 2)}</div></div>
    </div>`)
  + card('Executar agentes especializados', `
    <div class="form-grid">
      <label>Agente <select id="ag-key">
        <option value="seo_demand">SEO &amp; Demanda</option><option value="ads">Ads</option>
        <option value="competition">Concorrência</option><option value="conversion_cro">Conversão (CRO)</option>
        <option value="finance">Financeiro</option><option value="inventory">Estoque</option>
        <option value="content_postpurchase">Conteúdo &amp; Pós-compra</option><option value="pricing_offer">Precificação</option>
        <option value="performance_experiments">Performance &amp; Experimentação</option><option value="market_category">Mercado &amp; Categoria</option>
        <option value="keyword_rank">Keyword Intelligence</option><option value="voice_of_customer">Voz do Cliente</option>
        <option value="forecast_planning">Forecast</option><option value="growth_strategy">Growth &amp; Retenção</option></select></label>
      <label>Marketplace <input id="ag-mp" value="mercado_livre"></label>
      <label>Anúncio <input id="ag-listing" placeholder="MLB..."></label>
      <label>Janela (dias) <input id="ag-days" type="number" value="30"></label>
    </div>
    <div class="actions">
      <button class="btn primary" data-act="agent-run">Executar</button>
      <button class="btn ghost" data-act="agent-all">Executar todos + síntese do Director</button>
    </div>
    <div id="agent-out" class="out"></div>`)
  + card('Workspace de debate com o Gemini', `
    <div class="form-row">
      <label class="grow">Pergunta <textarea id="debate-q" rows="3" placeholder="Minha margem caiu 8% e o concorrente baixou o preço. O que fazer sem destruir margem?"></textarea></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="debate">Debater com o Gemini</button></div>
    <div id="debate-out" class="out"></div>`)
  + card('Histórico de execuções', table(['Quando', 'Agente', 'Recomendações', 'Conflitos'],
    (runs || []).slice(0, 50).map((r) => `<tr><td>${dt(r.created_at)}</td><td>${esc(r.agent_key || r.agent || '—')}</td>
      <td>${num(r.recommendation_count ?? (r.recommendations || []).length)}</td><td>${num(r.conflict_count ?? 0)}</td></tr>`),
    'Nenhuma execução de agente.'))
  + card('Memória operacional', table(['Tipo', 'Título', 'Confiança', 'Criado'],
    (memory || []).slice(0, 50).map((m) => `<tr><td>${esc(m.kind || '—')}</td><td>${esc(m.title || m.summary || '—')}</td>
      <td>${esc(m.confidence || '—')}</td><td>${dt(m.created_at)}</td></tr>`),
    'Memória vazia.'));
}

/**
 * Contexto que os agentes analisam, no formato do contrato (AgentContext).
 * As métricas entram como null quando não foram coletadas: o agente então
 * declara dado ausente em vez de supor número.
 */
function agentContext() {
  const days = Number($('#ag-days').value) || 30;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  return {
    accountId: state.accountId || 'local:default',
    marketplace: $('#ag-mp').value.trim() || 'mercado_livre',
    listingId: $('#ag-listing').value.trim() || '',
    window: { start: start.toISOString(), end: end.toISOString(), days },
    metrics: {},
    dataConfidence: 0,
    missingData: ['métricas ainda não coletadas para este anúncio'],
  };
}

// ------------------------------------------------------------------ TAREFAS
async function viewTasks() {
  const tasks = await api('task.list', {}).catch(() => []);
  return card('Criar tarefa', `
    <div class="form-grid">
      <label>Nome <input id="tk-name" placeholder="Revisar títulos dos 10 anúncios"></label>
      <label>Tipo <select id="tk-type">
        <option value="edit_title">Editar título</option><option value="edit_description">Editar descrição</option>
        <option value="upload_image">Trocar imagem de capa</option><option value="change_price">Alterar preço</option>
        <option value="duplicate_listing">Duplicar anúncio</option><option value="toggle_ads">Ligar/desligar Ads</option></select></label>
      <label>Marketplace <input id="tk-mp" value="mercado_livre"></label>
      <label>Anúncio <input id="tk-listing" placeholder="MLB..."></label>
      <label>Modo <select id="tk-mode"><option value="DRAFT">Rascunho (revisão)</option><option value="PUBLISH">Publicar autorizado</option></select></label>
      <label>Repetir <select id="tk-rec"><option value="">Não repetir</option><option value="1h">A cada hora</option><option value="6h">A cada 6 horas</option><option value="daily">Diário</option><option value="weekly">Semanal</option></select></label>
      <label>Agendar para <input id="tk-when" type="datetime-local"></label>
      <label>Digitação (ms por caractere) <input id="tk-typing" type="number" value="40"></label>
      <label class="wide">Novo título (opcional) <input id="tk-title" placeholder="Título novo do anúncio"></label>
      <label class="wide">Acréscimo à descrição (opcional) <textarea id="tk-desc" rows="2" placeholder="Só acrescenta ao final: o texto original é preservado"></textarea></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="task-add">Criar</button></div>`)
  + card('Fila de tarefas', table(['Status', 'Tipo', 'Anúncio', 'Agendada', 'Ações'],
    (tasks || []).map((t) => `<tr>
      <td>${badge(t.status, t.status === 'COMPLETED' ? 'ok' : t.status === 'FAILED' ? 'bad' : t.status === 'RUNNING' ? 'info' : 'neutral')}</td>
      <td>${esc(t.type)}</td><td>${esc(t.listing_id || '—')}</td><td>${dt(t.scheduled_for)}</td>
      <td>
        <button class="btn tiny" data-act="task-run" data-id="${t.id}">Executar</button>
        <button class="btn tiny" data-act="task-pause" data-id="${t.id}">Pausar</button>
        <button class="btn tiny" data-act="task-resume" data-id="${t.id}">Retomar</button>
        <button class="btn tiny" data-act="task-skip" data-id="${t.id}">Pular</button>
        <button class="btn tiny ghost" data-act="task-cancel" data-id="${t.id}">Cancelar</button>
      </td></tr>`),
    'Nenhuma tarefa.'));
}

// ------------------------------------------------------------------ CONECTORES
async function viewConnectors() {
  const registry = await api('connector.registry', {}).catch(() => []);
  return card('Conectores opcionais', table(['Conector', 'Dados', 'Status', 'Custo', 'Limites'],
    (registry || []).map((c) => `<tr><td>${esc(c.name || c.id)}</td><td>${esc(c.data_available || '—')}</td>
      <td>${badge(c.status || '—', c.status === 'CONECTADO' ? 'ok' : 'neutral')}</td>
      <td>${esc(c.cost || '—')}</td><td>${esc(c.limits || '—')}</td></tr>`),
    'Catálogo de conectores indisponível.'))
  + card('Importar relatório', `
    <div class="form-grid">
      <label>Conector <input id="im-conn" value="csv"></label>
      <label>Tipo <select id="im-kind"><option value="ADS">Ads</option><option value="VENDAS">Vendas</option>
        <option value="KEYWORDS">Palavras-chave</option><option value="AVALIACOES">Avaliações</option></select></label>
      <label class="wide">Conteúdo CSV <textarea id="im-csv" rows="4" placeholder="coluna,valor&#10;cliques,120"></textarea></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="import">Importar</button></div>
    <div id="import-out" class="out"></div>`);
}

// ------------------------------------------------------------------ ADMINISTRAÇÃO
async function viewAdmin() {
  const [audit, backups, settings, upgrades] = await Promise.all([
    api('audit.list', {}).catch(() => []),
    api('backup.list', {}).catch(() => []),
    api('settings.get', {}).catch(() => ({})),
    api('autoupgrade.list', {}).catch(() => []),
  ]);
  return card('Chave da API Gemini', `
    <div class="form-row">
      <label class="grow">Chave <input id="gk" type="password" placeholder="AIza..."></label>
      <button class="btn primary" data-act="gemini-key">Salvar (cifrada)</button>
      <button class="btn" data-act="gemini-test">Testar</button>
    </div>
    <p class="muted small">A chave fica cifrada no serviço local e nunca é enviada ao frontend.</p>`)
  + card('Configurações', `<pre class="json">${esc(JSON.stringify(settings, null, 2))}</pre>`)
  + card('Backups', `
    <div class="actions"><button class="btn primary" data-act="backup-create">Criar backup agora</button></div>
    ${table(['Arquivo', 'Quando', 'Tamanho'], (backups || []).map((b) => `<tr>
      <td>${esc(b.file || b.name)}</td><td>${dt(b.created_at)}</td><td>${num(b.sizeBytes)} B</td></tr>`), 'Nenhum backup.')}`)
  + card('Auto-upgrade governado', `
    <div class="form-row">
      <label class="grow">Sintoma observado <input id="au-sym" placeholder="Seletor de preço do Mercado Livre parou de funcionar"></label>
      <button class="btn" data-act="au-propose">Propor diagnóstico</button>
    </div>
    ${table(['Quando', 'Módulo', 'Risco', 'Status', 'Ações'],
      (upgrades || []).map((u) => `<tr><td>${dt(u.created_at)}</td><td>${esc(u.module || '—')}</td>
        <td>${badge(u.risk || '—', u.risk === 'ALTO' ? 'bad' : 'warn')}</td><td>${esc(u.status || '—')}</td>
        <td><button class="btn tiny" data-act="au-apply" data-id="${u.id}">Aplicar</button>
            <button class="btn tiny ghost" data-act="au-rollback" data-id="${u.id}">Reverter</button></td></tr>`),
      'Nenhuma proposta de upgrade.')}`)
  + card('Trilha de auditoria', table(['Quando', 'Ação', 'Ator', 'Alvo', 'Resultado'],
    (audit || []).slice(0, 100).map((a) => `<tr><td>${dt(a.created_at)}</td><td>${esc(a.action)}</td>
      <td>${esc(a.actor_id || a.actor || '—')}</td><td>${esc(a.target_id || '—')}</td>
      <td>${badge(a.result || '—', a.result === 'OK' ? 'ok' : 'bad')}</td></tr>`),
    'Sem registros.'))
  + card('Relatório e exportação', `
    <div class="form-row">
      <label>Tipo <select id="rp-type"><option value="EXECUTIVO">Resumo executivo</option>
        <option value="KPIS">KPIs por anúncio</option><option value="CONCORRENCIA">Inteligência competitiva</option>
        <option value="FINANCEIRO">Financeiro/margem</option><option value="EXPERIMENTOS">Testes A/B</option>
        <option value="AUDITORIA">Auditoria</option></select></label>
      <label>Formato <select id="rp-fmt"><option value="csv">CSV</option><option value="json">JSON</option></select></label>
      <button class="btn primary" data-act="report">Gerar</button>
    </div>
    <div id="report-out" class="out"></div>`)
  + card('Diagnóstico de adapters', `
    <div class="actions"><button class="btn" data-act="adapter-diag">Rodar diagnóstico</button></div>
    <div id="adapter-out" class="out"></div>`);
}

/**
 * Pré-Start & Diagnóstico dentro do painel.
 *
 * Mesmo conteúdo da tela inicial, em forma de resumo com atalho: a tela completa
 * é /prestart, que também roda sozinha (sem o painel) na primeira abertura.
 */
async function viewPrestart() {
  let report;
  try {
    report = await api('/api/prestart');
  } catch (err) {
    return `<div class="note bad">Não foi possível verificar o ambiente: ${esc(err.message)}</div>`;
  }
  const dot = { OK: 'ok', ATENCAO: 'warn', PENDENTE: 'warn', OPCIONAL: 'muted' };
  const rows = report.checks
    .map(
      (c) => `<tr>
        <td><span class="ps-dot ${dot[c.status] ?? 'muted'}"></span> ${esc(c.label)}</td>
        <td>${esc(c.detail)}</td>
        <td>${c.action ? `<span class="muted">${esc(c.action)}</span>` : ''}</td>
      </tr>`,
    )
    .join('');
  return card('Ambiente', `
      <table class="tbl">
        <thead><tr><th>Item</th><th>Situação</th><th>O que fazer</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="actions" style="margin-top:14px">
        <a class="btn primary" href="/prestart">Abrir tela completa de Pré-Start</a>
        <button class="btn" data-act="prestart-refresh">Verificar de novo</button>
      </div>
    `)
    + card('Extensão', `
      <div class="kv"><span>Caminho</span><code>${esc(report.extensionPath || 'não encontrado')}</code></div>
      <div class="kv"><span>ID esperado</span><code>${esc(report.extensionId || '—')}</code></div>
      <p class="muted">Carregue a pasta no navegador uma vez; a partir daí a tela mostra "Extensão conectada".</p>
    `);
}

// ------------------------------------------------------------------ roteador de views
const VIEWS = {
  exec: { label: 'Visão executiva', icon: '◧', render: viewExec },
  prestart: { label: 'Pré-Start & Diagnóstico', icon: '✓', render: viewPrestart },
  listings: { label: 'Anúncios & Captura', icon: '▤', render: viewListings },
  finance: { label: 'Financeiro', icon: '⊞', render: viewFinance },
  keywords: { label: 'SEO & Keywords', icon: '⌕', render: viewKeywords },
  market: { label: 'Radar de mercado', icon: '◎', render: viewMarket },
  competition: { label: 'Concorrência', icon: '⚔', render: viewCompetition },
  pricing: { label: 'Preço & Ofertas', icon: '◈', render: viewPricing },
  voc: { label: 'Voz do cliente', icon: '☰', render: viewVoc },
  growth: { label: 'Growth Lab', icon: '⟳', render: viewGrowth },
  agents: { label: 'Agentes de IA', icon: '✦', render: viewAgents },
  tasks: { label: 'Tarefas', icon: '⧗', render: viewTasks },
  connectors: { label: 'Conectores', icon: '⇄', render: viewConnectors },
  admin: { label: 'Administração', icon: '⚙', render: viewAdmin },
};

function renderNav() {
  $('#nav').innerHTML = Object.entries(VIEWS).map(([key, v]) => `
    <button class="nav-item ${state.view === key ? 'active' : ''}" data-act="nav" data-view="${key}">
      <span class="nav-icon">${v.icon}</span>${esc(v.label)}
    </button>`).join('');
}

async function renderView() {
  const view = VIEWS[state.view] || VIEWS.exec;
  $('#view-title').textContent = view.label;
  const host = $('#view');
  host.innerHTML = '<div class="loading">Carregando…</div>';
  try {
    host.innerHTML = await view.render();
    if (state.view === 'competition') await loadRelations();
  } catch (err) {
    host.innerHTML = `<div class="empty bad-text">${esc(err.message)}</div>`;
  }
}

// ------------------------------------------------------------------ ações
const ACTIONS = {
  nav: (d) => { state.view = d.view; renderNav(); renderView(); },

  'own-add': async () => {
    const attrs = {};
    ($('#op-attrs').value || '').split(';').forEach((pair) => {
      const [k, v] = pair.split('=');
      if (k && v) attrs[k.trim()] = v.trim();
    });
    const price = $('#op-price').value;
    const r = await run(() => api('competitor.ownProduct.upsert', {
      accountId: state.accountId,
      marketplace: $('#op-mp').value.trim() || 'mercado_livre',
      title: $('#op-title').value.trim(),
      brand: $('#op-brand').value.trim() || null,
      model: $('#op-model').value.trim() || null,
      category: $('#op-category').value.trim() || null,
      priceCents: price ? Math.round(Number(price) * 100) : null,
      url: $('#op-url').value.trim() || null,
      attributes: attrs,
      variations: ($('#op-vars').value || '').split(',').map((s) => s.trim()).filter(Boolean),
    }), 'Produto próprio cadastrado.');
    if (r && r.id) state.ownProductId = r.id;
    renderView();
  },

  'own-select': (d) => { state.ownProductId = d.id; toast('Produto selecionado.'); renderView(); },

  'search-demo': () => {
    $('#search-candidates').value = JSON.stringify([
      { marketplace: 'mercado_livre', title: 'Capacete Motociclista Fechado Norisk FF 302 Fosco 58', brand: 'Norisk', model: 'FF302', category: 'Capacetes', priceCents: 43900, seller: 'Loja A' },
      { marketplace: 'mercado_livre', title: 'Capacete Pro Tork Vision Preto Fechado', brand: 'Pro Tork', model: 'VISION', category: 'Capacetes', priceCents: 39900, seller: 'Loja B' },
      { marketplace: 'shopee', title: 'Luvas de moto couro tamanho G', brand: 'X11', category: 'Luvas', priceCents: 8900, seller: 'Loja C' },
    ], null, 2);
    toast('MODO DEMONSTRATIVO / EXEMPLO — dados de exemplo, não reais.');
  },

  search: async () => {
    if (!state.ownProductId) { toast('Cadastre e selecione um produto próprio primeiro.', 'bad'); return; }
    let candidates = [];
    const raw = $('#search-candidates').value.trim();
    if (raw) {
      try { candidates = JSON.parse(raw); } catch { toast('JSON de candidatos inválido.', 'bad'); return; }
    }
    const mps = $$('.mp-chk').filter((c) => c.checked).map((c) => c.value);
    if (!mps.length) { toast('Escolha pelo menos um marketplace.', 'bad'); return; }
    // O serviço exige `marketplaces` (lista) e valida cada candidato: normaliza
    // o que veio da tela para não perder a linha inteira por um campo faltando.
    const normalized = (Array.isArray(candidates) ? candidates : []).map((c) => ({
      marketplace: c.marketplace || mps[0],
      title: String(c.title || c.name || '').trim(),
      brand: c.brand ?? null,
      model: c.model ?? null,
      category: c.category ?? null,
      priceCents: typeof c.priceCents === 'number' ? c.priceCents : (typeof c.price === 'number' ? Math.round(c.price * 100) : null),
      url: c.url ?? null,
      seller: c.seller ?? null,
    })).filter((c) => c.title);
    const r = await run(() => api('competitor.search', {
      ownProductId: state.ownProductId,
      marketplaces: mps,
      candidates: normalized,
      discoveryMethod: 'BUSCA_ASSISTIDA',
      sourceClass: 'A_PRIMARY_UI',
    }), 'Busca concluída.');
    if (r) {
      $('#search-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
      if (!candidates.length) toast('Sem candidatos capturados: abra a página de busca no navegador e capture pela extensão.', 'bad');
      await renderView();
    }
  },

  tab: (d) => {
    state.relationsStatus = d.status;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.status === d.status));
    loadRelations();
  },

  approve: async (d) => { await run(() => api('competitor.approve', { relationId: d.id }), 'Aprovado e em monitoramento.'); renderView(); },
  reject: async (d) => {
    const reason = prompt('Motivo da rejeição (ajuda o aprendizado):') || '';
    await run(() => api('competitor.reject', { relationId: d.id, reason }), 'Rejeitado e registrado.');
    renderView();
  },
  edit: async (d) => {
    const title = prompt('Título correto do anúncio:');
    if (!title) return;
    const price = prompt('Preço em R$ (vazio mantém):') || '';
    await run(() => api('competitor.edit', {
      relationId: d.id, actorRole: 'super_admin', title,
      ...(price ? { priceCents: Math.round(Number(price) * 100) } : {}),
    }), 'Informações atualizadas.');
    renderView();
  },
  recat: async (d) => {
    const kind = prompt('Classificação: DIRETO, SIMILAR ou INDIRETO', 'SIMILAR');
    if (!kind) return;
    await run(() => api('competitor.edit', { relationId: d.id, actorRole: 'super_admin', relationKind: kind.toUpperCase() }), 'Recategorizado.');
    renderView();
  },
  change: async (d) => {
    const id = prompt('ID do produto próprio correto:');
    if (!id) return;
    await run(() => api('competitor.changeCandidate', { relationId: d.id, actorRole: 'super_admin', candidateId: id }), 'Produto relacionado alterado.');
    renderView();
  },
  reanalyze: async (d) => {
    const r = await run(() => api('competitor.reanalyze', { relationId: d.id }));
    if (r) toast(`Nova análise: ${Math.round(r.similarityPct)}% · ${r.kind}`);
    renderView();
  },
  monitor: async (d) => {
    const next = d.state === 'ATIVO' ? 'PAUSADO' : 'ATIVO';
    await run(() => api('competitor.monitoring.set', { relationId: d.id, actorRole: 'super_admin', state: next }), `Monitoramento ${next.toLowerCase()}.`);
    renderView();
  },
  history: async (d) => {
    const h = await run(() => api('competitor.monitoring.history', { relationId: d.id }));
    const out = document.querySelector(`[data-out="${d.id}"]`);
    if (!out || !h) return;
    const pts = h.points || [];
    const max = Math.max(...pts.map((p) => p.price_cents || 0), h.ownPriceCents || 0, 1);
    out.innerHTML = `
      <div class="small">Preço atual: ${brl(h.competitorPriceCents)} · mínimo: ${brl(h.minPriceCents)} · meu preço: ${brl(h.ownPriceCents)}</div>
      <div class="spark">${pts.map((p) => `<div class="bar" style="height:${Math.max(4, ((p.price_cents || 0) / max) * 60)}px" title="${brl(p.price_cents)} · ${dt(p.captured_at)}"></div>`).join('')}</div>
      ${table(['Quando', 'Preço', 'Posição', 'Nota', 'Avaliações'],
        pts.map((p) => `<tr><td>${dt(p.captured_at)}</td><td>${brl(p.price_cents)}</td>
          <td>${p.position ?? '—'}</td><td>${p.rating ?? '—'}</td><td>${p.reviews ?? '—'}</td></tr>`), 'Sem pontos coletados.')}
      ${h.note ? `<div class="muted small">${esc(h.note)}</div>` : ''}`;
  },
  'rebuild-rules': async () => {
    if (!state.ownProductId) { toast('Selecione um produto próprio.', 'bad'); return; }
    const r = await run(() => api('competitor.stats', { ownProductId: state.ownProductId }));
    if (r) toast(`${(r.learningRules || []).length} regra(s) derivadas de ${r.feedbackEvents} evento(s) de feedback.`);
    renderView();
  },

  'kpi-listing': async () => {
    const id = $('#kpi-listing-id').value.trim();
    if (!id) { toast('Informe o ID do anúncio.', 'bad'); return; }
    const r = await run(() => api('kpi.listing', { listingId: id, accountId: state.accountId }));
    $('#kpi-listing-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },

  'finance-simulate': async () => {
    const v = (id) => Number($(id).value) || 0;
    const r = await run(() => api('finance.simulate', {
      priceCents: Math.round(v('#fs-price') * 100),
      quantity: 1,
      unitCostCents: Math.round(v('#fs-cost') * 100),
      packagingCents: Math.round(v('#fs-packaging') * 100),
      commissionPct: v('#fs-commission'),
      fixedFeeCents: Math.round(v('#fs-fixed') * 100),
      shippingCents: Math.round(v('#fs-shipping') * 100),
      taxPct: v('#fs-tax'),
      discountPct: v('#fs-discount'),
      adSpendCents: Math.round(v('#fs-ads') * 100),
      returnRatePct: v('#fs-returns'),
      minMarginPct: 20,
    }));
    const rows = Object.entries(r || {}).map(([k, val]) => `<tr><td>${esc(k)}</td><td>${
      typeof val === 'number' && k.toLowerCase().includes('cents') ? brl(val) : esc(typeof val === 'object' ? JSON.stringify(val) : val)}</td></tr>`);
    $('#finance-out').innerHTML = table(['Campo', 'Valor'], rows);
  },
  'finance-cost': async () => {
    await run(() => api('finance.costs.upsert', {
      accountId: state.accountId, sku: $('#fc-sku').value.trim(),
      costCents: Math.round((Number($('#fc-cost').value) || 0) * 100),
    }), 'Custo registrado (versão preservada).');
  },

  'kw-add': async () => {
    await run(() => api('keyword.upsert', {
      term: $('#kw-term').value.trim(),
      intent: $('#kw-intent').value,
      marketplace: $('#kw-mp').value.trim() || 'mercado_livre',
    }), 'Termo adicionado.');
    renderView();
  },
  'rk-add': async () => {
    // rank.record é por ANÚNCIO: o serviço exige listingId e posição.
    await run(() => api('rank.record', {
      listingId: $('#rk-listing').value.trim(),
      keywordId: null,
      position: Number($('#rk-pos').value),
      isSponsored: false,
    }), 'Posição registrada.');
  },
  'rk-hist': async () => {
    const r = await run(() => api('rank.history', { listingId: $('#rk-listing').value.trim(), limit: 100 }));
    $('#rk-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },

  'mk-snapshot': async () => {
    await run(() => api('market.categorySnapshot', {
      marketplace: $('#mk-mp').value.trim(), category: $('#mk-cat').value.trim(),
      minPriceCents: Math.round((Number($('#mk-min').value) || 0) * 100) || null,
      medianPriceCents: Math.round((Number($('#mk-med').value) || 0) * 100) || null,
      maxPriceCents: Math.round((Number($('#mk-max').value) || 0) * 100) || null,
      observedListings: Number($('#mk-count').value) || null,
    }), 'Snapshot de categoria registrado.');
  },
  'op-add': async () => {
    await run(() => api('market.opportunities', {
      term: $('#op-term').value.trim(), demand: Number($('#op-demand').value),
      competition: Number($('#op-comp').value), marginPct: Number($('#op-margin').value),
    }), 'Oportunidade registrada.');
  },

  'price-calc': async () => {
    const v = (id) => Number($(id).value) || 0;
    const cost = Math.round(v('#pr-cost') * 100);
    const comm = v('#pr-comm') / 100;
    const fixed = Math.round(v('#pr-fixed') * 100);
    const tax = v('#pr-tax') / 100;
    const ship = Math.round(v('#pr-ship') * 100);
    const minMargin = v('#pr-min') / 100;
    const denom = 1 - comm - tax - minMargin;
    const floor = denom > 0 ? Math.ceil((cost + fixed + ship) / denom) : null;
    const comp = Math.round(v('#pr-comp') * 100);
    const cur = Math.round(v('#pr-cur') * 100);
    $('#price-out').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi"><div class="l">Piso (margem mínima)</div><div class="v">${floor ? brl(floor) : 'impossível'}</div></div>
        <div class="kpi"><div class="l">Preço atual</div><div class="v">${brl(cur)}</div></div>
        <div class="kpi"><div class="l">Concorrente</div><div class="v">${brl(comp)}</div></div>
        <div class="kpi"><div class="l">Diferença vs. concorrente</div><div class="v">${comp && cur ? pct(((cur - comp) / comp) * 100) : '—'}</div></div>
      </div>
      ${floor && cur && cur < floor ? '<div class="note warn">O preço atual está abaixo do piso de margem mínima.</div>' : ''}
      <p class="muted small">Cálculo local, sem alterar preço. Toda mudança exige limites, guard e aprovação.</p>`;
  },

  'voc-add': async () => {
    await run(() => api('voc.ingest', {
      accountId: state.accountId || 'local:default',
      listingId: null,
      kind: ($('#voc-type').value || 'REVIEW').toUpperCase(),
      rating: Number($('#voc-rating').value) || null,
      text: $('#voc-text').value.trim(),
    }), 'Item registrado com dados pessoais removidos.');
    renderView();
  },

  'metric-tree': async () => {
    const r = await run(() => api('growth.metricTree', {}));
    $('#tree-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },
  'gi-add': async () => {
    // O serviço ainda não tem gravação de iniciativa (growth.initiatives é só
    // leitura). A tela diz isso em vez de fingir que salvou.
    toast('Iniciativas ainda não têm gravação no serviço: esta tela é somente leitura.', 'warn');
  },
  'ex-add': async () => {
    const baseline = Number($('#ex-baseline').value) || 0;
    await run(() => api('experiment.create', {
      accountId: state.accountId || 'local:default',
      title: $('#ex-hyp').value.trim() || 'Experimento sem título',
      design: $('#ex-design').value,
      variable: $('#ex-var').value,
      primaryMetric: $('#ex-metric').value || 'CVR',
      guardrailMetrics: ['MARGEM', 'DEVOLUCAO'],
      // taxa base em fração (2% = 0.02); o serviço recusa 0.
      baselineRate: baseline > 0 ? baseline / 100 : 0.02,
      mde: 0.05,
      plannedDays: Number($('#ex-days').value) || 14,
    }), 'Experimento criado.');
    renderView();
  },
  'ex-result': async (d) => {
    const r = await run(() => api('experiment.result', { experimentId: d.id }));
    alert(JSON.stringify(r, null, 2));
  },

  'agent-run': async () => {
    // O serviço espera { agents, context }: o contexto é o dado que o agente
    // analisa. Sem ele o pedido é recusado por validação.
    const r = await run(() => api('agent.run', {
      agents: [$('#ag-key').value],
      context: agentContext(),
    }), 'Agente executado.');
    $('#agent-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },
  'agent-all': async () => {
    const r = await run(() => api('agent.run', {
      agents: ['seo_demand', 'ads', 'competition', 'conversion_cro', 'finance', 'inventory', 'content_postpurchase',
        'pricing_offer', 'performance_experiments', 'market_category', 'keyword_rank', 'voice_of_customer',
        'forecast_planning', 'growth_strategy'],
      context: agentContext(),
      listingId: $('#ag-listing').value.trim() || null,
      window: { days: Number($('#ag-days').value) || 30 },
    }), '14 agentes executados com síntese do Director.');
    $('#agent-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },
  debate: async () => {
    const q = $('#debate-q').value.trim();
    if (!q) { toast('Escreva a pergunta.', 'bad'); return; }
    // O serviço recebe o contexto como TEXTO: é o que vai no prompt.
    const r = await run(() => api('agent.debate', { topic: q, context: 'sem dados coletados ainda' }));
    $('#debate-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },

  'task-add': async () => {
    const listingId = $('#tk-listing').value.trim();
    if (!listingId) { toast('Informe o anúncio (MLB...).', 'bad'); return; }
    // Contrato real do serviço: nome, tipo, modo, perfil de digitação e itens.
    const item = {
      listingId,
      marketplace: $('#tk-mp').value.trim() || 'mercado_livre',
      accountId: state.accountId || 'local:default',
      copies: 1,
    };
    const title = $('#tk-title').value.trim();
    const desc = $('#tk-desc').value.trim();
    if (title) item.title = title;
    if (desc) item.descriptionAdditions = desc;
    await run(() => api('task.create', {
      name: $('#tk-name').value.trim() || `${$('#tk-type').value} · ${listingId}`,
      kind: $('#tk-type').value,
      accountId: item.accountId,
      mode: $('#tk-mode').value,
      scheduleAt: $('#tk-when').value ? new Date($('#tk-when').value).toISOString() : null,
      recurrence: $('#tk-rec').value || null,
      typing: {
        mode: 'set_value',
        charDelayMs: Number($('#tk-typing').value) || 0,
        settleDelayMs: 400,
        verifyAfterTyping: true,
      },
      items: [item],
    }), 'Tarefa criada.');
    renderView();
  },
  'task-run': async (d) => { await run(() => api('task.runNow', { taskId: d.id }), 'Executando.'); renderView(); },
  'task-pause': async (d) => { await run(() => api('task.pause', { taskId: d.id }), 'Pausada.'); renderView(); },
  'task-resume': async (d) => { await run(() => api('task.resume', { taskId: d.id }), 'Retomada.'); renderView(); },
  'task-skip': async (d) => { await run(() => api('task.skipItem', { taskId: d.id }), 'Item pulado.'); renderView(); },
  'task-cancel': async (d) => { await run(() => api('task.cancel', { taskId: d.id }), 'Cancelada.'); renderView(); },

  import: async () => {
    const text = $('#im-csv').value.trim();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) { toast('Cole um CSV com cabeçalho e pelo menos uma linha.', 'bad'); return; }
    const header = lines[0].split(',').map((h) => h.trim());
    const rows = lines.slice(1).map((line) => {
      const cells = line.split(',');
      const row = {};
      header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
      return row;
    });
    const r = await run(() => api('connector.import', {
      fileName: `${$('#im-kind').value.toLowerCase()}-${Date.now()}.csv`, rows,
    }), 'Importação enfileirada para validação.');
    $('#import-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },

  'gemini-key': async () => {
    const key = $('#gk').value.trim();
    if (!key) { toast('Informe a chave.', 'bad'); return; }
    await run(() => api('gemini.setKey', { key }), 'Chave salva cifrada.');
    $('#gk').value = '';
  },
  'gemini-test': async () => {
    const r = await run(() => api('gemini.testKey', {}));
    toast(r && r.ok ? 'Chave válida.' : `Falha: ${JSON.stringify(r)}`, r && r.ok ? 'ok' : 'bad');
  },
  'backup-create': async () => { await run(() => api('backup.create', {}), 'Backup criado.'); renderView(); },
  'au-propose': async () => {
    await run(() => api('autoupgrade.propose', {
      module: $('#au-mod').value.trim() || 'adapters/desconhecido',
      symptoms: $('#au-sym').value.trim(),
      currentCode: '',
    }), 'Proposta gerada (requer aprovação do super_admin).');
    renderView();
  },
  'au-apply': async (d) => {
    if (!confirm('Aplicar o upgrade? Um backup é criado antes e o rollback fica disponível.')) return;
    await run(() => api('autoupgrade.apply', { proposalId: d.id, approved: true, approverRole: 'super_admin', superAdminApproved: true }), 'Upgrade aplicado.');
    renderView();
  },
  'au-rollback': async (d) => { await run(() => api('autoupgrade.rollback', { proposalId: d.id, files: [] }), 'Revertido.'); renderView(); },
  report: async () => {
    const type = $('#rp-type').value;
    const fmt = $('#rp-fmt').value;
    const r = await run(() => api('report.export', { type, format: fmt }), 'Relatório gerado.');
    if (!r) return;
    const rows = r.rows || [];
    const name = `relatorio-${type.toLowerCase()}-${Date.now()}.${fmt}`;
    let content = '';
    let mime = 'application/json';
    if (fmt === 'csv') {
      const cols = Array.from(rows.reduce((set, row) => { Object.keys(row).forEach((k) => set.add(k)); return set; }, new Set()));
      const escCsv = (v) => {
        const t = v === null || v === undefined ? '' : String(v);
        return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      content = [cols.join(';'), ...rows.map((row) => cols.map((c) => escCsv(row[c])).join(';'))].join('\n');
      mime = 'text/csv';
    } else {
      content = JSON.stringify(r, null, 2);
    }
    const blob = new Blob([content], { type: mime });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.textContent = `baixar ${name}`;
    link.className = 'link';
    $('#report-out').innerHTML = '';
    $('#report-out').appendChild(link);
    $('#report-out').insertAdjacentHTML('beforeend',
      `<p class="muted small">${rows.length} linha(s) — dados vindos do seu banco local.</p>`);
  },
  'prestart-refresh': async () => {
    await renderView();
    toast('Ambiente verificado.', 'ok');
  },
  'adapter-diag': async () => {
    const r = await run(() => api('adapter.diagnostics', { marketplace: 'mercado_livre', observed: {} }));
    $('#adapter-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  try {
    await fn(el.dataset);
  } catch (err) {
    if (err.message !== 'UNAUTHORIZED') toast(err.message, 'bad');
  }
});

// ------------------------------------------------------------------ boot
async function boot() {
  renderNav();

  // A escolha de mostrar o Pré-Start é do servidor (rota `/`), não do navegador:
  // quem chegou em /app veio porque já escolheu ir ao painel.

  try {
    const health = await fetch('/api/health').then((r) => r.json());
    $('#health').textContent = `serviço local · ${health.uptimeSec}s no ar`;
    $('#dot').className = 'dot ok';
  } catch {
    $('#health').textContent = 'serviço local indisponível';
    $('#dot').className = 'dot bad';
    return;
  }

  try {
    const s = await api('settings.get', {});
    if (s && s.activeAccountId) state.accountId = s.activeAccountId;
  } catch { /* primeiro uso */ }

  const accounts = await api('account.list').catch(() => []);
  if (accounts && accounts.length && !state.accountId) state.accountId = accounts[0].id;
  const sel = $('#account');
  if (accounts && accounts.length) {
    sel.innerHTML = accounts
      .map((a) => `<option value="${a.id}" ${a.id === state.accountId ? 'selected' : ''}>${esc(a.display_name || a.id)} · ${esc(a.marketplace)}</option>`)
      .join('');
  } else {
    sel.innerHTML = '<option value="">nenhuma conta detectada</option>';
  }
  sel.addEventListener('change', () => { state.accountId = sel.value; renderView(); });

  await renderView();
}

boot();
