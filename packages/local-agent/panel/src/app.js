/**
 * Marketplace Intelligence — Console local
 * Cobre todos os métodos IPC do serviço local. Nenhum botão decorativo:
 * cada ação chama uma rota real e mostra o resultado ou o erro real.
 */
'use strict';

// ------------------------------------------------------------------ estado
let activeImportJobId = '';

const state = {
  token: new URLSearchParams(location.search).get('token') || sessionStorage.getItem('mi.token') || '',
  accountId: '',
  ownProductId: '',
  view: 'exec',
  relationsStatus: 'PENDENTE',
  historyPoints: [],
  execFilters:{marketplace:'',days:30,listingId:'',skuId:''},
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

function historyMetricConfig(){
  return {
    gmvCents: { label: 'GMV', format: (v) => brl(v), color: '#5b8def' },
    netRevenueCents: { label: 'Receita líquida', format: (v) => brl(v), color: '#16a085' },
    orders: { label: 'Pedidos', format: (v) => num(v), color: '#a66dd4' },
    visits: { label: 'Visitas', format: (v) => num(v), color: '#d18b2c' },
    adSpendCents: { label: 'Investimento Ads', format: (v) => brl(v), color: '#d15f71' },
    adAttributedRevenueCents: { label: 'Receita atribuída Ads', format: (v) => brl(v), color: '#2696a6' },
    commissionCents: { label: 'Comissões observadas', format: (v) => brl(v), color: '#9b7bd3' },
    fixedFeeCents: { label: 'Tarifas fixas observadas', format: (v) => brl(v), color: '#be8b51' },
    units: { label: "Unidades", format: (v) => num(v,2), color: '#5b8def' },
    stockAvailable: { label: "Estoque disponível", format: (v) => num(v,2), color: '#5b8def' },
    returnsCount: { label: "Devoluções", format: (v) => num(v,2), color: '#5b8def' },
    cancellations: { label: "Cancelamentos", format: (v) => num(v,2), color: '#5b8def' },
    adClicks: { label: "Cliques Ads", format: (v) => num(v,2), color: '#5b8def' },
    adAttributedOrders: { label: "Pedidos atribuídos Ads", format: (v) => num(v,2), color: '#5b8def' },
    paidImpressions: { label: "Impressões pagas", format: (v) => num(v,2), color: '#5b8def' },
    organicImpressions: { label: "Impressões orgânicas", format: (v) => num(v,2), color: '#5b8def' },
    questionsPending: { label: "Perguntas pendentes", format: (v) => num(v,2), color: '#5b8def' },
    questionsAnswered: { label: "Perguntas respondidas", format: (v) => num(v,2), color: '#5b8def' },
    reviewCount: { label: "Avaliações", format: (v) => num(v,2), color: '#5b8def' },
    reviewRating: { label: "Nota observada", format: (v) => num(v,2), color: '#5b8def' },
    organicClicks: { label: "Cliques orgânicos", format: (v) => num(v,2), color: '#5b8def' },
    favorites: { label: "Favoritos", format: (v) => num(v,2), color: '#5b8def' },
    addToCart: { label: "Adições ao carrinho", format: (v) => num(v,2), color: '#5b8def' },
    newCustomers: { label: "Novos clientes", format: (v) => num(v,2), color: '#5b8def' },
    returningCustomers: { label: "Clientes recorrentes", format: (v) => num(v,2), color: '#5b8def' },
    shippingFeeCents: { label: "Frete", format: (v) => brl(v), color: '#5b8def' },
    taxCents: { label: "Tributos", format: (v) => brl(v), color: '#5b8def' },
    marketplaceFeeCents: { label: "Tarifas marketplace", format: (v) => brl(v), color: '#5b8def' },
    returnsValue: { label: "Valor das devoluções", format: (v) => brl(v*100), color: '#5b8def' },
    cancellationValue: { label: "Valor dos cancelamentos", format: (v) => brl(v*100), color: '#5b8def' },
    discounts: { label: "Descontos observados", format: (v) => brl(v*100), color: '#5b8def' },
    cvr: { label: "Conversão observada", format: (v) => pct(v), color: '#5b8def' },
    aovCents: { label: "Ticket médio observado", format: (v) => brl(v), color: '#5b8def' },
    acosPct: { label: "ACoS observado", format: (v) => pct(v), color: '#5b8def' },
    roas: { label: "ROAS observado", format: (v) => num(v,2), color: '#5b8def' },
    returnRatePct: { label: "Taxa de devolução observada", format: (v) => pct(v), color: '#5b8def' },
  };
}
function renderHistoryChart(points, metric = 'gmvCents') {
  const config=historyMetricConfig();
  const selected = config[metric] ? metric : 'gmvCents';
  const meta = config[selected];
  const valid = (Array.isArray(points) ? points : []).filter((p) => typeof p[selected] === 'number' && Number.isFinite(p[selected]));
  if (valid.length < 2) return `<div class="empty">São necessários pelo menos dois dias com ${esc(meta.label.toLowerCase())} capturado para desenhar a evolução. A ausência de dado não é zero.</div>`;
  const width = 820, height = 230, left = 66, right = 22, top = 18, bottom = 38;
  const values = valid.map((p) => p[selected]);
  const min = Math.min(0, ...values), max = Math.max(...values);
  const span = Math.max(1, max - min);
  const start=Date.parse(valid[0].date+'T00:00:00Z'),end=Date.parse(valid[valid.length-1].date+'T00:00:00Z');
  const x=(index)=>left+(Date.parse(valid[index].date+'T00:00:00Z')-start)/Math.max(86400000,end-start)*(width-left-right);
  const y = (value) => top + (max - value) / span * (height - top - bottom);
  const path = valid.map((p, index) => `${index&&Date.parse(p.date+'T00:00:00Z')-Date.parse(valid[index-1].date+'T00:00:00Z')===86400000 ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(p[selected]).toFixed(2)}`).join(' ');
  const ticks = [0, .25, .5, .75, 1].map((fraction) => {
    const value = min + span * fraction;
    const yy = top + (height - top - bottom) * (1 - fraction);
    return `<g><line class="trend-grid" x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}"/><text class="trend-axis" x="${left-10}" y="${yy+4}" text-anchor="end">${esc(meta.format(value))}</text></g>`;
  }).join('');
  const dots = valid.map((p,index) => `<circle class="trend-dot" cx="${x(index)}" cy="${y(p[selected])}" r="3.5"><title>${esc(p.date)} · ${esc(meta.format(p[selected]))}</title></circle>`).join('');
  const first = valid[0].date, last = valid[valid.length-1].date;
  return `<div class="trend-chart-wrap"><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolução de ${esc(meta.label)} de ${esc(first)} a ${esc(last)}">${ticks}<path class="trend-path" d="${path}" stroke="${meta.color}"/>${dots}<text class="trend-axis" x="${left}" y="${height-10}">${esc(first)}</text><text class="trend-axis" x="${width-right}" y="${height-10}" text-anchor="end">${esc(last)}</text></svg></div><p class="muted small">${valid.length} dias com dado · observações por conta e anúncio · lacunas não são interpoladas.</p>`;
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
      body: JSON.stringify({ id: `ui-${Date.now()}`, method, protocolVersion: 1, token, payload }),
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

async function prestartRoute(path) {
  if (!state.token) state.token = await recoverToken();
  const request = () => fetch(path, { headers: { authorization: `Bearer ${state.token}` } });
  let response = await request();
  if (response.status === 401) {
    state.token = await recoverToken();
    if (state.token) response = await request();
  }
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error?.message ?? 'Falha ao consultar a conexão local.');
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

let tableSequence = 0;
function table(headers, rows, empty = 'Nenhum registro.') {
  if (!rows || !rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const id = `mi-table-${++tableSequence}`;
  return `<div class="table-wrap" data-table-id="${id}" data-page="0" data-sort-column="-1" data-sort-direction="asc">
    <div class="table-tools"><input type="search" data-table-search placeholder="Pesquisar nesta tabela…" aria-label="Pesquisar nesta tabela"><span class="muted small" data-table-count></span><div class="table-page-tools"><button type="button" class="btn tiny ghost" data-table-action="prev" disabled>Anterior</button><button type="button" class="btn tiny ghost" data-table-action="next">Próxima</button></div></div>
    <table id="${id}"><thead><tr>${headers.map((h, index) => `<th><button type="button" class="table-sort" data-table-sort="${index}" aria-label="Ordenar por ${esc(h)}">${esc(h)} <span aria-hidden="true">↕</span></button></th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function updateTableView(wrapper) {
  if (!wrapper) return;
  const body = wrapper.querySelector('tbody');
  const rows = Array.from(body?.rows || []);
  const query = (wrapper.querySelector('[data-table-search]')?.value || '').trim().toLocaleLowerCase('pt-BR');
  const column = Number(wrapper.dataset.sortColumn ?? -1);
  const direction = wrapper.dataset.sortDirection === 'desc' ? -1 : 1;
  if (column >= 0) {
    rows.sort((a, b) => (a.cells[column]?.textContent || '').trim().localeCompare((b.cells[column]?.textContent || '').trim(), 'pt-BR', { numeric: true, sensitivity: 'base' }) * direction);
    for (const row of rows) body.appendChild(row);
  }
  const filtered = rows.filter((row) => !query || row.textContent.toLocaleLowerCase('pt-BR').includes(query));
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(0, Number(wrapper.dataset.page || 0)), pageCount - 1);
  wrapper.dataset.page = String(page);
  const visible = new Set(filtered.slice(page * pageSize, (page + 1) * pageSize));
  rows.forEach((row) => { row.hidden = !visible.has(row); });
  const count = wrapper.querySelector('[data-table-count]');
  if (count) count.textContent = `${filtered.length ? page * pageSize + 1 : 0}–${Math.min((page + 1) * pageSize, filtered.length)} de ${filtered.length}`;
  const prev = wrapper.querySelector('[data-table-action="prev"]');
  const next = wrapper.querySelector('[data-table-action="next"]');
  if (prev) prev.disabled = page <= 0;
  if (next) next.disabled = page >= pageCount - 1;
}

function initializeTables(root = document) {
  root.querySelectorAll('[data-table-id]').forEach(updateTableView);
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
  const generation = viewRenderSequence;
  const selectedAccount=state.accountId;
  const filters={...state.execFilters};
  const scope={...(selectedAccount?{accountId:selectedAccount}:{}),...(filters.marketplace?{marketplace:filters.marketplace}:{}),days:filters.days,...(filters.listingId?{listingId:filters.listingId}:{}),...(filters.skuId?{skuId:filters.skuId}:{})};
  const [primaryFrom,primaryTo,comparisonFrom,comparisonTo]=comparisonPreset('7');
  const diagnosticScope={accountId:scope.accountId,marketplace:scope.marketplace,listingId:scope.listingId,skuId:scope.skuId,primaryFrom,primaryTo,comparisonFrom,comparisonTo,groupBy:'listing'};
  const [kpis, missions, alerts, history, realized, diagnostic, profitRows] = await Promise.all([
    api('kpi.dashboard', scope).catch((e) => ({ error: e.message })),
    api('missions.today', state.accountId ? { accountId: state.accountId } : {}).catch((e) => ({ error: e.message })),
    api('alerts.list', {}).catch((e) => ({ error: e.message })),
    api('kpi.history', scope).catch((e) => ({ error: e.message })),
    selectedAccount&&!filters.listingId&&!filters.skuId&&!filters.marketplace?api('finance.realized.summary',{accountId:selectedAccount}).catch(e=>({error:e.message})):Promise.resolve(null),
    api('kpi.compare.detail',diagnosticScope).catch(e=>({error:e.message})),
    selectedAccount&&!filters.listingId&&!filters.skuId&&!filters.marketplace?api('finance.realized.list',{accountId:selectedAccount,limit:100}).catch(e=>({error:e.message})):Promise.resolve(null),
  ]);
  const historyPoints = Array.isArray(history?.points) ? history.points : [];
  if (generation === viewRenderSequence) state.historyPoints = historyPoints;

  // kpi.dashboard devolve { accounts, listings, totals, ... }: usa totals quando existir.
  const k = kpis && !kpis.error ? (kpis.totals || kpis) : null;
  const kpiCards = [
    ['Receita líquida', k ? brl(k.netRevenueCents) : '—', 'netRevenue'],
    ['Lucro realizado registrado', realized&&!realized.error ? brl(realized.realizedProfitCents) : '—', null],
    ['Lucro de contribuição', k ? brl(k.contributionCents) : '—', null],
    ['Margem de contribuição', k ? pct(k.contributionMarginPct) : '—', null],
    ['GMV', k ? brl(k.gmvCents) : '—', 'gmv'],
    ['Unidades vendidas', k ? num(k.units) : '—', null],
    ['Pedidos', k ? num(k.orders) : '—', 'orders'],
    ['Visitas', k ? num(k.visits) : '—', 'visits'],
    ['CVR', k ? pct(k.cvr) : '—', 'cvr'],
    ['Ticket médio', k ? brl(k.aovCents) : '—', 'aov'],
    ['ACoS', k ? pct(k.acosPct) : '—', 'acos'],
    ['ROAS', k ? num(k.roas, 2) : '—', 'roas'],
    ['Devoluções', k ? pct(k.returnRatePct) : '—', 'returnRate'],
    ['Cobertura de estoque', k ? `${num(k.stockCoverageDays, 1)} d` : '—', null],
  ];

  const signals=(diagnostic?.rows||[]).flatMap(row=>(row.diagnostics||[]).map(d=>({label:row.label,...d})));
  const readFailures = [ ['Missões', missions], ['Alertas', alerts], ['Histórico', history], ['Diagnósticos',diagnostic], ['Registros de lucro',profitRows] ].filter(([, value]) => value?.error);
  return `
    ${readFailures.length ? card('Dados temporariamente indisponíveis', `<p class="bad-text">${readFailures.map(([name, value]) => `${esc(name)}: ${esc(value.error)}`).join(' · ')}</p>`) : ''}
    ${kpis && kpis.error ? card('Falha ao consultar KPIs', `<p class="muted">${esc(kpis.error)}</p>
      <p class="muted small">Os KPIs aparecem depois da primeira captura na sua conta autenticada.</p>`) : ''}
    ${card('Escopo dos indicadores', `<div class="form-grid"><label>Marketplace<select id="exec-market"><option value="">Todos</option>${['mercado_livre','shopee','amazon'].map(m=>`<option value="${m}" ${filters.marketplace===m?'selected':''}>${esc(m)}</option>`).join('')}</select></label><label>Recência da captura<select id="exec-days">${[1,7,30,90,365].map(d=>`<option value="${d}" ${filters.days===d?'selected':''}>${d} dias</option>`).join('')}</select></label><label>ID interno do anúncio<input id="exec-listing" maxlength="200" value="${esc(filters.listingId)}"></label><label>ID interno do SKU<input id="exec-sku" maxlength="200" value="${esc(filters.skuId)}"></label></div><button class="btn" data-act="exec-filter">Aplicar filtros</button><p class="muted small">Recência dos snapshots, não período de vendas comprovado. Missões e alertas mantêm o escopo próprio.</p>`)}
    <div class="kpi-grid">${kpiCards.map(([l, v, metric]) => metric ? `<button type="button" class="kpi kpi-drill" data-act="kpi-drilldown" data-metric="${esc(metric)}" aria-label="Detalhar ${esc(l)}"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span><span class="kpi-hint">Ver detalhes ↗</span></button>` : `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
    <div id="kpi-drilldown-out" class="out" aria-live="polite"></div>
    ${card('Lucro realizado — evidências', !selectedAccount||filters.listingId||filters.skuId||filters.marketplace?'<p class="muted">Selecione uma loja sem filtros adicionais para consultar registros de lucro.</p>':realized?.error?'<p class="bad-text">'+esc(realized.error)+'</p>':realized?.confidence==='CONFLICTING_RECORDS'?'<p class="bad-text">Registros conflitantes: intervalos sobrepostos ou escopos misturados. Corrija a conciliação antes de somar.</p>':realized?.records?'<p>Registros: '+num(realized.records)+' · Escopo: '+esc(realized.scope)+' · Origens: '+esc(realized.sourceClasses.join(', '))+'</p><p class="muted small">Histórico de registros disponíveis, sem cobertura integral comprovada. Não é o lucro dos últimos 30 dias.</p>':'<p class="muted">Nenhum registro de lucro realizado. Dado ausente não é zero.</p>')}
    ${card('Diagnósticos automáticos — 7 dias completos', '<p class="muted small">'+esc(diagnostic?.diagnosticPolicy||'Comparação de snapshots; não comprova causalidade.')+' · '+esc(primaryFrom)+' a '+esc(primaryTo)+' versus '+esc(comparisonFrom)+' a '+esc(comparisonTo)+' (UTC).</p>'+table(['Anúncio','Indicador','Atual','Anterior','Sinal observado'],signals.slice(0,100).map(d=>'<tr><td>'+esc(d.label)+'</td><td>'+esc(d.metric)+'</td><td>'+num(d.current,2)+'</td><td>'+num(d.previous,2)+'</td><td>'+esc(d.note)+'</td></tr>'),diagnostic?.error?'Falha ao consultar diagnósticos.':'Nenhum sinal com evidência suficiente.')+table(['Campanha','Investimento','Receita atribuída'],(diagnostic?.campaigns||[]).slice(0,100).map(d=>'<tr><td>'+esc(d.label||d.campaignId)+'</td><td>'+brl(d.spend*100)+'</td><td>'+brl(d.attributedRevenue*100)+'</td></tr>'),'Nenhuma campanha com evidência suficiente para revisão.')+'<button class="btn" data-act="nav" data-view="compare">Abrir comparações detalhadas</button>')}
    ${card('Histórico do lucro registrado',table(['Período inicial','Período final','Escopo','Lucro registrado','Origem'],(Array.isArray(profitRows)?profitRows:[]).map(r=>'<tr><td>'+dt(r.period_start)+'</td><td>'+dt(r.period_end)+'</td><td>'+esc(r.listing_id||'Loja')+'</td><td>'+brl(r.realizedProfitCents)+'</td><td>'+esc(r.source_class)+'</td></tr>'),profitRows?.error?'Falha ao carregar registros.':'Selecione uma loja com registros de lucro.')+'<p class="muted small">Registros individuais; períodos sobrepostos não são somados.</p>')}
    ${card('Como os indicadores são calculados', '<p class="muted small">GMV: faturamento bruto observado. Ticket médio: GMV ÷ pedidos. CVR: pedidos ÷ visitas × 100. ACoS: investimento Ads ÷ receita atribuída × 100. ROAS: receita atribuída ÷ investimento Ads. Taxa de devolução: devoluções ÷ pedidos × 100. Sem denominador positivo ou com dados ausentes, o resultado fica indisponível. Estes totais refletem snapshots; não comprovam automaticamente um período de vendas.</p>')}

    ${card('Histórico de snapshots', `<div class="form-row"><label>Métrica <select id="history-metric">${Object.entries(historyMetricConfig()).map(([key,m])=>`<option value="${esc(key)}">${esc(m.label)}</option>`).join('')}</select></label><span class="muted small">Últimos ${filters.days} dias de captura</span></div><p class="muted small">Cada ponto representa a última observação do dia por loja ou anúncio, não vendas realizadas naquele dia. Métricas ausentes não são tratadas como zero; períodos da origem precisam ser conciliados.</p><div id="history-chart">${history?.error ? '<div class="empty bad-text">Falha ao carregar histórico.</div>' : renderHistoryChart(historyPoints)}</div>`) }

    ${card('Missões do dia', Array.isArray(missions) && missions.length
      ? missions.map((m) => `<div class="mission">
          <div class="mission-head"><strong>${esc(m.title || m.type || 'Ação')}</strong>${badge(m.severity || m.priority || '—', m.severity === 'CRITICO' ? 'bad' : 'warn')}</div>
          <div class="muted small">${esc(m.evidence || m.reason || '')}</div>
          ${m.impactCents != null ? `<div class="small">Impacto estimado: ${brl(m.impactCents)} · Esforço: ${esc(m.effort || '—')}</div>` : ''}
        </div>`).join('')
      : missions?.error ? '<div class="empty bad-text">Missões indisponíveis.</div>' : '<div class="empty">Nenhuma missão calculada. Rode a captura de dados primeiro.</div>')}

    ${card('Alertas', table(['Severidade', 'Regra', 'Mensagem', 'Quando'],
      (Array.isArray(alerts) ? alerts : []).slice(0, 20).map((a) => `<tr>
        <td>${badge(a.severity || '—', a.severity === 'CRITICO' ? 'bad' : 'warn')}</td>
        <td>${esc(a.rule || a.type || '—')}</td><td>${esc(a.message || '')}</td><td>${dt(a.created_at)}</td></tr>`),
      alerts?.error ? 'Falha ao consultar alertas.' : 'Nenhum alerta ativo.'))}
    ${card('Previsão de tendência local', `
      <div class="form-row">
        <label>Métrica <select id="fcst-metric"><option value="gmv">GMV</option><option value="orders">Pedidos</option><option value="visits">Visitas</option><option value="units">Unidades</option><option value="adSpend">Investimento em Ads</option><option value="adAttributedRevenue">Receita atribuída a Ads</option><option value="stockAvailable">Estoque disponível</option></select></label>
        <label>Horizonte <select id="fcst-horizon"><option value="7">7 dias</option><option value="14">14 dias</option><option value="28" selected>28 dias</option><option value="56">56 dias</option></select></label>
        <button class="btn" data-act="forecast-run" ${state.accountId ? '' : 'disabled'}>Calcular previsão</button>
      </div>
      <p class="muted small">Exige pelo menos 8 semanas distintas com snapshots. Projeção linear local com intervalo heurístico; não é promessa de venda nem inferência causal.</p>
      <div id="forecast-out" class="out"></div>`)}
  `;
}

// ------------------------------------------------------------------ ANÚNCIOS / CAPTURA
async function viewListings() {
  const snaps = await api('capture.snapshot', state.accountId ? { accountId: state.accountId } : {});
  const accountSnaps = state.accountId ? await api('capture.accountSnapshots',{accountId:state.accountId,limit:30}) : [];
  const details=state.accountId?await api('capture.details',{accountId:state.accountId,limit:100}):[];
  const chartPoints=state.accountId?await api('capture.chartPoints',{accountId:state.accountId,limit:100}):[];
  const listings = new Map();
  for (const snapshot of snaps) if (!listings.has(snapshot.listing_id)) listings.set(snapshot.listing_id, snapshot);
  return card('Snapshots capturados', table(
    ['Marketplace', 'Anúncio', 'Preço capturado', 'Promoção observada', 'Conversão observada', 'Quando', 'Origem', 'Qualidade'],
    (snaps || []).slice(0, 100).map((s) => `<tr>
      <td>${esc(s.marketplace || '—')}</td>
      <td>${esc(s.external_id || s.listing_id || '—')}${s.title ? `<div class="muted small">${esc(s.title)}</div>` : ''}</td>
      <td>${typeof s.metrics?.price === 'number' ? brl(Math.round(s.metrics.price * 100)) : '—'}</td>
      <td>${typeof s.metrics?.originalPrice==='number'?brl(Math.round(s.metrics.originalPrice*100)):'—'}${typeof s.metrics?.promotionDiscountPct==='number'?` · ${num(s.metrics.promotionDiscountPct)}%` : ''}</td>
      <td>${typeof s.metrics?.conversionRatePct==='number'?`${num(s.metrics.conversionRatePct)}%`:'—'}</td>
      <td>${dt(s.captured_at || s.created_at)}</td>
      <td>${esc(s.source_class || '—')}</td>
      <td>${qualityBadge(s.quality || s.status)}</td></tr>`),
    'Nenhum snapshot. Use a extensão na página do anúncio para capturar.')
    + '<div class="actions"><button class="btn" data-act="nav" data-view="browserSync">Abrir Extensão & Coletas</button></div>')
  + card('Indicadores observados da loja',table(['Área','Conversão exibida','Conversão Ads exibida','Cliques orgânicos','Período/filtros observados','Capturado em'],(accountSnaps||[]).map(s=>`<tr><td>${esc(s.page_kind)}</td><td>${typeof s.metrics?.conversionRatePct==='number'?num(s.metrics.conversionRatePct)+'%':'—'}</td><td>${typeof s.metrics?.adConversionRatePct==='number'?num(s.metrics.adConversionRatePct)+'%':'—'}</td><td>${typeof s.metrics?.organicClicks==='number'?num(s.metrics.organicClicks):'—'}</td><td>${esc(s.evidence?.filtersAndPeriod||'não informado')}</td><td>${dt(s.captured_at)}</td></tr>`),'Selecione uma loja com capturas. Valores ausentes não são zeros.')+'<p class="muted small">Taxas exibidas na origem; não substituem KPIs calculados nem comprovam períodos compatíveis.</p>')
  + card('Reputação observada da loja',table(['Indicador','Valor','Evidência','Data'],(accountSnaps||[]).filter(s=>s.page_kind==='seller_reputation').flatMap(s=>Object.entries({"sellerCancellationRatePct":"Cancelamento pelo vendedor","complaintRatePct":"Reclamações","onTimeShippingRatePct":"Envio no prazo","responseRatePct":"Resposta","orderDefectRatePct":"Pedidos com defeito","lateShipmentRatePct":"Envios atrasados","validTrackingRatePct":"Rastreio válido","nonFulfillmentRatePct":"Não cumprimento","chatResponseRatePct":"Resposta do chat","mediatedComplaintRatePct":"Reclamações mediadas"}).filter(([key])=>typeof s.metrics?.[key]==='number').map(([key,label])=>`<tr><td>${esc(label)}</td><td>${num(s.metrics[key])}%</td><td>${esc(s.evidence?.[key]||'—')}</td><td>${dt(s.captured_at)}</td></tr>`)),'Nenhum indicador explícito de reputação capturado.'))
  + card('Campanhas, anúncios Ads, variações e armazéns capturados',table(['Tipo','Identificador','Entidade pai','Indicadores observados','Origem / filtros','Capturado em'],(details||[]).map(s=>`<tr><td>${esc(s.kind)}</td><td>${esc(s.external_id)}${s.label?`<div class="muted small">${esc(s.label)}</div>`:''}</td><td>${esc(s.parent_external_id||'—')}</td><td>${Object.entries(s.metrics||{}).map(([key,value])=>`${esc(key)}: ${esc(value)}`).join('<br>')}</td><td>${esc(s.context?.filtersAndPeriod||'período não informado')}</td><td>${dt(s.captured_at)}</td></tr>`),'Nenhum detalhe com identidade e dados reconhecidos. Abra uma página correspondente do vendedor.')+'<p class="muted small">Dados capturados por entidade; não são somados aos totais da loja.</p>')
  + card('Dados textuais de gráficos',table(['Gráfico','Série','Dimensão','Valor observado','Unidade','Filtros','Capturado em'],(chartPoints||[]).map(p=>`<tr><td>${esc(p.chart_title)}</td><td>${esc(p.series)}</td><td>${esc(p.dimension)}</td><td>${esc(p.raw_text)}</td><td>${esc(p.unit==='UNSPECIFIED'?'Não especificada':p.unit)}</td><td>${esc(p.filter_signature||'—')}</td><td>${dt(p.captured_at)}</td></tr>`),'Nenhuma série textual reconhecida. Gráficos somente visuais não são estimados.')+'<p class="muted small">Pontos observados em tabelas visíveis associadas aos gráficos, sem soma automática aos KPIs.</p>')
  + card('Detalhe de KPI por anúncio', `
    <div class="form-row">
      <label class="grow">Anúncio <select id="kpi-listing-id">${listings.size ? [...listings.values()].map((item) =>
        `<option value="${esc(item.listing_id)}">${esc(item.external_id ?? item.listing_id)}${item.title ? ` · ${esc(item.title)}` : ''}</option>`).join('') : '<option value="">Nenhum snapshot</option>'}</select></label>
      <button class="btn" data-act="kpi-listing" ${listings.size ? '' : 'disabled'}>Calcular KPIs</button>
    </div>
    <div id="kpi-listing-out" class="out"></div>`);
}

// ------------------------------------------------------------------ FINANCEIRO
const REALIZED_FIELDS=[["netRevenueCents","Receita líquida"],["productCostCents","Custo dos produtos"],["packagingCents","Embalagens"],["shippingCents","Frete"],["marketplaceFeesCents","Taxas marketplace"],["taxesCents","Impostos"],["adSpendCents","Publicidade"],["refundsCents","Reembolsos"],["returnLogisticsCents","Logística reversa"],["cancellationLossCents","Perdas em cancelamentos"],["otherCostsCents","Outros custos"]];
function realizedPayload(read,accountId){
  if(!accountId)throw new Error('Selecione uma loja.');
  const from=read('rp-from'),to=read('rp-to'),evidence=read('rp-evidence').trim();
  const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
  if(!validDate(from)||!validDate(to)||from>to||!evidence)throw new Error('Informe período válido e evidência da conciliação.');
  const payload={accountId,listingId:read('rp-listing').trim()||undefined,periodStart:from+'T00:00:00.000Z',periodEnd:to+'T23:59:59.999Z',sourceClass:'F_USER_INPUT',evidence:{source:evidence}};
  for(const [key,label] of REALIZED_FIELDS){
    const raw=read('rp-'+key).trim();
    if(!/^\d+(?:[.,]\d{1,2})?$/.test(raw))throw new Error('Informe '+label+'; use 0 somente se confirmado.');
    const cents=Math.round(Number(raw.replace(',','.'))*100);
    if(!Number.isSafeInteger(cents)||cents<0)throw new Error('Valor inválido: '+label);
    payload[key]=cents;
  }
  return payload;
}
async function viewFinance() {
  return card('Registrar lucro realizado', state.accountId?`
    <p class="muted small">Informe valores efetivamente conciliados. Nenhum campo financeiro é preenchido automaticamente com zero. Não desconte duas vezes valores já incluídos na receita líquida.</p>
    <div class="form-grid"><label>Anúncio (ID interno, opcional)<input id="rp-listing" maxlength="200"></label><label>Início (UTC)<input type="date" id="rp-from"></label><label>Fim (UTC)<input type="date" id="rp-to"></label>
    ${REALIZED_FIELDS.map(([key,label])=>`<label>${esc(label)} (R$)<input id="rp-${key}" inputmode="decimal" placeholder="0,00"></label>`).join('')}</div>
    <label>Referência da conciliação (relatório, data, origem)<textarea id="rp-evidence" maxlength="500" rows="2"></textarea></label>
    <button class="btn primary" data-act="finance-realized-save">Registrar valores conciliados</button><div id="rp-out" class="out" aria-live="polite"></div>
  `:'<p class="muted">Selecione uma loja para registrar lucro.</p>')
  + card('Simulador de margem e cenários', `
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
  + card('Simulador de kits e combos', `
    <label>Componentes em JSON <textarea id="bundle-json" rows="8">[
  {"name":"Produto A","priceCents":15990,"quantity":1,"unitCostCents":7000,"commissionPct":16,"fixedFeeCents":500,"taxPct":6,"shippingCents":0,"packagingCents":250},
  {"name":"Produto B","priceCents":8990,"quantity":1,"unitCostCents":3500,"commissionPct":16,"fixedFeeCents":0,"taxPct":6,"shippingCents":0,"packagingCents":150}
]</textarea></label>
    <div class="form-row"><label>Desconto do kit (%) <input id="bundle-discount" type="number" min="0" max="100" step="0.1" value="5"></label><label>Ads alocado (R$) <input id="bundle-ads" type="number" min="0" step="0.01" value="0"></label><button class="btn primary" data-act="bundle-simulate">Simular kit</button></div>
    <p class="muted small">Informe valores em centavos no JSON. Tarifas e custos devem refletir o cenário pretendido. A simulação não cria nem publica ofertas.</p><div id="bundle-out" class="out"></div>`)
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
  + card('Inteligência local de palavras-chave', `
    <div class="form-row"><button class="btn" data-act="kw-suggest">Sugerir termos pelos títulos</button><button class="btn" data-act="kw-cluster">Agrupar termos</button><button class="btn" data-act="kw-visibility">Calcular visibilidade</button><button class="btn" data-act="kw-cannibal">Detectar canibalização</button></div>
    <p class="muted small">Sugestões são extraídas do catálogo local, sem estimar volume de busca. Visibilidade usa apenas SERPs capturadas e não representa participação de mercado.</p>
    <div id="kw-intelligence-out" class="out"></div>`)
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
  const generation = viewRenderSequence;
  const accountId = state.accountId;
  const products = accountId ? await api('competitor.ownProduct.list', { accountId }) : [];
  const ownProductId = products.some((product) => product.id === state.ownProductId) ? state.ownProductId : products[0]?.id || '';
  const stats = accountId ? await api('competitor.stats', { accountId, ...(ownProductId ? { ownProductId } : {}) }) : null;
  if (generation === viewRenderSequence && accountId === state.accountId) state.ownProductId = ownProductId;
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
      <td><button class="btn tiny ${ownProductId === p.id ? 'primary' : ''}" data-act="own-select" data-id="${p.id}">Selecionar</button></td></tr>`),
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

let relationsRequestSequence = 0;
async function loadRelations() {
  const el = $('#relations-list');
  if (!el) return;
  const generation = ++relationsRequestSequence;
  const accountId = state.accountId;
  const ownProductId = state.ownProductId;
  const status = state.relationsStatus;
  const isCurrent = () => generation === relationsRequestSequence && el.isConnected && accountId === state.accountId && ownProductId === state.ownProductId && status === state.relationsStatus;
  if (!accountId) { el.innerHTML = '<div class="empty">Selecione uma loja.</div>'; return; }
  let rows;
  try {
    rows = await api('competitor.relations', { accountId, ...(ownProductId ? { ownProductId } : {}), ...(status ? { status } : {}) });
  } catch (err) {
    if (isCurrent()) el.innerHTML = `<div class="empty bad-text">${esc(err.message)}</div>`;
    return;
  }
  if (!isCurrent()) return;

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
  const accountId=state.accountId;
  const [topics,items,overview]=accountId?await Promise.all([
    api('voc.topics',{accountId}),api('voc.items',{accountId,limit:100}),api('voc.overview',{accountId,days:30}),
  ]):[[],[],null];
  const kinds={REVIEW:'Avaliação',QUESTION:'Pergunta',COMPLAINT:'Reclamação',RETURN_REASON:'Devolução',MESSAGE:'Mensagem'};
  const sources={A_PRIMARY_UI:'Marketplace',B_PLATFORM_EXPORT:'Exportação',F_USER_INPUT:'Registro manual'};
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
  + (overview?card('Pós-venda nos últimos 30 dias',table(['Tipo','Fonte','Registros','Com nota','Nota média'],overview.summary.map(row=>`<tr><td>${esc(kinds[row.kind]||row.kind)}</td><td>${esc(sources[row.source_class]||row.source_class)}</td><td>${num(row.count)}</td><td>${row.kind==='REVIEW'?num(row.rated):'—'}</td><td>${row.average_rating==null?'—':num(row.average_rating,2)}</td></tr>`),'Nenhum registro no período.')):'')
  + (overview?card('Histórico de reputação',table(['Captura','Nota','Avaliações','Cobertura'],overview.reputation.map(row=>`<tr><td>${dt(row.capturedAt)}</td><td>${row.rating==null?'—':num(row.rating,2)}</td><td>${row.reviewCount==null?'—':num(row.reviewCount)}</td><td>${row.partial?'Parcial':'Sem alerta na captura'}</td></tr>`),'Nenhuma captura no período.')+(overview.reputationTruncated?'<p class="muted">Exibindo as 100 capturas mais recentes.</p>':'')):'')
  + (overview?card('Motivos de devolução recorrentes',table(['Motivo informado','Fonte','Registros'],overview.returnReasons.map(row=>`<tr><td>${esc(row.reason)}</td><td>${esc(sources[row.source_class]||row.source_class)}</td><td>${num(row.count)}</td></tr>`),'Nenhum motivo com texto idêntico em dois ou mais registros.')+(overview.returnReasonsTruncated?'<p class="muted">Exibindo os 20 motivos mais frequentes.</p>':'')):'')
  + card('Feedback capturado por anúncio',table(['Tipo','Anúncio','Vínculo','Nota','Texto','Data'],items.map(item=>`<tr><td>${esc(item.kind)}</td><td>${esc(item.linked_external_id||item.external_listing_id||'—')}${item.listing_title?`<div class="muted small">${esc(item.listing_title)}</div>`:''}</td><td>${item.listing_id?'Vinculado':item.external_listing_id?'Aguardando anúncio':'Sem identificação'}</td><td>${esc(item.rating??'—')}</td><td>${esc(item.text_redacted)}</td><td>${dt(item.observed_at)}</td></tr>`),'Nenhum feedback capturado.'))
  + card('Temas detectados', table(['Tema', 'Ocorrências', 'Sentimento', 'Impacto'],
    (topics || []).map((t) => `<tr><td>${esc(t.label)}</td><td>${num(t.frequency)}</td>
      <td>${t.sentiment==null?'—':num(t.sentiment,2)}</td><td>${t.financial_impact_cents==null?'—':brl(t.financial_impact_cents)}</td></tr>`),
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
    <p class="muted small">Prioridade calculada por RICE/ICE, com risco, esforço e urgência registrados.</p>`)
  + card('Iniciativas', table(['Título', 'Score', 'Status','Atualizar'],
    (inits || []).map((i) => `<tr><td>${esc(i.title)}</td><td>${num(i.priority_score ?? i.rice_score, 1)}</td><td>${esc(i.status || '—')}</td><td><select data-act="initiative-status" data-id="${esc(i.id)}"><option value="BACKLOG" ${i.status==='BACKLOG'?'selected':''}>Backlog</option><option value="PLANNED" ${i.status==='PLANNED'?'selected':''}>Planejada</option><option value="IN_PROGRESS" ${i.status==='IN_PROGRESS'?'selected':''}>Em andamento</option><option value="BLOCKED" ${i.status==='BLOCKED'?'selected':''}>Bloqueada</option><option value="DONE" ${i.status==='DONE'?'selected':''}>Concluída</option><option value="CANCELLED" ${i.status==='CANCELLED'?'selected':''}>Cancelada</option></select></td></tr>`),
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
  const [runs, budget, memory, recommendations] = await Promise.all([
    api('agent.runs', {}).catch(() => []),
    api('agent.budget', {}).catch(() => null),
    api('agent.memory', {}).catch(() => []),
    api('agent.recommendations', { accountId: state.accountId || undefined, limit: 100 }).catch(() => []),
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
  + card('Análises operacionais por profundidade', `
    <div class="form-row"><label>Modo <select id="analysis-mode"><option value="RAPIDA">Rápida — 4 agentes</option><option value="PADRAO" selected>Padrão — 8 agentes</option><option value="FORENSE">Detalhada / Forense — 14 agentes por anúncio</option><option value="360">360° da conta — 14 agentes em todos os anúncios</option></select></label><label>Anúncio (opcional) <input id="analysis-listing" placeholder="ID interno ou deixe vazio"></label><label>Produto (opcional) <input id="analysis-product" placeholder="ID do produto canônico"></label><label>Janela <input id="analysis-days" type="number" min="1" max="365" value="30"></label><button class="btn primary" data-act="analysis-run">Executar análise</button></div>
    <div id="analysis-out" class="out"></div>
    <p class="muted small">A análise usa snapshots locais reais. Dados ausentes são explicitados; FORENSE/360 executam até 300 anúncios por chamada.</p>`)
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
  + card('Feedback e resultados das recomendações', table(['Diagnóstico','Ação sugerida','Confiança','Status','Registrar resultado'],
    (recommendations || []).map((r) => `<tr><td>${esc(r.diagnosis || '—')}</td><td>${esc(r.action_proposed || '—')}</td><td>${pct((Number(r.confidence)||0)*100)}</td><td>${badge(r.status || 'PROPOSTA')}</td><td><div class="actions"><button class="btn tiny" data-act="agent-feedback" data-id="${esc(r.id)}" data-decision="ACEITO">Aceitar</button><button class="btn tiny ghost" data-act="agent-feedback" data-id="${esc(r.id)}" data-decision="REJEITADO">Rejeitar</button><button class="btn tiny" data-act="agent-feedback-implemented" data-id="${esc(r.id)}">Implementada</button><button class="btn tiny ghost" data-act="agent-feedback" data-id="${esc(r.id)}" data-decision="FALHOU">Falhou</button></div></td></tr>`),
    'Nenhuma recomendação para a conta selecionada.'))
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
  const taskResult = await api('task.list', { accountId: state.accountId || undefined });
  const tasks = Array.isArray(taskResult) ? taskResult : (taskResult?.tasks || []);
  return card('Controles da fila', `<div class="actions"><button class="btn" data-act="task-refresh">Atualizar progresso</button></div>`) + card('Criar tarefa', `
    <div class="form-grid">
      <label>Nome <input id="tk-name" placeholder="Revisar títulos dos 10 anúncios"></label>
      <label>Tipo <select id="tk-type">
        <option value="edit_title">Editar título</option><option value="edit_description">Editar descrição</option></select></label>
      <label>Marketplace <select id="tk-mp"><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option></select></label>
      <label>Anúncio <input id="tk-listing" placeholder="MLB..."></label>
      <label>Modo <select id="tk-mode"><option value="DRAFT">Rascunho (revisão manual obrigatória)</option><option value="PUBLISH" disabled>Publicar (somente após rascunho e aprovação separada)</option></select></label>
      <label>Repetir <select id="tk-rec"><option value="">Não repetir</option><option value="1h">A cada hora</option><option value="6h">A cada 6 horas</option><option value="daily">Diário</option><option value="weekly">Semanal</option></select></label>
      <label>Agendar para <input id="tk-when" type="datetime-local"></label>
      <label>Intervalo entre caracteres (ms) <input id="tk-delay" type="number" min="0" max="250" step="5" value="0"></label>
      <div class="wide muted">A tarefa primeiro preenche um rascunho. Depois de concluída, um super_admin pode autorizar a publicação; cada anúncio exige confirmação final na aba ativa do marketplace. A extensão não publica em massa nem em segundo plano.</div>
      <label class="wide">Novo título (opcional) <input id="tk-title" placeholder="Título novo do anúncio"></label>
      <label class="wide">Acréscimo à descrição (opcional) <textarea id="tk-desc" rows="2" placeholder="Só acrescenta ao final: o texto original é preservado"></textarea></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="task-add">Criar</button></div>`)
  + card('Criar tarefa por desempenho', `
    <p class="muted small">Seleciona anúncios da conta atual usando o último snapshot disponível. Todos os critérios informados são obrigatórios; métricas ausentes não são tratadas como zero. Cria somente rascunhos para revisão manual.</p>
    <div class="form-grid">
      <label>Nome <input id="tkf-name" placeholder="Revisar anúncios com baixa conversão"></label>
      <label>Tipo <select id="tkf-type"><option value="edit_title">Rascunho de título</option><option value="edit_description">Rascunho de descrição</option></select></label>
      <label>GMV mínimo (R$) <input id="tkf-min-gmv" type="number" min="0" step="0.01"></label>
      <label>GMV máximo (R$) <input id="tkf-max-gmv" type="number" min="0" step="0.01"></label>
      <label>Pedidos mínimos <input id="tkf-min-orders" type="number" min="0" step="1"></label>
      <label>Visitas mínimas <input id="tkf-min-visits" type="number" min="0" step="1"></label>
      <label>Conversão máxima (%) <input id="tkf-max-cvr" type="number" min="0" max="100" step="0.01"></label>
      <label>Estoque máximo <input id="tkf-max-stock" type="number" min="0" step="1"></label>
      <label>Intervalo entre caracteres (ms) <input id="tkf-delay" type="number" min="0" max="250" step="5" value="0"></label>
      <label class="wide">Modelo de título (use {title} e {externalId}) <input id="tkf-title" placeholder="Revisado: {title}"></label>
      <label class="wide">Acréscimo de descrição <textarea id="tkf-desc" rows="2"></textarea></label>
    </div>
    <div class="actions"><button class="btn" data-act="task-create-filtered" ${state.accountId ? '' : 'disabled'}>Encontrar anúncios e criar rascunhos</button><span id="tkf-result" class="muted small"></span></div>`)
  + card('Fila de tarefas', table(['Status / progresso', 'Tipo', 'Anúncio', 'Agendada', 'Publicação', 'Ações'],
    (tasks || []).map((t) => {
      const allDraftsReady = Array.isArray(t.items) && t.items.length > 0 && t.items.length <= 10 && t.items.every((item) => item.status === 'COMPLETED');
      const approvals = Array.isArray(t.publish_approvals) ? t.publish_approvals : [];
      const published = approvals.filter((approval) => approval.status === 'PUBLISHED');
      const canApprove = t.status === 'COMPLETED' && t.mode === 'DRAFT' && allDraftsReady && approvals.length === 0;
      return `<tr>
      <td>${badge(t.status, t.status === 'COMPLETED' ? 'ok' : t.status === 'FAILED' ? 'bad' : t.status === 'RUNNING' ? 'info' : 'neutral')}<div class="muted small">${num(t.progress?.finished || 0)}/${num(t.progress?.total || t.items_count || 0)} · ${num(t.progress?.percent || 0)}%</div></td>
      <td>${esc(t.kind)}</td><td>${esc(t.listing_id || '—')} (${esc(t.items_count ?? 0)} item(ns))</td><td>${dt(t.schedule_at)}</td>
      <td>${published.length ? `${published.length}/${t.items_count} publicado(s)` : approvals.length ? approvals.map((a) => esc(a.status)).join(', ') : 'rascunho'}</td>
      <td>
        <button class="btn tiny" data-act="task-run" data-id="${t.id}" ${['PENDING','SCHEDULED','PAUSED','FAILED','WAITING_BROWSER'].includes(t.status) && t.mode === 'DRAFT' ? '' : 'disabled'}>Executar rascunho</button>
        <button class="btn tiny primary" data-act="task-approve-publish" data-id="${t.id}" data-count="${t.items_count}" ${canApprove ? '' : 'disabled'}>Autorizar publicação</button>
        ${published.map((approval) => `<button class="btn tiny ghost" data-act="task-rollback" data-id="${approval.id}">Preparar rollback</button>`).join('')}
        ${(t.items || []).filter((item) => item.status === 'PROCESSING').map((item) => `<button class="btn tiny" data-act="task-recover-draft" data-id="${esc(item.id)}" data-account-id="${esc(item.account_id)}">Recuperar rascunho ${esc(item.external_id)}</button>`).join('')}
        <button class="btn tiny" data-act="task-pause" data-id="${t.id}" ${['RUNNING','WAITING_BROWSER','PENDING','SCHEDULED'].includes(t.status) ? '' : 'disabled'}>Pausar</button>
        <button class="btn tiny" data-act="task-resume" data-id="${t.id}" ${t.status === 'PAUSED' ? '' : 'disabled'}>Retomar</button>
        <button class="btn tiny" data-act="task-skip" data-id="${t.id}" ${['PENDING','SCHEDULED','WAITING_BROWSER','RUNNING','PAUSED'].includes(t.status) ? '' : 'disabled'}>Pular</button>
        <button class="btn tiny ghost" data-act="task-cancel" data-id="${t.id}" ${['COMPLETED','FAILED','CANCELLED'].includes(t.status) ? 'disabled' : ''}>Cancelar</button>
      </td></tr>`;
    }), 'Nenhuma tarefa.'));
}

// ------------------------------------------------------------------ CONECTORES
async function viewConnectors() {
  const [registry, imports] = await Promise.all([
    api('connector.registry', {}),
    state.accountId ? api('connector.import.list', { accountId: state.accountId, limit: 30 }) : Promise.resolve([]),
  ]);
  return card('Conectores opcionais', table(['Conector', 'Dados', 'Estado', 'Custo', 'Limites', 'Ação'],
    (registry || []).map((c) => `<tr><td>${esc(c.label || c.id)}</td><td>${esc(c.data_available || '—')}</td>
      <td>${badge(c.enabled ? 'HABILITADO' : (c.status || 'DESATIVADO'), c.enabled ? 'ok' : 'neutral')}
        ${c.last_test_at ? `<div class="muted small">${dt(c.last_test_at)} · ${esc(c.last_test_message)}</div>` : ''}</td>
      <td>${esc(c.cost_note || '—')}</td><td>${esc(c.limits || '—')}</td><td><div class="actions">
        <button class="btn tiny" data-act="connector-toggle" data-id="${esc(c.id)}" data-enabled="${c.enabled ? '1':'0'}" ${c.enabled || !c.requires_credentials || c.status === 'CONECTADO' ? '' : 'disabled'}>${c.enabled ? 'Desativar' : 'Habilitar'}</button>
        ${c.configured && ['google_analytics4','google_search_console'].includes(c.id) ? `<button class="btn tiny" data-act="connector-test" data-id="${esc(c.id)}">Testar</button>` : ''}
        <button class="btn tiny danger" data-act="connector-disconnect" data-id="${esc(c.id)}" data-label="${esc(c.label || c.id)}">Desconectar / limpar</button></div></td></tr>`),
    'Catálogo de conectores indisponível.'))
  + card('Conexões Google', `<div class="form-grid">
    <label>ID da propriedade GA4<input id="ga4-property" inputmode="numeric" maxlength="20"></label>
    <label>Token OAuth de leitura do GA4<input id="ga4-token" type="password" autocomplete="off" maxlength="5000"></label>
    <div class="wide actions"><button class="btn" data-act="connector-configure" data-id="google_analytics4">Salvar GA4</button></div>
    <label>Propriedade Search Console<input id="gsc-property" placeholder="sc-domain:dominio.com" maxlength="500"></label>
    <label>Token OAuth de leitura do Search Console<input id="gsc-token" type="password" autocomplete="off" maxlength="5000"></label>
    <div class="wide actions"><button class="btn" data-act="connector-configure" data-id="google_search_console">Salvar Search Console</button></div>
    </div><p class="muted small">Salve um token de acesso autorizado e teste a propriedade. Substitua o token quando expirar.</p>`)
  + card('Histórico de importações', table(['Arquivo','Tipo','Status','Linhas','Criado em'], (imports || []).map((job) => `<tr><td>${esc(job.file_name)}</td><td>${esc(job.file_type)}</td><td>${badge(job.status, job.status === 'IMPORTADO_VALIDADO' ? 'ok' : 'neutral')}</td><td>${num(job.rows_total)}</td><td>${dt(job.created_at)}</td></tr>`), 'Nenhuma importação para esta conta.'))
  + card('Importar relatório', `
    <div class="form-grid">
      <label class="wide">Arquivo CSV, XLSX ou PDF digital (máximo 2 MB) <input id="im-file" type="file" accept=".csv,.xlsx,.pdf"></label>
      <label>Tipo de relatório <select id="im-kind"><option value="ADS">Ads</option><option value="VENDAS">Vendas</option>
        <option value="KEYWORDS">Palavras-chave</option><option value="AVALIACOES">Avaliações</option></select></label>
      <label class="wide">Ou cole um CSV <textarea id="im-csv" rows="4" placeholder="coluna;valor&#10;cliques;120"></textarea></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="import">Interpretar e guardar para validação</button></div>
    <div id="import-out" class="out"></div>`);
}

// ------------------------------------------------------------------ BIBLIOTECA DE MÍDIA
async function viewMedia() {
  const items = await api('media.list', { accountId: state.accountId || undefined }).catch(() => []);
  return card('Adicionar imagem à biblioteca local', `
    <div class="form-grid"><label class="wide">Arquivo (JPEG, PNG, WEBP ou GIF; até 2,5 MB) <input id="media-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label><label class="wide">Texto alternativo <input id="media-alt" placeholder="Descrição da imagem"></label></div>
    <button class="btn primary" data-act="media-add">Salvar imagem</button>
    <p class="muted small">Os arquivos ficam no SQLite local, vinculados à conta selecionada. Nada é enviado para terceiros.</p>`)
    + card('Imagens armazenadas', `<div class="media-grid">${(items || []).map(m => `<div class="media-item"><div><strong>${esc(m.filename)}</strong><div class="muted small">${esc(m.mime_type)} · ${num(m.byte_size)} bytes · ${dt(m.created_at)}</div><div class="muted small">SHA-256: ${esc(m.sha256)}</div></div><div class="actions"><button class="btn tiny" data-act="media-preview" data-id="${esc(m.id)}" data-account-id="${esc(m.account_id || '')}">Visualizar</button><button class="btn tiny ghost" data-act="media-delete" data-id="${esc(m.id)}" data-account-id="${esc(m.account_id || '')}">Excluir</button></div><div id="media-${esc(m.id)}" class="out"></div></div>`).join('') || '<div class="empty">Nenhuma imagem cadastrada.</div>'}</div>`);
}

// ------------------------------------------------------------------ CONTAS E COMPARATIVO
async function viewAccounts() {
  const [accounts, products, skus] = await Promise.all([
    api('account.list', {}).catch(() => []),
    api('catalog.product.list', { accountId: state.accountId || undefined }).catch(() => []),
    api('catalog.sku.list', { accountId: state.accountId || undefined }).catch(() => []),
  ]);
  return card('Cadastrar / atualizar conta', `
    <div class="form-grid">
      <label>ID da conta <input id="ac-id" placeholder="ex.: ml:minhaloja"></label>
      <label>Marketplace <select id="ac-market"><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option><option value="amazon">Amazon</option></select></label>
      <label>Nome da loja <input id="ac-name" placeholder="Minha loja"></label>
      <label>Identificador / handle <input id="ac-handle" placeholder="@minhaloja"></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="account-save">Salvar conta</button></div>
    <p class="muted small">Conta cadastrada manualmente fica identificada como confirmada pelo usuário. A captura precisa ocorrer em uma página autenticada compatível.</p>`)
    + card('Contas cadastradas', table(['Loja','Marketplace','Confiança','Status','Ação'], (accounts || []).map(a => `<tr><td>${esc(a.display_name)}</td><td>${esc(a.marketplace)}</td><td>${Math.round((a.detection_confidence || 0)*100)}%</td><td>${a.is_active ? badge('Ativa','ok') : badge('Inativa','bad')}</td><td><button class="btn tiny" data-act="account-toggle" data-id="${esc(a.id)}" data-enabled="${a.is_active ? '1':'0'}">${a.is_active ? 'Desativar' : 'Ativar'}</button></td></tr>`), 'Nenhuma conta cadastrada.'))
    + card('Catálogo de produtos', `
      <div class="form-grid"><label>Nome <input id="cp-name"></label><label>Marca <input id="cp-brand"></label><label>Modelo <input id="cp-model"></label><label>Categoria <input id="cp-category"></label></div>
      <button class="btn" data-act="catalog-product-add">Cadastrar produto</button>
      <div class="form-grid" style="margin-top:12px"><label>SKU <input id="sku-code" placeholder="SKU-001"></label><label>Product ID (opcional) <input id="sku-product-id" placeholder="UUID do produto"></label><label>EAN <input id="sku-ean"></label><label>GTIN <input id="sku-gtin"></label><label>UPC <input id="sku-upc"></label></div>
      <button class="btn" data-act="catalog-sku-add">Cadastrar SKU</button>
      ${table(['Produto','Marca','Modelo','Categoria'], (products || []).map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.brand || '—')}</td><td>${esc(p.model || '—')}</td><td>${esc(p.category || '—')}</td></tr>`), 'Nenhum produto cadastrado.')}`)
    + card('SKUs cadastrados', table(['SKU','EAN','GTIN','UPC'], (skus || []).map(x => `<tr><td>${esc(x.sku_code)}</td><td>${esc(x.ean || '—')}</td><td>${esc(x.gtin || '—')}</td><td>${esc(x.upc || '—')}</td></tr>`), 'Nenhum SKU cadastrado.'));
}

function comparisonPreset(preset,now=new Date()){
  const today=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  const day=(offset)=>new Date(today.getTime()+offset*86400000).toISOString().slice(0,10);
  if(preset==='today')return [day(0),day(0),day(-1),day(-1)];
  if(preset==='7')return [day(-7),day(-1),day(-14),day(-8)];
  if(preset==='30')return [day(-30),day(-1),day(-60),day(-31)];
  if(preset==='month'){
    const year=today.getUTCFullYear(),month=today.getUTCMonth(),completed=today.getUTCDate()-1;
    if(completed===0)return null;
    const previousDays=new Date(Date.UTC(year,month,0)).getUTCDate();
    const count=Math.min(completed,previousDays);
    const date=(m,d)=>new Date(Date.UTC(year,m,d)).toISOString().slice(0,10);
    return [date(month,1),date(month,count),date(month-1,1),date(month-1,count)];
  }
  return null;
}
async function viewCompare() {
  const [comparison, accounts] = await Promise.all([
    api('kpi.compare', {}).catch(e => ({ error: e.message })),
    api('account.list', {}).catch(() => []),
  ]);
  if (comparison?.error) return card('Comparação indisponível', `<p>${esc(comparison.error)}</p>`);
  const [primaryFrom,primaryTo,comparisonFrom,comparisonTo]=comparisonPreset('30');
  return card('Comparação entre lojas e marketplaces', `
    <p class="muted small">Os totais ficam como indisponíveis quando existe anúncio sem captura — não tratamos dado ausente como zero.</p>
    ${table(['Loja','Marketplace','Anúncios','Capturados','GMV','Receita líquida','Comissão','Tarifa fixa','Pedidos','CVR','ROAS'], (comparison.accounts || []).map(a => `<tr><td>${esc(a.display_name)}</td><td>${esc(a.marketplace)}</td><td>${num(a.coverage.totalListings)}</td><td>${num(a.coverage.capturedListings)}</td><td>${brl(a.totals.gmvCents)}</td><td>${brl(a.totals.netRevenueCents)}</td><td>${brl(a.totals.commissionCents)}</td><td>${brl(a.totals.fixedFeeCents)}</td><td>${num(a.totals.orders)}</td><td>${pct(a.totals.cvr)}</td><td>${num(a.totals.roas,2)}</td></tr>`), 'Cadastre contas e capture anúncios para comparar.')}`)
    + card('Comparação por período, produto ou anúncio', `
      <div class="form-grid">
        <label>Conta<select id="cmp-account"><option value="">Todas as contas</option>${(accounts || []).filter(a=>a.is_active!==0).map(a=>`<option value="${esc(a.id)}" ${a.id===state.accountId?'selected':''}>${esc(a.display_name)} · ${esc(a.marketplace)}</option>`).join('')}</select></label>
        <label>Janela de captura (UTC)<select id="cmp-preset"><option value="30">30 dias completos vs anteriores</option><option value="7">7 dias completos vs anteriores</option><option value="today">Hoje vs ontem (hoje parcial)</option><option value="month">Mês até ontem vs dias equivalentes</option><option value="custom">Personalizada</option></select></label>
        <label>Marketplace<select id="cmp-marketplace"><option value="">Todos</option><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option><option value="amazon">Amazon</option></select></label>
        <label>ID interno do anúncio (opcional)<input id="cmp-listing-id" maxlength="200"></label><label>ID interno do SKU (opcional)<input id="cmp-sku-id" maxlength="200"></label>
        <label>Agrupar por<select id="cmp-group"><option value="listing">Anúncio</option><option value="product">Produto</option><option value="account">Loja</option><option value="marketplace">Marketplace</option></select></label>
        <label>Período atual — início<input id="cmp-primary-from" type="date" value="${primaryFrom}"></label>
        <label>Período atual — fim<input id="cmp-primary-to" type="date" value="${primaryTo}"></label>
        <label>Período anterior — início<input id="cmp-previous-from" type="date" value="${comparisonFrom}"></label>
        <label>Período anterior — fim<input id="cmp-previous-to" type="date" value="${comparisonTo}"></label>
      </div>
      <div class="actions"><button class="btn primary" data-act="compare-detail">Comparar períodos</button></div>
      <div id="compare-detail-out"></div>
      <p class="muted small">Usa o último snapshot de cada anúncio em cada janela de captura. Variações observadas não comprovam vendas realizadas no período; a comparação com filtros compatíveis exige janelas equivalentes, anúncios idênticos e datas explícitas da origem; isso não prova a integralidade das vendas. Métricas incompletas permanecem indisponíveis. Produto sem SKU/produto canônico é separado pelo anúncio.</p>`)
    + card('Cobertura consolidada', `<div class="kpi-grid"><div class="kpi"><div class="l">Lojas</div><div class="v">${num(comparison.accounts?.length || 0)}</div></div><div class="kpi"><div class="l">Anúncios</div><div class="v">${num(comparison.coverage?.totalListings || 0)}</div></div><div class="kpi"><div class="l">Capturados</div><div class="v">${num(comparison.coverage?.capturedListings || 0)}</div></div><div class="kpi"><div class="l">Sem captura</div><div class="v">${num(comparison.coverage?.uncapturedListings || 0)}</div></div></div>`);
}

async function viewUsers() {
  const users = await api('user.list', {}).catch(e => ({ error: e.message }));
  if (users?.error) return card('Gestão de usuários', `<div class="note warn">${esc(users.error)}. Esta área exige o papel super_admin.</div>`);
  return card('Criar usuário', `
    <input id="us-id" type="hidden"><div class="form-grid"><label>Nome <input id="us-name"></label><label>E-mail <input id="us-email" type="email"></label><label>Senha nova (deixe vazia para manter) <input id="us-password" type="password"></label><label>Perfil <select id="us-role"><option value="operador">Operador</option><option value="visualizador">Visualizador</option><option value="super_admin">Super administrador</option></select></label></div>
    <button class="btn primary" data-act="user-save" id="us-save">Criar usuário</button>`)
    + card('Usuários do sistema', table(['Nome','E-mail','Papel','Status','Último acesso','Ação'], users.map(u => `<tr><td>${esc(u.display_name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.is_active ? badge('Ativo','ok') : badge('Inativo','bad')}</td><td>${dt(u.last_login_at)}</td><td><div class="actions"><button class="btn tiny" data-act="user-edit" data-id="${esc(u.id)}" data-name="${esc(u.display_name)}" data-email="${esc(u.email)}" data-role="${esc(u.role)}">Editar</button><button class="btn tiny" data-act="user-toggle" data-id="${esc(u.id)}" data-enabled="${u.is_active ? '1':'0'}">${u.is_active ? 'Desativar' : 'Ativar'}</button></div></td></tr>`), 'Nenhum usuário adicional.'));
}

// ------------------------------------------------------------------ ADMINISTRAÇÃO
async function viewAdmin() {
  const [audit, backups, settings, upgrades, analysisSchedules, reportSchedules] = await Promise.all([
    api('audit.list', {}).catch(() => []),
    api('backup.list', {}).catch(() => []),
    api('settings.get', {}).catch(() => ({})),
    api('autoupgrade.list', {}).catch(() => []),
    api('analysis.schedule.list', { accountId: state.accountId || undefined }).catch(() => []),
    api('report.schedule.list', { accountId: state.accountId || undefined }).catch(() => []),
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
    ${table(['Arquivo', 'Quando', 'Tamanho', 'Ação'], (backups || []).map((b) => `<tr>
      <td>${esc(String(b.path || '').split(/[\\/]/).pop() || b.id)}</td><td>${dt(b.created_at)}</td><td>${num(b.bytes)} B</td>
      <td><button class="btn tiny" data-act="backup-restore" data-id="${esc(b.id)}">Restaurar</button></td></tr>`), 'Nenhum backup.')}`)
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
  + card('Agendamento de análises e relatórios', `
    <div class="form-grid">
      <label>Tipo de rotina<select id="sc-kind"><option value="analysis">Análise da loja</option><option value="report">Relatório automático</option></select></label>
      <label>Cadência<select id="sc-cadence"><option value="1h">A cada hora</option><option value="6h">A cada 6 horas</option><option value="daily">Diária</option><option value="weekly">Semanal</option><option value="custom">Intervalo personalizado</option></select></label>
      <label id="sc-interval-wrap" hidden>Intervalo personalizado (minutos)<input id="sc-interval" type="number" min="15" max="43200" step="1" value="60"></label>
      <label id="sc-mode-wrap">Profundidade da análise<select id="sc-mode"><option value="RAPIDA">Rápida</option><option value="PADRAO" selected>Padrão</option><option value="FORENSE">Forense</option><option value="360">360° da conta</option></select></label>
      <label id="sc-days-wrap">Janela da análise (dias)<input id="sc-days" type="number" min="1" max="365" value="30"></label>
      <label id="sc-report-wrap" hidden>Tipo de relatório<select id="sc-report-type"><option value="EXECUTIVO">Executivo</option><option value="KPIS">KPIs</option><option value="CONCORRENCIA">Concorrência</option><option value="FINANCEIRO">Financeiro</option><option value="EXPERIMENTOS">Experimentos</option><option value="AUDITORIA">Auditoria global</option></select></label>
      <div class="wide muted small">As rotinas só leem dados locais. Análises e relatórios agendados não publicam anúncios nem alteram campanhas. Intervalos personalizados aceitam 15 a 43.200 minutos.</div>
    </div>
    <div class="actions"><button class="btn primary" data-act="schedule-create">Criar agendamento</button></div>
    <h3>Análises</h3>
    ${table(['Modo','Cadência','Próxima execução','Último estado','Falhas','Ação'], (analysisSchedules || []).map((a) => `<tr><td>${esc(a.mode)}</td><td>${a.interval_minutes ? `${num(a.interval_minutes)} min` : esc(a.cadence)}</td><td>${dt(a.next_run_at)}</td><td>${badge(a.last_status || 'AGUARDANDO', a.last_status === 'COMPLETED' ? 'ok' : a.last_status === 'FAILED' ? 'bad' : 'neutral')}${a.last_error ? `<div class="muted small">${esc(a.last_error)}</div>` : ''}</td><td>${num(a.consecutive_failures || 0)}/3</td><td><div class="actions"><button class="btn tiny" data-act="schedule-toggle" data-kind="analysis" data-id="${esc(a.id)}" data-enabled="${a.enabled ? '1':'0'}">${a.enabled ? 'Pausar' : 'Ativar'}</button><button class="btn tiny ghost" data-act="schedule-runs" data-kind="analysis" data-id="${esc(a.id)}">Histórico</button></div></td></tr>`), 'Nenhum agendamento de análise para esta conta.')}
    <div id="analysis-schedule-runs" class="out"></div>
    <h3>Relatórios</h3>
    ${table(['Tipo','Cadência','Próxima execução','Último estado','Falhas','Ação'], (reportSchedules || []).map((r) => `<tr><td>${esc(r.report_type)}</td><td>${r.interval_minutes ? `${num(r.interval_minutes)} min` : esc(r.cadence)}</td><td>${dt(r.next_run_at)}</td><td>${badge(r.last_status || 'AGUARDANDO', r.last_status === 'COMPLETED' ? 'ok' : r.last_status === 'FAILED' ? 'bad' : 'neutral')}${r.last_error ? `<div class="muted small">${esc(r.last_error)}</div>` : ''}</td><td>${num(r.consecutive_failures || 0)}/3</td><td><div class="actions"><button class="btn tiny" data-act="schedule-toggle" data-kind="report" data-id="${esc(r.id)}" data-enabled="${r.enabled ? '1':'0'}">${r.enabled ? 'Pausar' : 'Ativar'}</button><button class="btn tiny ghost" data-act="schedule-runs" data-kind="report" data-id="${esc(r.id)}">Histórico</button></div></td></tr>`), 'Nenhum agendamento de relatório para esta conta.')}
    <div id="report-schedule-runs" class="out"></div>
    <p class="muted small">Retentativas automáticas após falha: 5, 15 e 60 minutos. Depois da terceira falha, o próximo ciclo segue a cadência configurada. Horários perdidos são pulados sem executar uma fila acumulada em sequência.</p>
  `)
  + card('Relatório e exportação', `
    <div class="form-row">
      <label>Tipo <select id="rp-type"><option value="EXECUTIVO">Resumo executivo</option>
        <option value="KPIS">KPIs por anúncio</option><option value="CONCORRENCIA">Inteligência competitiva</option>
        <option value="FINANCEIRO">Financeiro/margem</option><option value="EXPERIMENTOS">Testes A/B</option>
        <option value="AUDITORIA">Auditoria</option></select></label>
      <label>Formato <select id="rp-fmt"><option value="csv">CSV</option><option value="xlsx">Excel XLSX</option><option value="json">JSON</option><option value="pdf">PDF (imprimir/salvar)</option></select></label>
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
    report = await prestartRoute('/api/prestart');
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

const SYNC_SCOPES = {
  ACCOUNT: 'Loja selecionada',
  ALL_ACTIVE_ACCOUNTS: 'Todas as lojas ativas',
  ALL_ENABLED_MARKETPLACES: 'Marketplaces habilitados',
};
const syncStatus = {
  QUEUED: 'Na fila', WAITING_BROWSER: 'Aguardando navegador', RUNNING: 'Em andamento',
  COMPLETED: 'Concluído', PARTIAL: 'Parcial', FAILED: 'Falhou', SKIPPED: 'Ignorado',
  CANCELLED: 'Cancelado',
};
const syncLabel = (status) => syncStatus[status] ?? status ?? '—';
const OPERATION_MODES = {
  MANUAL_GUIDED: 'Manual guiado',
  AUTO_ASSISTED: 'Automático com revisão',
  AUTO_PILOT: 'Automático contínuo',
};
let selectedSyncBatch = '';
let loadingSyncProgress = false;

async function viewBrowserSync() {
  const [connection, schedules, batches, operation] = await Promise.all([
    prestartRoute('/api/prestart/extension').catch((error) => ({ error: error.message })),
    api('sync.schedule.list', {}),
    api('sync.list', { limit: 30 }),
    api('operation.mode.get', {}),
  ]);
  const memory=state.accountId?await api('navigation.summary',{accountId:state.accountId}).catch(error=>({error:error.message})):null;
  const navigationCard=card('Inteligência de navegação',!memory?'<p class="muted">Selecione uma loja para consultar sua memória.</p>':memory.error?'<p>'+esc(memory.error)+'</p>':
    '<p><strong>'+memory.routes.length+'</strong> rotas demonstradas · <strong>'+memory.transitions.length+'</strong> transições observadas · <strong>'+memory.actions.length+'</strong> tipos de ações internas.</p>'
    +'<p class="muted small">Use o painel lateral para ensinar ou apagar a memória. A extensão prioriza apenas links de leitura reconhecidos. Contagem de observações não é garantia de cobertura.</p>'
    +table(['Área','Rota','Demonstrações','Última observação'],memory.routes.map(r=>'<tr><td>'+esc(r.page_kind)+'</td><td>'+esc(r.origin+r.route)+'</td><td>'+esc(r.observations)+'</td><td>'+dt(r.last_seen_at)+'</td></tr>'),'Nenhuma rota demonstrada.')
    +table(['Origem','Destino','Observações'],memory.transitions.map(r=>'<tr><td>'+esc(r.from_route)+'</td><td>'+esc(r.to_route)+'</td><td>'+esc(r.observations)+'</td></tr>'),'Nenhuma transição observada.')
    +table(['Rota','Ação observada','Observações'],memory.actions.map(r=>'<tr><td>'+esc(r.route)+'</td><td>'+esc(r.action_kind)+'</td><td>'+esc(r.observations)+'</td></tr>'),'Nenhuma ação interna observada.'));
  const transport = connection.diagnosis;
  return navigationCard + card('Conexão com a extensão', `
    <p>${connection.error ? esc(connection.error) : connection.connected ? 'A extensão respondeu ao serviço local.' : 'Aguardando sinal da extensão.'}</p>
    <dl>
      <dt>Último sinal</dt><dd>${dt(connection.lastSeenAt)}</dd>
      <dt>Versão</dt><dd>${esc(connection.version || '—')}</dd>
      <dt>Marketplace identificado</dt><dd>${esc(connection.marketplace || '—')}</dd>
      <dt>HTTP local</dt><dd>${transport?.http?.ok ? 'Disponível' : 'Aguardando diagnóstico'}</dd>
      <dt>Host nativo</dt><dd>${transport?.nativeHost ? (transport.nativeHost.ok ? 'Disponível' : 'Falhou no diagnóstico') : 'Teste no painel lateral da extensão'}</dd>
    </dl>
    <div class="actions"><button class="btn" data-act="browser-sync-refresh">Atualizar</button>
    <a class="btn ghost" href="/prestart">Configurar e diagnosticar</a></div>
  `)
  + card('Perfil global de operação', `
    <div class="form-row"><label>Modo <select id="browser-operation-mode">${Object.entries(OPERATION_MODES).map(([value,label]) =>
      `<option value="${value}" ${value === operation.mode ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
    <button class="btn" data-act="browser-operation-save">Salvar perfil</button></div>
    <p class="muted small">O perfil define a política de análise. Configure a frequência nas rotinas de coleta, análise e relatório.</p>
  `)
  + card('Solicitar coleta no navegador', `
    <p class="muted small">O worker recebe a solicitação quando a extensão estiver aberta. Abra as abas de vendedor autenticadas das lojas que deseja coletar.</p>
    <div class="form-grid">
      <label>Escopo<select id="browser-sync-scope">${Object.entries(SYNC_SCOPES).map(([value, label]) => `<option value="${value}" ${value === 'ACCOUNT' && !state.accountId ? 'disabled' : ''}>${esc(label)}</option>`).join('')}</select></label>
      <label>Recorrência<select id="browser-sync-cadence"><option value="1h">A cada hora</option><option value="6h">A cada 6 horas</option><option value="daily">Diária</option><option value="weekly">Semanal</option><option value="custom">Personalizada</option></select></label>
      <label id="browser-sync-interval-wrap" hidden>Intervalo em minutos<input id="browser-sync-interval" type="number" min="15" max="43200" step="1" value="60"></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="browser-sync-request">Solicitar agora</button><button class="btn" data-act="browser-sync-schedule">Agendar coleta</button></div>
    <p class="muted small">Coleta avançada: selecione uma loja, abra sua lista de anúncios e mantenha a página inicial e os filtros para retomar. Processa até cinco novas páginas por execução, até 50 por lote lógico.</p>
    <button class="btn" data-act="browser-sync-advanced" ${state.accountId?'':'disabled'}>Solicitar coleta avançada de anúncios</button>
  `)
  + card('Agendamentos de coleta', table(['Escopo','Próxima execução','Último estado','Ações'], schedules.map((schedule) => `<tr>
    <td>${esc(SYNC_SCOPES[schedule.scope])}${schedule.account_id ? `<div class="small muted">${esc(schedule.account_id)}</div>` : ''}</td>
    <td>${dt(schedule.next_run_at)}</td><td>${schedule.enabled ? esc(syncLabel(schedule.last_status)) : 'Pausado'}</td>
    <td><div class="actions"><button class="btn tiny" data-act="browser-sync-toggle" data-id="${esc(schedule.id)}" data-enabled="${schedule.enabled}">${schedule.enabled ? 'Pausar' : 'Reativar'}</button>
    <button class="btn tiny ghost" data-act="browser-sync-runs" data-id="${esc(schedule.id)}">Histórico</button></div></td></tr>`), 'Nenhuma coleta agendada.'))
  + '<div id="browser-sync-runs" class="out"></div>'
  + card('Lotes recentes', table(['Solicitação','Origem','Escopo','Modo','Estado','Ações'], batches.map((batch) => `<tr>
    <td>${dt(batch.requested_at)}</td><td>${batch.browser_request ? 'Dashboard' : 'Extensão ou agenda'}</td>
    <td>${esc(SYNC_SCOPES[batch.scope])}</td><td>${batch.collection_mode==='ADVANCED_LISTINGS'?'Anúncios avançada':'Áreas autorizadas'}</td><td>${esc(syncLabel(batch.status))}</td>
    <td><div class="actions"><button class="btn tiny" data-act="browser-sync-batch" data-id="${esc(batch.id)}">Ver progresso</button>
    ${['PARTIAL','FAILED'].includes(batch.status) ? `<button class="btn tiny ghost" data-act="browser-sync-retry" data-id="${esc(batch.id)}">Retomar pendências</button>` : ''}</div></td></tr>`), 'Nenhum lote de coleta.'))
  + '<div id="browser-sync-detail" class="out" aria-live="polite"></div>';
}

function browserSyncScope() {
  const scope = $('#browser-sync-scope').value;
  if (scope === 'ACCOUNT' && !state.accountId) throw new Error('Selecione uma loja.');
  return scope === 'ACCOUNT' ? { scope, accountId: state.accountId } : { scope };
}

let syncPageOffset=0;
let syncPageBatch='';
async function showBrowserSyncBatch() {
  const target = $('#browser-sync-detail');
  const batchId = selectedSyncBatch;
  if (!target || !batchId) return;
  if(syncPageBatch!==batchId){syncPageBatch=batchId;syncPageOffset=0;}
  const offset=syncPageOffset;
  const data = await api('sync.list', { batchId,compact:true,pageLimit:100,pageOffset:offset });
  if (!target.isConnected || selectedSyncBatch !== batchId || syncPageOffset!==offset) return;
  const rows = data.accounts.map((row) => `<tr><td>${esc(row.account_id)}</td><td>${esc(row.marketplace)}</td>
    <td>${esc(syncLabel(row.status))}</td><td>${num(row.pages_succeeded)}/${num(row.pages_scanned)}</td><td>${esc(row.error ?? '')}<div class="muted small">${num(row.pendingPages??0)} páginas na fila${row.unsupportedLinks?' · cobertura exige revisão manual':''}${row.stoppedReason?` · ${esc(row.stoppedReason)}`:''}</div></td></tr>`);
  const pages = data.pageRuns.map((row) => `<tr><td>${esc(row.account_id)}</td><td>${num(row.page_no)}${row.spa_page?` · SPA ${num(row.spa_page)}`:''}</td>
    <td>${esc(row.page_kind)}</td><td>${esc(syncLabel(row.status))}</td><td>${esc(row.error ?? '')}</td></tr>`);
  const content = card(`Progresso do lote · ${esc(syncLabel(data.batch?.status))}`,
    table(['Conta','Marketplace','Estado','Páginas concluídas','Observação'], rows) +
    table(['Conta','Página','Área','Estado','Observação'], pages, 'Nenhuma página registrada.')+`<div class="actions"><button class="btn" data-act="browser-sync-prev-page" ${offset===0?'disabled':''}>Anteriores</button><span>${data.totalPageRuns?offset+1:0}–${Math.min(offset+100,data.totalPageRuns??0)} de ${num(data.totalPageRuns??0)}</span><button class="btn" data-act="browser-sync-next-page" ${offset+100>=(data.totalPageRuns??0)?'disabled':''}>Próximas</button></div>`);
  const signature = JSON.stringify([batchId, data.batch?.status, offset, data.totalPageRuns, rows, pages]);
  target.querySelector('[data-sync-error]')?.remove();
  if (target.dataset.signature === signature) return;
  target.dataset.signature = signature;
  target.dataset.active = String(['QUEUED','RUNNING'].includes(data.batch?.status));
  target.innerHTML = content;
  initializeTables(target);
}

// ------------------------------------------------------------------ roteador de views
function observedAdsMetrics(metrics){
  const known=k=>typeof metrics?.[k]==='number'&&Number.isFinite(metrics[k])&&metrics[k]>=0?metrics[k]:null;
  const spend=known('adSpend'),revenue=known('adAttributedRevenue'),clicks=known('adClicks'),impressions=known('paidImpressions'),orders=known('adAttributedOrders');
  return {spend,revenue,clicks,impressions,orders,roas:spend!==null&&spend>0&&revenue!==null?revenue/spend:null,acos:revenue!==null&&revenue>0&&spend!==null?spend/revenue*100:null,ctr:impressions!==null&&impressions>0&&clicks!==null?clicks/impressions*100:null,cpc:clicks!==null&&clicks>0&&spend!==null?spend/clicks:null,signal:spend!==null&&spend>0&&revenue===0?'INVESTIMENTO_SEM_RECEITA_ATRIBUIDA':spend!==null&&revenue!==null&&spend>revenue?'INVESTIMENTO_SUPERIOR_RECEITA_ATRIBUIDA':null};
}
function operationDates(){
  const to=new Date(Date.now()-86400000).toISOString().slice(0,10),from=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  return {from,to};
}
const opFilters={ads:{...operationDates(),kind:'',externalId:''},profit:operationDates(),inventory:{days:30}};
function operationDateInputs(prefix,filter){
  return '<label>Início (UTC)<input type="date" id="'+prefix+'-from" value="'+esc(filter.from)+'"></label><label>Fim (UTC)<input type="date" id="'+prefix+'-to" value="'+esc(filter.to)+'"></label>';
}
function operationInterval(prefix){
  const from=$('#'+prefix+'-from').value,to=$('#'+prefix+'-to').value;
  if(!from||!to||from>to)throw Error('Informe datas válidas.');
  return {from,to};
}
const operationRange=f=>({from:f.from+'T00:00:00.000Z',to:f.to+'T23:59:59.999Z'});
async function viewAds(){
  const accountId=state.accountId;
  if(!accountId)return card('Publicidade e campanhas','<p class="muted">Selecione uma loja para consultar dados de Ads.</p>');
  const f={...opFilters.ads};
  const [result,proposals,budgetRuns]=await Promise.all([
    api('ads.dashboard',{accountId,...operationRange(f),kind:f.kind||undefined,externalId:f.externalId||undefined}),
    api('campaign.change.list',{accountId,limit:100}),api('campaign.budget.list',{accountId})
  ]);
  const money=n=>n===null?'—':brl(Math.round(n*100));
  const display=(rows)=>table(['Identificador','Campanha pai','Investimento','Receita atribuída','Cliques','Impressões','Pedidos atribuídos','ROAS','ACoS','CTR','CPC','Lucro atribuído informado','Sinal','Período e origem','Captura'],rows.map(r=>{
    const m=observedAdsMetrics(r.metrics);
    return '<tr><td>'+esc(r.label||r.external_id)+'<div class="muted small">'+esc(r.external_id)+'</div><div class="muted small">Snapshot: '+esc(r.id)+'</div></td><td>'+esc(r.parent_external_id||'—')+'</td><td>'+money(m.spend)+'</td><td>'+money(m.revenue)+'</td><td>'+num(m.clicks)+'</td><td>'+num(m.impressions)+'</td><td>'+num(m.orders)+'</td><td>'+num(m.roas,2)+'</td><td>'+pct(m.acos)+'</td><td>'+pct(m.ctr)+'</td><td>'+money(m.cpc)+'</td><td>'+brl(r.profitCents)+(r.profitSource?'<div class="muted small">'+esc(r.profitSource)+'</div>':'')+'</td><td>'+esc(r.verified?(r.signal||m.signal||'—'):'Janela não comprovada')+'</td><td>'+esc(r.context?.filtersAndPeriod||'Não comprovado')+' · '+esc(r.source_class)+'</td><td>'+dt(r.captured_at)+'</td></tr>';
  }),'Nenhuma observação disponível. Capture a área de publicidade na extensão.');
  return card('Publicidade — observações por loja','<div class="form-grid">'+operationDateInputs('ads',f)+'<label>Tipo<select id="ads-kind">'+[['','Todos'],['AD_CAMPAIGN','Campanha'],['AD','Anúncio']].map(([v,l])=>'<option value="'+v+'" '+(f.kind===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label><label>Identificador externo<input id="ads-external" maxlength="200" value="'+esc(f.externalId)+'"></label></div><button class="btn" data-act="ads-filter">Aplicar filtros</button><p>TACoS da loja: '+pct(result.tacosPct)+'</p><p class="muted small">Última observação por entidade, até 500 snapshots de origem; não soma campanhas e anúncios. '+(result.truncated?'Limite de consulta atingido. ':'')+'TACoS exige janelas e escopos compatíveis; cobertura integral não comprovada.</p><button class="btn" data-act="nav" data-view="browserSync">Abrir coletas</button>')
    +card('Campanhas',display(result.items.filter(r=>r.kind==='AD_CAMPAIGN')))+card('Anúncios patrocinados',display(result.items.filter(r=>r.kind==='AD')))
    +card('Conciliação de campanha','<p class="muted small">Valores atribuídos ao mesmo escopo e período do snapshot. Informe receita líquida e custos que ainda não foram deduzidos, sem duplicar descontos. O investimento vem da observação; não estime o lucro nem o impacto incremental.</p><div class="form-grid"><label>Snapshot da campanha<select id="ads-reconcile-snapshot"><option value="">Selecione</option>'+result.items.filter(r=>r.kind==='AD_CAMPAIGN'&&r.verified).map(r=>'<option value="'+esc(r.id)+'">'+esc(r.label||r.external_id)+' · '+dt(r.captured_at)+'</option>').join('')+'</select></label><label>Receita líquida atribuída (R$)<input id="ads-net" inputmode="decimal"></label>'+REALIZED_FIELDS.filter(([key])=>!['netRevenueCents','adSpendCents'].includes(key)).map(([key,label])=>'<label>'+esc(label)+' (R$)<input id="ads-cost-'+esc(key)+'" inputmode="decimal"></label>').join('')+'<label>Referência da conciliação<input id="ads-source" maxlength="1000"></label></div><button class="btn" data-act="ads-reconcile">Registrar conciliação</button>')
    +card('Anúncios para revisar investimento',table(['Anúncio','Estoque','Investimento','Receita atribuída','Pedidos atribuídos','Lucro registrado','Período'],result.listingCandidates.map(r=>'<tr><td>'+esc(r.label)+'</td><td>'+num(r.stock)+'</td><td>'+money(r.spend)+'</td><td>'+money(r.revenue)+'</td><td>'+num(r.orders)+'</td><td>'+brl(r.profitCents)+'</td><td>'+esc(r.window.from)+' a '+esc(r.window.to)+'</td></tr>'),'Nenhum anúncio com evidências simultâneas suficientes.')+'<p class="muted small">Revisar investimento não é ordem de aumentar verba. Margem incremental não comprovada.</p>')
    +card('Propor alteração de campanha','<p class="muted small">Rascunho local. Para orçamento diário assistido, informe apenas dailyBudgetCents (centavos) em ambos os objetos. Para pausar ou reativar, use status ACTIVE ou PAUSED em cada objeto e mantenha dailyBudgetCents igual. Aprovação não executa; abra a extensão na campanha e configure limites na tela Anúncios &amp; Variações.</p><div class="form-grid"><label>Marketplace<select id="campaign-market"><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option><option value="amazon">Amazon</option></select></label><label>Campanha (ID externo)<input id="campaign-ref" maxlength="200"></label><label>Estado observado (JSON)<textarea id="campaign-baseline" rows="3"></textarea></label><label>Alterações propostas (JSON)<textarea id="campaign-changes" rows="3"></textarea></label><label>Motivo<input id="campaign-reason" maxlength="2000"></label></div><button class="btn" data-act="campaign-prepare">Salvar proposta</button>')
    +card('Propostas de campanhas',table(['Campanha','Alteração proposta','Status','Revisão'],proposals.map(p=>'<tr><td>'+esc(p.campaign_ref)+'<div class="muted small">Proposta: '+esc(p.id)+'</div></td><td>'+esc(JSON.stringify(p.changes))+'</td><td>'+esc(p.status)+'</td><td>'+(p.status==='DRAFT'?'<button class="btn tiny" data-act="campaign-review" data-id="'+esc(p.id)+'" data-decision="APPROVED">Aprovar</button> <button class="btn tiny" data-act="campaign-review" data-id="'+esc(p.id)+'" data-decision="REJECTED">Rejeitar</button>':p.status==='APPROVED'&&!budgetRuns.some(r=>r.proposal_id===p.id)?operationReceiptAction('CAMPAIGN',p.id):'—')+'</td></tr>'),'Nenhuma proposta.'))
    +card('Execuções assistidas de campanha',table(['Proposta','Campanha','Antes','Aprovado','Estado','Data'],budgetRuns.map(r=>'<tr><td>'+esc(r.proposal_id)+'</td><td>'+esc(r.campaign_ref)+'</td><td>'+(r.before_campaign_status?esc(r.before_campaign_status)+' · ':'')+brl(r.before_cents)+'</td><td>'+(r.target_campaign_status?esc(r.target_campaign_status)+' · ':'')+brl(r.target_cents)+'</td><td>'+esc(r.status)+'</td><td>'+dt(r.updated_at)+(r.status==='UI_READBACK_MATCHED'?'<div>'+operationMeasureAction('CAMPAIGN',r.proposal_id)+'</div>':'')+'</td></tr>'),'Nenhuma tentativa.')+'<p class="muted small">UI_READBACK_MATCHED indica valor observado após recarga, não causalidade. Confira no painel lateral; não repita tentativa incerta.</p><div id="operation-measure-out" class="out" aria-live="polite"></div>');
}
async function viewProfitability(){
  if(!state.accountId)return card('Rentabilidade','<p class="muted">Selecione uma loja.</p>');
  const f={...opFilters.profit},range=operationRange(f);
  const result=await api('finance.profitability',{accountId:state.accountId,periodStart:range.from,periodEnd:range.to});
  return card('Rentabilidade realizada','<div class="form-grid">'+operationDateInputs('profit',f)+'</div><button class="btn" data-act="profit-filter">Aplicar intervalo exato</button><p class="muted small">'+esc(result.method)+'</p><button class="btn" data-act="nav" data-view="finance">Registrar conciliação</button>')
    +card('Anúncios e margem negativa',table(['Anúncio','SKU','Receita líquida','Lucro registrado','Margem','Situação'],result.listings.map(r=>'<tr><td>'+esc(r.title||r.external_id)+'</td><td>'+esc(r.sku_id||'—')+'</td><td>'+brl(r.netRevenueCents)+'</td><td>'+brl(r.profitCents)+'</td><td>'+pct(r.marginPct)+'</td><td>'+esc(r.negative?'MARGEM NEGATIVA / PREJUÍZO':r.status)+'</td></tr>'),'Nenhum anúncio.'))
    +card('Comparação entre produtos',table(['Produto','Anúncios conhecidos','Receita líquida','Lucro','Margem'],result.products.map(r=>'<tr><td>'+esc(r.label)+'</td><td>'+num(r.knownListings)+' / '+num(r.listingCount)+'</td><td>'+brl(r.netRevenueCents)+'</td><td>'+brl(r.profitCents)+'</td><td>'+pct(r.marginPct)+'</td></tr>'),'Nenhum produto vinculado.'));
}
async function viewInventory(){
  if(!state.accountId)return card('Estoque','<p class="muted">Selecione uma loja.</p>');
  const days=opFilters.inventory.days;
  const result=await api('inventory.dashboard',{accountId:state.accountId,days});
  return card('Estoque e operação','<label>Recência da captura<select id="inventory-days">'+[1,7,30,90,365].map(d=>'<option value="'+d+'" '+(days===d?'selected':'')+'>'+d+' dias</option>').join('')+'</select></label><button class="btn" data-act="inventory-filter">Aplicar</button><p class="muted small">'+esc(result.method)+(result.truncated?' Histórico limitado aos registros mais recentes.':'')+'</p>')
    +card('Estoque por anúncio e SKU',table(['Anúncio','SKU','Estoque','Unidades observadas','Cobertura (dias)','Investimento Ads','Perguntas pendentes','Sinais','Captura'],result.items.map(r=>'<tr><td>'+esc(r.title||r.external_id)+'</td><td>'+esc(r.sku_id||'—')+'</td><td>'+num(r.stock)+'</td><td>'+num(r.units)+'</td><td>'+num(r.coverageDays,1)+'</td><td>'+brl(r.adSpend===null?null:Math.round(r.adSpend*100))+'</td><td>'+num(r.questionsPending)+'</td><td>'+esc(r.signals.join(', ')||'—')+'</td><td>'+dt(r.capturedAt)+'</td></tr>'),'Nenhum anúncio.'))
    +card('Histórico de estoque',table(['Anúncio','SKU','Estoque','Origem','Data'],result.history.map(r=>'<tr><td>'+esc(r.external_id)+'</td><td>'+esc(r.sku_id||'—')+'</td><td>'+num(r.stock)+'</td><td>'+esc(r.source_class)+'</td><td>'+dt(r.captured_at)+'</td></tr>'),'Nenhum snapshot.'))
    +card('Armazéns e estoque observado',table(['Identificador','Entidade pai','Estoque','Data'],result.warehouses.map(r=>'<tr><td>'+esc(r.external_id)+'</td><td>'+esc(r.parent_external_id||'—')+'</td><td>'+num(r.metrics.stockAvailable)+'</td><td>'+dt(r.captured_at)+'</td></tr>'),'Nenhum armazém observado.'))
    +card('Questões e problemas operacionais',table(['Área','Indicadores observados','Período/filtros','Data'],result.areas.map(r=>'<tr><td>'+esc(r.page_kind)+'</td><td>'+esc(JSON.stringify(r.metrics))+'</td><td>'+esc(r.evidence.filtersAndPeriod||'Não comprovado')+'</td><td>'+dt(r.captured_at)+'</td></tr>'),'Nenhuma observação da área operacional.'));
}
function operationMeasureAction(kind,id){
  return '<button class="btn tiny" data-act="operation-measure" data-kind="'+esc(kind)+'" data-id="'+esc(id)+'">Medir antes/depois</button>';
}
function operationReceiptAction(kind,id){
  return '<button class="btn tiny" data-act="operation-receipt" data-kind="'+esc(kind)+'" data-id="'+esc(id)+'">Registrar execução manual</button>';
}
async function viewProductOperations(){
  const accountId=state.accountId;
  if(!accountId)return card('Anúncios e variações','<p class="muted">Selecione uma loja.</p>');
  const [proposals,variants,media,receipts,attempts,limitsResult]=await Promise.all([api('listing.change.list',{accountId}),api('offer.variation.list',{accountId}),api('media.list',{accountId}),api('operation.receipt.list',{accountId}),api('listing.browser.list',{accountId}),api('operation.limits.get',{accountId})]);
  const limits=limitsResult.limits||{};
  const limitFields=[['maxCampaignDailyBudgetCents','Teto diário por campanha (centavos)'],['minVariationPriceCents','Preço mínimo da variação (centavos)'],['maxVariationPriceCents','Preço máximo da variação (centavos)'],['maxVariationStock','Estoque máximo da variação'],['maxVariationPriceChangePct','Variação máxima do preço (%)']];
  const reviewed=(kind,row)=>row.status==='DRAFT'?'<button class="btn tiny" data-act="product-review" data-kind="'+kind+'" data-id="'+esc(row.id)+'" data-decision="APPROVED">Aprovar</button> <button class="btn tiny" data-act="product-review" data-kind="'+kind+'" data-id="'+esc(row.id)+'" data-decision="REJECTED">Rejeitar</button>':row.status==='APPROVED'&&!receipts.some(r=>r.proposal_kind===kind&&r.proposal_id===row.id)&&!attempts.some(r=>r.proposal_kind===kind&&r.proposal_id===row.id)?operationReceiptAction(kind,row.id):'—';
  return card('Limites de execução assistida por loja','<p class="muted small">Confirme os limites antes de executar orçamento ou variações. O teto é por campanha, não orçamento total da conta. Nenhuma ação automática em segundo plano.</p><div class="form-grid">'+limitFields.map(([k,label])=>'<label>'+esc(label)+'<input id="assisted-'+k+'" type="number" min="0" step="'+(k.endsWith('Pct')?'0.1':'1')+'" value="'+esc(limits[k]??'')+'"></label>').join('')+'</div><button class="btn" data-act="assisted-limits-save">Confirmar limites</button>')
    +card('Preparar capa ou duplicação','<p class="muted small">Propostas locais. Duplicação assistida somente na extensão do Mercado Livre quando o controle explícito estiver visível e autorizado. Troca de capa permanece manual. Confira se a plataforma permite duplicar.</p><div class="form-grid"><label>ID interno do anúncio<input id="product-listing"></label><label>Operação<select id="product-kind"><option value="COVER">Troca de capa</option><option value="DUPLICATE">Duplicação</option></select></label><label>Imagem da loja<select id="product-media"><option value="">Nenhuma</option>'+media.map(m=>'<option value="'+esc(m.id)+'">'+esc(m.filename)+'</option>').join('')+'</select></label><label>Motivo<input id="product-reason" maxlength="2000"></label></div><button class="btn" data-act="product-preview">Prévia da imagem</button> <button class="btn" data-act="product-prepare">Salvar rascunho</button><div id="product-preview-out" class="out" aria-live="polite"></div><p><button class="btn" data-act="nav" data-view="media">Biblioteca de imagens</button></p>')
    +card('Propostas de anúncios',table(['Anúncio','Tipo','Imagem','Estado','Revisão'],proposals.map(p=>'<tr><td>'+esc(p.title||p.external_id)+'<div class="muted small">Proposta: '+esc(p.id)+' · ID externo: '+esc(p.external_id)+'</div></td><td>'+esc(p.kind)+'</td><td>'+esc(p.filename||'—')+'</td><td>'+esc(p.status)+'</td><td>'+reviewed('LISTING_CHANGE',p)+'</td></tr>'),'Nenhuma proposta.'))
    +card('Gerenciar variações e ofertas','<p class="muted small">Rascunhos locais. Executor assistido experimental: criação simples com uma opção {&quot;name&quot;:&quot;Azul&quot;}; edição com {&quot;externalId&quot;:&quot;ID&quot;,&quot;beforePriceCents&quot;:1000,&quot;beforeStock&quot;:5}. Para edição, use o nome observado da variação; preço e estoque finais são obrigatórios.</p><div class="form-grid"><label>ID do rascunho para edição (opcional)<input id="variation-id"></label><label>ID interno do anúncio<input id="variation-listing"></label><label>Nome da variação<input id="variation-name" maxlength="120"></label><label>Opções (JSON: lista de objetos)<textarea id="variation-options" rows="4">[]</textarea></label><label>Preço (centavos, opcional)<input type="number" min="0" step="1" id="variation-price"></label><label>Estoque (opcional)<input type="number" min="0" step="1" id="variation-stock"></label></div><button class="btn" data-act="variation-save">Salvar rascunho</button>')
    +card('Propostas de variações',table(['ID','Anúncio','Nome','Opções','Status','Ações'],variants.map(p=>'<tr><td>'+esc(p.id)+'</td><td>'+esc(p.listing_id)+'</td><td>'+esc(p.variation_name)+'</td><td>'+esc(JSON.stringify(p.options))+'</td><td>'+esc(p.status)+'</td><td>'+reviewed('VARIATION',p)+(p.status==='DRAFT'?' <button class="btn tiny" data-act="variation-delete" data-id="'+esc(p.id)+'">Excluir</button>':'')+'</td></tr>'),'Nenhum rascunho.'))
    +card('Tentativas assistidas e conferência',table(['Proposta','Anúncio','Ação','Estado','Conferência'],attempts.map(r=>'<tr><td>'+esc(r.proposal_id)+'</td><td>'+esc(r.external_listing_id)+'</td><td>'+esc(r.action)+'</td><td>'+esc(r.status)+'</td><td>'+(['CLAIMED','NEEDS_VERIFICATION'].includes(r.status)?'<button class="btn tiny" data-act="listing-browser-verify" data-id="'+esc(r.proposal_id)+'">Conferir captura posterior</button>':['UI_READBACK_MATCHED','CANDIDATE_OBSERVED'].includes(r.status)?operationMeasureAction(r.proposal_kind,r.proposal_id):'—')+'</td></tr>'),'Nenhuma tentativa.')+'<p class="muted small">CANDIDATE_OBSERVED é uma nova entidade compatível observada, não prova de duplicação/criação. UI_READBACK_MATCHED indica campos observados correspondentes. Não repita cliques.</p>')
    +card('Execuções relatadas e medição',table(['Tipo','Proposta','Data','Referência','Conferência','Medição'],receipts.map(r=>{
      const canVerify=r.proposal_kind==='VARIATION'||proposals.some(p=>p.id===r.proposal_id&&p.kind==='DUPLICATE');
      const observationLabels={UI_READBACK_MATCHED:'Captura corresponde à proposta',CANDIDATE_OBSERVED:'Nova entidade compatível observada'};
      const check=r.observation?esc(observationLabels[r.observation.status]||r.observation.status)+'<div class="muted small">'+esc(r.observation.observedExternalId)+'</div>':canVerify?'<button class="btn tiny" data-act="operation-receipt-verify" data-kind="'+esc(r.proposal_kind)+'" data-id="'+esc(r.proposal_id)+'">Conferir captura</button>':'—';
      return '<tr><td>'+esc(r.proposal_kind)+'</td><td>'+esc(r.proposal_id)+'</td><td>'+dt(r.performed_at)+'</td><td>'+esc(r.evidence_reference)+'</td><td>'+check+'</td><td><button class="btn tiny" data-act="operation-measure" data-kind="'+esc(r.proposal_kind)+'" data-id="'+esc(r.proposal_id)+'">Medir antes/depois</button></td></tr>';
    }),'Nenhum relato humano.')+'<p class="muted small">A conferência registra o que a loja exibe após a operação. A medição exige janelas compatíveis.</p><div id="operation-measure-out" class="out" aria-live="polite"></div>');
}
const VIEWS = {
  exec: { label: 'Visão executiva', icon: '◧', render: viewExec },
  prestart: { label: 'Pré-Start & Diagnóstico', icon: '✓', render: viewPrestart },
  browserSync: { label: 'Extensão & Coletas', icon: '⇄', render: viewBrowserSync },
  listings: { label: 'Anúncios & Captura', icon: '▤', render: viewListings },
  finance: { label: 'Financeiro', icon: '⊞', render: viewFinance },
  ads: { label: 'Publicidade & Ads', icon: '◈', render: viewAds },
  profitability: { label: 'Rentabilidade', icon: '⊞', render: viewProfitability },
  inventory: { label: 'Estoque & Operação', icon: '▤', render: viewInventory },
  productOperations: { label: 'Anúncios & Variações', icon: '▤', render: viewProductOperations },
  keywords: { label: 'SEO & Keywords', icon: '⌕', render: viewKeywords },
  market: { label: 'Radar de mercado', icon: '◎', render: viewMarket },
  competition: { label: 'Concorrência', icon: '⚔', render: viewCompetition },
  pricing: { label: 'Preço & Ofertas', icon: '◈', render: viewPricing },
  voc: { label: 'Voz do cliente', icon: '☰', render: viewVoc },
  growth: { label: 'Growth Lab', icon: '⟳', render: viewGrowth },
  agents: { label: 'Agentes de IA', icon: '✦', render: viewAgents },
  tasks: { label: 'Tarefas', icon: '⧗', render: viewTasks },
  connectors: { label: 'Conectores', icon: '⇄', render: viewConnectors },
  accounts: { label: 'Contas & Catálogo', icon: '▣', render: viewAccounts },
  compare: { label: 'Comparativo', icon: '▥', render: viewCompare },
  media: { label: 'Biblioteca de imagens', icon: '▧', render: viewMedia },
  users: { label: 'Usuários', icon: '♙', render: viewUsers },
  admin: { label: 'Administração', icon: '⚙', render: viewAdmin },
};

function renderNav() {
  $('#nav').innerHTML = Object.entries(VIEWS).map(([key, v]) => `
    <button class="nav-item ${state.view === key ? 'active' : ''}" data-act="nav" data-view="${key}">
      <span class="nav-icon">${v.icon}</span>${esc(v.label)}
    </button>`).join('');
}

let viewRenderSequence = 0;
async function renderView() {
  const generation = ++viewRenderSequence;
  const selectedView = state.view;
  const selectedAccount = state.accountId;
  const isCurrent = () => generation === viewRenderSequence && selectedView === state.view && selectedAccount === state.accountId;
  const view = VIEWS[state.view] || VIEWS.exec;
  $('#view-title').textContent = view.label;
  const host = $('#view');
  host.innerHTML = '<div class="loading">Carregando…</div>';
  try {
    const content = await view.render();
    if (!isCurrent()) return false;
    host.innerHTML = content;
    initializeTables(host);
    if (state.view === 'competition') await loadRelations();
    if (state.view === 'browserSync') await showBrowserSyncBatch();
    return isCurrent();
  } catch (err) {
    if (isCurrent()) host.innerHTML = `<div class="empty bad-text">${esc(err.message)}</div>`;
    return false;
  }
}

// ------------------------------------------------------------------ ações
function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function excelColumn(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function makeSheetXml(rows, headers) {
  const allRows = [headers, ...rows.map((row) => headers.map((h) => row[h]))];
  const xmlRows = allRows.map((cells, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cellXml = cells.map((value, colIndex) => {
      const ref = `${excelColumn(colIndex)}${rowNumber}`;
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
      if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
      const textValue = value === null || value === undefined ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(textValue)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNumber}">${cellXml}</row>`;
  }).join('');
  const lastRef = `${excelColumn(Math.max(0, headers.length - 1))}${Math.max(1, allRows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastRef}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${xmlRows}</sheetData></worksheet>`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30); local.set(data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    central.set(name, 46); centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function createXlsxReport(report) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const keys = Array.from(rows.reduce((set, row) => { Object.keys(row || {}).forEach((key) => set.add(key)); return set; }, new Set()));
  const dataHeaders = keys.length ? keys : ['Informação'];
  const dataRows = keys.length ? rows : [{ Informação: 'Nenhum registro no período selecionado.' }];
  const sheets = [];
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : null;
  if (summary) {
    const summaryRows = Object.entries(summary).map(([Indicador, Valor]) => ({ Indicador, Valor }));
    sheets.push({ name: 'Resumo', xml: makeSheetXml(summaryRows, ['Indicador', 'Valor']) });
  }
  sheets.push({ name: 'Dados', xml: makeSheetXml(dataRows, dataHeaders) });
  const sheetOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const sheetNodes = sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const relNodes = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const files = [
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}</Types>` },
    { name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetNodes}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relNodes}</Relationships>` },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: sheet.xml })),
  ];
  return zipStored(files);
}

let compareRequestSequence=0;
const ACTIONS = {
  'browser-operation-save': async () => {
    await run(() => api('operation.mode.set', { mode: $('#browser-operation-mode').value }), 'Perfil global salvo.');
    await renderView();
  },
  'browser-sync-prev-page': async()=>{syncPageOffset=Math.max(0,syncPageOffset-100);await showBrowserSyncBatch();},
  'browser-sync-next-page': async()=>{syncPageOffset+=100;await showBrowserSyncBatch();},
  'browser-sync-refresh': renderView,
  'browser-sync-request': async () => {
    const result = await api('sync.createAll', { ...browserSyncScope(), browserRequest: true });
    selectedSyncBatch = result.batchId;
    toast('Solicitação registrada. Aguardando o navegador.');
    await renderView();
  },
  'browser-sync-advanced': async()=>{
    if(!state.accountId)throw new Error('Selecione uma loja.');
    const result=await api('sync.createAll',{scope:'ACCOUNT',accountId:state.accountId,browserRequest:true,collectionMode:'ADVANCED_LISTINGS'});
    selectedSyncBatch=result.batchId;toast('Coleta avançada registrada. Abra a lista de anúncios da loja.');await renderView();
  },
  'browser-sync-schedule': async () => {
    const cadence = $('#browser-sync-cadence').value;
    const intervalMinutes = Number($('#browser-sync-interval').value);
    await run(() => api('sync.schedule.create', {
      ...browserSyncScope(), cadence, ...(cadence === 'custom' ? { intervalMinutes } : {}),
    }), 'Coleta agendada.');
    await renderView();
  },
  'browser-sync-toggle': async ({ id, enabled }) => {
    await api('sync.schedule.setEnabled', { id, enabled: enabled !== '1' });
    await renderView();
  },
  'browser-sync-runs': async ({ id }) => {
    const target = $('#browser-sync-runs');
    const runs = await api('sync.schedule.runs', { scheduleId: id, limit: 30 });
    if (!target?.isConnected) return;
    target.innerHTML = card('Histórico do agendamento', table(['Agendado para','Estado','Observação','Lote'],
      runs.map((entry) => `<tr><td>${dt(entry.scheduled_at)}</td><td>${esc(syncLabel(entry.status))}</td><td>${esc(entry.error ?? '')}</td>
      <td>${entry.batch_id ? `<button class="btn tiny" data-act="browser-sync-batch" data-id="${esc(entry.batch_id)}">Ver progresso</button>` : '—'}</td></tr>`)));
    initializeTables(target);
  },
  'browser-sync-batch': async ({ id }) => {
    selectedSyncBatch = id;
    await showBrowserSyncBatch();
    $('#browser-sync-detail')?.scrollIntoView({ block: 'nearest' });
  },
  'browser-sync-retry': async ({ id }) => {
    const result = await api('sync.retryFailed', { batchId: id, browserRequest: true });
    selectedSyncBatch = result.batchId;
    toast('Repetição registrada. Aguardando o navegador.');
    await renderView();
  },
  nav: (d) => { state.view = d.view; renderNav(); renderView(); },
  'account-save': async () => {
    const id = $('#ac-id').value.trim(); const name = $('#ac-name').value.trim();
    if (!id || !name) throw new Error('Informe o ID e o nome da loja.');
    await run(() => api('account.upsert', { accountId: id, marketplace: $('#ac-market').value, displayName: name, handle: $('#ac-handle').value.trim() || undefined, confidence: 1, verifiedByUser: true }), 'Conta cadastrada.');
    await bootAccountSelector(); renderView();
  },
  'account-toggle': async (d) => { await run(() => api('account.setActive', { accountId: d.id, isActive: d.enabled !== '1' }), 'Status da conta atualizado.'); await bootAccountSelector(); renderView(); },
  'catalog-product-add': async () => {
    const name = $('#cp-name').value.trim(); if (!name) throw new Error('Informe o nome do produto.');
    await run(() => api('catalog.product.upsert', { accountId: state.accountId, name, brand: $('#cp-brand').value.trim() || null, model: $('#cp-model').value.trim() || null, category: $('#cp-category').value.trim() || null }), 'Produto cadastrado.'); renderView();
  },
  'catalog-sku-add': async () => {
    const sku = $('#sku-code').value.trim(); if (!sku) throw new Error('Informe o código do SKU.');
    await run(() => api('catalog.sku.upsert', { accountId: state.accountId, sku, productId: $('#sku-product-id').value.trim() || null, ean: $('#sku-ean').value.trim() || null, gtin: $('#sku-gtin').value.trim() || null, upc: $('#sku-upc').value.trim() || null, attributes: {} }), 'SKU cadastrado.'); renderView();
  },
  'user-save': async () => {
    const id = $('#us-id').value.trim(); const password = $('#us-password').value;
    const payload = { ...(id ? { id } : {}), displayName: $('#us-name').value.trim(), email: $('#us-email').value.trim(), role: $('#us-role').value, ...(password ? { password } : {}) };
    await run(() => api('user.upsert', payload), id ? 'Usuário atualizado.' : 'Usuário criado.'); renderView();
  },
  'user-edit': async (d) => {
    $('#us-id').value = d.id; $('#us-name').value = d.name; $('#us-email').value = d.email; $('#us-role').value = d.role; $('#us-password').value = '';
    $('#us-save').textContent = 'Salvar alterações'; $('#us-name').focus();
  },
  'user-toggle': async (d) => { await run(() => api('user.setActive', { userId: d.id, isActive: d.enabled !== '1' }), 'Status do usuário atualizado.'); renderView(); },
  'agent-feedback': async (d) => {
    const reason = window.prompt('Motivo ou observação (opcional):','');
    if (reason === null) return;
    const result = await run(() => api('agent.feedback', { recommendationId:d.id, decision:d.decision, reason:reason || undefined }), 'Feedback registrado.');
    if (result?.playbook) toast(`Playbook criado/atualizado com ${result.playbook.successes} resultados positivos observados.`);
    renderView();
  },
  'agent-feedback-implemented': async (d) => {
    const example = { success:true, measuredAt:new Date().toISOString(), baseline:{ orders:10 }, after:{ orders:12 }, sampleSize:100, source:'A_PRIMARY_UI', notes:'Substitua os valores pelo resultado real observado.' };
    const raw = window.prompt('Informe o JSON das métricas antes/depois. Use amostra e origem reais:', JSON.stringify(example));
    if (raw === null) return;
    let outcome;
    try { outcome = JSON.parse(raw); } catch { throw new Error('JSON de resultado inválido'); }
    if (outcome.notes === 'Substitua os valores pelo resultado real observado.') throw new Error('substitua os valores de exemplo pelos dados reais antes de registrar');
    const result = await run(() => api('agent.feedback', { recommendationId:d.id, decision:'IMPLEMENTADO', outcome }), 'Resultado observado registrado.');
    if (result?.playbook) toast(`Playbook criado/atualizado com ${result.playbook.successes} resultados positivos observados.`);
    renderView();
  },

  'analysis-run': async () => {
    const mode = $('#analysis-mode').value;
    const listingId = $('#analysis-listing').value.trim();
    const catalogProductId = $('#analysis-product').value.trim();
    if (listingId && catalogProductId) throw new Error('Escolha um anúncio ou produto, não ambos.');
    const result = await run(() => api('analysis.run', { mode, accountId: state.accountId || undefined, ...(listingId ? { listingId } : {}), ...(catalogProductId ? { catalogProductId } : {}), days: Number($('#analysis-days').value) || 30 }), 'Análise concluída.');
    $('#analysis-out').innerHTML = `<pre class="json">${esc(JSON.stringify(result, null, 2))}</pre>`;
  },

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
    const generation=viewRenderSequence,accountId=state.accountId,productId=state.ownProductId,status=state.relationsStatus;
    const out=document.querySelector(`[data-out="${CSS.escape(d.id)}"]`);
    if(!out)return;
    const [h,evidence]=await run(()=>Promise.all([
      api('competitor.monitoring.history',{relationId:d.id}),
      api('competitor.evidence.compare',{relationId:d.id,accountId}).catch(()=>null),
    ]))||[];
    if(!h||generation!==viewRenderSequence||accountId!==state.accountId||productId!==state.ownProductId||
       status!==state.relationsStatus||!out.isConnected)return;
    const difference=(value,format)=>value==null?'—':format(value);
    const comparison=evidence?table(['Indicador','Valor observado'],[
      ['Diferença de preço (concorrente menos próprio)',difference(evidence.priceDifferenceCents,brl)],
      ['Diferença de frete',difference(evidence.shippingDifferenceCents,brl)],
      ['Prazo mínimo',difference(evidence.deliveryDaysMinDifference,value=>num(value,1)+' dias')],
      ['Prazo máximo',difference(evidence.deliveryDaysMaxDifference,value=>num(value,1)+' dias')],
      ['Anúncio concorrente patrocinado',evidence.sponsored==null?'—':evidence.sponsored?'Sim':'Não'],
      ['Arquivos de imagem idênticos',num(evidence.images.identicalHashes)],
    ].map(([label,value])=>`<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`),'Sem evidências comparáveis.')+
    `<p class="muted small">${evidence.observedAt?'Captura: '+dt(evidence.observedAt)+' · ':''}${esc(evidence.images.explanation)}</p>`:'<p class="muted small">Comparativo de evidências indisponível.</p>';
    const pts = h.points || [];
    const max = Math.max(...pts.map((p) => p.price_cents || 0), h.ownPriceCents || 0, 1);
    out.innerHTML = `
      ${comparison}
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

  'assisted-limits-save': async()=>{
    const keys=['maxCampaignDailyBudgetCents','minVariationPriceCents','maxVariationPriceCents','maxVariationStock','maxVariationPriceChangePct'];
    const limits=Object.fromEntries(keys.map(k=>{const raw=$('#assisted-'+k).value.trim();if(!raw)throw Error('Informe todos os limites explicitamente.');return [k,Number(raw)];}));
    if(!confirm('Confirma estes limites para a loja selecionada?'))return;
    await run(()=>api('operation.limits.set',{accountId:state.accountId,limits,confirmed:true}),'Limites salvos.');await renderView();
  },
  'listing-browser-verify': async d=>{
    const observedExternalId=prompt('ID externo observado na captura posterior (novo anúncio ou variação):');if(!observedExternalId)return;
    const result=await api('listing.browser.verify',{accountId:state.accountId,proposalId:d.id,observedExternalId:observedExternalId.trim()});toast(result.status+' — observação, não causalidade comprovada');await renderView();
  },
  'product-preview': async()=>{
    const accountId=state.accountId,id=$('#product-media').value,host=$('#product-preview-out'),generation=viewRenderSequence;
    if(!id)throw Error('Escolha uma imagem da loja.');
    const item=await api('media.get',{id,accountId});
    if(generation!==viewRenderSequence||host!==$('#product-preview-out')||state.accountId!==accountId)return;
    const image=document.createElement('img');image.alt=item.alt_text||item.filename;image.style.maxWidth='100%';image.style.maxHeight='280px';
    const note=document.createElement('p');note.className='muted small';note.textContent='Decodificando imagem…';
    host.replaceChildren(image,note);
    image.onload=()=>{const w=image.naturalWidth,h=image.naturalHeight;note.textContent=w+' × '+h+' px. '+(Math.min(w,h)<800?'Considere resolução maior para manter detalhes. ':'')+(Math.abs(w/h-1)>0.15?'Considere um enquadramento mais próximo de quadrado, se permitido. ':'')+(!item.alt_text?'Adicione texto alternativo descritivo quando suportado. ':'')+'Confira fundo, legibilidade e fidelidade do produto. Critérios de qualidade são sugestões, não regras oficiais.';};
    image.onerror=()=>{note.textContent='Não foi possível decodificar a imagem; revise o arquivo.';};
    image.src='data:'+item.mime_type+';base64,'+item.content_base64;
  },
  'product-prepare': async()=>{
    await run(()=>api('listing.change.prepare',{accountId:state.accountId,listingId:$('#product-listing').value.trim(),kind:$('#product-kind').value,mediaId:$('#product-media').value||undefined,reason:$('#product-reason').value.trim()}),'Rascunho local salvo.');await renderView();
  },
  'product-review': async d=>{
    const reason=prompt('Motivo da decisão (não executa alteração remota):');if(!reason)return;
    const p=d.kind==='VARIATION'?{accountId:state.accountId,id:d.id,decision:d.decision,reason}:{accountId:state.accountId,id:d.id,decision:d.decision,reason};
    await run(()=>api(d.kind==='VARIATION'?'offer.variation.review':'listing.change.review',p),'Revisão registrada.');await renderView();
  },
  'variation-save': async()=>{
    const id=$('#variation-id').value.trim(),options=JSON.parse($('#variation-options').value);
    const optionalInt=id=>{const v=$('#'+id).value.trim();if(!v)return undefined;const n=Number(v);if(!Number.isSafeInteger(n)||n<0)throw Error('Valor inteiro não negativo obrigatório.');return n;};
    const payload={accountId:state.accountId,variationName:$('#variation-name').value.trim(),options,proposedPriceCents:optionalInt('variation-price'),proposedStock:optionalInt('variation-stock')};
    await run(()=>api(id?'offer.variation.update':'offer.variation.prepare',id?{...payload,id}:{...payload,listingId:$('#variation-listing').value.trim()}),'Rascunho salvo.');await renderView();
  },
  'variation-delete': async d=>{if(!confirm('Excluir este rascunho local?'))return;await run(()=>api('offer.variation.delete',{accountId:state.accountId,id:d.id}),'Rascunho excluído.');await renderView();},
  'operation-receipt': async d=>{
    const accountId=state.accountId;
    const performedAt=prompt('Data e hora reais da execução, com fuso horário (ex.: 2026-11-27T15:00:00-03:00):');
    if(!performedAt)return;const date=new Date(performedAt);if(!Number.isFinite(date.getTime()))throw Error('Data inválida.');
    const evidenceReference=prompt('Referência da confirmação ou relatório real, sem credenciais:');if(!evidenceReference)return;
    if(!confirm('Confirma que você executou manualmente a proposta aprovada na loja? O sistema não verificou o marketplace.'))return;
    await run(()=>api('operation.receipt.record',{accountId,proposalKind:d.kind,proposalId:d.id,performedAt:date.toISOString(),evidenceReference,confirmedManualExecution:true}),'Relato humano registrado.');await renderView();
  },
  'operation-receipt-verify': async d=>{
    const accountId=state.accountId;
    const observedExternalId=prompt('ID externo que aparece na captura feita após a operação');
    if(!observedExternalId?.trim())return;
    await run(()=>api('operation.receipt.verify',{accountId,proposalKind:d.kind,proposalId:d.id,observedExternalId:observedExternalId.trim()}),'Conferência registrada.');
    await renderView();
  },
  'operation-measure': async d=>{
    const generation=viewRenderSequence,host=$('#operation-measure-out');
    const result=await api('operation.measure',{accountId:state.accountId,proposalKind:d.kind,proposalId:d.id});
    if(generation!==viewRenderSequence||host!==$('#operation-measure-out')||!host)return;
    const v=result.variationObservation;
    const variation=v?'<h4>Variação '+esc(v.externalId)+'</h4><p>'+dt(v.before.capturedAt)+' → '+dt(v.after.capturedAt)+'</p>'+
      table(['Estado observado','Antes','Depois'],[
        '<tr><td>Preço</td><td>'+brl(v.before.priceCents)+'</td><td>'+brl(v.after.priceCents)+'</td></tr>',
        '<tr><td>Estoque disponível</td><td>'+num(v.before.stock)+'</td><td>'+num(v.after.stock)+'</td></tr>',
      ],'Sem capturas comparáveis.'):'';
    const c=result.candidateObservation;
    if(c){
      host.innerHTML='<h4>Candidato observado '+esc(c.externalId)+'</h4><p>'+dt(c.capturedAt)+
        ' · Preço '+brl(c.priceCents)+' · Estoque '+num(c.stock)+'</p><p class="muted small">Captura compatível. O vínculo com a operação ainda precisa ser comprovado.</p>';
      host.scrollIntoView({block:'nearest'});
      return;
    }
    host.innerHTML='<p>'+esc(result.status)+'</p>'+variation+(result.before&&result.after?'<p>'+esc(result.measurementScope==='CAMPAIGN'?'Campanha':'Anúncio inteiro')+' · '+esc(result.before.window.from)+' a '+esc(result.before.window.to)+' × '+esc(result.after.window.from)+' a '+esc(result.after.window.to)+'</p>':'')+table(['Métrica','Antes','Depois','Variação'],Object.entries(result.metrics||{}).map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+num(v.before,2)+'</td><td>'+num(v.after,2)+'</td><td>'+pct(v.deltaPct)+'</td></tr>'),'Sem janelas ou métricas compatíveis.')+'<p class="muted small">Mudança observada; execução e causalidade não verificadas.</p>';
    initializeTables(host);
    host.scrollIntoView({block:'nearest'});
  },
  'ads-reconcile': async()=>{
    const accountId=state.accountId,snapshotId=$('#ads-reconcile-snapshot').value,sourceReference=$('#ads-source').value.trim();
    const cents=id=>{const v=$('#'+id).value.trim();if(!/^\d+(?:[.,]\d{1,2})?$/.test(v))throw Error('Todos os valores devem ser explícitos, inclusive zero.');const n=Math.round(Number(v.replace(',','.'))*100);if(!Number.isSafeInteger(n)||n<0)throw Error('Valor inválido.');return n;};
    if(!snapshotId||!sourceReference)throw Error('Selecione o snapshot e informe a referência.');
    const netAttributedRevenueCents=cents('ads-net'),costs=Object.fromEntries(REALIZED_FIELDS.filter(([key])=>!['netRevenueCents','adSpendCents'].includes(key)).map(([key])=>[key,cents('ads-cost-'+key)]));
    if(!confirm('Confirma que os valores conciliados pertencem à campanha e à janela do snapshot, sem custos duplicados?'))return;
    const out=await api('ads.reconcile',{accountId,snapshotId,netAttributedRevenueCents,costs,sourceReference,confirmedSameScope:true});toast('Lucro atribuído informado: '+brl(out.profitCents));await renderView();
  },
  'ads-filter': async()=>{opFilters.ads={...operationInterval('ads'),kind:$('#ads-kind').value,externalId:$('#ads-external').value.trim()};await renderView();},
  'profit-filter': async()=>{opFilters.profit=operationInterval('profit');await renderView();},
  'inventory-filter': async()=>{opFilters.inventory.days=Number($('#inventory-days').value);await renderView();},
  'campaign-prepare': async()=>{
    if(!state.accountId)throw Error('Selecione uma loja.');
    const obj=id=>{const v=JSON.parse($('#'+id).value);if(!v||Array.isArray(v)||typeof v!=='object')throw Error('Informe um objeto JSON.');return v;};
    await run(()=>api('campaign.change.prepare',{accountId:state.accountId,marketplace:$('#campaign-market').value,campaignRef:$('#campaign-ref').value.trim(),baseline:obj('campaign-baseline'),changes:obj('campaign-changes'),reason:$('#campaign-reason').value.trim()}),'Proposta local salva. Nenhuma alteração remota.');await renderView();
  },
  'campaign-review': async d=>{const reason=prompt('Motivo da decisão (não executa alteração remota):');if(!reason)return;await run(()=>api('campaign.change.review',{accountId:state.accountId,proposalId:d.id,decision:d.decision,reason}),'Revisão registrada; execução remota bloqueada.');await renderView();},
  'finance-realized-save': async()=>{
    const accountId=state.accountId,generation=viewRenderSequence,host=$('#rp-out');
    const payload=realizedPayload(id=>$('#'+id).value,accountId);
    if(!confirm('Registrar os valores informados nesta loja? Confirme a conciliação e evite períodos duplicados.'))return;
    const result=await api('finance.realized.upsert',payload);
    if(generation!==viewRenderSequence||state.accountId!==accountId||host!==$('#rp-out')||!host)return;
    host.textContent='Lucro registrado: '+brl(result.realizedProfitCents)+' · fonte informada pelo usuário. Consulte o executivo para verificar conflitos.';
  },
  'exec-filter': async()=>{state.execFilters={marketplace:$('#exec-market').value,days:Number($('#exec-days').value),listingId:$('#exec-listing').value.trim(),skuId:$('#exec-sku').value.trim()};await renderView();},
  'kpi-drilldown': async (d) => {
    const metric = d.metric;
    const supported = new Set(['gmv','netRevenue','orders','visits','cvr','aov','acos','roas','returnRate']);
    if (!supported.has(metric)) throw new Error('Detalhamento ainda não disponível para este indicador.');
    const today = new Date();
    const day = (offset) => { const value = new Date(today); value.setDate(value.getDate() + offset); return value.toISOString().slice(0, 10); };
    const result = await run(() => api('kpi.compare.detail', {
      primaryFrom: day(-6), primaryTo: day(0),
      comparisonFrom: day(-13), comparisonTo: day(-7),
      groupBy: 'listing', ...(state.accountId ? { accountId: state.accountId } : {}),...(state.execFilters.marketplace?{marketplace:state.execFilters.marketplace}:{}),...(state.execFilters.listingId?{listingId:state.execFilters.listingId}:{}),...(state.execFilters.skuId?{skuId:state.execFilters.skuId}:{}),
    }));
    const metricLabel = { gmv:'GMV', netRevenue:'Receita líquida', orders:'Pedidos', visits:'Visitas', cvr:'CVR', aov:'Ticket médio', acos:'ACoS', roas:'ROAS', returnRate:'Taxa de devolução' }[metric] || metric;
    const format = (value) => value == null ? '—' : ['gmv','netRevenue','aov'].includes(metric) ? brl(Math.round(value * 100)) : ['cvr','acos','returnRate'].includes(metric) ? pct(value) : metric === 'roas' ? num(value, 2) : num(value);
    const rows = (result.rows || []).filter((row) => row.current?.metrics?.[metric] != null || row.previous?.metrics?.[metric] != null).slice(0, 100);
    const host = $('#kpi-drilldown-out');
    if (!host) return;
    host.innerHTML = `<section class="card"><header><h2>Detalhamento: ${esc(metricLabel)}</h2></header><div class="card-body"><p class="muted small">Últimos 7 dias (${esc(result.primary.start.slice(0,10))} a ${esc(result.primary.end.slice(0,10))}) versus os 7 dias anteriores (${esc(result.comparison.start.slice(0,10))} a ${esc(result.comparison.end.slice(0,10))}). Valores ausentes permanecem sem preenchimento.</p>${table(['Anúncio','Atual','Anterior','Variação observada','Variação com filtros compatíveis'], rows.map((row) => { const delta = row.deltaPct?.[metric]; return `<tr><td>${esc(row.label || row.id)}</td><td>${esc(format(row.current?.metrics?.[metric]))}</td><td>${esc(format(row.previous?.metrics?.[metric]))}</td><td>${delta == null ? '—' : `${num(delta,1)}%`}</td><td>${row.verifiedDeltaPct?.[metric] == null ? 'Não comprovada' : `${num(row.verifiedDeltaPct[metric],1)}%`}</td></tr>`; }), 'Sem snapshots suficientes para detalhar este KPI.')}</div></section>`;
    initializeTables(host);
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  'kpi-listing': async () => {
    const id = $('#kpi-listing-id').value.trim();
    if (!id) { toast('Informe o ID do anúncio.', 'bad'); return; }
    const result = await api('kpi.listing', { listingId: id, accountId: state.accountId || undefined });
    const target = $('#kpi-listing-out');
    if (!target) return;
    if (!result) { target.textContent = 'Nenhum snapshot disponível para este anúncio.'; return; }
    const { conversion_cro: visits, revenue_profit: revenue, operational_health: stock, acquisition_ads: ads } = result.pillars;
    const money = (value) => brl(value == null ? null : Math.round(value * 100));
    const rows = [
      ['Visitas', num(visits.visits)], ['Pedidos', num(visits.orders)], ['Unidades', num(visits.units)],
      ['Conversão', pct(visits.cvr.value)], ['Faturamento bruto', money(revenue.gmv)],
      ['Receita líquida', money(revenue.netRevenue)], ['Investimento em Ads', money(ads.adSpend)],
      ['ROAS', num(ads.roas.value, 2)], ['Estoque disponível', num(stock.stockAvailable)],
      ['Cobertura de estoque em dias', num(stock.stockCoverageDays.value, 1)],
    ];
    target.innerHTML = `<p class="muted small">${dt(result.periodStart)} a ${dt(result.periodEnd)} · ${num(result.missingInputs.length)} dados de origem ausentes</p>
      ${table(['Indicador','Valor'], rows.map(([label,value]) => `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`))}`;
    initializeTables(target);
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
    initializeTables($('#finance-out'));
  },
  'finance-cost': async () => {
    await run(() => api('finance.costs.upsert', {
      accountId: state.accountId, sku: $('#fc-sku').value.trim(),
      costCents: Math.round((Number($('#fc-cost').value) || 0) * 100),
    }), 'Custo registrado (versão preservada).');
  },

  'bundle-simulate': async () => {
    let components;
    try { components = JSON.parse($('#bundle-json').value); } catch { throw new Error('JSON dos componentes está inválido'); }
    const result = await run(() => api('finance.bundle.simulate', {
      components,
      bundleDiscountPct: Number($('#bundle-discount').value) || 0,
      adSpendCents: Math.round((Number($('#bundle-ads').value) || 0) * 100),
    }), 'Simulação do kit calculada.');
    const rows = Object.entries(result.total || {}).map(([key,value]) => `<tr><td>${esc(key)}</td><td>${key.toLowerCase().includes('cents') ? brl(value) : esc(value ?? '—')}</td></tr>`);
    $('#bundle-out').innerHTML = table(['Indicador','Valor'],rows) + `<pre class="json">${esc(JSON.stringify(result.components,null,2))}</pre>`;
    initializeTables($('#bundle-out'));
  },

  'kw-add': async () => {
    await run(() => api('keyword.upsert', {
      term: $('#kw-term').value.trim(),
      intent: $('#kw-intent').value,
      marketplace: $('#kw-mp').value.trim() || 'mercado_livre',
    }), 'Termo adicionado.');
    renderView();
  },
  'kw-suggest': async () => {
    if (!state.accountId) throw new Error('selecione uma conta ativa');
    const result = await run(() => api('keyword.suggest', { accountId: state.accountId, limit: 100 }));
    $('#kw-intelligence-out').innerHTML = table(['Termo sugerido','Frequência local','Títulos','Origem','Confiança'], result.map((r) => `<tr><td>${esc(r.term)}</td><td>${num(r.localFrequency)}</td><td>${num(r.sourceTitles)}</td><td>${esc(r.source)}</td><td>${pct(r.confidence * 100)}</td></tr>`), 'Não há novos termos sugeridos a partir dos títulos cadastrados.') + `<p class="muted small">${esc(result[0]?.note || 'Frequência local não representa volume de busca.')}</p>`;
    initializeTables($('#kw-intelligence-out'));
  },
  'kw-cluster': async () => {
    const result = await run(() => api('keyword.cluster', { marketplace: $('#kw-mp').value.trim() || 'mercado_livre' }), 'Agrupamentos locais atualizados.');
    $('#kw-intelligence-out').innerHTML = `<pre class="json">${esc(JSON.stringify(result,null,2))}</pre>`;
  },
  'kw-visibility': async () => {
    if (!state.accountId) throw new Error('selecione uma conta ativa');
    const accountId=state.accountId,generation=viewRenderSequence,host=$('#kw-intelligence-out');
    const result = await run(() => api('keyword.visibility', { accountId, days: 30 }));
    if(!result||generation!==viewRenderSequence||state.accountId!==accountId||host!==$('#kw-intelligence-out'))return;
    host.innerHTML = table(['Termo','Amostras','Top 3','Top 10','Top 20','Share observado'], result.terms.map((r) => `<tr><td>${esc(r.term)}</td><td>${num(r.sampleSize)}</td><td>${pct(r.top3PresencePct)}</td><td>${pct(r.top10PresencePct)}</td><td>${pct(r.top20PresencePct)}</td><td>${pct(r.ownVisibilitySharePct)}</td></tr>`), 'Nenhuma SERP com resultados utilizáveis no período.') + `<p class="muted small">${esc(result.note)}</p>` + (result.excludedSnapshots?`<p class="muted small">${num(result.excludedSnapshots)} captura(s) sem posições válidas ou com posições repetidas no Top 20.</p>`:'');
    initializeTables($('#kw-intelligence-out'));
  },
  'kw-cannibal': async () => {
    if (!state.accountId) throw new Error('selecione uma conta ativa');
    const result = await run(() => api('keyword.cannibalization', { accountId: state.accountId, days: 90 }));
    $('#kw-intelligence-out').innerHTML = `<pre class="json">${esc(JSON.stringify(result,null,2))}</pre>`;
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
    const title = $('#gi-title').value.trim(); const hypothesis = $('#gi-hyp').value.trim();
    if (!title || !hypothesis) throw new Error('Informe título e hipótese verificável.');
    await run(() => api('growth.initiative.upsert', { accountId: state.accountId || null, title, hypothesis, pillar: 'GROWTH', reach: Number($('#gi-reach').value)||0, impact: Number($('#gi-impact').value)||1, confidence: Number($('#gi-conf').value)||0.5, effort: Number($('#gi-effort').value)||1, iceImpact: Number($('#gi-impact').value)||5, iceConfidence: Math.round((Number($('#gi-conf').value)||0.5)*10), iceEase: Math.max(1, 10-(Number($('#gi-effort').value)||1)), urgency: 0 }), 'Iniciativa registrada e priorizada.'); renderView();
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

  'task-refresh': async () => { if (await renderView()) toast('Progresso atualizado.'); },
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
    if ($('#tk-type').value === 'edit_title' && !title) { toast('Informe o novo título.', 'bad'); return; }
    if ($('#tk-type').value === 'edit_description' && !desc) { toast('Informe o acréscimo de descrição.', 'bad'); return; }
    if ($('#tk-type').value === 'edit_title') item.title = title;
    if ($('#tk-type').value === 'edit_description') item.descriptionAdditions = desc;
    await run(() => api('task.create', {
      name: $('#tk-name').value.trim() || `${$('#tk-type').value} · ${listingId}`,
      kind: $('#tk-type').value,
      accountId: item.accountId,
      mode: $('#tk-mode').value,
      scheduleAt: $('#tk-when').value ? new Date($('#tk-when').value).toISOString() : null,
      recurrence: $('#tk-rec').value || null,
      typing: {
        mode: 'set_value',
        charDelayMs: Number($('#tk-delay').value) || 0,
        settleDelayMs: 400,
        verifyAfterTyping: true,
      },
      items: [item],
    }), 'Tarefa criada.');
    renderView();
  },
  'task-create-filtered': async () => {
    if (!state.accountId) throw new Error('Selecione uma conta antes de criar tarefas por desempenho.');
    const numberOrUndefined = (id, scale = 1) => { const raw = $(`#${id}`).value.trim(); if (!raw) return undefined; const value = Number(raw); if (!Number.isFinite(value) || value < 0) throw new Error(`Valor inválido: ${id}`); return value * scale; };
    const kind = $('#tkf-type').value;
    const payload = {
      name: $('#tkf-name').value.trim() || `Tarefa por desempenho · ${kind}`,
      accountId: state.accountId,
      kind,
      charDelayMs: Number($('#tkf-delay').value) || 0,
      filters: {
        ...(numberOrUndefined('tkf-min-gmv', 1) !== undefined ? { minGmv: numberOrUndefined('tkf-min-gmv', 1) } : {}),
        ...(numberOrUndefined('tkf-max-gmv', 1) !== undefined ? { maxGmv: numberOrUndefined('tkf-max-gmv', 1) } : {}),
        ...(numberOrUndefined('tkf-min-orders') !== undefined ? { minOrders: numberOrUndefined('tkf-min-orders') } : {}),
        ...(numberOrUndefined('tkf-min-visits') !== undefined ? { minVisits: numberOrUndefined('tkf-min-visits') } : {}),
        ...(numberOrUndefined('tkf-max-cvr') !== undefined ? { maxCvrPct: numberOrUndefined('tkf-max-cvr') } : {}),
        ...(numberOrUndefined('tkf-max-stock') !== undefined ? { maxStockAvailable: numberOrUndefined('tkf-max-stock') } : {}),
      },
      ...(kind === 'edit_title' ? { draftTitle: $('#tkf-title').value.trim() } : { descriptionAdditions: $('#tkf-desc').value.trim() }),
    };
    const result = await run(() => api('task.createByFilter', payload));
    const out = $('#tkf-result'); if (out) out.textContent = result?.created ? `${result.matched} anúncios enfileirados de ${result.totalMatched ?? result.matched} encontrados${result.truncated ? ' (limite de 100 por tarefa)' : ''} · tarefa ${result.taskId}` : (result?.note || 'Nenhum anúncio corresponde aos filtros.');
    if (result?.created) { toast('Rascunho por desempenho criado. Nada foi publicado.'); renderView(); }
  },
  'task-run': async (d) => { await run(() => api('task.runNow', { taskId: d.id }), 'Tarefa enfileirada. Abra a tela de edição do anúncio na conta correspondente; somente rascunhos serão preenchidos, sem salvar/publicar.'); renderView(); },
  'task-approve-publish': async (d) => {
    const count = Number(d.count);
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('aprovação limitada a 1–10 anúncios');
    const confirmation = window.prompt(`A publicação altera anúncios reais. Revise a tarefa e os ${count} anúncios antes de continuar.\n\nPara autorizar, digite exatamente: PUBLICAR ${count}`);
    if (confirmation === null) return;
    const reason = window.prompt('Motivo da autorização (obrigatório):');
    if (reason === null) return;
    const result = await run(() => api('task.approvePublish', { taskId: d.id, confirmation, reason }), 'Aprovação registrada por 15 minutos. Agora abra e deixe ativa a tela de edição de cada anúncio correspondente; o marketplace ainda pedirá confirmação individual.');
    if (result?.ok) toast('Aprovação de uso único registrada. Abra a aba ativa do anúncio para continuar.');
    renderView();
  },
  'task-rollback': async (d) => {
    const result = await run(() => api('task.rollbackPrepare', { approvalId: d.id }), 'Rascunho de reversão criado; revise e execute separadamente.');
    if (result?.taskId) toast(`Rascunho de reversão ${result.taskId} criado. Nada foi alterado remotamente.`);
    renderView();
  },
  'compare-detail': async () => {
    const generation=viewRenderSequence,originalHost=$('#compare-detail-out'),requestId=++compareRequestSequence;
    const value = (id) => $(`#${id}`).value;
    const payload = {
      accountId: value('cmp-account') || undefined,
      marketplace: value('cmp-marketplace') || undefined,
      listingId: value('cmp-listing-id').trim() || undefined,
      skuId: value('cmp-sku-id').trim() || undefined,
      groupBy: value('cmp-group'),
      primaryFrom: value('cmp-primary-from'), primaryTo: value('cmp-primary-to'),
      comparisonFrom: value('cmp-previous-from'), comparisonTo: value('cmp-previous-to'),
    };
    const result = await run(() => api('kpi.compare.detail', payload), 'Comparação calculada a partir dos snapshots disponíveis.');
    if(requestId!==compareRequestSequence||generation!==viewRenderSequence||originalHost!==$('#compare-detail-out')||!result)return;
    const rows = result?.rows || [];
    const delta = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${num(n,1)}%`;
    const output = table(['Item','Marketplace','GMV atual','GMV anterior','Variação observada','Compatibilidade dos filtros','Pedidos atuais','Pedidos anteriores','ROAS atual','ROAS anterior'], rows.map((row) => `<tr><td>${esc(row.label)}</td><td>${esc(row.marketplace)}</td><td>${row.current.metrics.gmv == null ? '—' : brl(row.current.metrics.gmv * 100)}</td><td>${row.previous.metrics.gmv == null ? '—' : brl(row.previous.metrics.gmv * 100)}</td><td>${delta(row.deltaPct.gmv)}</td><td>${row.comparisonQuality?.comparable ? delta(row.verifiedDeltaPct.gmv)+' · cobertura não comprovada' : 'Não comprovada'}</td><td>${num(row.current.metrics.orders)}</td><td>${num(row.previous.metrics.orders)}</td><td>${num(row.current.metrics.roas,2)}</td><td>${num(row.previous.metrics.roas,2)}</td></tr>`), 'Nenhum snapshot encontrado nos períodos escolhidos.');
    const host=$('#compare-detail-out');
    if(!host||!result)return;
    const signals=rows.flatMap(row=>(row.diagnostics||[]).map(d=>({label:row.label,...d})));
    const diagnostics=card('Diagnósticos de desempenho', '<p class="muted small">'+esc(result.diagnosticPolicy||'')+'</p>'+table(['Item','Indicador','Atual','Anterior','Sinal observado'],signals.map(d=>'<tr><td>'+esc(d.label)+'</td><td>'+esc(d.metric)+'</td><td>'+num(d.current,2)+'</td><td>'+num(d.previous,2)+'</td><td>'+esc(d.note)+'</td></tr>'),'Nenhum sinal com evidência suficiente. Isso não comprova ausência de problemas.'));
    const campaigns=card('Campanhas para revisar',table(['Campanha','Marketplace','Investimento','Receita atribuída','Evidência'],(result.campaigns||[]).map(d=>'<tr><td>'+esc(d.label||d.campaignId)+'</td><td>'+esc(d.marketplace)+'</td><td>'+brl(d.spend*100)+'</td><td>'+brl(d.attributedRevenue*100)+'</td><td>'+esc(d.note)+' · '+dt(d.capturedAt)+'</td></tr>'),'Nenhuma campanha com sinal e período comprováveis. Não equivale a lucro confirmado.'));
    host.innerHTML = `<p class="muted small">${esc(result.method || '')}</p>${output}${diagnostics}${campaigns}`;
    initializeTables(host);
  },

  'task-recover-draft': async (d) => {
    if (!confirm('Feche todas as abas anteriores de edição deste anúncio antes de recuperar. Nenhuma publicação será repetida. Confirma que as abas foram fechadas?')) return;
    await run(() => api('task.recoverDraft', { itemId: d.id, accountId: d.accountId, closedOldTabs: true }), 'Rascunho recuperado. Reabra a aba do anúncio e retome se necessário.');
    renderView();
  },
  'task-pause': async (d) => { await run(() => api('task.pause', { taskId: d.id }), 'Pausada.'); renderView(); },
  'task-resume': async (d) => { await run(() => api('task.resume', { taskId: d.id }), 'Retomada.'); renderView(); },
  'task-skip': async (d) => { await run(() => api('task.skipItem', { taskId: d.id }), 'Próximo item pendente pulado.'); renderView(); },
  'task-cancel': async (d) => { await run(() => api('task.cancel', { taskId: d.id }), 'Cancelada.'); renderView(); },

  'media-add': async () => {
    const file = $('#media-file').files?.[0]; if (!file) throw new Error('Escolha uma imagem.');
    if (file.size > 2_500_000) throw new Error('Imagem acima do limite de 2,5 MB.');
    const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Falha ao ler imagem.')); reader.readAsDataURL(file); });
    await run(() => api('media.add', { accountId: state.accountId || null, filename: file.name, mimeType: file.type, base64, altText: $('#media-alt').value.trim() }), 'Imagem salva na biblioteca local.'); renderView();
  },
  'media-preview': async (d) => {
    const item = await run(() => api('media.get', { id: d.id, accountId: d.accountId || null }));
    const out = document.querySelector(`#media-${CSS.escape(d.id)}`); if (out) out.innerHTML = `<img alt="${esc(item.alt_text || item.filename)}" style="max-width:100%;max-height:240px;border-radius:10px" src="data:${esc(item.mime_type)};base64,${item.content_base64}">`;
  },
  'media-delete': async (d) => { if (!confirm('Excluir esta imagem da biblioteca?')) return; await run(() => api('media.delete', { id: d.id, accountId: d.accountId || null }), 'Imagem excluída.'); renderView(); },
  'connector-toggle': async (d) => { await run(() => api('connector.setEnabled', { connectorId: d.id, enabled: d.enabled !== '1' }), 'Conector atualizado.'); renderView(); },
  'connector-configure': async ({ id }) => {
    const analytics = id === 'google_analytics4';
    const property = $(analytics ? '#ga4-property' : '#gsc-property').value.trim();
    const field = $(analytics ? '#ga4-token' : '#gsc-token');
    const accessToken = field.value.trim();
    if (!property || !accessToken) throw new Error('Informe a propriedade e o token de leitura.');
    await api('connector.configure', {
      connectorId: id, provider: analytics ? 'GOOGLE_ANALYTICS4' : 'GOOGLE_SEARCH_CONSOLE',
      publicConfig: analytics ? { propertyId: property } : { siteUrl: property }, secrets: { accessToken },
    });
    field.value = '';
    toast('Conexão configurada. Teste a propriedade.');
    await renderView();
  },
  'connector-test': async ({ id }) => {
    const result = await api('connector.test', { connectorId: id });
    toast(result.message, result.ok ? 'ok' : 'bad');
    await renderView();
  },
  'connector-disconnect': async (d) => {
    if (!confirm(`Desconectar ${d.label || d.id}? Os tokens e credenciais guardados para este conector serão removidos.`)) return;
    await run(() => api('connector.disconnect', { connectorId: d.id }), 'Conector desconectado e credenciais locais removidas.');
    renderView();
  },
  import: async () => {
    const file = $('#im-file').files?.[0];
    const pasted = $('#im-csv').value;
    if (!state.accountId) throw new Error('Selecione a conta que receberá os dados antes de importar.');
    if (!file && !pasted.trim()) throw new Error('Escolha um arquivo ou cole o conteúdo CSV.');
    if (file && file.size > 2 * 1024 * 1024) throw new Error('Arquivo acima do limite de 2 MB.');
    let fileName = file?.name || `${$('#im-kind').value.toLowerCase()}-${Date.now()}.csv`;
    const fileType = fileName.toLowerCase().split('.').at(-1);
    if (!['csv','xlsx','pdf'].includes(fileType)) throw new Error('Selecione CSV, XLSX ou PDF digital.');
    const payload = { fileName, fileType, accountId: state.accountId || undefined };
    if (fileType !== 'csv' && file) {
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(new Error('Falha ao ler o arquivo.')); reader.readAsDataURL(file); });
      payload.base64 = dataUrl.split(',')[1] || '';
    } else {
      payload.csvText = file ? await file.text() : pasted;
    }
    const r = await run(() => api('connector.import', payload), 'Arquivo interpretado e salvo para validação.');
    const rows = r?.previewRows || [];
    const columns = Array.from(rows.reduce((set, row) => { Object.keys(row || {}).forEach((key) => set.add(key)); return set; }, new Set()));
    const preview = rows.length ? table(columns, rows.map((row) => `<tr>${columns.map((key) => `<td>${esc(row[key] ?? '')}</td>`).join('')}</tr>`), 'Sem linhas de prévia.') : '';
    if (fileType === 'pdf') {
      activeImportJobId = '';
      $('#import-out').innerHTML = `<p>${num(r.rowCount)} linhas de texto guardadas para conferência. Use um CSV ou XLSX com IDs de anúncios para importar métricas.</p>
        <ul>${(r.warnings ?? []).map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>${preview}`;
      initializeTables($('#import-out'));
      return;
    }
    activeImportJobId = r?.jobId || '';
    const options = `<option value="">— não mapear —</option>${columns.map((column) => `<option value="${esc(column)}">${esc(column)}</option>`).join('')}`;
    const metricFields = [['gmv','Faturamento bruto'],['netRevenue','Receita líquida'],['orders','Pedidos'],['units','Unidades vendidas'],['visits','Visitas'],['impressions','Impressões'],['clicks','Cliques'],['adSpend','Investimento em Ads'],['adClicks','Cliques em Ads'],['adAttributedRevenue','Receita atribuída a Ads'],['stockAvailable','Estoque disponível'],['returnsCount','Devoluções'],['cancellations','Cancelamentos'],['reviewRating','Nota de avaliação'],['reviewCount','Quantidade de avaliações']];
    const mapping = `<div class="form-grid"><label>ID externo do anúncio<select id="im-map-external"><option value="">— selecione a coluna —</option>${columns.map((column) => `<option value="${esc(column)}">${esc(column)}</option>`).join('')}</select></label><label>Data do registro (opcional)<select id="im-map-date">${options}</select></label>${metricFields.map(([key,label]) => `<label>${esc(label)}<select class="im-map-metric" data-metric="${key}">${options}</select></label>`).join('')}</div><div class="actions"><button class="btn primary" data-act="import-commit" ${state.accountId ? '' : 'disabled'}>Validar mapeamento e importar para KPIs</button></div><p class="muted small">Os anúncios precisam já existir na conta. O sistema rejeita IDs desconhecidos, datas duplicadas e valores inválidos. A origem será registrada como F_USER_INPUT.</p>`;
    $('#import-out').innerHTML = `<p>${num(r?.rowCount || 0)} linha(s) em staging · status ${esc(r?.status || '—')} · job ${esc(r?.jobId || '—')}</p><p class="muted small">${esc(r?.note || 'Os dados aguardam mapeamento e validação; ainda não alteram KPIs.')}</p>${preview}${mapping}`;
    initializeTables($('#import-out'));
  },
  'import-commit': async () => {
    if (!activeImportJobId) throw new Error('Não há importação pendente para mapear.');
    if (!state.accountId) throw new Error('Selecione a mesma conta usada para preparar o arquivo.');
    const externalId = $('#im-map-external').value;
    if (!externalId) throw new Error('Selecione a coluna que contém o ID externo do anúncio.');
    const metrics = {};
    $$('.im-map-metric').forEach((control) => { if (control.value) metrics[control.dataset.metric] = control.value; });
    if (!Object.keys(metrics).length) throw new Error('Mapeie pelo menos um indicador.');
    const capturedAt = $('#im-map-date').value || undefined;
    const result = await run(() => api('connector.import.commit', { jobId: activeImportJobId, accountId: state.accountId, mapping: { externalId, capturedAt, metrics } }), 'Dados validados e adicionados ao histórico de KPIs.');
    $('#import-out').innerHTML = `<p>${num(result?.snapshotsCreated || 0)} snapshots importados · origem ${esc(result?.sourceClass || 'F_USER_INPUT')} · status ${esc(result?.status || '—')}</p><p class="muted small">${esc(result?.note || 'Proveniência registrada.')}</p>`;
    activeImportJobId = '';
  },

  'gemini-key': async () => {
    const key = $('#gk').value.trim();
    if (!key) { toast('Informe a chave.', 'bad'); return; }
    await run(() => api('gemini.setKey', { apiKey: key }), 'Chave salva cifrada.');
    $('#gk').value = '';
  },
  'gemini-test': async () => {
    const r = await run(() => api('gemini.testKey', {}));
    toast(r && r.ok ? 'Chave válida.' : `Falha: ${JSON.stringify(r)}`, r && r.ok ? 'ok' : 'bad');
  },
  'backup-create': async () => { await run(() => api('backup.create', {}), 'Backup criado.'); renderView(); },
  'backup-restore': async (d) => {
    if (!d.id || !confirm('Restaurar este backup? O banco atual será salvo em um arquivo .pre-restore.bak antes da troca. Operações recentes posteriores à data do backup serão substituídas. As sessões serão revogadas e autorizações antigas de publicação precisarão de revisão.')) return;
    await run(() => api('backup.restore', { backupId: d.id, confirmed: true }), 'Backup restaurado e integridade verificada. Reinicie o serviço local e reabra o painel para renovar a sessão.');
    state.token = ''; sessionStorage.removeItem('mi.token');
  },
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
  'forecast-run': async () => {
    if (!state.accountId) throw new Error('selecione uma conta antes de gerar a previsão');
    const r = await api('forecast.run', { accountId: state.accountId, metric: $('#fcst-metric').value, horizonDays: Number($('#fcst-horizon').value) });
    if (!r?.ok) {
      $('#forecast-out').innerHTML = `<p class="muted">${esc(r?.error || 'previsão indisponível')} · Sem preenchimento artificial de dados.</p>`;
      return;
    }
    const pts = (r.points || []).map((p) => `<tr><td>${p.week}</td><td>${num(p.value, 2)}</td><td>${num(p.low, 2)} – ${num(p.high, 2)}</td></tr>`);
    $('#forecast-out').innerHTML = `<p>Modelo: ${esc(r.method)} · Observações semanais: ${r.observations.length} · Variação estimada por semana: ${num(r.trendPerWeek, 2)} · MAPE retrospectivo: ${r.mape == null ? 'indisponível' : `${num(r.mape, 1)}%`}</p>${table(['Semana futura', 'Estimativa', 'Faixa heurística'], pts)}<p class="muted small">${esc(r.interval)}</p>`;
    initializeTables($('#forecast-out'));
  },
  'schedule-create': async () => {
    const kind = $('#sc-kind').value;
    const cadence = $('#sc-cadence').value;
    const payload = { accountId: state.accountId || null, cadence, ...(cadence === 'custom' ? { intervalMinutes: Number($('#sc-interval').value) } : {}) };
    if (cadence === 'custom' && (!Number.isInteger(payload.intervalMinutes) || payload.intervalMinutes < 15 || payload.intervalMinutes > 43200)) {
      throw new Error('Intervalo personalizado deve ser um número inteiro entre 15 e 43200 minutos.');
    }
    if (kind === 'analysis') {
      await run(() => api('analysis.schedule.create', { ...payload, mode: $('#sc-mode').value, days: Number($('#sc-days').value) || 30 }), 'Análise agendada.');
    } else {
      await run(() => api('report.schedule.create', { ...payload, reportType: $('#sc-report-type').value, format: 'json' }), 'Relatório agendado.');
    }
    renderView();
  },
  'schedule-toggle': async (d) => {
    const method = d.kind === 'analysis' ? 'analysis.schedule.setEnabled' : 'report.schedule.setEnabled';
    await run(() => api(method, { id: d.id, enabled: d.enabled !== '1' }), d.enabled === '1' ? 'Agendamento pausado.' : 'Agendamento ativado.');
    renderView();
  },
  'schedule-runs': async (d) => {
    const isAnalysis = d.kind === 'analysis';
    const runs = await api(isAnalysis ? 'analysis.schedule.runs' : 'report.schedule.runs', { scheduleId: d.id, limit: 50 });
    const target = $(isAnalysis ? '#analysis-schedule-runs' : '#report-schedule-runs');
    if (!target) return;
    if (isAnalysis) {
      target.innerHTML = card('Histórico de análises', table(['Início','Duração','Estado','Erro/resultado'], (runs || []).map((r) => `<tr><td>${dt(r.started_at)}</td><td>${num(r.duration_ms)} ms</td><td>${badge(r.status,r.status==='COMPLETED'?'ok':r.status==='FAILED'?'bad':'warn')}</td><td>${esc(r.error || (r.result_json ? 'Resultado registrado' : '—'))}</td></tr>`), 'Nenhuma execução registrada.'));
    } else {
      target.innerHTML = card('Histórico de relatórios', table(['Gerado em','Linhas','Estado','Erro','Arquivo'], (runs || []).map((r) => `<tr><td>${dt(r.generated_at)}</td><td>${num(r.row_count)}</td><td>${badge(r.status,r.status==='COMPLETED'?'ok':'bad')}</td><td>${esc(r.error || '—')}</td><td>${r.status === 'COMPLETED' ? `<button class="btn tiny" data-act="schedule-run-download" data-id="${esc(r.id)}">Baixar JSON</button>` : '—'}</td></tr>`), 'Nenhum relatório gerado.'));
    }
    initializeTables(target);
  },
  'schedule-run-download': async (d) => {
    const result = await api('report.schedule.run.get', { runId: d.id });
    const blob = new Blob([result.reportJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `relatorio-agendado-${d.id}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  report: async () => {
    const type = $('#rp-type').value;
    const fmt = $('#rp-fmt').value;
    const r = await run(() => api('report.export', { type, format: fmt === 'pdf' ? 'json' : fmt, accountId: state.accountId || undefined }), 'Relatório gerado.');
    if (!r) return;
    if (fmt === 'pdf') {
      const rowsHtml = (r.rows || []).map(row => `<tr>${Object.values(row).map(v => `<td>${esc(v ?? '')}</td>`).join('')}</tr>`).join('');
      const cols = Object.keys((r.rows || [])[0] || {});
      const w = window.open('', '_blank');
      if (!w) throw new Error('O navegador bloqueou a janela de impressão. Permita pop-ups para o painel local.');
      w.document.write(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Relatório ${esc(type)}</title><style>body{font:12px Arial;padding:24px;color:#222}h1{font-size:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:5px;text-align:left;word-break:break-word}</style><h1>Marketplace Intelligence — ${esc(type)}</h1><p>Gerado em ${new Date().toLocaleString('pt-BR')} · ${r.rowCount} registros</p><table><thead><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></html>`);
      w.document.close(); w.focus(); w.print(); return;
    }
    const rows = r.rows || [];
    const name = `relatorio-${type.toLowerCase()}-${Date.now()}.${fmt}`;
    if (fmt === 'xlsx') {
      const blob = createXlsxReport(r);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.textContent = `baixar ${name}`;
      link.className = 'link';
      $('#report-out').innerHTML = '';
      $('#report-out').appendChild(link);
      $('#report-out').insertAdjacentHTML('beforeend', `<p class="muted small">${rows.length} linha(s) exportadas em uma planilha XLSX local.</p>`);
      return;
    }
    let content = '';
    let mime = 'application/json';
    if (fmt === 'csv') {
      const cols = Array.from(rows.reduce((set, row) => { Object.keys(row).forEach((k) => set.add(k)); return set; }, new Set()));
      const escCsv = (v) => {
        let t = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        // Evita CSV/Formula Injection ao abrir exportações em Excel/LibreOffice.
        if (/^[\s]*[=+\-@\t\r]/.test(t)) t = `'${t}`;
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
    if (await renderView()) toast('Ambiente verificado.', 'ok');
  },
  'adapter-diag': async () => {
    const r = await run(() => api('adapter.diagnostics', { marketplace: 'mercado_livre', observed: {} }));
    $('#adapter-out').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 2))}</pre>`;
  },
};

document.addEventListener('input', (e) => {
  const search = e.target.closest('[data-table-search]');
  if (!search) return;
  const wrapper = search.closest('[data-table-id]');
  if (wrapper) { wrapper.dataset.page = '0'; updateTableView(wrapper); }
});

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-table-action], [data-table-sort]');
  if (!action) return;
  const wrapper = action.closest('[data-table-id]');
  if (!wrapper) return;
  if (action.dataset.tableAction) {
    const page = Number(wrapper.dataset.page || 0);
    wrapper.dataset.page = String(action.dataset.tableAction === 'next' ? page + 1 : Math.max(0, page - 1));
  } else {
    const column = Number(action.dataset.tableSort);
    const current = Number(wrapper.dataset.sortColumn || -1);
    const direction = current === column && wrapper.dataset.sortDirection === 'asc' ? 'desc' : 'asc';
    wrapper.dataset.sortColumn = String(column);
    wrapper.dataset.sortDirection = direction;
    wrapper.dataset.page = '0';
  }
  updateTableView(wrapper);
});

document.addEventListener('change', (e) => {
  if(e.target?.id==='cmp-preset'&&e.target.value!=='custom'){
    const dates=comparisonPreset(e.target.value);
    if(!dates){e.target.value='custom';toast('Ainda não há dia completo neste mês. Selecione datas manualmente.','bad');return;}
    ['cmp-primary-from','cmp-primary-to','cmp-previous-from','cmp-previous-to'].forEach((id,i)=>{const input=$('#'+id);if(input)input.value=dates[i];});
  }
  if(['cmp-primary-from','cmp-primary-to','cmp-previous-from','cmp-previous-to'].includes(e.target?.id)&&$('#cmp-preset'))$('#cmp-preset').value='custom';
  if (e.target?.id === 'history-metric') {
    const host = $('#history-chart');
    if (host) host.innerHTML = renderHistoryChart(state.historyPoints, e.target.value);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target?.id === 'browser-sync-cadence') $('#browser-sync-interval-wrap')?.toggleAttribute('hidden', e.target.value !== 'custom');
  if (e.target?.id === 'sc-kind') {
    const report = e.target.value === 'report';
    $('#sc-mode-wrap')?.toggleAttribute('hidden', report);
    $('#sc-days-wrap')?.toggleAttribute('hidden', report);
    $('#sc-report-wrap')?.toggleAttribute('hidden', !report);
  }
  if (e.target?.id === 'sc-cadence') $('#sc-interval-wrap')?.toggleAttribute('hidden', e.target.value !== 'custom');
  const el = e.target.closest('[data-act=\"initiative-status\"]');
  if (!el) return;
  try { await api('growth.initiative.setStatus', { id: el.dataset.id, status: el.value }); toast('Status da iniciativa atualizado.'); }
  catch (err) { toast(err.message, 'bad'); }
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn || el.dataset.busy === 'true') return;
  const protectedAction = ['browser-sync-request', 'browser-sync-advanced', 'browser-sync-schedule', 'browser-sync-retry','finance-realized-save','compare-detail'].includes(el.dataset.act);
  if (protectedAction) { el.dataset.busy = 'true'; el.disabled = true; }
  try {
    await fn(el.dataset);
  } catch (err) {
    if (err.message !== 'UNAUTHORIZED') toast(err.message, 'bad');
  } finally {
    if (protectedAction && el.isConnected) { delete el.dataset.busy; el.disabled = false; }
  }
});

async function bootAccountSelector() {
  const accounts = await api('account.list', {});
  const active = (accounts || []).filter(a => a.is_active !== 0);
  if (!state.accountId || !active.some(a => a.id === state.accountId)) { state.accountId = active[0]?.id || ''; state.ownProductId = ''; }
  const sel = $('#account');
  sel.innerHTML = active.length ? active.map(a => `<option value="${esc(a.id)}" ${a.id === state.accountId ? 'selected' : ''}>${esc(a.display_name || a.id)} · ${esc(a.marketplace)}</option>`).join('') : '<option value="">nenhuma conta ativa</option>';
}

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

  await bootAccountSelector();
  $('#account').addEventListener('change', () => { state.accountId = $('#account').value; state.ownProductId = ''; renderView(); });

  await renderView();
  setInterval(async () => {
    const detail = $('#browser-sync-detail');
    if (state.view !== 'browserSync' || detail?.dataset.active !== 'true' || loadingSyncProgress) return;
    loadingSyncProgress = true;
    try { await showBrowserSyncBatch(); }
    catch (err) {
      if (detail.isConnected) {
        let warning = detail.querySelector('[data-sync-error]');
        if (!warning) { warning = document.createElement('p'); warning.dataset.syncError = ''; warning.className = 'bad-text'; detail.prepend(warning); }
        warning.textContent = `Falha ao atualizar progresso: ${err.message}. Tentaremos novamente.`;
      }
    }
    finally { loadingSyncProgress = false; }
  }, 4000);
}

boot().catch((err) => {
  $('#view').innerHTML = `<div class="empty bad-text">Falha ao inicializar o painel: ${esc(err.message)}</div>`;
});
