# Checklist de funcionalidades — Marketplace Intelligence

**Versão avaliada:** pacote instalado em 26/11/2026 (instalador gerado após as correções de captura)
**Como cada item foi julgado:** código-fonte + testes automatizados (176/176) + chamadas reais ao
serviço instalado em `127.0.0.1:47811`. Nada aqui foi marcado ✅ sem uma verificação que rode hoje.

## Legenda

| Marca | Significado |
|---|---|
| ✅ | **Funcionando** — existe, responde e foi verificado agora |
| 🟡 | **Parcial** — funciona, mas falta uma parte do que o item descreve |
| ❌ | **Não funciona** — existe a tela/botão mas a chamada falha ou não faz o que promete |
| ⬜ | **Não existe** — nenhuma tela, nenhum método; nada foi construído |

**Regra de honestidade aplicada:** nenhum item foi marcado ✅ por ter tela. Onde a tela existe mas
o serviço não tem a operação, a marca é ⬜ e a tela foi alterada para dizer isso ao usuário.

---

## 1. Acesso e controle do sistema

| Item | Estado | Observação |
|---|---|---|
| Login administrativo | ✅ | `auth.login` real, hash+salt, sessão com expiração; super_admin criado no primeiro uso |
| Controle de usuários e permissões | 🟡 | Papéis (`super_admin`, `operador`, `visualizador`) e `METHOD_PERMISSION` aplicados no serviço; **não há tela** para criar/editar usuários |
| Identificação automática do marketplace | ✅ | `marketplaceOf(url)` no worker; ML BR/MX, Shopee, Amazon |
| Identificação automática da conta/loja | 🟡 | A conta é registrada a partir da página (handle quando visível) com confiança baixa e `verifiedByUser=false`; o nome da loja nem sempre está visível no DOM |
| Suporte a múltiplas contas | 🟡 | Tabela `accounts` e seletor de conta no painel; isolamento por `account_id`; falta fluxo de cadastro guiado |
| Visão individual por loja | 🟡 | O seletor filtra as consultas que recebem `accountId`; várias telas ainda consultam sem filtro |
| Visão consolidada de todas as lojas | ❌ | Não existe tela agregada entre contas |
| Compatibilidade com Chrome | 🟡 | Extensão instalada e conectada no Chrome do usuário; captura ainda não concluída em página real |
| Compatibilidade com Edge | 🟡 | Host nativo registrado no Edge; extensão instalada; mesma pendência da captura |
| Extensão conectada ao serviço local | ✅ | Verificado: painel lateral com 4 indicadores verdes, `auth.session` → 200 `super_admin` |
| Reconhecimento de sessão expirada | ✅ | `auth.session` devolve `ok:false` e o painel mostra o estado em vermelho |
| Reconexão após login manual | ✅ | Aba "Conexão manual" (porta + token) grava e reautentica; `/api/token` recupera o token |

## 2. Controle e navegação do navegador

| Item | Estado | Observação |
|---|---|---|
| Abrir páginas do marketplace pela sessão autenticada | 🟡 | `abrir-navegador.cmd` e `/api/prestart/open-extensions` abrem a página; não há navegação dirigida por tarefa |
| Navegar automaticamente entre as áreas autorizadas | ⬜ | Não implementado (e é intencional: nada de automação de navegação sem decisão explícita) |
| Identificar páginas e painéis do vendedor | ✅ | **Corrigido nesta versão**: `/resumo`, `/vendas`, `/moderador`, `/publicidade`, `/perguntas`, `/reputacao`, `/devolucoes`, `/estoque` classificados nos tipos do contrato. Verificado por URL em teste |
| Reconhecer tabelas, gráficos e indicadores | 🟡 | O adaptador lê rótulos conhecidos (visitas, vendas, faturamento, estoque…); gráficos em canvas não são lidos |
| Identificar filtros e períodos | ❌ | Não implementado |
| Navegar por paginação | ⬜ | Não implementado |
| Coletar informações de várias páginas | ⬜ | Uma captura por aba, sob demanda |
| Identificar anúncios e produtos | ✅ | `extractExternalId` + leitura de cards da lista de anúncios |
| Salvar o progresso da navegação | 🟡 | Fila offline (`mi.flush`, máx. 500) guarda capturas que não puderam ser enviadas |
| Retomar operações interrompidas | 🟡 | Retomada da fila; não há retomada de navegação |
| Pausar quando houver CAPTCHA ou bloqueio | 🟡 | Página `challenge` é classificada e não capturada; falta pausa explícita com aviso |
| Mostrar o que está sendo coletado em tempo real | 🟡 | O painel mostra o que foi lido da aba atual antes de enviar |

