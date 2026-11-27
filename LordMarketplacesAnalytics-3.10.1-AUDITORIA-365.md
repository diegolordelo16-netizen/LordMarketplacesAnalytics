# Auditoria recursiva e classificação integral — LordMarketplacesAnalytics 3.10.1

**Data:** 26/11/2026  |  **Base:** código `LordMarketplacesAnalytics 3.10.1`, revisão incremental sobre o ZIP 3.10.0  |  **Especificação:** checklist enviado com 21 seções e 365 requisitos.

## Critério de classificação

- **✅ Implementado no código:** há fluxo/método/UI identificável para a função. Não significa que integração externa ou teste em navegador real foi validado nesta execução.
- **🟡 Parcial:** existe parte do fluxo, mas falta cobertura, integração, interface, dados reais ou execução ponta a ponta.
- **❌ Não implementado / não funciona ponta a ponta:** não há implementação funcional suficiente, ou o método só muda estado/retorna stub.
- **🟡 Não comprovado nesta execução:** existe documentação ou artefato, mas o ambiente não permitiu reproduzir a validação.

**Importante:** esta é uma auditoria estática com execução de verificações locais. Não tive acesso a contas autenticadas de vendedor, Chrome/Edge reais, credenciais OAuth ou API Gemini; não afirmo teste real desses serviços.

## Resultado geral da versão 3.10.1

| Classificação consolidada | Requisitos |
|---|---:|
| ✅ Implementado no código | 174 |
| 🟡 Parcial ou não comprovado ponta a ponta | 164 |
| ❌ Não implementado ou não funciona ponta a ponta | 27 |
| **Total** | **365** |

O checklist enviado contém **365 requisitos individuais**. A checklist antiga dentro do projeto agrupava vários itens (por exemplo, os 14 agentes) e por isso tinha 246 linhas classificadas; não era equivalente ao arquivo enviado.

**Atenção à leitura dos números:** “implementado no código” não significa “testado em conta real”. Os 5 requisitos marcados especificamente como não comprovados em navegador/testes foram contabilizados em parcial.

## Debug histórico da revisão 3.8.0 (referência; ver validação 3.10.0 ao final)

- JavaScript: 20 arquivos `.js`, `.mjs` e `.cjs` passaram em `node --check` nesta execução.
- TypeScript: 50 arquivos analisados pelo parser TypeScript global, **0 diagnósticos de sintaxe**. Isto não substitui `tsc --noEmit`.
- Extensão: `node scripts/build-extension.mjs` passou e gerou `dist/extension`.
- SQLite: migrations 001–005 executadas; tabela `import_job_rows` criada. A contagem anterior de 92 tabelas referia-se ao estado pré-005; a migration 005 adiciona a tabela de staging.
- Content scripts: testes isolados com `vm` confirmaram contexto editável e extração do identificador para Mercado Livre e Shopee. Não substituem Chrome/Edge reais.
- Tarefas: testes isolados com SQLite real confirmaram claim por anúncio exato, conclusão, repetição manual após 3 falhas, skip terminal e filtro por conta.
- XLSX export: arquivo OpenXML gerado, assinatura ZIP `PK`, seis partes XML analisadas. XLSX import: arquivo ZIP comprimido de fixture interpretado com shared strings, boolean e número; CSV: delimitador ponto e vírgula, aspas, campos multilinha e BOM verificados. A etapa de staging e promoção mapeada ganhou testes de regressão na suíte Vitest (ainda não executável neste ambiente).
- JSON: `package.json`, `package-lock.json`, `contracts.json` e manifest passaram em `python -m json.tool`.
- `npm test`: **não iniciou** — `vitest: not found` (inclui novos testes de importação CSV/XLSX e promoção).
- `npm run typecheck`: **bloqueado** — faltam `@types/node` e `vitest/globals`.
- `npm run agent:build` e `npm run host:build`: **bloqueados** — `esbuild` não está instalado.
- Teste manual em conta real, Chrome/Edge com seller logado, OAuth/Gemini/API: não executados neste ambiente.

## Findings da auditoria anterior — estado na 3.6.0

### P1 — Execução de tarefas
**Parcialmente corrigido:** `task.runNow` coloca a tarefa na fila; o service worker consulta abas; content scripts confirmam uma tela de edição e formulário de vendedor; o serviço reserva o item pelo par marketplace + ID externo; título/descrição são preenchidos e verificados no DOM; o resultado é gravado. O modo **não salva nem publica**. A operação exige que o usuário abra a tela de edição correta e revise/salve manualmente. Ainda falta validar com contas reais e cobrir cada variação de layout.

### P1 — Capacidade dos adapters
**Corrigido:** a matriz declara `NAO_DISPONIVEL` para ações sem executor real e `PARCIALMENTE_SUPORTADO` para leitura DOM observacional. Amazon possui agora captura somente de inventário visível, classificada como parcial; não são anunciadas capacidades de Ads ou edição.

### P1 — Amazon
**Parcial:** foi incluído adapter/content script para Seller Central Brasil com leitura somente de inventário visível e paginação observacional. Não lê Ads/vendas, não edita, os seletores não foram homologados em conta Seller Central real e a detecção de sessão ainda requer validação manual.

### P1 — Forecast
**Corrigido no código:** previsão linear semanal usa o snapshot mais recente por semana, exige ao menos oito semanas distintas, persiste execução/cenário e apresenta intervalo heurístico e MAPE. Não é previsão causal nem garantia de resultado; a execução real continua dependendo de histórico coletado suficiente.

### P2 — Integridade da fila de tarefas
**Corrigido no código:** tarefas ficam terminais quando todos os itens são concluídos/pulados; itens esgotados podem ser reabertos por execução manual; itens PROCESSING podem ser recuperados após interrupção; lista pode filtrar por conta; criação exige anúncio pertencente à conta/marketplace; só `set_value` com verificação está habilitado; tarefa de título não altera descrição e vice-versa.

### P2 — Autenticação contextual no rascunho
**Melhorado:** o content script exige formulário editável visível e ID externo, e o service worker exige `sessionAuthenticated=true`. Isso é uma verificação de sinais DOM, não validação criptográfica da sessão do marketplace.

### P2 — Relatórios
**Melhorado:** os relatórios deixam de devolver somente a tabela genérica; há datasets por tipo e escopo de conta. Exportação CSV/JSON permanece; XLSX local foi gerado e validado como pacote OpenXML. PDF continua sendo impressão pelo navegador, não PDF server-side.

### P2 — Conectores e APIs externas
**Não implementado ponta a ponta:** registrar/ativar um conector ainda não representa OAuth, autenticação, sincronização ou ingestão externa. Google Trends, GA4, Search Console e APIs oficiais exigem credenciais e fluxos específicos.

### P2 — Limites da coleta
**Parcial:** a coleta lê elementos visíveis no DOM da página aberta, não navega automaticamente por toda a conta nem por todas as páginas, períodos ou relatórios. Ausência de campo não significa zero.

### P3 — Testes oficiais
**Não comprovados:** Vitest, typecheck e builds do agente/host não puderam ser executados por dependências ausentes. Não declarar a suite completa aprovada.

## Classificação individual dos 365 requisitos

