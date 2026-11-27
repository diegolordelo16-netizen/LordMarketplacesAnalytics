# LordMarketplacesAnalytics 3.10.3 — upgrade de publicação assistida

**Data:** 27/11/2026  
**Base:** pacote 3.10.2  
**Escopo prioritário:** requisito #284 (publicar alterações autorizadas), segurança, estado original e rollback.

## Resumo

A versão 3.10.3 adiciona ao código um fluxo de publicação assistida para edição de título e acréscimo de descrição no Mercado Livre e Shopee. O fluxo não é publicação automática ou invisível: começa com tarefa `DRAFT`, passa por aprovação administrativa e exige confirmação nativa individual no navegador ativo. A escrita real em conta de vendedor não foi homologada nesta execução; o requisito #284 é classificado como **parcial**, não como ponta a ponta concluído.

## Etapas implementadas

### 1. Autorização de uso único

- Nova migration `013_publish_approval.sql` cria `task_publish_approvals` e índices de fila/conta.
- Aprovação ligada a task, item, account, marketplace e ID externo do anúncio.
- Somente `super_admin` (`manage_accounts`) aprova, reivindica e registra o resultado.
- Até 10 anúncios por lote, todos da mesma conta e marketplace, sem repetição de listing.
- Confirmação digitada exatamente como `PUBLICAR N`, justificativa obrigatória e expiração de 15 minutos.
- Uma aprovação por item; tentativa de replay ou segunda autorização para o mesmo item é recusada.
- As transições de estado verificam `changes === 1`; se houver corrida/conflito, a transação inteira é revertida para não deixar autorização ou item em estado órfão.

### 2. Snapshot anterior ao rascunho

- Nova migration `014_task_item_pre_publish_snapshot.sql` guarda `before_title`, `before_description`, `baseline_source_url` e `baseline_captured_at`.
- Content scripts capturam o valor antes de alterar campos e devolvem a evidência junto da identidade da conta/anúncio.
- O serviço valida accountId, externalListingId, marketplace e host HTTPS antes de concluir o rascunho.
- Aprovação é bloqueada sem snapshot original do campo que será alterado.
- O serviço não aceita um `before` arbitrário no resultado da publicação: lê o snapshot persistido na base.

### 3. Execução assistida

- A extensão só procura tarefas de publicação na aba ativa da janela em foco.
- Exige sessão autenticada, página de edição, conta identificada e ID do anúncio exato.
- A execução é limitada a `edit_title` e `edit_description`; campanhas, Ads, preço, duplicação e imagem não são aceitos.
- Deve existir exatamente um botão de salvar/atualizar reconhecido dentro do formulário.
- Exige `window.confirm` por anúncio, leitura pós-clique e mensagem de sucesso nova (mensagens preexistentes são ignoradas).
- O serviço só grava `PUBLISHED` se a URL continuar no mesmo host original, o externalListingId corresponder, o sucesso for observado e o campo após salvar corresponder ao valor aprovado.
- Sem confirmação após clique, registra `NEEDS_VERIFICATION`; não tenta novamente automaticamente.

### 4. Auditoria e rollback

- `change_sets` usa o estado anterior persistido e o estado lido após salvar.
- `task.rollbackPrepare` cria uma nova tarefa `DRAFT` para restaurar o título anterior.
- Rollback de descrição ainda exige revisão manual. Nenhum rollback chama API remota ou salva sem uma nova aprovação.

### 5. Regressões e debug

- Testes Vitest adicionados para snapshot obrigatório, publicação com aprovação, uso único, resultado com evidência, rollback de título e bloqueio de perfil operador.
- Novo comando `npm run audit:publish` executa smoke test SQLite sem dependências npm externas.
- Auditoria estática expandida para verificar políticas de publicação, active tab, confirmações, snapshot, ID externo, rollback sem escrita automática e transições atômicas.
- Smoke test ampliado para 10 verificações; inclui colisão de ID externo entre contas, consumo único e rollback de transação em mudança concorrente.

## Arquivos principais alterados

- `packages/local-agent/migrations/013_publish_approval.sql`
- `packages/local-agent/migrations/014_task_item_pre_publish_snapshot.sql`
- `packages/local-agent/src/service.ts`
- `packages/local-agent/src/scheduler/task-scheduler.ts`
- `packages/extension/service-worker.js`
- `packages/extension/content/mercado-livre.js`
- `packages/extension/content/shopee.js`
- `packages/local-agent/panel/src/app.js`
- `packages/shared/src/types/contracts.ts`
- `packages/shared/src/schemas/ipc.ts`
- `contracts.json`
- `scripts/audit-project.mjs`
- `scripts/audit-publish-flow.mjs`

## Debug final 3.10.3

- Auditoria estática: 417/417 aprovada.
- Smoke SQLite: 10 verificações aprovadas.
- Extensão MV3 reconstruída; 8 arquivos do manifest conferidos.
- 19 scripts JS/MJS/CJS sem erros de sintaxe; 52 arquivos TS/TSX sem erros de parsing.
- 14 migrations, 154 objetos, integridade SQLite aprovada e zero violações de chaves estrangeiras.
- `npm ci --prefer-offline` excedeu 120 segundos; a instalação parcial foi removida. Vitest, typecheck semântico e builds do agente/host permanecem bloqueados.

## Limitações conhecidas

1. Não houve teste com Chrome/Edge e sessão real de vendedor. Seletores dos campos/botões e o texto das mensagens de sucesso precisam ser validados nas interfaces atuais.
2. O fluxo opera por UI visível; não há adapter de API oficial/OAuth e não cobre todas as mudanças de catálogo, Ads ou campanhas.
3. Se a página navegar após o clique ou não der confirmação positiva, o estado fica incerto. É necessário verificar manualmente no marketplace; não há retry para evitar duplicidade.
4. Só o rollback de título gera rascunho automaticamente. Descrição precisa de edição/revisão manual.
5. Não foi criado instalador Windows nesta rodada.

## Classificação dos requisitos

Matriz de 365 IDs: 174 implementados no código, 191 parciais/não comprovados, 0 completamente ausentes no código. O requisito #284 avançou de ausente para **parcial**, pois o fluxo local está implementado mas a escrita remota não foi homologada. Os 191 itens parciais não devem ser interpretados como concluídos.