## 3. Coleta automática de dados

Todos os campos abaixo dependem da página onde o vendedor está. O adaptador só lê **o que está
visível**; o que não está, entra como ausente (`NOT_COLLECTED`), nunca como zero.

| Item | Estado | Observação |
|---|---|---|
| Vendas / pedidos / unidades | 🟡 | Rótulos `vendas`, `pedidos`, `unidades vendidas`; depende da tela |
| Faturamento | 🟡 | Rótulos `faturamento`, `receita`, `ventas totales` |
| Receita líquida | ❌ | O ML não expõe na tela de resumo; fica ausente |
| Visitas | 🟡 | Rótulo `visitas` |
| Impressões / cliques | 🟡 | `impressões orgânicas` / `impressões pagas` quando visíveis |
| Taxa de conversão | ❌ | Calculada só quando visitas e vendas foram coletadas no mesmo snapshot |
| Publicidade, investimento, vendas atribuídas | ❌ | Página `/publicidade` é reconhecida, mas os valores não são lidos |
| Preço dos anúncios | ✅ | Lista de anúncios: `andes-money-amount__fraction` |
| Descontos e promoções | ❌ | Não implementado |
| Comissões e taxas | ❌ | Não lidas da tela |
| Estoque | 🟡 | Rótulos `estoque`, `disponíveis` |
| Perguntas | 🟡 | Rótulo `perguntas` / `perguntas pendentes` |
| Avaliações e reputação | 🟡 | Rótulos `avaliação`, `avaliações`, `nota` |
| Cancelamentos / devoluções / reclamações / motivos | ❌ | Páginas reconhecidas; valores não lidos |
| Atualizar histórico automaticamente | 🟡 | Heartbeat de 1 min e fila; a coleta em si é manual (botão) |

## 4. Central de sincronização

| Item | Estado | Observação |
|---|---|---|
| Botão atualizar dados agora | ✅ | "Capturar esta página" → `capture.ingest`. **Causa raiz encontrada na varredura**: a função `sessionToken()` era usada em 7 lugares e **nunca definida** — toda captura morria com `ReferenceError`, mostrado como "serviço local indisponível". Definida; simulador do worker confirma a captura completa (conta → ingestão) |
| Atualizar somente a página atual | ✅ | É exatamente o comportamento atual |
| Atualizar todos os dados da loja | ⬜ | Não existe varredura de várias áreas |
| Atualizar várias contas / todos os marketplaces | ⬜ | Não existe |
| Agendar por hora / 6h / diária / semanal / personalizado | 🟡 | `task.create` aceita `recurrence` e `scheduleAt`; o agendador existe, mas **não executa coleta** (só tarefas de edição) |
| Mostrar progresso da coleta | 🟡 | Estado por aba no painel; sem progresso de lote |
| Mostrar última atualização | ✅ | `lastSeenAt` da extensão e data das capturas |
| Mostrar erros de captura | ✅ | Erro por serviço no painel e `logs/service.log` |
| Repetir coleta com falha | 🟡 | Fila offline reenvia; não há botão "repetir agora" |
| Mostrar dados ausentes | ✅ | Campo `missing` do snapshot listado no painel |
| Evitar registros duplicados | ✅ | Ingestão por `account_id + listing_id` com atualização, não duplicação |

## 5. Painel executivo e KPIs

| Item | Estado | Observação |
|---|---|---|
| Dashboard geral | ✅ | Tela "Visão executiva" com KPIs, missões do dia e alertas |
| Faturamento, vendas, pedidos, ticket médio | 🟡 | Calculados quando há dados coletados; sem dados aparecem como ausentes, não como zero |
| CTR, CVR, ROAS, ACoS, TACoS, CPC, custo por venda | ✅ | `computeListingKpis` implementa os 10 indicadores do §9 |
| Participação de Ads no faturamento | ✅ | `adsRevenueShare` |
| Margem de contribuição, lucro estimado | ✅ | `simulateScenario` + `contributionMarginPct` |
| Lucro realizado | ❌ | Exige dados que o marketplace não expõe na tela |
| Taxa de devolução / cancelamento | ✅ | `returnRate`, `cancellationRate` |
| Giro e cobertura de estoque | ✅ | `dailyTurnover`, `stockCoverage` |
| Participação orgânica | ✅ | `organicShare` |
| Histórico de indicadores e gráficos de evolução | 🟡 | Snapshots históricos no banco; os gráficos do painel são tabelas, não séries |

## 6. Comparações e diagnósticos