| Nº | Seção | Requisito | Estado |
|---:|---|---|---|
| 1 | 1. Acesso e controle do sistema | Login administrativo. | ✅ Implementado no código |
| 2 | 1. Acesso e controle do sistema | Controle de usuários e permissões. | 🟡 Parcial |
| 3 | 1. Acesso e controle do sistema | Identificação automática do marketplace. | 🟡 Parcial |
| 4 | 1. Acesso e controle do sistema | Identificação automática da conta/loja. | 🟡 Parcial |
| 5 | 1. Acesso e controle do sistema | Suporte a múltiplas contas. | 🟡 Parcial |
| 6 | 1. Acesso e controle do sistema | Visão individual por loja. | 🟡 Parcial |
| 7 | 1. Acesso e controle do sistema | Visão consolidada de todas as lojas. | ✅ Implementado no código |
| 8 | 1. Acesso e controle do sistema | Compatibilidade com Chrome. | 🟡 Não comprovado em navegador real nesta execução |
| 9 | 1. Acesso e controle do sistema | Compatibilidade com Edge. | 🟡 Não comprovado em navegador real nesta execução |
| 10 | 1. Acesso e controle do sistema | Extensão conectada ao serviço local. | ✅ Implementado no código |
| 11 | 1. Acesso e controle do sistema | Reconhecimento de sessão expirada. | ✅ Implementado no código |
| 12 | 1. Acesso e controle do sistema | Reconexão após login manual. | ✅ Implementado no código |
| 13 | 2. Controle e navegação do navegador | Abrir páginas do marketplace pela sessão autenticada. | 🟡 Parcial |
| 14 | 2. Controle e navegação do navegador | Navegar automaticamente entre as áreas autorizadas. | 🟡 Parcial |
| 15 | 2. Controle e navegação do navegador | Identificar páginas e painéis do vendedor. | ✅ Implementado no código |
| 16 | 2. Controle e navegação do navegador | Reconhecer tabelas, gráficos e indicadores. | 🟡 Parcial |
| 17 | 2. Controle e navegação do navegador | Identificar filtros e períodos. | 🟡 Parcial |
| 18 | 2. Controle e navegação do navegador | Navegar por paginação. | 🟡 Parcial |
| 19 | 2. Controle e navegação do navegador | Coletar informações de várias páginas. | 🟡 Parcial |
| 20 | 2. Controle e navegação do navegador | Identificar anúncios e produtos. | ✅ Implementado no código |
| 21 | 2. Controle e navegação do navegador | Salvar o progresso da navegação. | 🟡 Parcial |
| 22 | 2. Controle e navegação do navegador | Retomar operações interrompidas. | 🟡 Parcial |
| 23 | 2. Controle e navegação do navegador | Pausar quando houver CAPTCHA ou bloqueio. | 🟡 Parcial |
| 24 | 2. Controle e navegação do navegador | Mostrar o que está sendo coletado em tempo real. | 🟡 Parcial |
| 25 | 3. Coleta automática de dados | Coletar vendas. | 🟡 Parcial |
| 26 | 3. Coleta automática de dados | Coletar pedidos. | 🟡 Parcial |
| 27 | 3. Coleta automática de dados | Coletar unidades vendidas. | 🟡 Parcial |
| 28 | 3. Coleta automática de dados | Coletar faturamento. | 🟡 Parcial |
| 29 | 3. Coleta automática de dados | Coletar receita líquida quando disponível. | 🟡 Parcial |
| 30 | 3. Coleta automática de dados | Coletar visitas. | 🟡 Parcial |
| 31 | 3. Coleta automática de dados | Coletar impressões. | 🟡 Parcial |
| 32 | 3. Coleta automática de dados | Coletar cliques. | 🟡 Parcial |
| 33 | 3. Coleta automática de dados | Coletar taxas de conversão. | 🟡 Parcial |
| 34 | 3. Coleta automática de dados | Coletar dados de publicidade. | 🟡 Parcial |
| 35 | 3. Coleta automática de dados | Coletar investimentos em Ads. | 🟡 Parcial |
| 36 | 3. Coleta automática de dados | Coletar vendas atribuídas aos Ads. | 🟡 Parcial |
| 37 | 3. Coleta automática de dados | Coletar preço dos anúncios. | 🟡 Parcial |
| 38 | 3. Coleta automática de dados | Coletar descontos e promoções. | 🟡 Parcial |
| 39 | 3. Coleta automática de dados | Coletar comissões e taxas disponíveis. | 🟡 Parcial |
| 40 | 3. Coleta automática de dados | Coletar estoque. | 🟡 Parcial |
| 41 | 3. Coleta automática de dados | Coletar perguntas. | 🟡 Parcial |
| 42 | 3. Coleta automática de dados | Coletar avaliações. | 🟡 Parcial |
| 43 | 3. Coleta automática de dados | Coletar reputação. | 🟡 Parcial |
| 44 | 3. Coleta automática de dados | Coletar cancelamentos. | 🟡 Parcial |
| 45 | 3. Coleta automática de dados | Coletar devoluções. | 🟡 Parcial |
| 46 | 3. Coleta automática de dados | Coletar reclamações. | ❌ Não implementado |
| 47 | 3. Coleta automática de dados | Coletar motivos de devolução. | ❌ Não implementado |
| 48 | 3. Coleta automática de dados | Atualizar histórico automaticamente. | 🟡 Parcial |
| 49 | 4. Central de sincronização | Botão atualizar dados agora. | ✅ Implementado no código |
| 50 | 4. Central de sincronização | Atualizar somente a página atual. | ✅ Implementado no código |
| 51 | 4. Central de sincronização | Atualizar todos os dados da loja. | 🟡 Parcial |
| 52 | 4. Central de sincronização | Atualizar várias contas. | ❌ Não implementado |
| 53 | 4. Central de sincronização | Atualizar todos os marketplaces habilitados. | ❌ Não implementado |
| 54 | 4. Central de sincronização | Agendar coleta por hora. | 🟡 Parcial |
| 55 | 4. Central de sincronização | Agendar coleta a cada 6 horas. | 🟡 Parcial |
| 56 | 4. Central de sincronização | Agendar coleta diária. | 🟡 Parcial |
| 57 | 4. Central de sincronização | Agendar coleta semanal. | 🟡 Parcial |
| 58 | 4. Central de sincronização | Criar horários personalizados. | 🟡 Parcial |
| 59 | 4. Central de sincronização | Mostrar progresso da coleta. | 🟡 Parcial |
| 60 | 4. Central de sincronização | Mostrar última atualização. | ✅ Implementado no código |
| 61 | 4. Central de sincronização | Mostrar erros de captura. | ✅ Implementado no código |
| 62 | 4. Central de sincronização | Repetir coleta com falha. | 🟡 Parcial |
| 63 | 4. Central de sincronização | Mostrar dados ausentes. | ✅ Implementado no código |
| 64 | 4. Central de sincronização | Evitar registros duplicados. | ✅ Implementado no código |
| 65 | 5. Painel executivo e KPIs | Dashboard geral da operação. | ✅ Implementado no código |
| 66 | 5. Painel executivo e KPIs | Faturamento total. | 🟡 Parcial |
| 67 | 5. Painel executivo e KPIs | Total de vendas. | 🟡 Parcial |
| 68 | 5. Painel executivo e KPIs | Total de pedidos. | 🟡 Parcial |
| 69 | 5. Painel executivo e KPIs | Ticket médio. | 🟡 Parcial |
| 70 | 5. Painel executivo e KPIs | CTR. | ✅ Implementado no código |
| 71 | 5. Painel executivo e KPIs | CVR. | ✅ Implementado no código |
| 72 | 5. Painel executivo e KPIs | ROAS. | ✅ Implementado no código |
| 73 | 5. Painel executivo e KPIs | ACoS. | ✅ Implementado no código |
| 74 | 5. Painel executivo e KPIs | TACoS. | ✅ Implementado no código |
| 75 | 5. Painel executivo e KPIs | CPC. | ✅ Implementado no código |
| 76 | 5. Painel executivo e KPIs | Custo por venda. | ✅ Implementado no código |
| 77 | 5. Painel executivo e KPIs | Participação de Ads no faturamento. | ✅ Implementado no código |
| 78 | 5. Painel executivo e KPIs | Margem de contribuição. | ✅ Implementado no código |
| 79 | 5. Painel executivo e KPIs | Lucro estimado. | ✅ Implementado no código |
| 80 | 5. Painel executivo e KPIs | Lucro realizado quando possível. | ❌ Não implementado |
| 81 | 5. Painel executivo e KPIs | Taxa de devolução. | ✅ Implementado no código |
| 82 | 5. Painel executivo e KPIs | Taxa de cancelamento. | ✅ Implementado no código |
| 83 | 5. Painel executivo e KPIs | Giro de estoque. | ✅ Implementado no código |
| 84 | 5. Painel executivo e KPIs | Cobertura de estoque. | ✅ Implementado no código |
| 85 | 5. Painel executivo e KPIs | Participação orgânica. | ✅ Implementado no código |
| 86 | 5. Painel executivo e KPIs | Histórico de todos os indicadores. | 🟡 Parcial |
| 87 | 5. Painel executivo e KPIs | Gráficos de evolução. | 🟡 Parcial |
| 88 | 6. Comparações e diagnósticos | Hoje versus ontem. | 🟡 Parcial |
| 89 | 6. Comparações e diagnósticos | Últimos 7 dias versus período anterior. | 🟡 Parcial |
| 90 | 6. Comparações e diagnósticos | Últimos 30 dias versus período anterior. | 🟡 Parcial |
| 91 | 6. Comparações e diagnósticos | Mês atual versus mês anterior. | 🟡 Parcial |
| 92 | 6. Comparações e diagnósticos | Comparação de períodos personalizados. | ✅ Implementado no código |
| 93 | 6. Comparações e diagnósticos | Comparação entre lojas. | ✅ Implementado no código |
| 94 | 6. Comparações e diagnósticos | Comparação entre marketplaces. | 🟡 Parcial |
| 95 | 6. Comparações e diagnósticos | Comparação entre produtos. | ✅ Implementado no código |
| 96 | 6. Comparações e diagnósticos | Comparação entre anúncios. | ✅ Implementado no código |
| 97 | 6. Comparações e diagnósticos | Identificação de quedas nas vendas. | 🟡 Parcial |
| 98 | 6. Comparações e diagnósticos | Identificação de aumento de custos. | 🟡 Parcial |
| 99 | 6. Comparações e diagnósticos | Identificação de perda de conversão. | 🟡 Parcial |
| 100 | 6. Comparações e diagnósticos | Identificação de campanhas deficitárias. | 🟡 Parcial |
| 101 | 6. Comparações e diagnósticos | Identificação de produtos com potencial de crescimento. | 🟡 Parcial |
| 102 | 6. Comparações e diagnósticos | Diagnóstico das causas dos problemas. | ✅ Implementado no código |
| 103 | 6. Comparações e diagnósticos | Sugestão de ações corretivas. | ✅ Implementado no código |
| 104 | 7. Inteligência competitiva e concorrentes | Cadastrar produtos próprios. | ✅ Implementado no código |
| 105 | 7. Inteligência competitiva e concorrentes | Identificar concorrentes automaticamente. | 🟡 Parcial |
| 106 | 7. Inteligência competitiva e concorrentes | Pesquisar pelo EAN. | 🟡 Parcial |
| 107 | 7. Inteligência competitiva e concorrentes | Pesquisar pelo GTIN/UPC. | 🟡 Parcial |
| 108 | 7. Inteligência competitiva e concorrentes | Pesquisar pela marca. | 🟡 Parcial |
| 109 | 7. Inteligência competitiva e concorrentes | Pesquisar pelo modelo. | 🟡 Parcial |
| 110 | 7. Inteligência competitiva e concorrentes | Pesquisar pelo SKU. | 🟡 Parcial |
| 111 | 7. Inteligência competitiva e concorrentes | Pesquisar por atributos técnicos. | 🟡 Parcial |
| 112 | 7. Inteligência competitiva e concorrentes | Pesquisar anúncios semelhantes. | 🟡 Parcial |
| 113 | 7. Inteligência competitiva e concorrentes | Pesquisar anúncios em outros marketplaces suportados. | 🟡 Parcial |
| 114 | 7. Inteligência competitiva e concorrentes | Analisar os 10 a 20 principais resultados, quando disponíveis. | 🟡 Parcial |
| 115 | 7. Inteligência competitiva e concorrentes | Identificar anúncios iguais. | ✅ Implementado no código |
| 116 | 7. Inteligência competitiva e concorrentes | Identificar anúncios similares. | ✅ Implementado no código |
| 117 | 7. Inteligência competitiva e concorrentes | Classificar correspondência por confiança. | ✅ Implementado no código |
| 118 | 7. Inteligência competitiva e concorrentes | Exibir concorrentes pendentes. | ✅ Implementado no código |
| 119 | 7. Inteligência competitiva e concorrentes | Aprovar concorrentes. | ✅ Implementado no código |
| 120 | 7. Inteligência competitiva e concorrentes | Rejeitar concorrentes. | ✅ Implementado no código |
| 121 | 7. Inteligência competitiva e concorrentes | Editar correspondências. | ✅ Implementado no código |
| 122 | 7. Inteligência competitiva e concorrentes | Aprender com aprovações e rejeições. | ✅ Implementado no código |
| 123 | 7. Inteligência competitiva e concorrentes | Monitorar concorrentes aprovados. | ✅ Implementado no código |
| 124 | 7. Inteligência competitiva e concorrentes | Registrar histórico de preços. | 🟡 Parcial |
| 125 | 7. Inteligência competitiva e concorrentes | Registrar promoções. | 🟡 Parcial |
| 126 | 7. Inteligência competitiva e concorrentes | Comparar avaliações. | 🟡 Parcial |
| 127 | 7. Inteligência competitiva e concorrentes | Comparar posicionamento. | 🟡 Parcial |
| 128 | 7. Inteligência competitiva e concorrentes | Comparar frete e prazo. | ❌ Não implementado |
| 129 | 7. Inteligência competitiva e concorrentes | Comparar títulos e palavras-chave. | 🟡 Parcial |
| 130 | 7. Inteligência competitiva e concorrentes | Comparar imagens. | ❌ Não implementado |
| 131 | 7. Inteligência competitiva e concorrentes | Comparar atributos e descrições. | 🟡 Parcial |
| 132 | 7. Inteligência competitiva e concorrentes | Identificar anúncios patrocinados visíveis. | ❌ Não implementado |
| 133 | 7. Inteligência competitiva e concorrentes | Identificar vantagens competitivas. | 🟡 Parcial |
| 134 | 7. Inteligência competitiva e concorrentes | Sugerir como superar concorrentes. | ✅ Implementado no código |
| 135 | 8. SEO e inteligência de palavras-chave | Pesquisar palavras-chave. | ✅ Implementado no código |
| 136 | 8. SEO e inteligência de palavras-chave | Identificar sugestões de busca. | 🟡 Parcial |
| 137 | 8. SEO e inteligência de palavras-chave | Identificar palavras-chave dos concorrentes. | 🟡 Parcial |
| 138 | 8. SEO e inteligência de palavras-chave | Identificar palavras-chave ausentes nos anúncios próprios. | ✅ Implementado no código |
| 139 | 8. SEO e inteligência de palavras-chave | Identificar oportunidades de cauda longa. | 🟡 Parcial |
| 140 | 8. SEO e inteligência de palavras-chave | Identificar intenção de compra. | 🟡 Parcial |
| 141 | 8. SEO e inteligência de palavras-chave | Criar agrupamentos de palavras-chave. | 🟡 Parcial |
| 142 | 8. SEO e inteligência de palavras-chave | Comparar cobertura SEO. | 🟡 Parcial |
| 143 | 8. SEO e inteligência de palavras-chave | Monitorar posições. | ✅ Implementado no código |
| 144 | 8. SEO e inteligência de palavras-chave | Registrar histórico de posicionamento. | ✅ Implementado no código |
| 145 | 8. SEO e inteligência de palavras-chave | Calcular participação de visibilidade. | 🟡 Parcial |
| 146 | 8. SEO e inteligência de palavras-chave | Sugerir títulos otimizados. | ✅ Implementado no código |
| 147 | 8. SEO e inteligência de palavras-chave | Sugerir atributos relevantes. | ✅ Implementado no código |
| 148 | 8. SEO e inteligência de palavras-chave | Identificar canibalização entre anúncios próprios. | 🟡 Parcial |
| 149 | 9. Financeiro e precificação | Cadastrar custo de produtos. | ✅ Implementado no código |
| 150 | 9. Financeiro e precificação | Cadastrar custos de embalagem. | ✅ Implementado no código |
| 151 | 9. Financeiro e precificação | Cadastrar frete. | ✅ Implementado no código |
| 152 | 9. Financeiro e precificação | Cadastrar impostos. | ✅ Implementado no código |
| 153 | 9. Financeiro e precificação | Cadastrar comissões. | ✅ Implementado no código |
| 154 | 9. Financeiro e precificação | Calcular margem por SKU. | ✅ Implementado no código |
| 155 | 9. Financeiro e precificação | Calcular lucro por anúncio. | ✅ Implementado no código |
| 156 | 9. Financeiro e precificação | Simular alterações de preços. | ✅ Implementado no código |
| 157 | 9. Financeiro e precificação | Simular descontos e cupons. | ✅ Implementado no código |
| 158 | 9. Financeiro e precificação | Simular custos de Ads. | ✅ Implementado no código |
| 159 | 9. Financeiro e precificação | Calcular preço mínimo viável. | ✅ Implementado no código |
| 160 | 9. Financeiro e precificação | Calcular preço competitivo. | ✅ Implementado no código |
| 161 | 9. Financeiro e precificação | Identificar anúncios com margem negativa. | 🟡 Parcial |
| 162 | 9. Financeiro e precificação | Identificar oportunidades de aumento de margem. | ✅ Implementado no código |
| 163 | 9. Financeiro e precificação | Simular kits e combos. | ✅ Implementado no código |
| 164 | 9. Financeiro e precificação | Calcular ponto de equilíbrio. | ✅ Implementado no código |
| 165 | 9. Financeiro e precificação | Comparar rentabilidade entre produtos. | 🟡 Parcial |
| 166 | 10. Publicidade e campanhas | Analisar campanhas de Ads. | 🟡 Parcial |
| 167 | 10. Publicidade e campanhas | Analisar investimento. | 🟡 Parcial |
| 168 | 10. Publicidade e campanhas | Analisar cliques e impressões. | 🟡 Parcial |
| 169 | 10. Publicidade e campanhas | Analisar ROAS. | 🟡 Parcial |
| 170 | 10. Publicidade e campanhas | Analisar ACoS. | 🟡 Parcial |
| 171 | 10. Publicidade e campanhas | Analisar TACoS. | 🟡 Parcial |
| 172 | 10. Publicidade e campanhas | Identificar campanhas deficitárias. | 🟡 Parcial |
| 173 | 10. Publicidade e campanhas | Identificar anúncios que merecem mais investimento. | 🟡 Parcial |
| 174 | 10. Publicidade e campanhas | Identificar anúncios que consomem orçamento sem resultado. | 🟡 Parcial |
| 175 | 10. Publicidade e campanhas | Considerar margem antes de recomendar escala. | ✅ Implementado no código |
| 176 | 10. Publicidade e campanhas | Considerar estoque antes de recomendar investimento. | ✅ Implementado no código |
| 177 | 10. Publicidade e campanhas | Simular mudanças de orçamento. | ✅ Implementado no código |
| 178 | 10. Publicidade e campanhas | Preparar alterações de campanhas. | ❌ Não implementado |
| 179 | 10. Publicidade e campanhas | Executar alterações autorizadas. | ❌ Não implementado |
| 180 | 11. Produtos, anúncios e CRO | Cadastro e gestão de produtos. | ✅ Implementado no código |
| 181 | 11. Produtos, anúncios e CRO | Cadastro de SKUs. | ✅ Implementado no código |
| 182 | 11. Produtos, anúncios e CRO | Gestão de variações. | 🟡 Parcial |
| 183 | 11. Produtos, anúncios e CRO | Análise de títulos. | ✅ Implementado no código |
| 184 | 11. Produtos, anúncios e CRO | Análise de descrições. | ✅ Implementado no código |
| 185 | 11. Produtos, anúncios e CRO | Sugestões de melhoria de imagens. | 🟡 Parcial |
| 186 | 11. Produtos, anúncios e CRO | Biblioteca de imagens. | ✅ Implementado no código |
| 187 | 11. Produtos, anúncios e CRO | Preparar troca de imagem de capa. | 🟡 Parcial |
| 188 | 11. Produtos, anúncios e CRO | Melhorar fichas técnicas. | ✅ Implementado no código |
| 189 | 11. Produtos, anúncios e CRO | Identificar informações ausentes. | ✅ Implementado no código |
| 190 | 11. Produtos, anúncios e CRO | Melhorar conteúdo para conversão. | ✅ Implementado no código |
| 191 | 11. Produtos, anúncios e CRO | Criar blocos para prevenir devoluções. | ✅ Implementado no código |
| 192 | 11. Produtos, anúncios e CRO | Preservar integralmente o texto original. | ✅ Implementado no código |
| 193 | 11. Produtos, anúncios e CRO | Exibir comparação antes e depois. | ✅ Implementado no código |
| 194 | 11. Produtos, anúncios e CRO | Duplicar anúncios quando permitido. | 🟡 Parcial |
| 195 | 11. Produtos, anúncios e CRO | Criar variações de ofertas. | ❌ Não implementado |
| 196 | 11. Produtos, anúncios e CRO | Medir resultados das alterações. | 🟡 Parcial |
| 197 | 12. Estoque e operação | Monitorar estoque. | 🟡 Parcial |
| 198 | 12. Estoque e operação | Identificar risco de ruptura. | 🟡 Parcial |
| 199 | 12. Estoque e operação | Calcular cobertura. | ✅ Implementado no código |
| 200 | 12. Estoque e operação | Identificar produtos parados. | ✅ Implementado no código |
| 201 | 12. Estoque e operação | Identificar produtos com alto giro. | ✅ Implementado no código |
| 202 | 12. Estoque e operação | Alertar sobre estoque insuficiente. | ✅ Implementado no código |
| 203 | 12. Estoque e operação | Cruzar estoque com campanhas de Ads. | 🟡 Parcial |
| 204 | 12. Estoque e operação | Recomendar reposição. | ✅ Implementado no código |
| 205 | 12. Estoque e operação | Monitorar perguntas pendentes. | 🟡 Parcial |
| 206 | 12. Estoque e operação | Monitorar problemas operacionais. | 🟡 Parcial |
| 207 | 13. Voz do cliente e pós-venda | Analisar avaliações. | 🟡 Parcial |
| 208 | 13. Voz do cliente e pós-venda | Analisar perguntas. | 🟡 Parcial |
| 209 | 13. Voz do cliente e pós-venda | Analisar reclamações. | 🟡 Parcial |
| 210 | 13. Voz do cliente e pós-venda | Analisar devoluções. | 🟡 Parcial |
| 211 | 13. Voz do cliente e pós-venda | Identificar motivos recorrentes de devolução. | 🟡 Parcial |
| 212 | 13. Voz do cliente e pós-venda | Identificar objeções de compra. | 🟡 Parcial |
| 213 | 13. Voz do cliente e pós-venda | Identificar problemas de qualidade. | 🟡 Parcial |
| 214 | 13. Voz do cliente e pós-venda | Identificar oportunidades de melhoria de produto. | ✅ Implementado no código |
| 215 | 13. Voz do cliente e pós-venda | Criar recomendações para reduzir devoluções. | ✅ Implementado no código |
| 216 | 13. Voz do cliente e pós-venda | Monitorar reputação. | 🟡 Parcial |
| 217 | 14. Inteligência artificial e aprendizado | Possuir 14 agentes especializados. | ✅ Implementado no código |
| 218 | 14. Inteligência artificial e aprendizado | Agente de SEO e demanda. | ✅ Implementado no código |
| 219 | 14. Inteligência artificial e aprendizado | Agente de Ads. | ✅ Implementado no código |
| 220 | 14. Inteligência artificial e aprendizado | Agente de concorrência. | ✅ Implementado no código |
| 221 | 14. Inteligência artificial e aprendizado | Agente de conversão. | ✅ Implementado no código |
| 222 | 14. Inteligência artificial e aprendizado | Agente financeiro. | ✅ Implementado no código |
| 223 | 14. Inteligência artificial e aprendizado | Agente de estoque. | ✅ Implementado no código |
| 224 | 14. Inteligência artificial e aprendizado | Agente de conteúdo e pós-compra. | ✅ Implementado no código |
| 225 | 14. Inteligência artificial e aprendizado | Agente de precificação e ofertas. | ✅ Implementado no código |
| 226 | 14. Inteligência artificial e aprendizado | Agente de performance e experimentação. | ✅ Implementado no código |
| 227 | 14. Inteligência artificial e aprendizado | Agente de inteligência de mercado. | ✅ Implementado no código |
| 228 | 14. Inteligência artificial e aprendizado | Agente de palavras-chave e rank tracking. | ✅ Implementado no código |
| 229 | 14. Inteligência artificial e aprendizado | Agente de voz do cliente. | ✅ Implementado no código |
| 230 | 14. Inteligência artificial e aprendizado | Agente de previsão e planejamento. | ✅ Implementado no código |
| 231 | 14. Inteligência artificial e aprendizado | Agente de Growth Strategy e retenção. | ✅ Implementado no código |
| 232 | 14. Inteligência artificial e aprendizado | AI Director para coordenar os agentes. | ✅ Implementado no código |
| 233 | 14. Inteligência artificial e aprendizado | Chat de consulta com Gemini. | 🟡 Parcial |
| 234 | 14. Inteligência artificial e aprendizado | Debate entre agentes. | ✅ Implementado no código |
| 235 | 14. Inteligência artificial e aprendizado | Memória operacional local. | ✅ Implementado no código |
| 236 | 14. Inteligência artificial e aprendizado | Aprendizado com aprovações. | ✅ Implementado no código |
| 237 | 14. Inteligência artificial e aprendizado | Aprendizado com rejeições. | ✅ Implementado no código |
| 238 | 14. Inteligência artificial e aprendizado | Aprendizado com resultados de ações. | 🟡 Parcial |
| 239 | 14. Inteligência artificial e aprendizado | Reutilização de estratégias que funcionaram. | ✅ Implementado no código |
| 240 | 14. Inteligência artificial e aprendizado | Histórico de recomendações. | ✅ Implementado no código |
| 241 | 14. Inteligência artificial e aprendizado | Melhoria progressiva das análises. | 🟡 Parcial |
| 242 | 14. Inteligência artificial e aprendizado | Controle de orçamento da IA. | ✅ Implementado no código |
| 243 | 14. Inteligência artificial e aprendizado | Funcionamento básico sem Gemini. | ✅ Implementado no código |
| 244 | 14. Inteligência artificial e aprendizado | Propostas de melhorias no próprio software. | ✅ Implementado no código |
| 245 | 14. Inteligência artificial e aprendizado | Auto-upgrade com aprovação, backup e rollback. | 🟡 Parcial |
| 246 | 15. Modos de operação e análise | AUTO_PILOT — automático contínuo. | ❌ Não implementado |
| 247 | 15. Modos de operação e análise | AUTO_ASSISTED — automático com revisão. | ❌ Não implementado |
| 248 | 15. Modos de operação e análise | MANUAL_GUIDED — manual guiado. | ❌ Não implementado |
| 249 | 15. Modos de operação e análise | Análise RÁPIDA. | ✅ Implementado no código |
| 250 | 15. Modos de operação e análise | Análise PADRÃO. | ✅ Implementado no código |
| 251 | 15. Modos de operação e análise | Análise DETALHADA/FORENSE. | ✅ Implementado no código |
| 252 | 15. Modos de operação e análise | Análise personalizada por conta. | ✅ Implementado no código |
| 253 | 15. Modos de operação e análise | Análise personalizada por produto. | ✅ Implementado no código |
| 254 | 15. Modos de operação e análise | Análise personalizada por anúncio. | ✅ Implementado no código |
| 255 | 15. Modos de operação e análise | Análise completa 360° da loja. | 🟡 Parcial |
| 256 | 15. Modos de operação e análise | Agendamento de análises. | ❌ Não implementado |
| 257 | 15. Modos de operação e análise | Execução de análises sob demanda. | ✅ Implementado no código |
| 258 | 15. Modos de operação e análise | Relatórios automáticos. | ❌ Não implementado |
| 259 | 15. Modos de operação e análise | Missões do Dia. | ✅ Implementado no código |
| 260 | 15. Modos de operação e análise | Alertas de oportunidades. | ✅ Implementado no código |
| 261 | 15. Modos de operação e análise | Alertas de problemas críticos. | ✅ Implementado no código |
| 262 | 16. Growth Lab e experimentação | Criar iniciativas de crescimento. | ✅ Implementado no código |
| 263 | 16. Growth Lab e experimentação | Criar hipóteses de melhoria. | ✅ Implementado no código |
| 264 | 16. Growth Lab e experimentação | Criar árvore de métricas. | ✅ Implementado no código |
| 265 | 16. Growth Lab e experimentação | Criar testes A/B. | ✅ Implementado no código |
| 266 | 16. Growth Lab e experimentação | Comparar resultados antes e depois. | ✅ Implementado no código |
| 267 | 16. Growth Lab e experimentação | Analisar significância estatística quando aplicável. | ✅ Implementado no código |
| 268 | 16. Growth Lab e experimentação | Identificar problemas de amostragem. | ✅ Implementado no código |
| 269 | 16. Growth Lab e experimentação | Registrar aprendizados. | ✅ Implementado no código |
| 270 | 16. Growth Lab e experimentação | Identificar estratégias vencedoras. | ✅ Implementado no código |
| 271 | 16. Growth Lab e experimentação | Acompanhar impacto na margem e no lucro. | 🟡 Parcial |
| 272 | 17. Central de tarefas e automações | Criar tarefas individuais. | ✅ Implementado no código |
| 273 | 17. Central de tarefas e automações | Criar tarefas em lote. | ✅ Implementado no código |
| 274 | 17. Central de tarefas e automações | Criar tarefas por filtros de desempenho. | ✅ Implementado no código |
| 275 | 17. Central de tarefas e automações | Executar imediatamente. | 🟡 Parcial |
| 276 | 17. Central de tarefas e automações | Agendar tarefas. | 🟡 Parcial |
| 277 | 17. Central de tarefas e automações | Criar recorrências. | 🟡 Parcial |
| 278 | 17. Central de tarefas e automações | Pausar tarefas. | ✅ Implementado no código |
| 279 | 17. Central de tarefas e automações | Retomar tarefas. | ✅ Implementado no código |
| 280 | 17. Central de tarefas e automações | Cancelar tarefas. | ✅ Implementado no código |
| 281 | 17. Central de tarefas e automações | Pular itens. | ✅ Implementado no código |
| 282 | 17. Central de tarefas e automações | Retentar operações com falha. | 🟡 Parcial |
| 283 | 17. Central de tarefas e automações | Preparar alterações em rascunho. | ✅ Implementado no código |
| 284 | 17. Central de tarefas e automações | Publicar alterações autorizadas. | ❌ Não implementado |
| 285 | 17. Central de tarefas e automações | Configurar perfis de digitação. | 🟡 Parcial |
| 286 | 17. Central de tarefas e automações | Configurar velocidade de digitação. | ✅ Implementado no código |
| 287 | 17. Central de tarefas e automações | Verificar se alterações foram salvas. | ❌ Não implementado ponta a ponta |
| 288 | 17. Central de tarefas e automações | Registrar resultados. | 🟡 Parcial |
| 289 | 17. Central de tarefas e automações | Reverter alterações quando suportado. | ❌ Não implementado |
| 290 | 18. Conectores e integrações opcionais | Importar CSV. | 🟡 Parcial |
| 291 | 18. Conectores e integrações opcionais | Importar XLSX. | 🟡 Parcial |
| 292 | 18. Conectores e integrações opcionais | Importar relatórios PDF. | ❌ Não implementado |
| 293 | 18. Conectores e integrações opcionais | Conectar APIs oficiais opcionais. | ❌ Não implementado |
| 294 | 18. Conectores e integrações opcionais | Conectar serviços externos opcionais. | ❌ Não implementado |
| 295 | 18. Conectores e integrações opcionais | Configurar Google Trends, quando disponível. | ❌ Não implementado |
| 296 | 18. Conectores e integrações opcionais | Configurar Google Analytics 4, quando disponível. | ❌ Não implementado |
| 297 | 18. Conectores e integrações opcionais | Configurar Google Search Console, quando disponível. | ❌ Não implementado |
| 298 | 18. Conectores e integrações opcionais | Configurar ferramentas de SEO autorizadas. | ❌ Não implementado |
| 299 | 18. Conectores e integrações opcionais | Configurar ferramentas de inteligência de marketplace autorizadas. | ❌ Não implementado |
| 300 | 18. Conectores e integrações opcionais | Testar conexão. | 🟡 Parcial |
| 301 | 18. Conectores e integrações opcionais | Ativar e desativar conectores. | 🟡 Parcial |
| 302 | 18. Conectores e integrações opcionais | Mostrar custos e limites. | 🟡 Parcial |
| 303 | 18. Conectores e integrações opcionais | Mostrar última sincronização. | 🟡 Parcial |
| 304 | 18. Conectores e integrações opcionais | Desconectar integrações. | 🟡 Parcial |
| 305 | 18. Conectores e integrações opcionais | Operar sem nenhuma API externa. | ✅ Implementado no código |
| 306 | 19. Relatórios e administração | Relatório executivo. | 🟡 Parcial |
| 307 | 19. Relatórios e administração | Relatório de KPIs. | 🟡 Parcial |
| 308 | 19. Relatórios e administração | Relatório financeiro. | 🟡 Parcial |
| 309 | 19. Relatórios e administração | Relatório por anúncio. | 🟡 Parcial |
| 310 | 19. Relatórios e administração | Relatório de concorrentes. | 🟡 Parcial |
| 311 | 19. Relatórios e administração | Relatório de auditoria. | 🟡 Parcial |
| 312 | 19. Relatórios e administração | Exportar CSV. | ✅ Implementado no código |
| 313 | 19. Relatórios e administração | Exportar XLSX. | ✅ Implementado no código |
| 314 | 19. Relatórios e administração | Exportar JSON. | ✅ Implementado no código |
| 315 | 19. Relatórios e administração | Gerar PDF. | 🟡 Parcial |
| 316 | 19. Relatórios e administração | Criar backups. | ✅ Implementado no código |
| 317 | 19. Relatórios e administração | Consultar backups. | ✅ Implementado no código |
| 318 | 19. Relatórios e administração | Restaurar dados quando suportado. | ✅ Implementado no código|
| 319 | 19. Relatórios e administração | Consultar histórico de operações. | ✅ Implementado no código |
| 320 | 19. Relatórios e administração | Consultar auditoria. | ✅ Implementado no código |
| 321 | 19. Relatórios e administração | Reverter alterações quando suportado. | 🟡 Parcial |
| 322 | 19. Relatórios e administração | Gerenciar chave Gemini. | ✅ Implementado no código |
| 323 | 19. Relatórios e administração | Consultar consumo de IA. | ✅ Implementado no código |
| 324 | 19. Relatórios e administração | Diagnosticar adaptadores. | ✅ Implementado no código |
| 325 | 19. Relatórios e administração | Configurar permissões e limites financeiros. | 🟡 Parcial |
| 326 | 20. Interface e experiência SaaS | Painel moderno e profissional. | ✅ Implementado no código |
| 327 | 20. Interface e experiência SaaS | Todas as funcionalidades disponíveis na interface. | 🟡 Parcial |
| 328 | 20. Interface e experiência SaaS | Menu lateral completo. | ✅ Implementado no código |
| 329 | 20. Interface e experiência SaaS | Filtros por marketplace. | 🟡 Parcial |
| 330 | 20. Interface e experiência SaaS | Filtros por conta. | 🟡 Parcial |
| 331 | 20. Interface e experiência SaaS | Filtros por período. | 🟡 Parcial |
| 332 | 20. Interface e experiência SaaS | Filtros por SKU e anúncio. | 🟡 Parcial |
| 333 | 20. Interface e experiência SaaS | Tabelas pesquisáveis. | ✅ Implementado no código |
| 334 | 20. Interface e experiência SaaS | Ordenação e paginação. | ✅ Implementado no código |
| 335 | 20. Interface e experiência SaaS | Gráficos históricos. | ✅ Implementado no código |
| 336 | 20. Interface e experiência SaaS | Comparações lado a lado. | ✅ Implementado no código |
| 337 | 20. Interface e experiência SaaS | Detalhamento ao clicar nos KPIs. | ✅ Implementado no código |
| 338 | 20. Interface e experiência SaaS | Explicação das fórmulas. | 🟡 Parcial |
| 339 | 20. Interface e experiência SaaS | Indicadores de origem dos dados. | ✅ Implementado no código |
| 340 | 20. Interface e experiência SaaS | Indicadores de qualidade dos dados. | ✅ Implementado no código |
| 341 | 20. Interface e experiência SaaS | Avisos e notificações. | ✅ Implementado no código |
| 342 | 20. Interface e experiência SaaS | Área de demonstração identificada. | ✅ Implementado no código |
| 343 | 20. Interface e experiência SaaS | Nenhum botão sem funcionamento. | 🟡 Parcial |
| 344 | 20. Interface e experiência SaaS | Nenhuma informação fictícia misturada aos dados reais. | ✅ Implementado no código |
| 345 | 21. Segurança, instalação e funcionamento | Banco de dados local. | ✅ Implementado no código |
| 346 | 21. Segurança, instalação e funcionamento | Serviço local persistente. | 🟡 Parcial |
| 347 | 21. Segurança, instalação e funcionamento | Comunicação com Native Messaging Host. | 🟡 Parcial |
| 348 | 21. Segurança, instalação e funcionamento | Criptografia de credenciais. | ✅ Implementado no código |
| 349 | 21. Segurança, instalação e funcionamento | Proteção de chaves e tokens. | 🟡 Parcial |
| 350 | 21. Segurança, instalação e funcionamento | Isolamento entre contas. | 🟡 Parcial |
| 351 | 21. Segurança, instalação e funcionamento | Auditoria das ações. | 🟡 Parcial |
| 352 | 21. Segurança, instalação e funcionamento | Proteção contra prompt injection. | ✅ Implementado no código |
| 353 | 21. Segurança, instalação e funcionamento | Proteção contra alterações não autorizadas. | ✅ Implementado no código |
| 354 | 21. Segurança, instalação e funcionamento | Automation Guard funcionando. | ✅ Implementado no código |
| 355 | 21. Segurança, instalação e funcionamento | Backup antes de alterações críticas. | ✅ Implementado no código |
| 356 | 21. Segurança, instalação e funcionamento | Verificação posterior das alterações. | ✅ Implementado no código |
| 357 | 21. Segurança, instalação e funcionamento | Instalador Windows completo. | 🟡 Parcial |
| 358 | 21. Segurança, instalação e funcionamento | Instalação sem exigir conhecimentos técnicos. | 🟡 Parcial |
| 359 | 21. Segurança, instalação e funcionamento | Inicialização automática autorizada. | 🟡 Parcial |
| 360 | 21. Segurança, instalação e funcionamento | Atualização do software. | 🟡 Parcial |
| 361 | 21. Segurança, instalação e funcionamento | Desinstalação correta. | ✅ Implementado no código |
| 362 | 21. Segurança, instalação e funcionamento | Testes automatizados aprovados. | 🟡 Não comprovado nesta execução |
| 363 | 21. Segurança, instalação e funcionamento | Teste real em Chrome. | 🟡 Não comprovado nesta execução |
| 364 | 21. Segurança, instalação e funcionamento | Teste real em Edge. | 🟡 Não comprovado nesta execução |
| 365 | 21. Segurança, instalação e funcionamento | Documentação atualizada. | ✅ Implementado no código |


