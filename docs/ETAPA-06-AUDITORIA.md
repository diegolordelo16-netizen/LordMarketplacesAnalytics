# Progresso da atualização até 4.0.0

| Etapa | Estado verificado | Evidência ou pendência |
|---|---|---|
| 00 — Diagnóstico | Integrada | Auditoria de requisitos disponível no repositório. |
| 01 — Validação | Integrada | PR #1. |
| 02 — Segurança e estabilidade | Integrada | PR #2. |
| 03 — Extensão e coleta | Integrada com limites | PR #3, 3.12.0. Consultar `ETAPA-03-PENDENCIAS.md` para cobertura de interfaces e homologação. |
| 04 — Dashboard e KPIs | Integrada | PR #4, 3.13.0 em master. |
| 05 — Financeiro, publicidade, estoque e anúncios | Parcial em revisão | PR #5, CI #182 aprovada. A matriz da etapa identifica os quatro requisitos parciais. |
| 06 — Concorrência, SEO e pós-venda | Candidata 3.15.0, validação de código | OpenSEO integrado, pesquisa pública assistida e pós-venda lexical. Limitações explícitas abaixo. |
| 07 — IA e automações | A auditar | Agentes, memória e propostas já existem. Validar cobertura e operação assistida. |
| 08 — Conectores e relatórios | A auditar | Conferir suporte efetivo por conector, escopo e formato de relatório. |
| 09 — Windows e homologação | A auditar | Conferir empacotamento e executar homologação em Windows. |
| 10 — Auditoria final 4.0.0 | Pendente | Consolidar cobertura dos requisitos e evidência de validação antes de versionar. |

## Entrega inicial de pós-venda

O painel apresenta o volume observado por tipo e fonte nos últimos 30 dias, a média das avaliações com nota explícita, o histórico de reputação capturado para a loja e motivos de devolução recorrentes quando o texto registrado coincide. A contagem descreve os registros locais do período. Notas ausentes permanecem vazias e a cobertura parcial das capturas permanece visível.

Novos relatos manuais usam a fonte `F_USER_INPUT`. A migração 035 corrige registros antigos quando o log da operação identifica sua origem manual. A gravação direta exige uma conta ativa e valida o vínculo de anúncios à mesma loja.

## Revisão da visibilidade SEO

A presença e o share Top 20 usam capturas com posições válidas e sem empates de posição. Capturas vazias ou ambíguas são contabilizadas separadamente no painel. O registro do cálculo é transacional.

## Comparativo de concorrentes

O histórico de cada relação no painel mostra as diferenças observadas de preço, frete e prazo, o patrocínio informado e a contagem de arquivos idênticos por hash. Campos sem observação ficam vazios. A resposta é descartada se o usuário trocar a loja, o produto ou o filtro enquanto a consulta está em andamento.

A comparação utiliza uma única captura recente identificada por data e ID. Capturas antigas ficam no histórico, campos ausentes continuam sem valor e a consulta do painel verifica a loja selecionada.


## Pesquisa de volume do Google Ads

O OpenSEO, licenciado sob MIT, usa o DataForSEO em seus fluxos de pesquisa. O painel SEO & Keywords adota a consulta de volume via contrato público do provedor. A implementação usa o serviço local existente.

O operador informa as credenciais da API e confirma uma consulta paga de até 20 termos. O painel mostra volume médio mensal, concorrência em Google Ads, índice de concorrência e até 12 observações mensais. A consulta usa Brasil e português. Resultados ausentes permanecem vazios. O custo exibido vem da resposta do provedor. As credenciais são transitórias.

A consulta fornece sinal de demanda no Google. A visibilidade e a demanda dos marketplaces continuam baseadas nas fontes próprias já existentes. A validação automatizada usa respostas simuladas do provedor.

Referências