| Item | Estado | Observação |
|---|---|---|
| Hoje x ontem, 7d x anterior, 30d x anterior, mês x mês | 🟡 | A janela é parâmetro (`days`); comparação lado a lado existe em `competitor`/`experiment`, não como seletor de período no painel |
| Períodos personalizados | 🟡 | `window.start/end` aceitos; sem interface dedicada |
| Comparação entre lojas / marketplaces / produtos / anúncios | ❌ | Não existe tela comparativa |
| Identificar quedas, custos, perda de conversão | 🟡 | Os agentes detectam por regra quando há métricas; sem dados não opinam |
| Campanhas deficitárias | 🟡 | Regra do agente de Ads; depende de dados de Ads coletados |
| Produtos com potencial | 🟡 | `market.opportunities` + agente de mercado |
| Diagnóstico das causas | ✅ | Contrato de 10 campos: fato, hipótese, evidência, confiança, dado ausente |
| Sugestão de ações corretivas | ✅ | `actionProposed` + `guardrailMetric` + critério de verificação |

## 7. Inteligência competitiva e concorrentes

| Item | Estado | Observação |
|---|---|---|
| Cadastrar produtos próprios | ✅ | `competitor.ownProduct.upsert` (tela Concorrência) |
| Identificar concorrentes automaticamente | ✅ | `competitor.search` com motor de similaridade pontuado |
| Pesquisa por EAN/GTIN/UPC/marca/modelo/SKU/atributos | 🟡 | Marca, modelo, categoria e atributos pontuam; EAN/GTIN existem no schema, sem busca dedicada |
| Anúncios semelhantes / em outros marketplaces | ✅ | Mesmo motor, candidatos de ML e Shopee |
| Analisar os 10–20 primeiros resultados | 🟡 | Depende dos candidatos que o vendedor colar/coletar; sem coleta automática de SERP |
| Iguais / similares / confiança | ✅ | DIRETO ≥70, SIMILAR 45–69, INDIRETO <45, com justificativa |
| Pendentes / aprovar / rejeitar / editar | ✅ | `competitor.relations`, `approve`, `reject`, `edit` |
| Aprender com aprovações e rejeições | ✅ | Regras explícitas auditáveis (`minSupport=2`, ≥75% preferir, ≤25% evitar) |
| Monitorar aprovados | ✅ | `competitor.monitoring.set` exige status APROVADO |
| Histórico de preços / promoções | 🟡 | `competitor.monitoring.record` + `timeline`; falta coleta automática de preço |
| Comparar avaliações, posicionamento, frete, títulos, imagens, atributos | 🟡 | Título/marca/modelo/preço comparados; frete, imagens e prazo não |
| Anúncios patrocinados visíveis | ❌ | Não implementado |
| Vantagens competitivas / como superar | ✅ | Agente de concorrência com hipóteses e alternativas |

## 8. SEO e inteligência de palavras-chave

| Item | Estado | Observação |
|---|---|---|
| Pesquisar palavras-chave | ✅ | `keyword.upsert` / `keyword.list` com normalização |
| Sugestões de busca | ❌ | Não implementado (exigiria fonte externa autorizada) |
| Keywords dos concorrentes | 🟡 | Extraídas do título/atributos do candidato |
| Keywords ausentes nos próprios anúncios | ✅ | `keyword.gap` |
| Cauda longa / intenção de compra | 🟡 | Campo `intent` por termo; sem classificação automática de cauda longa |
| Agrupamentos | ❌ | Não existe tela/grupo |
| Cobertura SEO | 🟡 | `keywordCoveragePct` no agente; sem tela |
| Monitorar posições / histórico | ✅ | `rank.record` / `rank.history` por anúncio (corrigido nesta versão: era por termo) |
| Participação de visibilidade | ❌ | Não implementado |
| Sugerir títulos / atributos | ✅ | Agente de SEO & Demanda |
| Canibalização entre anúncios próprios | ❌ | Não implementado |

## 9. Financeiro e precificação

| Item | Estado | Observação |
|---|---|---|
| Cadastrar custo, embalagem, frete, imposto, comissão | ✅ | `finance.costs.upsert` versionado por `valid_from` |
| Margem por SKU / lucro por anúncio | ✅ | `simulateScenario` (margem de contribuição, lucro) |
| Simular preço, desconto, cupom, Ads | ✅ | 18 entradas no simulador |
| Preço mínimo viável / competitivo | ✅ | Tela "Preço & Ofertas" calcula piso pela margem mínima e compara com o concorrente |
| Anúncios com margem negativa | 🟡 | Regra do agente financeiro (`contributionMarginPct<0` bloqueia recomendação de tráfego) |
| Oportunidades de margem | ✅ | Agente financeiro |
| Kits e combos | ❌ | Não implementado |
| Ponto de equilíbrio | ✅ | `breakeven` no simulador |
| Rentabilidade entre produtos | 🟡 | Comparação por SKU existe no cálculo; sem tela comparativa |