### Tabelas e comparação analítica local
- Todas as tabelas geradas pelo helper da interface agora incluem pesquisa local, ordenação por cabeçalho e paginação client-side (25 linhas por página).
- Novo método `kpi.compare.detail` compara períodos personalizados não sobrepostos, agrupando por conta, produto ou anúncio. Usa o último snapshot de cada anúncio em cada período para evitar somar capturas repetidas; campos incompletos permanecem nulos.
- A tela Comparativo expõe os quatro limites de data, grupo e filtro de conta; calcula variação percentual quando há base comparável.
- Requisitos #92, #95, #96, #333 e #334 foram reclassificados como implementados no código. A análise depende de snapshots já existentes e não substitui uma soma histórica de vendas diárias.

## Etapas adicionais da revisão 3.8.0

- Importador CSV/XLSX: leitura local de CSV com BOM, delimitador detectado, aspas e campos multilinha; leitor XLSX com ZIP/Deflate, CRC32, shared strings, limites de expansão e validação de caminhos.
- Migration 005: staging persistente `import_job_rows` com chave estrangeira e unicidade por linha.
- Importação em duas fases: arquivo vai para staging e só promove após mapeamento explícito de ID externo/data/indicadores, conta ativa correspondente e anúncio previamente cadastrado.
- A promoção é transacional, rejeita IDs ausentes, valores negativos/fora do intervalo, duplicatas e snapshots já existentes. Registra `F_USER_INPUT` em `data_provenance`; não cria anúncios nem preenche campos sem evidência.
- UI exibe prévia, seleção manual das colunas e histórico da importação; os dados só entram no histórico de snapshots após confirmação do usuário.
- Teste isolado de parser confirmou XLSX comprimido com shared strings, número/boolean, CSV com delimitador semicolon, campos citados/multilinha, BOM e rejeição de arquivo inválido.
- Migration 005 executada após 001–004 em SQLite. SQL de inserção de snapshot/proveniência exercitado isoladamente.

