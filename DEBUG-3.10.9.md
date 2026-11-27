# Parecer e revisão candidata 3.10.9 — 27/11/2026

Base: 3.10.8, commit GitHub `474b6e8555a4a666544dced08ea691cda5353fd2`, árvore `f57803b147caf24454d6b2f3cb44039fb114f297`. Árvore reproduzida pelo ZIP. CI da base: [execução concluída com sucesso](https://github.com/diegolordelo16-netizen/LordMarketplacesAnalytics/actions/runs/45988067051). O código novo está neste ZIP, não foi publicado no GitHub.

## Diagnóstico confirmado e correções desta revisão

- P0 — `packages/local-agent/panel/src/app.js`: a verificação anterior de tela não diferenciava conta nem geração de renderização; erros de uma requisição antiga também podiam sobrescrever a tela nova. Adicionada geração de renderização, verificação de conta e proteção do histórico. Testes de resposta atrasada e erro atrasado.
- P0 — `packages/extension/service-worker.js`: a primeira falha de captura podia avançar para outras áreas e a retomada adicionava nova posição para uma página anteriormente falha. Corrigido: a página inicial falha fica pendente, a varredura para e uma tentativa da mesma URL reutiliza o registro; no sucesso, a URL sai da fila. Testes no limite de páginas e com área secundária.
- P0 — `packages/local-agent/panel/src/app.js`: a tela de concorrência mantinha produto selecionado de outra conta e não enviava accountId nas consultas de estatísticas/relações; regras de aprendizado podiam vir de outras contas. Corrigida seleção pelo catálogo da loja atual e escopo de consulta. Teste de troca de loja; não é prova de isolamento de todos os endpoints.
- P1 — `packages/local-agent/panel/src/app.js`: erros de leitura em KPIs, alertas, missões, histórico, captura, tarefas, conectores e seletor de contas podiam ser exibidos como ausência de dados. Revisadas essas consultas, aviso de falha no acompanhamento de lote e mensagens de atualização. Outras telas ainda precisam de revisão sistemática de fallbacks. Bloqueado duplo clique no mesmo botão de solicitar/agendar/repetir coleta enquanto a ação está pendente; idempotência no serviço continua pendente.
- P1 — `.github/workflows/ci.yml`: a suíte testava o pacote da extensão antes de compilar; o teste existente retornava cedo na ausência de dist. Agora os builds precedem a suíte, a CI inclui testes de regressão e auditoria estática. Não houve execução da CI para esta revisão.

## Arquitetura: dashboard e extensão

O dashboard possui 20 entradas de navegação em `VIEWS`. Existe a tela Extensão & Coletas, com diagnóstico HTTP/host nativo, escopo, agendamentos, histórico e progresso. `sync.createAll` registra o pedido; `sync.claimBrowserRequest` permite ao worker reivindicar o lote; a extensão lê o DOM das abas autenticadas e envia os dados ao agente; o progresso é persistido via `sync.accountProgress` em SQLite; `sync.list` abastece a tela. A captura direta da aba e sua paginação são ações do painel lateral. Não há uma tela dedicada de Ads ou estoque na navegação atual; métricas e ações pontuais existem em outras telas. A tela Conectores aceita token manual para GA4/GSC e testa a propriedade, sem renovar OAuth nem sincronizar métricas externas. Os 515 checks incluem contratos, handlers e referências, mas não comprovam o funcionamento de todas as telas com dados reais.

## Riscos e ajustes ainda abertos, com fundamento no código

1. `sync.claimScheduled` recupera RUNNING pelo started_at de 30 minutos, sem verificar atividade recente como `sync.claimBrowserRequest`; exigir heartbeat/lease exclusivo e teste de dois workers. É um risco de corrida, não incidente observado.
2. `sync.retryFailed` cria novo lote de contas sem copiar cursor/páginas do lote antigo. Retomada de lease é diferente de repetir lote terminal; oferecer retomada de páginas ou explicitar recaptura completa, com deduplicação e reconciliação. O limite de 12 páginas por varredura precisa de continuação controlada para lojas grandes.
3. O manifest injeta scripts em `*.mercadolibre.com`, enquanto a identificação do worker e validação de progresso aceitam apenas domínio brasileiro de Mercado Livre. Alinhar suporte declarado e testado; não expandir domínios automaticamente.
4. Coleta depende de DOM e abas abertas; Amazon tem suporte observacional limitado. Validar dados de vendas, Ads, estoque, devoluções e filtros de cada marketplace antes de usar números para decisões.
5. Publicação assistida e rollback precisam de homologação real; manter autorização humana, snapshot anterior e estado de execução incerta. Não automatizar cliques de gravação sem evidência.
6. `google.ts` apenas verifica propriedade via GET e token fornecido; não implementa OAuth completo, refresh, consulta de métricas ou ingestão incremental. Importação PDF digital não equivale a OCR. Nenhuma credencial ou conta real foi usada.
7. Instalação Windows completa e restauração ainda precisam de teste em Windows limpo; não entregar executável não construído. Não declarar produção pronta.
8. O backend deve aplicar escopo de conta e permissão em cada operação, não só no dashboard. Revisar ações de mutação e métodos administrativos, testar com operador e visualizador. Outros fallbacks de leitura ainda precisam ser auditados.

## Validação executada nesta revisão

- 7/7 testes Node com VM e mocks de navegador/dashboard (`node --test scripts/regression-3109.test.mjs`).
- 515/515 verificações estáticas (`npm run audit`).
- Build da extensão (`npm run ext:build`), versão 3.10.9.
- SQLite: 18 migrations, 164 objetos de schema, integridade OK, zero violações FK (`node scripts/db-generate.mjs --check`).
- `node --check` nos JS alterados e `git diff --check` aprovados.
- Smoke local: 7/7 aprovados (CSV, XLSX, PDF digital, cadência, retentativas, SQLite).
- Smoke de publicação assistida: 10 verificações aprovadas, incluindo isolamento, uso único, concorrência, rollback e integridade SQLite.
- Bloqueados nesta revisão: npm ci (dependência zod não disponível em cache e tentativa online sem conclusão), Vitest, TypeScript completo, builds de agente e host e homologação real. Não reutilizar a aprovação da base como aprovação desta revisão.

## Matriz de execução das pendências

A classificação da matriz oficial 3.10.8 continua válida como referência: 188 implementados no código, 3 classificados como validados localmente e 174 parciais. Nenhum requisito foi promovido por esta correção pontual. Critérios abaixo são planejamento técnico, não provas de implementação. P0 = bloqueia estabilidade/segurança, P1 = bloqueia confiabilidade/fluxo operacional, P2 = evolução após estabilização. Todos os 174 IDs estão listados, em 21 seções.

### 1. Acesso e controle do sistema — 6 parciais (P0)

**Critério de aceite:** Validar identidade estável e isolamento de duas lojas simultâneas em cada navegador; provar que ausência de identidade bloqueia a captura.

- 3: Identificação automática do marketplace. — permanece parcial/pendente de evidência.
- 4: Identificação automática da conta/loja. — permanece parcial/pendente de evidência.
- 5: Suporte a múltiplas contas. — permanece parcial/pendente de evidência.
- 6: Visão individual por loja. — permanece parcial/pendente de evidência.
- 8: Compatibilidade com Chrome. — permanece parcial/pendente de evidência.
- 9: Compatibilidade com Edge. — permanece parcial/pendente de evidência.

### 2. Controle e navegação do navegador — 7 parciais (P0)

**Critério de aceite:** Fixtures de navegação, páginas com diferentes filtros, paginação, alteração de conta e CAPTCHA; interromper sem contornar verificações e provar recuperação de lease.

- 13: Abrir páginas do marketplace pela sessão autenticada. — permanece parcial/pendente de evidência.
- 14: Navegar automaticamente entre as áreas autorizadas. — permanece parcial/pendente de evidência.
- 16: Reconhecer tabelas, gráficos e indicadores. — permanece parcial/pendente de evidência.
- 17: Identificar filtros e períodos. — permanece parcial/pendente de evidência.
- 18: Navegar por paginação. — permanece parcial/pendente de evidência.
- 19: Coletar informações de várias páginas. — permanece parcial/pendente de evidência.
- 23: Pausar quando houver CAPTCHA ou bloqueio. — permanece parcial/pendente de evidência.

### 3. Coleta automática de dados — 24 parciais (P0)

**Critério de aceite:** Para cada campo e marketplace, comparar valores da página/relatório real com SQLite, origem, período e dashboard; ausente não é zero.

- 25: Coletar vendas. — permanece parcial/pendente de evidência.
- 26: Coletar pedidos. — permanece parcial/pendente de evidência.
- 27: Coletar unidades vendidas. — permanece parcial/pendente de evidência.
- 28: Coletar faturamento. — permanece parcial/pendente de evidência.
- 29: Coletar receita líquida quando disponível. — permanece parcial/pendente de evidência.
- 30: Coletar visitas. — permanece parcial/pendente de evidência.
- 31: Coletar impressões. — permanece parcial/pendente de evidência.
- 32: Coletar cliques. — permanece parcial/pendente de evidência.
- 33: Coletar taxas de conversão. — permanece parcial/pendente de evidência.
- 34: Coletar dados de publicidade. — permanece parcial/pendente de evidência.
- 35: Coletar investimentos em Ads. — permanece parcial/pendente de evidência.
- 36: Coletar vendas atribuídas aos Ads. — permanece parcial/pendente de evidência.
- 37: Coletar preço dos anúncios. — permanece parcial/pendente de evidência.
- 38: Coletar descontos e promoções. — permanece parcial/pendente de evidência.
- 39: Coletar comissões e taxas disponíveis. — permanece parcial/pendente de evidência.
- 40: Coletar estoque. — permanece parcial/pendente de evidência.
- 41: Coletar perguntas. — permanece parcial/pendente de evidência.
- 42: Coletar avaliações. — permanece parcial/pendente de evidência.
- 43: Coletar reputação. — permanece parcial/pendente de evidência.
- 44: Coletar cancelamentos. — permanece parcial/pendente de evidência.
- 45: Coletar devoluções. — permanece parcial/pendente de evidência.
- 46: Coletar reclamações. — permanece parcial/pendente de evidência.
- 47: Coletar motivos de devolução. — permanece parcial/pendente de evidência.
- 48: Atualizar histórico automaticamente. — permanece parcial/pendente de evidência.

### 4. Central de sincronização — 3 parciais (P0)

**Critério de aceite:** Executar lote com múltiplas contas, falhas, serviço desligado e retomada; provar que cada página é processada no máximo uma vez por coleta lógica.

- 51: Atualizar todos os dados da loja. — permanece parcial/pendente de evidência.
- 52: Atualizar várias contas. — permanece parcial/pendente de evidência.
- 53: Atualizar todos os marketplaces habilitados. — permanece parcial/pendente de evidência.

### 5. Painel executivo e KPIs — 7 parciais (P1)

**Critério de aceite:** Conciliar KPIs com exportações reais, janelas equivalentes, cobertura, unidade, origem e filtros de conta/anúncio.

- 66: Faturamento total. — permanece parcial/pendente de evidência.
- 67: Total de vendas. — permanece parcial/pendente de evidência.
- 68: Total de pedidos. — permanece parcial/pendente de evidência.
- 69: Ticket médio. — permanece parcial/pendente de evidência.
- 80: Lucro realizado quando possível. — permanece parcial/pendente de evidência.
- 86: Histórico de todos os indicadores. — permanece parcial/pendente de evidência.
- 87: Gráficos de evolução. — permanece parcial/pendente de evidência.

### 6. Comparações e diagnósticos — 10 parciais (P1)

**Critério de aceite:** Testar comparações com janelas equivalentes, denominadores, períodos incompletos e alertas; não inferir causa ou oportunidade sem evidência.

- 88: Hoje versus ontem. — permanece parcial/pendente de evidência.
- 89: Últimos 7 dias versus período anterior. — permanece parcial/pendente de evidência.
- 90: Últimos 30 dias versus período anterior. — permanece parcial/pendente de evidência.
- 91: Mês atual versus mês anterior. — permanece parcial/pendente de evidência.
- 94: Comparação entre marketplaces. — permanece parcial/pendente de evidência.
- 97: Identificação de quedas nas vendas. — permanece parcial/pendente de evidência.
- 98: Identificação de aumento de custos. — permanece parcial/pendente de evidência.
- 99: Identificação de perda de conversão. — permanece parcial/pendente de evidência.
- 100: Identificação de campanhas deficitárias. — permanece parcial/pendente de evidência.
- 101: Identificação de produtos com potencial de crescimento. — permanece parcial/pendente de evidência.

### 7. Inteligência competitiva e concorrentes — 20 parciais (P2)

**Critério de aceite:** Validar busca e ranking em resultados reais e consentidos, evidência por atributo, monitoramento e classificação revisada pelo usuário; separar identidade exata de similaridade.

- 105: Identificar concorrentes automaticamente. — permanece parcial/pendente de evidência.
- 106: Pesquisar pelo EAN. — permanece parcial/pendente de evidência.
- 107: Pesquisar pelo GTIN/UPC. — permanece parcial/pendente de evidência.
- 108: Pesquisar pela marca. — permanece parcial/pendente de evidência.
- 109: Pesquisar pelo modelo. — permanece parcial/pendente de evidência.
- 110: Pesquisar pelo SKU. — permanece parcial/pendente de evidência.
- 111: Pesquisar por atributos técnicos. — permanece parcial/pendente de evidência.
- 112: Pesquisar anúncios semelhantes. — permanece parcial/pendente de evidência.
- 113: Pesquisar anúncios em outros marketplaces suportados. — permanece parcial/pendente de evidência.
- 114: Analisar os 10 a 20 principais resultados, quando disponíveis. — permanece parcial/pendente de evidência.
- 124: Registrar histórico de preços. — permanece parcial/pendente de evidência.
- 125: Registrar promoções. — permanece parcial/pendente de evidência.
- 126: Comparar avaliações. — permanece parcial/pendente de evidência.
- 127: Comparar posicionamento. — permanece parcial/pendente de evidência.
- 128: Comparar frete e prazo. — permanece parcial/pendente de evidência.
- 129: Comparar títulos e palavras-chave. — permanece parcial/pendente de evidência.
- 130: Comparar imagens. — permanece parcial/pendente de evidência.
- 131: Comparar atributos e descrições. — permanece parcial/pendente de evidência.
- 132: Identificar anúncios patrocinados visíveis. — permanece parcial/pendente de evidência.
- 133: Identificar vantagens competitivas. — permanece parcial/pendente de evidência.

### 8. SEO e inteligência de palavras-chave — 8 parciais (P2)

**Critério de aceite:** Exibir origem, termos capturados, cobertura de SERP, agrupamento, intenção e canibalização; não inventar volume ou posição.

- 136: Identificar sugestões de busca. — permanece parcial/pendente de evidência.
- 137: Identificar palavras-chave dos concorrentes. — permanece parcial/pendente de evidência.
- 139: Identificar oportunidades de cauda longa. — permanece parcial/pendente de evidência.
- 140: Identificar intenção de compra. — permanece parcial/pendente de evidência.
- 141: Criar agrupamentos de palavras-chave. — permanece parcial/pendente de evidência.
- 142: Comparar cobertura SEO. — permanece parcial/pendente de evidência.
- 145: Calcular participação de visibilidade. — permanece parcial/pendente de evidência.
- 148: Identificar canibalização entre anúncios próprios. — permanece parcial/pendente de evidência.

### 9. Financeiro e precificação — 2 parciais (P1)

**Critério de aceite:** Conciliar margem negativa e rentabilidade com custos, taxas, devoluções e Ads efetivos; exibir ausência de dado.

- 161: Identificar anúncios com margem negativa. — permanece parcial/pendente de evidência.
- 165: Comparar rentabilidade entre produtos. — permanece parcial/pendente de evidência.

### 10. Publicidade e campanhas — 11 parciais (P1)

**Critério de aceite:** Adicionar tela dedicada de Ads por campanha/conta/anúncio/período, coleta de dados e reconciliação; alterações somente após aprovação explícita e confirmação real.

- 166: Analisar campanhas de Ads. — permanece parcial/pendente de evidência.
- 167: Analisar investimento. — permanece parcial/pendente de evidência.
- 168: Analisar cliques e impressões. — permanece parcial/pendente de evidência.
- 169: Analisar ROAS. — permanece parcial/pendente de evidência.
- 170: Analisar ACoS. — permanece parcial/pendente de evidência.
- 171: Analisar TACoS. — permanece parcial/pendente de evidência.
- 172: Identificar campanhas deficitárias. — permanece parcial/pendente de evidência.
- 173: Identificar anúncios que merecem mais investimento. — permanece parcial/pendente de evidência.
- 174: Identificar anúncios que consomem orçamento sem resultado. — permanece parcial/pendente de evidência.
- 178: Preparar alterações de campanhas. — permanece parcial/pendente de evidência.
- 179: Executar alterações autorizadas. — permanece parcial/pendente de evidência.

### 11. Produtos, anúncios e CRO — 6 parciais (P2)

**Critério de aceite:** CRUD de variações, imagens e duplicação conforme capacidade do marketplace; prévia, autorização, verificação e métricas posteriores.

- 182: Gestão de variações. — permanece parcial/pendente de evidência.
- 185: Sugestões de melhoria de imagens. — permanece parcial/pendente de evidência.
- 187: Preparar troca de imagem de capa. — permanece parcial/pendente de evidência.
- 194: Duplicar anúncios quando permitido. — permanece parcial/pendente de evidência.
- 195: Criar variações de ofertas. — permanece parcial/pendente de evidência.
- 196: Medir resultados das alterações. — permanece parcial/pendente de evidência.

### 12. Estoque e operação — 5 parciais (P1)

**Critério de aceite:** Painel de estoque por SKU e alertas com histórico; cruzar Ads e vendas, distinguir ausência de estoque de dado ausente.

- 197: Monitorar estoque. — permanece parcial/pendente de evidência.
- 198: Identificar risco de ruptura. — permanece parcial/pendente de evidência.
- 203: Cruzar estoque com campanhas de Ads. — permanece parcial/pendente de evidência.
- 205: Monitorar perguntas pendentes. — permanece parcial/pendente de evidência.
- 206: Monitorar problemas operacionais. — permanece parcial/pendente de evidência.

### 13. Voz do cliente e pós-venda — 8 parciais (P2)

**Critério de aceite:** Validar dados de avaliações, perguntas, reclamações e devoluções com páginas reais; mascarar dados pessoais, deduplicar e mostrar evidência.

- 207: Analisar avaliações. — permanece parcial/pendente de evidência.
- 208: Analisar perguntas. — permanece parcial/pendente de evidência.
- 209: Analisar reclamações. — permanece parcial/pendente de evidência.
- 210: Analisar devoluções. — permanece parcial/pendente de evidência.
- 211: Identificar motivos recorrentes de devolução. — permanece parcial/pendente de evidência.
- 212: Identificar objeções de compra. — permanece parcial/pendente de evidência.
- 213: Identificar problemas de qualidade. — permanece parcial/pendente de evidência.
- 216: Monitorar reputação. — permanece parcial/pendente de evidência.

### 14. Inteligência artificial e aprendizado — 4 parciais (P2)

**Critério de aceite:** Testar Gemini real, feedback e avaliação de impacto com métricas verificáveis; auto-upgrade com assinatura/manifesto, backup restaurável e rollback testado.

- 233: Chat de consulta com Gemini. — permanece parcial/pendente de evidência.
- 238: Aprendizado com resultados de ações. — permanece parcial/pendente de evidência.
- 241: Melhoria progressiva das análises. — permanece parcial/pendente de evidência.
- 245: Auto-upgrade com aprovação, backup e rollback. — permanece parcial/pendente de evidência.

### 15. Modos de operação e análise — 4 parciais (P1)

**Critério de aceite:** Definir comportamento de cada perfil e simular execuções; apresentar ações e limites no painel e manter confirmação para operações sensíveis.

- 246: AUTO_PILOT — automático contínuo. — permanece parcial/pendente de evidência.
- 247: AUTO_ASSISTED — automático com revisão. — permanece parcial/pendente de evidência.
- 248: MANUAL_GUIDED — manual guiado. — permanece parcial/pendente de evidência.
- 255: Análise completa 360° da loja. — permanece parcial/pendente de evidência.

### 16. Growth Lab e experimentação — 1 parciais (P2)

**Critério de aceite:** Comparar grupos/períodos com custo, margem e lucro; medir incerteza e registrar resultado do experimento.

- 271: Acompanhar impacto na margem e no lucro. — permanece parcial/pendente de evidência.

### 17. Central de tarefas e automações — 9 parciais (P0)

**Critério de aceite:** Validar fila, agendamento, idempotência, confirmação de salvamento e rollback por marketplace, conta e anúncio; não repetir gravação remota incerta.

- 275: Executar imediatamente. — permanece parcial/pendente de evidência.
- 276: Agendar tarefas. — permanece parcial/pendente de evidência.
- 277: Criar recorrências. — permanece parcial/pendente de evidência.
- 282: Retentar operações com falha. — permanece parcial/pendente de evidência.
- 284: Publicar alterações autorizadas. — permanece parcial/pendente de evidência.
- 285: Configurar perfis de digitação. — permanece parcial/pendente de evidência.
- 287: Verificar se alterações foram salvas. — permanece parcial/pendente de evidência.
- 288: Registrar resultados. — permanece parcial/pendente de evidência.
- 289: Reverter alterações quando suportado. — permanece parcial/pendente de evidência.

### 18. Conectores e integrações opcionais — 15 parciais (P1)

**Critério de aceite:** Implementar OAuth e renovação segura, ingestão incremental, cursor, escopos mínimos, erro/revogação, limites; testar CSV/XLSX/PDF reais, OCR e revisão humana.

- 290: Importar CSV. — permanece parcial/pendente de evidência.
- 291: Importar XLSX. — permanece parcial/pendente de evidência.
- 292: Importar relatórios PDF. — permanece parcial/pendente de evidência.
- 293: Conectar APIs oficiais opcionais. — permanece parcial/pendente de evidência.
- 294: Conectar serviços externos opcionais. — permanece parcial/pendente de evidência.
- 295: Configurar Google Trends, quando disponível. — permanece parcial/pendente de evidência.
- 296: Configurar Google Analytics 4, quando disponível. — permanece parcial/pendente de evidência.
- 297: Configurar Google Search Console, quando disponível. — permanece parcial/pendente de evidência.
- 298: Configurar ferramentas de SEO autorizadas. — permanece parcial/pendente de evidência.
- 299: Configurar ferramentas de inteligência de marketplace autorizadas. — permanece parcial/pendente de evidência.
- 300: Testar conexão. — permanece parcial/pendente de evidência.
- 301: Ativar e desativar conectores. — permanece parcial/pendente de evidência.
- 302: Mostrar custos e limites. — permanece parcial/pendente de evidência.
- 303: Mostrar última sincronização. — permanece parcial/pendente de evidência.
- 304: Desconectar integrações. — permanece parcial/pendente de evidência.

### 19. Relatórios e administração — 9 parciais (P2)

**Critério de aceite:** Conferir relatórios com dados e filtros reais, exportações, PDF e permissões; provar restauração e limites financeiros.

- 306: Relatório executivo. — permanece parcial/pendente de evidência.
- 307: Relatório de KPIs. — permanece parcial/pendente de evidência.
- 308: Relatório financeiro. — permanece parcial/pendente de evidência.
- 309: Relatório por anúncio. — permanece parcial/pendente de evidência.
- 310: Relatório de concorrentes. — permanece parcial/pendente de evidência.
- 311: Relatório de auditoria. — permanece parcial/pendente de evidência.
- 315: Gerar PDF. — permanece parcial/pendente de evidência.
- 321: Reverter alterações quando suportado. — permanece parcial/pendente de evidência.
- 325: Configurar permissões e limites financeiros. — permanece parcial/pendente de evidência.

### 20. Interface e experiência SaaS — 7 parciais (P1)

**Critério de aceite:** Mapear cada ação utilizável para tela/handler/IPC/resultado e teste de interface; filtros por conta, SKU, anúncio e período; distinguir erro e vazio.

- 327: Todas as funcionalidades disponíveis na interface. — permanece parcial/pendente de evidência.
- 329: Filtros por marketplace. — permanece parcial/pendente de evidência.
- 330: Filtros por conta. — permanece parcial/pendente de evidência.
- 331: Filtros por período. — permanece parcial/pendente de evidência.
- 332: Filtros por SKU e anúncio. — permanece parcial/pendente de evidência.
- 338: Explicação das fórmulas. — permanece parcial/pendente de evidência.
- 343: Nenhum botão sem funcionamento. — permanece parcial/pendente de evidência.

### 21. Segurança, instalação e funcionamento — 8 parciais (P0)

**Critério de aceite:** Instalação limpa no Windows, atualização preservando DB, desinstalação, restauração, isolamento de contas, permissões, secrets, auditoria e inicialização autorizada.

- 346: Serviço local persistente. — permanece parcial/pendente de evidência.
- 349: Proteção de chaves e tokens. — permanece parcial/pendente de evidência.
- 350: Isolamento entre contas. — permanece parcial/pendente de evidência.
- 351: Auditoria das ações. — permanece parcial/pendente de evidência.
- 357: Instalador Windows completo. — permanece parcial/pendente de evidência.
- 358: Instalação sem exigir conhecimentos técnicos. — permanece parcial/pendente de evidência.
- 359: Inicialização automática autorizada. — permanece parcial/pendente de evidência.
- 360: Atualização do software. — permanece parcial/pendente de evidência.

## Portões para publicar 3.10.9

1. Instalar dependências em checkout limpo; executar typecheck, builds, suíte Vitest, sete regressões, auditoria estática, smoke local e publicação assistida em SQLite. Guardar resultados, não marcar teste bloqueado como aprovado.
2. Executar CI no branch de revisão e conferir artefatos. Homologar fluxo do dashboard e extensão em Chrome/Edge, contas simuladas e depois contas autorizadas de cada marketplace.
3. Testar instalador Windows em VM limpa com upgrade da base, backup, restauração, logs, host nativo e desinstalação.
4. Atualizar a matriz por ID somente quando a funcionalidade tiver implementação e evidência de aceitação; manter a master estável até aprovação dos testes.