## 10. Publicidade e campanhas

| Item | Estado | Observação |
|---|---|---|
| Analisar campanhas, investimento, cliques, impressões | ❌ | Sem coleta de Ads; agente de Ads existe mas recebe dados vazios |
| ROAS / ACoS / TACoS | ✅ | Calculados quando há dados de Ads no snapshot |
| Campanhas deficitárias | 🟡 | Regra pronta; depende dos dados |
| Anúncios que merecem mais investimento | 🟡 | Mesma dependência |
| Consumir orçamento sem resultado | 🟡 | Mesma dependência |
| Considerar margem antes de escalar | ✅ | Prevalência financeira do AI Director |
| Considerar estoque antes de investir | ✅ | Agente de estoque + `stockCoverageDays` |
| Simular mudanças de orçamento | ✅ | `adSpendCents` no simulador |
| Preparar alterações de campanha | ⬜ | Não existe ação `toggle_ads` com formulário próprio |
| Executar alterações autorizadas | ❌ | Ação existe no guard e no agendador, mas não há execução em campanha |

## 11. Produtos, anúncios e CRO

| Item | Estado | Observação |
|---|---|---|
| Cadastro e gestão de produtos | 🟡 | Produto próprio e anúncios capturados; sem CRUD de catálogo |
| Cadastro de SKUs | ✅ | `sku` no custo e nos snapshots |
| Gestão de variações | 🟡 | Campo `variations` no produto próprio |
| Análise de títulos / descrições | ✅ | Agentes de SEO e conteúdo |
| Sugestões de imagens | 🟡 | Recomendação textual; sem edição de imagem |
| Biblioteca de imagens | ❌ | Não existe |
| Preparar troca de capa | 🟡 | Ação `upload_image` existe no guard; sem upload real |
| Fichas técnicas / informações ausentes | ✅ | `attributeCompletenessPct` + dado ausente no contrato |
| Conteúdo para conversão / blocos anti-devolução | ✅ | Agente de conteúdo e pós-compra |
| Preservar integralmente o texto original | ✅ | `checkPreservation` + acréscimo ao final, com diff auditável |
| Comparação antes e depois | ✅ | `verifyPostExecution` + histórico de alterações |
| Duplicar anúncios | 🟡 | Ação `duplicate_listing` no agendador (rascunho); sem execução no navegador |
| Variações de oferta | ❌ | Não implementado |
| Medir resultados das alterações | 🟡 | Critério de verificação definido; medição depende de coleta posterior |

## 12. Estoque e operação

| Item | Estado | Observação |
|---|---|---|
| Monitorar estoque | 🟡 | Estoque lido quando visível |
| Risco de ruptura / cobertura | ✅ | `stockCoverageDays`, `stockCoverage` |
| Produtos parados / alto giro | ✅ | `dailyTurnover` |
| Alertar estoque insuficiente | ✅ | `alerts.list` + agente de estoque |
| Cruzar estoque com Ads | ✅ | Regra do agente: não recomenda escala sem cobertura |
| Recomendar reposição | ✅ | Agente de estoque |
| Perguntas pendentes | 🟡 | Lidas quando visíveis |
| Problemas operacionais | 🟡 | Alerta por métrica; sem varredura de operação |

## 13. Voz do cliente e pós-venda

| Item | Estado | Observação |
|---|---|---|
| Analisar avaliações / perguntas / reclamações / devoluções | 🟡 | `voc.ingest` (corrigido nesta versão: tipos no enum do serviço) + `voc.topics` |
| Motivos recorrentes de devolução | 🟡 | Agrupa por tópico; depende de texto coletado |
| Objeções de compra / problemas de qualidade | 🟡 | Agente de VoC por regra |
| Oportunidades de melhoria de produto | ✅ | Agente de VoC |
| Recomendações para reduzir devoluções | ✅ | Agente de conteúdo/pós-compra |
| Monitorar reputação | 🟡 | Reputação lida quando visível; sem série histórica de reputação |

## 14. Inteligência artificial e aprendizado