**Limitação:** PDF não é importado. A importação CSV/XLSX é um fluxo local para snapshots de anúncios existentes, não um parser universal de todos os relatórios de todos os marketplaces; requer conta ativa, anúncio previamente cadastrado e mapeamento manual. O teste formal da suíte Vitest permanece pendente pela ausência do executável no ambiente.

## Conclusão da revisão 3.8.0

Foram corrigidos fluxos locais relevantes, principalmente executor de rascunhos, retentativas e finalização de tarefas, filtro por conta, validação contextual do formulário, exportação XLSX e declarações de capacidade dos adapters. A extensão compilou e os testes isolados passaram.

**Ainda não é correto declarar os 365 requisitos concluídos.** Permanecem dependências de integrações/credenciais (OAuth e APIs oficiais), leitura real do painel completo, marketplace Amazon, publicação/rollback seguros, importador PDF, recursos de UI analíticos que não foram implementados, testes Vitest/typecheck e validação manual real. Os itens individuais acima preservam esses limites.


### Rodada incremental 3.8.0 — etapas 1 a 10

- **Etapa 1 — histórico e SEO local:** `kpi.history` gera série diária a partir do último snapshot por anúncio/dia e aplica snapshots agregados de conta, preservando ausências como `null`. Sugestões de termos derivadas dos títulos próprios são rotuladas como catálogo local, não como autocomplete ou volume de busca. Agrupamento usa sobreposição lexical; visibilidade e canibalização dependem de SERPs já registradas.
- **Etapa 2 — feedback mensurado dos agentes:** decisões ACEITO/REJEITADO/IMPLEMENTADO/FALHOU podem ser registradas. Para IMPLEMENTADO exige métricas antes/depois, amostra e fonte; após três sucessos medidos, cria/atualiza playbook observacional. Isto não treina o modelo, nem demonstra causalidade.
- **Etapa 3 — paginação assistida:** coleta iniciada pelo usuário abre aba temporária e percorre até cinco páginas de anúncios, somente por link “próxima” visível, mesmo domínio e mesma rota. Interrompe ao detectar login, CAPTCHA, desafio, ciclo ou host inesperado. Não é crawling irrestrito nem coleta periódica.
- **Etapa 4 — Amazon Seller Central:** adapter/content script brasileiro de leitura do inventário visível, sem APIs privadas, cookies ou mutações. Capacidade parcial; requer validação com conta Seller Central real.
- **Etapa 5 — SKU por conta:** migration 007 troca unicidade global por `(account_id, sku_code)`, preserva referências e permite mesmo SKU em lojas diferentes; captura associa anúncio ao SKU dentro da conta.
- **Etapa 6 — snapshots agregados:** migration 008 cria `account_snapshots`; captura de dashboard, Ads, pedidos, inventário, devoluções, perguntas e reputação pode persistir métricas sem inventar `listingId`. `kpi.history` usa snapshots de conta com prioridade por tipo de página.
- **Etapa 7 — dashboard consolidado:** `kpi.dashboard` incorpora os snapshots agregados por conta e agrega o consolidado somando contas, sem somar duas vezes anúncios e métricas da conta. Campos incompletos seguem `null`.
- **Etapa 8 — relatórios/conectores:** relatório KPIS inclui registros de anúncio e conta com `entityType` distinto. Conector que exige credenciais e não possui status `CONECTADO` não pode ser falsamente habilitado.
- **Etapa 9 — regressão e versão:** pacote, serviço, extensão, painel e instalador foram alinhados em 3.8.0; migrations 001–008 e integridade referencial foram reexecutadas localmente.

