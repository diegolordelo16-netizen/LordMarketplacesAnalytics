# Upgrade e depuração 3.10.8

27/11/2026. Base de trabalho: ZIP 3.10.7 integrado ao histórico local da versão 3.2.1.

## Etapas executadas

1. Reproduzi 29 falhas da suíte do anexo e 15 erros de TypeScript. Corrigi os contratos e as regressões reproduzidas antes de ampliar a interface.
2. Validei o fluxo dashboard → serviço → worker. O dashboard envia a sessão no IPC, o diagnóstico usa as rotas HTTP próprias e o host nativo usa as migrações do serviço. O worker registra a disponibilidade de HTTP e do host nativo.
3. A tela **Extensão & Coletas** ganhou solicitação por loja, lojas ativas ou marketplaces habilitados. Também permite agendar, pausar, reativar, consultar histórico e repetir contas com falha. O progresso mostra estados por conta e página.
4. A fila conserva capturas ainda pendentes em caso de desconexão. A extensão revalida a loja em cada área e o serviço recusa a conclusão quando há páginas pendentes. O worker recupera uma reserva antiga quando o lote não tem atividade recente.
5. A tela de anúncios mostra preços observados e permite escolher o anúncio para consultar KPIs da loja selecionada. Conectores ganhou importação de PDF digital para conferência e configuração/teste de leitura para GA4 e Search Console. O dashboard expõe o perfil global de operação.

## Cobertura das telas revisadas

| Fluxo | Dashboard | Painel lateral da extensão |
|---|---|---|
| Diagnóstico de conexão | Extensão & Coletas e Pré-Start | Diagnóstico da extensão |
| Captura da aba selecionada e paginação direta | Acompanhamento do resultado em Anúncios & Captura | Ações de captura da aba |
| Coleta de loja, agendamento e repetição | Solicitar, configurar e acompanhar | Executar, agendar e acompanhar |
| Estado por conta e página | Histórico persistido e atualização do lote ativo | Eventos do worker |
| Perfil de operação | Seletor global | Seletor global |
| Dados capturados e KPIs | Snapshots, preço e tabela de indicadores | Resumo e estado do envio |
| PDF digital, GA4 e Search Console | Tela Conectores | Área administrativa da aplicação local |

## Verificações

A suíte Vitest passa com 290 testes. TypeScript, builds de agente, host e extensão, auditoria estática (515 verificações), smoke local e publicação assistida em SQLite aprovados. O banco aplica 18 migrações com integridade aprovada e zero violações de chaves estrangeiras.

Chrome for Testing e Edge executaram o dashboard e a extensão MV3 usando páginas de vendedor simuladas. O teste reuniu HTTP local, Native Messaging, solicitação de coleta, três páginas persistidas, agendamento, pausa e PDF digital.

## Pendências

A matriz registra 188 requisitos implementados no código, 3 validados localmente e 174 parciais. Os IDs pendentes estão agrupados em `AUDITORIA-365-RESUMO.json`. Contas reais de Mercado Livre, Shopee e Amazon são necessárias para conferir a cobertura da captura, Ads, publicação e rollback. As conexões do Google foram testadas com respostas simuladas. A renovação OAuth, a ingestão externa, o OCR e o instalador Windows permanecem pendentes. [Matriz dos 365 requisitos](docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md)