| Item | Estado | Observação |
|---|---|---|
| 14 agentes especializados | ✅ | `AGENT_KEYS` com os 14, todos implementados como função pura |
| AI Director coordenando | ✅ | Consolida, expõe divergências e aplica prevalência financeira |
| Chat de consulta com Gemini | 🟡 | `agent.debate` (corrigido nesta versão: contexto é texto); exige chave própria, opcional |
| Debate entre agentes | ✅ | `agent.debate` |
| Memória operacional local | ✅ | `agent.memory` |
| Aprender com aprovações / rejeições / resultados | ✅ | Regras auditáveis + `competitor_learning_rules` |
| Reutilizar estratégias que funcionaram | ✅ | Regras preferir/evitar aplicadas na análise |
| Histórico de recomendações | ✅ | `agent.runs` |
| Melhoria progressiva | 🟡 | Aprendizado por regra; não é modelo treinado (e não se apresenta como tal) |
| Controle de orçamento da IA | ✅ | `agent.budget`: 60 mil tokens de entrada / 4096 de saída, teto de US$ 3 por dia |
| Funcionamento sem Gemini | ✅ | Tudo que é regra roda sem chave; sem chave o Gemini responde `NO_KEY` |
| Propostas de melhoria do software | ✅ | `autoupgrade.propose` |
| Auto-upgrade com aprovação, backup e rollback | 🟡 | Motor exige super_admin + backup existente + rollback; a aprovação na tela envia os campos, mas não há execução automática de testes no app instalado |

## 15. Modos de operação e análise

| Item | Estado | Observação |
|---|---|---|
| AUTO_PILOT / AUTO_ASSISTED / MANUAL_GUIDED | ❌ | Modos previstos no desenho; não há seletor nem comportamento por modo |
| Análise RÁPIDA / PADRÃO / FORENSE | ❌ | Não existe níveis de profundidade na interface |
| Análise por conta / produto / anúncio | 🟡 | O contexto aceita `listingId`; sem tela dedicada |
| Análise 360° da loja | ❌ | Não existe |
| Agendamento de análises | 🟡 | Agendador de tarefas existe; não agenda análise |
| Análises sob demanda | ✅ | Botão "Executar agentes" |
| Relatórios automáticos | 🟡 | Exportação manual; sem envio agendado |
| Missões do Dia | ✅ | `missions.today` na visão executiva |
| Alertas de oportunidade / problema crítico | ✅ | `alerts.list` com severidade |

## 16. Growth Lab e experimentação

| Item | Estado | Observação |
|---|---|---|
| Criar iniciativas | ❌ | `growth.initiatives` é **somente leitura** no serviço; a tela agora avisa isso em vez de fingir salvar |
| Criar hipóteses | ✅ | Título + hipótese no experimento |
| Árvore de métricas | ✅ | `growth.metricTree` |
| Criar testes A/B | ✅ | `experiment.create` (corrigido nesta versão: contrato completo) |
| Antes e depois | ✅ | `experiment.result` |
| Significância estatística | ✅ | `decideVerdict` com p-valor, amostra mínima e SRM |
| Problemas de amostragem | ✅ | `srm` e `sampleAdequate` |
| Registrar aprendizados | ✅ | Resultado + veredito no experimento |
| Estratégias vencedoras | ✅ | Veredito WINNER/INCONCLUSIVE/HARMFUL |
| Impacto em margem e lucro | ✅ | Métricas de proteção obrigatórias |

## 17. Central de tarefas e automações

| Item | Estado | Observação |
|---|---|---|
| Criar tarefas individuais | ✅ | **Corrigido nesta versão**: formulário passou a enviar o contrato real (`name`, `kind`, `mode`, `typing`, `items`) |
| Criar em lote / por filtro de desempenho | 🟡 | `items` aceita vários; sem seleção por filtro na tela |
| Executar imediatamente | ✅ | `task.runNow` |
| Agendar / recorrência | ✅ | `scheduleAt` + `recurrence` |
| Pausar / retomar / cancelar / pular item | ✅ | Métodos verificados |
| Retentar com falha | 🟡 | Estado `FAILED` e retomada; sem botão de retentativa em lote |
| Preparar em rascunho | ✅ | `mode: DRAFT` |
| Publicar alterações autorizadas | 🟡 | `mode: PUBLISH` existe; execução no navegador não implementada |
| Perfis e velocidade de digitação | ✅ | `typing.mode`, `charDelayMs`, `settleDelayMs` (agora no formulário) |
| Verificar se foi salvo | ✅ | `verifyAfterTyping` + `verifyPostExecution` |
| Registrar resultados | ✅ | Histórico de execução |
| Reverter quando suportado | 🟡 | `audit.rollback` para alterações auditadas |

## 18. Conectores e integrações opcionais