- [OpenSEO no commit revisado](https://github.com/every-app/open-seo/tree/6f68494e92a695db17f4b22da25e84b9bf1e582c)
- [Licença MIT do OpenSEO](https://github.com/every-app/open-seo/blob/6f68494e92a695db17f4b22da25e84b9bf1e582c/LICENSE)
- [Documentação DataForSEO Search Volume Live](https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/)

## Fusão e revisão final de código
PR #9 integrado à etapa 06, seguido das alterações da etapa 05 até 32b7365. Consulta externa e Google Ads usam conexão criptografada, histórico único e autorização. Pós-venda ganhou análise lexical por fonte/conta/anúncio, recorrência e sugestões de revisão sem inferir sentimento ou causa. Comparativo competitivo expõe nota, avaliações, posição e termos/atributos cadastrados, mantendo diferenças de captura e limites. Requisitos 110–114 dependem de coleta real nos marketplaces; 125/131 exigem dados explícitos de promoções/descrições; 130 não calcula similaridade visual além de hashes. SEO externo não substitui ranking de marketplace. Validação real permanece separada. Não declarar 365 requisitos concluídos.

A busca assistida passa a gerar links públicos por título, marca/modelo, SKU vinculado e atributos nos três marketplaces, sem inventar resultados; demonstração não grava registros e importação manual é rotulada F_USER_INPUT. A coleta em abas públicas foi posteriormente implementada para os três marketplaces; a cobertura real de seletores, redirecionamentos e páginas adicionais requer homologação.

Captura de busca pública assistida na extensão, com seleção explícita de conta/produto, identidade de anúncio conferida, até 20 cartões reconhecidos e evidência de ordem observada (não posição absoluta). Amazon público usa permissão opcional, não amplia permissões obrigatórias. Sem cliques, endpoints privados ou escrita remota. Os seletores precisam de homologação em páginas reais; não há garantia de cobertura.

O plano também pode ser executado pela extensão em até três abas temporárias por critério, sem alternar a sessão do vendedor. A URL final precisa coincidir; falha ou página sem cartões reconhecidos é NOT_VERIFIED. O histórico público é exibido separadamente do monitoramento de anúncio. Permissão Amazon concedida por clique dedicado. Corrigida a referência a SKU (sku_code) e o acesso ao DOM no contexto injetado.

## Matriz de fechamento da candidata

| Requisitos | Estado de código | Limites |
|---|---|---|
| 110–114 | Plano e leitura pública até 20 cartões por busca nos três marketplaces | Seletores, páginas reais, CAPTCHA e cobertura exigem homologação; não contorna bloqueios. |
| 115–123 | Fluxos de candidatos, revisão e aprendizado preservados | Monitoramento contínuo de todos os concorrentes sem presença de navegador ainda não comprovado. |
| 124–134 | Histórico público, comparativo de preço/frete/prazo, nota, posição observada, títulos/atributos, patrocínio e recomendação | Promoções e descrições completas dependem de evidência; similaridade visual além de hash não implementada. |
| 135–148 | SEO local preservado, módulos OpenSEO e Google Ads integrados, grupos e gap, histórico/ranking externo, cruzamento com indicadores | Volume Google não é demanda marketplace; cobertura interna, SERPs, atributos e canibalização dependem de dados próprios. |
| 207–216 | Pós-venda por fonte/loja, motivos recorrentes, menções lexicais e reputação observada | Não classifica sentimento ou causalidade como comprovados; coleta real parcial. |

Versão 3.15.0 candidata, sem publicar release estável ou declarar requisitos pendentes como concluídos. Etapa 07 pode ser desenvolvida em branch descendente sem alterar master; conclusão global depende da revisão das etapas anteriores.

## Fechamento adicional de implementação — revisão 27/11/2026

- Histórico de monitoramento retorna a janela mais recente em ordem cronológica; bloqueia observações em monitoramento pausado e datas futuras. Troca de candidato valida vínculo com o produto e preserva histórico. Regras de aprendizado agregam decisões mais recentes por candidato de toda a conta.
- Captura pública alimenta automaticamente o histórico de relações aprovadas/ativas, sem inferir ranking absoluto. Agendamento diário opt-in pela extensão: um plano por instalação, até 30 ciclos e três buscas por ciclo, sem repetição de ciclo reservado, interrompe em falha ou mudança de sessão. Requer navegador e sessão ativos; não é coleta contínua com navegador fechado nem garante cobertura de todos os concorrentes.
- Migration 045 (044 reservada à etapa 07): registros de conteúdo independentes por produto, candidato e loja, com fonte/data. Comparação lexical de descrição e promoções explícitas; imagens por SHA-256 e dHash64, com melhores correspondências. Upload manual calcula hashes localmente sem guardar binários. Extensão captura conteúdo público de página de produto com identidade conferida; CORS pode impedir o hash perceptual. Ausência de campo não significa inexistência.
- Adicionados testes de regressão de monitoramento, agendamento, conteúdo, isolamento e comparação. Verificação de sintaxe JavaScript e nove verificações direcionadas com fixtures executadas nesta revisão. A CI 219 pertence ao commit anterior 4214c5b, não valida os novos commits.
- Pendências: execução integral da CI no novo SHA, eventual correção de falhas, publicação na master após revisão, integração da etapa 07 sobre a versão final, e homologação de seletores, API paga e contas reais (dispensada nesta fase). Comparação visual é heurística, não reconhecimento semântico. Escopo remanescente da etapa 05 permanece em sua auditoria.