### Nova validação específica da rodada 3.8.0

- Parser TypeScript global: 50 arquivos, zero erros de sintaxe (não é `tsc` semântico).
- `node --check` em todos os JS/MJS/CJS; extensão recompilada por `node scripts/build-extension.mjs`.
- SQLite nativo do Node: migrations 001–008, `PRAGMA integrity_check` e `PRAGMA foreign_key_check`; SKU igual em contas diferentes foi aceito após migration 007.
- Testes Vitest novos foram escritos para agregação no dashboard, exportação de snapshots da conta e bloqueio de conector sem credenciais, mas não executados porque `vitest` não está instalado.
- `npm ci`/acesso ao registro npm não ficou disponível no ambiente; typecheck semântico e builds do agente/host continuam pendentes.

**Limite da evidência:** os status ✅ indicam implementação identificável no código e não homologação de todos os fluxos com contas reais. Nenhuma API/OAuth externa foi declarada conectada; a Amazon continua parcial; edição/publish ainda não é automatizada.


### Etapa 10 — métricas de receita líquida e custos observados; análise por produto

- Schemas de captura de anúncio e de conta aceitam `netRevenue`, `commission`, `fixedFee`, `shippingFee`, `tax` e `marketplaceFee`, todos como valores não negativos em BRL (unidade monetária exibida pela página).
- Content scripts do Mercado Livre e Shopee reconhecem apenas rótulos explícitos de receita líquida e taxas; cada valor capturado mantém o rótulo de origem em `evidence`.
- Não se infere receita líquida a partir de GMV e não se estima comissão/taxa quando o campo não estiver visível.
- Snapshots e histórico preservam as métricas; dashboard e comparação mostram comissão e tarifa fixa somente quando a cobertura permite total completo.
- A tela de histórico permite selecionar comissões e tarifas fixas observadas.
- `analysis.run` aceita `catalogProductId`, junta anúncios pelo SKU/produto canônico e sempre valida a mesma conta. Não permite passar `listingId` e `catalogProductId` simultaneamente.
- UI de análise inclui campo para ID do produto canônico.
- Requisitos #29 e #39 foram elevados de ausentes para parciais porque a captura depende de rótulos e páginas específicas; #253 e #335 foram classificados como implementados no código.