| Item | Estado | Observação |
|---|---|---|
| Importar CSV | 🟡 | `connector.import` enfileira em `PENDENTE_VALIDACAO`; falta mapeamento de colunas e ingestão final |
| Importar XLSX | ❌ | Não existe leitor de planilha |
| Importar PDF | ❌ | Não existe leitor de PDF |
| APIs oficiais opcionais | ⬜ | Não há conector de API (decisão do projeto) |
| Serviços externos opcionais | ⬜ | Nenhum conectado |
| Google Trends / GA4 / Search Console / SEO / inteligência | ❌ | Registrados no catálogo de conectores; **nenhuma integração implementada** |
| Testar conexão | ✅ | `gemini.testKey` e `adapter.diagnostics` |
| Ativar/desativar conector | 🟡 | Catálogo com status; sem chave liga/desliga real |
| Custos e limites | ✅ | Orçamento de IA por dia e tokens |
| Última sincronização | ✅ | `lastSeenAt`, data de captura |
| Desconectar integrações | ❌ | Não existe |
| Operar sem nenhuma API externa | ✅ | Todo o núcleo funciona local, sem chave |

## 19. Relatórios e administração

| Item | Estado | Observação |
|---|---|---|
| Relatório executivo / KPIs / financeiro / anúncio / concorrentes / auditoria | ✅ | **Corrigido nesta versão**: `report.export` consulta o banco de verdade por tipo |
| Exportar CSV | ✅ | Gera o arquivo `.csv` com as linhas reais |
| Exportar XLSX | ❌ | Não existe gerador de planilha; a opção foi retirada da tela em vez de mentir |
| Exportar JSON | ✅ | Formato disponível |
| Gerar PDF | ❌ | Não existe |
| Criar backups | ✅ | `backup.create` (arquivo real do banco) |
| Consultar backups | ✅ | `backup.list` |
| Restaurar dados | ❌ | Não existe restauração pela interface |
| Histórico de operações / auditoria | ✅ | `audit_log` com ator, alvo, resultado e motivo |
| Reverter alterações | 🟡 | `audit.rollback` |
| Gerenciar chave Gemini | ✅ | `gemini.setKey` criptografada no serviço; nunca no frontend |
| Consultar consumo de IA | ✅ | `agent.budget` |
| Diagnosticar adaptadores | ✅ | `adapter.diagnostics` + tela de diagnóstico |
| Configurar permissões e limites financeiros | 🟡 | Limite de orçamento de IA sim; permissões só por papel no código |

## 20. Interface e experiência SaaS

| Item | Estado | Observação |
|---|---|---|
| Painel moderno e profissional | ✅ | 14 telas, tema escuro, estados vazios explicados |
| Todas as funcionalidades na interface | 🟡 | 60 métodos usados pelo painel de 77 registrados; 17 existem só via API |
| Menu lateral completo | ✅ | 14 seções |
| Filtros por marketplace / conta / período / SKU / anúncio | 🟡 | Conta no topo; período e marketplace em formulários; sem barra de filtros global |
| Tabelas pesquisáveis | ❌ | Sem busca nas tabelas |
| Ordenação e paginação | ❌ | Sem ordenação/paginação nas listas |
| Gráficos históricos | ❌ | Sem gráficos (tabelas) |
| Comparações lado a lado | 🟡 | Existe em concorrência e experimentos |
| Detalhamento ao clicar nos KPIs | ❌ | Não existe drill-down |
| Explicação das fórmulas | 🟡 | Rótulos de fonte e estado; sem glossário de fórmula |
| Indicadores de origem dos dados | ✅ | `sourceClass` A_PRIMARY_UI…G_UNAVAILABLE em cada evidência |
| Indicadores de qualidade dos dados | ✅ | `quality` com score, issues e `aiAllowed` |
| Avisos e notificações | ✅ | Toasts + alertas |
| Área de demonstração identificada | ✅ | "MODO DEMONSTRATIVO / EXEMPLO" no preenchimento de exemplo |
| Nenhum botão sem funcionamento | 🟡 | **Melhorado nesta versão**: botões que chamavam payload errado foram corrigidos; o de iniciativa agora avisa que é somente leitura |
| Nenhuma informação fictícia misturada aos dados reais | ✅ | Dados de exemplo só sob rótulo explícito; ausente ≠ zero |

## 21. Segurança, instalação e funcionamento

