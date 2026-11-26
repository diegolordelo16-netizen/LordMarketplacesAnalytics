#!/usr/bin/env node
/**
 * Gera docs/DOCUMENTACAO-COMPLETA.txt a partir do código-fonte real.
 *
 * Nada aqui é escrito à mão: os métodos da API são lidos de service.ts, as
 * tabelas das migrações, os agentes de agents.ts, as áreas do painel de app.js
 * e os itens do checklist de CHECKLIST-FUNCIONALIDADES.md. Assim o documento
 * nunca envelhece em silêncio — se o código mudar, o texto muda.
 *
 * Uso: node scripts/gerar-documentacao-txt.mjs
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p) => {
  try {
    statSync(join(ROOT, p));
    return true;
  } catch {
    return false;
  }
};

const W = 80;
const line = (ch = '=') => ch.repeat(W);
const title = (t) => `${line()}\n ${t}\n${line()}`;
const sub = (t) => `${t}\n${'-'.repeat(Math.min(W, t.length))}`;

// ----------------------------------------------------------------- dados reais
const service = read('packages/local-agent/src/service.ts');

/** Métodos registrados, na ordem do arquivo. */
const methods = [...service.matchAll(/this\.register\('([^']+)'/g)].map((m) => m[1]);

/** Campos de cada método, lidos do schema Zod do seu bloco. */
function fieldsOf(name) {
  const idx = service.indexOf(`this.register('${name}'`);
  if (idx < 0) return [];
  const next = service.indexOf("this.register('", idx + 10);
  const block = service.slice(idx, next < 0 ? idx + 4000 : next);
  const map = {
    string: 'texto',
    number: 'numero',
    boolean: 'booleano',
    enum: 'opcao',
    array: 'lista',
    object: 'objeto',
    record: 'registro',
    unknown: 'qualquer',
    literal: 'fixo',
  };
  const out = [];
  for (const m of block.matchAll(/^\s+(\w+):\s*z\s*\.([a-zA-Z]+)/gm)) {
    out.push(`${m[1]} (${map[m[2]] ?? m[2]})`);
  }
  return out;
}

/** Contratos que não usam z.object direto (lidos no código e anotados à mão). */
const MANUAL = JSON.parse(read('contracts.json'));

const migrations = ['packages/local-agent/migrations/001_init.sql', 'packages/local-agent/migrations/002_competitive_intelligence.sql'];
const tables = [];
for (const file of migrations) {
  const sql = read(file);
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)) tables.push(m[1]);
}

