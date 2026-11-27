# LordMarketplacesAnalytics 3.3.0 — incremento funcional

Data: 26/11/2026

## Entregas incluídas

- Gestão de usuários no painel: criar, editar, alterar papel e senha, ativar/desativar; a listagem não retorna hashes e o serviço impede desativar o último superadministrador ou a própria sessão ativa.
- Gestão de contas: ativação/desativação, auditoria e seletor que considera apenas contas ativas.
- Catálogo local: cadastro e listagem de produtos e SKUs, migration 004 com vínculo do SKU à conta, prevenção de associação cruzada, atualização com verificação de existência e custo versionado por ID ou código do SKU.
- Visão comparativa: agregação de KPIs e cobertura por conta; totais ficam nulos quando faltam dados de anúncios, evitando tratar ausência como zero.
- Análises locais por profundidade: RAPIDA (4 agentes), PADRAO (8 agentes), FORENSE (14 agentes) e 360 (14 agentes), com persistência de execuções e recomendações.
- Growth Lab: criar/atualizar iniciativas, pontuação RICE/ICE e mudança de status com auditoria.
- Biblioteca de imagens local: JPEG, PNG, WEBP e GIF até 2,5 MB, assinatura de arquivo, SHA-256, pré-visualização e exclusão limitada à conta associada.
- Conectores: estado local habilitado/desabilitado e auditado; a interface explicita que isso não equivale a uma conexão com o provedor.
- Captura: ampliação de métricas adicionais quando os valores estão visíveis na página renderizada.
- Correção do payload do formulário Gemini (`apiKey`) e correções de validação de atualização do catálogo.
- Contratos IPC, políticas de permissão, migrations 003 e 004 e testes de regressão adicionados; versão do pacote, lockfile e extensão alinhadas em 3.3.0.

## Verificações feitas neste ambiente

- 48 arquivos TypeScript passaram pela transpilação/sintaxe do TypeScript sem diagnósticos de parser.
- JavaScript do painel, content scripts e worker passou por `node --check`.
- Build da extensão MV3 executado: `node scripts/build-extension.mjs` concluiu com sucesso e gerou `dist/extension` (manifest e todos os arquivos referenciados presentes).
- JSON de pacote, lockfile e manifest conferido.
- Migrations SQL 001, 002, 003 e 004 executadas em SQLite em memória; foram testados inserts de catálogo, custos, Growth Lab, biblioteca e recomendações dos agentes.
- A lista de métodos registrados foi comparada com o contrato IPC e a política de permissões; não foram encontrados métodos registrados ausentes do contrato ou sem permissão.

## Verificações que não puderam ser concluídas

`npm ci` não concluiu devido a falha de rede/DNS no registro do npm. Como resultado, `npm test` não encontrou o executável `vitest`, e não foi possível afirmar que typecheck oficial, suíte Vitest completa, builds do serviço local/Native Messaging Host ou instalador Windows passaram. O build da extensão foi executado com sucesso. Não houve teste real em Chrome/Edge nem em conta autenticada de vendedor.

## Requisitos que continuam dependentes de serviços ou validação externa

- APIs/OAuth de Mercado Livre, Shopee, Amazon, GA4, Search Console, Trends e fornecedores externos: requerem credenciais, escopos e autorização de cada conta.
- Coleta de Ads, histórico completo, paginação e navegação entre todas as páginas: dependem do conteúdo realmente mostrado pela plataforma ou de integração oficial autorizada. A leitura DOM não consegue extrair gráficos canvas ou dados não exibidos.
- Publicação/edição automática de preço, anúncios, imagens e campanhas: exige adaptador validado por plataforma, sessão de teste, verificação pós-ação e política de aprovação; não marcar como pronta apenas por haver scheduler/guard.
- XLSX e PDF nativo: ainda faltam. O PDF atual é uma visualização imprimível que usa a função de impressão do navegador.
- Integrações configuráveis, OAuth, testes de conexão e sincronizações recorrentes reais não são implementados só pelo estado local do catálogo de conectores.
- Testes físicos do instalador e navegadores Chrome/Edge seguem pendentes.

**Conclusão:** 3.3.0 é um avanço funcional real sobre a base anterior, mas não é uma implementação completa de todos os itens do checklist. O status por requisito foi acrescentado em `docs/CHECKLIST-FUNCIONALIDADES.md` sem apagar a evidência histórica.