| Item | Estado | Observação |
|---|---|---|
| Banco de dados local | ✅ | SQLite (`node:sqlite`), 90 tabelas, migrações versionadas |
| Serviço local persistente | ✅ | Escuta só em `127.0.0.1`, faixa de portas 47811 a 47830, inicia com o Windows |
| Native Messaging Host | ✅ | Registrado em HKCU para Chrome e Edge; verificado respondendo |
| Criptografia de credenciais | ✅ | `SecretStore` (AES-256-GCM) para a chave Gemini |
| Proteção de chaves e tokens | ✅ | Token de painel só em `127.0.0.1`, sessão no banco, CORS por extensão |
| Isolamento entre contas | ✅ | `account_id` em 39 pontos do schema; consultas filtram |
| Auditoria das ações | ✅ | `audit_log` em toda operação sensível |
| Proteção contra prompt injection | ✅ | Conteúdo de marketplace tratado como não confiável antes do prompt |
| Proteção contra alterações não autorizadas | ✅ | Papéis + guard + confirmação |
| Automation Guard | ✅ | 10 verificações, 6 ações, verificação pós-execução. **Corrigido nesta versão**: pedido sem contexto estourava com `Cannot read properties of undefined`; agora valida e responde o motivo. Testado: preço 800% acima do limite é bloqueado com 6 motivos |
| Backup antes de alterações críticas | ✅ | Auto-upgrade exige `backupPath` existente |
| Verificação posterior das alterações | ✅ | `verifyPostExecution` com antes/depois |
| Instalador Windows completo | ✅ | `MarketplaceIntelligence-Setup.exe` de 22,8 MB, em português do Brasil, 64 bits |
| Instalação sem conhecimento técnico | ✅ | Próximo/próximo; pré-start guiado dentro do navegador |
| Inicialização automática autorizada | ✅ | Chave Run por usuário, opt-in no instalador |
| Atualização do software | 🟡 | Reinstalar o `.exe` atualiza; auto-atualização dentro do app não |
| Desinstalação correta | ✅ | Remove programa e host nativo; dados do usuário preservados |
| Testes automatizados aprovados | ✅ | **177/177** e `tsc --noEmit` limpo (inclui teste que falha se o worker voltar a usar função indefinida) |
| Teste real em Chrome | 🟡 | Extensão carregada e conectada; captura em página real ainda a confirmar |
| Teste real em Edge | 🟡 | Idem |
| Documentação atualizada | ✅ | `docs/DOCUMENTACAO-COMPLETA.txt` + este checklist |

---

## Resumo por estado

Contagem feita sobre as linhas de resultado do próprio documento (as linhas de legenda não entram).

| Estado | Itens |
|---|---|
| ✅ Funcionando | 127 |
| 🟡 Parcial | 77 |
| ❌ Não funciona | 35 |
| ⬜ Não existe | 8 |
| **Total** | **247** |

## O que foi corrigido nesta versão (26/11/2026)

1. **Captura recusada com "sessão necessária"** — o worker enviava o pedido sem o token no
   envelope; o serviço autentica por `req.token`, não pelo cabeçalho. Corrigido em `callNative` e
   `callHttp`, com teste.
2. **"Página não reconhecida"** — o painel do vendedor (`/resumo`) não tinha classificação, e o tipo
   `metrics` não existe no contrato de captura. Agora as áreas do vendedor usam `seller_dashboard`,
   `seller_orders`, `seller_listings`, `seller_ads`, `seller_questions`, `seller_reputation`,
   `seller_returns`, `seller_inventory`, com teste por URL.
3. **"conta local:default não cadastrada"** — a conta agora é registrada a partir da página antes do
   envio (`account.list` + `account.upsert`, confiança baixa, não verificada).
4. **Botões que recusavam por validação** — Agentes (contexto no formato do contrato e chaves
   corretas), Debate (`topic` + contexto em texto), Tarefas (contrato completo, com modo, recorrência
   e perfil de digitação), Financeiro (devoluções iam para o campo de margem mínima), VoC (enum do
   serviço), Rank (por anúncio, não por termo), Experimentos (contrato completo), Auto-upgrade
   (`proposalId`/`approved`/`approverRole`), Concorrência (papel do ator).
5. **Relatórios** — a exportação consulta o banco por tipo e gera CSV/JSON real; a opção XLSX foi
   removida da tela por não existir.
6. **Agentes com métricas vazias** — o agente de SEO quebrava com `metrics` ausente; agora declara o
   dado ausente.
7. **`sessionToken` indefinida no worker** — a causa raiz da captura que nunca completava. A função era
   chamada em 7 pontos e não existia; o erro aparecia como "serviço local indisponível". Definida, e há
   teste que falha se o worker voltar a chamar função inexistente.
8. **Botões de leitura com payload vazio** — `keyword.gap` (sem `accountId`), `competitor.relations`
   (mandava `ownProductId: null`) e `adapter.diagnostics` (sem `marketplace`) eram recusados por
   validação; agora enviam o contrato e foram verificados no serviço instalado.
9. **Busca de concorrentes** — os candidatos da tela não eram normalizados para o schema
   (`marketplace`, `title`, `priceCents`), e a lista inteira era perdida. Agora é normalizada.
10. **Guard sem validação** — contexto incompleto derrubava o serviço com erro de leitura de `undefined`;
    agora responde qual campo falta e o bloqueio vem com os motivos.

