# LordMarketplacesAnalytics 3.10.7 — relatório de upgrade

**Data:** 27/11/2026  
**Base:** pacote 3.10.3 com melhorias acumuladas das rodadas 3.10.4–3.10.7.  
**Objetivo desta rodada:** fechar os parciais locais relacionados a progresso, retomada e visibilidade da coleta; deixar a matriz e os limites de homologação atualizados.

## Etapas executadas

### 1. Persistência de progresso por página

Foi criada a migration `017_sync_page_progress.sql`.

- `sync_batch_accounts` agora guarda `current_page_no`, `current_url`, `progress_json` e `progress_updated_at`.
- A nova tabela `sync_batch_page_runs` registra página, URL sanitizada, tipo de área, resultado, erro, estado de fila e data de atualização.
- Uma chave única por `(batch_id, account_id, page_no)` e `ON CONFLICT ... DO UPDATE` evitam criar cópias do mesmo registro da página durante a retomada.
- O serviço expõe `sync.accountProgress`, protegido por `execute_task`, verifica se a conta pertence ao lote e recusa atualizações em contas terminais.

### 2. Retomada segura do worker

O service worker carrega o `progress_json` persistido ao reprocessar uma coleta agendada cujo lease ficou órfão por mais de 30 minutos.

- Páginas confirmadas são carregadas para o conjunto `seen` e não são capturadas novamente.
- A fila de links pendentes é restaurada e processada na mesma conta/marketplace.
- Uma página que falha continua na fila e pode ser tentada na retomada; uma captura aceita na fila local fica identificada como `QUEUED`.
- O limite absoluto permanece em 12 páginas/entradas por operação.
- Um lote que ainda tem links pendentes termina como `PARTIAL`; não recebe falso status `COMPLETED`.
- A sessão nunca é trocada; o worker exige aba autenticada com identidade visível correspondente à conta.

### 3. Validação e privacidade das URLs

O serviço só aceita URL HTTPS do marketplace associado à conta. Remove usuário, senha e fragmento e preserva apenas parâmetros conhecidos de paginação (`page`, `page_number`, `p`, `offset`, `limit`, `sort`, `order`). Parâmetros opacos — inclusive tokens que eventualmente apareçam em query strings — não são persistidos.

### 4. Progresso em tempo real

A extensão emite `MI_SYNC_PROGRESS` depois de cada página persistida. O painel mostra conta, página atual, quantidade concluída e links pendentes, sem apresentar URLs potencialmente sensíveis.

### 5. Requisitos promovidos

Nesta rodada foram promovidos:

- **21 — Salvar o progresso da navegação.** Cursor, páginas concluídas e links restantes são persistidos.
- **22 — Retomar operações interrompidas.** Recuperação do lease de coletas agendadas restaura fila e pula páginas confirmadas. O escopo implementado é a coleta agendada, não toda e qualquer tarefa da aplicação.
- **24 — Mostrar o que está sendo coletado em tempo real.** Atualização por página no painel lateral.

Com as rodadas anteriores, a matriz fica em **187 implementados no código, 178 parciais/não comprovados e 0 completamente ausentes**, totalizando 365 IDs únicos. Os estados brutos são 187 implementados, 173 parciais, 2 não comprovados em Chrome/Edge real e 3 não comprovados nesta execução.

## Alterações acumuladas desta linha de upgrade

- 3.10.4: agenda recorrente de análise/relatórios, histórico de execução, retry 5/15/60 minutos, progresso da fila, exportação JSON, importação de PDF digital.
- 3.10.5: agenda recorrente de coleta, escopo por conta/marketplace, alarmes MV3, histórico de lotes e repetição manual auditável de contas com falha.
- 3.10.6: gestão de usuários no painel para `super_admin`, com hash de senha, gestão de papéis e proteções contra auto-desativação/remoção do último administrador.
- 3.10.7: progresso por página persistido, URL sanitizada, fila de navegação retomável e progresso por página no painel.

## Limitações que permanecem

A retomada foi validada com migration SQLite, persistência/recuperação do estado e auditoria estática; não foi possível encerrar um worker MV3 em Chrome/Edge com conta de vendedor real e comprovar a retomada ponta a ponta nesta execução. O comportamento depende de o navegador, a extensão, o serviço local e a aba autenticada estarem disponíveis. Se a identidade da conta não corresponder, a conta é ignorada; se aparecer login/CAPTCHA, a coleta para.

Os demais 178 itens parciais/não comprovados ainda incluem cobertura de dados diferente entre marketplaces, seletores que precisam de homologação, OAuth/APIs externas, conectores sem credenciais, publicação/rollback remoto fora do fluxo assistido já existente, PDFs digitalizados/OCR, Ads e métricas que não estejam visíveis na sessão autenticada. Esses itens não podem ser marcados como concluídos apenas por existir uma tabela, tela ou configuração.

## Arquivos relevantes

- `packages/local-agent/migrations/017_sync_page_progress.sql`
- `packages/local-agent/src/service.ts` — `sync.accountProgress`
- `packages/extension/service-worker.js` — callback de progresso, estado de retomada e `pendingPages`
- `packages/extension/panel/panel.js` — progresso por página
- `scripts/smoke-local-features.mjs` — persistência da página, fila pendente e idempotência
- `scripts/audit-project.mjs` — contratos, permissões, domínio, retomada e matriz

Consulte `DEBUG-3.10.7.md` para os resultados reproduzidos e bloqueios do ambiente, e `docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md` para os 365 requisitos individualmente.