### Validação adicional da etapa 10

- `node --check` passou nos content scripts Mercado Livre/Shopee e no painel.
- Parser TypeScript global verificou 50 arquivos e encontrou zero erros sintáticos.
- `node scripts/build-extension.mjs` terminou com sucesso.
- Testes novos foram adicionados para persistência/proveniência de taxas e análise por produto, mas não executados: `vitest` permanece ausente. `npm ci --prefer-offline` não completou e consulta ao registry retornou `EAI_AGAIN`.
- O typecheck semântico, builds do serviço/host e homologação em sessões reais seguem bloqueados por dependências ausentes e credenciais não fornecidas.

**Classificação histórica da matriz na rodada 3.10.0:** 174 implementados no código, 161 parciais/não comprovados e 30 não implementados/não funcionais (365 no total).


### Rodada incremental 3.9.0 — etapas 9 a 11

- **Etapa 9 — receita líquida e taxas:** a captura dos adapters ML/Shopee foi ampliada para receita líquida, comissão, tarifa fixa, frete, impostos e tarifas do marketplace quando visíveis. Evidência mantém o rótulo encontrado; nenhum valor é calculado por aproximação.
- **Etapa 10 — análise por produto:** a análise pode usar `catalogProductId`; joins respeitam a conta e só incluem anúncios vinculados por SKU. Interface permite selecionar o ID do produto canônico. A análise FORENSE/360 limita cada execução a 300 anúncios e declara truncamento.
- **Etapa 11 — debug semântico:** corrigidos rótulos genéricos que poderiam misturar GMV/receita líquida ou faturamento/pedidos; simulações DOM dos adapters ML e Shopee verificaram o valor e a evidência dos campos financeiros.