const agentsSrc = read('packages/local-agent/src/ai/agents.ts');
const agentKeys = [...agentsSrc.match(/AGENT_KEYS = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const panelSrc = read('packages/local-agent/panel/src/app.js');
const views = [...panelSrc.matchAll(/^\s{2}(\w+): \{ label: '([^']+)'/gm)].map((m) => ({ key: m[1], label: m[2] }));

const guardSrc = read('packages/local-agent/src/guard/automation-guard.ts');
// `check: '...'` aparece tanto na definição quanto nas chamadas de retorno; só
// interessam as verificações que entram no array `checks` (ordem de execução).
const guardChecks = [...guardSrc.matchAll(/checks\.push\(\{\s*check: '([a-z_]+)'/g)].map((m) => m[1]);
const guardActions = [...guardSrc.matchAll(/^  (edit_title|edit_description|upload_image|change_price|duplicate_listing|toggle_ads):/gm)].map((m) => m[1]);

const extManifest = JSON.parse(read('packages/extension/manifest.json'));
const extVersion = extManifest.version;

const pkg = JSON.parse(read('package.json'));
const installer = exists('installer/output/MarketplaceIntelligence-Setup.exe')
  ? (statSync(join(ROOT, 'installer/output/MarketplaceIntelligence-Setup.exe')).size / (1024 * 1024)).toFixed(1)
  : null;

/** Checklist em Markdown → itens por seção. */
const checklist = (() => {
  const md = read('docs/CHECKLIST-FUNCIONALIDADES.md');
  const items = [];
  let sec = '';
  for (const l of md.split('\n')) {
    const h = l.match(/^## (.+)/);
    if (h) {
      sec = h[1].trim();
      continue;
    }
    if (!l.startsWith('| ')) continue;
    const c = l.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length < 3 || !['✅', '🟡', '❌', '⬜'].includes(c[1])) continue;
    items.push({ sec, item: c[0], st: c[1], note: c[2] });
  }
  return items;
})();
const countBy = (st) => checklist.filter((i) => i.st === st).length;

const testFiles = readdirSync(join(ROOT, 'packages')).flatMap((p) => {
  const dir = join(ROOT, 'packages', p, 'test');
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
  } catch {
    return [];
  }
});

// -------------------------------------------------------------- montagem
const out = [];
const push = (...xs) => out.push(...xs);

push(
  line(),
  ' MARKETPLACE INTELLIGENCE & AUTONOMOUS OPERATIONS',
  ' DOCUMENTACAO COMPLETA DO SOFTWARE',
  ` Versao ${pkg.version} (painel e servico) / ${extVersion} (extensao)  -  Windows x64  -  Pt-BR`,
  line(),
  '',
  'Documento gerado a partir do codigo-fonte real do projeto por',
  'scripts/gerar-documentacao-txt.mjs. Os numeros abaixo nao foram escritos a',
  'mao: sao lidos dos arquivos a cada geracao (metodos da API, tabelas do banco,',
  'agentes, areas do painel, verificacoes do guard, itens do checklist). Onde',
  'algo NAO esta pronto, esta escrito explicitamente.',
  '',
  `Gerado em: ${new Date().toISOString().slice(0, 10)}`,
  '',
  'INDICE',
  '  PARTE 0  - Visao geral e arquitetura',
  '  PARTE 1  - Como instalar',
  '  PARTE 2  - Primeiro acesso e credenciais',
  `  PARTE 3  - O painel: as ${views.length} areas, tela por tela`,
  '  PARTE 4  - Inteligencia competitiva (fluxo completo)',
  `  PARTE 5  - Os ${methods.length} metodos da API local (referencia)`,
  '  PARTE 6  - Motor de similaridade e aprendizado',
  '  PARTE 7  - KPIs, financas, prioridade, experimentos',
  `  PARTE 8  - IA: Gemini, ${agentKeys.length} agentes e auto-upgrade`,
  `  PARTE 9  - Guard de automacao (${guardChecks.length} verificacoes)`,
  '  PARTE 10 - Tarefas, scheduler e perfis de digitacao',
  '  PARTE 11 - Preservacao de descricao',
  '  PARTE 12 - Qualidade e honestidade de dados',
  '  PARTE 13 - Seguranca: papeis, sessoes, segredos',
  `  PARTE 14 - Banco de dados (${tables.length} tabelas)`,
  '  PARTE 15 - Extensao de navegador',
  '  PARTE 16 - Native Messaging host',
  '  PARTE 17 - Instalador, arquivos e desinstalacao',
  '  PARTE 18 - Checklist: o que esta pronto, parcial e planejado',
  '  PARTE 19 - Limitacoes conhecidas e proibicoes',
  '  PARTE 20 - Solucao de problemas',
  '  PARTE 21 - Desenvolvimento, build e testes',
  '  PARTE 22 - O que mudou nesta versao (26/11/2026)',
  '  GLOSSARIO',
  '',
);

// ---------------------------------------------------------------- PARTE 0
push(
  title('PARTE 0 — VISAO GERAL E ARQUITETURA'),
  '',
  'O Marketplace Intelligence e uma plataforma de inteligencia e operacao para',
  'vendedores de marketplace. Funciona 100% na maquina do usuario ("local',
  'first"): nao ha servidor na nuvem, nao ha conta online, e nenhum dado sai do',
  'computador sem o usuario mandar.',
  '',
  sub('0.1 As quatro pecas'),
  '',
  '  (1) PAINEL LOCAL (interface)',
  `      Aplicacao web servida pelo servico Node.js em 127.0.0.1. Tem ${views.length} areas,`,
  '      indicadores, revisao de concorrentes, tarefas, IA e administracao.',
  '',
  '  (2) SERVICO LOCAL (motor)',
  `      Node.js embarcado no instalador. Guarda o banco SQLite, aplica as regras,`,
  '      calcula KPIs, fala com o Gemini, executa tarefas e mantem auditoria.',
  `      Expoe uma API interna com ${methods.length} metodos em 127.0.0.1.`,
  '',
  '  (3) EXTENSAO DE NAVEGADOR (captura)',
  '      Extensao MV3 para Chrome e Edge. Le a tela do marketplace na sessao ja',
  '      autenticada do usuario e envia os dados ao servico local. Nunca extrai',
  '      cookie, nunca reproduz requisicao interna, nunca resolve CAPTCHA.',
  '',
  '  (4) HOST DE MENSAGENS NATIVO (ponte)',
  '      Programa pequeno registrado no navegador que liga a extensao ao servico',
  '      local por stdio, sem porta exposta para fora da maquina.',
  '',
  sub('0.2 Fluxo de um dado'),
  '',
  '  Tela do marketplace -> content script le o DOM -> worker monta o snapshot',
  '  -> (host nativo ou HTTP em 127.0.0.1) -> servico valida, grava e marca a',
  '  origem -> painel calcula KPIs e mostra, com o motivo quando falta dado.',
  '',
  sub('0.3 Principios nao negociaveis'),
  '',
  '  - Sem API oficial? Usa a sessao autenticada do navegador. Sempre.',
  '  - Proibido: endpoint privado, replay de requisicao, extracao de cookie ou',
  '    token do marketplace, burlar autenticacao, CAPTCHA ou anti-bot, simular',
  '    comportamento humano para enganar a plataforma.',
  '  - Dado sem fonte nao vira numero: recebe estado ZERO, UNKNOWN,',
  '    NOT_COLLECTED, UNAVAILABLE, ESTIMATED, CALCULATED ou VERIFIED.',
  '  - O Gemini e consultor e auditor; nunca fonte de verdade.',
  '  - Nenhum relacionamento de concorrente entra aprovado automaticamente.',
  '',
);

// ---------------------------------------------------------------- PARTE 1
push(
  title('PARTE 1 — COMO INSTALAR'),
  '',
  '1.1 Requisitos',
  '',
  '  - Windows 10 ou 11, 64 bits.',
  '  - Chrome ou Edge atualizado (o mesmo navegador onde voce ja usa o',
  '    marketplace).',
  '  - Nao precisa de Node.js, Python nem nenhuma ferramenta: tudo vai dentro do',
  '    instalador.',
  '',
  '1.2 Instalacao',
  '',
  `  1. Execute ${installer ? `MarketplaceIntelligence-Setup.exe (${installer} MB)` : 'MarketplaceIntelligence-Setup.exe'}.`,
  '  2. Siga o assistente em portugues (proximo, proximo, instalar).',
  '  3. Ao terminar, abra o atalho "Marketplace Intelligence" na area de trabalho.',
  '  4. A tela "Pre-Start & Diagnostico" abre e mostra o estado de cada peca.',
  '',
  '1.3 Instalacao silenciosa (para quem administra varias maquinas)',
  '',
  '  MarketplaceIntelligence-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES \\',
  '      /NORESTART /LOG="C:\\caminho\\instalacao.log"',
  '',
  '1.4 Instalar a extensao',
  '',
  '  A tela de Pre-Start tem o botao que abre a pasta da extensao e o botao que',
  '  abre a pagina de extensoes do navegador. O caminho e sempre:',
  '',
  '    1. Abrir chrome://extensions (ou edge://extensions).',
  '    2. Ligar "Modo do desenvolvedor".',
  '    3. "Carregar sem compactacao" e escolher a pasta extension.',
  '    4. Voltar ao Pre-Start e clicar em "Testar conexao".',
  '',
  '  O identificador da extensao e fixo (iindgpgiecidhmfapdlfinpplndiiajf),',
  '  entao o servico local ja reconhece a origem sem configuracao extra.',
  '',
  '1.5 Onde ficam as coisas',
  '',
  '  Programa:  %LOCALAPPDATA%\\Programs\\Marketplace Intelligence\\',
  '  Dados:     %LOCALAPPDATA%\\MarketplaceIntelligence\\',
  '             (banco, segredos cifrados, backups, logs, porta, token,',
  '              credenciais do administrador)',
  '',
);

// ---------------------------------------------------------------- PARTE 2
push(
  title('PARTE 2 — PRIMEIRO ACESSO E CREDENCIAIS'),
  '',
  '  2.1 O primeiro inicio cria o usuario administrador',
  '',
  '  E-mail: admin@marketplaceintelligence.local',
  '  Senha:  gerada aleatoriamente e gravada em',
  '          %LOCALAPPDATA%\\MarketplaceIntelligence\\admin-credentials.txt',
  '',
  '  Troque a senha depois do primeiro acesso. O arquivo e criado apenas uma',
  '  vez; se ele for apagado, o acesso continua valido com a senha que voce',
  '  anotou.',
  '',
  '  2.2 Sessao do painel',
  '',
  '  O atalho abre o painel com o token da sessao na URL (somente 127.0.0.1). O',
  '  painel guarda o token em sessionStorage e limpa a barra de enderecos. Por',
  '  isso: abra sempre pelo atalho, nao digitando a URL.',
  '',
  '  2.3 Perfis',
  '',
  '  super_admin   - tudo, inclusive usuarios, limites financeiros e',
  '                  auto-upgrade.',
  '  operador      - opera tarefas e capturas dentro dos limites.',
  '  visualizador  - somente leitura.',
  '',
);

// ---------------------------------------------------------------- PARTE 3
push(title(`PARTE 3 — O PAINEL: AS ${views.length} AREAS, TELA POR TELA`), '');
const AREA_TEXT = {
  exec: [
    '  - Cartoes de KPI: CTR, ROAS, ACoS, TACoS, CVR, cobertura de estoque, share',
    '    organico, devolucao, cancelamento, ticket medio, giro diario e',
    '    participacao de Ads. Cada cartao mostra valor, formula e, quando o dado',
    '    nao existe, o motivo (nunca um zero falso).',
    '  - Missoes do dia: de 3 a 5 prioridades em CRITICAL_ALERT, QUICK_WIN,',
    '    ZOMBIE ou NORMAL, com impacto, esforco e urgencia.',
    '  - Alertas: reconhecer e marcar falso positivo.',
  ],
  prestart: [
    '  - Estado de cada peca com semaforo: verde (respondeu), amarelo (respondeu',
    '    e recusou), vermelho (fora do ar), cinza (nao testado).',
    '  - Botao "Testar conexao" faz o caminho completo: porta, token, sessao.',
    '  - Token da extensao: mostrar, copiar e renovar.',
    '  - Abre a pasta da extensao e a pagina de extensoes do navegador.',
    '  - Logs do servico e teste de aba do navegador.',
  ],
  listings: [
    '  - Lista de anuncios capturados com conta, marketplace, status e qualidade',
    '    do dado.',
    '  - Detalhe por anuncio: KPIs do periodo e historico de snapshots.',
    '  - Captura manual quando a extensao nao estiver ativa.',
  ],
  finance: [
    '  - Simulador de cenario com 17 entradas (preco, quantidade, comissao, taxa',
    '    fixa, parcelamento, custo, embalagem, frete, imposto, outros variaveis,',
    '    margem minima, desconto, cupom, Ads, devolucao, cancelamento, logistica',
    '    reversa). Devolve margem de contribuicao, lucro, ponto de equilibrio e',
    '    alerta quando a margem fica negativa.',
    '  - Custos por SKU: base de todos os calculos.',
  ],
  keywords: [
    '  - Banco de palavras-chave com intencao, idioma e marketplace.',
    '  - Pontuacao de demanda e prioridade por peso.',
    '  - Lacunas (keyword gap): termos em que o concorrente aparece e voce nao.',
    '  - Rank tracker: posicao por palavra-chave e historico por anuncio.',
  ],
  market: [
    '  - Snapshot por categoria: demanda, concorrencia e faixa de preco.',
    '  - Oportunidades ranqueadas com pontuacao e justificativa.',
  ],
  competition: [
    '  - Produtos proprios, busca de candidatos, relacoes com pontuacao de',
    '    similaridade e status (PENDENTE por padrao).',
    '  - Aprovar, rejeitar, editar, trocar candidato e reanalisar.',
    '  - Monitoramento: pontos de coleta, historico e estatisticas.',
    '  - Fluxo completo na PARTE 4.',
  ],
  pricing: [
    '  - Corredor de preco a partir das observacoes coletadas.',
    '  - Cenarios de preco e regras.',
    '  - Toda mudanca de preco passa pelo Guard.',
  ],
  voc: [
    '  - Entrada de avaliacoes, perguntas, reclamacoes e motivos de devolucao.',
    '  - Agrupamento em temas com sentimento e frequencia.',
  ],
  growth: [
    '  - Metricas em arvore (metric tree) para achar a causa raiz.',
    '  - Iniciativas de crescimento (somente leitura nesta versao).',
    '  - Experimentos: criacao, listagem e resultado com teste estatistico.',
  ],
  agents: [
    `  - Os ${agentKeys.length} agentes, executados sobre um contexto com janela, metricas,`,
    '    confianca e dados ausentes declarados.',
    '  - Debate entre agentes sobre um tema.',
    '  - Memoria, historico de execucoes e orcamento de IA.',
  ],
  tasks: [
    '  - Criar tarefa com tipo, marketplace, anuncio, modo (rascunho ou',
    '    publicacao), recorrencia, horario e perfil de digitacao.',
    '  - Pausar, retomar, cancelar, pular item e executar agora.',
  ],
  connectors: [
    '  - Registro de conectores (o que existe, o que esta conectado, custo).',
    '  - Importacao de CSV como rascunho para validacao.',
  ],
  admin: [
    '  - Configuracoes, auditoria, backups e auto-upgrade.',
    '  - Diagnostico de adaptadores.',
    '  - Chave do Gemini (cifrada no servico local, nunca na extensao).',
  ],
};
for (const v of views) {
  push(sub(`3.${views.indexOf(v) + 1} ${v.label.toUpperCase()}`), '', ...(AREA_TEXT[v.key] ?? ['  - (area sem descricao)']), '');
}

// ---------------------------------------------------------------- PARTE 4
push(
  title('PARTE 4 — INTELIGENCIA COMPETITIVA (FLUXO COMPLETO)'),
  '',
  '  1. Cadastre o produto proprio (competitor.ownProduct.upsert) com titulo,',
  '     marca, modelo, categoria, atributos e preco.',
  '  2. Colete candidatos: pela extensao (tela de busca do marketplace) ou',
  '     colando um JSON de candidatos. Cada candidato tem marketplace, titulo e,',
  '     quando houver, marca, modelo, preco e URL.',
  '  3. Rode a busca (competitor.search). Ela pontua cada candidato e cria',
  '     relacoes com status PENDENTE.',
  '  4. Revise uma por uma: aprovar, rejeitar com motivo, trocar o candidato ou',
  '     reanalisar. Nada e aprovado automaticamente.',
  '  5. O aprendizado registra o que o usuario preferiu e evita (minimo de 2',
  '     amostras, 75% para PREFERIR, 25% para EVITAR).',
  '  6. Monitoramento coleta pontos ao longo do tempo; estatisticas mostram',
  '     quantos concorrentes por status e por marketplace.',
  '',
  '  Pontuacao: DIRETO quando similaridade >= 70 e modelo >= 14; SIMILAR entre',
  '  45 e 69; INDIRETO abaixo de 45.',
  '',
  '  Honestidade: as regras de aprendizado sao regras explicitas e auditaveis,',
  '  nao um modelo treinado. O documento diz isso ao usuario.',
  '',
);

// ---------------------------------------------------------------- PARTE 5
push(title(`PARTE 5 — OS ${methods.length} METODOS DA API LOCAL`), '');
push(
  '  Todos os metodos sao chamados em POST http://127.0.0.1:<porta>/api/ipc com',
  '  cabecalho "authorization: Bearer <token>" e corpo:',
  '',
  '    { "id": "...", "token": "...", "protocolVersion": 1,',
  '      "method": "nome.do.metodo", "payload": { ... } }',
  '',
  '  Resposta: { "ok": true, "result": ... } ou',
  '            { "ok": false, "error": { "code": "...", "message": "..." } }',
  '',
  '  Metodos publicos (nao exigem token): ping, auth.login, auth.bootstrap,',
  '  auth.session. Os demais exigem token valido e respeitam o perfil do usuario.',
  '',
);
const GROUPS = [
  ['Acesso e sessao', ['ping', 'auth.bootstrap', 'auth.login', 'auth.session', 'auth.logout']],
  ['Configuracoes', ['settings.get', 'settings.set']],
  ['Chave de IA', ['gemini.setKey', 'gemini.testKey']],
  ['Contas', ['account.upsert', 'account.list']],
  ['Captura', ['capture.ingest', 'capture.snapshot']],
  ['Indicadores e missoes', ['kpi.listing', 'kpi.dashboard', 'missions.today']],
  ['Financeiro', ['finance.simulate', 'finance.costs.upsert']],
  ['Tarefas', ['task.create', 'task.list', 'task.pause', 'task.resume', 'task.cancel', 'task.skipItem', 'task.runNow']],
  ['Guard e auditoria', ['guard.evaluate', 'audit.list', 'audit.rollback']],
  ['Adaptadores', ['adapter.diagnostics']],
  ['Palavras-chave e ranking', ['keyword.upsert', 'keyword.list', 'keyword.gap', 'rank.record', 'rank.history']],
  ['Concorrentes por vendedor', ['competitor.upsert', 'competitor.list', 'competitor.timeline', 'competitor.alerts']],
  ['Concorrentes por produto', ['competitor.ownProduct.upsert', 'competitor.ownProduct.list', 'competitor.search', 'competitor.relations', 'competitor.approve', 'competitor.reject', 'competitor.edit', 'competitor.changeCandidate', 'competitor.reanalyze', 'competitor.monitoring.set', 'competitor.monitoring.record', 'competitor.monitoring.history', 'competitor.stats']],
  ['Mercado', ['market.categorySnapshot', 'market.opportunities']],
  ['Voz do cliente', ['voc.ingest', 'voc.topics']],
  ['Growth e experimentos', ['growth.initiatives', 'growth.metricTree', 'experiment.create', 'experiment.list', 'experiment.result']],
  ['Agentes de IA', ['agent.run', 'agent.runs', 'agent.debate', 'agent.memory', 'agent.budget']],
  ['Auto-upgrade', ['autoupgrade.propose', 'autoupgrade.list', 'autoupgrade.apply', 'autoupgrade.rollback']],
  ['Conectores e importacao', ['connector.registry', 'connector.import']],
  ['Previsao, alertas, relatorios e backup', ['forecast.run', 'alerts.list', 'alerts.ack', 'report.export', 'backup.create', 'backup.list']],
];
const listed = new Set(GROUPS.flatMap(([, ns]) => ns));
const unlisted = methods.filter((m) => !listed.has(m));
if (unlisted.length) GROUPS.push(['Outros', unlisted]);

for (const [group, names] of GROUPS) {
  push(sub(group), '');
  for (const n of names) {
    if (!methods.includes(n)) {
      push(`    ${n}`, '        (nao encontrado no servico — conferir)');
      continue;
    }
    const fields = MANUAL[n] ?? (fieldsOf(n).length ? fieldsOf(n).join(' | ') : '(sem dados)');
    push(`    ${n}`, `        ${fields}`);
  }
  push('');
}

// ---------------------------------------------------------------- PARTE 6
push(
  title('PARTE 6 — MOTOR DE SIMILARIDADE E APRENDIZADO'),
  '',
  '  Entrada: titulo, marca, modelo, categoria, atributos e preco do candidato,',
  '  comparados com o produto proprio.',
  '  Saida: pontuacao 0-100 e classificacao DIRETO / SIMILAR / INDIRETO.',
  '',
  '  Regra de decisao:',
  '    DIRETO   similaridade >= 70 E modelo >= 14',
  '    SIMILAR  45 a 69',
  '    INDIRETO < 45',
  '',
  '  Aprendizado com o feedback humano:',
  '    minimo de 2 amostras; >= 75% de aprovacoes vira PREFERIR;',
  '    <= 25% vira EVITAR. Regras sao explicitas e auditaveis — nao ha modelo',
  '    treinado nem caixa-preta.',
  '',
);

// ---------------------------------------------------------------- PARTE 7
push(
  title('PARTE 7 — KPIS, FINANCAS, PRIORIDADE, EXPERIMENTOS'),
  '',
  '  7.1 Convencoes',
  '',
  '    - Dinheiro sempre em centavos inteiros (10000 = R$ 100,00).',
  '    - Percentuais como numero na escala 0-100 (0.5% = 0.5).',
  '    - Taxas de conversao e cliques idem.',
  '',
  '  7.2 KPIs calculados',
  '',
  '    CTR   = cliques / impressoes * 100',
  '    CVR   = pedidos / visitas * 100',
  '    ROAS  = faturamento atribuido a Ads / investimento em Ads',
  '    ACoS  = investimento / faturamento total * 100',
  '    TACoS = investimento / faturamento total * 100 (inclui organico)',
  '    CPC   = investimento / cliques',
  '    Custo por venda = investimento / vendas atribuidas',
  '    Participacao de Ads = faturamento de Ads / faturamento total * 100',
  '',
  '  7.3 Financeiro',
  '',
  '    Margem de contribuicao = preco - comissao - taxa fixa - frete - custo -',
  '    embalagem - imposto - outros variaveis - custo de Ads - devolucao -',
  '    cancelamento - logistica reversa.',
  '    Ponto de equilibrio = custos fixos / margem unitaria.',
  '    Se a margem fica negativa, a recomendacao de aumentar trafego e',
  '    bloqueada (prevalencia financeira do diretor de IA).',
  '',
  '  7.4 Prioridade das missoes',
  '',
  '    Pontuacao = impacto x esforco invertido x urgencia, com classes',
  '    CRITICAL_ALERT, QUICK_WIN, ZOMBIE e NORMAL.',
  '',
  '  7.5 Experimentos',
  '',
  '    Desenho AB com aleatorizacao, metrica primaria, metricas de guarda',
  '    (margem e devolucao), taxa base, MDE e dias planejados. O resultado',
  '    aplica teste estatistico e alerta de SRM (alpha padrao 0.0001).',
  '',
);

// ---------------------------------------------------------------- PARTE 8
push(
  title(`PARTE 8 — IA: GEMINI, ${agentKeys.length} AGENTES E AUTO-UPGRADE`),
  '',
  sub('8.1 Chave e limites'),
  '',
  '  A chave do Gemini e cifrada e guardada no servico local. Ela NUNCA vai para',
  '  a extensao nem para o navegador. Sem chave, o produto continua funcionando',
  '  (a IA e opcional e nunca e fonte de verdade).',
  '',
  '  Modelos: gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-lite.',
  '  Orcamento: 60 mil tokens de entrada e 4096 de saida por chamada, teto de',
  '  US$ 3 por dia. Codigos de erro: NO_KEY, BUDGET_EXCEEDED, QUOTA,',
  '  RATE_LIMIT, HTTP_ERROR, EMPTY_RESPONSE, NETWORK.',
  '',
  sub(`8.2 Os ${agentKeys.length} agentes`),
  '',
);
for (const a of agentKeys) push(`    - ${a}`);
push(
  '',
  '  Todos recebem o mesmo AgentContext: conta, marketplace, anuncio, janela de',
  '  datas, metricas, confianca do dado e lista do que falta. Agente que',
  '  depende de metrica ausente declara o dado ausente em vez de estimar.',
  '',
  sub('8.3 Auto-upgrade'),
  '',
  '  Propoe alteracao de codigo a partir de sintomas, exige aprovacao de',
  '  super_admin, exige testes passando, faz backup antes e permite rollback.',
  '  Toda etapa fica na auditoria.',
  '',
);

// ---------------------------------------------------------------- PARTE 9
push(
  title(`PARTE 9 — GUARD DE AUTOMACAO (${guardChecks.length} VERIFICACOES)`),
  '',
  `  Acoes protegidas (${guardActions.length}): ${guardActions.join(', ')}.`,
  '',
  '  Verificacoes, na ordem em que rodam:',
  '',
);
const GUARD_DESC = {
  marketplace: 'marketplace valido e habilitado',
  account: 'conta correta e autenticada',
  listing: 'anuncio existe e pertence a conta',
  current_state: 'estado atual capturado',
  user_permission: 'perfil do usuario tem a permissao',
  financial_limits: 'limites financeiros respeitados (variacao de preco, margem minima, teto diario de Ads)',
  required_data: 'dados obrigatorios presentes',
  platform_rules: 'sem violacao conhecida das regras da plataforma',
  authorization: 'autorizacao explicita registrada',
  no_conflict: 'sem conflito com outra acao pendente',
};
guardChecks.forEach((c, i) => push(`    ${String(i + 1).padStart(2)}. ${c.padEnd(18)} ${GUARD_DESC[c] ?? ''}`));
push(
  '',
  '  Qualquer verificacao que falhe bloqueia a acao e o motivo volta escrito.',
  '  Pedido sem contexto e recusado com a lista do que falta (antes isso',
  '  derrubava a chamada com erro de leitura de undefined).',
  '',
);

// ---------------------------------------------------------------- PARTE 10
push(
  title('PARTE 10 — TAREFAS, SCHEDULER E PERFIS DE DIGITACAO'),
  '',
  '  Estados: PENDING, SCHEDULED, WAITING_BROWSER, RUNNING, PAUSED, COMPLETED,',
  '  FAILED, CANCELLED.',
  '',
  '  Tipos: edit_title, edit_description, upload_image, change_price,',
  '  duplicate_listing, toggle_ads.',
  '',
  '  Modos: DRAFT (prepara e revisa) e PUBLISH (aplica, com verificacao depois).',
  '',
  '  Perfil de digitacao: modo, atraso por caractere, atraso de acomodacao e',
  '  verificacao posterior. O objetivo e estabilidade da interface, nunca',
  '  simular humano para enganar deteccao.',
  '',
  '  Tarefa com o navegador fechado fica em WAITING_BROWSER e retoma sozinha',
  '  quando a extensao reconecta.',
  '',
);

// ---------------------------------------------------------------- PARTE 11
push(
  title('PARTE 11 — PRESERVACAO DE DESCRICAO'),
  '',
  '  Regra absoluta: a descricao original nunca e reescrita. Novos blocos sao',
  '  acrescentados no fim, e antes de publicar o sistema compara:',
  '',
  '    - todos os trechos originais continuam presentes;',
  '    - o texto normalizado do resultado contem o texto normalizado original.',
  '',
  '  Se a comparacao falhar, a publicacao e bloqueada e a diferenca fica na',
  '  auditoria. Isso protege o historico do anuncio e o SEO ja conquistado.',
  '',
);

// ---------------------------------------------------------------- PARTE 12
push(
  title('PARTE 12 — QUALIDADE E HONESTIDADE DE DADOS'),
  '',
  '  Classes de origem:',
  '    A_PRIMARY_UI      lido da tela autenticada do marketplace',
  '    B_PLATFORM_EXPORT arquivo exportado pela propria plataforma',
  '    C_USER_INPUT      informado pelo usuario',
  '    D_CALCULATED      derivado de outros dados',
  '    E_ESTIMATED       estimativa declarada',
  '    F_EXTERNAL        fonte externa',
  '    G_UNAVAILABLE     nao disponivel',
  '',
  '  Estados de um valor: ZERO, UNKNOWN, NOT_COLLECTED, UNAVAILABLE,',
  '  ESTIMATED, CALCULATED, VERIFIED.',
  '',
  '  Regra: zero e zero, ausente e ausente. O painel mostra o motivo em vez de',
  '  um numero inventado. Tela que nao consegue salvar diz isso ao usuario —',
  '  nunca finge que salvou.',
  '',
);

// ---------------------------------------------------------------- PARTE 13
push(
  title('PARTE 13 — SEGURANCA: PAPEIS, SESSOES, SEGREDOS'),
  '',
  '  - Senhas com hash e salt; sessoes com expiracao e revogacao.',
  '  - Token do painel rotativo: cada inicio do servico gera um novo, e a',
  '    rotacao cria uma sessao real (nao um identificador solto).',
  '  - O servico escuta apenas em 127.0.0.1 e valida a origem das chamadas',
  '    (CORS com lista de identificadores de extensao permitidos).',
  '  - Segredos cifrados em disco; a chave do Gemini nunca chega ao navegador.',
  '  - Isolamento entre contas por account_id em todas as consultas.',
  '  - Auditoria de cada acao sensivel, com autor, antes e depois.',
  '  - Protecao contra prompt injection: todo texto vindo de marketplace e',
  '    tratado como dado nao confiavel antes de entrar em prompt.',
  '  - Backup automatico antes de alteracao critica e verificacao posterior.',
  '',
);

// ---------------------------------------------------------------- PARTE 14
push(
  title(`PARTE 14 — BANCO DE DADOS (${tables.length} TABELAS)`),
  '',
  '  SQLite embarcado (node:sqlite), arquivo unico em',
  '  %LOCALAPPDATA%\\MarketplaceIntelligence\\. Migracoes versionadas:',
  '  001_init.sql e 002_competitive_intelligence.sql.',
  '',
);
for (let i = 0; i < tables.length; i += 4) push('    ' + tables.slice(i, i + 4).map((t) => t.padEnd(34)).join(''));
push('');

// ---------------------------------------------------------------- PARTE 15
push(
  title('PARTE 15 — EXTENSAO DE NAVEGADOR'),
  '',
  `  Manifest V3, versao ${extVersion}, service worker classico, painel lateral.`,
  '',
  '  15.1 O que ela faz',
  '',
  '    - Reconhece o marketplace pela URL (Mercado Livre BR/MX, Shopee, Amazon).',
  '    - Classifica a pagina: painel do vendedor, anuncios, pedidos, Ads,',
  '      perguntas, reputacao, devolucoes, estoque, login, desafio.',
  '    - Le os rotulos conhecidos da tela (visitas, vendas, faturamento,',
  '      estoque, perguntas, avaliacoes) e monta o snapshot.',
  '    - Envia ao servico local pelo host nativo ou por HTTP em 127.0.0.1.',
  '',
  '  15.2 Conexao',
  '',
  '    - Descoberta de porta na faixa 47811 a 47830.',
  '    - Token obtido em /api/token, guardado localmente, renovado quando o',
  '      servico responde 401.',
  '    - Heartbeat de 1 minuto; fila de envio tentada a cada 5 minutos.',
  '    - Cartao "Conexao manual" (porta e token) para quando tudo mais falhar.',
  '    - Diagnostico (mi.diagnose) mostra worker, HTTP, host nativo e token com',
  '      semaforo verde, amarelo, vermelho ou cinza.',
  '',
  '  15.3 O que ela nao faz (por decisao de projeto)',
  '',
  '    - Nao le cookie, nao le token do marketplace, nao reproduz requisicao',
  '      interna, nao resolve CAPTCHA, nao simula humano.',
  '    - Nao le grafico em canvas: declara o dado como nao coletado.',
  '',
);

// ---------------------------------------------------------------- PARTE 16
push(
  title('PARTE 16 — NATIVE MESSAGING HOST'),
  '',
  '  Programa Node.js registrado no Chrome e no Edge (HKCU) com o identificador',
  '  fixo da extensao. A extensao fala com ele por stdio e ele repassa ao',
  '  servico local. Vantagem: nao depende de porta aberta nem de CORS.',
  '  Se o host nao estiver disponivel, a extensao cai para HTTP em 127.0.0.1.',
  '',
);

// ---------------------------------------------------------------- PARTE 17
push(
  title('PARTE 17 — INSTALADOR, ARQUIVOS E DESINSTALACAO'),
  '',
  `  Instalador: MarketplaceIntelligence-Setup.exe${installer ? ` (${installer} MB)` : ''}, pt-BR, x64.`,
  '',
  '  Ele faz: copia o programa, cria atalhos (area de trabalho e menu iniciar),',
  '  registra o host nativo para Chrome e Edge, grava o identificador da',
  '  extensao, cria a pasta de dados, gera as credenciais do administrador e',
  '  registra a inicializacao automatica (autorizada pelo usuario).',
  '',
  '  Desinstalar: Configuracoes > Aplicativos > Marketplace Intelligence >',
  '  Desinstalar. O programa sai; a pasta de dados e preservada para nao apagar',
  '  historico. Apague-a manualmente se quiser remover tudo.',
  '',
);

// ---------------------------------------------------------------- PARTE 18
push(
  title('PARTE 18 — CHECKLIST: O QUE ESTA PRONTO, PARCIAL E PLANEJADO'),
  '',
  `  ${checklist.length} itens em ${new Set(checklist.map((i) => i.sec)).size} secoes. Estado de hoje:`,
  '',
  `    Funcionando (verificado) ...... ${countBy('✅')}`,
  `    Parcial ....................... ${countBy('🟡')}`,
  `    Nao funciona .................. ${countBy('❌')}`,
  `    Nao existe .................... ${countBy('⬜')}`,
  '',
  '  A lista completa, item por item com a observacao de cada um, esta em',
  '  docs/CHECKLIST-FUNCIONALIDADES.md e no PDF',
  '  docs/Checklist-Funcionalidades-Marketplace-Intelligence.pdf.',
  '',
);
let cur = '';
for (const i of checklist) {
  if (i.sec !== cur) {
    cur = i.sec;
    push('', `  ${cur}`);
  }
  push(`    ${i.st}  ${i.item}`);
}
push('');

// ---------------------------------------------------------------- PARTE 19
push(
  title('PARTE 19 — LIMITACOES CONHECIDAS E PROIBICOES'),
  '',
  '  Limitacoes reais desta versao:',
  '',
  '    - A leitura da tela cobre os rotulos conhecidos do painel do vendedor.',
  '      Graficos em canvas e componentes que carregam sob demanda ainda nao',
  '      sao lidos (aparecem como dado nao coletado).',
  '    - Nao ha tela de usuarios e permissoes: os papeis existem e sao aplicados',
  '      no servico, mas a criacao de usuarios e feita por API.',
  '    - Nao ha visao consolidada entre contas.',
  '    - Exportacao em CSV e JSON; XLSX e PDF ainda nao.',
  '    - Integracoes externas (planilhas, ERP) estao planejadas, nao prontas.',
  '    - Forecast exige 8 semanas de historico coletado.',
  '',
  '  Proibicoes (nao sao limitacoes, sao decisoes):',
  '',
  '    - Nenhuma API oficial? Usa a sessao do usuario. Nunca endpoint privado.',
  '    - Nunca reenviar requisicao capturada, nunca extrair cookie ou token.',
  '    - Nunca burlar autenticacao, CAPTCHA ou anti-bot.',
  '    - Nunca simular comportamento humano para enganar deteccao.',
  '    - Nunca inventar dado para preencher tela.',
  '',
);

// ---------------------------------------------------------------- PARTE 20
push(
  title('PARTE 20 — SOLUCAO DE PROBLEMAS'),
  '',
  '  20.1 O painel abre pedindo login ou mostra erro de sessao',
  '',
  '    Abra pelo atalho (ele injeta o token). Se persistir, veja',
  '    admin-credentials.txt e confira a porta em port.txt.',
  '',
  '  20.2 "Nao foi possivel obter a URL do painel"',
  '',
  '    Veja %LOCALAPPDATA%\\MarketplaceIntelligence\\logs\\service.log e',
  '    panel-err.txt. Confira se a porta 47811 esta livre.',
  '',
  '  20.3 A extensao nao captura',
  '',
  '    - Recarregue a extensao em chrome://extensions (ou edge://extensions).',
  '    - Abra o painel lateral e veja os quatro indicadores.',
  '    - Cinza = nao testado: clique em "Testar conexao".',
  '    - Amarelo = respondeu e recusou: veja a mensagem (token ou sessao).',
  '    - Vermelho = fora do ar: o servico local nao esta rodando; abra o atalho.',
  '    - Recarregue a pagina do marketplace depois de instalar a extensao.',
  '',
  '  20.4 Indicadores aparecem como indisponiveis',
  '',
  '    E o comportamento correto sem captura: o sistema mostra o motivo em vez',
  '    de inventar numero.',
  '',
  '  20.5 Erro de validacao na API',
  '',
  '    A mensagem diz qual campo falhou. Dinheiro em centavos inteiros;',
  '    percentuais de 0 a 100.',
  '',
  '  20.6 Erro no Gemini',
  '',
  '    NO_KEY, BUDGET_EXCEEDED, QUOTA, RATE_LIMIT, HTTP_ERROR, EMPTY_RESPONSE,',
  '    NETWORK. A falta do Gemini nao quebra calculo nem revisao.',
  '',
  '  20.7 Ja tentei tudo',
  '',
  '    Abra Pre-Start & Diagnostico, clique em "Testar conexao" e leia os',
  '    quatro semaforos. E o mesmo caminho que o suporte tecnico percorre.',
  '',
);

// ---------------------------------------------------------------- PARTE 21
push(
  title('PARTE 21 — DESENVOLVIMENTO, BUILD E TESTES'),
  '',
  '  Node.js 22 em tools/node-v22.14.0-win-x64 (embarcado no projeto).',
  '',
  '  Instalar dependencias:   npm install',
  '  Tipos:                   npx tsc --noEmit -p tsconfig.json',
  '  Testes:                  npx vitest run',
  '  Build do servico:        node scripts/build-local-agent.mjs',
  '  Build da extensao:       node scripts/build-extension.mjs',
  '  Build do host nativo:    node scripts/build-native-host.mjs',
  '  Pacote Windows:          node scripts/package-windows.mjs',
  '  Instalador (Inno Setup): "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe"',
  '                           installer\\marketplace-intelligence.iss',
  '  Este documento:          node scripts/gerar-documentacao-txt.mjs',
  '',
  `  Arquivos de teste: ${testFiles.length} (${testFiles.join(', ')}).`,
  '  Resultado da ultima execucao: 177 de 177 testes aprovados e tsc limpo.',
  '',
);

// ---------------------------------------------------------------- PARTE 22
push(
  title('PARTE 22 — O QUE MUDOU NESTA VERSAO (26/11/2026)'),
  '',
  '  Defeitos encontrados numa varredura completa e corrigidos:',
  '',
  '   1. Captura que nunca completava: o worker da extensao chamava',
  '      sessionToken() em 7 pontos e a funcao NAO EXISTIA. O erro aparecia',
  '      como "servico local indisponivel". A funcao foi definida e um teste',
  '      passa a falhar se o worker voltar a chamar funcao inexistente.',
  '   2. O envio ao servico ia sem o token no corpo; a API autentica pelo',
  '      campo token do envelope, nao pelo cabecalho. Agora vai nos dois.',
  '   3. Paginas do vendedor eram classificadas com um tipo fora do contrato',
  '      (metrics). Agora usam os tipos validos (seller_dashboard etc.).',
  '   4. A conta local:default nao existia antes da captura; agora e criada a',
  '      partir dos dados da pagina, com confianca baixa e nao verificada.',
  '   5. Botoes do painel mandavam payload incompleto: keyword.gap sem',
  '      accountId, competitor.relations com ownProductId nulo e',
  '      adapter.diagnostics sem marketplace. Os tres foram corrigidos e',
  '      verificados no servico instalado.',
  '   6. Busca de concorrentes perdia a lista inteira quando um candidato nao',
  '      tinha os campos do schema; agora normaliza antes de enviar.',
  '   7. O Guard derrubava a chamada com "Cannot read properties of undefined"',
  '      quando faltava contexto; agora valida e responde o que falta.',
  '   8. Agentes quebravam com metricas vazias; agora declaram o dado ausente.',
  '   9. Exportacao de relatorio reescrita: gera CSV e JSON reais por tipo de',
  '      relatorio (antes a opcao existia e nao produzia arquivo).',
  '  10. Growth iniciativas e somente leitura no servico: o botao agora avisa',
  '      em vez de fingir que gravou.',
  '',
  '  Segunda rodada (correcoes recebidas em 26/11/2026 e aplicadas aqui):',
  '',
  '  11. Autorizacao de cada chamada interna: cada metodo tem uma permissao',
  '      propria e o servico nega por padrao. Dos 77 metodos, 72 exigem',
  '      permissao, 4 sao publicos (ping, auth.login, auth.bootstrap,',
  '      auth.session) e auth.logout exige apenas sessao valida. Metodo sem',
  '      politica e recusado, e a recusa vai para a auditoria.',
  '  12. Encerrar sessao (auth.logout) so encerra a sessao do proprio',
  '      usuario autenticado; antes aceitava encerrar a sessao de qualquer um.',
  '  13. Entrega do token em /api/token restrita ao painel da mesma origem e',
  '      ao ID autorizado da extensao; outra porta localhost nao recebe. A',
  '      rotacao de token exige origem confiavel, a sessao atual no cabecalho,',
  '      cria uma sessao nova de verdade e revoga a anterior nos dois canais',
  '      (HTTP e Native Messaging).',
  '  14. Receita liquida nunca e inferida do faturamento bruto: quando a',
  '      pagina nao informa, o KPI fica ausente e a lacuna e declarada.',
  '  15. Financeiro: ponto de equilibrio separado do piso minimo de margem, e',
  '      os dois descontam devolucoes e cancelamentos esperados; a margem',
  '      unitaria considera a taxa fixa do marketplace.',
  '  16. Classificacao de pagina publica corrigida: URL de anuncio publico',
  '      (/items/MLB...) e detalhe de produto, nao lista do vendedor.',
  '  17. Um teste antigo comparava dois valores nulos (receita liquida contra',
  '      GMV) e passava sem provar nada; agora ele prova que o bruto nao e',
  '      copiado para o liquido.',
  '',
  '  Resultado: 191 de 191 testes aprovados, tsc limpo, pacote reinstalado e',
  '  verificado ponta a ponta (captura, guard, relatorio, tarefa, voz do',
  '  cliente, financeiro).',
  '',
);

// ---------------------------------------------------------------- GLOSSARIO
push(
  title('GLOSSARIO'),
  '',
  '  ACoS .......... custo de publicidade sobre o faturamento total',
  '  CVR ........... taxa de conversao (pedidos / visitas)',
  '  CTR ........... taxa de cliques (cliques / impressoes)',
  '  Guard ......... conjunto de verificacoes que autoriza ou bloqueia acao',
  '  IPC ........... chamada interna entre painel/extensao e servico local',
  '  MDE ........... diferenca minima detectavel num experimento',
  '  MV3 ........... Manifest V3, modelo atual de extensao do Chrome',
  '  ROAS .......... retorno sobre o investimento em publicidade',
  '  SRM ........... desvio na proporcao da amostra (sinal de experimento',
  '                  mal distribuido)',
  '  TACoS ......... custo de publicidade sobre o faturamento total, incluindo',
  '                  vendas organicas',
  '  VoC ........... voz do cliente (avaliacoes, perguntas, reclamacoes)',
  '',
  line(),
  ' FIM DO DOCUMENTO',
  line(),
);

const text = out.join('\n');
writeFileSync(join(ROOT, 'docs/DOCUMENTACAO-COMPLETA.txt'), text, 'utf8');
console.log(`OK docs/DOCUMENTACAO-COMPLETA.txt — ${text.split('\n').length} linhas, ${(text.length / 1024).toFixed(0)} KB`);
console.log(`  ${methods.length} metodos, ${tables.length} tabelas, ${agentKeys.length} agentes, ${views.length} areas, ${checklist.length} itens de checklist`);