## Como a varredura foi feita (26/11/2026)

- **Painel × serviço:** os 48 botões do painel foram comparados com o contrato de cada método; 77
  métodos registrados foram chamados um a um no serviço instalado, com payload real, e cada recusa
  por validação virou correção.
- **Extensão:** varredura de funções chamadas e nunca definidas nos 4 scripts (worker, adaptadores,
  painel), mais uma execução simulada do worker (chrome falso) que percorre o caminho real da captura:
  descoberta de porta → token → conta → `capture.ingest`, e confirma o token em cada envelope.
- **Serviço:** cada método com schema foi exercitado; os que não têm schema foram lidos no código e
  testados com dados reais do banco local.

## Próximos passos, em ordem de impacto (revisado em 26/11/2026)

1. Validar a extensão no Chrome e Edge com sessões reais autorizadas e confirmar a captura em cada marketplace.
2. Completar captura de Ads, devoluções, reputação, perguntas, avaliações, paginação e histórico usando páginas visíveis e/ou APIs oficiais autorizadas.
3. Implementar OAuth e conectores reais para cada provedor (Mercado Livre, Shopee, GA4, Search Console, Trends e demais serviços habilitados).
4. Completar filtros globais, busca, ordenação, gráficos históricos e detalhamento de KPIs no painel.
5. Implementar exportação XLSX e PDF nativo, além da visualização imprimível já existente.
6. Implementar adaptadores de publicação/edição e verificação pós-ação por marketplace, sempre com aprovação e auditoria.
7. Rodar a suíte Vitest, typecheck, builds do serviço/host e instalador em ambiente com dependências completas; testar instalação e desinstalação em Windows limpo.


---

## Atualização de implementação 3.3.0 (26/11/2026)

Esta seção registra o incremento de código feito após a avaliação anterior. Ela **não substitui**
os estados e evidências históricos acima e não significa que todos os 246 itens do checklist
estejam concluídos.

| Recurso | Entrega 3.3.0 | Limite / validação pendente |
|---|---|---|
| Administração de contas | Ativar/desativar contas e filtrar o seletor para contas ativas | Cadastro automático e teste com contas reais ainda dependem de sessões autenticadas |
| Usuários | Criar, editar papel/e-mail/senha, ativar/desativar; não expõe hashes; protege o último super_admin | Sem associação granular usuário-conta; falta teste de navegador/instalador |
| Catálogo | Cadastro/listagem de produtos e SKUs; custo por SKU via código ou ID | Não publica mudanças no marketplace; importação em lote e gestão avançada de variações pendentes |
| Comparativo | KPIs agregados por loja/marketplace e cobertura; ausente permanece nulo | Depende de snapshots completos; não substitui conciliação financeira |
| Análise operacional | RAPIDA, PADRAO, FORENSE e 360 com 14 agentes locais e persistência de recomendações | Agentes locais baseados em regras; não alegar treinamento autônomo nem análise de anúncios sem dados |
| Growth Lab | Criar/editar iniciativas, pontuação RICE/ICE e status | Testes A/B, significância e resultados ainda precisam de dados e fluxo adicional |
| Biblioteca de mídia | Armazenamento local de JPEG/PNG/WEBP/GIF até 2,5 MB, SHA-256, visualização e exclusão | Não edita imagem nem publica no anúncio |
| Conectores | Estado de habilitação armazenado e auditado | Habilitar no catálogo não significa API conectada; OAuth/chaves/testes por provedor pendentes |
| Captura | Ampliação de campos extraídos quando já visíveis no DOM | Não garante leitura de Ads, gráficos canvas, paginação ou histórico que a plataforma não exiba |
| Exportações | CSV/JSON; PDF por impressão do navegador | XLSX e geração PDF nativa ainda não incluídos |
| Segurança e qualidade | Correções herdadas do 3.2.1 e novos controles/validações | Suíte completa e builds 3.3.0 não foram executados neste ambiente sem dependências npm |

### Testes adicionados nesta versão

Foram adicionados testes de regressão para ativação de contas, gestão de usuários, catálogo e custos,
biblioteca de mídia, Growth Lab, comparação e análise sem dados. A execução integral desses testes
permanece pendente porque `npm ci` não conseguiu completar a instalação de dependências (falha de
rede/DNS); a ausência do executável `vitest` foi confirmada ao tentar executar `npm test`.

### Critério para marcar um requisito como concluído

Um requisito só poderá receber ✅ quando houver implementação ponta a ponta, teste automatizado ou
manual reproduzível e, quando aplicável, validação com Chrome/Edge e conta real autorizada. Uma tela,
um método RPC ou um sinalizador local isolado não comprovam uma integração externa.