**Classificação da rodada anterior (3.9.0), consolidada e corrigida na matriz 3.10.0 acima: 174 implementados, 161 parciais/não comprovados e 30 não implementados/não funcionais. A matriz tem 365 IDs únicos (1–365), sem lacunas.


### Rodada incremental 3.10.0 — etapas 12 a 19
- KPI cards compatíveis abrem detalhe por anúncio e comparação de períodos adjacentes.
- Tarefas por filtros de desempenho criam somente rascunhos, com critérios explícitos e conta obrigatória.
- Velocidade de digitação ajustável (0–250 ms) nos formulários de título/descrição, com verificação pós-preenchimento e sem salvar/publicar.
- Contexto de filtros/período visível é capturado sem ler campos de texto livres.
- Migration 009 preserva evidências também em `listing_snapshots`, corrigindo a lacuna que havia perdido rótulos/períodos das capturas individuais.
- Relatório KPI preserva métricas e `evidence` de snapshots de anúncio e de conta; o schema limita o payload de evidência a 40 chaves e 12 KB.
- Migrations 001–009 passaram no SQLite nativo; integridade `ok`, zero violações FK. Parser TS: 51 arquivos, sem erros sintáticos. `node --check` nos JS/MJS/CJS passou. Extensão MV3 recompilada.
- Vitest, `tsc` semântico e builds Agent/Host seguem bloqueados por dependências npm ausentes; Chrome/Edge e APIs externas não foram homologados com contas reais.

**Classificação consolidada na 3.10.0:** 174 implementados no código, 161 parciais/não comprovados e 30 não implementados/não funcionais. Todos os 365 requisitos estão classificados individualmente.


### Etapa 18 — auditoria dos contratos IPC
- A inspeção cruzada encontrou quatro métodos com handler e permissões no serviço, porém ausentes da allowlist `IPC_METHODS`. Isso poderia bloquear chamadas ao detalhamento de KPI e ao ciclo de importação.
- Corrigido incluindo `kpi.compare.detail`, `connector.import.list`, `connector.import.get` e `connector.import.commit` na lista de contratos.
- Nova checagem: 109 métodos únicos, 0 handlers ausentes, 0 handlers não declarados, 0 permissões ausentes e 0 permissões obsoletas.

**Debug 3.10.0 após a Etapa 18:** extensão MV3 recompilada; `node --check` sem erros em JS/MJS/CJS; parser TypeScript sem erros sintáticos em 51 arquivos; JSON sem erros; migrations 001–009 com integridade SQLite `ok` e zero violações FK; consulta SQL de relatório confirmou preservação de evidências de anúncio e conta. A suíte Vitest, o `tsc` semântico e os builds do agente/host continuam sem execução por dependências npm indisponíveis.


### Etapa 19 — restauração controlada de backups
- `LocalDatabase.restoreBackup` aceita somente `backupId` registrado, restringe o arquivo ao diretório de backups por caminho real e valida SHA-256 antes de abrir.
- Abre o backup em modo somente leitura para executar `integrity_check`, `foreign_key_check` e validar que cada migration aplicada possui checksum idêntico ao código local.
- Antes da troca, cria backup automático do estado atual, fecha a conexão SQLite, preserva o arquivo atual como `.pre-restore-*.bak`, troca por arquivo temporário e reabre/migra/verifica o banco restaurado.
- Em caso de falha durante a troca/migration, tenta restaurar o arquivo anterior e reabrir o banco; a ação exige confirmação explícita no IPC e no painel.
- Requisito #318 reclassificado como implementado no código. Homologação Vitest não foi possível; foi executado teste direto com `node:sqlite` na implementação TypeScript via type stripping.

**Classificação após a Etapa 19:** 174 implementados no código, 161 parciais/não comprovados e 30 não implementados/não funcionais (365 no total).


### Etapa 20 — requisito de runtime
- Alinhado `engines.node` para `>=22.13.0`, pois a aplicação usa `node:sqlite` e a validação read-only dos backups depende de opção presente na documentação Node 22.13. O runtime portátil previsto no instalador é Node 22.14.0.
- Classificação permanece 174 ✅, 161 🟡 e 30 ❌.


### Rodada incremental 3.10.1 — etapas 20 a 23

- **Etapa 20 — navegação guiada entre áreas autorizadas:** o painel ganhou a ação `Varredura de áreas autorizadas`. A operação só começa após confirmação do usuário, parte da aba ativa, lê links visíveis reconhecidos pelo content script e navega em uma aba temporária. Há allowlist de áreas do vendedor, HTTPS obrigatório, mesma origem e mesmo marketplace, deduplicação por caminho, limite rígido de 12 páginas e interrupção em login, CAPTCHA ou verificação de segurança. Não clica em botões, não envia formulários e não publica alterações. Requisitos #14 e #51 passaram de ausentes para parciais: só links atualmente visíveis e áreas reconhecidas são percorridos; não é uma sincronização completa da conta.
- **Etapa 21 — desconexão local de conectores:** `connector.disconnect` desativa o estado, marca `NAO_CONECTADO`, remove somente chaves do namespace `connector:<id>:` e metadados da credencial, preserva custos/histórico e registra auditoria sem incluir segredos. O painel oferece a ação mesmo para conectores que aparentem inativos, permitindo limpar credenciais residuais. O requisito #304 passou a parcial: a rotina de limpeza existe, mas não há fluxo OAuth/API real conectado para homologar desconexão de provedores.
- **Etapa 22 — geração do schema:** criado `scripts/db-generate.mjs`, que aplica as migrations em banco SQLite em memória, verifica integridade e chaves estrangeiras, e gera snapshot SQL determinístico. `--check` valida sem gravar. Foram verificadas 9 migrations e 131 objetos.
- **Etapa 23 — auditoria de consistência:** criado `scripts/audit-project.mjs`, chamado por `npm run audit`. Verifica versão entre pacote/lock/manifest/painel/serviço, referências de scripts e recursos da extensão, handlers da interface, políticas de permissão IPC, contrato de desconexão, JSON e filtros de links nas três plataformas. Resultado nesta rodada: 335/335 verificações aprovadas (inclui alinhamento da versão do instalador).

**Debug 3.10.1:** extensão MV3 recompilada; 18 arquivos JS/MJS/CJS passaram em `node --check`; 51 arquivos TypeScript/TSX passaram no parser, sem erros sintáticos; auditoria 335/335; 9 migrations aplicadas em memória, 131 objetos, `integrity_check=ok`, `foreign_key_check=0`; smoke test com SQLite real e `SecretStore` confirmou limpeza isolada de tokens e preservação dos segredos de outro conector. Foram acrescentados testes Vitest para limpeza de segredo, desconexão do conector e navegação autorizada, mas a suíte não pode ser executada porque `node_modules` está incompleto e não há pacote Vitest disponível. `npm ci` não completou por indisponibilidade de rede no ambiente; portanto `tsc` semântico e builds Agent/Host permanecem não comprovados. Chrome/Edge reais, contas de vendedor e APIs/OAuth não foram testados.

**Classificação consolidada 3.10.1:** 174 implementados no código, 164 parciais/não comprovados e 27 não implementados/não funcionais (365 no total). IDs ainda não implementados: 46, 47, 52, 53, 80, 128, 130, 132, 178, 179, 195, 246, 247, 248, 256, 258, 284, 287, 289, 292, 293, 294, 295, 296, 297, 298 e 299.
